/**
 * campaignConsistencyChecker.test.ts
 *
 * Covers the four scenarios required by the consistency-checker contract:
 *
 *   1. Matching state   – on-chain snapshot equals the DB projection → zero diffs
 *   2. Stale balance    – DB projection has an outdated `currentAmount` → exact
 *                         field-level diff reported
 *   3. Missing row      – campaign exists on-chain but has no DB projection row
 *                         → `existence` diff reported
 *   4. In-flight guard  – a not-yet-confirmed transaction makes the on-chain
 *                         `currentAmount` temporarily ahead of the projection;
 *                         passing the pending tx hash + expected delta suppresses
 *                         the false-positive drift alert
 */

import { describe, it, expect, beforeEach, vi, beforeAll } from 'vitest';
import type {
  OnChainCampaignState,
  CheckCampaignOptions,
  CheckMultipleCampaignsOptions,
} from '../services/campaignConsistencyChecker';

// ---------------------------------------------------------------------------
// Prisma mock – isolated, no real DB required
// ---------------------------------------------------------------------------

const mockCampaigns = new Map<number, Record<string, unknown>>();

const mockPrisma = {
  campaign: {
    findUnique: vi.fn(async ({ where }: { where: { campaignId: number } }) =>
      mockCampaigns.get(where.campaignId) ?? null
    ),
  },
};

