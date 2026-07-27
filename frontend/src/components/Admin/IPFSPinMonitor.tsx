/**
 * IPFSPinMonitor (#1403)
 *
 * Admin dashboard section showing the current pin status of every tracked
 * IPFS CID: pin status, last checked time, and failure count. Rows are
 * color-coded so operators can spot trouble at a glance, and a "Re-Pin"
 * button lets an operator manually trigger a re-pin attempt for a failing
 * CID. The table auto-refreshes every 30 seconds.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '../../services/apiClient';

const AUTO_REFRESH_INTERVAL_MS = 30_000;

export type PinHealthStatus = 'pinned' | 'warning' | 'failed';

export interface IPFSPinRecord {
  cid: string;
  tokenName: string | null;
  tokenAddress: string | null;
  pinned: boolean;
  failureCount: number;
  lastChecked: string | null;
  error: string | null;
  status: PinHealthStatus;
  createdAt: string;
  updatedAt: string;
}

interface PinsResponse {
  success: boolean;
  data?: { pins: IPFSPinRecord[]; total: number };
  error?: { code: string; message: string };
}

interface RePinResponse {
  success: boolean;
  data?: Partial<IPFSPinRecord> & { message?: string };
  error?: { code: string; message: string };
}

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; pins: IPFSPinRecord[]; loadedAt: number }
  | { status: 'error'; message: string };

/** Row background/text classes per the failure-count thresholds in the issue. */
function rowClasses(status: PinHealthStatus): string {
  switch (status) {
    case 'pinned':
      return 'bg-green-50 hover:bg-green-100';
    case 'warning':
      return 'bg-yellow-50 hover:bg-yellow-100';
    case 'failed':
      return 'bg-red-50 hover:bg-red-100';
    default:
      return '';
  }
}

function statusBadgeClasses(status: PinHealthStatus): string {
  switch (status) {
    case 'pinned':
      return 'bg-green-100 text-green-800';
    case 'warning':
      return 'bg-yellow-100 text-yellow-800';
    case 'failed':
      return 'bg-red-100 text-red-800';
    default:
      return 'bg-gray-100 text-gray-700';
  }
}

function statusLabel(status: PinHealthStatus): string {
  switch (status) {
    case 'pinned':
      return 'Pinned';
    case 'warning':
      return 'Warning';
    case 'failed':
      return 'Failed';
    default:
      return 'Unknown';
  }
}

function formatLastChecked(value: string | null): string {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Never';
  return date.toLocaleString();
}

interface Props {
  /** Override the auto-refresh interval (mainly for tests). */
  refreshIntervalMs?: number;
}

