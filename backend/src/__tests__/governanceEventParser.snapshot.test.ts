/**
 * Snapshot regression tests for GovernanceEventParser
 *
 * Locks the shape of prisma calls for all 6 proposal lifecycle events so that
 * upstream changes that silently alter the output shape are caught immediately.
 *
 * Closes #1287
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PrismaClient, ProposalStatus, ProposalType } from '@prisma/client';
import { GovernanceEventParser } from '../services/governanceEventParser';
import {
  fixtureProposalCreated,
  fixtureVoteCast,
  fixtureProposalQueued,
  fixtureProposalExecuted,
  fixtureProposalCancelled,
  fixtureProposalExpired,
  fixtureMalformedXdr,
} from './__fixtures__/governanceXdrFixtures';

// ---------------------------------------------------------------------------
// Prisma mock
// ---------------------------------------------------------------------------

const mockProposal = {
  id: 'proposal-uuid-1',
  proposalId: 1,
  status: ProposalStatus.ACTIVE,
};

const mockPrisma = {
  proposal: {
    upsert: vi.fn().mockResolvedValue(mockProposal),
    findUnique: vi.fn().mockResolvedValue(mockProposal),
    update: vi.fn().mockResolvedValue(mockProposal),
  },
  vote: {
    upsert: vi.fn().mockResolvedValue({}),
  },
  proposalExecution: {
    create: vi.fn().mockResolvedValue({}),
  },
} as unknown as PrismaClient;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function captureLastCall(mockFn: ReturnType<typeof vi.fn>) {
  const calls = mockFn.mock.calls;
  return calls[calls.length - 1]?.[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GovernanceEventParser — snapshot regression suite', () => {
  let parser: GovernanceEventParser;

  beforeEach(() => {
    vi.clearAllMocks();
    parser = new GovernanceEventParser(mockPrisma);
  });

  it('snapshot: Created — proposal.upsert payload shape', async () => {
    await parser.parseProposalCreatedEvent(fixtureProposalCreated);

    const call = captureLastCall(mockPrisma.proposal.upsert as ReturnType<typeof vi.fn>);
    expect(call).toMatchSnapshot();
  });

  it('snapshot: Voted — vote.upsert payload shape', async () => {
    await parser.parseVoteCastEvent(fixtureVoteCast);

    const call = captureLastCall(mockPrisma.vote.upsert as ReturnType<typeof vi.fn>);
    expect(call).toMatchSnapshot();
  });

  it('snapshot: Queued — proposal.update payload shape (status → QUEUED)', async () => {
    await parser.parseProposalStatusChangedEvent(fixtureProposalQueued);

    const call = captureLastCall(mockPrisma.proposal.update as ReturnType<typeof vi.fn>);
    expect(call).toMatchSnapshot();
  });

  it('snapshot: Executed — proposalExecution.create + proposal.update payload shapes', async () => {
    await parser.parseProposalExecutedEvent(fixtureProposalExecuted);

    const execCall = captureLastCall(mockPrisma.proposalExecution.create as ReturnType<typeof vi.fn>);
    const updateCall = captureLastCall(mockPrisma.proposal.update as ReturnType<typeof vi.fn>);

    expect({ executionCreate: execCall, proposalUpdate: updateCall }).toMatchSnapshot();
  });

  it('snapshot: Cancelled — proposal.update payload shape', async () => {
    await parser.parseProposalCancelledEvent(fixtureProposalCancelled);

    const call = captureLastCall(mockPrisma.proposal.update as ReturnType<typeof vi.fn>);
    expect(call).toMatchSnapshot();
  });

  it('snapshot: Expired — proposal.update payload shape (status → EXPIRED)', async () => {
    await parser.parseProposalStatusChangedEvent(fixtureProposalExpired);

    const call = captureLastCall(mockPrisma.proposal.update as ReturnType<typeof vi.fn>);
    expect(call).toMatchSnapshot();
  });

  it('throws a typed error when proposal is not found (vote cast on unknown proposal)', async () => {
    (mockPrisma.proposal.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(parser.parseVoteCastEvent(fixtureVoteCast)).rejects.toThrow(
      /Proposal \d+ not found/
    );
  });

  it('throws a typed error when proposal is not found (executed on unknown proposal)', async () => {
    (mockPrisma.proposal.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(parser.parseProposalExecutedEvent(fixtureProposalExecuted)).rejects.toThrow(
      /Proposal \d+ not found/
    );
  });

  it('throws a typed error when proposal is not found (cancelled on unknown proposal)', async () => {
    (mockPrisma.proposal.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(parser.parseProposalCancelledEvent(fixtureProposalCancelled)).rejects.toThrow(
      /Proposal \d+ not found/
    );
  });
});