vi.mock('@prisma/client', () => ({
  PrismaClient: vi.fn(() => mockPrisma),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A DB projection row that perfectly mirrors the on-chain snapshot.
 * Both sides are identical → checker must report zero diffs.
 */
const FIXTURE_MATCHING = {
  db: {
    campaignId: 1,
    status: 'ACTIVE',
    currentAmount: BigInt(500_000),
    executionCount: 5,
    targetAmount: BigInt(1_000_000),
  },
  onChain: {
    campaignId: 1,
    status: 'ACTIVE',
    currentAmount: BigInt(500_000),
    executionCount: 5,
    targetAmount: BigInt(1_000_000),
  } satisfies OnChainCampaignState,
};

/**
 * The DB projection row is behind: the projection still shows 500 000 but
 * on-chain the campaign has collected 550 000 (a real, already-confirmed
 * discrepancy, not an in-flight one).
 */
const FIXTURE_STALE_BALANCE = {
  db: {
    campaignId: 2,
    status: 'ACTIVE',
    currentAmount: BigInt(500_000),
    executionCount: 5,
    targetAmount: BigInt(1_000_000),
  },
  onChain: {
    campaignId: 2,
    status: 'ACTIVE',
    currentAmount: BigInt(550_000), // 50 000 stale
    executionCount: 5,
    targetAmount: BigInt(1_000_000),
  } satisfies OnChainCampaignState,
  expectedDiff: {
    field: 'currentAmount',
    backendValue: '500000',
    onChainValue: '550000',
  },
};

/**
 * The campaign exists on-chain but has NO row in the Postgres projection.
 * Checker must return a single `existence` diff.
 */
const FIXTURE_MISSING_ROW = {
  onChain: {
    campaignId: 99,
    status: 'ACTIVE',
    currentAmount: BigInt(100_000),
    executionCount: 1,
    targetAmount: BigInt(1_000_000),
  } satisfies OnChainCampaignState,
};

/**
 * An in-flight scenario:
 *  - DB projection: 500 000 (projection has NOT yet processed the pending tx)
 *  - On-chain:      550 000 (the pending tx of 50 000 is already visible on-chain)
 *  - The 50 000 gap is fully explained by one pending transaction hash
 *    "tx_pending_abc123".
 *
 * With the in-flight options provided the checker must return zero diffs.
 * Without the options it would return a `currentAmount` diff (see stale-balance
 * scenario above which uses the same numbers deliberately).
 */
const FIXTURE_IN_FLIGHT = {
  db: {
    campaignId: 3,
    status: 'ACTIVE',
    currentAmount: BigInt(500_000),
    executionCount: 5,
    targetAmount: BigInt(1_000_000),
  },
  onChain: {
    campaignId: 3,
    status: 'ACTIVE',
    currentAmount: BigInt(550_000), // chain is 50 000 ahead
    executionCount: 5,
    targetAmount: BigInt(1_000_000),
  } satisfies OnChainCampaignState,
  pendingTxHash: 'tx_pending_abc123',
  pendingAmount: BigInt(50_000), // exactly explains the gap
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('CampaignConsistencyChecker', () => {
  let checker: Awaited<ReturnType<typeof loadChecker>>;

  async function loadChecker() {
    const { CampaignConsistencyChecker } = await import(
      '../services/campaignConsistencyChecker'
    );
    return new CampaignConsistencyChecker();
  }

  beforeAll(async () => {
    checker = await loadChecker();
  });

  beforeEach(() => {
    mockCampaigns.clear();
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 1 – Matching state
  // ─────────────────────────────────────────────────────────────────────────
  describe('Scenario 1: matching state → no drift reported', () => {
    it('returns an empty diff array when DB projection equals on-chain snapshot', async () => {
      mockCampaigns.set(FIXTURE_MATCHING.db.campaignId, FIXTURE_MATCHING.db);

      const diffs = await checker.checkCampaign(
        FIXTURE_MATCHING.onChain.campaignId,
        FIXTURE_MATCHING.onChain
      );

      expect(diffs).toHaveLength(0);
    });

    it('reports `consistent: true` in a batch check when all campaigns match', async () => {
      mockCampaigns.set(FIXTURE_MATCHING.db.campaignId, FIXTURE_MATCHING.db);

      const result = await checker.checkMultipleCampaigns([
        FIXTURE_MATCHING.onChain,
      ]);

      expect(result.consistent).toBe(true);
      expect(result.totalChecked).toBe(1);
      expect(result.diffs).toHaveLength(0);
    });

    it('does not flag matching BigInt amounts as different', async () => {
      const db = {
        campaignId: 10,
        status: 'COMPLETED',
        currentAmount: BigInt('9999999999999999'),
        executionCount: 100,
        targetAmount: BigInt('9999999999999999'),
      };
      mockCampaigns.set(10, db);

      const onChain: OnChainCampaignState = { ...db };

      const diffs = await checker.checkCampaign(10, onChain);
      expect(diffs).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 2 – Stale balance
  // ─────────────────────────────────────────────────────────────────────────
  describe('Scenario 2: stale balance → exact field-level diff reported', () => {
    it('reports a `currentAmount` diff with the correct backend and on-chain values', async () => {
      mockCampaigns.set(
        FIXTURE_STALE_BALANCE.db.campaignId,
        FIXTURE_STALE_BALANCE.db
      );

      const diffs = await checker.checkCampaign(
        FIXTURE_STALE_BALANCE.onChain.campaignId,
        FIXTURE_STALE_BALANCE.onChain
      );

      expect(diffs).toHaveLength(1);
      expect(diffs[0].field).toBe(FIXTURE_STALE_BALANCE.expectedDiff.field);
      expect(diffs[0].backendValue).toBe(
        FIXTURE_STALE_BALANCE.expectedDiff.backendValue
      );
      expect(diffs[0].onChainValue).toBe(
        FIXTURE_STALE_BALANCE.expectedDiff.onChainValue
      );
      expect(diffs[0].campaignId).toBe(FIXTURE_STALE_BALANCE.db.campaignId);
    });

    it('serialises BigInt values as strings in the diff output', async () => {
      mockCampaigns.set(
        FIXTURE_STALE_BALANCE.db.campaignId,
        FIXTURE_STALE_BALANCE.db
      );

      const diffs = await checker.checkCampaign(
        FIXTURE_STALE_BALANCE.onChain.campaignId,
        FIXTURE_STALE_BALANCE.onChain
      );

      const amountDiff = diffs.find((d) => d.field === 'currentAmount');
      expect(amountDiff).toBeDefined();
      expect(typeof amountDiff!.backendValue).toBe('string');
      expect(typeof amountDiff!.onChainValue).toBe('string');
    });

    it('does not report other fields as drifted when only currentAmount differs', async () => {
      mockCampaigns.set(
        FIXTURE_STALE_BALANCE.db.campaignId,
        FIXTURE_STALE_BALANCE.db
      );

      const diffs = await checker.checkCampaign(
        FIXTURE_STALE_BALANCE.onChain.campaignId,
        FIXTURE_STALE_BALANCE.onChain
      );

      const reportedFields = diffs.map((d) => d.field);
      expect(reportedFields).not.toContain('status');
      expect(reportedFields).not.toContain('executionCount');
      expect(reportedFields).not.toContain('targetAmount');
    });

    it('reports multiple field-level diffs when several fields diverge simultaneously', async () => {
      const campaignId = 20;
      mockCampaigns.set(campaignId, {
        campaignId,
        status: 'ACTIVE',
        currentAmount: BigInt(200_000),
        executionCount: 4,
        targetAmount: BigInt(1_000_000),
      });

      const onChain: OnChainCampaignState = {
        campaignId,
        status: 'PAUSED',               // ← different
        currentAmount: BigInt(250_000), // ← different
        executionCount: 5,              // ← different
        targetAmount: BigInt(1_000_000),
      };

      const diffs = await checker.checkCampaign(campaignId, onChain);

      expect(diffs).toHaveLength(3);
      const fields = diffs.map((d) => d.field);
      expect(fields).toContain('status');
      expect(fields).toContain('currentAmount');
      expect(fields).toContain('executionCount');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 3 – Missing projection row
  // ─────────────────────────────────────────────────────────────────────────
  describe('Scenario 3: missing DB row → existence diff reported', () => {
    it('returns a single `existence` diff when the campaign has no DB projection row', async () => {
      // Deliberately do NOT seed mockCampaigns with campaignId 99
      const diffs = await checker.checkCampaign(
        FIXTURE_MISSING_ROW.onChain.campaignId,
        FIXTURE_MISSING_ROW.onChain
      );

      expect(diffs).toHaveLength(1);
      expect(diffs[0].field).toBe('existence');
      expect(diffs[0].backendValue).toBeNull();
      expect(diffs[0].onChainValue).toBe('exists');
      expect(diffs[0].campaignId).toBe(FIXTURE_MISSING_ROW.onChain.campaignId);
    });

    it('marks the batch as inconsistent when a missing-row campaign is included', async () => {
      // Campaign 1 is healthy; campaign 99 is missing from DB
      mockCampaigns.set(FIXTURE_MATCHING.db.campaignId, FIXTURE_MATCHING.db);

      const result = await checker.checkMultipleCampaigns([
        FIXTURE_MATCHING.onChain,
        FIXTURE_MISSING_ROW.onChain,
      ]);

      expect(result.consistent).toBe(false);
      expect(result.totalChecked).toBe(2);
      expect(result.diffs).toHaveLength(1);
      expect(result.diffs[0].field).toBe('existence');
      expect(result.diffs[0].campaignId).toBe(
        FIXTURE_MISSING_ROW.onChain.campaignId
      );
    });

    it('returns only an existence diff (no field diffs) for a missing row', async () => {
      const diffs = await checker.checkCampaign(
        FIXTURE_MISSING_ROW.onChain.campaignId,
        FIXTURE_MISSING_ROW.onChain
      );

      // No field diffs should bleed in alongside the existence diff
      const nonExistenceDiffs = diffs.filter((d) => d.field !== 'existence');
      expect(nonExistenceDiffs).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 4 – In-flight transaction guard
  // ─────────────────────────────────────────────────────────────────────────
  describe('Scenario 4: in-flight transaction guard → false positive suppressed', () => {
    it('does NOT report currentAmount drift when the gap equals the pending tx delta', async () => {
      mockCampaigns.set(FIXTURE_IN_FLIGHT.db.campaignId, FIXTURE_IN_FLIGHT.db);

      const options: CheckCampaignOptions = {
        inFlightTxHashes: new Set([FIXTURE_IN_FLIGHT.pendingTxHash]),
        inFlightAmountDelta: FIXTURE_IN_FLIGHT.pendingAmount,
      };

      const diffs = await checker.checkCampaign(
        FIXTURE_IN_FLIGHT.onChain.campaignId,
        FIXTURE_IN_FLIGHT.onChain,
        options
      );

      expect(diffs).toHaveLength(0);
    });

    it('still reports drift when the gap does NOT match the pending delta', async () => {
      mockCampaigns.set(FIXTURE_IN_FLIGHT.db.campaignId, FIXTURE_IN_FLIGHT.db);

      // Pending delta is only 10 000, but actual gap is 50 000 → real drift
      const options: CheckCampaignOptions = {
        inFlightTxHashes: new Set([FIXTURE_IN_FLIGHT.pendingTxHash]),
        inFlightAmountDelta: BigInt(10_000), // does not fully explain the gap
      };

      const diffs = await checker.checkCampaign(
        FIXTURE_IN_FLIGHT.onChain.campaignId,
        FIXTURE_IN_FLIGHT.onChain,
        options
      );

      expect(diffs).toHaveLength(1);
      expect(diffs[0].field).toBe('currentAmount');
      expect(diffs[0].backendValue).toBe('500000');
      expect(diffs[0].onChainValue).toBe('550000');
    });

    it('reports drift when inFlightTxHashes is empty even if delta is provided', async () => {
      mockCampaigns.set(FIXTURE_IN_FLIGHT.db.campaignId, FIXTURE_IN_FLIGHT.db);

      // Empty set of hashes → no in-flight context → gap treated as real drift
      const options: CheckCampaignOptions = {
        inFlightTxHashes: new Set(),
        inFlightAmountDelta: FIXTURE_IN_FLIGHT.pendingAmount,
      };

      const diffs = await checker.checkCampaign(
        FIXTURE_IN_FLIGHT.onChain.campaignId,
        FIXTURE_IN_FLIGHT.onChain,
        options
      );

      expect(diffs).toHaveLength(1);
      expect(diffs[0].field).toBe('currentAmount');
    });

    it('reports drift when no in-flight options are passed at all', async () => {
      mockCampaigns.set(FIXTURE_IN_FLIGHT.db.campaignId, FIXTURE_IN_FLIGHT.db);

      // No options → default behaviour, no suppression
      const diffs = await checker.checkCampaign(
        FIXTURE_IN_FLIGHT.onChain.campaignId,
        FIXTURE_IN_FLIGHT.onChain
        // options intentionally omitted
      );

      expect(diffs).toHaveLength(1);
      expect(diffs[0].field).toBe('currentAmount');
    });

    it('suppresses drift in a batch check when per-campaign in-flight options are supplied', async () => {
      // Campaign 1 matches; campaign 3 has an in-flight tx
      mockCampaigns.set(FIXTURE_MATCHING.db.campaignId, FIXTURE_MATCHING.db);
      mockCampaigns.set(FIXTURE_IN_FLIGHT.db.campaignId, FIXTURE_IN_FLIGHT.db);

      const batchOptions: CheckMultipleCampaignsOptions = {
        inFlight: new Map([
          [
            FIXTURE_IN_FLIGHT.db.campaignId,
            {
              inFlightTxHashes: new Set([FIXTURE_IN_FLIGHT.pendingTxHash]),
              inFlightAmountDelta: FIXTURE_IN_FLIGHT.pendingAmount,
            },
          ],
        ]),
      };

      const result = await checker.checkMultipleCampaigns(
        [FIXTURE_MATCHING.onChain, FIXTURE_IN_FLIGHT.onChain],
        batchOptions
      );

      expect(result.consistent).toBe(true);
      expect(result.diffs).toHaveLength(0);
    });

    it('only suppresses currentAmount drift; other diverging fields still appear', async () => {
      const campaignId = 30;
      mockCampaigns.set(campaignId, {
        campaignId,
        status: 'ACTIVE',       // DB has ACTIVE
        currentAmount: BigInt(500_000),
        executionCount: 5,
        targetAmount: BigInt(1_000_000),
      });

      const onChain: OnChainCampaignState = {
        campaignId,
        status: 'PAUSED',        // ← different from DB → real drift
        currentAmount: BigInt(550_000), // gap = 50 000 = in-flight delta
        executionCount: 5,
        targetAmount: BigInt(1_000_000),
      };

      const options: CheckCampaignOptions = {
        inFlightTxHashes: new Set(['tx_pending_xyz']),
        inFlightAmountDelta: BigInt(50_000),
      };

      const diffs = await checker.checkCampaign(campaignId, onChain, options);

      // currentAmount is suppressed; status is NOT
      expect(diffs).toHaveLength(1);
      expect(diffs[0].field).toBe('status');
      expect(diffs[0].backendValue).toBe('ACTIVE');
      expect(diffs[0].onChainValue).toBe('PAUSED');
    });

    it('does not suppress when in-flight delta is zero', async () => {
      mockCampaigns.set(FIXTURE_IN_FLIGHT.db.campaignId, FIXTURE_IN_FLIGHT.db);

      const options: CheckCampaignOptions = {
        inFlightTxHashes: new Set([FIXTURE_IN_FLIGHT.pendingTxHash]),
        inFlightAmountDelta: BigInt(0), // zero → suppression disabled
      };

      const diffs = await checker.checkCampaign(
        FIXTURE_IN_FLIGHT.onChain.campaignId,
        FIXTURE_IN_FLIGHT.onChain,
        options
      );

      expect(diffs).toHaveLength(1);
      expect(diffs[0].field).toBe('currentAmount');
    });

    it('does not suppress when the on-chain amount is LESS than the backend amount', async () => {
      // Regression: do not swallow drift where the chain went backwards
      const campaignId = 31;
      mockCampaigns.set(campaignId, {
        campaignId,
        status: 'ACTIVE',
        currentAmount: BigInt(600_000), // DB is AHEAD of chain → suspicious
        executionCount: 6,
        targetAmount: BigInt(1_000_000),
      });

      const onChain: OnChainCampaignState = {
        campaignId,
        status: 'ACTIVE',
        currentAmount: BigInt(550_000), // on-chain is BEHIND
        executionCount: 6,
        targetAmount: BigInt(1_000_000),
      };

      const options: CheckCampaignOptions = {
        inFlightTxHashes: new Set(['tx_abc']),
        inFlightAmountDelta: BigInt(50_000), // delta = 50 000 but direction is wrong
      };

      const diffs = await checker.checkCampaign(campaignId, onChain, options);

      // Must NOT be suppressed: the on-chain is behind, not ahead
      expect(diffs).toHaveLength(1);
      expect(diffs[0].field).toBe('currentAmount');
    });
  });
});
