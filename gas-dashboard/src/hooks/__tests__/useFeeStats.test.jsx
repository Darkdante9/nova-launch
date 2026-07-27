import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { useFeeStats } from '../useFeeStats';

const SAMPLE_RESPONSE = {
  success: true,
  data: {
    lastLedger: 123456,
    lastLedgerBaseFee: 100,
    ledgerCapacityUsage: 0.42,
    feeCharged: {
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
    },
    fetchedAt: '2026-06-25T12:00:00.000Z',
  },
};

// Minimal harness component so we can exercise the hook through React's
// render/act lifecycle.
function HookHarness() {
  const { data, history, loading, error, refresh } = useFeeStats();
  return (
    <div>
      <div data-testid="loading">{String(loading)}</div>
      <div data-testid="error">{error ?? ''}</div>
      <div data-testid="base-fee">{data?.lastLedgerBaseFee ?? ''}</div>
      <div data-testid="history-length">{history.length}</div>
      <button onClick={refresh}>refresh</button>
    </div>
  );
}

describe('useFeeStats', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => SAMPLE_RESPONSE,
      })
    );
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('fetches fee stats on mount and exposes the latest snapshot', async () => {
    render(<HookHarness />);

    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));

    expect(screen.getByTestId('base-fee').textContent).toBe('100');
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/stellar/fee-stats'));
  });

  it('accumulates a history point per successful fetch', async () => {
    render(<HookHarness />);

    await waitFor(() => expect(screen.getByTestId('history-length').textContent).toBe('1'));
  });

  it('exposes an error message when the fetch fails', async () => {
    fetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ success: false }),
    });

    render(<HookHarness />);

    await waitFor(() => expect(screen.getByTestId('error').textContent).not.toBe(''));
  });

  it('refresh() triggers an additional fetch', async () => {
    render(<HookHarness />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    await act(async () => {
      screen.getByText('refresh').click();
    });

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });
});
