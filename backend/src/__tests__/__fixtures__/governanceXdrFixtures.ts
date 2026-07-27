/**
 * Deterministic typed fixtures for GovernanceEventParser snapshot tests.
 * All timestamps are fixed so snapshots are stable across runs.
 */

import {
  ProposalCreatedEvent,
  VoteCastEvent,
  ProposalExecutedEvent,
  ProposalCancelledEvent,
  ProposalStatusChangedEvent,
  ProposalType,
  ProposalStatus,
} from '../../types/governance';

const BASE_TIMESTAMP = new Date('2024-01-15T12:00:00.000Z');
const END_TIMESTAMP = new Date('2024-01-22T12:00:00.000Z');
const CONTRACT_ID = 'CGOVCONTRACT1234567890ABCDEF';

export const fixtureProposalCreated: ProposalCreatedEvent = {
  type: 'proposal_created',
  txHash: 'deadbeef0001000000000000000000000000000000000000000000000000cafe',
  ledger: 1_000_000,
  timestamp: BASE_TIMESTAMP,
  contractId: CONTRACT_ID,
  proposalId: 1,
  tokenAddress: 'CTOKEN1234567890ABCDEFGHIJKLMN',
  proposer: 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ12345',
  title: 'Increase Protocol Fee',
  description: 'Proposal to increase the protocol fee from 1% to 2%',
  proposalType: ProposalType.PARAMETER_CHANGE,
  startTime: BASE_TIMESTAMP,
  endTime: END_TIMESTAMP,
  quorum: '1000000000000',
  threshold: '500000000000',
  metadata: JSON.stringify({ category: 'fee_adjustment' }),
};

export const fixtureVoteCast: VoteCastEvent = {
  type: 'vote_cast',
  txHash: 'deadbeef0002000000000000000000000000000000000000000000000000cafe',
  ledger: 1_000_100,
  timestamp: new Date('2024-01-15T13:00:00.000Z'),
  contractId: CONTRACT_ID,
  proposalId: 1,
  voter: 'GVOTER12345678901234567890ABCDEFGHIJKLMNOPQR',
  support: true,
  weight: '250000000000',
  reason: 'I support this proposal for better tokenomics',
};

export const fixtureProposalQueued: ProposalStatusChangedEvent = {
  type: 'proposal_status_changed',
  txHash: 'deadbeef0003000000000000000000000000000000000000000000000000cafe',
  ledger: 1_000_200,
  timestamp: new Date('2024-01-22T12:30:00.000Z'),
  contractId: CONTRACT_ID,
  proposalId: 1,
  oldStatus: ProposalStatus.ACTIVE,
  newStatus: ProposalStatus.QUEUED,
};

export const fixtureProposalExecuted: ProposalExecutedEvent = {
  type: 'proposal_executed',
  txHash: 'deadbeef0004000000000000000000000000000000000000000000000000cafe',
  ledger: 1_000_300,
  timestamp: new Date('2024-01-23T10:00:00.000Z'),
  contractId: CONTRACT_ID,
  proposalId: 1,
  executor: 'GEXECUTOR1234567890ABCDEFGHIJKLMNOPQRSTUV',
  success: true,
  returnData: '0x01',
  gasUsed: '50000',
};

export const fixtureProposalCancelled: ProposalCancelledEvent = {
  type: 'proposal_cancelled',
  txHash: 'deadbeef0005000000000000000000000000000000000000000000000000cafe',
  ledger: 1_000_400,
  timestamp: new Date('2024-01-16T09:00:00.000Z'),
  contractId: CONTRACT_ID,
  proposalId: 2,
  canceller: 'GCANCELLER1234567890ABCDEFGHIJKLMNOPQRSTUV',
  reason: 'Proposal no longer needed',
};

export const fixtureProposalExpired: ProposalStatusChangedEvent = {
  type: 'proposal_status_changed',
  txHash: 'deadbeef0006000000000000000000000000000000000000000000000000cafe',
  ledger: 1_000_500,
  timestamp: new Date('2024-01-23T00:00:00.000Z'),
  contractId: CONTRACT_ID,
  proposalId: 3,
  oldStatus: ProposalStatus.ACTIVE,
  newStatus: ProposalStatus.EXPIRED,
};

export const fixtureMalformedXdr = 'ZZZZZZZZZINVALIDXDRBLOB!!!';
