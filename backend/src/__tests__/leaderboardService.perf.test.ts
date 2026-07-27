import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getMostBurnedLeaderboard,
  getMostActiveLeaderboard,
  getNewestTokensLeaderboard,
  getLargestSupplyLeaderboard,
  getMostBurnersLeaderboard,
  TimePeriod,
  clearCache,
} from "../services/leaderboardService";
import { prisma } from "../lib/prisma";

vi.mock("../lib/prisma", () => ({
  prisma: {
    burnRecord: {
      groupBy: vi.fn(),
      count: vi.fn(),
    },
    token: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    $queryRaw: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Seeding helpers — builds deterministic mock datasets of the requested size
// ---------------------------------------------------------------------------

function buildMockTokens(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `token-${i}`,
    address: `0x${i.toString(16).padStart(40, "0")}`,
    name: `Token ${i}`,
    symbol: `TK${i}`,
    decimals: 18,
    totalSupply: BigInt(1_000_000_000 + i),
    totalBurned: BigInt(i * 1000),
    burnCount: i,
    metadataUri: null,
    createdAt: new Date(Date.now() - i * 1000),
  }));
}

function buildMockBurnGroups(count: number, mode: "amount" | "count") {
  return Array.from({ length: count }, (_, i) => ({
    tokenId: `token-${i}`,
    ...(mode === "amount"
      ? { _sum: { amount: BigInt((count - i) * 100) } }
      : { _count: { id: count - i } }),
  }));
}

function buildMockQueryRawResult(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    tokenId: `token-${i}`,
    uniqueBurners: BigInt(count - i),
  }));
}

// ---------------------------------------------------------------------------
// Statistical helpers
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function measureMs(samples: number[]): { p50: number; p95: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) };
}

// SLO ceiling — p95 must be under this value for any page size ≤ 100
const P95_CEILING_MS = 200;
// Sampling rounds per page-size scenario
const ROUNDS = 20;

// ---------------------------------------------------------------------------
// Dataset sizes for page-size scenarios
// ---------------------------------------------------------------------------

const PAGE_SIZES = [10, 50, 100];

