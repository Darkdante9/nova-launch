import { ERROR_REPORTING_ENABLED } from '../config/errorReporting';
import type { ErrorTxContext } from '../providers/ErrorContextProvider';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? '';

export interface ErrorReportPayload {
  message: string;
  stack?: string;
  componentStack?: string;
  txHash?: string | null;
  ledgerSequence?: number | null;
  walletAddress?: string | null;
  route?: string | null;
  network?: string | null;
}

/**
 * Send an enriched error report to the backend. Never throws — telemetry
 * failures must never compound the original rendering error.
 */
export async function reportError(payload: ErrorReportPayload): Promise<void> {
  if (!ERROR_REPORTING_ENABLED) return;

  try {
    await fetch(`${BACKEND_URL}/api/errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error('Failed to send error report:', err);
  }
}

/** Build the wire payload from a caught render error + the current tx context. */
export function buildErrorReportPayload(
  error: Error,
  componentStack: string | undefined,
  txContext: ErrorTxContext
): ErrorReportPayload {
  return {
    message: error.message,
    stack: error.stack,
    componentStack,
    txHash: txContext.txHash,
    ledgerSequence: txContext.ledgerSequence,
    walletAddress: txContext.walletAddress,
    route: txContext.route,
    network: txContext.network,
  };
}
