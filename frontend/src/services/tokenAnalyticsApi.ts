/**
 * Token Analytics API client.
 *
 * REST:   GET /api/tokens/:address/stats
 * GraphQL: burnRecords field
 */

import { apiClient } from './apiClient';
import type { Granularity } from '../components/TokenAnalytics/GranularityToggle';
import type { TimeRange } from '../components/TokenAnalytics/TimeRangeSelector';

export interface TokenStats {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string;
  /** Supply over time snapshots — each point represents a ledger close */
  supplyHistory: Array<{ timestamp: number; supply: string }>;
  burnCount: number;
  totalBurned: string;
  burnerCount: number;
  dailyBurnVolume: string;
  weeklyBurnVolume: string;
  monthlyBurnVolume: string;
  burnTrend: number;
}

export interface BurnRecord {
  id: string;
  timestamp: number; // Unix seconds
  from: string;
  amount: string;
  isAdminBurn: boolean;
  txHash: string;
}

const GQL_ENDPOINT =
  (import.meta as any)?.env?.VITE_GRAPHQL_URL ?? '/api/graphql';

const BURN_RECORDS_QUERY = `
  query BurnRecords($address: String!, $startTime: Int, $endTime: Int, $granularity: String) {
    burnRecords(tokenAddress: $address, startTime: $startTime, endTime: $endTime, granularity: $granularity) {
      id
      timestamp
      from
      amount
      isAdminBurn
      txHash
    }
  }
`;

export async function fetchTokenStats(address: string): Promise<TokenStats> {
  return apiClient.get<TokenStats>(`/api/tokens/${address}/stats`);
}

interface BurnRecordsOptions {
  startDate?: string; // ISO date YYYY-MM-DD
  endDate?: string;
  granularity?: Granularity;
}

export async function fetchBurnRecords(
  address: string,
  options?: BurnRecordsOptions
): Promise<BurnRecord[]> {
  const variables: Record<string, unknown> = { address };

  if (options?.startDate) {
    variables.startTime = Math.floor(new Date(options.startDate).getTime() / 1000);
  }
  if (options?.endDate) {
    variables.endTime = Math.floor(new Date(options.endDate).getTime() / 1000);
  }
  if (options?.granularity) {
    variables.granularity = options.granularity;
  }

  const res = await apiClient.post<{ data: { burnRecords: BurnRecord[] } }>(
    GQL_ENDPOINT,
    { query: BURN_RECORDS_QUERY, variables }
  );
  return res.data.burnRecords;
}
