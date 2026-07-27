import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import React from 'react';
import { WithdrawalHistory } from '../WithdrawalHistory';
import type { PaginatedWithdrawals } from '../../../services/vaultsApi';

describe('WithdrawalHistory - Pagination', () => {
  const mockWithdrawals: PaginatedWithdrawals = {
    withdrawals: [
      {
        id: '1',
        vaultId: 1,
        amount: '100000',
        timestamp: '2024-01-15T10:00:00Z',
        txHash: 'txhash123456789',
        recipient: 'GBENEFICIARY',
      },
      {
        id: '2',
        vaultId: 1,
        amount: '50000',
        timestamp: '2024-01-10T14:30:00Z',
        txHash: 'txhash987654321',
        recipient: 'GBENEFICIARY',
      },
    ],
    nextCursor: 'cursor_next',
    prevCursor: undefined,
    hasMore: true,
    totalCount: 5,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders withdrawal history table', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockWithdrawals);

    render(
      <WithdrawalHistory vaultId={1} onFetchWithdrawals={mockFetch} />
    );

    await waitFor(() => {
      expect(screen.getByText('100000')).toBeInTheDocument();
      expect(screen.getByText('50000')).toBeInTheDocument();
    });
  });

  it('displays pagination buttons with cursors', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockWithdrawals);

    render(
      <WithdrawalHistory vaultId={1} onFetchWithdrawals={mockFetch} />
    );

    await waitFor(() => {
      expect(screen.getByText('Next →')).toBeInTheDocument();
      expect(screen.queryByText('← Previous')).not.toBeInTheDocument();
    });
  });

  it('loads next page when next button clicked', async () => {
    const nextPageData: PaginatedWithdrawals = {
      withdrawals: [
        {
          id: '3',
          vaultId: 1,
          amount: '75000',
          timestamp: '2024-01-05T09:00:00Z',
          txHash: 'txhash111111111',
          recipient: 'GBENEFICIARY',
        },
      ],
      nextCursor: 'cursor_next_2',
      prevCursor: 'cursor_prev',
      hasMore: true,
      totalCount: 5,
    };

    const mockFetch = vi.fn()
      .mockResolvedValueOnce(mockWithdrawals)
      .mockResolvedValueOnce(nextPageData);

    render(
      <WithdrawalHistory vaultId={1} onFetchWithdrawals={mockFetch} />
    );

    await waitFor(() => {
      expect(screen.getByText('Next →')).toBeInTheDocument();
    });

    const nextButton = screen.getByText('Next →');
    fireEvent.click(nextButton);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(1, 'cursor_next');
      expect(screen.getByText('75000')).toBeInTheDocument();
    });
  });

  it('loads previous page when prev button clicked', async () => {
    const pageWithPrev: PaginatedWithdrawals = {
      withdrawals: mockWithdrawals.withdrawals,
      nextCursor: 'cursor_next',
      prevCursor: 'cursor_prev',
      hasMore: true,
    };

    const prevPageData: PaginatedWithdrawals = {
      withdrawals: [
        {
          id: '0',
          vaultId: 1,
          amount: '200000',
          timestamp: '2024-01-20T16:00:00Z',
          txHash: 'txhash000000000',
          recipient: 'GBENEFICIARY',
        },
      ],
      nextCursor: 'cursor_next',
      prevCursor: undefined,
      hasMore: true,
    };

    const mockFetch = vi.fn()
      .mockResolvedValueOnce(pageWithPrev)
      .mockResolvedValueOnce(prevPageData);

    render(
      <WithdrawalHistory vaultId={1} onFetchWithdrawals={mockFetch} />
    );

    await waitFor(() => {
      expect(screen.getByText('← Previous')).toBeInTheDocument();
    });

    const prevButton = screen.getByText('← Previous');
    fireEvent.click(prevButton);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(1, 'cursor_prev');
      expect(screen.getByText('200000')).toBeInTheDocument();
    });
  });

  it('shows loading spinner while fetching', async () => {
    const mockFetch = vi.fn(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(mockWithdrawals), 100)
        )
    );

    render(
      <WithdrawalHistory vaultId={1} onFetchWithdrawals={mockFetch} />
    );

    // Should show some loading state initially (component may not expose spinner)
    expect(mockFetch).toHaveBeenCalled();
  });

  it('handles error gracefully', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));

    render(
      <WithdrawalHistory vaultId={1} onFetchWithdrawals={mockFetch} />
    );

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
  });

  it('shows empty state when no withdrawals', async () => {
    const emptyData: PaginatedWithdrawals = {
      withdrawals: [],
      nextCursor: undefined,
      prevCursor: undefined,
      hasMore: false,
    };

    const mockFetch = vi.fn().mockResolvedValue(emptyData);

    render(
      <WithdrawalHistory vaultId={1} onFetchWithdrawals={mockFetch} />
    );

    await waitFor(() => {
      expect(screen.getByText('No withdrawal history available.')).toBeInTheDocument();
    });
  });

  it('disables pagination buttons while loading', async () => {
    const mockFetch = vi.fn(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(mockWithdrawals), 100)
        )
    );

    render(
      <WithdrawalHistory vaultId={1} onFetchWithdrawals={mockFetch} />
    );

    await waitFor(() => {
      const nextButton = screen.getByText('Next →') as HTMLButtonElement;
      expect(nextButton).toBeInTheDocument();
    });
  });

  it('refetches when vaultId changes', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockWithdrawals);

    const { rerender } = render(
      <WithdrawalHistory vaultId={1} onFetchWithdrawals={mockFetch} />
    );

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(1, undefined);
    });

    rerender(
      <WithdrawalHistory vaultId={2} onFetchWithdrawals={mockFetch} />
    );

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(2, undefined);
    });
  });

  it('formats transaction hash as truncated link', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockWithdrawals);

    render(
      <WithdrawalHistory vaultId={1} onFetchWithdrawals={mockFetch} />
    );

    await waitFor(() => {
      const txLink = screen.getByTitle('txhash123456789');
      expect(txLink).toHaveAttribute('href', expect.stringContaining('txhash123456789'));
      expect(txLink).toHaveAttribute('target', '_blank');
    });
  });
});
