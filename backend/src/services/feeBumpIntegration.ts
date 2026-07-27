/**
 * Fee-bump integration for the token deployment pipeline (#1346).
 *
 * When a user's XLM balance is below STELLAR_FEE_BUMP_THRESHOLD_XLM,
 * the deployment transaction is automatically wrapped in a fee-bump funded by
 * the sponsor account (STELLAR_FEE_BUMP_SPONSOR_ACCOUNT).
 *
 * The sponsor is fully transparent to the user — no UI changes required.
 */

import {
  submitFeeBump,
  DEFAULT_FEE_BUMP_CONFIG,
  FeeBumpResult,
  HorizonServer,
} from "../stellar-service-integration/feeBump.service";

export interface DeploymentContext {
  userBalanceXLM: number;
  originalTxHash: string;
  originalFee: string;
  buildFeeBumpTx: (bumpFee: string) => unknown;
  horizon: HorizonServer;
}

const THRESHOLD_XLM = parseFloat(
  process.env.STELLAR_FEE_BUMP_THRESHOLD_XLM ?? "1.0"
);

const SPONSOR_ACCOUNT = process.env.STELLAR_FEE_BUMP_SPONSOR_ACCOUNT ?? "";

export function isSponsorConfigured(): boolean {
  return SPONSOR_ACCOUNT.length > 0;
}

export function needsFeeBump(userBalanceXLM: number): boolean {
  return isSponsorConfigured() && userBalanceXLM < THRESHOLD_XLM;
}

/**
 * Submit a deployment transaction, automatically applying a fee-bump when
 * the user's balance is below the configured threshold.
 *
 * Returns `{ feeBumped: true, result }` when a fee-bump was applied,
 * or `{ feeBumped: false, result: null }` when balance was sufficient.
 */
export async function submitDeploymentWithFeeBump(
  ctx: DeploymentContext
): Promise<{ feeBumped: boolean; result: FeeBumpResult | null }> {
  if (!needsFeeBump(ctx.userBalanceXLM)) {
    return { feeBumped: false, result: null };
  }

  const result = await submitFeeBump(
    ctx.originalTxHash,
    ctx.originalFee,
    ctx.buildFeeBumpTx,
    ctx.horizon,
    DEFAULT_FEE_BUMP_CONFIG
  );

  return { feeBumped: true, result };
}
