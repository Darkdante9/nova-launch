import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, DataSource } from "typeorm";
import { BurnEvent, BurnType } from "./entities/burn-event.entity";
import {
  TimePeriod,
  TokenAnalyticsResponseDto,
  TimeSeriesDataPoint,
  PeriodStats,
  AggregateBurnResponseDto,
  TokenBurnSummaryDto,
  TopBurnerDto,
  BurnRateTrendPointDto,
} from "./dto/analytics.dto";

interface PeriodWindow {
  start: Date;
  end: Date;
  granularity: "hour" | "day" | "week" | "month";
  intervalCount: number;
}

export type TimePeriod = "24h" | "7d" | "30d" | "90d" | "all";

const GRANULARITIES: Granularity[] = ["hour", "day", "week"];

// ──────────────────────────────────────────────────────────────────────────────
// Injectable prisma dependency for testability
// ──────────────────────────────────────────────────────────────────────────────

type PrismaDep = Pick<typeof prisma, "analyticsBucket">;

export class AnalyticsService {
  private readonly db: PrismaDep;

  constructor(db?: PrismaDep) {
    this.db = db ?? prisma;
  }

  // ──────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────

  async getTokenAnalytics(
    tokenAddress: string,
    period: TimePeriod
  ): Promise<TokenAnalyticsResponseDto> {
    const normalizedAddress = tokenAddress.toLowerCase();

    // Verify token has any burns at all
    const exists = await this.countBurnEvents(normalizedAddress);
    if (exists === 0) {
      const err = new Error(`No burn data found for token ${tokenAddress}`);
      (err as any).status = 404;
      throw err;
    }

    const window = this.getPeriodWindow(period);
    const prevWindow = this.getPreviousWindow(window);

    const [
      allTimeStats,
      periodBurns,
      prevPeriodBurns,
      stats24h,
      stats7d,
      stats30d,
      timeSeries,
      burnTypeDistribution,
      largestBurnRow,
    ] = await Promise.all([
      this.getAllTimeStats(normalizedAddress),
      this.getPeriodStats(normalizedAddress, window.start, window.end),
      this.getPeriodStats(normalizedAddress, prevWindow.start, prevWindow.end),
      this.getPeriodStats(normalizedAddress, this.hoursAgo(24), new Date()),
      this.getPeriodStats(normalizedAddress, this.daysAgo(7), new Date()),
      this.getPeriodStats(normalizedAddress, this.daysAgo(30), new Date()),
      this.buildTimeSeries(normalizedAddress, window),
      this.getBurnTypeDistribution(normalizedAddress, window.start, window.end),
      this.getLargestBurn(normalizedAddress),
    ]);

    const volumeChangePercent = this.calcChangePercent(
      BigInt(prevPeriodBurns.volume),
      BigInt(periodBurns.volume)
    );
    const countChangePercent = this.calcChangePercent(
      BigInt(prevPeriodBurns.count),
      BigInt(periodBurns.count)
    );

    const durationDays = this.windowDurationDays(window);
    const burnFrequencyPerDay =
      durationDays > 0
        ? Math.round((periodBurns.count / durationDays) * 100) / 100
        : 0;

    const averageBurnAmount =
      periodBurns.count > 0
        ? (BigInt(periodBurns.volume) / BigInt(periodBurns.count)).toString()
        : "0";

    return {
      tokenAddress,
      period,
      generatedAt: new Date().toISOString(),

      // All-time
      totalBurned: allTimeStats.totalVolume,
      totalBurnCount: allTimeStats.totalCount,
      allTimeUniqueBurners: allTimeStats.uniqueBurners,
      largestBurn: largestBurnRow?.amount ?? "0",
      largestBurnTx: largestBurnRow?.txHash ?? "",

      // Fixed-window stats
      stats24h,
      stats7d,
      stats30d,

      // Current period
      periodVolume: periodBurns.volume,
      periodBurnCount: periodBurns.count,
      periodUniqueBurners: periodBurns.uniqueBurners,
      averageBurnAmount,
      burnFrequencyPerDay,

      // Comparison
      volumeChangePercent,
      countChangePercent,

      // Chart
      timeSeries,
      burnTypeDistribution,
    };
  }

