import type { VaultProjection } from '../types';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api';

interface ApiResponse<T> {
  success: boolean;
  data: T;
  timestamp: string;
  error?: { code: string; message: string };
}

async function request<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
  });
  const body: ApiResponse<T> = await response.json();
  if (!response.ok || !body.success) {
    throw new Error(body.error?.message || `Vault API error: ${response.status}`);
  }
  return body.data;
}

/**
 * Fetch the latest ledger sequence number from Stellar Horizon.
 * Progress must be ledger-based — never use Date.now() as a proxy.
 */
export async function fetchCurrentLedger(horizonUrl: string): Promise<number> {
  const res = await fetch(`${horizonUrl}/`);
  if (!res.ok) throw new Error(`Horizon error: ${res.status}`);
  const data = await res.json();
  return data.core_latest_ledger as number;
}

/**
 * Compute vesting progress [0, 100] based on ledger numbers.
 *
 * @param currentLedger - Latest ledger from Horizon
 * @param startLedger   - Ledger when vesting began
 * @param endLedger     - Ledger when vesting fully matures
 */
export function calcLedgerProgress(
  currentLedger: number,
  startLedger: number,
  endLedger: number,
): number {
  if (endLedger <= startLedger) return 100;
  const pct = ((currentLedger - startLedger) / (endLedger - startLedger)) * 100;
  return Math.min(100, Math.max(0, pct));
}

export interface WithdrawalRecord {
  id: string;
  vaultId: number;
  amount: string;
  timestamp: string;
  txHash: string;
  recipient: string;
}

export interface PaginatedWithdrawals {
  withdrawals: WithdrawalRecord[];
  nextCursor?: string;
  prevCursor?: string;
  hasMore: boolean;
  totalCount?: number;
}

export const vaultsApi = {
  getById: (id: number) =>
    request<VaultProjection>(`/vaults/${id}`),

  getByCreator: (address: string) =>
    request<VaultProjection[]>(`/vaults/creator/${address}`),

  getByBeneficiary: (address: string) =>
    request<VaultProjection[]>(`/vaults/beneficiary/${address}`),

  getWithdrawalHistory: (vaultId: number, cursor?: string): Promise<PaginatedWithdrawals> => {
    const query = new URLSearchParams();
    if (cursor) query.append('cursor', cursor);
    query.append('limit', '10');
    return request<PaginatedWithdrawals>(`/vaults/${vaultId}/withdrawals?${query.toString()}`);
  },
};
