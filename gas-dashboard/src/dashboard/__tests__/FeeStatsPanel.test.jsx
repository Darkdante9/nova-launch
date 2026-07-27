import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import FeeStatsPanel from '../FeeStatsPanel';

function mockFetchOnce(overrides = {}) {
  const feeCharged = {
    min: 100,
    max: 10000,
    mode: 100,
    p10: 100,
    p20: 100,
    p30: 100,
    p40: 100,
    p50: 100,
    p60: 150,
    p70: 200,
    p80: 300,
    p90: 500,
    p95: 1000,
    p99: 5000,
    ...overrides.feeCharged,
  };

  return {
    ok: true,
    json: async () => ({
      success: true,
      data: {
        lastLedger: 123456,
        lastLedgerBaseFee: overrides.lastLedgerBaseFee ?? 100,
        ledgerCapacityUsage: 0.42,
        feeCharged,
        fetchedAt: new Date().toISOString(),
      },
    }),
  };
}

describe('FeeStatsPanel', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders current base fee and percentile stats after loading', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockFetchOnce()));

    render(<FeeStatsPanel />);

    expect(screen.getByText(/Loading fee stats/i)).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText('Current Base Fee')).toBeInTheDocument());

    expect(screen.getByText('p50 (Median)')).toBeInTheDocument();
    expect(screen.getByText('p99')).toBeInTheDocument();
  });

  it('shows the elevated-fee recommendation banner when base fee >= p90', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockFetchOnce({ lastLedgerBaseFee: 600 }))
    );

    render(<FeeStatsPanel />);

    await waitFor(() =>
      expect(screen.getByText(/Fees are elevated/i)).toBeInTheDocument()
    );
  });

  it('does not show the recommendation banner when fees are normal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockFetchOnce({ lastLedgerBaseFee: 100 })));

    render(<FeeStatsPanel />);

    await waitFor(() => expect(screen.getByText('Current Base Fee')).toBeInTheDocument());

    expect(screen.queryByText(/Fees are elevated/i)).not.toBeInTheDocument();
  });

  it('triggers a manual refresh fetch when the Refresh button is clicked', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockFetchOnce());
    vi.stubGlobal('fetch', fetchMock);

    render(<FeeStatsPanel />);

    await waitFor(() => expect(screen.getByText('Refresh')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    screen.getByText('Refresh').click();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('shows an error message when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({ success: false }) })
    );

    render(<FeeStatsPanel />);

    await waitFor(() =>
      expect(screen.getByText(/Failed to load fee stats/i)).toBeInTheDocument()
    );
  });
});