  async getAggregateBurnStats(
    startDate?: Date,
    endDate?: Date
  ): Promise<AggregateBurnResponseDto> {
    const start = startDate ?? this.daysAgo(30);
    const end = endDate ?? new Date();

    const [totals, trend, top5, tokenSummaries] = await Promise.all([
      this.getAggregateTotals(start, end),
      this.getAggregateBurnRateTrend(start, end),
      this.getTop5Burners(start, end),
      this.getTokenSummaries(start, end),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      totalBurnedAllTokens: totals.totalVolume,
      totalBurnCount: totals.totalCount,
      totalUniqueTokens: totals.uniqueTokens,
      totalUniqueBurners: totals.uniqueBurners,
      burnRateTrend: trend,
      top5Burners: top5,
      tokenSummaries,
    };
  }

  private async getAggregateTotals(start: Date, end: Date) {
    const row = await this.dataSource.query(
      `SELECT
         COALESCE(SUM(amount::numeric), 0)::text AS "totalVolume",
         COUNT(*)::int                           AS "totalCount",
         COUNT(DISTINCT token_address)::int      AS "uniqueTokens",
         COUNT(DISTINCT burner_address)::int     AS "uniqueBurners"
       FROM burn_events
       WHERE burned_at >= $1 AND burned_at < $2`,
      [start, end]
    );
    return row[0] as {
      totalVolume: string;
      totalCount: number;
      uniqueTokens: number;
      uniqueBurners: number;
    };
  }

  private async getAggregateBurnRateTrend(
    start: Date,
    end: Date
  ): Promise<BurnRateTrendPointDto[]> {
    const rows: { day: string; volume: string; count: number }[] =
      await this.dataSource.query(
        `SELECT
           DATE_TRUNC('day', burned_at)::text AS day,
           COALESCE(SUM(amount::numeric), 0)::text AS volume,
           COUNT(*)::int AS count
         FROM burn_events
         WHERE burned_at >= $1 AND burned_at < $2
         GROUP BY DATE_TRUNC('day', burned_at)
         ORDER BY day ASC`,
        [start, end]
      );

    return rows.map((r) => ({ date: r.day, volume: r.volume, count: r.count }));
  }

  private async getTop5Burners(start: Date, end: Date): Promise<TopBurnerDto[]> {
    const rows: {
      burner_address: string;
      total_burned: string;
      burn_count: number;
    }[] = await this.dataSource.query(
      `SELECT
         burner_address,
         COALESCE(SUM(amount::numeric), 0)::text AS total_burned,
         COUNT(*)::int AS burn_count
       FROM burn_events
       WHERE burned_at >= $1 AND burned_at < $2
       GROUP BY burner_address
       ORDER BY SUM(amount::numeric) DESC
       LIMIT 5`,
      [start, end]
    );

    return rows.map((r) => ({
      walletAddress: r.burner_address,
      totalBurned: r.total_burned,
      burnCount: r.burn_count,
    }));
  }

  private async getTokenSummaries(
    start: Date,
    end: Date
  ): Promise<TokenBurnSummaryDto[]> {
    const rows: {
      token_address: string;
      total_burned: string;
      burn_count: number;
      unique_burners: number;
    }[] = await this.dataSource.query(
      `SELECT
         token_address,
         COALESCE(SUM(amount::numeric), 0)::text AS total_burned,
         COUNT(*)::int AS burn_count,
         COUNT(DISTINCT burner_address)::int AS unique_burners
       FROM burn_events
       WHERE burned_at >= $1 AND burned_at < $2
       GROUP BY token_address
       ORDER BY SUM(amount::numeric) DESC`,
      [start, end]
    );

    return rows.map((r) => ({
      tokenAddress: r.token_address,
      totalBurned: r.total_burned,
      burnCount: r.burn_count,
      uniqueBurners: r.unique_burners,
    }));
  }

  // ──────────────────────────────────────────────
  // Query helpers (mockable via subclass or vi.spyOn in tests)
  // ──────────────────────────────────────────────

  /** Overridable for tests that don't want to spin up a real DB. */
  protected async countBurnEvents(tokenAddress: string): Promise<number> {
    const result = await prisma.$queryRaw<[{ cnt: bigint }]>`
      SELECT COUNT(*)::int AS cnt FROM burn_events WHERE token_address = ${tokenAddress}
    `;
    return Number(result[0].cnt);
  }

  protected async queryBurnEventsPage(
    tokenAddress: string,
    pageSize: number,
    skip: number
  ): Promise<{ amount: string; burned_at: Date }[]> {
    return prisma.$queryRaw<{ amount: string; burned_at: Date }[]>`
      SELECT amount, burned_at
      FROM burn_events
      WHERE token_address = ${tokenAddress}
      ORDER BY burned_at ASC
      LIMIT ${pageSize} OFFSET ${skip}
    `;
  }

  private async getAllTimeStats(tokenAddress: string): Promise<{
    totalVolume: string;
    totalCount: number;
    uniqueBurners: number;
  }> {
    const rows = await prisma.$queryRaw<
      { totalVolume: string; totalCount: number; uniqueBurners: number }[]
    >`
      SELECT
        COALESCE(SUM(amount::numeric), 0)::text AS "totalVolume",
        COUNT(*)::int                           AS "totalCount",
        COUNT(DISTINCT burner_address)::int     AS "uniqueBurners"
      FROM burn_events
      WHERE token_address = ${tokenAddress}
    `;
    return rows[0];
  }

  private async getPeriodStats(
    tokenAddress: string,
    start: Date,
    end: Date
  ): Promise<PeriodStats> {
    const rows = await prisma.$queryRaw<PeriodStats[]>`
      SELECT
        COALESCE(SUM(amount::numeric), 0)::text AS volume,
        COUNT(*)::int                           AS count,
        COUNT(DISTINCT burner_address)::int     AS "uniqueBurners"
      FROM burn_events
      WHERE token_address = ${tokenAddress}
        AND burned_at >= ${start}
        AND burned_at < ${end}
    `;
    return rows[0];
  }

  private async getLargestBurn(
    tokenAddress: string
  ): Promise<{ amount: string; txHash: string } | null> {
    const rows = await prisma.$queryRaw<{ amount: string; txHash: string }[]>`
      SELECT amount::text, transaction_hash AS "txHash"
      FROM burn_events
      WHERE token_address = ${tokenAddress}
      ORDER BY amount::numeric DESC
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  private async getBurnTypeDistribution(
    tokenAddress: string,
    start: Date,
    end: Date
  ): Promise<BurnTypeDistribution> {
    const rows = await prisma.$queryRaw<
      { burn_type: string; volume: string; cnt: number }[]
    >`
      SELECT
        burn_type,
        COALESCE(SUM(amount::numeric), 0)::text AS volume,
        COUNT(*)::int AS cnt
      FROM burn_events
      WHERE token_address = ${tokenAddress}
        AND burned_at >= ${start}
        AND burned_at < ${end}
      GROUP BY burn_type
    `;

    const byType = (type: string) =>
      rows.find((r) => r.burn_type === type) ?? { volume: "0", cnt: 0 };

    const selfRow = byType("self");
    const adminRow = byType("admin");

    const totalVolume = BigInt(selfRow.volume) + BigInt(adminRow.volume);

    const pct = (v: bigint) =>
      totalVolume === 0n
        ? 0
        : Math.round(Number((v * 10000n) / totalVolume) / 100);

    return {
      self: selfRow.volume,
      admin: adminRow.volume,
      selfPercentage: pct(BigInt(selfRow.volume)),
      adminPercentage: pct(BigInt(adminRow.volume)),
    };
  }

  private async buildTimeSeries(
    tokenAddress: string,
    window: PeriodWindow
  ): Promise<TimeSeriesDataPoint[]> {
    const gran = window.granularity;
    // Safe: gran is constrained to known literal values
    const rows = await prisma.$queryRawUnsafe<
      { ts: string; value: string; count: number }[]
    >(
      `SELECT
         DATE_TRUNC('${gran}', burned_at)::text AS ts,
         COALESCE(SUM(amount::numeric), 0)::text AS value,
         COUNT(*)::int AS count
       FROM burn_events
       WHERE token_address = $1
         AND burned_at >= $2
         AND burned_at < $3
       GROUP BY DATE_TRUNC('${gran}', burned_at)
       ORDER BY ts ASC`,
      tokenAddress,
      window.start,
      window.end
    );

    return this.fillTimeSeriesGaps(rows, window);
  }

  private fillTimeSeriesGaps(
    rows: { ts: string; value: string; count: number }[],
    window: PeriodWindow
  ): TimeSeriesDataPoint[] {
    const map = new Map(rows.map((r) => [r.ts.slice(0, 16), r]));
    const result: TimeSeriesDataPoint[] = [];

    const cursor = new Date(window.start);
    while (cursor < window.end) {
      const key = cursor.toISOString().slice(0, 16);
      const row = map.get(key);
      result.push({
        timestamp: cursor.toISOString(),
        value: row?.value ?? "0",
        count: row?.count ?? 0,
      });
      this.advanceCursor(cursor, window.granularity);
    }

    return result;
  }

  // ──────────────────────────────────────────────
  // Bucket utilities
  // ──────────────────────────────────────────────

  /**
   * Truncate a Date to the start of its granularity bucket (UTC-aligned).
   */
  truncateToBucket(date: Date, granularity: Granularity): Date {
    const d = new Date(date);
    d.setUTCMilliseconds(0);
    d.setUTCSeconds(0);
    d.setUTCMinutes(0);

    if (granularity === "hour") {
      return d;
    }

    d.setUTCHours(0);

    if (granularity === "day") {
      return d;
    }

    // "week" — ISO-week: truncate to the Monday of the current week
    const dayOfWeek = d.getUTCDay(); // 0 = Sunday
    const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    d.setUTCDate(d.getUTCDate() - daysToMonday);
    return d;
  }

  // ──────────────────────────────────────────────
  // Time-window utilities
  // ──────────────────────────────────────────────

  private getPeriodWindow(period: TimePeriod): PeriodWindow {
    const now = new Date();
    switch (period) {
      case "24h":
        return {
          start: this.hoursAgo(24),
          end: now,
          granularity: "hour",
          intervalCount: 24,
        };
      case "7d":
        return {
          start: this.daysAgo(7),
          end: now,
          granularity: "day",
          intervalCount: 7,
        };
      case "30d":
        return {
          start: this.daysAgo(30),
          end: now,
          granularity: "day",
          intervalCount: 30,
        };
      case "90d":
        return {
          start: this.daysAgo(90),
          end: now,
          granularity: "week",
          intervalCount: 13,
        };
      case "all":
      default:
        return {
          start: new Date("2020-01-01"),
          end: now,
          granularity: "month",
          intervalCount: 0,
        };
    }
  }

  private getPreviousWindow(window: PeriodWindow): PeriodWindow {
    const duration = window.end.getTime() - window.start.getTime();
    return {
      start: new Date(window.start.getTime() - duration),
      end: window.start,
      granularity: window.granularity,
      intervalCount: window.intervalCount,
    };
  }

  private windowDurationDays(window: PeriodWindow): number {
    return (window.end.getTime() - window.start.getTime()) / 86_400_000;
  }

  private hoursAgo(h: number): Date {
    return new Date(Date.now() - h * 3_600_000);
  }

  private daysAgo(d: number): Date {
    return new Date(Date.now() - d * 86_400_000);
  }

  private advanceCursor(d: Date, granularity: PeriodWindow["granularity"]) {
    switch (granularity) {
      case "hour":
        d.setHours(d.getHours() + 1);
        break;
      case "day":
        d.setDate(d.getDate() + 1);
        break;
      case "week":
        d.setDate(d.getDate() + 7);
        break;
      case "month":
        d.setMonth(d.getMonth() + 1);
        break;
    }
  }

  private calcChangePercent(prev: bigint, curr: bigint): number {
    if (prev === 0n) return curr > 0n ? 100 : 0;
    const change = Number(((curr - prev) * 10000n) / prev) / 100;
    return Math.round(change * 100) / 100;
  }
}

/** Singleton instance for use across the app */
export const analyticsService = new AnalyticsService();
