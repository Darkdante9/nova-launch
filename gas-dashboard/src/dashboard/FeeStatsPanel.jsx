import React, { useMemo } from 'react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';
import { format } from 'date-fns';
import { useFeeStats } from '../hooks/useFeeStats';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
);

/**
 * Stroop -> XLM formatting helper. Horizon fee values are denominated in
 * stroops (1 XLM = 10,000,000 stroops).
 */
function formatStroops(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '--';
  return value.toLocaleString();
}

function buildChartData(history) {
  const labels = history.map((point) => format(new Date(point.fetchedAtMs), 'HH:mm:ss'));

  return {
    labels,
    datasets: [
      {
        label: 'Base Fee',
        data: history.map((point) => point.baseFee),
        borderColor: '#0066ff',
        backgroundColor: 'rgba(0, 102, 255, 0.1)',
        tension: 0.3,
        pointRadius: 2,
      },
      {
        label: 'p50',
        data: history.map((point) => point.p50),
        borderColor: '#00c853',
        backgroundColor: 'rgba(0, 200, 83, 0.1)',
        tension: 0.3,
        pointRadius: 2,
      },
      {
        label: 'p90',
        data: history.map((point) => point.p90),
        borderColor: '#ff9800',
        backgroundColor: 'rgba(255, 152, 0, 0.1)',
        tension: 0.3,
        pointRadius: 2,
      },
      {
        label: 'p99',
        data: history.map((point) => point.p99),
        borderColor: '#f44336',
        backgroundColor: 'rgba(244, 67, 54, 0.1)',
        tension: 0.3,
        pointRadius: 2,
      },
    ],
  };
}

const chartOptions = {
  responsive: true,
  plugins: {
    legend: { position: 'top' },
    title: { display: false },
    tooltip: {
      callbacks: {
        label: (context) => `${context.dataset.label}: ${formatStroops(context.parsed.y)} stroops`,
      },
    },
  },
  scales: {
    y: {
      beginAtZero: false,
      title: { display: true, text: 'Fee (stroops)' },
    },
    x: {
      title: { display: true, text: 'Time (rolling 24h buffer, sampled every 30s)' },
    },
  },
};

function FeeStatCard({ label, value, highlight }) {
  return (
    <div className={`fee-stat-card${highlight ? ' fee-stat-card--highlight' : ''}`}>
      <h3>{label}</h3>
      <div className="fee-stat-value">
        {formatStroops(value)} <span className="unit">stroops</span>
      </div>
    </div>
  );
}

export default function FeeStatsPanel() {
  const { data, history, loading, error, refresh } = useFeeStats();

  const chartData = useMemo(() => buildChartData(history), [history]);

  const isElevated = useMemo(() => {
    if (!data) return false;
    const p90 = data.feeCharged?.p90;
    const currentFee = data.lastLedgerBaseFee;
    if (p90 === undefined || p90 === null || currentFee === undefined) return false;
    return currentFee >= p90;
  }, [data]);

  return (
    <section className="fee-stats-panel">
      <div className="fee-stats-header">
        <h2>Real-Time Network Fees</h2>
        <button
          className="refresh-button"
          onClick={refresh}
          disabled={loading}
          aria-label="Refresh fee stats"
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div className="fee-stats-error" role="alert">
          Failed to load fee stats: {error}
        </div>
      )}

      {isElevated && (
        <div className="fee-recommendation-banner" role="alert">
          <span className="fee-recommendation-icon">⚠️</span>
          <span>
            Fees are elevated — the current base fee is at or above the p90 threshold.
            Consider waiting before deploying.
          </span>
        </div>
      )}

      {loading && !data && <div className="loading">Loading fee stats...</div>}

      {data && (
        <>
          <div className="fee-stats-grid">
            <FeeStatCard label="Current Base Fee" value={data.lastLedgerBaseFee} highlight={isElevated} />
            <FeeStatCard label="p50 (Median)" value={data.feeCharged?.p50} />
            <FeeStatCard label="p70 (~p75)" value={data.feeCharged?.p70} />
            <FeeStatCard label="p99" value={data.feeCharged?.p99} />
          </div>

          <div className="chart-container">
            <h2>24h Fee Trend</h2>
            {history.length > 1 ? (
              <Line data={chartData} options={chartOptions} />
            ) : (
              <div className="fee-stats-empty">
                Collecting samples — the trend chart fills in as the dashboard polls
                Horizon every 30 seconds. Horizon's fee_stats endpoint has no
                historical API, so this chart is built from snapshots accumulated
                client-side.
              </div>
            )}
          </div>

          <div className="fee-stats-meta">
            Last updated: {format(new Date(data.fetchedAt), 'MMM dd, yyyy HH:mm:ss')} · Ledger{' '}
            {data.lastLedger} · Capacity usage{' '}
            {(data.ledgerCapacityUsage * 100).toFixed(1)}%
          </div>
        </>
      )}
    </section>
  );
}
