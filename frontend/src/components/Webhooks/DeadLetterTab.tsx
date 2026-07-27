import React, { useEffect, useState, useCallback } from 'react';
import { webhookApi, DeadLetterEntry } from '../../services/webhookApi';
import { Spinner } from '../UI/Spinner';
import { Button } from '../UI/Button';
import { ConfirmDialog } from '../UI/ConfirmDialog';
import { CheckCircle } from 'lucide-react';

interface DeadLetterTabProps {
  subscriptionId: string;
}

export function DeadLetterTab({ subscriptionId }: DeadLetterTabProps) {
  const [entries, setEntries] = useState<DeadLetterEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [confirmingAction, setConfirmingAction] = useState<'retry' | 'discard' | null>(null);
  const [processingId, setProcessingId] = useState<string | null>(null);

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    try {
      const data = await webhookApi.getDeadLetters(subscriptionId);
      setEntries(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dead-letter entries');
    } finally {
      setLoading(false);
    }
  }, [subscriptionId]);

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  const handleRetry = async () => {
    if (!confirmingId) return;
    setProcessingId(confirmingId);
    try {
      await webhookApi.retryDeadLetter(confirmingId);
      setEntries(prev => prev.filter(e => e.id !== confirmingId));
      setConfirmingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to retry dead-letter');
    } finally {
      setProcessingId(null);
    }
  };

  const handleDiscard = async () => {
    if (!confirmingId) return;
    setProcessingId(confirmingId);
    try {
      await webhookApi.discardDeadLetter(confirmingId);
      setEntries(prev => prev.filter(e => e.id !== confirmingId));
      setConfirmingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to discard dead-letter');
    } finally {
      setProcessingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 text-center text-red-600">
        <p>{error}</p>
        <button
          onClick={fetchEntries}
          className="mt-2 text-sm text-blue-600 hover:underline"
        >
          Try again
        </button>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="p-12 text-center text-gray-500">
        <CheckCircle className="w-12 h-12 text-green-300 mx-auto mb-4" />
        <p>No dead-letter entries. All webhooks are being delivered successfully!</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Event Type
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Failure Reason
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Attempts
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Last Attempt
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {entries.map((entry) => (
            <tr key={entry.id} className="hover:bg-gray-50">
              <td className="px-6 py-4 whitespace-nowrap">
                <span className="text-sm text-gray-900 font-mono">
                  {entry.event}
                </span>
              </td>
              <td className="px-6 py-4 text-sm text-gray-500 max-w-xs truncate">
                {entry.lastError || 'Unknown error'}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 text-center">
                {entry.attemptCount}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                {new Date(entry.updatedAt).toLocaleString()}
              </td>
              <td className="px-6 py-4 whitespace-nowrap">
                <div className="flex gap-2">
                    <Button
                    size="sm"
                    variant="primary"
                    onClick={() => {
                      setConfirmingId(entry.id);
                      setConfirmingAction('retry');
                    }}
                    disabled={processingId === entry.id}
                    className="text-xs"
                  >
                    Retry
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setConfirmingId(entry.id);
                      setConfirmingAction('discard');
                    }}
                    disabled={processingId === entry.id}
                    className="text-xs"
                  >
                    Discard
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <ConfirmDialog
        isOpen={confirmingAction === 'retry' && confirmingId !== null}
        title="Retry Dead-Letter Delivery?"
        message="This will attempt to deliver the webhook again with the original payload."
        confirmText="Retry"
        action="custom"
        onConfirm={handleRetry}
        onClose={() => {
          setConfirmingId(null);
          setConfirmingAction(null);
        }}
      />

      <ConfirmDialog
        isOpen={confirmingAction === 'discard' && confirmingId !== null}
        title="Discard Dead-Letter Entry?"
        message="This will mark the entry as skipped and remove it from the queue. This action cannot be undone."
        confirmText="Discard"
        confirmButtonVariant="danger"
        action="custom"
        onConfirm={handleDiscard}
        onClose={() => {
          setConfirmingId(null);
          setConfirmingAction(null);
        }}
      />
    </div>
  );
}
