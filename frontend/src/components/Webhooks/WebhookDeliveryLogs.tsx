import React, { useEffect, useState, useCallback } from 'react';
import { CheckCircle, XCircle, AlertTriangle, ShieldCheck, ShieldAlert, HelpCircle } from 'lucide-react';
import { webhookApi, WebhookDeliveryLog, WebhookDeliveryVerification } from '../../services/webhookApi';
import { Spinner } from '../UI/Spinner';
import { Tooltip } from '../UI/Tooltip';

interface WebhookDeliveryLogsProps {
    subscriptionId: string;
}

const SIGNATURE_VERIFICATION_DOC_URL =
    'https://github.com/Emmyt24/nova-launch/blob/main/docs/WEBHOOK_SIGNATURE_VERIFICATION.md';

type VerificationState =
    | { status: 'loading' }
    | { status: 'error' }
    | { status: 'done'; result: WebhookDeliveryVerification };

export function WebhookDeliveryLogs({ subscriptionId }: WebhookDeliveryLogsProps) {
    const [logs, setLogs] = useState<WebhookDeliveryLog[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [verifications, setVerifications] = useState<Record<string, VerificationState>>({});

    const fetchLogs = useCallback(async () => {
        setLoading(true);
        try {
            const data = await webhookApi.getLogs(subscriptionId);
            setLogs(data);
            setError(null);

            setVerifications(
                Object.fromEntries(data.map((log) => [log.id, { status: 'loading' } as VerificationState]))
            );

            await Promise.allSettled(
                data.map(async (log) => {
                    try {
                        const result = await webhookApi.getDeliveryVerification(log.id);
                        setVerifications((prev) => ({ ...prev, [log.id]: { status: 'done', result } }));
                    } catch {
                        setVerifications((prev) => ({ ...prev, [log.id]: { status: 'error' } }));
                    }
                })
            );
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load delivery logs');
        } finally {
            setLoading(false);
        }
    }, [subscriptionId]);

    useEffect(() => {
        fetchLogs();
    }, [fetchLogs]);

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
                    onClick={fetchLogs}
                    className="mt-2 text-sm text-blue-600 hover:underline"
                >
                    Try again
                </button>
            </div>
        );
    }

    if (logs.length === 0) {
        return (
            <div className="p-12 text-center text-gray-500">
                <AlertTriangle className="w-12 h-12 text-gray-300 mx-auto mb-4" />
                <p>No delivery logs found for this subscription yet.</p>
            </div>
        );
    }

    return (
        <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                    <tr>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Status
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Event
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Attempts
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Time
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Response
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Signature
                        </th>
                    </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                    {logs.map((log) => (
                        <tr key={log.id} className="hover:bg-gray-50">
                            <td className="px-6 py-4 whitespace-nowrap">
                                <div className="flex items-center">
                                    {log.success ? (
                                        <CheckCircle className="w-5 h-5 text-green-500 mr-2" />
                                    ) : (
                                        <XCircle className="w-5 h-5 text-red-500 mr-2" />
                                    )}
                                    <span className={`text-sm font-medium ${log.success ? 'text-green-900' : 'text-red-900'}`}>
                                        {log.statusCode || 'Failed'}
                                    </span>
                                </div>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap">
                                <span className="text-sm text-gray-900 font-mono">
                                    {log.event}
                                </span>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 text-center">
                                {log.attempts}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                                {new Date(log.createdAt).toLocaleString()}
                            </td>
                            <td className="px-6 py-4 text-sm text-gray-500 max-w-xs truncate">
                                {log.success ? 'OK' : (log.errorMessage || 'Unknown Error')}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap">
                                <VerificationBadge state={verifications[log.id]} />
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function VerificationBadge({ state }: { state: VerificationState | undefined }) {
    if (!state || state.status === 'loading') {
        return <Spinner size="sm" />;
    }

    if (state.status === 'error') {
        return <span className="text-xs text-gray-400">Verification unavailable</span>;
    }

    const { verified, keyId, algorithm } = state.result;

    return (
        <div className="flex items-center gap-1.5">
            <Tooltip
                content={`${algorithm} — recomputed server-side from the stored payload and the subscription's current signing key.`}
            >
                <span
                    className={`inline-flex items-center text-xs font-medium ${verified ? 'text-green-700' : 'text-red-700'}`}
                >
                    {verified ? (
                        <ShieldCheck className="w-4 h-4 mr-1" />
                    ) : (
                        <ShieldAlert className="w-4 h-4 mr-1" />
                    )}
                    {verified ? 'Verified' : 'Unverified'}
                </span>
            </Tooltip>
            <span className="text-xs text-gray-400 font-mono">key …{keyId}</span>
            <a
                href={SIGNATURE_VERIFICATION_DOC_URL}
                target="_blank"
                rel="noopener noreferrer"
                title="How to verify this signature independently"
                aria-label="How to verify this signature independently"
                className="text-gray-400 hover:text-gray-600"
            >
                <HelpCircle className="w-3.5 h-3.5" />
            </a>
        </div>
    );
}
