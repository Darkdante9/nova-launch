/**
 * Reconciliation Tests
 *
 * Asserts that reconcileProjection(tokenAddress) correctly heals diverged
 * Prisma projection state and that auto-reconciliation fires when checkBurnTotals
 * detects a divergence.
 *
 * Uses a mocked PrismaClient so no live database is required.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  OnChainProjectionVerifier,
  OnChainDataFetcher,
  type OnChainBurnRecord,
} from "../services/consistency/onchainProjectionVerifier";

// ─── helpers ────────────────────────────────────────────────────────────────

function buildBurns(
  tokenAddress: string,
  amounts: bigint[]
): OnChainBurnRecord[] {
  return amounts.map((amount, i) => ({
    tokenAddress,
    from: "GFROM",
    amount,
    burnedBy: "GFROM",
    isAdminBurn: false,
    txHash: `tx${i}`,
  }));
}

const TOKEN_ADDRESS = "CTOKEN1AAABBBCCC";

// ─── mock prisma builder ─────────────────────────────────────────────────────

function buildMockPrisma(tokenRow: {
  address: string;
  totalBurned: bigint;
  burnCount: number;
  lastReconciledAt: Date | null;
} | null) {
  const updatedRow = tokenRow ? { ...tokenRow } : null;

  return {
    token: {
      findUnique: vi.fn().mockImplementation(({ where }: any) => {
        if (!updatedRow || updatedRow.address !== where.address) return null;
        return Promise.resolve(updatedRow);
      }),
      findMany: vi.fn().mockResolvedValue(
        updatedRow
          ? [
              {
                address: updatedRow.address,
                totalBurned: updatedRow.totalBurned,
                burnCount: updatedRow.burnCount,
              },
            ]
          : []
      ),
      update: vi.fn().mockImplementation(({ data }: any) => {
        if (updatedRow) {
          if (data.totalBurned !== undefined) updatedRow.totalBurned = data.totalBurned;
          if (data.burnCount !== undefined) updatedRow.burnCount = data.burnCount;
          if (data.lastReconciledAt !== undefined)
            updatedRow.lastReconciledAt = data.lastReconciledAt;
        }
        return Promise.resolve(updatedRow);
      }),
      count: vi.fn().mockResolvedValue(updatedRow ? 1 : 0),
    },
    _updatedRow: updatedRow,
  } as any;
}

function buildFetcher(burns: OnChainBurnRecord[]): OnChainDataFetcher {
  const fetcher = new OnChainDataFetcher();
  vi.spyOn(fetcher, "fetchBurnEvents").mockResolvedValue(burns);
  vi.spyOn(fetcher, "fetchTokenCount").mockResolvedValue(null);
  return fetcher;
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe("reconcileProjection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("corrects diverged totalBurned and burnCount", async () => {
    const prisma = buildMockPrisma({
      address: TOKEN_ADDRESS,
      totalBurned: BigInt(500),
      burnCount: 2,
      lastReconciledAt: null,
    });
    const onChainBurns = buildBurns(TOKEN_ADDRESS, [BigInt(300), BigInt(400), BigInt(100)]);

    const verifier = new OnChainProjectionVerifier(prisma);
    (verifier as any).fetcher = buildFetcher(onChainBurns);

    const result = await verifier.reconcileProjection(TOKEN_ADDRESS);

    expect(result.alreadyConsistent).toBe(false);
    expect(result.fieldsUpdated).toContain("totalBurned");
    expect(result.fieldsUpdated).toContain("burnCount");
    expect(prisma.token.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { address: TOKEN_ADDRESS },
        data: expect.objectContaining({
          totalBurned: BigInt(800),
          burnCount: 3,
        }),
      })
    );
  });

  it("is idempotent — running twice produces the same result", async () => {
    // After first run the mock reflects updated values — simulate by starting
    // already-correct for the second call.
    const prisma = buildMockPrisma({
      address: TOKEN_ADDRESS,
      totalBurned: BigInt(0),
      burnCount: 0,
      lastReconciledAt: null,
    });
    const onChainBurns = buildBurns(TOKEN_ADDRESS, [BigInt(100)]);
    const fetcher = buildFetcher(onChainBurns);

    const verifier = new OnChainProjectionVerifier(prisma);
    (verifier as any).fetcher = fetcher;

    const r1 = await verifier.reconcileProjection(TOKEN_ADDRESS);
    expect(r1.alreadyConsistent).toBe(false);
    expect(r1.fieldsUpdated.length).toBeGreaterThan(0);

    // Prisma mock now returns updated values — second call should be consistent
    const r2 = await verifier.reconcileProjection(TOKEN_ADDRESS);
    expect(r2.alreadyConsistent).toBe(true);
    expect(r2.fieldsUpdated).toHaveLength(0);

    // update was only called twice (once per call), always with lastReconciledAt
    expect(prisma.token.update).toHaveBeenCalledTimes(2);
  });

  it("reports alreadyConsistent when projection is already correct", async () => {
    const prisma = buildMockPrisma({
      address: TOKEN_ADDRESS,
      totalBurned: BigInt(500),
      burnCount: 2,
      lastReconciledAt: null,
    });
    const onChainBurns = buildBurns(TOKEN_ADDRESS, [BigInt(200), BigInt(300)]);

    const verifier = new OnChainProjectionVerifier(prisma);
    (verifier as any).fetcher = buildFetcher(onChainBurns);

    const result = await verifier.reconcileProjection(TOKEN_ADDRESS);

    expect(result.alreadyConsistent).toBe(true);
    expect(result.fieldsUpdated).toHaveLength(0);
    expect(result.lastReconciledAt).toBeInstanceOf(Date);
  });

  it("still writes lastReconciledAt even when already consistent", async () => {
    const prisma = buildMockPrisma({
      address: TOKEN_ADDRESS,
      totalBurned: BigInt(50),
      burnCount: 1,
      lastReconciledAt: null,
    });
    const onChainBurns = buildBurns(TOKEN_ADDRESS, [BigInt(50)]);

    const verifier = new OnChainProjectionVerifier(prisma);
    (verifier as any).fetcher = buildFetcher(onChainBurns);

    await verifier.reconcileProjection(TOKEN_ADDRESS);

    expect(prisma.token.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastReconciledAt: expect.any(Date) }),
      })
    );
  });

  it("throws when token is not in the projection", async () => {
    const prisma = buildMockPrisma(null);
    const verifier = new OnChainProjectionVerifier(prisma);
    (verifier as any).fetcher = buildFetcher([]);

    await expect(verifier.reconcileProjection("CNOT_IN_DB")).rejects.toThrow(
      "token not found in projection"
    );
  });

  it("throws when on-chain data cannot be fetched", async () => {
    const prisma = buildMockPrisma({
      address: TOKEN_ADDRESS,
      totalBurned: BigInt(0),
      burnCount: 0,
      lastReconciledAt: null,
    });

    const verifier = new OnChainProjectionVerifier(prisma);
    vi.spyOn((verifier as any).fetcher, "fetchBurnEvents").mockResolvedValue(null);

    await expect(verifier.reconcileProjection(TOKEN_ADDRESS)).rejects.toThrow(
      "could not fetch on-chain data"
    );
  });
});

describe("checkBurnTotals — auto-reconciliation on divergence", () => {
  beforeEach(() => vi.clearAllMocks());

  it("auto-reconciles diverged token during checkBurnTotals", async () => {
    const prisma = buildMockPrisma({
      address: TOKEN_ADDRESS,
      totalBurned: BigInt(0),
      burnCount: 0,
      lastReconciledAt: null,
    });
    const onChainBurns = buildBurns(TOKEN_ADDRESS, [BigInt(1000)]);

    const verifier = new OnChainProjectionVerifier(prisma);
    (verifier as any).fetcher = buildFetcher(onChainBurns);

    const checkResult = await verifier.checkBurnTotals();

    // Divergence was reported
    expect(checkResult.diffs.some((d) => d.identifier === TOKEN_ADDRESS)).toBe(true);

    // update was called as part of auto-reconciliation
    expect(prisma.token.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { address: TOKEN_ADDRESS },
        data: expect.objectContaining({
          totalBurned: BigInt(1000),
          burnCount: 1,
        }),
      })
    );
  });

  it("does not trigger reconciliation when projection is already consistent", async () => {
    const prisma = buildMockPrisma({
      address: TOKEN_ADDRESS,
      totalBurned: BigInt(200),
      burnCount: 1,
      lastReconciledAt: null,
    });
    const onChainBurns = buildBurns(TOKEN_ADDRESS, [BigInt(200)]);

    const verifier = new OnChainProjectionVerifier(prisma);
    (verifier as any).fetcher = buildFetcher(onChainBurns);

    const reconcileSpy = vi.spyOn(verifier, "reconcileProjection");
    await verifier.checkBurnTotals();

    expect(reconcileSpy).not.toHaveBeenCalled();
    expect(prisma.token.update).not.toHaveBeenCalled();
  });
});
