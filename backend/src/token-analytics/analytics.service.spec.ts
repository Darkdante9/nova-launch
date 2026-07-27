/**
 * Tests for AnalyticsService – token analytics aggregation pipeline.
 *
 * Uses Vitest with vi.mock / vi.spyOn.  No NestJS testing harness needed
 * because the service is now a plain TypeScript class.
 *
 * Issue: #1357
 */

import { describe, it, expect, beforeEach, vi, type MockInstance } from "vitest";
import { AnalyticsService, AnalyticsEvent, Granularity } from "./analytics.service";

// ─── Mock the prisma singleton ──────────────────────────────────────────────

const mockUpsert = vi.fn().mockResolvedValue({});
const mockFindMany = vi.fn().mockResolvedValue([]);

vi.mock("../lib/prisma", () => ({
  prisma: {
    analyticsBucket: {
      upsert: (...args: unknown[]) => mockUpsert(...args),
      findMany: (...args: unknown[]) => mockFindMany(...args),
    },
    $queryRaw: vi.fn(),
    $queryRawUnsafe: vi.fn(),
  },
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePeriodRow(overrides = {}) {
  return {
    volume: "500000",
    count: 5,
    uniqueBurners: 3,
    ...overrides,
  };
}

function makeAllTimeRow(overrides = {}) {
  return {
    totalVolume: "1000000",
    totalCount: 10,
    uniqueBurners: 5,
    ...overrides,
  };
}

function makeBurnTypeRows() {
  return [
    { burn_type: "self", volume: "700000", cnt: 7 },
    { burn_type: "admin", volume: "300000", cnt: 3 },
  ];
}

function makeTimeSeriesRows() {
  return [{ ts: "2024-01-01 00:00:00+00", value: "100000", count: 1 }];
}

// ─── Bucket aggregation suite (core of issue #1357) ─────────────────────────

describe("AnalyticsService – bucket aggregation", () => {
  let service: AnalyticsService;
  let upsertCalls: unknown[];

  beforeEach(() => {
    upsertCalls = [];
    mockUpsert.mockReset();
    mockFindMany.mockReset().mockResolvedValue([]);

    mockUpsert.mockImplementation((args: unknown) => {
      upsertCalls.push(args);
      return Promise.resolve({});
    });

    const mockDb = {
      analyticsBucket: {
        upsert: mockUpsert,
        findMany: mockFindMany,
      },
    } as any;

    service = new AnalyticsService(mockDb);
  });

  // ── truncateToBucket ──────────────────────────────────────────────────────

  describe("truncateToBucket", () => {
    it("truncates to the start of the hour", () => {
      const d = new Date("2024-03-15T14:37:22.456Z");
      const result = service.truncateToBucket(d, "hour");
      expect(result.toISOString()).toBe("2024-03-15T14:00:00.000Z");
    });

    it("truncates to the start of the day (UTC midnight)", () => {
      const d = new Date("2024-03-15T14:37:22.456Z");
      const result = service.truncateToBucket(d, "day");
      expect(result.toISOString()).toBe("2024-03-15T00:00:00.000Z");
    });

    it("truncates to Monday of the current week (Friday input)", () => {
      // 2024-03-15 is a Friday
      const d = new Date("2024-03-15T14:37:22.456Z");
      const result = service.truncateToBucket(d, "week");
      // Monday of that week is 2024-03-11
      expect(result.toISOString()).toBe("2024-03-11T00:00:00.000Z");
    });

    it("truncates Sunday to the Monday six days earlier", () => {
      // 2024-03-17 is a Sunday
      const d = new Date("2024-03-17T10:00:00.000Z");
      const result = service.truncateToBucket(d, "week");
      expect(result.toISOString()).toBe("2024-03-11T00:00:00.000Z");
    });

    it("truncates Monday to itself", () => {
      // 2024-03-11 is a Monday
      const d = new Date("2024-03-11T08:45:00.000Z");
      const result = service.truncateToBucket(d, "week");
      expect(result.toISOString()).toBe("2024-03-11T00:00:00.000Z");
    });

    it("preserves the input date (does not mutate it)", () => {
      const original = new Date("2024-06-10T12:30:00.000Z");
      const snapshot = original.toISOString();
      service.truncateToBucket(original, "week");
      expect(original.toISOString()).toBe(snapshot);
    });
  });

  // ── aggregateIntoBuckets ──────────────────────────────────────────────────

  describe("aggregateIntoBuckets", () => {
    it("calls upsert for all three granularities (hour, day, week)", async () => {
      const event: AnalyticsEvent = {
        tokenId: "token-abc",
        burnVolume: 1000n,
        transferCount: 1,
        holderCount: 0,
        eventTime: new Date("2024-06-01T10:30:00.000Z"),
      };

      await service.aggregateIntoBuckets(event);

      const granularitiesUsed = (upsertCalls as any[]).map(
        (c) => c.where.tokenId_bucketStart_granularity.granularity
      );

      expect(granularitiesUsed).toContain("hour");
      expect(granularitiesUsed).toContain("day");
      expect(granularitiesUsed).toContain("week");
      expect(upsertCalls).toHaveLength(3);
    });

    it("uses correct bucket boundaries for each granularity", async () => {
      // 2024-06-05 is a Wednesday
      const event: AnalyticsEvent = {
        tokenId: "token-abc",
        burnVolume: 500n,
        eventTime: new Date("2024-06-05T15:45:00.000Z"),
      };

      await service.aggregateIntoBuckets(event);

      const byGran = (g: string) =>
        (upsertCalls as any[]).find(
          (c) => c.where.tokenId_bucketStart_granularity.granularity === g
        );

      expect(
        byGran("hour").where.tokenId_bucketStart_granularity.bucketStart.toISOString()
      ).toBe("2024-06-05T15:00:00.000Z");

      expect(
        byGran("day").where.tokenId_bucketStart_granularity.bucketStart.toISOString()
      ).toBe("2024-06-05T00:00:00.000Z");

      // Monday of the week containing 2024-06-05 (Wednesday) is 2024-06-03
      expect(
        byGran("week").where.tokenId_bucketStart_granularity.bucketStart.toISOString()
      ).toBe("2024-06-03T00:00:00.000Z");
    });

    it("passes burnVolume, transferCount, and holderCount to create and increment", async () => {
      const event: AnalyticsEvent = {
        tokenId: "token-xyz",
        burnVolume: 9999n,
        transferCount: 2,
        holderCount: 3,
        eventTime: new Date("2024-01-10T08:00:00.000Z"),
      };

      await service.aggregateIntoBuckets(event);

      for (const call of upsertCalls as any[]) {
        expect(call.create.burnVolume).toBe(9999n);
        expect(call.create.transferCount).toBe(2);
        expect(call.create.holderCount).toBe(3);
        expect(call.update.burnVolume.increment).toBe(9999n);
        expect(call.update.transferCount.increment).toBe(2);
        expect(call.update.holderCount.increment).toBe(3);
      }
    });

    it("defaults transferCount and holderCount to 0 when not provided", async () => {
      const event: AnalyticsEvent = {
        tokenId: "token-minimal",
        burnVolume: 100n,
        eventTime: new Date("2024-01-01T00:00:00.000Z"),
      };

      await service.aggregateIntoBuckets(event);

      for (const call of upsertCalls as any[]) {
        expect(call.create.transferCount).toBe(0);
        expect(call.create.holderCount).toBe(0);
        expect(call.update.transferCount.increment).toBe(0);
        expect(call.update.holderCount.increment).toBe(0);
      }
    });
  });

  // ── Bucket values match sum of constituent raw rows ───────────────────────

  describe("bucket values match sum of constituent raw rows", () => {
    it("sum of burnVolumes across events equals total incremented into bucket", async () => {
      /**
       * Three burn events all falling into the same hour bucket.
       * The sum of each event's burnVolume must equal the total
       * that would be accumulated if Prisma actually ran these upserts
       * against a real database.
       *
       * We verify by summing the incremental `create.burnVolume` values
       * across all upsert calls for the "hour" granularity.
       */
      const events: AnalyticsEvent[] = [
        {
          tokenId: "token-sum",
          burnVolume: 100n,
          eventTime: new Date("2024-05-20T09:10:00.000Z"),
        },
        {
          tokenId: "token-sum",
          burnVolume: 250n,
          eventTime: new Date("2024-05-20T09:25:00.000Z"),
        },
        {
          tokenId: "token-sum",
          burnVolume: 650n,
          eventTime: new Date("2024-05-20T09:55:00.000Z"),
        },
      ];

      const expectedTotal = events.reduce((acc, e) => acc + e.burnVolume, 0n); // 1000n

      for (const event of events) {
        await service.aggregateIntoBuckets(event);
      }

      const hourCalls = (upsertCalls as any[]).filter(
        (c) =>
          c.where.tokenId_bucketStart_granularity.granularity === "hour" &&
          c.where.tokenId_bucketStart_granularity.tokenId === "token-sum"
      );

      // All three events land in the same hour bucket (09:xx UTC)
      const allSameBucket = hourCalls.every(
        (c: any) =>
          c.where.tokenId_bucketStart_granularity.bucketStart.toISOString() ===
          "2024-05-20T09:00:00.000Z"
      );
      expect(allSameBucket).toBe(true);

      const summedVolume = hourCalls.reduce(
        (acc: bigint, c: any) => acc + BigInt(c.create.burnVolume),
        0n
      );
      expect(summedVolume).toBe(expectedTotal);
    });

    it("events in different day buckets produce separate upsert keys", async () => {
      const events: AnalyticsEvent[] = [
        {
          tokenId: "token-days",
          burnVolume: 300n,
          eventTime: new Date("2024-07-01T12:00:00.000Z"),
        },
        {
          tokenId: "token-days",
          burnVolume: 700n,
          eventTime: new Date("2024-07-02T12:00:00.000Z"),
        },
      ];

      for (const event of events) {
        await service.aggregateIntoBuckets(event);
      }

      const dayCalls = (upsertCalls as any[]).filter(
        (c) =>
          c.where.tokenId_bucketStart_granularity.granularity === "day" &&
          c.where.tokenId_bucketStart_granularity.tokenId === "token-days"
      );

      const bucketDates = dayCalls.map((c: any) =>
        c.where.tokenId_bucketStart_granularity.bucketStart.toISOString()
      );

      expect(bucketDates).toContain("2024-07-01T00:00:00.000Z");
      expect(bucketDates).toContain("2024-07-02T00:00:00.000Z");
      expect(new Set(bucketDates).size).toBe(2);
    });

    it("events on different days in the same ISO-week share the week bucket key", async () => {
      // 2024-07-08 is Monday, 2024-07-10 is Wednesday — same ISO week
      const events: AnalyticsEvent[] = [
        {
          tokenId: "token-week",
          burnVolume: 400n,
          eventTime: new Date("2024-07-08T10:00:00.000Z"),
        },
        {
          tokenId: "token-week",
          burnVolume: 600n,
          eventTime: new Date("2024-07-10T16:00:00.000Z"),
        },
      ];

      for (const event of events) {
        await service.aggregateIntoBuckets(event);
      }

      const weekCalls = (upsertCalls as any[]).filter(
        (c) =>
          c.where.tokenId_bucketStart_granularity.granularity === "week" &&
          c.where.tokenId_bucketStart_granularity.tokenId === "token-week"
      );

      const bucketStarts = weekCalls.map((c: any) =>
        c.where.tokenId_bucketStart_granularity.bucketStart.toISOString()
      );

      // Both events map to Monday 2024-07-08
      expect(
        bucketStarts.every((s: string) => s === "2024-07-08T00:00:00.000Z")
      ).toBe(true);

      const totalVolume = weekCalls.reduce(
        (acc: bigint, c: any) => acc + BigInt(c.create.burnVolume),
        0n
      );
      expect(totalVolume).toBe(1000n);
    });

    it("the sum of volumes from different granularities all equal the event volume", async () => {
      const event: AnalyticsEvent = {
        tokenId: "token-verify",
        burnVolume: 12345n,
        eventTime: new Date("2024-08-15T07:30:00.000Z"),
      };

      await service.aggregateIntoBuckets(event);

      for (const gran of ["hour", "day", "week"]) {
        const call = (upsertCalls as any[]).find(
          (c) =>
            c.where.tokenId_bucketStart_granularity.granularity === gran &&
            c.where.tokenId_bucketStart_granularity.tokenId === "token-verify"
        );
        expect(call).toBeDefined();
        expect(BigInt(call.create.burnVolume)).toBe(12345n);
      }
    });
  });

  // ── getBuckets ────────────────────────────────────────────────────────────

  describe("getBuckets", () => {
    it("calls findMany with correct filters and maps results", async () => {
      const start = new Date("2024-01-01T00:00:00.000Z");
      const end = new Date("2024-01-08T00:00:00.000Z");

      const mockRows = [
        {
          bucketStart: new Date("2024-01-01T00:00:00.000Z"),
          granularity: "day",
          burnVolume: { toString: () => "123456" },
          transferCount: 10,
          holderCount: 5,
        },
      ];

      mockFindMany.mockResolvedValueOnce(mockRows);

      const results = await service.getBuckets("token-abc", "day", start, end);

      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            tokenId: "token-abc",
            granularity: "day",
            bucketStart: { gte: start, lt: end },
          },
          orderBy: { bucketStart: "asc" },
        })
      );

      expect(results).toHaveLength(1);
      expect(results[0].burnVolume).toBe("123456");
      expect(results[0].transferCount).toBe(10);
      expect(results[0].holderCount).toBe(5);
    });

    it("returns an empty array when no buckets exist", async () => {
      mockFindMany.mockResolvedValueOnce([]);

      const results = await service.getBuckets(
        "token-new",
        "hour",
        new Date(),
        new Date()
      );

      expect(results).toEqual([]);
    });

    it("preserves ordering from the database response", async () => {
      const rows = [
        {
          bucketStart: new Date("2024-01-01"),
          granularity: "day",
          burnVolume: { toString: () => "100" },
          transferCount: 1,
          holderCount: 0,
        },
        {
          bucketStart: new Date("2024-01-02"),
          granularity: "day",
          burnVolume: { toString: () => "200" },
          transferCount: 2,
          holderCount: 0,
        },
      ];
      mockFindMany.mockResolvedValueOnce(rows);

      const results = await service.getBuckets(
        "tok",
        "day",
        new Date("2024-01-01"),
        new Date("2024-01-03")
      );

      expect(results[0].burnVolume).toBe("100");
      expect(results[1].burnVolume).toBe("200");
    });
  });

  // ── backfillBuckets ───────────────────────────────────────────────────────

  describe("backfillBuckets", () => {
    let queryPageSpy: MockInstance;

    beforeEach(() => {
      // Spy on the protected queryBurnEventsPage method
      queryPageSpy = vi.spyOn(service as any, "queryBurnEventsPage");
    });

    it("processes all pages and returns correct counts", async () => {
      const pageSize = 2;
      const page1 = [
        { amount: "100", burned_at: new Date("2024-01-01T10:00:00Z") },
        { amount: "200", burned_at: new Date("2024-01-01T11:00:00Z") },
      ];
      const page2 = [
        { amount: "300", burned_at: new Date("2024-01-02T10:00:00Z") },
      ];

      queryPageSpy
        .mockResolvedValueOnce(page1)
        .mockResolvedValueOnce(page2)
        .mockResolvedValueOnce([]);

      const result = await service.backfillBuckets("token-abc", pageSize);

      expect(result.eventsProcessed).toBe(3);
      expect(result.pagesProcessed).toBe(2);
    });

    it("calls upsert for each granularity-bucket combination", async () => {
      const rows = [
        { amount: "500", burned_at: new Date("2024-03-15T14:30:00Z") },
      ];

      queryPageSpy
        .mockResolvedValueOnce(rows)
        .mockResolvedValueOnce([]);

      await service.backfillBuckets("token-abc", 100);

      // 1 event × 3 granularities = 3 upserts
      expect(mockUpsert).toHaveBeenCalledTimes(3);
    });

    it("stops immediately when query returns empty on first call", async () => {
      queryPageSpy.mockResolvedValueOnce([]);

      const result = await service.backfillBuckets("token-empty", 100);

      expect(result.eventsProcessed).toBe(0);
      expect(result.pagesProcessed).toBe(0);
      expect(mockUpsert).not.toHaveBeenCalled();
    });

    it("merges multiple events in the same bucket within a page before upserting", async () => {
      // Both events fall in the same hour bucket (10:xx)
      const rows = [
        { amount: "100", burned_at: new Date("2024-01-01T10:10:00Z") },
        { amount: "200", burned_at: new Date("2024-01-01T10:50:00Z") },
      ];

      queryPageSpy
        .mockResolvedValueOnce(rows)
        .mockResolvedValueOnce([]);

      await service.backfillBuckets("token-agg", 100);

      // Should be exactly 3 upserts (one per granularity), not 6,
      // because both events are merged within the same hour/day/week bucket
      expect(mockUpsert).toHaveBeenCalledTimes(3);

      const hourUpsert = mockUpsert.mock.calls.find(
        ([args]) =>
          args.where.tokenId_bucketStart_granularity.granularity === "hour"
      );

      expect(hourUpsert).toBeDefined();
      // Merged burnVolume: 100 + 200 = 300
      expect(hourUpsert![0].create.burnVolume).toBe(300n);
      expect(hourUpsert![0].create.transferCount).toBe(2);
    });

    it("backfill bucket values match the sum of constituent raw rows (correctness assertion)", async () => {
      /**
       * Core correctness test for issue #1357:
       * For a set of raw events, the backfilled bucket's burnVolume
       * must equal the arithmetic sum of all event amounts in that bucket.
       */
      const rawRows = [
        { amount: "1000", burned_at: new Date("2024-06-10T08:00:00Z") },
        { amount: "2500", burned_at: new Date("2024-06-10T08:30:00Z") },
        { amount: "500",  burned_at: new Date("2024-06-10T08:45:00Z") },
      ];

      // All in the same hour (08:xx on 2024-06-10) and same day/week
      const expectedHourVolume = 1000n + 2500n + 500n; // 4000n

      queryPageSpy
        .mockResolvedValueOnce(rawRows)
        .mockResolvedValueOnce([]);

      await service.backfillBuckets("token-correctness", 100);

      const hourUpsert = mockUpsert.mock.calls.find(
        ([args]) =>
          args.where.tokenId_bucketStart_granularity.granularity === "hour" &&
          args.where.tokenId_bucketStart_granularity.tokenId === "token-correctness"
      );

      expect(hourUpsert).toBeDefined();
      expect(hourUpsert![0].create.burnVolume).toBe(expectedHourVolume);
    });
  });
});