export function IPFSPinMonitor({ refreshIntervalMs = AUTO_REFRESH_INTERVAL_MS }: Props = {}) {
  const [loadState, setLoadState] = useState<LoadState>({ status: 'idle' });
  const [rePinningCid, setRePinningCid] = useState<string | null>(null);
  const [rePinMessage, setRePinMessage] = useState<{ cid: string; text: string; isError: boolean } | null>(
    null
  );
  const isMountedRef = useRef(true);

  const loadPins = useCallback(async (showSpinner = true) => {
    if (showSpinner) setLoadState({ status: 'loading' });
    try {
      const res = await apiClient.get<PinsResponse>('/api/admin/ipfs/pins');
      if (!isMountedRef.current) return;
      if (!res.success || !res.data) {
        throw new Error(res.error?.message ?? 'Failed to load IPFS pin status');
      }
      setLoadState({ status: 'loaded', pins: res.data.pins, loadedAt: Date.now() });
    } catch (err) {
      if (!isMountedRef.current) return;
      setLoadState({
        status: 'error',
        message: err instanceof Error ? err.message : 'Unknown error loading IPFS pin status',
      });
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    loadPins();

    const interval = setInterval(() => {
      loadPins(false);
    }, refreshIntervalMs);

    return () => {
      isMountedRef.current = false;
      clearInterval(interval);
    };
  }, [loadPins, refreshIntervalMs]);

  const handleRePin = useCallback(
    async (cid: string) => {
      setRePinningCid(cid);
      setRePinMessage(null);
      try {
        const res = await apiClient.post<RePinResponse>(`/api/admin/ipfs/re-pin/${encodeURIComponent(cid)}`);
        if (!res.success) {
          throw new Error(res.error?.message ?? 'Re-pin failed');
        }
        setRePinMessage({
          cid,
          text: res.data?.message ?? 'Re-pin triggered successfully',
          isError: false,
        });
        // Refresh the table to reflect the updated pin record.
        await loadPins(false);
      } catch (err) {
        setRePinMessage({
          cid,
          text: err instanceof Error ? err.message : 'Re-pin failed',
          isError: true,
        });
      } finally {
        setRePinningCid(null);
      }
    },
    [loadPins]
  );

  return (
    <div className="bg-white rounded-lg shadow-md border border-gray-200">
      <div className="px-6 py-4 border-b border-gray-200 flex items-center gap-2">
        <span className="text-lg">📌</span>
        <h3 className="text-lg font-semibold text-gray-900">IPFS Pins</h3>
        <span className="ml-auto text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">
          Auto-refreshes every 30s
        </span>
      </div>

      <div className="p-6">
        {loadState.status === 'loaded' && (
          <p className="text-xs text-gray-400 mb-3">
            Last refreshed: {new Date(loadState.loadedAt).toLocaleTimeString()}
          </p>
        )}

        {loadState.status === 'loading' && (
          <div className="animate-pulse space-y-2">
            <div className="h-4 bg-gray-100 rounded w-full" />
            <div className="h-4 bg-gray-100 rounded w-full" />
            <div className="h-4 bg-gray-100 rounded w-3/4" />
          </div>
        )}

        {loadState.status === 'error' && (
          <div role="alert" className="rounded-lg border border-red-300 bg-red-50 px-5 py-4 flex items-start gap-3">
            <span className="text-red-500 text-lg">⚠️</span>
            <div>
              <p className="text-sm font-semibold text-red-800">Failed to load IPFS pin status</p>
              <p className="text-xs text-red-600 mt-1">{loadState.message}</p>
              <button
                onClick={() => loadPins()}
                className="mt-2 text-xs text-red-700 underline hover:no-underline"
              >
                Try again
              </button>
            </div>
          </div>
        )}

        {loadState.status === 'loaded' && (
          <>
            {loadState.pins.length === 0 ? (
              <p className="text-sm text-gray-400 italic">No CIDs are currently tracked.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs font-medium text-gray-500 uppercase tracking-wide border-b border-gray-200">
                      <th className="py-2 pr-4">CID</th>
                      <th className="py-2 pr-4">Token</th>
                      <th className="py-2 pr-4">Status</th>
                      <th className="py-2 pr-4">Last Checked</th>
                      <th className="py-2 pr-4">Failures</th>
                      <th className="py-2 pr-4">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loadState.pins.map((pin) => (
                      <tr
                        key={pin.cid}
                        data-testid={`pin-row-${pin.cid}`}
                        data-status={pin.status}
                        className={`border-b border-gray-100 ${rowClasses(pin.status)}`}
                      >
                        <td className="py-2 pr-4 font-mono text-xs break-all" title={pin.cid}>
                          {pin.cid}
                        </td>
                        <td className="py-2 pr-4">{pin.tokenName ?? <span className="text-gray-400 italic">—</span>}</td>
                        <td className="py-2 pr-4">
                          <span
                            className={`text-xs font-semibold px-2 py-0.5 rounded-full ${statusBadgeClasses(
                              pin.status
                            )}`}
                          >
                            {statusLabel(pin.status)}
                          </span>
                        </td>
                        <td className="py-2 pr-4 text-xs text-gray-600">{formatLastChecked(pin.lastChecked)}</td>
                        <td className="py-2 pr-4 text-xs font-mono">{pin.failureCount}</td>
                        <td className="py-2 pr-4">
                          <button
                            onClick={() => handleRePin(pin.cid)}
                            disabled={rePinningCid === pin.cid}
                            className="text-xs px-3 py-1.5 rounded border border-blue-300 text-blue-700 bg-blue-50 hover:bg-blue-100 font-medium transition-colors disabled:opacity-50"
                          >
                            {rePinningCid === pin.cid ? 'Re-Pinning…' : 'Re-Pin'}
                          </button>
                          {rePinMessage && rePinMessage.cid === pin.cid && (
                            <p
                              className={`text-xs mt-1 ${
                                rePinMessage.isError ? 'text-red-600' : 'text-green-700'
                              }`}
                            >
                              {rePinMessage.text}
                            </p>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default IPFSPinMonitor;
