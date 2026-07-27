/**
 * campaignProjectionService.test.ts
 *
 * Guard Campaign Projection Service Against Concurrent Writer Race Conditions (#1545)
 *
 * Scenarios covered:
 *   S1  Sequential event application – create → execute × 2 → complete produces the
 *       expected read-model row (amounts, executionCount, status, progress).
 *   S2  Concurrent writer race – two execution events for the same campaign land via
 *       Promise.all; both writes must be recorded with no lost update.
 *   S3  Out-of-order create – an execution event arrives before the campaign-created
 *       event; the parser must throw (or the row is absent) rather than silently
 *       producing a corrupt projection.
 */

import { describe, it, expect, beforeEach, vi, beforeAll } from "vitest";

// ── In-memory store (shared across both the parser and the projection service) ─

const mockCampaigns = new Map<number, any>();
const mockExecutions = new Map<string, any>();

/**
 * The campaign `update` mock must be serialised so that two concurrent
 * callers each read-then-write without overwriting each other's increment.
 * We model the real Prisma `{ increment: N }` path faithfully.
 */
const mockPrisma = {
  campaign: {
    upsert: vi.fn(async ({ where, create }: any) => {
      if (!mockCampaigns.has(where.campaignId)) {
        const row = {
          ...create,
          id: `campaign-${where.campaignId}`,
          updatedAt: new Date(),
        };
        mockCampaigns.set(where.campaignId, row);
        return row;
      }
      return mockCampaigns.get(where.campaignId);
    }),

    findUnique: vi.fn(async ({ where }: any) =>
      mockCampaigns.get(where.campaignId) ?? null
    ),

    findMany: vi.fn(async ({ where }: any = {}) => {
      const all = Array.from(mockCampaigns.values());
      if (where?.status) return all.filter((c) => c.status === where.status);
      if (where?.tokenId) return all.filter((c) => c.tokenId === where.tokenId);
      if (where?.creator) return all.filter((c) => c.creator === where.creator);
      return all;
    }),

    update: vi.fn(async ({ where, data }: any) => {
      // Resolve row by `id` (used in parseCampaignExecution) or by `campaignId`
      let campaign: any;
      if (where.id) {
        campaign = Array.from(mockCampaigns.values()).find(
          (c) => c.id === where.id
        );
      } else {
        campaign = mockCampaigns.get(where.campaignId);
      }
      if (!campaign) throw new Error("Campaign not found for update");

      // Handle Prisma increment syntax — critical for race-convergence test
      if (data.currentAmount?.increment !== undefined)
        campaign.currentAmount =
          (campaign.currentAmount ?? BigInt(0)) + data.currentAmount.increment;
      if (data.executionCount?.increment !== undefined)
        campaign.executionCount =
          (campaign.executionCount ?? 0) + data.executionCount.increment;

      // Direct assignments
      if (data.status !== undefined) campaign.status = data.status;
      if (data.completedAt !== undefined) campaign.completedAt = data.completedAt;
      if (data.cancelledAt !== undefined) campaign.cancelledAt = data.cancelledAt;
      if (data.pausedAt !== undefined) campaign.pausedAt = data.pausedAt;
      campaign.updatedAt = data.updatedAt ?? new Date();

      return campaign;
    }),

    count: vi.fn(async ({ where }: any = {}) => {
      const all = Array.from(mockCampaigns.values());
      if (where?.status) return all.filter((c) => c.status === where.status).length;
      return all.length;
    }),

    aggregate: vi.fn(async () => ({
      _sum: { currentAmount: BigInt(0), executionCount: 0 },
    })),
  },

  campaignExecution: {
    create: vi.fn(async ({ data }: any) => {
      const exec = { ...data, id: `exec-${data.txHash}` };
      mockExecutions.set(data.txHash, exec);
      return exec;
    }),
    findUnique: vi.fn(async ({ where }: any) =>
      mockExecutions.get(where.txHash) ?? null
    ),
    findMany: vi.fn(async ({ where }: any = {}) => {
      const all = Array.from(mockExecutions.values());
      if (where?.campaignId)
        return all
          .filter((e) => e.campaignId === where.campaignId)
          .sort(
            (a, b) =>
              new Date(b.executedAt).getTime() - new Date(a.executedAt).getTime()
          );
      return all;
    }),
    count: vi.fn(async () => mockExecutions.size),
  },

  campaignAuditTrail: {
    create: vi.fn(async ({ data }: any) => ({
      id: `audit-${Date.now()}`,
      ...data,
      transitionAt: new Date(),
    })),
    findMany: vi.fn(async () => []),
    count: vi.fn(async () => 0),
  },

  /**
   * $transaction executes operations sequentially in the mock, mirroring the
   * serialised writes that Prisma's interactive transactions provide in
   * production.  This lets the concurrent-race test verify that both
   * increments are applied even when the two Promise.all calls interleave.
   */
  $transaction: vi.fn(async (ops: any[]) => {
    const results: any[] = [];
    for (const op of ops) results.push(await op);
    return results;
  }),
};

