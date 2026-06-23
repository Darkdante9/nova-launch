/**
 * Stellar fee estimate and fee-bump availability endpoint (#1346).
 * GET /api/stellar/fee-estimate
 */
import { Router } from "express";
import { successResponse } from "../utils/response";

const router = Router();

const BASE_FEE_STROOPS = parseInt(process.env.STELLAR_BASE_FEE ?? "100", 10);
const FEE_BUMP_SPONSOR = process.env.STELLAR_FEE_BUMP_SPONSOR_ACCOUNT ?? "";
const FEE_BUMP_THRESHOLD_XLM = parseFloat(
  process.env.STELLAR_FEE_BUMP_THRESHOLD_XLM ?? "1.0"
);

/**
 * GET /api/stellar/fee-estimate
 *
 * Returns the current Stellar base fee (in stroops) and whether the fee-bump
 * sponsor account is configured. When the user's balance is below
 * feeThresholdXLM, the deployment pipeline will automatically wrap the
 * transaction in a fee-bump funded by the sponsor — transparent to the user.
 */
router.get("/fee-estimate", (_req, res) => {
  const feeBumpAvailable = FEE_BUMP_SPONSOR.length > 0;
  res.json(
    successResponse({
      baseFeeStroops: BASE_FEE_STROOPS,
      feeBumpAvailable,
      sponsorAccount: feeBumpAvailable ? FEE_BUMP_SPONSOR : null,
      feeThresholdXLM: FEE_BUMP_THRESHOLD_XLM,
    })
  );
});

export default router;
