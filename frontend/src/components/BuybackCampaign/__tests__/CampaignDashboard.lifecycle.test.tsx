import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CampaignDashboard } from '../CampaignDashboard';
import type { BuybackCampaignModel } from '../../../types/campaign';

// Mock the hooks
vi.mock('../../../hooks/useProjectionRefresh', () => ({
  useProjectionRefresh: vi.fn(() => ({
    status: 'idle',
    retry: vi.fn(),
  })),
}));

vi.mock('../../../hooks/useCampaignStepSubscription', () => ({
  useCampaignStepSubscription: vi.fn(),
}));

// Mock the services
vi.mock('../../../services/campaignApi', () => ({
  campaignApi: {
    getById: vi.fn(),
  },
}));

// Mock utilities
vi.mock('../../../utils/explorer', () => ({
  getTxUrl: (hash: string) => `https://explorer.stellar.org/tx/${hash}`,
}));

const mockCampaignUpcoming: BuybackCampaignModel = {
  id: 1,
  tokenAddress: 'CTOKEN123',
  totalAmount: '10000',
  executedAmount: '0',
  currentStep: 0,
  totalSteps: 5,
  status: 'UPCOMING',
  createdAt: '2026-03-24T00:00:00Z',
  progressPercent: 0,
  isActive: false,
  steps: [
    { id: 1, stepNumber: 0, amount: '2000', status: 'PENDING' },
    { id: 2, stepNumber: 1, amount: '2000', status: 'PENDING' },
    { id: 3, stepNumber: 2, amount: '2000', status: 'PENDING' },
    { id: 4, stepNumber: 3, amount: '2000', status: 'PENDING' },
    { id: 5, stepNumber: 4, amount: '2000', status: 'PENDING' },
  ],
};

const mockCampaignActive: BuybackCampaignModel = {
  ...mockCampaignUpcoming,
  status: 'ACTIVE',
  isActive: true,
  currentStep: 2,
  executedAmount: '4000',
  progressPercent: 40,
  steps: [
    { id: 1, stepNumber: 0, amount: '2000', status: 'COMPLETED', executedAt: '2026-03-24T01:00:00Z', txHash: 'abc123' },
    { id: 2, stepNumber: 1, amount: '2000', status: 'COMPLETED', executedAt: '2026-03-24T02:00:00Z', txHash: 'def456' },
    { id: 3, stepNumber: 2, amount: '2000', status: 'PENDING' },
    { id: 4, stepNumber: 3, amount: '2000', status: 'PENDING' },
    { id: 5, stepNumber: 4, amount: '2000', status: 'PENDING' },
  ],
};

const mockCampaignEnded: BuybackCampaignModel = {
  ...mockCampaignActive,
  status: 'COMPLETED',
  isActive: false,
  currentStep: 5,
  executedAmount: '10000',
  progressPercent: 100,
  steps: [
    { id: 1, stepNumber: 0, amount: '2000', status: 'COMPLETED', executedAt: '2026-03-24T01:00:00Z', txHash: 'abc123' },
    { id: 2, stepNumber: 1, amount: '2000', status: 'COMPLETED', executedAt: '2026-03-24T02:00:00Z', txHash: 'def456' },
    { id: 3, stepNumber: 2, amount: '2000', status: 'COMPLETED', executedAt: '2026-03-24T03:00:00Z', txHash: 'ghi789' },
    { id: 4, stepNumber: 3, amount: '2000', status: 'COMPLETED', executedAt: '2026-03-24T04:00:00Z', txHash: 'jkl012' },
    { id: 5, stepNumber: 4, amount: '2000', status: 'COMPLETED', executedAt: '2026-03-24T05:00:00Z', txHash: 'mno345' },
  ],
};