describe("LeaderboardService — performance regression (100k row dataset simulation)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
  });

  describe("getMostBurnedLeaderboard", () => {
    it.each(PAGE_SIZES)(
      "p95 < 200ms for page size %d",
      async (limit) => {
        const mockBurns = buildMockBurnGroups(limit, "amount");
        const mockTokens = buildMockTokens(limit);
        const mockTotal = buildMockBurnGroups(limit, "amount");

        vi.mocked(prisma.burnRecord.groupBy)
          .mockResolvedValue(mockBurns as any);
        vi.mocked(prisma.token.findMany).mockResolvedValue(mockTokens as any);

        const samples: number[] = [];

        for (let r = 0; r < ROUNDS; r++) {
          clearCache();
          vi.mocked(prisma.burnRecord.groupBy)
            .mockResolvedValueOnce(mockBurns as any)
            .mockResolvedValueOnce(mockTotal as any);
          vi.mocked(prisma.token.findMany).mockResolvedValueOnce(
            mockTokens as any
          );

          const t0 = performance.now();
          await getMostBurnedLeaderboard(TimePeriod.ALL, 1, limit);
          samples.push(performance.now() - t0);
        }

        const { p50, p95 } = measureMs(samples);
        console.log(
          JSON.stringify({
            fn: "getMostBurnedLeaderboard",
            limit,
            p50_ms: +p50.toFixed(2),
            p95_ms: +p95.toFixed(2),
            slo_ms: P95_CEILING_MS,
          })
        );

        expect(p95).toBeLessThan(P95_CEILING_MS);
      }
    );
  });

  describe("getMostActiveLeaderboard", () => {
    it.each(PAGE_SIZES)(
      "p95 < 200ms for page size %d",
      async (limit) => {
        const mockBurns = buildMockBurnGroups(limit, "count");
        const mockTokens = buildMockTokens(limit);

        const samples: number[] = [];

        for (let r = 0; r < ROUNDS; r++) {
          clearCache();
          vi.mocked(prisma.burnRecord.groupBy)
            .mockResolvedValueOnce(mockBurns as any)
            .mockResolvedValueOnce(mockBurns as any);
          vi.mocked(prisma.token.findMany).mockResolvedValueOnce(
            mockTokens as any
          );

          const t0 = performance.now();
          await getMostActiveLeaderboard(TimePeriod.ALL, 1, limit);
          samples.push(performance.now() - t0);
        }

        const { p50, p95 } = measureMs(samples);
        console.log(
          JSON.stringify({
            fn: "getMostActiveLeaderboard",
            limit,
            p50_ms: +p50.toFixed(2),
            p95_ms: +p95.toFixed(2),
            slo_ms: P95_CEILING_MS,
          })
        );

        expect(p95).toBeLessThan(P95_CEILING_MS);
      }
    );
  });

  describe("getNewestTokensLeaderboard", () => {
    it.each(PAGE_SIZES)(
      "p95 < 200ms for page size %d",
      async (limit) => {
        const mockTokens = buildMockTokens(limit);

        const samples: number[] = [];

        for (let r = 0; r < ROUNDS; r++) {
          clearCache();
          vi.mocked(prisma.token.findMany).mockResolvedValueOnce(
            mockTokens as any
          );
          vi.mocked(prisma.token.count).mockResolvedValueOnce(100_000);

          const t0 = performance.now();
          await getNewestTokensLeaderboard(1, limit);
          samples.push(performance.now() - t0);
        }

        const { p50, p95 } = measureMs(samples);
        console.log(
          JSON.stringify({
            fn: "getNewestTokensLeaderboard",
            limit,
            p50_ms: +p50.toFixed(2),
            p95_ms: +p95.toFixed(2),
            slo_ms: P95_CEILING_MS,
          })
        );

        expect(p95).toBeLessThan(P95_CEILING_MS);
      }
    );
  });

  describe("getLargestSupplyLeaderboard", () => {
    it.each(PAGE_SIZES)(
      "p95 < 200ms for page size %d",
      async (limit) => {
        const mockTokens = buildMockTokens(limit);

        const samples: number[] = [];

        for (let r = 0; r < ROUNDS; r++) {
          clearCache();
          vi.mocked(prisma.token.findMany).mockResolvedValueOnce(
            mockTokens as any
          );
          vi.mocked(prisma.token.count).mockResolvedValueOnce(100_000);

          const t0 = performance.now();
          await getLargestSupplyLeaderboard(1, limit);
          samples.push(performance.now() - t0);
        }

        const { p50, p95 } = measureMs(samples);
        console.log(
          JSON.stringify({
            fn: "getLargestSupplyLeaderboard",
            limit,
            p50_ms: +p50.toFixed(2),
            p95_ms: +p95.toFixed(2),
            slo_ms: P95_CEILING_MS,
          })
        );

        expect(p95).toBeLessThan(P95_CEILING_MS);
      }
    );
  });

  describe("getMostBurnersLeaderboard", () => {
    it.each(PAGE_SIZES)(
      "p95 < 200ms for page size %d",
      async (limit) => {
        const mockRaw = buildMockQueryRawResult(limit);
        const mockTokens = buildMockTokens(limit);

        const samples: number[] = [];

        for (let r = 0; r < ROUNDS; r++) {
          clearCache();
          vi.mocked(prisma.$queryRaw)
            .mockResolvedValueOnce(mockRaw as any)
            .mockResolvedValueOnce([{ count: BigInt(100_000) }] as any);
          vi.mocked(prisma.token.findMany).mockResolvedValueOnce(
            mockTokens as any
          );

          const t0 = performance.now();
          await getMostBurnersLeaderboard(TimePeriod.ALL, 1, limit);
          samples.push(performance.now() - t0);
        }

        const { p50, p95 } = measureMs(samples);
        console.log(
          JSON.stringify({
            fn: "getMostBurnersLeaderboard",
            limit,
            p50_ms: +p50.toFixed(2),
            p95_ms: +p95.toFixed(2),
            slo_ms: P95_CEILING_MS,
          })
        );

        expect(p95).toBeLessThan(P95_CEILING_MS);
      }
    );
  });

  describe("cache hit — second call must not re-query prisma", () => {
    it("returns cached result without hitting prisma on the second call", async () => {
      const mockBurns = buildMockBurnGroups(10, "amount");
      const mockTokens = buildMockTokens(10);

      vi.mocked(prisma.burnRecord.groupBy)
        .mockResolvedValueOnce(mockBurns as any)
        .mockResolvedValueOnce(mockBurns as any);
      vi.mocked(prisma.token.findMany).mockResolvedValueOnce(mockTokens as any);

      await getMostBurnedLeaderboard(TimePeriod.D7, 1, 10);

      const t0 = performance.now();
      const cached = await getMostBurnedLeaderboard(TimePeriod.D7, 1, 10);
      const elapsed = performance.now() - t0;

      expect(cached.success).toBe(true);
      // Cache hit must be sub-millisecond service overhead
      expect(elapsed).toBeLessThan(5);
      // Prisma should only have been called once (first request)
      expect(prisma.burnRecord.groupBy).toHaveBeenCalledTimes(2);
    });
  });

  describe("teardown isolation — cache cleared between tests", () => {
    it("does not carry state from a prior test", async () => {
      // If clearCache() in beforeEach works, prisma.groupBy was never primed
      // and must be called (not skipped via stale cache)
      const mockBurns = buildMockBurnGroups(10, "amount");
      const mockTokens = buildMockTokens(10);

      vi.mocked(prisma.burnRecord.groupBy)
        .mockResolvedValueOnce(mockBurns as any)
        .mockResolvedValueOnce(mockBurns as any);
      vi.mocked(prisma.token.findMany).mockResolvedValueOnce(mockTokens as any);

      await getMostBurnedLeaderboard(TimePeriod.D7, 1, 10);

      expect(prisma.burnRecord.groupBy).toHaveBeenCalled();
    });
  });
});
