import {
  Controller,
  Get,
  Param,
  Query,
  UseInterceptors,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { CacheInterceptor, CacheTTL } from "@nestjs/cache-manager";
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiQuery,
} from "@nestjs/swagger";
import { AnalyticsService } from "./analytics.service";
import {
  GetAnalyticsQueryDto,
  GetAggregateBurnQueryDto,
  TimePeriod,
  TokenAnalyticsResponseDto,
  AggregateBurnResponseDto,
} from "./dto/analytics.dto";

import { Router, Request, Response } from "express";
import { analyticsService, Granularity, TimePeriod } from "./analytics.service";

  /**
   * GET /api/analytics/:address
   *
   * Returns comprehensive burn analytics for a specific token.
   * Results are cached per (address + period) combination.
   *
   * Cache TTL:
   *  - 24h  → 2 min  (fast-moving data)
   *  - 7d   → 5 min
   *  - 30d  → 10 min
   *  - 90d  → 15 min
   *  - all  → 30 min (slow-moving data)
   */
  @Get("burn/aggregate")
  @HttpCode(HttpStatus.OK)
  @CacheTTL(120_000)
  @ApiOperation({
    summary: "Get cross-token aggregate burn statistics",
    description:
      "Returns total burn volume across all tokens, a 7-day rolling burn-rate trend, the top-5 burners by wallet, and per-token summaries. Filterable by date range.",
  })
  @ApiQuery({ name: "startDate", required: false, description: "ISO date string for range start (default: 30 days ago)" })
  @ApiQuery({ name: "endDate", required: false, description: "ISO date string for range end (default: now)" })
  @ApiResponse({ status: 200, description: "Aggregate burn data", type: AggregateBurnResponseDto })
  async getAggregateBurnStats(
    @Query() query: GetAggregateBurnQueryDto
  ): Promise<AggregateBurnResponseDto> {
    const startDate = query.startDate ? new Date(query.startDate) : undefined;
    const endDate = query.endDate ? new Date(query.endDate) : undefined;
    return this.analyticsService.getAggregateBurnStats(startDate, endDate);
  }

  @Get(":address")
  @HttpCode(HttpStatus.OK)
  @CacheTTL(300) // default 5 min; see note above
  @ApiOperation({
    summary: "Get token burn analytics",
    description:
      "Returns burn statistics, time-series data for charts, burn-type distribution, and comparison metrics for the requested time period.",
  })
  @ApiParam({
    name: "address",
    description: "Token contract address (EVM hex address)",
    example: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  })
  @ApiQuery({
    name: "period",
    required: false,
    enum: TimePeriod,
    description: "Aggregation window (default: 7d)",
  })
  @ApiResponse({
    status: 200,
    description: "Analytics data for the token",
    type: TokenAnalyticsResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: "No burn data found for this token address",
  })
  async getTokenAnalytics(
    @Param("address") address: string,
    @Query() query: GetAnalyticsQueryDto
  ): Promise<TokenAnalyticsResponseDto> {
    return this.analyticsService.getTokenAnalytics(
      address,
      query.period ?? TimePeriod.D7
    );
  }
}

/**
 * GET /api/token-analytics/:address
 *
 * Query params:
 *   period      - "24h" | "7d" | "30d" | "90d" | "all"  (default: "7d")
 *   granularity - "hour" | "day" | "week"                (optional)
 *
 * When granularity is provided, returns pre-aggregated bucket rows
 * instead of the full analytics response (10-100x faster for busy tokens).
 */
router.get("/:address", async (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    const rawPeriod = (req.query.period as string) ?? "7d";
    const rawGranularity = req.query.granularity as string | undefined;

    const period: TimePeriod = VALID_PERIODS.includes(rawPeriod as TimePeriod)
      ? (rawPeriod as TimePeriod)
      : "7d";

    if (rawGranularity !== undefined) {
      if (!VALID_GRANULARITIES.includes(rawGranularity as Granularity)) {
        return res.status(400).json({
          error: `Invalid granularity. Must be one of: ${VALID_GRANULARITIES.join(", ")}`,
        });
      }

      const granularity = rawGranularity as Granularity;
      const { start, end } = periodToWindow(period);
      const buckets = await analyticsService.getBuckets(
        address.toLowerCase(),
        granularity,
        start,
        end
      );
      return res.json(buckets);
    }

    const data = await analyticsService.getTokenAnalytics(address, period);
    return res.json(data);
  } catch (err: any) {
    if (err?.status === 404) {
      return res.status(404).json({ error: err.message });
    }
    console.error("[analytics] unexpected error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