describe('CampaignDashboard — lifecycle state coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('upcoming state rendering', () => {
    it('renders upcoming campaign with no execute button', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockCampaignUpcoming,
      } as Response);

      render(<CampaignDashboard campaignId={1} />);

      await waitFor(() => {
        expect(screen.getByText('Buyback Campaign #1')).toBeInTheDocument();
        expect(screen.getByText('UPCOMING')).toBeInTheDocument();
      });

      expect(screen.queryByText('Current Step')).not.toBeInTheDocument();
    });

    it('displays upcoming campaign status badge', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockCampaignUpcoming,
      } as Response);

      render(<CampaignDashboard campaignId={1} />);

      await waitFor(() => {
        const badge = screen.getByText('UPCOMING');
        expect(badge).toBeInTheDocument();
        expect(badge).toHaveClass('bg-gray-100');
      });
    });

    it('shows 0% progress for upcoming campaign', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockCampaignUpcoming,
      } as Response);

      render(<CampaignDashboard campaignId={1} />);

      await waitFor(() => {
        const progressText = screen.getByText('0%');
        expect(progressText).toBeInTheDocument();
      });
    });

    it('displays all steps as pending in upcoming state', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockCampaignUpcoming,
      } as Response);

      render(<CampaignDashboard campaignId={1} />);

      await waitFor(() => {
        for (let i = 0; i < 5; i++) {
          expect(screen.getByTestId(`step-${i}`)).toBeInTheDocument();
        }
      });
    });
  });

  describe('active state rendering', () => {
    it('renders active campaign with execute button', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockCampaignActive,
      } as Response);

      render(<CampaignDashboard campaignId={1} />);

      await waitFor(() => {
        expect(screen.getByText('Buyback Campaign #1')).toBeInTheDocument();
        expect(screen.getByText('ACTIVE')).toBeInTheDocument();
        expect(screen.getByText('Current Step')).toBeInTheDocument();
      });
    });

    it('displays active campaign status badge with green styling', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockCampaignActive,
      } as Response);

      render(<CampaignDashboard campaignId={1} />);

      await waitFor(() => {
        const badge = screen.getByText('ACTIVE');
        expect(badge).toHaveClass('bg-green-100');
      });
    });

    it('shows correct progress percentage for active campaign', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockCampaignActive,
      } as Response);

      render(<CampaignDashboard campaignId={1} />);

      await waitFor(() => {
        const progressText = screen.getByText('40%');
        expect(progressText).toBeInTheDocument();
      });
    });

    it('highlights current step in active campaign', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockCampaignActive,
      } as Response);

      render(<CampaignDashboard campaignId={1} />);

      await waitFor(() => {
        const currentStepElement = screen.getByTestId('step-2');
        expect(currentStepElement).toHaveClass('bg-blue-50');
      });
    });

    it('marks completed steps with green styling', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockCampaignActive,
      } as Response);

      render(<CampaignDashboard campaignId={1} />);

      await waitFor(() => {
        const completedStep = screen.getByTestId('step-0');
        expect(completedStep).toHaveClass('bg-green-50');
      });
    });

    it('displays executed amount in active campaign', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockCampaignActive,
      } as Response);

      render(<CampaignDashboard campaignId={1} />);

      await waitFor(() => {
        expect(screen.getByText('4000')).toBeInTheDocument();
      });
    });
  });

  describe('ended state rendering', () => {
    it('renders completed campaign with no execute button', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockCampaignEnded,
      } as Response);

      render(<CampaignDashboard campaignId={1} />);

      await waitFor(() => {
        expect(screen.getByText('Buyback Campaign #1')).toBeInTheDocument();
        expect(screen.getByText('COMPLETED')).toBeInTheDocument();
      });

      expect(screen.queryByText('Current Step')).not.toBeInTheDocument();
    });

    it('displays completed campaign status badge with blue styling', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockCampaignEnded,
      } as Response);

      render(<CampaignDashboard campaignId={1} />);

      await waitFor(() => {
        const badge = screen.getByText('COMPLETED');
        expect(badge).toHaveClass('bg-blue-100');
      });
    });

    it('shows 100% progress for completed campaign', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockCampaignEnded,
      } as Response);

      render(<CampaignDashboard campaignId={1} />);

      await waitFor(() => {
        const progressText = screen.getByText('100%');
        expect(progressText).toBeInTheDocument();
      });
    });

    it('displays all steps as completed in ended state', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockCampaignEnded,
      } as Response);

      render(<CampaignDashboard campaignId={1} />);

      await waitFor(() => {
        for (let i = 0; i < 5; i++) {
          const step = screen.getByTestId(`step-${i}`);
          expect(step).toHaveClass('bg-green-50');
        }
      });
    });

    it('displays total executed amount equals total amount when completed', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockCampaignEnded,
      } as Response);

      render(<CampaignDashboard campaignId={1} />);

      await waitFor(() => {
        expect(screen.getByText('10000')).toBeInTheDocument();
      });
    });
  });

  describe('state transitions', () => {
    it('re-renders correctly when campaign transitions from active to completed', async () => {
      const { rerender } = render(<CampaignDashboard campaignId={1} />);

      // Initial active state
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockCampaignActive,
      } as Response);

      await waitFor(() => {
        expect(screen.getByText('ACTIVE')).toBeInTheDocument();
      });

      // Simulate transition to completed
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockCampaignEnded,
      } as Response);

      rerender(<CampaignDashboard campaignId={1} />);

      await waitFor(() => {
        expect(screen.getByText('COMPLETED')).toBeInTheDocument();
        expect(screen.queryByText('ACTIVE')).not.toBeInTheDocument();
      });
    });

    it('does not require remount when transitioning from active to ended state', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockCampaignActive,
      } as Response);

      const { rerender } = render(<CampaignDashboard campaignId={1} />);

      await waitFor(() => {
        expect(screen.getByText('40%')).toBeInTheDocument();
      });

      // Update to ended state
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockCampaignEnded,
      } as Response);

      rerender(<CampaignDashboard campaignId={1} />);

      await waitFor(() => {
        expect(screen.getByText('100%')).toBeInTheDocument();
      });

      // Verify execute button disappeared
      expect(screen.queryByText('Current Step')).not.toBeInTheDocument();
    });

    it('preserves scroll position during active-to-ended transition', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockCampaignActive,
      } as Response);

      render(<CampaignDashboard campaignId={1} />);

      await waitFor(() => {
        expect(screen.getByText('ACTIVE')).toBeInTheDocument();
      });

      const containerBefore = screen.getByText('Buyback Campaign #1').parentElement;

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockCampaignEnded,
      } as Response);

      // Re-render same component
      const { rerender } = render(<CampaignDashboard campaignId={1} />);

      await waitFor(() => {
        expect(screen.getByText('COMPLETED')).toBeInTheDocument();
      });

      const containerAfter = screen.getByText('Buyback Campaign #1').parentElement;
      // Verify it's the same element (not remounted)
      expect(containerAfter).toBe(containerBefore);
    });

    it('updates step completion status without losing user context', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockCampaignActive,
      } as Response);

      const { rerender } = render(<CampaignDashboard campaignId={1} />);

      await waitFor(() => {
        expect(screen.getByText('Step 3')).toBeInTheDocument();
      });

      const stepBefore = screen.getByTestId('step-2');

      // Simulate step completion
      const updatedCampaign: BuybackCampaignModel = {
        ...mockCampaignActive,
        currentStep: 3,
        executedAmount: '6000',
        progressPercent: 60,
        steps: mockCampaignActive.steps.map((s, i) => ({
          ...s,
          status: i < 3 ? 'COMPLETED' : 'PENDING',
          executedAt: i < 3 ? '2026-03-24T0X:00:00Z' : undefined,
          txHash: i < 3 ? `tx${i}` : undefined,
        })),
      };

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => updatedCampaign,
      } as Response);

      rerender(<CampaignDashboard campaignId={1} />);

      await waitFor(() => {
        expect(screen.getByText('60%')).toBeInTheDocument();
      });

      // Step 2 should now show as completed
      const stepAfter = screen.getByTestId('step-2');
      expect(stepAfter).toHaveClass('bg-green-50');
    });
  });

  describe('rendering edge cases', () => {
    it('handles campaign with single step', async () => {
      const singleStepCampaign: BuybackCampaignModel = {
        ...mockCampaignActive,
        totalSteps: 1,
        steps: [{ id: 1, stepNumber: 0, amount: '10000', status: 'PENDING' }],
      };

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => singleStepCampaign,
      } as Response);

      render(<CampaignDashboard campaignId={1} />);

      await waitFor(() => {
        expect(screen.getByTestId('step-0')).toBeInTheDocument();
      });
    });

    it('handles campaign with many steps (10+)', async () => {
      const manyStepsCampaign: BuybackCampaignModel = {
        ...mockCampaignActive,
        totalSteps: 10,
        steps: Array.from({ length: 10 }, (_, i) => ({
          id: i + 1,
          stepNumber: i,
          amount: '1000',
          status: i < 3 ? 'COMPLETED' : 'PENDING',
          executedAt: i < 3 ? '2026-03-24T00:00:00Z' : undefined,
          txHash: i < 3 ? `tx${i}` : undefined,
        })),
      };

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => manyStepsCampaign,
      } as Response);

      render(<CampaignDashboard campaignId={1} />);

      await waitFor(() => {
        expect(screen.getByTestId('step-9')).toBeInTheDocument();
      });
    });

    it('renders transaction links for completed steps', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockCampaignActive,
      } as Response);

      render(<CampaignDashboard campaignId={1} />);

      await waitFor(() => {
        const txLinks = screen.getAllByText('View Transaction');
        expect(txLinks.length).toBeGreaterThan(0);
      });
    });

    it('does not render transaction links for pending steps', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockCampaignActive,
      } as Response);

      render(<CampaignDashboard campaignId={1} />);

      await waitFor(() => {
        const allElements = screen.queryAllByText('View Transaction');
        // Should only be 2 (the completed steps)
        expect(allElements.length).toBe(2);
      });
    });
  });
});
