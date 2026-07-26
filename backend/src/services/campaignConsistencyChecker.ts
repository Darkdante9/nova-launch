import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * Represents the on-chain state of a campaign as retrieved from the blockchain
 * @interface OnChainCampaignState
 */
export interface OnChainCampaignState {
  /** Unique identifier for the campaign */
  campaignId: number;
  /** Current status of the campaign (e.g., 'ACTIVE', 'PAUSED', 'COMPLETED') */
  status: string;
  /** Current amount raised in the campaign (in smallest token units) */
  currentAmount: bigint;
  /** Number of times the campaign has been executed */
  executionCount: number;
  /** Target amount for the campaign (in smallest token units) */
  targetAmount: bigint;
}

/**
 * Represents a single inconsistency found between backend and on-chain state
 * @interface ConsistencyDiff
 */
export interface ConsistencyDiff {
  /** Campaign ID where the inconsistency was found */
  campaignId: number;
  /** Field name that has inconsistent values */
  field: string;
  /** Value from the backend database */
  backendValue: any;
  /** Value from the on-chain state */
  onChainValue: any;
}

/**
 * Result of a consistency check across multiple campaigns
 * @interface ConsistencyCheckResult
 */
export interface ConsistencyCheckResult {
  /** True if all campaigns are consistent, false otherwise */
  consistent: boolean;
  /** Total number of campaigns checked */
  totalChecked: number;
  /** Array of all inconsistencies found */
  diffs: ConsistencyDiff[];
}

/**
 * Options for a single-campaign consistency check
 * @interface CheckCampaignOptions
 */
export interface CheckCampaignOptions {
  /**
   * Set of in-flight transaction hashes (not yet confirmed on-chain) that are
   * known to be pending for this campaign. When provided, the checker will skip
   * reporting a `currentAmount` divergence whose magnitude is fully explained by
   * the sum of pending amounts in these transactions, preventing false-positive
   * drift alerts while a transaction is still propagating through the network.
   *
   * @example
   * // A payment of 50_000 stroops is in-flight; suppress its apparent drift:
   * checker.checkCampaign(1, onChainState, {
   *   inFlightTxHashes: new Set(['abc123', 'def456']),
   *   inFlightAmountDelta: BigInt(50_000),
   * });
   */
  inFlightTxHashes?: Set<string>;
  /**
   * The total amount that in-flight transactions are expected to add to
   * `currentAmount` once they are confirmed. If the difference between the
   * on-chain value and the backend value equals this delta, the diff is
   * considered in-flight and is suppressed.
   */
  inFlightAmountDelta?: bigint;
}

/**
 * Options for a batch consistency check
 * @interface CheckMultipleCampaignsOptions
 */
export interface CheckMultipleCampaignsOptions {
  /**
   * Per-campaign in-flight options keyed by campaignId.
   * Campaigns whose IDs are absent from this map are checked without any
   * in-flight suppression.
   */
  inFlight?: Map<number, CheckCampaignOptions>;
}

/**
 * CampaignConsistencyChecker - Verifies consistency between backend database and on-chain state
 *
 * This service compares campaign data stored in the backend database with the actual
 * on-chain state retrieved from the blockchain. It detects any discrepancies that may
 * indicate data synchronization issues, bugs, or potential security concerns.
 *
 * ### In-flight transaction guard
 * When a Stellar transaction has been submitted but not yet reflected in the Postgres
 * projection, the checker would normally flag a `currentAmount` divergence as drift.
 * Pass `inFlightTxHashes` and `inFlightAmountDelta` to suppress that false positive:
 * the checker will skip the `currentAmount` diff if the on-chain amount exceeds the
 * backend amount by exactly `inFlightAmountDelta` (i.e. the gap is fully explained by
 * the pending transaction).
 *
 * @class CampaignConsistencyChecker
 * @example
 * ```typescript
 * const checker = new CampaignConsistencyChecker();
 * const diffs = await checker.checkCampaign(1, onChainState);
 * if (diffs.length > 0) {
 *   console.log(checker.formatDiffs(diffs));
 * }
 * ```
 */
