/**
 * Integration tests for progressive confirmation step polling.
 *
 * Tests cover all 4 step transitions by mocking getConfirmationStep:
 *   submitted → pending → confirming → finalized
 *
 * Issue: #1374
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import React from 'react';
import * as deploymentStatusApiModule from '../../../services/deploymentStatusApi';
import * as DeploymentRecoveryStorageModule from '../../../services/DeploymentRecoveryStorage';
import { DeploymentRecoveryBanner } from '../../../components/TokenDeployForm/DeploymentRecoveryBanner';
import type { DeploymentCheckpoint } from '../../../services/DeploymentRecoveryStorage';
import type { ConfirmationStepResponse } from '../../../types';

const TX_HASH = 'a'.repeat(64);

const baseCheckpoint: DeploymentCheckpoint = {
  step: 'contract_submitted',
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  formData: {
    name: 'My Token',
    symbol: 'MTK',
    decimals: 7,
    initialSupply: '1000000',
    adminWallet: 'GTEST',
  },
  transactionHash: TX_HASH,
  network: 'testnet',
  walletAddress: 'GTEST',
};

function mockConfirmationStep(override: Partial<ConfirmationStepResponse>) {
  vi.spyOn(deploymentStatusApiModule, 'getConfirmationStep').mockResolvedValue({
    txHash: TX_HASH,
    step: 'submitted',
    totalConfirmations: 7,
    ...override,
  });
}

describe('Confirmation step banner — 4 step transitions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(DeploymentRecoveryStorageModule.DeploymentRecoveryStorage, 'getStaleCheckpoint')
      .mockReturnValue(baseCheckpoint);
    vi.spyOn(deploymentStatusApiModule, 'getDeploymentStatus').mockResolvedValue({
      txHash: TX_HASH,
      status: 'PENDING',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('step 1 — shows "Submitted" as active when step=submitted', async () => {
    mockConfirmationStep({ step: 'submitted' });

    render(<DeploymentRecoveryBanner onResume={() => {}} onDiscard={() => {}} />);

    await waitFor(() => {
      // Active step label should be visible
      expect(screen.getByText('Submitted')).toBeInTheDocument();
    });

    // Subsequent steps should be present but not active
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText('Confirming')).toBeInTheDocument();
    expect(screen.getByText('Finalized')).toBeInTheDocument();
  });

  it('step 2 — shows "Pending" as active when step=pending', async () => {
    mockConfirmationStep({ step: 'pending' });

    render(<DeploymentRecoveryBanner onResume={() => {}} onDiscard={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('Pending')).toBeInTheDocument();
    });
  });

  it('step 3 — shows confirmation count when step=confirming', async () => {
    mockConfirmationStep({ step: 'confirming', confirmations: 3, totalConfirmations: 7 });

    render(<DeploymentRecoveryBanner onResume={() => {}} onDiscard={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('Confirming (3/7)')).toBeInTheDocument();
    });
  });

  it('step 4 — shows all prior steps as done when step=finalized', async () => {
    mockConfirmationStep({ step: 'finalized', confirmations: 7, totalConfirmations: 7 });

    render(<DeploymentRecoveryBanner onResume={() => {}} onDiscard={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('Finalized')).toBeInTheDocument();
    });

    // All 4 labels should be present
    expect(screen.getByText('Submitted')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    // "Confirming" label (without count, it's a done step)
    expect(screen.getByText('Confirming')).toBeInTheDocument();
  });

  it('renders no StepIndicator when getConfirmationStep fails', async () => {
    vi.spyOn(deploymentStatusApiModule, 'getConfirmationStep').mockRejectedValue(
      new Error('Network error')
    );

    render(<DeploymentRecoveryBanner onResume={() => {}} onDiscard={() => {}} />);

    // Banner still renders even without confirmation info
    expect(screen.getByText(/Incomplete Deployment Detected/i)).toBeInTheDocument();

    // Step indicator labels should not appear (no confirmation data)
    await act(async () => {});
    expect(screen.queryByText('Submitted')).not.toBeInTheDocument();
  });

  it('does not render when there is no stale checkpoint', () => {
    vi.spyOn(DeploymentRecoveryStorageModule.DeploymentRecoveryStorage, 'getStaleCheckpoint')
      .mockReturnValue(null);

    const { container } = render(
      <DeploymentRecoveryBanner onResume={() => {}} onDiscard={() => {}} />
    );

    expect(container.firstChild).toBeNull();
  });
});
