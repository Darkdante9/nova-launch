/**
 * Governance Event Types
 * 
 * These types represent governance events emitted by smart contracts
 * and processed by the backend for analytics and tracking.
 */

export enum ProposalType {
  PARAMETER_CHANGE = 'PARAMETER_CHANGE',
  ADMIN_TRANSFER = 'ADMIN_TRANSFER',
  TREASURY_SPEND = 'TREASURY_SPEND',
  CONTRACT_UPGRADE = 'CONTRACT_UPGRADE',
  CUSTOM = 'CUSTOM',
}

export enum ProposalStatus {
  ACTIVE = 'ACTIVE',
  PASSED = 'PASSED',
  REJECTED = 'REJECTED',
  QUEUED = 'QUEUED',
  EXECUTED = 'EXECUTED',
  CANCELLED = 'CANCELLED',
  EXPIRED = 'EXPIRED',
}

export interface BaseGovernanceEvent {
  txHash: string;
  ledger: number;
  timestamp: Date;
  contractId: string;
}

export interface ProposalCreatedEvent extends BaseGovernanceEvent {
  type: 'proposal_created';
  proposalId: number;
  tokenAddress: string;
  proposer: string;
  title: string;
  description?: string;
  proposalType: ProposalType;
  startTime: Date;
  endTime: Date;
  quorum: string;
  threshold: string;
  metadata?: string;
}

export interface VoteCastEvent extends BaseGovernanceEvent {
  type: 'vote_cast';
  proposalId: number;
  voter: string;
  support: boolean;
  weight: string;
  reason?: string;
}

export interface ProposalExecutedEvent extends BaseGovernanceEvent {
  type: 'proposal_executed';
  proposalId: number;
  executor: string;
  success: boolean;
  returnData?: string;
  gasUsed?: string;
}

export interface ProposalCancelledEvent extends BaseGovernanceEvent {
  type: 'proposal_cancelled';
  proposalId: number;
  canceller: string;
  reason?: string;
}

export interface ProposalStatusChangedEvent extends BaseGovernanceEvent {
  type: 'proposal_status_changed';
  proposalId: number;
  oldStatus: ProposalStatus;
  newStatus: ProposalStatus;
}

/**
 * Periodic (every ~1000 ledgers) or on-demand checkpoint of a proposal's
 * fully accumulated state, emitted by the contract's `prop_snap`
 * (`ProposalStateSnapshot`) event (#1383).
 *
 * Off-chain indexers can use this as a fast-forward point: instead of
 * replaying every `proposal_created`/`vote_cast`/status-change event from
 * genesis, an indexer can seed its projection from the latest snapshot for
 * a proposal and only replay events emitted after `snapshotLedger`.
 */
export interface ProposalStateSnapshotEvent extends BaseGovernanceEvent {
  type: 'proposal_state_snapshot';
  proposalId: number;
  status: ProposalStatus;
  yesVotes: string;
  noVotes: string;
  quorumRequired: string;
  /** Ledger sequence at which the contract took this snapshot. */
  snapshotLedger: number;
}

export type GovernanceEvent =
  | ProposalCreatedEvent
  | VoteCastEvent
  | ProposalExecutedEvent
  | ProposalCancelledEvent
  | ProposalStatusChangedEvent
  | ProposalStateSnapshotEvent;

/**
 * Governance Analytics Types
 */

export interface ProposalAnalytics {
  proposalId: number;
  totalVotes: number;
  votesFor: string;
  votesAgainst: string;
  participationRate: number;
  uniqueVoters: number;
  status: ProposalStatus;
  timeRemaining?: number;
}

export interface GovernanceStats {
  totalProposals: number;
  activeProposals: number;
  executedProposals: number;
  totalVotes: number;
  uniqueVoters: number;
  averageParticipation: number;
  proposalsByType: Record<ProposalType, number>;
  proposalsByStatus: Record<ProposalStatus, number>;
}

export interface VoterStats {
  address: string;
  totalVotes: number;
  votingPower: string;
  participationRate: number;
  proposalsVoted: number[];
}
