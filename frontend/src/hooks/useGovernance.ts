import { useState } from 'react';
import type { WalletState } from '../types';
import {
  submitProposal,
  fetchVoterInfo,
  invalidateProposalListCache,
} from '../services/governanceApi';

export type GovernanceStatus = 'idle' | 'submitting' | 'success' | 'error';

export interface CreateProposalInput {
  title: string;
  description: string;
  payloadType: string;
  payload: string;
  votingPeriod: number;
}

export function useGovernance(_tokenAddress: string) {
  const [status, setStatus] = useState<GovernanceStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [proposalId, setProposalId] = useState<string | null>(null);
  const [votingPower, setVotingPower] = useState<string | null>(null);

  const createProposal = async (
    params: CreateProposalInput,
    wallet: WalletState
  ): Promise<void> => {
    if (!wallet.connected || !wallet.address) {
      setError('Wallet not connected');
      return;
    }

    setStatus('submitting');
    setError(null);

    try {
      const result = await submitProposal(
        params.title,
        params.description,
        params.payloadType,
        params.payload,
        params.votingPeriod,
        wallet
      );

      setTxHash(result.txHash);
      setProposalId(result.proposalId);
      setStatus('success');
      invalidateProposalListCache();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create proposal');
      setStatus('error');
    }
  };

  const checkGovernancePower = async (wallet: WalletState): Promise<boolean> => {
    if (!wallet.connected || !wallet.address) return false;

    try {
      const info = await fetchVoterInfo(wallet.address);
      const power = info.votingPower;
      setVotingPower(power);
      return BigInt(power) > 0n;
    } catch {
      return false;
    }
  };

  const reset = () => {
    setStatus('idle');
    setError(null);
    setTxHash(null);
    setProposalId(null);
  };

  return {
    createProposal,
    checkGovernancePower,
    reset,
    status,
    error,
    txHash,
    proposalId,
    votingPower,
    isSubmitting: status === 'submitting',
  };
}
