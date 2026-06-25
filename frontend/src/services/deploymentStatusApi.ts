/**
 * Client-side API for deployment status checking
 * Calls backend endpoint: GET /api/tokens/deployment-status/:txHash
 */

import type { DeploymentStatusResponse, DeploymentStatusType, ConfirmationStepResponse } from '../types';

const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:3000/api';

export interface DeploymentStatus {
  txHash: string;
  status: DeploymentStatusType;
  ledger?: number;
  reason?: string; // Stellar error reason if failed
}

/**
 * Poll backend for deployment status
 * 
 * @param txHash - Stellar transaction hash
 * @param network - 'testnet' or 'mainnet'
 * @returns DeploymentStatus with current on-chain and backend indexing state
 */
export async function getDeploymentStatus(
  txHash: string,
  network: 'testnet' | 'mainnet'
): Promise<DeploymentStatus> {
  const url = new URL(`${API_BASE}/tokens/deployment-status/${txHash}`);
  url.searchParams.set('network', network);

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(
      error.message || `Failed to fetch deployment status: ${response.statusText}`
    );
  }

  const data = (await response.json()) as DeploymentStatusResponse;
  
  return {
    txHash: data.txHash,
    status: data.status,
    ledger: data.ledger,
    reason: data.reason,
  };
}

/**
 * Poll backend for progressive confirmation step (4-step disclosure)
 *
 * Steps: submitted → pending → confirming (n/7) → finalized
 *
 * @param txHash - Stellar transaction hash
 * @param network - 'testnet' or 'mainnet'
 */
export async function getConfirmationStep(
  txHash: string,
  network: 'testnet' | 'mainnet'
): Promise<ConfirmationStepResponse> {
  const url = new URL(`${API_BASE}/deploy/${txHash}`);
  url.searchParams.set('network', network);

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(
      error.message || `Failed to fetch confirmation step: ${response.statusText}`
    );
  }

  const data = await response.json();
  return data.data as ConfirmationStepResponse;
}
