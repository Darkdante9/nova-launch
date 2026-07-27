import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { CampaignDashboard } from '../CampaignDashboard';
import * as useStellarHook from '../../../hooks/useStellar';
import * as useWalletHook from '../../../hooks/useWallet';
import * as useCampaignStepSubscriptionHook from '../../../hooks/useCampaignStepSubscription';
import type { CampaignStepExecutedEvent } from '../../../hooks/useCampaignStepSubscription';

global.fetch = vi.fn();

vi.mock('../../../hooks/useStellar');
vi.mock('../../../hooks/useWallet');
vi.mock('../../../hooks/useCampaignStepSubscription');

describe('CampaignDashboard Integration Tests', () => {
  const mockCampaign = {
    id: 1,
    tokenAddress: 'GTEST123456789',
    totalAmount: '10000',
    executedAmount: '5000',
    currentStep: 2,
    totalSteps: 5,
    status: 'ACTIVE' as const,
    createdAt: '2026-03-09T10:00:00Z',
    steps: [
      {
        id: 1,
        stepNumber: 0,
        amount: '2000',
        status: 'COMPLETED' as const,
        executedAt: '2026-03-09T10:30:00Z',
        txHash: 'hash1',
      },
      {
        id: 2,
        stepNumber: 1,
        amount: '3000',
        status: 'COMPLETED' as const,
        executedAt: '2026-03-09T11:00:00Z',
        txHash: 'hash2',
      },
      {
        id: 3,
        stepNumber: 2,
        amount: '2000',
        status: 'PENDING' as const,
      },
      {
        id: 4,
        stepNumber: 3,
        amount: '1500',
        status: 'PENDING' as const,
      },
      {
        id: 5,
        stepNumber: 4,
        amount: '1500',
        status: 'PENDING' as const,
      },
    ],
  };

  /** Captured on each render so tests can simulate a delivered subscription event. */
  let onStepExecuted: (event: CampaignStepExecutedEvent) => void = () => {};

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useStellarHook.useStellar).mockReturnValue({
      executeBuybackStep: vi.fn(),
      getCampaign: vi.fn(),
    });
    vi.mocked(useWalletHook.useWallet).mockReturnValue({
      wallet: { address: 'GTEST123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', isConnected: true },
      connect: vi.fn(),
      disconnect: vi.fn(),
      isConnecting: false,
      error: null,
    });
    vi.mocked(useCampaignStepSubscriptionHook.useCampaignStepSubscription).mockImplementation(
      (options) => {
        onStepExecuted = options.onStepExecuted;
        return { connected: true };
      }
    );
  });

  it('should fetch and display campaign data', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockCampaign,
    } as Response);

    render(<CampaignDashboard campaignId={1} />);

    await waitFor(() => {
      expect(screen.getByText(/buyback campaign #1/i)).toBeInTheDocument();
    });

    expect(screen.getByText('ACTIVE')).toBeInTheDocument();
    expect(screen.getByText(mockCampaign.tokenAddress)).toBeInTheDocument();
    expect(screen.getByText('2 / 5 steps')).toBeInTheDocument();
  });

  it('should show loading state initially', () => {
    vi.mocked(fetch).mockImplementation(
      () => new Promise(() => {}) // Never resolves
    );

    render(<CampaignDashboard campaignId={1} />);

    expect(screen.getByLabelText('Loading campaign')).toBeInTheDocument();
  });

  it('should handle fetch errors', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 404,
    } as Response);

    render(<CampaignDashboard campaignId={1} />);

    await waitFor(() => {
      expect(screen.getByText(/failed to fetch campaign/i)).toBeInTheDocument();
    });
  });

  it('should display progress bar correctly', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockCampaign,
    } as Response);

    render(<CampaignDashboard campaignId={1} />);

    await waitFor(() => {
      const progressText = screen.getByText('40%');
      expect(progressText).toBeInTheDocument();
    });
  });

  it('should show all steps with correct status', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockCampaign,
    } as Response);

    render(<CampaignDashboard campaignId={1} />);

    await waitFor(() => {
      expect(screen.getAllByText('COMPLETED')).toHaveLength(2);
      expect(screen.getAllByText('PENDING')).toHaveLength(3);
    });
  });

  it('should highlight current step', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockCampaign,
    } as Response);

    render(<CampaignDashboard campaignId={1} />);

    await waitFor(() => {
      expect(screen.getByText('(Current)')).toBeInTheDocument();
    });
  });

  it('should not show execute button for completed campaign', async () => {
    const completedCampaign = {
      ...mockCampaign,
      status: 'COMPLETED' as const,
      currentStep: 5,
    };

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => completedCampaign,
    } as Response);

    render(<CampaignDashboard campaignId={1} />);

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /execute/i })).not.toBeInTheDocument();
    });
  });

  it('should refresh data after successful step execution', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockCampaign,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ...mockCampaign,
          currentStep: 3,
          executedAmount: '7000',
        }),
      } as Response);

    render(<CampaignDashboard campaignId={1} />);

    await waitFor(() => {
      expect(screen.getByText('2 / 5 steps')).toBeInTheDocument();
    });

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('shows an ETA for the next step once two steps have executed', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockCampaign,
    } as Response);

    render(<CampaignDashboard campaignId={1} />);

    await waitFor(() => {
      expect(screen.getByText(/est\. next step in/i)).toBeInTheDocument();
    });
  });

  it('highlights the completed step and refetches immediately when a step-executed event arrives', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockCampaign,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ...mockCampaign,
          currentStep: 3,
          executedAmount: '7000',
          steps: mockCampaign.steps.map((step) =>
            step.stepNumber === 2
              ? { ...step, status: 'COMPLETED' as const, executedAt: '2026-03-09T11:30:00Z', txHash: 'hash3' }
              : step
          ),
        }),
      } as Response);

    render(<CampaignDashboard campaignId={1} />);

    await waitFor(() => {
      expect(screen.getByText('2 / 5 steps')).toBeInTheDocument();
    });

    onStepExecuted({
      campaignId: 1,
      stepNumber: 2,
      amount: '2000',
      status: 'COMPLETED',
      txHash: 'hash3',
      executedAt: '2026-03-09T11:30:00Z',
      totalSteps: 5,
      executedAmount: '7000',
      campaignStatus: 'ACTIVE',
    });

    await waitFor(() => {
      expect(screen.getByTestId('step-2')).toHaveClass('animate-pulse');
    });

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });
});
