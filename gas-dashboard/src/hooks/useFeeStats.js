import { useCallback, useEffect, useRef, useState } from 'react';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';
const POLL_INTERVAL_MS = 30000; // 30 seconds, per dashboard requirements

// How long to keep accumulated snapshots for the 24h trend chart.
// Horizon's /fee_stats endpoint has no historical/time-series endpoint —
// it only reflects the last few ledgers — so the rolling 24h trend is
// built client-side by sampling this endpoint every POLL_INTERVAL_MS and
// keeping a rolling buffer of snapshots in localStorage. This means the
// chart only has as much history as the dashboard has been open/sampling;
// it is not a true 24h backfill on first load.
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const HISTORY_STORAGE_KEY = 'gas-dashboard:fee-stats-history';
const MAX_HISTORY_POINTS = 2880; // 24h at one sample every 30s, generous cap

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function saveHistory(history) {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
  } catch {
    // localStorage may be unavailable (e.g. private browsing quota) — the
    // dashboard still works, it just won't persist history across reloads.
  }
}

function pruneHistory(history) {
  const cutoff = Date.now() - HISTORY_WINDOW_MS;
  const pruned = history.filter((point) => point.fetchedAtMs >= cutoff);
  if (pruned.length > MAX_HISTORY_POINTS) {
    return pruned.slice(pruned.length - MAX_HISTORY_POINTS);
  }
  return pruned;
}

/**
 * Polls the backend's /stellar/fee-stats endpoint (which proxies Horizon's
 * /fee_stats) every 30 seconds, and accumulates a rolling 24h buffer of
 * snapshots (persisted to localStorage) for trend charting.
 *
 * Returns:
 *   - data: the latest normalized fee-stats snapshot, or null before the
 *     first successful fetch
 *   - history: array of { fetchedAtMs, baseFee, p50, p75, p90, p99 } points
 *     within the rolling 24h window, oldest first
 *   - loading: true while the first fetch is in flight
 *   - error: the last fetch error, or null
 *   - refresh: manually triggers an extra fetch outside the poll cadence
 *     (does not reset the 30s timer; the next scheduled poll still fires
 *     on its original cadence)
 */
export function useFeeStats() {
  const [data, setData] = useState(null);
  const [history, setHistory] = useState(() => pruneHistory(loadHistory()));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const isMounted = useRef(true);

  const fetchFeeStats = useCallback(async () => {
    try {
      setError(null);
      const response = await fetch(`${API_BASE_URL}/stellar/fee-stats`);
      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }
      const body = await response.json();
      if (!body.success) {
        throw new Error(body.error?.message || 'Failed to fetch fee stats');
      }

      if (!isMounted.current) return;

      const snapshot = body.data;
      setData(snapshot);

      setHistory((prev) => {
        const point = {
          fetchedAtMs: new Date(snapshot.fetchedAt).getTime() || Date.now(),
          baseFee: snapshot.lastLedgerBaseFee,
          // Horizon's fee_charged buckets are p10/p20/.../p90/p95/p99 — there is
          // no native p75 bucket. We use p70 as the closest available stand-in
          // for a "p75-ish" mid-high percentile in the trend chart.
          p50: snapshot.feeCharged?.p50 ?? null,
          p70: snapshot.feeCharged?.p70 ?? null,
          p90: snapshot.feeCharged?.p90 ?? null,
          p99: snapshot.feeCharged?.p99 ?? null,
        };
        const next = pruneHistory([...prev, point]);
        saveHistory(next);
        return next;
      });
    } catch (err) {
      if (!isMounted.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (isMounted.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    isMounted.current = true;
    fetchFeeStats();

    const intervalId = setInterval(fetchFeeStats, POLL_INTERVAL_MS);

    return () => {
      isMounted.current = false;
      clearInterval(intervalId);
    };
  }, [fetchFeeStats]);

  return {
    data,
    history,
    loading,
    error,
    refresh: fetchFeeStats,
  };
}

export default useFeeStats;
