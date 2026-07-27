import { useEffect, useState } from 'react';
import { fetchTokenStats, fetchBurnRecords } from '../services/tokenAnalyticsApi';
import { groupBurnsByDay, normaliseSupplyHistory } from '../utils/analyticsTransforms';
import type { TokenStats, BurnRecord } from '../services/tokenAnalyticsApi';
import type { DailyBurnPoint, SupplyPoint } from '../utils/analyticsTransforms';
import type { Granularity } from '../components/TokenAnalytics/GranularityToggle';
import type { TimeRange } from '../components/TokenAnalytics/TimeRangeSelector';

export interface TokenAnalyticsData {
  stats: TokenStats | null;
  burnRecords: BurnRecord[];
  dailyBurns: DailyBurnPoint[];
  supplyHistory: SupplyPoint[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Fetch token stats (REST) and burn records (GraphQL) in parallel and return
 * a unified, chart-ready data shape.
 */
export function useTokenAnalytics(
  address: string,
  timeRange?: TimeRange,
  granularity?: Granularity
): TokenAnalyticsData {
  const [stats, setStats] = useState<TokenStats | null>(null);
  const [burnRecords, setBurnRecords] = useState<BurnRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!address) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    const fetchRecords = async () => {
      try {
        const options: { startDate?: string; endDate?: string; granularity?: Granularity } = {};
        if (timeRange?.preset === 'custom') {
          options.startDate = timeRange.startDate;
          options.endDate = timeRange.endDate;
        }
        if (granularity) {
          options.granularity = granularity;
        }

        const [s, records] = await Promise.all([
          fetchTokenStats(address),
          fetchBurnRecords(address, options),
        ]);

        if (cancelled) return;
        setStats(s);
        setBurnRecords(records);
      } catch (err: unknown) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load analytics');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchRecords();

    return () => {
      cancelled = true;
    };
  }, [address, timeRange, granularity, tick]);

  const decimals = stats?.decimals ?? 7;
  const dailyBurns = groupBurnsByDay(burnRecords, decimals);
  const supplyHistory = normaliseSupplyHistory(stats?.supplyHistory ?? [], decimals);

  return {
    stats,
    burnRecords,
    dailyBurns,
    supplyHistory,
    loading,
    error,
    refresh: () => setTick((t) => t + 1),
  };
}
