/**
 * Governance Proposal State Snapshot tests (#1383).
 *
 * Verifies that the `prop_snap` (`ProposalStateSnapshot`) event emitted by
 * the token-factory contract every ~1000 ledgers (or on demand via
 * `snapshot_proposals`) is:
 *   1. Recognized and correctly decoded by `GovernanceEventMapper`.
 *   2. Parseable end-to-end by `GovernanceEventParser` (the same parser
 *      that backs `eventReplayService`'s indexer fast-forward path).
 *   3. Decoded by the `eventVersioning` decoder registry, the single
 *      normalization point used by `stellarEventListener`.
 *
 * Uses a hand-rolled in-memory mock of `@prisma/client` (mirroring the
 * pattern in `campaignIngestion.test.ts`) so these tests run without a
 * live database connection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GovernanceEventMapper } from '../services/governanceEventMapper';
import { decodeEvent } from '../services/eventVersioning/decoderRegistry';

// ── Minimal in-memory Prisma mock ───────────────────────────────────────────

const ProposalStatus = {
  ACTIVE: 'ACTIVE',
  PASSED: 'PASSED',
  REJECTED: 'REJECTED',
  QUEUED: 'QUEUED',
  EXECUTED: 'EXECUTED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
} as const;

function createMockPrisma() {
  const proposals = new Map<number, any>();

  return {
    proposals,
    proposal: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.proposalId !== undefined) {
          return proposals.get(where.proposalId) ?? null;
        }
        if (where.id !== undefined) {
          return (
            Array.from(proposals.values()).find((p) => p.id === where.id) ??
            null
          );
        }
        return null;
      }),
      upsert: vi.fn(async ({ where, create }: any) => {
        const existing = proposals.get(where.proposalId);
        if (existing) return existing;
        const created = { id: `proposal-${where.proposalId}`, ...create };
        proposals.set(where.proposalId, created);
        return created;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const proposal = Array.from(proposals.values()).find(
          (p) => p.id === where.id,
        );
        if (!proposal) throw new Error('Proposal not found');
        Object.assign(proposal, data);
        return proposal;
      }),
      deleteMany: vi.fn(async () => {
        proposals.clear();
        return { count: 0 };
      }),
    },
  };
}

// Mock the GovernanceEventParser's @prisma/client import so it uses our enum.
vi.mock('@prisma/client', () => ({
  PrismaClient: vi.fn(),
  ProposalStatus,
  ProposalType: { PARAMETER_CHANGE: 'PARAMETER_CHANGE', CUSTOM: 'CUSTOM' },
}));

describe('Governance proposal state snapshot (#1383)', () => {
  const mapper = new GovernanceEventMapper();

  const baseRawEvent = {
    type: 'contract',
    ledger: 5000,
    ledger_close_time: '2026-01-01T00:00:00Z',
    contract_id: 'CFACTORY123456789',
    id: 'event-snap-1',
    paging_token: 'token-snap-1',
    topic: ['prop_snap', '7'],
    value: {
      proposal_id: 7,
      status: 'Active',
      yes_votes: 1_500,
      no_votes: 400,
      quorum_required: 1_000,
      ledger: 5000,
    },
    in_successful_contract_call: true,
    transaction_hash: 'tx-snap-1',
  };

  describe('GovernanceEventMapper', () => {
    it('recognizes the prop_snap topic as a governance event', () => {
      expect(mapper.isGovernanceEvent(baseRawEvent as any)).toBe(true);
    });

    it('maps a prop_snap event to a fully-populated ProposalStateSnapshotEvent', () => {
      const mapped = mapper.mapEvent(baseRawEvent as any);

      expect(mapped).not.toBeNull();
      expect(mapped).toMatchObject({
        type: 'proposal_state_snapshot',
        proposalId: 7,
        yesVotes: '1500',
        noVotes: '400',
        quorumRequired: '1000',
        snapshotLedger: 5000,
        txHash: 'tx-snap-1',
        contractId: 'CFACTORY123456789',
      });
    });

    it('falls back to the topic-encoded proposal id when value.proposal_id is absent', () => {
      const event = {
        ...baseRawEvent,
        value: { ...baseRawEvent.value, proposal_id: undefined },
      };
      const mapped = mapper.mapEvent(event as any);
      expect(mapped?.proposalId).toBe(7);
    });

    it('falls back to the event ledger when value.ledger is absent', () => {
      const event = {
        ...baseRawEvent,
        value: { ...baseRawEvent.value, ledger: undefined },
      };
      const mapped: any = mapper.mapEvent(event as any);
      expect(mapped?.snapshotLedger).toBe(5000);
    });
  });

  describe('eventVersioning decoder registry', () => {
    it('decodes prop_snap via the single normalization point used by stellarEventListener', () => {
      const decoded = decodeEvent(baseRawEvent as any);

      expect(decoded.kind).toBe('proposal_state_snapshot');
      if (decoded.kind === 'proposal_state_snapshot') {
        expect(decoded.proposalId).toBe(7);
        expect(decoded.yesVotes).toBe('1500');
        expect(decoded.noVotes).toBe('400');
        expect(decoded.quorumRequired).toBe('1000');
        expect(decoded.snapshotLedger).toBe(5000);
      }
    });
  });

  describe('GovernanceEventParser', () => {
    let mockPrisma: ReturnType<typeof createMockPrisma>;
    let GovernanceEventParser: typeof import('../services/governanceEventParser').GovernanceEventParser;

    beforeEach(async () => {
      vi.resetModules();
      mockPrisma = createMockPrisma();
      ({ GovernanceEventParser } = await import('../services/governanceEventParser'));
    });

    it('fast-forwards an existing proposal to the snapshotted status', async () => {
      mockPrisma.proposals.set(7, {
        id: 'proposal-7',
        proposalId: 7,
        status: ProposalStatus.ACTIVE,
      });

      const parser = new GovernanceEventParser(mockPrisma as any);
      const mapped = mapper.mapEvent(baseRawEvent as any)!;

      await expect(parser.parseEvent(mapped)).resolves.not.toThrow();

      expect(mockPrisma.proposal.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'proposal-7' },
          data: { status: ProposalStatus.ACTIVE },
        }),
      );
    });

    it('reflects a Succeeded snapshot as a PASSED status update', async () => {
      mockPrisma.proposals.set(7, {
        id: 'proposal-7',
        proposalId: 7,
        status: ProposalStatus.ACTIVE,
      });

      const parser = new GovernanceEventParser(mockPrisma as any);
      const succeededEvent = {
        ...baseRawEvent,
        value: { ...baseRawEvent.value, status: 'Succeeded' },
      };
      const mapped = mapper.mapEvent(succeededEvent as any)!;

      await parser.parseEvent(mapped);

      const updated = mockPrisma.proposals.get(7);
      expect(updated.status).toBe(ProposalStatus.PASSED);
    });

    it('does not throw when the proposal has not been indexed yet (skips gracefully)', async () => {
      const parser = new GovernanceEventParser(mockPrisma as any);
      const mapped = mapper.mapEvent(baseRawEvent as any)!;

      await expect(parser.parseEvent(mapped)).resolves.not.toThrow();
      expect(mockPrisma.proposal.update).not.toHaveBeenCalled();
    });

    it('is idempotent: applying the same snapshot twice yields the same state', async () => {
      mockPrisma.proposals.set(7, {
        id: 'proposal-7',
        proposalId: 7,
        status: ProposalStatus.ACTIVE,
      });

      const parser = new GovernanceEventParser(mockPrisma as any);
      const mapped = mapper.mapEvent(baseRawEvent as any)!;

      await parser.parseEvent(mapped);
      await parser.parseEvent(mapped);

      expect(mockPrisma.proposals.get(7).status).toBe(ProposalStatus.ACTIVE);
      expect(mockPrisma.proposal.update).toHaveBeenCalledTimes(2);
    });
  });
});