vi.mock("@prisma/client", () => ({
  PrismaClient: vi.fn(() => mockPrisma),
}));

// ── Module imports (after mock registration) ──────────────────────────────────

let parser: any;
let projectionService: any;

beforeAll(async () => {
  const { CampaignEventParser } = await import(
    "../services/campaignEventParser"
  );
  const { CampaignProjectionService } = await import(
    "../services/campaignProjectionService"
  );
  parser = new CampaignEventParser();
  projectionService = new CampaignProjectionService();
});

beforeEach(() => {
  mockCampaigns.clear();
  mockExecutions.clear();
  vi.clearAllMocks();
});

// ── Shared fixture helpers ────────────────────────────────────────────────────

const BASE_CREATE = {
  campaignId: 1,
  tokenId: "CTOKEN123",
  creator: "GCREATOR",
  type: "BUYBACK" as const,
  targetAmount: BigInt(1_000_000),
  startTime: new Date("2026-01-01T00:00:00Z"),
  txHash: "tx-create-001",
};

function makeExecEvent(txHash: string, amount = BigInt(300_000)) {
  return {
    campaignId: 1,
    executor: "GEXECUTOR",
    amount,
    txHash,
    executedAt: new Date(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// S1 — Sequential event application
// ─────────────────────────────────────────────────────────────────────────────

describe("S1: Sequential event application", () => {
  it("create event inserts a projection row with zero amounts", async () => {
    await parser.parseCampaignCreated(BASE_CREATE);

    const row = await projectionService.getCampaignById(1);
    expect(row).not.toBeNull();
    expect(row.campaignId).toBe(1);
    expect(row.tokenId).toBe("CTOKEN123");
    expect(row.creator).toBe("GCREATOR");
    expect(row.type).toBe("BUYBACK");
    expect(row.status).toBe("ACTIVE");
    expect(row.currentAmount).toBe(BigInt(0));
    expect(row.executionCount).toBe(0);
    expect(row.targetAmount).toBe(BigInt(1_000_000));
    expect(row.progress).toBe(0);
  });

  it("two execution events accumulate currentAmount and executionCount", async () => {
    await parser.parseCampaignCreated(BASE_CREATE);
    await parser.parseCampaignExecution(makeExecEvent("tx-exec-s1a", BigInt(400_000)));
    await parser.parseCampaignExecution(makeExecEvent("tx-exec-s1b", BigInt(200_000)));

    const row = await projectionService.getCampaignById(1);
    expect(row.currentAmount).toBe(BigInt(600_000));
    expect(row.executionCount).toBe(2);
    // progress = 600_000 / 1_000_000 * 100 = 60
    expect(row.progress).toBe(60);
  });

  it("COMPLETED status event updates status and sets completedAt", async () => {
    await parser.parseCampaignCreated(BASE_CREATE);
    await parser.parseCampaignExecution(makeExecEvent("tx-exec-s1c", BigInt(1_000_000)));
    await parser.parseCampaignStatusChange({
      campaignId: 1,
      status: "COMPLETED",
      txHash: "tx-status-completed",
    });

    const row = await projectionService.getCampaignById(1);
    expect(row.status).toBe("COMPLETED");
    expect(row.completedAt).toBeInstanceOf(Date);
    expect(row.cancelledAt).toBeUndefined();
    expect(row.pausedAt).toBeUndefined();
  });

  it("full sequential pipeline produces correct final projection state", async () => {
    // create → exec(300k) → exec(700k) → COMPLETED
    await parser.parseCampaignCreated(BASE_CREATE);
    await parser.parseCampaignExecution(makeExecEvent("tx-seq-a", BigInt(300_000)));
    await parser.parseCampaignExecution(makeExecEvent("tx-seq-b", BigInt(700_000)));
    await parser.parseCampaignStatusChange({
      campaignId: 1,
      status: "COMPLETED",
      txHash: "tx-seq-complete",
    });

    const row = await projectionService.getCampaignById(1);

    expect(row.currentAmount).toBe(BigInt(1_000_000));
    expect(row.executionCount).toBe(2);
    expect(row.status).toBe("COMPLETED");
    expect(row.completedAt).toBeInstanceOf(Date);
    expect(row.progress).toBe(100);

    // Idempotency: replaying the same events must not corrupt the projection
    await parser.parseCampaignCreated(BASE_CREATE);            // upsert – no-op if exists
    await parser.parseCampaignExecution(makeExecEvent("tx-seq-a", BigInt(300_000))); // duplicate txHash
    await parser.parseCampaignExecution(makeExecEvent("tx-seq-b", BigInt(700_000))); // duplicate txHash

    const rowAfterReplay = await projectionService.getCampaignById(1);
    expect(rowAfterReplay.currentAmount).toBe(BigInt(1_000_000));
    expect(rowAfterReplay.executionCount).toBe(2);
    expect(mockExecutions.size).toBe(2); // no duplicates
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S2 — Concurrent writer race (two execution events, Promise.all)
// ─────────────────────────────────────────────────────────────────────────────

describe("S2: Concurrent writer race — two execution events via Promise.all", () => {
  it("both writes are applied; no update is lost", async () => {
    await parser.parseCampaignCreated(BASE_CREATE);

    // Fire both execution events concurrently to simulate two listener instances
    // or a replay overlapping live traffic.
    await Promise.all([
      parser.parseCampaignExecution(makeExecEvent("tx-race-A", BigInt(300_000))),
      parser.parseCampaignExecution(makeExecEvent("tx-race-B", BigInt(200_000))),
    ]);

    const row = await projectionService.getCampaignById(1);

    // Both increments must be visible – no lost update
    expect(row.currentAmount).toBe(BigInt(500_000));
    expect(row.executionCount).toBe(2);

    // Both execution rows must have been created
    expect(mockExecutions.has("tx-race-A")).toBe(true);
    expect(mockExecutions.has("tx-race-B")).toBe(true);
  });

  it("duplicate concurrent writes for the same txHash are idempotent", async () => {
    await parser.parseCampaignCreated(BASE_CREATE);

    // Simulate two listener instances delivering the same event simultaneously
    await Promise.all([
      parser.parseCampaignExecution(makeExecEvent("tx-dup-concurrent", BigInt(500_000))),
      parser.parseCampaignExecution(makeExecEvent("tx-dup-concurrent", BigInt(500_000))),
    ]);

    const row = await projectionService.getCampaignById(1);

    // Idempotency: only one write should have taken effect
    expect(row.currentAmount).toBe(BigInt(500_000));
    expect(row.executionCount).toBe(1);
    expect(mockExecutions.size).toBe(1);
  });

  it("three concurrent executions all converge to the correct accumulated total", async () => {
    await parser.parseCampaignCreated(BASE_CREATE);

    await Promise.all([
      parser.parseCampaignExecution(makeExecEvent("tx-c3-a", BigInt(100_000))),
      parser.parseCampaignExecution(makeExecEvent("tx-c3-b", BigInt(200_000))),
      parser.parseCampaignExecution(makeExecEvent("tx-c3-c", BigInt(300_000))),
    ]);

    const row = await projectionService.getCampaignById(1);
    expect(row.currentAmount).toBe(BigInt(600_000));
    expect(row.executionCount).toBe(3);
    expect(mockExecutions.size).toBe(3);
  });

  it("concurrent status change alongside execution does not corrupt the projection", async () => {
    await parser.parseCampaignCreated(BASE_CREATE);
    await parser.parseCampaignExecution(makeExecEvent("tx-pre-pause", BigInt(400_000)));

    // Status change and a second execution arrive concurrently
    await Promise.all([
      parser.parseCampaignStatusChange({
        campaignId: 1,
        status: "PAUSED",
        txHash: "tx-pause-concurrent",
      }),
      parser.parseCampaignExecution(makeExecEvent("tx-exec-concurrent", BigInt(100_000))),
    ]);

    const row = await projectionService.getCampaignById(1);
    // Both mutations must be reflected (order of concurrent ops may vary but both must apply)
    expect(row.currentAmount).toBe(BigInt(500_000));
    expect(row.executionCount).toBe(2);
    expect(row.status).toBe("PAUSED");
    expect(row.pausedAt).toBeInstanceOf(Date);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S3 — Out-of-order create (execution arrives before campaign-created)
// ─────────────────────────────────────────────────────────────────────────────

describe("S3: Out-of-order create — execution event before campaign-created", () => {
  it("executing against a non-existent campaign throws an error", async () => {
    // No campaign-created event has been processed yet; the projection row is absent.
    await expect(
      parser.parseCampaignExecution(makeExecEvent("tx-ooo-exec", BigInt(200_000)))
    ).rejects.toThrow(/Campaign 1 not found/i);
  });

  it("projection row is absent until the create event is processed", async () => {
    // Attempt execution before create — expect an error
    await expect(
      parser.parseCampaignExecution(makeExecEvent("tx-ooo-before", BigInt(100_000)))
    ).rejects.toThrow();

    // The projection store must still be empty
    const row = await projectionService.getCampaignById(1);
    expect(row).toBeNull();
  });

  it("after retrying the create event the execution can be safely reprocessed", async () => {
    // Step 1: execution arrives first (out-of-order) — swallowed by caller
    let thrownError: Error | null = null;
    try {
      await parser.parseCampaignExecution(makeExecEvent("tx-ooo-retry", BigInt(250_000)));
    } catch (err: any) {
      thrownError = err;
    }
    expect(thrownError).not.toBeNull();
    expect(thrownError!.message).toMatch(/Campaign 1 not found/i);

    // Step 2: create event arrives (late, replayed by the reconciliation job)
    await parser.parseCampaignCreated(BASE_CREATE);

    // Step 3: execution is reprocessed now that the campaign row exists
    await parser.parseCampaignExecution(makeExecEvent("tx-ooo-retry", BigInt(250_000)));

    const row = await projectionService.getCampaignById(1);
    expect(row).not.toBeNull();
    expect(row.currentAmount).toBe(BigInt(250_000));
    expect(row.executionCount).toBe(1);
  });

  it("status change for a non-existent campaign throws an error", async () => {
    await expect(
      parser.parseCampaignStatusChange({
        campaignId: 999,
        status: "COMPLETED",
        txHash: "tx-ooo-status",
      })
    ).rejects.toThrow(/Campaign 999 not found/i);
  });
});
