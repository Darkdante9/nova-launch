import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import React from 'react';
import { VaultDashboard } from '../VaultDashboard';
import * as vaultsService from '../../../services/vaultsApi';
import { useWallet } from '../../../hooks/useWallet';
import { useVaultBalanceSubscription } from '../../../hooks/useVaultBalanceSubscription';

// Mock dependencies
vi.mock('../../../hooks/useWallet');
vi.mock('../../../hooks/useVaultBalanceSubscription');
vi.mock('../../../hooks/useVaultContract');
vi.mock('../../../hooks/useToast');
vi.mock('../../../hooks/useConfetti');
vi.mock('../../../services/vaultsApi');

const mockVault = {
  streamId: 1,
  creator: 'GCREATOR',
  recipient: 'GRECIPIENT',
  amount: '1000000',
  status: 'CREATED' as const,
  createdAt: '2024-01-01',
  startLedger: 100,
  endLedger: 200,
};

describe('VaultDashboard - Real-time Balance Updates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (useWallet as any).mockReturnValue({
      wallet: {
        address: 'GUSER',
        network: 'testnet',
      },
    });
  });

  it('renders dashboard when wallet connected', async () => {
    (vaultsService.vaultsApi.getByBeneficiary as any).mockResolvedValue([mockVault]);
    (vaultsService.fetchCurrentLedger as any).mockResolvedValue(150);
    (useVaultBalanceSubscription as any).mockReturnValue({
      isConnected: true,
      error: null,
    });

    render(<VaultDashboard />);

    await waitFor(() => {
      expect(screen.getByText('Vaults Dashboard')).toBeInTheDocument();
    });
  });

  it('displays real-time balance subscription status', async () => {
    (vaultsService.vaultsApi.getByBeneficiary as any).mockResolvedValue([mockVault]);
    (vaultsService.fetchCurrentLedger as any).mockResolvedValue(150);
    (useVaultBalanceSubscription as any).mockReturnValue({
      isConnected: true,
      error: null,
    });

    render(<VaultDashboard />);

    await waitFor(() => {
      expect(screen.getByText(/Real-time balance updates enabled/)).toBeInTheDocument();
    });
  });

  it('handles balance update callback', async () => {
    let balanceChangedCallback: ((vaultId: number, newBalance: string) => void) | undefined;

    (useVaultBalanceSubscription as any).mockImplementation(
      (vaultIds: number[], callback?: any) => {
        balanceChangedCallback = callback;
        return { isConnected: true, error: null };
      }
    );

    (vaultsService.vaultsApi.getByBeneficiary as any).mockResolvedValue([mockVault]);
    (vaultsService.fetchCurrentLedger as any).mockResolvedValue(150);

    render(<VaultDashboard />);

    await waitFor(() => {
      expect(screen.getByText('1000000')).toBeInTheDocument();
    });

    // Simulate balance change
    if (balanceChangedCallback) {
      balanceChangedCallback(1, '2000000');
    }

    await waitFor(() => {
      expect(screen.getByText('2000000')).toBeInTheDocument();
    });
  });

  it('shows error when subscription fails', async () => {
    (vaultsService.vaultsApi.getByBeneficiary as any).mockResolvedValue([mockVault]);
    (vaultsService.fetchCurrentLedger as any).mockResolvedValue(150);
    (useVaultBalanceSubscription as any).mockReturnValue({
      isConnected: false,
      error: 'Connection failed',
    });

    render(<VaultDashboard />);

    await waitFor(() => {
      expect(screen.getByText('Connection failed')).toBeInTheDocument();
    });
  });

  it('passes onFetchWithdrawals to VaultCard', async () => {
    (vaultsService.vaultsApi.getByBeneficiary as any).mockResolvedValue([mockVault]);
    (vaultsService.fetchCurrentLedger as any).mockResolvedValue(150);
    (useVaultBalanceSubscription as any).mockReturnValue({
      isConnected: true,
      error: null,
    });

    render(<VaultDashboard />);

    await waitFor(() => {
      expect(screen.getByText(/Stream #1/)).toBeInTheDocument();
    });

    // VaultCard should have access to onFetchWithdrawals
    const historyButton = screen.getByText('View Withdrawal History');
    expect(historyButton).toBeInTheDocument();
  });

  it('handles refresh button click', async () => {
    (vaultsService.vaultsApi.getByBeneficiary as any).mockResolvedValue([mockVault]);
    (vaultsService.fetchCurrentLedger as any).mockResolvedValue(150);
    (useVaultBalanceSubscription as any).mockReturnValue({
      isConnected: true,
      error: null,
    });

    render(<VaultDashboard />);

    await waitFor(() => {
      expect(screen.getByText('Refresh')).toBeInTheDocument();
    });

    const refreshButton = screen.getByText('Refresh');
    fireEvent.click(refreshButton);

    await waitFor(() => {
      expect(vaultsService.vaultsApi.getByBeneficiary).toHaveBeenCalledTimes(2);
    });
  });

  it('displays claim confirmation on successful claim', async () => {
    (vaultsService.vaultsApi.getByBeneficiary as any).mockResolvedValue([
      { ...mockVault, status: 'CLAIMED' },
    ]);
    (vaultsService.fetchCurrentLedger as any).mockResolvedValue(250); // Past end ledger
    (useVaultBalanceSubscription as any).mockReturnValue({
      isConnected: true,
      error: null,
    });

    render(<VaultDashboard />);

    await waitFor(() => {
      expect(screen.getByText('CLAIMED')).toBeInTheDocument();
    });
  });
});
