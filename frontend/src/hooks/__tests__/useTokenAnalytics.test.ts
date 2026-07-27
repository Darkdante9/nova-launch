import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useTokenAnalytics } from '../useTokenAnalytics';
import * as tokenAnalyticsApi from '../../services/tokenAnalyticsApi';
import type { Granularity } from '../../components/TokenAnalytics/GranularityToggle';
import type { TimeRange } from '../../components/TokenAnalytics/TimeRangeSelector';

// Mock the API
vi.mock('../../services/tokenAnalyticsApi');

const mockStats = {
  address: '0x123',
  name: 'Test Token',
  symbol: 'TEST',
  decimals: 7,
  totalSupply: '1000000000000000',
  supplyHistory: [
    { timestamp: 1000000, supply: '1000000000000000' },
  ],
  burnCount: 10,
  totalBurned: '1000000000',
  burnerCount: 5,
  dailyBurnVolume: '100000000',
  weeklyBurnVolume: '700000000',
  monthlyBurnVolume: '3000000000',
  burnTrend: 5,
};

const mockBurnRecords = [
  {
    id: '1',
    timestamp: 1000000,
    from: '0xabc',
    amount: '1000000',
    isAdminBurn: false,
    txHash: '0xtx1',
  },
];

describe('useTokenAnalytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (tokenAnalyticsApi.fetchTokenStats as any).mockResolvedValue(mockStats);
    (tokenAnalyticsApi.fetchBurnRecords as any).mockResolvedValue(mockBurnRecords);
  });

  it('should fetch data on mount', async () => {
    const { result } = renderHook(() => useTokenAnalytics('0x123'));

    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.stats).toEqual(mockStats);
    expect(result.current.burnRecords).toEqual(mockBurnRecords);
  });

  it('should pass time range to fetchBurnRecords when custom', async () => {
    const timeRange: TimeRange = {
      preset: 'custom',
      startDate: '2024-01-01',
      endDate: '2024-01-31',
    };

    renderHook(() => useTokenAnalytics('0x123', timeRange));

    await waitFor(() => {
      expect(tokenAnalyticsApi.fetchBurnRecords).toHaveBeenCalledWith(
        '0x123',
        expect.objectContaining({
          startDate: '2024-01-01',
          endDate: '2024-01-31',
        })
      );
    });
  });

  it('should pass granularity to fetchBurnRecords', async () => {
    const granularity: Granularity = 'hourly';

    renderHook(() => useTokenAnalytics('0x123', undefined, granularity));

    await waitFor(() => {
      expect(tokenAnalyticsApi.fetchBurnRecords).toHaveBeenCalledWith(
        '0x123',
        expect.objectContaining({
          granularity: 'hourly',
        })
      );
    });
  });

  it('should pass both time range and granularity', async () => {
    const timeRange: TimeRange = {
      preset: 'custom',
      startDate: '2024-01-01',
      endDate: '2024-01-31',
    };
    const granularity: Granularity = 'weekly';

    renderHook(() => useTokenAnalytics('0x123', timeRange, granularity));

    await waitFor(() => {
      expect(tokenAnalyticsApi.fetchBurnRecords).toHaveBeenCalledWith(
        '0x123',
        expect.objectContaining({
          startDate: '2024-01-01',
          endDate: '2024-01-31',
          granularity: 'weekly',
        })
      );
    });
  });

  it('should not pass dates for preset ranges', async () => {
    const timeRange: TimeRange = { preset: '7d' };

    renderHook(() => useTokenAnalytics('0x123', timeRange));

    await waitFor(() => {
      expect(tokenAnalyticsApi.fetchBurnRecords).toHaveBeenCalledWith(
        '0x123',
        expect.not.objectContaining({
          startDate: expect.anything(),
          endDate: expect.anything(),
        })
      );
    });
  });

  it('should update when time range changes', async () => {
    const { rerender } = renderHook(
      ({ timeRange }: { timeRange: TimeRange }) =>
        useTokenAnalytics('0x123', timeRange),
      {
        initialProps: { timeRange: { preset: '7d' } },
      }
    );

    await waitFor(() => {
      expect(tokenAnalyticsApi.fetchBurnRecords).toHaveBeenCalled();
    });

    const callCount = (tokenAnalyticsApi.fetchBurnRecords as any).mock.calls.length;

    rerender({
      timeRange: {
        preset: 'custom',
        startDate: '2024-01-01',
        endDate: '2024-01-31',
      },
    });

    await waitFor(() => {
      expect((tokenAnalyticsApi.fetchBurnRecords as any).mock.calls.length).toBeGreaterThan(callCount);
    });
  });

  it('should update when granularity changes', async () => {
    const { rerender } = renderHook(
      ({ granularity }: { granularity: Granularity }) =>
        useTokenAnalytics('0x123', undefined, granularity),
      {
        initialProps: { granularity: 'daily' as Granularity },
      }
    );

    await waitFor(() => {
      expect(tokenAnalyticsApi.fetchBurnRecords).toHaveBeenCalled();
    });

    const callCount = (tokenAnalyticsApi.fetchBurnRecords as any).mock.calls.length;

    rerender({ granularity: 'hourly' as Granularity });

    await waitFor(() => {
      expect((tokenAnalyticsApi.fetchBurnRecords as any).mock.calls.length).toBeGreaterThan(callCount);
    });
  });

  it('should handle fetch error', async () => {
    const error = new Error('Fetch failed');
    (tokenAnalyticsApi.fetchTokenStats as any).mockRejectedValue(error);

    const { result } = renderHook(() => useTokenAnalytics('0x123'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('Fetch failed');
  });

  it('should provide refresh function', async () => {
    const { result } = renderHook(() => useTokenAnalytics('0x123'));

    await waitFor(() => {
      expect(result.current.stats).not.toBeNull();
    });

    const initialCallCount = (tokenAnalyticsApi.fetchTokenStats as any).mock.calls.length;

    result.current.refresh();

    await waitFor(() => {
      expect((tokenAnalyticsApi.fetchTokenStats as any).mock.calls.length).toBeGreaterThan(
        initialCallCount
      );
    });
  });
});
