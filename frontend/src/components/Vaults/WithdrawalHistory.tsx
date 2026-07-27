import React, { useEffect, useState } from 'react';
import { Button } from '../UI/Button';
import { Spinner } from '../UI/Spinner';
import type { PaginatedWithdrawals, WithdrawalRecord } from '../../services/vaultsApi';

interface WithdrawalHistoryProps {
  vaultId: number;
  onFetchWithdrawals: (vaultId: number, cursor?: string) => Promise<PaginatedWithdrawals>;
}

export function WithdrawalHistory({ vaultId, onFetchWithdrawals }: WithdrawalHistoryProps) {
  const [withdrawals, setWithdrawals] = useState<WithdrawalRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [prevCursor, setPrevCursor] = useState<string | undefined>();
  const [hasMore, setHasMore] = useState(false);

  const loadWithdrawals = async (cursor?: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await onFetchWithdrawals(vaultId, cursor);
      setWithdrawals(result.withdrawals);
      setNextCursor(result.nextCursor);
      setPrevCursor(result.prevCursor);
      setHasMore(result.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load withdrawal history');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadWithdrawals();
  }, [vaultId]);

  if (loading && withdrawals.length === 0) {
    return (
      <div className="flex justify-center py-8">
        <Spinner size="md" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
        <p className="text-sm text-red-700">{error}</p>
        <Button size="sm" variant="outline" onClick={() => loadWithdrawals()} className="mt-2">
          Retry
        </Button>
      </div>
    );
  }

  if (withdrawals.length === 0) {
    return (
      <div className="p-4 text-center text-gray-500">
        <p className="text-sm">No withdrawal history available.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Amount
              </th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Date
              </th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Tx Hash
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {withdrawals.map((withdrawal) => (
              <tr key={withdrawal.id} className="hover:bg-gray-50">
                <td className="px-4 py-2 whitespace-nowrap text-sm font-mono text-gray-900">
                  {withdrawal.amount}
                </td>
                <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500">
                  {new Date(withdrawal.timestamp).toLocaleString()}
                </td>
                <td className="px-4 py-2 whitespace-nowrap text-sm font-mono">
                  <a
                    href={`https://stellar.expert/explorer/testnet/tx/${withdrawal.txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline truncate max-w-xs block"
                    title={withdrawal.txHash}
                  >
                    {withdrawal.txHash.slice(0, 8)}…{withdrawal.txHash.slice(-8)}
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(nextCursor || prevCursor) && (
        <div className="flex gap-2 justify-center">
          {prevCursor && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => loadWithdrawals(prevCursor)}
              disabled={loading}
            >
              ← Previous
            </Button>
          )}
          {nextCursor && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => loadWithdrawals(nextCursor)}
              disabled={loading}
            >
              Next →
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
