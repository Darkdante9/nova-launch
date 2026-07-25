/**
 * Dividend Distribution Service – Unit Tests
 *
 * Coverage targets:
 *  - createDividendPool: happy path, validation errors, missing token, zero amounts
 *  - claimDividend: happy path, duplicate claim, expired pool, inactive pool,
 *                   missing snapshot, insufficient funds, zero claimable
 *  - getHolderClaimable: found / not found
 *  - listDividendPools: pagination, filters
 *  - getDividendPool: found / not found
 *  - cancelDividendPool: happy path, wrong funder, non-active pool
 *  - computeClaimable (via createDividendPool): pro-rata, cap enforcement
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createDividendPool,
  claimDividend,
  getHolderClaimable,
  listDividendPools,
  getDividendPool,
  cancelDividendPool,
  CreatePoolSchema,
  ClaimSchema,
} from "../services/dividendService";
import { prisma } from "../lib/prisma";

// ─── Mock Prisma ────────────────────────────────────────────────────────────

vi.mock("../lib/prisma", () => ({
  prisma: {
    token: { findUnique: vi.fn() },
    dividendPool: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    holderSnapshot: { findUnique: vi.fn() },
    dividendClaim: {
      create: vi.fn(),
      findFirst: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

// ─── Fixtures ───────────────────────────────────────────────────────────────

// RFC 4122-compliant UUIDs (version nibble in [1-8], variant nibble in [89ab])
const TOKEN_ID = "11111111-1111-4111-8111-111111111111";
const POOL_ID = "22222222-2222-4222-8222-222222222222";
const HOLDER_A = "GABC1234";
const HOLDER_B = "GDEF5678";

const basePoolInput = {
  tokenId: TOKEN_ID,
  fundedBy: "GADMIN",
  totalAmount: "1000000",
  supplySnapshot: "10000000",
  perHolderCap: "0",
  txHash: "abc123txhash",
  holders: [
    { holder: HOLDER_A, balance: "5000000" },
    { holder: HOLDER_B, balance: "2500000" },
  ],
};

const mockToken = { id: TOKEN_ID, name: "TestToken", symbol: "TST" };

const mockPool = {
  id: POOL_ID,
  tokenId: TOKEN_ID,
  fundedBy: "GADMIN",
  totalAmount: BigInt("1000000"),
  claimedAmount: BigInt("0"),
  supplySnapshot: BigInt("10000000"),
  perHolderCap: BigInt("0"),
  expiresAt: null,
  status: "ACTIVE",
  txHash: "abc123txhash",
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
  _count: { claims: 0, snapshots: 2 },
};

// ─── Validation schema tests ─────────────────────────────────────────────────

describe("CreatePoolSchema validation", () => {
  it("accepts valid input", () => {
    const result = CreatePoolSchema.safeParse(basePoolInput);
    expect(result.success).toBe(true);
  });

  it("rejects non-UUID tokenId", () => {
    const result = CreatePoolSchema.safeParse({ ...basePoolInput, tokenId: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("rejects non-numeric totalAmount", () => {
    const result = CreatePoolSchema.safeParse({ ...basePoolInput, totalAmount: "abc" });
    expect(result.success).toBe(false);
  });

  it("rejects empty holders array", () => {
    const result = CreatePoolSchema.safeParse({ ...basePoolInput, holders: [] });
    expect(result.success).toBe(false);
  });

  it("rejects invalid expiresAt", () => {
    const result = CreatePoolSchema.safeParse({ ...basePoolInput, expiresAt: "not-a-date" });
    expect(result.success).toBe(false);
  });

  it("defaults perHolderCap to '0' when omitted", () => {
    const { perHolderCap: _, ...withoutCap } = basePoolInput;
    const result = CreatePoolSchema.safeParse(withoutCap);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.perHolderCap).toBe("0");
  });
});

describe("ClaimSchema validation", () => {
  it("accepts valid input", () => {
    const result = ClaimSchema.safeParse({ poolId: POOL_ID, claimant: HOLDER_A, txHash: "tx1" });
    expect(result.success).toBe(true);
  });

  it("rejects non-UUID poolId", () => {
    const result = ClaimSchema.safeParse({ poolId: "bad", claimant: HOLDER_A, txHash: "tx1" });
    expect(result.success).toBe(false);
  });

  it("rejects missing claimant", () => {
    const result = ClaimSchema.safeParse({ poolId: POOL_ID, txHash: "tx1" });
    expect(result.success).toBe(false);
  });
});

// ─── createDividendPool ──────────────────────────────────────────────────────

describe("createDividendPool", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a pool and returns serialized summary", async () => {
    vi.mocked(prisma.token.findUnique).mockResolvedValue(mockToken as any);
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) =>
      fn({
        dividendPool: {
          create: vi.fn().mockResolvedValue(mockPool),
        },
      })
    );

    const result = await createDividendPool(basePoolInput);

    expect(result.id).toBe(POOL_ID);
    expect(result.totalAmount).toBe("1000000");
    expect(result.remainingAmount).toBe("1000000");
    expect(result.status).toBe("ACTIVE");
  });

  it("throws when token does not exist", async () => {
    vi.mocked(prisma.token.findUnique).mockResolvedValue(null);

    await expect(createDividendPool(basePoolInput)).rejects.toThrow(
      `Token not found: ${TOKEN_ID}`
    );
  });

  it("throws when totalAmount is zero", async () => {
    vi.mocked(prisma.token.findUnique).mockResolvedValue(mockToken as any);

    await expect(
      createDividendPool({ ...basePoolInput, totalAmount: "0" })
    ).rejects.toThrow("totalAmount must be greater than zero");
  });

  it("throws when supplySnapshot is zero", async () => {
    vi.mocked(prisma.token.findUnique).mockResolvedValue(mockToken as any);

    await expect(
      createDividendPool({ ...basePoolInput, supplySnapshot: "0" })
    ).rejects.toThrow("supplySnapshot must be greater than zero");
  });

  it("computes pro-rata claimable correctly (no cap)", async () => {
    // HOLDER_A has 5_000_000 / 10_000_000 = 50% → 500_000
    // HOLDER_B has 2_500_000 / 10_000_000 = 25% → 250_000
    let capturedData: any;
    vi.mocked(prisma.token.findUnique).mockResolvedValue(mockToken as any);
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      const mockCreate = vi.fn().mockImplementation(async ({ data }: any) => {
        capturedData = data;
        return mockPool;
      });
      return fn({ dividendPool: { create: mockCreate } });
    });

    await createDividendPool(basePoolInput);

    const snapshots = capturedData.snapshots.createMany.data;
    const holderA = snapshots.find((s: any) => s.holder === HOLDER_A);
    const holderB = snapshots.find((s: any) => s.holder === HOLDER_B);

    expect(holderA.claimable).toBe(500000n);
    expect(holderB.claimable).toBe(250000n);
  });

  it("enforces perHolderCap when set", async () => {
    let capturedData: any;
    vi.mocked(prisma.token.findUnique).mockResolvedValue(mockToken as any);
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      const mockCreate = vi.fn().mockImplementation(async ({ data }: any) => {
        capturedData = data;
        return mockPool;
      });
      return fn({ dividendPool: { create: mockCreate } });
    });

    // Cap at 300_000 – HOLDER_A would get 500_000 but is capped
    await createDividendPool({ ...basePoolInput, perHolderCap: "300000" });

    const snapshots = capturedData.snapshots.createMany.data;
    const holderA = snapshots.find((s: any) => s.holder === HOLDER_A);
    const holderB = snapshots.find((s: any) => s.holder === HOLDER_B);

    expect(holderA.claimable).toBe(300000n); // capped
    expect(holderB.claimable).toBe(250000n); // under cap, unchanged
  });
});

// ─── claimDividend ───────────────────────────────────────────────────────────

describe("claimDividend", () => {
  const claimInput = { poolId: POOL_ID, claimant: HOLDER_A, txHash: "claimtx1" };

  const mockSnapshot = {
    poolId: POOL_ID,
    holder: HOLDER_A,
    balance: BigInt("5000000"),
    claimable: BigInt("500000"),
  };

  beforeEach(() => vi.clearAllMocks());

  it("processes a valid claim and returns ClaimResult", async () => {
    const mockClaim = {
      id: "claim-uuid",
      poolId: POOL_ID,
      claimant: HOLDER_A,
      amount: BigInt("500000"),
      txHash: "claimtx1",
      claimedAt: new Date("2024-01-02"),
    };

    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      return fn({
        dividendPool: {
          findUnique: vi.fn().mockResolvedValue(mockPool),
          update: vi.fn().mockResolvedValue(mockPool),
        },
        holderSnapshot: {
          findUnique: vi.fn().mockResolvedValue(mockSnapshot),
        },
        dividendClaim: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue(mockClaim),
        },
      });
    });

    const result = await claimDividend(claimInput);

    expect(result.claimId).toBe("claim-uuid");
    expect(result.amount).toBe("500000");
    expect(result.claimant).toBe(HOLDER_A);
  });

  it("throws when pool does not exist", async () => {
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      return fn({
        dividendPool: { findUnique: vi.fn().mockResolvedValue(null) },
      });
    });

    await expect(claimDividend(claimInput)).rejects.toThrow("not found");
  });

  it("throws when pool is not ACTIVE", async () => {
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      return fn({
        dividendPool: {
          findUnique: vi.fn().mockResolvedValue({ ...mockPool, status: "EXHAUSTED" }),
        },
      });
    });

    await expect(claimDividend(claimInput)).rejects.toThrow("not active");
  });

  it("auto-expires and throws when pool expiresAt is in the past", async () => {
    const expiredPool = {
      ...mockPool,
      expiresAt: new Date("2020-01-01"),
    };

    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      return fn({
        dividendPool: {
          findUnique: vi.fn().mockResolvedValue(expiredPool),
          update: vi.fn().mockResolvedValue({ ...expiredPool, status: "EXPIRED" }),
        },
      });
    });

    await expect(claimDividend(claimInput)).rejects.toThrow("expired");
  });

  it("throws when holder has no snapshot", async () => {
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      return fn({
        dividendPool: { findUnique: vi.fn().mockResolvedValue(mockPool) },
        holderSnapshot: { findUnique: vi.fn().mockResolvedValue(null) },
      });
    });

    await expect(claimDividend(claimInput)).rejects.toThrow("No snapshot found");
  });

  it("throws on duplicate claim", async () => {
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      return fn({
        dividendPool: { findUnique: vi.fn().mockResolvedValue(mockPool) },
        holderSnapshot: { findUnique: vi.fn().mockResolvedValue(mockSnapshot) },
        dividendClaim: {
          findFirst: vi.fn().mockResolvedValue({ id: "existing-claim" }),
        },
      });
    });

    await expect(claimDividend(claimInput)).rejects.toThrow("already claimed");
  });

  it("throws when claimable amount is zero", async () => {
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      return fn({
        dividendPool: { findUnique: vi.fn().mockResolvedValue(mockPool) },
        holderSnapshot: {
          findUnique: vi.fn().mockResolvedValue({ ...mockSnapshot, claimable: 0n }),
        },
        dividendClaim: { findFirst: vi.fn().mockResolvedValue(null) },
      });
    });

    await expect(claimDividend(claimInput)).rejects.toThrow("zero");
  });

  it("throws when pool has insufficient remaining funds", async () => {
    const nearlyExhaustedPool = {
      ...mockPool,
      totalAmount: BigInt("1000000"),
      claimedAmount: BigInt("999999"), // only 1 left, but claimable is 500_000
    };

    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      return fn({
        dividendPool: { findUnique: vi.fn().mockResolvedValue(nearlyExhaustedPool) },
        holderSnapshot: { findUnique: vi.fn().mockResolvedValue(mockSnapshot) },
        dividendClaim: { findFirst: vi.fn().mockResolvedValue(null) },
      });
    });

    await expect(claimDividend(claimInput)).rejects.toThrow("Insufficient pool funds");
  });
});

// ─── getHolderClaimable ──────────────────────────────────────────────────────

describe("getHolderClaimable", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns claimable info when snapshot exists and not yet claimed", async () => {
    vi.mocked(prisma.holderSnapshot.findUnique).mockResolvedValue({
      poolId: POOL_ID,
      holder: HOLDER_A,
      claimable: BigInt("500000"),
    } as any);
    vi.mocked(prisma.dividendClaim.findFirst).mockResolvedValue(null);

    const result = await getHolderClaimable(POOL_ID, HOLDER_A);

    expect(result.claimable).toBe("500000");
    expect(result.alreadyClaimed).toBe(false);
    expect(result.claimedAmount).toBe("0");
  });

  it("returns alreadyClaimed=true when claim exists", async () => {
    vi.mocked(prisma.holderSnapshot.findUnique).mockResolvedValue({
      poolId: POOL_ID,
      holder: HOLDER_A,
      claimable: BigInt("500000"),
    } as any);
    vi.mocked(prisma.dividendClaim.findFirst).mockResolvedValue({
      id: "c1",
      amount: BigInt("500000"),
    } as any);

    const result = await getHolderClaimable(POOL_ID, HOLDER_A);

    expect(result.alreadyClaimed).toBe(true);
    expect(result.claimedAmount).toBe("500000");
  });

  it("throws when no snapshot found", async () => {
    vi.mocked(prisma.holderSnapshot.findUnique).mockResolvedValue(null);

    await expect(getHolderClaimable(POOL_ID, HOLDER_A)).rejects.toThrow(
      "No snapshot"
    );
  });
});

// ─── listDividendPools ───────────────────────────────────────────────────────

describe("listDividendPools", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns paginated list of pools", async () => {
    vi.mocked(prisma.dividendPool.count).mockResolvedValue(1);
    vi.mocked(prisma.dividendPool.findMany).mockResolvedValue([mockPool] as any);

    const result = await listDividendPools({ page: 1, limit: 10 });

    expect(result.data).toHaveLength(1);
    expect(result.pagination.total).toBe(1);
    expect(result.pagination.totalPages).toBe(1);
  });

  it("filters by tokenId", async () => {
    vi.mocked(prisma.dividendPool.count).mockResolvedValue(0);
    vi.mocked(prisma.dividendPool.findMany).mockResolvedValue([]);

    const result = await listDividendPools({ tokenId: TOKEN_ID, page: 1, limit: 10 });

    expect(result.data).toHaveLength(0);
    expect(prisma.dividendPool.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tokenId: TOKEN_ID }) })
    );
  });

  it("filters by status", async () => {
    vi.mocked(prisma.dividendPool.count).mockResolvedValue(0);
    vi.mocked(prisma.dividendPool.findMany).mockResolvedValue([]);

    await listDividendPools({ status: "EXPIRED", page: 1, limit: 10 });

    expect(prisma.dividendPool.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: "EXPIRED" }) })
    );
  });

  it("calculates correct skip for page 2", async () => {
    vi.mocked(prisma.dividendPool.count).mockResolvedValue(25);
    vi.mocked(prisma.dividendPool.findMany).mockResolvedValue([]);

    await listDividendPools({ page: 2, limit: 10 });

    expect(prisma.dividendPool.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10, take: 10 })
    );
  });
});

// ─── getDividendPool ─────────────────────────────────────────────────────────

describe("getDividendPool", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns pool when found", async () => {
    vi.mocked(prisma.dividendPool.findUnique).mockResolvedValue(mockPool as any);

    const result = await getDividendPool(POOL_ID);
    expect(result.id).toBe(POOL_ID);
  });

  it("throws when pool not found", async () => {
    vi.mocked(prisma.dividendPool.findUnique).mockResolvedValue(null);

    await expect(getDividendPool(POOL_ID)).rejects.toThrow("not found");
  });
});

// ─── cancelDividendPool ──────────────────────────────────────────────────────

describe("cancelDividendPool", () => {
  beforeEach(() => vi.clearAllMocks());

  it("cancels an active pool when requested by funder", async () => {
    vi.mocked(prisma.dividendPool.findUnique).mockResolvedValue(mockPool as any);
    vi.mocked(prisma.dividendPool.update).mockResolvedValue({
      ...mockPool,
      status: "CANCELLED",
    } as any);

    const result = await cancelDividendPool(POOL_ID, "GADMIN");
    expect(result.status).toBe("CANCELLED");
  });

  it("throws when pool not found", async () => {
    vi.mocked(prisma.dividendPool.findUnique).mockResolvedValue(null);

    await expect(cancelDividendPool(POOL_ID, "GADMIN")).rejects.toThrow("not found");
  });

  it("throws when pool is not ACTIVE", async () => {
    vi.mocked(prisma.dividendPool.findUnique).mockResolvedValue({
      ...mockPool,
      status: "EXHAUSTED",
    } as any);

    await expect(cancelDividendPool(POOL_ID, "GADMIN")).rejects.toThrow(
      "Only ACTIVE pools can be cancelled"
    );
  });

  it("throws when requestedBy is not the funder", async () => {
    vi.mocked(prisma.dividendPool.findUnique).mockResolvedValue(mockPool as any);

    await expect(cancelDividendPool(POOL_ID, "GOTHER")).rejects.toThrow(
      "Only the pool funder"
    );
  });
});

// ─── Edge cases ──────────────────────────────────────────────────────────────

describe("Edge cases", () => {
  beforeEach(() => vi.clearAllMocks());

  it("handles holder with zero balance (claimable = 0)", async () => {
    let capturedData: any;
    vi.mocked(prisma.token.findUnique).mockResolvedValue(mockToken as any);
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      const mockCreate = vi.fn().mockImplementation(async ({ data }: any) => {
        capturedData = data;
        return mockPool;
      });
      return fn({ dividendPool: { create: mockCreate } });
    });

    await createDividendPool({
      ...basePoolInput,
      holders: [{ holder: HOLDER_A, balance: "0" }],
    });

    const snapshots = capturedData.snapshots.createMany.data;
    expect(snapshots[0].claimable).toBe(0n);
  });

  it("serializes BigInt fields as strings in pool summary", async () => {
    vi.mocked(prisma.dividendPool.findUnique).mockResolvedValue(mockPool as any);

    const result = await getDividendPool(POOL_ID);

    // All numeric fields must be strings (JSON-safe)
    expect(typeof result.totalAmount).toBe("string");
    expect(typeof result.claimedAmount).toBe("string");
    expect(typeof result.remainingAmount).toBe("string");
    expect(typeof result.supplySnapshot).toBe("string");
  });

  it("remainingAmount equals totalAmount - claimedAmount", async () => {
    const partialPool = {
      ...mockPool,
      totalAmount: BigInt("1000000"),
      claimedAmount: BigInt("300000"),
    };
    vi.mocked(prisma.dividendPool.findUnique).mockResolvedValue(partialPool as any);

    const result = await getDividendPool(POOL_ID);
    expect(result.remainingAmount).toBe("700000");
  });
});

// ─── Issue #1063: Dividend Pro-Rata Precision & Rounding ──────────────────────

describe("Issue #1063: Dividend pro-rata precision and rounding safety", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sum of all individual claims never exceeds pool total", async () => {
    // Pool: 1000 units, 3 holders with uneven distribution
    // Holder A: 333 / 1000 = 33.3% → 333
    // Holder B: 333 / 1000 = 33.3% → 333
    // Holder C: 334 / 1000 = 33.4% → 334
    // Total: 333 + 333 + 334 = 1000 (no overflow)
    let capturedData: any;
    vi.mocked(prisma.token.findUnique).mockResolvedValue(mockToken as any);
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      const mockCreate = vi.fn().mockImplementation(async ({ data }: any) => {
        capturedData = data;
        return mockPool;
      });
      return fn({ dividendPool: { create: mockCreate } });
    });

    await createDividendPool({
      tokenId: TOKEN_ID,
      fundedBy: "GADMIN",
      totalAmount: "1000",
      supplySnapshot: "1000",
      perHolderCap: "0",
      txHash: "tx-uneven",
      holders: [
        { holder: "H1", balance: "333" },
        { holder: "H2", balance: "333" },
        { holder: "H3", balance: "334" },
      ],
    });

    const snapshots = capturedData.snapshots.createMany.data;
    const totalClaimed = snapshots.reduce(
      (sum: bigint, s: any) => sum + s.claimable,
      0n
    );

    expect(totalClaimed).toBeLessThanOrEqual(1000n);
    expect(totalClaimed).toBe(1000n); // All distributed
  });

  it("handles uneven divisions: floor division leaves dust undistributed", async () => {
    // Pool: 100 units, 3 equal holders each with balance 100/300 = 33.33...
    // The service uses floor(holderBalance * totalAmount / supplySnapshot):
    //   floor(100 * 100 / 300) = floor(10000 / 300) = floor(33.33) = 33 each
    // Dust = 100 - (33 + 33 + 33) = 1 unit; this unit remains in the pool
    // (not reallocated — the service makes no dust-redistribution guarantee)
    let capturedData: any;
    vi.mocked(prisma.token.findUnique).mockResolvedValue(mockToken as any);
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      const mockCreate = vi.fn().mockImplementation(async ({ data }: any) => {
        capturedData = data;
        return mockPool;
      });
      return fn({ dividendPool: { create: mockCreate } });
    });

    await createDividendPool({
      tokenId: TOKEN_ID,
      fundedBy: "GADMIN",
      totalAmount: "100",
      supplySnapshot: "300",
      perHolderCap: "0",
      txHash: "tx-dust",
      holders: [
        { holder: "H1", balance: "100" },
        { holder: "H2", balance: "100" },
        { holder: "H3", balance: "100" },
      ],
    });

    const snapshots = capturedData.snapshots.createMany.data;
    const amounts = snapshots.map((s: any) => s.claimable);

    // Each holder gets floor(33.33) = 33 — no dust redistribution
    expect(amounts[0]).toBe(33n);
    expect(amounts[1]).toBe(33n);
    expect(amounts[2]).toBe(33n);

    // Total paid out is 99, leaving 1 unit of dust in the pool (never exceeds pool)
    const totalClaimed = amounts.reduce((a: bigint, b: bigint) => a + b, 0n);
    expect(totalClaimed).toBe(99n);
    expect(totalClaimed).toBeLessThanOrEqual(100n);
  });

  it("holder with zero eligible balance receives zero", async () => {
    let capturedData: any;
    vi.mocked(prisma.token.findUnique).mockResolvedValue(mockToken as any);
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      const mockCreate = vi.fn().mockImplementation(async ({ data }: any) => {
        capturedData = data;
        return mockPool;
      });
      return fn({ dividendPool: { create: mockCreate } });
    });

    await createDividendPool({
      tokenId: TOKEN_ID,
      fundedBy: "GADMIN",
      totalAmount: "1000",
      supplySnapshot: "1000",
      perHolderCap: "0",
      txHash: "tx-zero",
      holders: [
        { holder: "ACTIVE", balance: "1000" },
        { holder: "INACTIVE", balance: "0" },
      ],
    });

    const snapshots = capturedData.snapshots.createMany.data;
    const inactive = snapshots.find((s: any) => s.holder === "INACTIVE");

    expect(inactive.claimable).toBe(0n);
  });

  it("prevents double-claim via unique constraint on (poolId, claimant)", async () => {
    const claimInput = { poolId: POOL_ID, claimant: HOLDER_A, txHash: "tx1" };
    const mockSnapshot = {
      poolId: POOL_ID,
      holder: HOLDER_A,
      balance: BigInt("5000000"),
      claimable: BigInt("500000"),
    };
    const mockClaim = {
      id: "claim-1",
      poolId: POOL_ID,
      claimant: HOLDER_A,
      amount: BigInt("500000"),
      txHash: "tx1",
      claimedAt: new Date(),
    };

    vi.mocked(prisma.dividendPool.findUnique).mockResolvedValue(mockPool as any);
    vi.mocked(prisma.holderSnapshot.findUnique).mockResolvedValue(mockSnapshot as any);

    // First claim succeeds
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) =>
      fn({
        dividendClaim: { create: vi.fn().mockResolvedValue(mockClaim) },
        dividendPool: { update: vi.fn().mockResolvedValue(mockPool) },
      })
    );

    const result1 = await claimDividend(claimInput);
    expect(result1.amount).toBe("500000");

    // Second claim with same (poolId, claimant) fails
    vi.mocked(prisma.dividendClaim.findFirst).mockResolvedValue(mockClaim as any);

    await expect(claimDividend(claimInput)).rejects.toThrow(
      "Holder has already claimed from this pool"
    );
  });

  it("large pool with many holders maintains precision", async () => {
    // Simulate 1000 holders with varying balances
    const holders = Array.from({ length: 1000 }, (_, i) => ({
      holder: `H${i}`,
      balance: String(1000 + i), // 1000 to 1999
    }));

    const totalSupply = holders.reduce(
      (sum, h) => sum + BigInt(h.balance),
      0n
    );
    const poolAmount = "1000000000"; // 1 billion

    let capturedData: any;
    vi.mocked(prisma.token.findUnique).mockResolvedValue(mockToken as any);
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      const mockCreate = vi.fn().mockImplementation(async ({ data }: any) => {
        capturedData = data;
        return mockPool;
      });
      return fn({ dividendPool: { create: mockCreate } });
    });

    await createDividendPool({
      tokenId: TOKEN_ID,
      fundedBy: "GADMIN",
      totalAmount: poolAmount,
      supplySnapshot: totalSupply.toString(),
      perHolderCap: "0",
      txHash: "tx-large",
      holders,
    });

    const snapshots = capturedData.snapshots.createMany.data;
    const totalClaimed = snapshots.reduce(
      (sum: bigint, s: any) => sum + s.claimable,
      0n
    );

    // Total claimed must not exceed pool
    expect(totalClaimed).toBeLessThanOrEqual(BigInt(poolAmount));
    // Dust should be minimal (at most 1 unit per holder, but typically 0)
    const dust = BigInt(poolAmount) - totalClaimed;
    expect(dust).toBeLessThanOrEqual(BigInt(holders.length));
  });

  it("cap enforcement does not cause total to exceed pool", async () => {
    // Pool: 1000, 2 holders, cap at 600 each
    // Without cap: H1 gets 600, H2 gets 400
    // With cap: H1 gets 600 (capped), H2 gets 400 (under cap)
    // Total: 1000 (still valid)
    let capturedData: any;
    vi.mocked(prisma.token.findUnique).mockResolvedValue(mockToken as any);
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      const mockCreate = vi.fn().mockImplementation(async ({ data }: any) => {
        capturedData = data;
        return mockPool;
      });
      return fn({ dividendPool: { create: mockCreate } });
    });

    await createDividendPool({
      tokenId: TOKEN_ID,
      fundedBy: "GADMIN",
      totalAmount: "1000",
      supplySnapshot: "1000",
      perHolderCap: "600",
      txHash: "tx-cap",
      holders: [
        { holder: "H1", balance: "600" },
        { holder: "H2", balance: "400" },
      ],
    });

    const snapshots = capturedData.snapshots.createMany.data;
    const totalClaimed = snapshots.reduce(
      (sum: bigint, s: any) => sum + s.claimable,
      0n
    );

    expect(totalClaimed).toBeLessThanOrEqual(1000n);
  });
});
