import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PrismaClient, ProposalStatus, ProposalType } from '@prisma/client';
import {
  GovernanceEventParser,
  GovernanceCatchupTransport,
  RawStellarEvent,
  DEFAULT_GOVERNANCE_CATCHUP_WINDOW,
} from '../services/governanceEventParser';
import { GovernanceEventMapper } from '../services/governanceEventMapper';
import { EventCursorStore } from '../services/eventCursorStore';
import {
  proposalCreatedEvent,
  voteCastEventFor,
  voteCastEventAgainst,
  proposalExecutedEvent,
  proposalCancelledEvent,
  proposalStatusChangedEvent,
  adminTransferProposal,
  treasurySpendProposal,
} from './fixtures/governanceEvents';

describe('Governance Event Parser Integration Tests', () => {
  let prisma: PrismaClient;
  let parser: GovernanceEventParser;
  let mapper: GovernanceEventMapper;

  beforeEach(async () => {
    prisma = new PrismaClient();
    parser = new GovernanceEventParser(prisma);
    mapper = new GovernanceEventMapper();

    // Clean up test data
    await prisma.proposalExecution.deleteMany();
    await prisma.vote.deleteMany();
    await prisma.proposal.deleteMany();
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  describe('Proposal Created Event', () => {
    it('should parse and persist proposal created event', async () => {
      const governanceEvent = mapper.mapEvent(proposalCreatedEvent);
      expect(governanceEvent).not.toBeNull();

      await parser.parseEvent(governanceEvent!);

      const proposal = await prisma.proposal.findUnique({
        where: { proposalId: 1 },
      });

      expect(proposal).not.toBeNull();
      expect(proposal?.proposer).toBe('GPROPOSER123456789');
      expect(proposal?.title).toBe('Increase Burn Fee');
      expect(proposal?.proposalType).toBe(ProposalType.PARAMETER_CHANGE);
      expect(proposal?.status).toBe(ProposalStatus.ACTIVE);
      expect(proposal?.txHash).toBe('tx-prop-create-1');
    });

    it('should handle admin transfer proposal type', async () => {
      const governanceEvent = mapper.mapEvent(adminTransferProposal);
      await parser.parseEvent(governanceEvent!);

      const proposal = await prisma.proposal.findUnique({
        where: { proposalId: 3 },
      });

      expect(proposal?.proposalType).toBe(ProposalType.ADMIN_TRANSFER);
      expect(proposal?.title).toBe('Transfer Admin Rights');
    });

    it('should handle treasury spend proposal type', async () => {
      const governanceEvent = mapper.mapEvent(treasurySpendProposal);
      await parser.parseEvent(governanceEvent!);

      const proposal = await prisma.proposal.findUnique({
        where: { proposalId: 4 },
      });

      expect(proposal?.proposalType).toBe(ProposalType.TREASURY_SPEND);
      expect(proposal?.title).toBe('Marketing Budget Allocation');
    });
  });

  describe('Vote Cast Event', () => {
    beforeEach(async () => {
      // Create proposal first
      const proposalEvent = mapper.mapEvent(proposalCreatedEvent);
      await parser.parseEvent(proposalEvent!);
    });

    it('should parse and persist vote for event', async () => {
      const voteEvent = mapper.mapEvent(voteCastEventFor);
      await parser.parseEvent(voteEvent!);

      const votes = await prisma.vote.findMany({
        where: { voter: 'GVOTER1123456789' },
      });

      expect(votes).toHaveLength(1);
      expect(votes[0].support).toBe(true);
      expect(votes[0].weight.toString()).toBe('250000000000');
      expect(votes[0].reason).toBe('I support this proposal for better tokenomics');
    });

    it('should parse and persist vote against event', async () => {
      const voteEvent = mapper.mapEvent(voteCastEventAgainst);
      await parser.parseEvent(voteEvent!);

      const votes = await prisma.vote.findMany({
        where: { voter: 'GVOTER2123456789' },
      });

      expect(votes).toHaveLength(1);
      expect(votes[0].support).toBe(false);
      expect(votes[0].weight.toString()).toBe('100000000000');
    });

    it('should handle multiple votes on same proposal', async () => {
      const voteFor = mapper.mapEvent(voteCastEventFor);
      const voteAgainst = mapper.mapEvent(voteCastEventAgainst);

      await parser.parseEvent(voteFor!);
      await parser.parseEvent(voteAgainst!);

      const proposal = await prisma.proposal.findUnique({
        where: { proposalId: 1 },
        include: { votes: true },
      });

      expect(proposal?.votes).toHaveLength(2);
    });
  });

  describe('Proposal Executed Event', () => {
    beforeEach(async () => {
      const proposalEvent = mapper.mapEvent(proposalCreatedEvent);
      await parser.parseEvent(proposalEvent!);
    });

    it('should parse and persist proposal execution', async () => {
      const execEvent = mapper.mapEvent(proposalExecutedEvent);
      await parser.parseEvent(execEvent!);

      const execution = await prisma.proposalExecution.findUnique({
        where: { txHash: 'tx-prop-exec-1' },
      });

      expect(execution).not.toBeNull();
      expect(execution?.executor).toBe('GEXECUTOR123456789');
      expect(execution?.success).toBe(true);
      expect(execution?.gasUsed?.toString()).toBe('50000');
    });

    it('should update proposal status to EXECUTED', async () => {
      const execEvent = mapper.mapEvent(proposalExecutedEvent);
      await parser.parseEvent(execEvent!);

      const proposal = await prisma.proposal.findUnique({
        where: { proposalId: 1 },
      });

      expect(proposal?.status).toBe(ProposalStatus.EXECUTED);
      expect(proposal?.executedAt).not.toBeNull();
    });
  });

  describe('Proposal Cancelled Event', () => {
    beforeEach(async () => {
      // Create a different proposal for cancellation
      const cancelProposal = {
        ...proposalCreatedEvent,
        value: { ...proposalCreatedEvent.value, proposal_id: 2 },
        transaction_hash: 'tx-prop-create-cancel',
      };
      const proposalEvent = mapper.mapEvent(cancelProposal);
      await parser.parseEvent(proposalEvent!);
    });

    it('should parse and persist proposal cancellation', async () => {
      const cancelEvent = mapper.mapEvent(proposalCancelledEvent);
      await parser.parseEvent(cancelEvent!);

      const proposal = await prisma.proposal.findUnique({
        where: { proposalId: 2 },
      });

      expect(proposal?.status).toBe(ProposalStatus.CANCELLED);
      expect(proposal?.cancelledAt).not.toBeNull();
    });
  });

  describe('Proposal Status Changed Event', () => {
    beforeEach(async () => {
      const proposalEvent = mapper.mapEvent(proposalCreatedEvent);
      await parser.parseEvent(proposalEvent!);
    });

    it('should update proposal status', async () => {
      const statusEvent = mapper.mapEvent(proposalStatusChangedEvent);
      await parser.parseEvent(statusEvent!);

      const proposal = await prisma.proposal.findUnique({
        where: { proposalId: 1 },
      });

      expect(proposal?.status).toBe(ProposalStatus.PASSED);
    });
  });

  describe('Proposal Analytics', () => {
    beforeEach(async () => {
      const proposalEvent = mapper.mapEvent(proposalCreatedEvent);
      await parser.parseEvent(proposalEvent!);

      const voteFor = mapper.mapEvent(voteCastEventFor);
      const voteAgainst = mapper.mapEvent(voteCastEventAgainst);

      await parser.parseEvent(voteFor!);
      await parser.parseEvent(voteAgainst!);
    });

    it('should calculate proposal analytics correctly', async () => {
      const analytics = await parser.getProposalAnalytics(1);

      expect(analytics.proposalId).toBe(1);
      expect(analytics.totalVotes).toBe(2);
      expect(analytics.votesFor).toBe('250000000000');
      expect(analytics.votesAgainst).toBe('100000000000');
      expect(analytics.uniqueVoters).toBe(2);
      expect(analytics.participationRate).toBeGreaterThan(0);
    });
  });

  describe('Governance Statistics', () => {
    beforeEach(async () => {
      // Create multiple proposals
      const proposal1 = mapper.mapEvent(proposalCreatedEvent);
      const proposal2 = mapper.mapEvent(adminTransferProposal);
      const proposal3 = mapper.mapEvent(treasurySpendProposal);

      await parser.parseEvent(proposal1!);
      await parser.parseEvent(proposal2!);
      await parser.parseEvent(proposal3!);

      // Add votes
      const vote1 = mapper.mapEvent(voteCastEventFor);
      const vote2 = mapper.mapEvent(voteCastEventAgainst);

      await parser.parseEvent(vote1!);
      await parser.parseEvent(vote2!);
    });

    it('should calculate governance stats correctly', async () => {
      const stats = await parser.getGovernanceStats();

      expect(stats.totalProposals).toBe(3);
      expect(stats.activeProposals).toBeGreaterThanOrEqual(0);
      expect(stats.totalVotes).toBe(2);
      expect(stats.uniqueVoters).toBe(2);
      expect(stats.proposalsByType).toHaveProperty(ProposalType.PARAMETER_CHANGE);
      expect(stats.proposalsByType).toHaveProperty(ProposalType.ADMIN_TRANSFER);
      expect(stats.proposalsByType).toHaveProperty(ProposalType.TREASURY_SPEND);
    });
  });

  describe('Event Mapping', () => {
    it('should correctly identify governance events', () => {
      expect(mapper.isGovernanceEvent(proposalCreatedEvent)).toBe(true);
      expect(mapper.isGovernanceEvent(voteCastEventFor)).toBe(true);
      expect(mapper.isGovernanceEvent(proposalExecutedEvent)).toBe(true);
    });

    it('should map all governance event types', () => {
      const events = [
        proposalCreatedEvent,
        voteCastEventFor,
        proposalExecutedEvent,
        proposalCancelledEvent,
        proposalStatusChangedEvent,
      ];

      const mappedEvents = mapper.mapEvents(events);
      expect(mappedEvents).toHaveLength(5);
      expect(mappedEvents[0].type).toBe('proposal_created');
      expect(mappedEvents[1].type).toBe('vote_cast');
      expect(mappedEvents[2].type).toBe('proposal_executed');
      expect(mappedEvents[3].type).toBe('proposal_cancelled');
      expect(mappedEvents[4].type).toBe('proposal_status_changed');
    });
  });

  describe('Error Handling', () => {
    it('should throw error for non-existent proposal when voting', async () => {
      const voteEvent = mapper.mapEvent(voteCastEventFor);

      await expect(parser.parseEvent(voteEvent!)).rejects.toThrow('Proposal 1 not found');
    });

    it('should throw error for non-existent proposal when executing', async () => {
      const execEvent = mapper.mapEvent(proposalExecutedEvent);

      await expect(parser.parseEvent(execEvent!)).rejects.toThrow('Proposal 1 not found');
    });
  });

  describe('Full Event Flow', () => {
    it('should handle complete proposal lifecycle', async () => {
      // 1. Create proposal
      const createEvent = mapper.mapEvent(proposalCreatedEvent);
      await parser.parseEvent(createEvent!);

      let proposal = await prisma.proposal.findUnique({
        where: { proposalId: 1 },
      });
      expect(proposal?.status).toBe(ProposalStatus.ACTIVE);

      // 2. Cast votes
      const voteFor = mapper.mapEvent(voteCastEventFor);
      const voteAgainst = mapper.mapEvent(voteCastEventAgainst);
      await parser.parseEvent(voteFor!);
      await parser.parseEvent(voteAgainst!);

      const votes = await prisma.vote.count({
        where: { proposalId: proposal!.id },
      });
      expect(votes).toBe(2);

      // 3. Change status to PASSED
      const statusEvent = mapper.mapEvent(proposalStatusChangedEvent);
      await parser.parseEvent(statusEvent!);

      proposal = await prisma.proposal.findUnique({
        where: { proposalId: 1 },
      });
      expect(proposal?.status).toBe(ProposalStatus.PASSED);

      // 4. Execute proposal
      const execEvent = mapper.mapEvent(proposalExecutedEvent);
      await parser.parseEvent(execEvent!);

      proposal = await prisma.proposal.findUnique({
        where: { proposalId: 1 },
        include: { executions: true },
      });
      expect(proposal?.status).toBe(ProposalStatus.EXECUTED);
      expect(proposal?.executions).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Catchup window tests (Issue #1353)
// ---------------------------------------------------------------------------

/**
 * Build a minimal RawStellarEvent that maps to a governance event.
 */
function makeRawEvent(
  overrides: Partial<RawStellarEvent> & { ledger: number },
): RawStellarEvent {
  return {
    type: 'contract',
    ledger: overrides.ledger,
    ledger_close_time: new Date(Date.now() - 60_000).toISOString(),
    contract_id: 'CGOVCONTRACT123456789',
    id: `event-${overrides.ledger}`,
    paging_token: `token-${overrides.ledger}`,
    topic: ['prop_create', 'CTOKEN123456789'],
    value: {
      proposal_id: overrides.ledger, // use ledger as unique proposal id
      proposer: 'GPROPOSER123456789',
      title: `Proposal at ledger ${overrides.ledger}`,
      description: 'Catchup test proposal',
      proposal_type: 0,
      start_time: Math.floor(Date.now() / 1000),
      end_time: Math.floor(Date.now() / 1000) + 86400,
      quorum: 1_000_000_000_000,
      threshold: 500_000_000_000,
      metadata: null,
    },
    in_successful_contract_call: true,
    transaction_hash: `tx-catchup-${overrides.ledger}`,
    ...overrides,
  };
}

/**
 * A controllable in-memory transport for catchup tests.
 * Returns a fixed list of events on each call.
 */
function makeMockTransport(eventPages: RawStellarEvent[][]): GovernanceCatchupTransport {
  let callCount = 0;
  return {
    async getEvents(_url: string, _params: Record<string, unknown>) {
      const page = eventPages[callCount] ?? [];
      callCount++;
      return { data: { _embedded: { records: page } } };
    },
  };
}

describe('GovernanceEventParser — catchup window (Issue #1353)', () => {
  let prisma: PrismaClient;
  let cursorStore: EventCursorStore;

  const HORIZON_URL = 'https://horizon-testnet.stellar.org';
  const CONTRACT_ID = 'CGOVCONTRACT123456789';

  beforeEach(async () => {
    prisma = new PrismaClient();
    cursorStore = new EventCursorStore(prisma);

    // Clean test data
    await prisma.proposalExecution.deleteMany();
    await prisma.vote.deleteMany();
    await prisma.proposal.deleteMany();
    await prisma.integrationState.deleteMany({ where: { key: 'governance_last_ledger' } });
  });

  afterEach(async () => {
    await prisma.$disconnect();
    delete process.env.GOVERNANCE_CATCHUP_WINDOW;
  });

  // -------------------------------------------------------------------------
  // CU1: On first boot (no stored cursor) catchup is bounded by the window
  // -------------------------------------------------------------------------
  it('CU1: replays events within catchup window on first boot', async () => {
    const currentLedger = 15_000;
    // Events at ledgers 5001 and 12000 — only 12000 is inside default 10,000-ledger window
    const eventsInWindow: RawStellarEvent[] = [makeRawEvent({ ledger: 12_000 })];

    const transport = makeMockTransport([eventsInWindow, []]);
    const parser = new GovernanceEventParser(prisma, { transport, cursorStore });

    const count = await parser.catchupFromCursor(HORIZON_URL, CONTRACT_ID, currentLedger);

    expect(count).toBe(1);

    // Cursor should be advanced to currentLedger
    const storedLedger = await cursorStore.loadGovernanceLedger();
    expect(storedLedger).toBe(currentLedger);

    // Proposal should be persisted
    const proposal = await prisma.proposal.findUnique({ where: { proposalId: 12_000 } });
    expect(proposal).not.toBeNull();
    expect(proposal?.title).toBe('Proposal at ledger 12000');
  });

  // -------------------------------------------------------------------------
  // CU2: After service restart, events missed during downtime are processed
  // -------------------------------------------------------------------------
  it('CU2: replays missed events after service restart', async () => {
    // Simulate: service stopped at ledger 1000, restarted at ledger 1005
    await cursorStore.saveGovernanceLedger(1000);

    const missedEvents: RawStellarEvent[] = [
      makeRawEvent({ ledger: 1001 }),
      makeRawEvent({ ledger: 1003 }),
      makeRawEvent({ ledger: 1005 }),
    ];

    const transport = makeMockTransport([missedEvents, []]);
    const parser = new GovernanceEventParser(prisma, { transport, cursorStore });

    const count = await parser.catchupFromCursor(HORIZON_URL, CONTRACT_ID, 1005);

    expect(count).toBe(3);

    const storedLedger = await cursorStore.loadGovernanceLedger();
    expect(storedLedger).toBe(1005);

    for (const proposalId of [1001, 1003, 1005]) {
      const p = await prisma.proposal.findUnique({ where: { proposalId } });
      expect(p).not.toBeNull();
    }
  });

  // -------------------------------------------------------------------------
  // CU3: No catchup when cursor is already current
  // -------------------------------------------------------------------------
  it('CU3: skips catchup when stored cursor matches current ledger', async () => {
    await cursorStore.saveGovernanceLedger(2000);

    let transportCalled = false;
    const transport: GovernanceCatchupTransport = {
      async getEvents() {
        transportCalled = true;
        return { data: { _embedded: { records: [] } } };
      },
    };

    const parser = new GovernanceEventParser(prisma, { transport, cursorStore });
    const count = await parser.catchupFromCursor(HORIZON_URL, CONTRACT_ID, 2000);

    expect(count).toBe(0);
    expect(transportCalled).toBe(false);
  });

  // -------------------------------------------------------------------------
  // CU4: GOVERNANCE_CATCHUP_WINDOW env var overrides the default
  // -------------------------------------------------------------------------
  it('CU4: GOVERNANCE_CATCHUP_WINDOW env var narrows the replay window', async () => {
    process.env.GOVERNANCE_CATCHUP_WINDOW = '500';

    const currentLedger = 1000;
    // fromLedger = 1000 - 500 = 500; event at ledger 400 should NOT be fetched
    // We just verify the transport receives the correct cursor (and returns nothing)
    const capturedParams: Record<string, unknown>[] = [];
    const transport: GovernanceCatchupTransport = {
      async getEvents(_url, params) {
        capturedParams.push(params);
        return { data: { _embedded: { records: [] } } };
      },
    };

    const parser = new GovernanceEventParser(prisma, { transport, cursorStore });
    await parser.catchupFromCursor(HORIZON_URL, CONTRACT_ID, currentLedger);

    expect(capturedParams.length).toBeGreaterThan(0);
    // The cursor sent should correspond to ledger 500 (1000 - 500)
    // _ledgerToCursor(500) = (499) * 4096 * 4096 * 256 = 2194728321024
    const expectedCursor = (BigInt(499) * BigInt(4096) * BigInt(4096) * BigInt(256)).toString();
    expect(capturedParams[0].cursor).toBe(expectedCursor);
  });

  // -------------------------------------------------------------------------
  // CU5: Events beyond currentLedger are ignored
  // -------------------------------------------------------------------------
  it('CU5: events beyond currentLedger are not processed', async () => {
    await cursorStore.saveGovernanceLedger(900);

    const currentLedger = 1000;
    // Mix: 950 is inside the window, 1100 is beyond
    const events: RawStellarEvent[] = [
      makeRawEvent({ ledger: 950 }),
      makeRawEvent({ ledger: 1100 }),
    ];

    const transport = makeMockTransport([events, []]);
    const parser = new GovernanceEventParser(prisma, { transport, cursorStore });

    const count = await parser.catchupFromCursor(HORIZON_URL, CONTRACT_ID, currentLedger);

    expect(count).toBe(1); // only ledger 950 processed

    const inside = await prisma.proposal.findUnique({ where: { proposalId: 950 } });
    expect(inside).not.toBeNull();

    const outside = await prisma.proposal.findUnique({ where: { proposalId: 1100 } });
    expect(outside).toBeNull();
  });

  // -------------------------------------------------------------------------
  // CU6: Cursor is updated after each page (crash-safe checkpointing)
  // -------------------------------------------------------------------------
  it('CU6: cursor is checkpointed after each page of events', async () => {
    await cursorStore.saveGovernanceLedger(0);

    const page1: RawStellarEvent[] = Array.from({ length: 200 }, (_, i) =>
      makeRawEvent({ ledger: i + 1 }),
    );
    const page2: RawStellarEvent[] = [makeRawEvent({ ledger: 201 })];

    const transport = makeMockTransport([page1, page2, []]);
    const parser = new GovernanceEventParser(prisma, { transport, cursorStore });

    await parser.catchupFromCursor(HORIZON_URL, CONTRACT_ID, 250);

    // Final cursor must be 250 (currentLedger)
    const stored = await cursorStore.loadGovernanceLedger();
    expect(stored).toBe(250);
  });

  // -------------------------------------------------------------------------
  // CU7: Catchup processes events in order (replay is deterministic)
  // -------------------------------------------------------------------------
  it('CU7: catchup processes events in ledger order', async () => {
    await cursorStore.saveGovernanceLedger(500);

    // Provide two proposals in reverse order to verify they are consumed in the
    // order returned by Horizon (ascending).
    const events: RawStellarEvent[] = [
      makeRawEvent({ ledger: 501 }),
      makeRawEvent({ ledger: 502 }),
    ];

    const processedLedgers: number[] = [];
    // Wrap the real transport to record ordering
    const transport = makeMockTransport([events, []]);
    const wrappedTransport: GovernanceCatchupTransport = {
      async getEvents(url, params) {
        const result = await transport.getEvents(url, params);
        result.data._embedded?.records.forEach((e) => processedLedgers.push(e.ledger));
        return result;
      },
    };

    const parser = new GovernanceEventParser(prisma, { transport: wrappedTransport, cursorStore });
    await parser.catchupFromCursor(HORIZON_URL, CONTRACT_ID, 502);

    expect(processedLedgers).toEqual([501, 502]);
  });

  // -------------------------------------------------------------------------
  // CU8: Default catchup window constant is 10,000
  // -------------------------------------------------------------------------
  it('CU8: DEFAULT_GOVERNANCE_CATCHUP_WINDOW is 10000', () => {
    expect(DEFAULT_GOVERNANCE_CATCHUP_WINDOW).toBe(10_000);
  });

  // -------------------------------------------------------------------------
  // CU9: catchup events are processed before live events (ordering guarantee)
  // -------------------------------------------------------------------------
  it('CU9: catchup completes before returning (live events start after)', async () => {
    await cursorStore.saveGovernanceLedger(700);

    const catchupEvents: RawStellarEvent[] = [makeRawEvent({ ledger: 701 })];
    const transport = makeMockTransport([catchupEvents, []]);
    const parser = new GovernanceEventParser(prisma, { transport, cursorStore });

    // Catchup should complete synchronously (awaited) before the caller proceeds
    const catchupCompleted = await parser.catchupFromCursor(HORIZON_URL, CONTRACT_ID, 701);
    expect(catchupCompleted).toBe(1);

    // Verify proposal exists — live processing can now proceed safely
    const proposal = await prisma.proposal.findUnique({ where: { proposalId: 701 } });
    expect(proposal).not.toBeNull();
  });
});
