import React, { useState, useEffect, useCallback } from 'react';
import { Flame, Hash, Users, Layers, Download, AlertCircle, RefreshCw } from 'lucide-react';
import { Card } from '../UI/Card';
import { StatCard, StatCardSkeleton } from './StatCard';
import { exportToCsv, truncateAddress, formatTokenAmount } from './utils';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TopBurner {
  walletAddress: string;
  totalBurned: string;
  burnCount: number;
}

export interface TokenBurnSummary {
  tokenAddress: string;
  totalBurned: string;
  burnCount: number;
  uniqueBurners: number;
}

export interface BurnRateTrendPoint {
  date: string;
  volume: string;
  count: number;
}

export interface AggregateBurnData {
  generatedAt: string;
  startDate: string;
  endDate: string;
  totalBurnedAllTokens: string;
  totalBurnCount: number;
  totalUniqueTokens: number;
  totalUniqueBurners: number;
  burnRateTrend: BurnRateTrendPoint[];
  top5Burners: TopBurner[];
  tokenSummaries: TokenBurnSummary[];
}

interface DateRange {
  startDate: string;
  endDate: string;
}

// ─── Mock service (mirrors BurnStatistics mock pattern) ───────────────────────

const mockAggregateService = {
  getAggregateBurnStats: async (_range: DateRange): Promise<AggregateBurnData> => {
    await new Promise((resolve) => setTimeout(resolve, 900));
    const now = new Date();
    const trend: BurnRateTrendPoint[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      trend.push({
        date: d.toISOString().split('T')[0],
        volume: String(Math.floor(Math.random() * 5_000_000_000_000) + 500_000_000_000),
        count: Math.floor(Math.random() * 15) + 1,
      });
    }
    return {
      generatedAt: now.toISOString(),
      startDate: new Date(now.getTime() - 7 * 86_400_000).toISOString(),
      endDate: now.toISOString(),
      totalBurnedAllTokens: '72500000000000',
      totalBurnCount: 214,
      totalUniqueTokens: 8,
      totalUniqueBurners: 63,
      burnRateTrend: trend,
      top5Burners: [
        { walletAddress: 'GABC1234567890DEFGHIJKLMNOPQRSTUVWXYZ123456', totalBurned: '18000000000000', burnCount: 42 },
        { walletAddress: 'GXYZ9876543210ABCDEFGHIJKLMNOPQRSTUVWXYZ99', totalBurned: '12500000000000', burnCount: 31 },
        { walletAddress: 'GQRS4567891234MNOPQRSTUVWXYZ123456789ABCDE', totalBurned: '9800000000000', burnCount: 27 },
        { walletAddress: 'GLMN1111222233ABCDEFGHIJKLMNOPQRSTUVWXYZAA', totalBurned: '7600000000000', burnCount: 19 },
        { walletAddress: 'GTUV5555666677ABCDEFGHIJKLMNOPQRSTUVWXYZBB', totalBurned: '5200000000000', burnCount: 14 },
      ],
      tokenSummaries: [
        { tokenAddress: 'GCQRS111NOVA', totalBurned: '30000000000000', burnCount: 88, uniqueBurners: 24 },
        { tokenAddress: 'GABC222STAR', totalBurned: '22000000000000', burnCount: 65, uniqueBurners: 19 },
        { tokenAddress: 'GXYZ333MOON', totalBurned: '14000000000000', burnCount: 40, uniqueBurners: 13 },
        { tokenAddress: 'GLMN444FIRE', totalBurned: '6500000000000', burnCount: 21, uniqueBurners: 7 },
      ],
    };
  },
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function BurnRateChart({ trend }: { trend: BurnRateTrendPoint[] }) {
  if (trend.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-gray-400 text-sm">
        No trend data available
      </div>
    );
  }

  const volumes = trend.map((p) => Number(p.volume));
  const maxVolume = Math.max(...volumes, 1);

  return (
    <div className="mt-4">
      <div className="flex items-end gap-1 h-32">
        {trend.map((point, i) => {
          const heightPct = (Number(point.volume) / maxVolume) * 100;
          return (
            <div key={i} className="flex-1 flex flex-col items-center gap-1 group relative">
              <div
                className="w-full bg-gradient-to-t from-orange-500 to-red-400 rounded-t transition-all duration-300 hover:from-orange-600 hover:to-red-500"
                style={{ height: `${Math.max(heightPct, 2)}%` }}
              />
              <span className="text-xs text-gray-400 rotate-45 origin-left whitespace-nowrap overflow-hidden w-6">
                {point.date.slice(5)}
              </span>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-gray-400 mt-2 text-center">7-day rolling burn volume</p>
    </div>
  );
}

function Top5BurnersTable({ burners, decimals }: { burners: TopBurner[]; decimals: number }) {
  if (burners.length === 0) {
    return <p className="text-sm text-gray-500 py-4 text-center">No burner data available</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500 border-b border-gray-200">
            <th className="pb-2 pr-4 font-medium">Rank</th>
            <th className="pb-2 pr-4 font-medium">Wallet</th>
            <th className="pb-2 pr-4 font-medium">Total Burned</th>
            <th className="pb-2 font-medium">Burns</th>
          </tr>
        </thead>
        <tbody>
          {burners.map((b, i) => (
            <tr key={b.walletAddress} className="border-b border-gray-100 hover:bg-gray-50">
              <td className="py-2 pr-4">
                <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${
                  i === 0 ? 'bg-yellow-100 text-yellow-700' :
                  i === 1 ? 'bg-gray-100 text-gray-600' :
                  i === 2 ? 'bg-orange-100 text-orange-700' :
                  'bg-gray-50 text-gray-500'
                }`}>
                  {i + 1}
                </span>
              </td>
              <td className="py-2 pr-4 font-mono text-gray-700">
                {truncateAddress(b.walletAddress)}
              </td>
              <td className="py-2 pr-4 font-medium text-gray-900">
                {formatTokenAmount(b.totalBurned, decimals)}
              </td>
              <td className="py-2 text-gray-600">{b.burnCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Main Component ────────────────────────────────────────────────────────────

interface CrossTokenSummaryTabProps {
  decimals?: number;
  symbol?: string;
}

export function CrossTokenSummaryTab({
  decimals = 0,
  symbol = '',
}: CrossTokenSummaryTabProps) {
  const today = new Date().toISOString().split('T')[0];
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().split('T')[0];

  const [dateRange, setDateRange] = useState<DateRange>({
    startDate: sevenDaysAgo,
    endDate: today,
  });
  const [data, setData] = useState<AggregateBurnData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (range: DateRange, isRefresh = false) => {
    if (isRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);
    try {
      const result = await mockAggregateService.getAggregateBurnStats(range);
      setData(result);
    } catch {
      setError('Failed to load aggregate burn statistics. Please try again.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load(dateRange);
  }, [load, dateRange]);

  const handleDateChange = (field: keyof DateRange, value: string) => {
    setDateRange((prev) => ({ ...prev, [field]: value }));
  };

  const handleExportTokenSummaries = () => {
    if (!data) return;
    exportToCsv(
      data.tokenSummaries as unknown as Record<string, unknown>[],
      `burn-summary-${dateRange.startDate}-${dateRange.endDate}`,
      [
        { key: 'tokenAddress' as never, label: 'Token Address' },
        { key: 'totalBurned' as never, label: 'Total Burned' },
        { key: 'burnCount' as never, label: 'Burn Count' },
        { key: 'uniqueBurners' as never, label: 'Unique Burners' },
      ]
    );
  };

  const handleExportTopBurners = () => {
    if (!data) return;
    exportToCsv(
      data.top5Burners as unknown as Record<string, unknown>[],
      `top-burners-${dateRange.startDate}-${dateRange.endDate}`,
      [
        { key: 'walletAddress' as never, label: 'Wallet Address' },
        { key: 'totalBurned' as never, label: 'Total Burned' },
        { key: 'burnCount' as never, label: 'Burn Count' },
      ]
    );
  };

  // ── Loading skeleton ──────────────────────────────────────────────────────
  if (loading) {
    return (
      <div data-testid="cross-token-loading">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          {[...Array(4)].map((_, i) => <StatCardSkeleton key={i} />)}
        </div>
        <div className="h-48 bg-gray-100 rounded-lg animate-pulse mb-6" />
        <div className="h-48 bg-gray-100 rounded-lg animate-pulse" />
      </div>
    );
  }

  // ── Error ─────────────────────────────────────────────────────────────────
  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center" data-testid="cross-token-error">
        <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
        <h3 className="text-lg font-semibold text-red-800 mb-2">Error Loading Data</h3>
        <p className="text-red-600 mb-4">{error}</p>
        <button
          onClick={() => load(dateRange, true)}
          className="inline-flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          Try Again
        </button>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div data-testid="cross-token-summary">
      {/* Controls row */}
      <div className="flex flex-wrap items-end gap-4 mb-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">From</label>
          <input
            type="date"
            value={dateRange.startDate}
            max={dateRange.endDate}
            onChange={(e) => handleDateChange('startDate', e.target.value)}
            className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-400"
            data-testid="start-date-input"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">To</label>
          <input
            type="date"
            value={dateRange.endDate}
            min={dateRange.startDate}
            onChange={(e) => handleDateChange('endDate', e.target.value)}
            className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-400"
            data-testid="end-date-input"
          />
        </div>
        <button
          onClick={() => load(dateRange, true)}
          disabled={refreshing}
          className="inline-flex items-center gap-2 px-4 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {/* Aggregate stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard
          title="Total Burned (All Tokens)"
          value={`${formatTokenAmount(data.totalBurnedAllTokens, decimals)} ${symbol}`}
          icon={<Flame className="w-6 h-6" />}
          subtitle="Across all managed tokens"
        />
        <StatCard
          title="Total Burns"
          value={data.totalBurnCount.toLocaleString()}
          icon={<Hash className="w-6 h-6" />}
          subtitle="Transactions in period"
        />
        <StatCard
          title="Tokens Tracked"
          value={data.totalUniqueTokens.toLocaleString()}
          icon={<Layers className="w-6 h-6" />}
          subtitle="Unique token contracts"
        />
        <StatCard
          title="Unique Burners"
          value={data.totalUniqueBurners.toLocaleString()}
          icon={<Users className="w-6 h-6" />}
          subtitle="Distinct wallet addresses"
        />
      </div>

      {/* Burn rate trend */}
      <Card title="Burn Rate Trend (7-Day Rolling)" className="mb-6">
        <BurnRateChart trend={data.burnRateTrend} />
      </Card>

      {/* Top 5 burners */}
      <Card className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-gray-900">Top 5 Burners by Wallet</h3>
          <button
            onClick={handleExportTopBurners}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-orange-600 border border-orange-300 rounded-lg hover:bg-orange-50 transition-colors"
            data-testid="export-top-burners-btn"
          >
            <Download className="w-4 h-4" />
            Export CSV
          </button>
        </div>
        <Top5BurnersTable burners={data.top5Burners} decimals={decimals} />
      </Card>

      {/* Per-token summary table */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-gray-900">Per-Token Burn Summary</h3>
          <button
            onClick={handleExportTokenSummaries}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-orange-600 border border-orange-300 rounded-lg hover:bg-orange-50 transition-colors"
            data-testid="export-token-summaries-btn"
          >
            <Download className="w-4 h-4" />
            Export CSV
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="token-summaries-table">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-200">
                <th className="pb-2 pr-4 font-medium">Token Address</th>
                <th className="pb-2 pr-4 font-medium">Total Burned</th>
                <th className="pb-2 pr-4 font-medium">Burn Count</th>
                <th className="pb-2 font-medium">Unique Burners</th>
              </tr>
            </thead>
            <tbody>
              {data.tokenSummaries.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-6 text-center text-gray-500">
                    No token data available for this period
                  </td>
                </tr>
              ) : (
                data.tokenSummaries.map((t) => (
                  <tr key={t.tokenAddress} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="py-2 pr-4 font-mono text-gray-700">
                      {truncateAddress(t.tokenAddress, 8, 6)}
                    </td>
                    <td className="py-2 pr-4 font-medium text-gray-900">
                      {formatTokenAmount(t.totalBurned, decimals)}
                    </td>
                    <td className="py-2 pr-4 text-gray-600">{t.burnCount}</td>
                    <td className="py-2 text-gray-600">{t.uniqueBurners}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {data.tokenSummaries.length > 0 && (
          <p className="mt-4 pt-4 border-t border-gray-200 text-xs text-gray-400">
            Showing {data.tokenSummaries.length} token{data.tokenSummaries.length !== 1 ? 's' : ''} •{' '}
            Generated {new Date(data.generatedAt).toLocaleString()}
          </p>
        )}
      </Card>
    </div>
  );
}

export default CrossTokenSummaryTab;
