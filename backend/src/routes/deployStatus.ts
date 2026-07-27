import { Router, Request, Response } from "express";
import axios from "axios";
import { successResponse, errorResponse } from "../utils/response";

const router = Router();

export type ConfirmationStep = "submitted" | "pending" | "confirming" | "finalized";

export interface ConfirmationStatusResponse {
  txHash: string;
  step: ConfirmationStep;
  confirmations?: number;
  totalConfirmations: number;
  ledger?: number;
  reason?: string;
}

const TOTAL_CONFIRMATIONS = 7;

function getHorizonUrl(network: string): string {
  if (process.env.STELLAR_HORIZON_URL) return process.env.STELLAR_HORIZON_URL;
  return network === "mainnet"
    ? "https://horizon.stellar.org"
    : "https://horizon-testnet.stellar.org";
}

/**
 * GET /api/deploy/status/:txHash
 *
 * Returns 4-step progressive confirmation state for a Stellar transaction:
 *   submitted  – hash known but not yet seen on Horizon
 *   pending    – seen in Horizon (in mempool / not yet in a ledger)
 *   confirming – included in a ledger, accumulating confirmations (n/7)
 *   finalized  – enough confirmations accumulated
 */
router.get("/:txHash", async (req: Request, res: Response) => {
  const { txHash } = req.params;
  const network = (req.query.network as string) || "testnet";

  if (!txHash || !/^[a-f0-9]{64}$/i.test(txHash)) {
    return res.status(400).json(
      errorResponse({ code: "INVALID_TX_HASH", message: "txHash must be a 64-character hex string" })
    );
  }

  if (!["testnet", "mainnet"].includes(network)) {
    return res.status(400).json(
      errorResponse({ code: "INVALID_NETWORK", message: "network must be testnet or mainnet" })
    );
  }

  try {
    const horizonUrl = getHorizonUrl(network);
    let txData: { successful: boolean; ledger?: number } | null = null;

    try {
      const response = await axios.get(`${horizonUrl}/transactions/${txHash}`, { timeout: 10000 });
      txData = response.data as { successful: boolean; ledger?: number };
    } catch (err: any) {
      if (err?.response?.status === 404) {
        // Not yet seen on Horizon — still submitted/propagating
        const result: ConfirmationStatusResponse = {
          txHash,
          step: "submitted",
          totalConfirmations: TOTAL_CONFIRMATIONS,
        };
        return res.json(successResponse(result));
      }
      throw err;
    }

    if (!txData.successful) {
      const result: ConfirmationStatusResponse = {
        txHash,
        step: "submitted",
        totalConfirmations: TOTAL_CONFIRMATIONS,
        reason: "Transaction failed on-chain",
      };
      return res.json(successResponse(result));
    }

    // Transaction is in a ledger. Compute confirmations by fetching latest ledger sequence.
    let confirmations = 0;
    if (txData.ledger) {
      try {
        const ledgerResp = await axios.get(`${horizonUrl}/ledgers?order=desc&limit=1`, { timeout: 10000 });
        const latestLedger: number = ledgerResp.data?._embedded?.records?.[0]?.sequence ?? txData.ledger;
        confirmations = latestLedger - txData.ledger + 1;
      } catch {
        // If we can't fetch latest ledger, assume at least 1 confirmation
        confirmations = 1;
      }
    }

    confirmations = Math.max(0, confirmations);
    const step: ConfirmationStep = confirmations >= TOTAL_CONFIRMATIONS ? "finalized" : "confirming";

    const result: ConfirmationStatusResponse = {
      txHash,
      step,
      confirmations: Math.min(confirmations, TOTAL_CONFIRMATIONS),
      totalConfirmations: TOTAL_CONFIRMATIONS,
      ledger: txData.ledger,
    };
    return res.json(successResponse(result));
  } catch (error) {
    console.error("Error fetching deploy status:", error);
    return res.status(502).json(
      errorResponse({ code: "HORIZON_ERROR", message: "Failed to fetch transaction status from Horizon" })
    );
  }
});

export default router;
