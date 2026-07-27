import React, { useCallback, useEffect, useState } from 'react';
import { ExecuteStepButton } from './ExecuteStepButton';
import { useProjectionRefresh } from '../../hooks/useProjectionRefresh';
import {
  useCampaignStepSubscription,
  type CampaignStepExecutedEvent,
} from '../../hooks/useCampaignStepSubscription';
import { campaignApi } from '../../services/campaignApi';
import { getTxUrl } from '../../utils/explorer';
import { Skeleton } from '../UI/Skeleton';
import { estimateNextStepEtaMs, formatEta } from '../../utils/campaignStepEta';
import type { BuybackCampaignModel } from '../../types/campaign';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? '';
/** How long the just-completed step stays visually highlighted. */
const HIGHLIGHT_DURATION_MS = 2_000;

interface CampaignDashboardProps {
  campaignId: number;
  network?: 'testnet' | 'mainnet';
}

export const CampaignDashboard: React.FC<CampaignDashboardProps> = ({
  campaignId,
  network = (import.meta.env.VITE_NETWORK as 'testnet' | 'mainnet') ?? 'testnet',
}) => {
  const [campaign, setCampaign] = useState<BuybackCampaignModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // txHash of the most recently submitted step — drives projection polling
  const [pendingTxHash, setPendingTxHash] = useState<string | null>(null);

  const fetchCampaign = useCallback(async () => {
    try {
      setLoading(true);
      const response = await fetch(
        `${BACKEND_URL}/api/buyback/campaigns/${campaignId}`
      );
      if (!response.ok) throw new Error('Failed to fetch campaign');
      const data = await response.json();
      setCampaign({
        ...data,
        progressPercent:
          data.totalSteps > 0
            ? Math.min(100, (data.currentStep / data.totalSteps) * 100)
            : 0,
        isActive: data.status === 'ACTIVE',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    fetchCampaign();
  }, [fetchCampaign]);

  // Projection refresh — polls until the backend execution count advances
  const expectedExecutionCount = campaign ? campaign.currentStep + 1 : 0;
  const { status: projectionStatus, retry: retryProjection } = useProjectionRefresh({
    txHash: pendingTxHash,
    check: useCallback(async () => {
      const projection = await campaignApi.getById(campaignId);
      return projection.executionCount >= expectedExecutionCount;
    }, [campaignId, expectedExecutionCount]),
    onIndexed: useCallback(() => {
      setPendingTxHash(null);
      fetchCampaign();
    }, [fetchCampaign]),
  });

  const handleStepSuccess = useCallback((txHash: string) => {
    // Start projection polling — don't re-fetch immediately, wait for backend catch-up
    setPendingTxHash(txHash);
  }, []);

  const handleStepError = useCallback((err: Error) => {
    console.error('Step execution failed:', err);
    fetchCampaign();
  }, [fetchCampaign]);

  // Real-time step progression — independent of who triggered the execution
  // (this client or another operator), so it always refetches on delivery.
  const [highlightedStep, setHighlightedStep] = useState<number | null>(null);

  const handleStepExecuted = useCallback(
    (event: CampaignStepExecutedEvent) => {
      setHighlightedStep(event.stepNumber);
      fetchCampaign();
      setTimeout(() => setHighlightedStep(null), HIGHLIGHT_DURATION_MS);
    },
    [fetchCampaign]
  );

  useCampaignStepSubscription({
    campaignId,
    onStepExecuted: handleStepExecuted,
  });

  const nextStepEtaMs = campaign ? estimateNextStepEtaMs(campaign.steps) : null;

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto p-6 space-y-6" aria-label="Loading campaign">
        <div className="bg-white rounded-lg shadow-lg p-6">
          {/* Header row */}
          <div className="flex items-center justify-between mb-6">
            <Skeleton className="h-8" width="40%" />
            <Skeleton variant="rectangular" width={80} height={32} />
          </div>
          {/* Meta grid */}
          <div className="grid grid-cols-2 gap-4 mb-6">
            {[...Array(4)].map((_, i) => (
              <div key={i}>
                <Skeleton className="mb-1 h-3" width="50%" />
                <Skeleton width="70%" />
              </div>
            ))}
          </div>
          {/* Progress bar area */}
          <div className="mb-6">
            <div className="flex justify-between mb-2">
              <Skeleton width={60} />
              <Skeleton width={30} />
            </div>
            <Skeleton variant="rectangular" height={12} />
          </div>
          {/* Steps list */}
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} variant="rectangular" height={64} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error || !campaign) {
    return (
      <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
        <p className="text-red-800">{error || 'Campaign not found'}</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div className="bg-white rounded-lg shadow-lg p-6">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-bold text-gray-900">
            Buyback Campaign #{campaign.id}
          </h2>
          <span
            className={`px-4 py-2 rounded-full text-sm font-semibold ${
              campaign.status === 'ACTIVE'
                ? 'bg-green-100 text-green-800'
                : campaign.status === 'COMPLETED'
                ? 'bg-blue-100 text-blue-800'
                : 'bg-gray-100 text-gray-800'
            }`}
          >
            {campaign.status}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-4 mb-6">
          <div>
            <p className="text-sm text-gray-600">Token Address</p>
            <p className="font-mono text-sm break-all">{campaign.tokenAddress}</p>
          </div>
          <div>
            <p className="text-sm text-gray-600">Total Amount</p>
            <p className="font-semibold">{campaign.totalAmount}</p>
          </div>
          <div>
            <p className="text-sm text-gray-600">Executed Amount</p>
            <p className="font-semibold">{campaign.executedAmount}</p>
          </div>
          <div>
            <p className="text-sm text-gray-600">Progress</p>
            <p className="font-semibold">
              {campaign.currentStep} / {campaign.totalSteps} steps
            </p>
          </div>
        </div>

        <div className="mb-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-700">Progress</span>
            <span className="text-sm font-medium text-gray-700">
              {campaign.progressPercent.toFixed(0)}%
            </span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-3">
            <div
              className="bg-purple-600 h-3 rounded-full transition-all duration-500"
              style={{ width: `${campaign.progressPercent}%` }}
            />
          </div>
        </div>

        {campaign.isActive && (
          <div className="mb-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Current Step</h3>
              {nextStepEtaMs !== null && (
                <span className="text-sm text-gray-500">
                  Est. next step in {formatEta(nextStepEtaMs)}
                </span>
              )}
            </div>

            {/* Projection catch-up indicator */}
            {projectionStatus === 'polling' && (
              <div className="mb-3 flex items-center gap-2 text-sm text-blue-700 bg-blue-50 border border-blue-200 rounded-md px-4 py-2">
                <svg className="animate-spin h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Waiting for backend to index the transaction…
              </div>
            )}
            {projectionStatus === 'failed' && (
              <div className="mb-3 flex items-center justify-between text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-4 py-2">
                <span>⚠️ Backend sync timed out — data may be stale</span>
                <button
                  onClick={retryProjection}
                  className="ml-4 text-xs underline hover:no-underline"
                >
                  Retry
                </button>
              </div>
            )}

            <ExecuteStepButton
              campaignId={campaign.id}
              currentStep={campaign.currentStep}
              stepAmount={campaign.steps[campaign.currentStep]?.amount ?? '0'}
              status={campaign.status}
              onSuccess={handleStepSuccess}
              onError={handleStepError}
            />
          </div>
        )}

        <div>
          <h3 className="text-lg font-semibold mb-4">All Steps</h3>
          <div className="space-y-3">
            {campaign.steps.map((step) => (
              <div
                key={step.id}
                data-testid={`step-${step.stepNumber}`}
                className={`p-4 rounded-lg border-2 transition-all duration-500 ${
                  step.stepNumber === highlightedStep
                    ? 'bg-yellow-50 border-yellow-400 ring-2 ring-yellow-300 animate-pulse'
                    : step.status === 'COMPLETED'
                    ? 'bg-green-50 border-green-200'
                    : step.status === 'FAILED'
                    ? 'bg-red-50 border-red-200'
                    : step.stepNumber === campaign.currentStep
                    ? 'bg-blue-50 border-blue-300'
                    : 'bg-gray-50 border-gray-200'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold">
                      Step {step.stepNumber + 1}
                      {step.stepNumber === campaign.currentStep && (
                        <span className="ml-2 text-blue-600">(Current)</span>
                      )}
                    </p>
                    <p className="text-sm text-gray-600">Amount: {step.amount}</p>
                  </div>
                  <div className="text-right">
                    <span
                      className={`px-3 py-1 rounded-full text-xs font-semibold ${
                        step.status === 'COMPLETED'
                          ? 'bg-green-200 text-green-800'
                          : step.status === 'FAILED'
                          ? 'bg-red-200 text-red-800'
                          : 'bg-gray-200 text-gray-800'
                      }`}
                    >
                      {step.status}
                    </span>
                    {step.executedAt && (
                      <p className="text-xs text-gray-500 mt-1">
                        {new Date(step.executedAt).toLocaleString()}
                      </p>
                    )}
                  </div>
                </div>
                {step.txHash && (
                  <a
                    href={getTxUrl(step.txHash, network)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-600 hover:text-blue-800 underline mt-2 block"
                  >
                    View Transaction
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