export class CampaignConsistencyChecker {
  /**
   * Checks a single campaign for consistency between backend and on-chain state.
   *
   * Compares the backend database record with the on-chain state and returns
   * an array of differences found. If the campaign doesn't exist in the backend,
   * returns a single diff indicating the missing campaign.
   *
   * Pass `options.inFlightTxHashes` + `options.inFlightAmountDelta` to suppress a
   * `currentAmount` divergence that is fully explained by pending (not-yet-confirmed)
   * transactions. This avoids false-positive alerts during the propagation window
   * between a transaction being submitted and the projection being updated.
   *
   * @param campaignId - The unique identifier of the campaign to check
   * @param onChainState - The current on-chain state of the campaign
   * @param options - Optional in-flight transaction context
   * @returns Array of ConsistencyDiff objects representing found discrepancies
   */
  async checkCampaign(
    campaignId: number,
    onChainState: OnChainCampaignState,
    options: CheckCampaignOptions = {}
  ): Promise<ConsistencyDiff[]> {
    const backendCampaign = await prisma.campaign.findUnique({
      where: { campaignId },
    });

    if (!backendCampaign) {
      return [
        {
          campaignId,
          field: "existence",
          backendValue: null,
          onChainValue: "exists",
        },
      ];
    }

    const diffs: ConsistencyDiff[] = [];

    if (backendCampaign.status !== onChainState.status) {
      diffs.push({
        campaignId,
        field: "status",
        backendValue: backendCampaign.status,
        onChainValue: onChainState.status,
      });
    }

    if (backendCampaign.currentAmount !== onChainState.currentAmount) {
      // Suppress the diff when all of the observed divergence is accounted for
      // by in-flight transactions that have not yet been projected into Postgres.
      const shouldSuppress = this._isCurrentAmountDivergenceInFlight(
        backendCampaign.currentAmount,
        onChainState.currentAmount,
        options
      );

      if (!shouldSuppress) {
        diffs.push({
          campaignId,
          field: "currentAmount",
          backendValue: backendCampaign.currentAmount.toString(),
          onChainValue: onChainState.currentAmount.toString(),
        });
      }
    }

    if (backendCampaign.executionCount !== onChainState.executionCount) {
      diffs.push({
        campaignId,
        field: "executionCount",
        backendValue: backendCampaign.executionCount,
        onChainValue: onChainState.executionCount,
      });
    }

    if (backendCampaign.targetAmount !== onChainState.targetAmount) {
      diffs.push({
        campaignId,
        field: "targetAmount",
        backendValue: backendCampaign.targetAmount.toString(),
        onChainValue: onChainState.targetAmount.toString(),
      });
    }

    return diffs;
  }

  /**
   * Returns true when the `currentAmount` gap is fully explained by in-flight
   * (not-yet-confirmed) transactions, meaning the divergence should NOT be
   * reported as real drift.
   *
   * Conditions for suppression (all must hold):
   *  1. At least one in-flight tx hash is provided.
   *  2. An `inFlightAmountDelta` is provided.
   *  3. The on-chain amount is greater than the backend amount (chain is ahead).
   *  4. The difference equals `inFlightAmountDelta` exactly.
   */
  private _isCurrentAmountDivergenceInFlight(
    backendAmount: bigint,
    onChainAmount: bigint,
    options: CheckCampaignOptions
  ): boolean {
    const { inFlightTxHashes, inFlightAmountDelta } = options;

    if (
      !inFlightTxHashes ||
      inFlightTxHashes.size === 0 ||
      inFlightAmountDelta === undefined ||
      inFlightAmountDelta <= BigInt(0)
    ) {
      return false;
    }

    // Only suppress when the chain is ahead of the projection by exactly the
    // pending delta (i.e. the projection has not yet processed the tx).
    const delta = onChainAmount - backendAmount;
    return delta === inFlightAmountDelta;
  }

  /**
   * Checks multiple campaigns for consistency in a single batch operation.
   *
   * Iterates through an array of on-chain states and checks each campaign
   * for consistency. Aggregates all differences found across all campaigns
   * into a single result object.
   *
   * @param onChainStates - Array of on-chain states to check
   * @param options - Optional batch-level in-flight context, keyed by campaignId
   * @returns ConsistencyCheckResult object with overall consistency status and all diffs
   */
  async checkMultipleCampaigns(
    onChainStates: OnChainCampaignState[],
    options: CheckMultipleCampaignsOptions = {}
  ): Promise<ConsistencyCheckResult> {
    const allDiffs: ConsistencyDiff[] = [];

    for (const onChainState of onChainStates) {
      const perCampaignOptions =
        options.inFlight?.get(onChainState.campaignId) ?? {};
      const diffs = await this.checkCampaign(
        onChainState.campaignId,
        onChainState,
        perCampaignOptions
      );
      allDiffs.push(...diffs);
    }

    return {
      consistent: allDiffs.length === 0,
      totalChecked: onChainStates.length,
      diffs: allDiffs,
    };
  }

  /**
   * Formats consistency diffs into a human-readable string representation.
   *
   * Converts an array of ConsistencyDiff objects into a formatted string
   * suitable for logging, reporting, or display purposes. Uses emoji
   * indicators for quick visual identification of consistency status.
   *
   * @param diffs - Array of ConsistencyDiff objects to format
   * @returns Formatted string with consistency check results
   */
  formatDiffs(diffs: ConsistencyDiff[]): string {
    if (diffs.length === 0) {
      return "✅ No inconsistencies found";
    }

    let output = `❌ Found ${diffs.length} inconsistencies:\n\n`;

    for (const diff of diffs) {
      output += `Campaign ${diff.campaignId} - ${diff.field}:\n`;
      output += `  Backend:  ${diff.backendValue}\n`;
      output += `  On-chain: ${diff.onChainValue}\n\n`;
    }

    return output;
  }
}

export const campaignConsistencyChecker = new CampaignConsistencyChecker();
