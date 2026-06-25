/**
 * DeploymentRecoveryBanner - Detects and prompts for recovery of stuck deployments
 *
 * Renders when:
 * - A stale deployment checkpoint exists in localStorage
 * - User navigated away or page crashed mid-deployment
 *
 * Actions:
 * - Resume: Check deployment status and retry failed step
 * - Discard: Clear checkpoint and allow fresh deployment
 */

import React, { useEffect, useState } from 'react';
import { DeploymentRecoveryStorage, type DeploymentCheckpoint } from '../../services/DeploymentRecoveryStorage';
import { getDeploymentStatus, getConfirmationStep } from '../../services/deploymentStatusApi';
import { getErrorMessage } from '../../utils/errors';
import type { ConfirmationStep, ConfirmationStepResponse } from '../../types';

interface DeploymentRecoveryBannerProps {
  onResume: (checkpoint: DeploymentCheckpoint) => void;
  onDiscard: () => void;
}

const STEP_LABELS: Record<ConfirmationStep, string> = {
  submitted: 'Submitted',
  pending: 'Pending',
  confirming: 'Confirming',
  finalized: 'Finalized',
};

const STEP_ORDER: ConfirmationStep[] = ['submitted', 'pending', 'confirming', 'finalized'];

function StepIndicator({
  currentStep,
  confirmations,
  totalConfirmations,
}: {
  currentStep: ConfirmationStep;
  confirmations?: number;
  totalConfirmations?: number;
}) {
  const currentIndex = STEP_ORDER.indexOf(currentStep);

  return (
    <ol className="flex items-center gap-1 mt-3" aria-label="Confirmation progress">
      {STEP_ORDER.map((step, index) => {
        const isDone = index < currentIndex;
        const isActive = index === currentIndex;
        const isPending = index > currentIndex;

        return (
          <React.Fragment key={step}>
            <li className="flex flex-col items-center min-w-0">
              <div
                className={[
                  'w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border-2 shrink-0',
                  isDone
                    ? 'bg-green-500 border-green-500 text-white'
                    : isActive
                      ? 'bg-amber-500 border-amber-500 text-white animate-pulse'
                      : 'bg-white border-gray-300 text-gray-400',
                ].join(' ')}
                aria-current={isActive ? 'step' : undefined}
              >
                {isDone ? '✓' : index + 1}
              </div>
              <span
                className={[
                  'text-xs mt-0.5 text-center whitespace-nowrap',
                  isDone
                    ? 'text-green-700 font-medium'
                    : isActive
                      ? 'text-amber-700 font-semibold'
                      : 'text-gray-400',
                ].join(' ')}
              >
                {step === 'confirming' && isActive && confirmations !== undefined && totalConfirmations !== undefined
                  ? `${STEP_LABELS[step]} (${confirmations}/${totalConfirmations})`
                  : STEP_LABELS[step]}
              </span>
            </li>
            {index < STEP_ORDER.length - 1 && (
              <li
                aria-hidden="true"
                className={[
                  'flex-1 h-0.5 mt-[-0.75rem]',
                  index < currentIndex ? 'bg-green-400' : 'bg-gray-200',
                ].join(' ')}
              />
            )}
          </React.Fragment>
        );
      })}
    </ol>
  );
}

export function DeploymentRecoveryBanner({ onResume, onDiscard }: DeploymentRecoveryBannerProps) {
  const [checkpoint, setCheckpoint] = useState<DeploymentCheckpoint | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [confirmationInfo, setConfirmationInfo] = useState<ConfirmationStepResponse | null>(null);

  // On mount, check for stale checkpoint and try to load current confirmation step
  useEffect(() => {
    const staleCheckpoint = DeploymentRecoveryStorage.getStaleCheckpoint();
    setCheckpoint(staleCheckpoint);

    if (staleCheckpoint?.transactionHash) {
      getConfirmationStep(staleCheckpoint.transactionHash, staleCheckpoint.network)
        .then(setConfirmationInfo)
        .catch(() => {
          // Non-fatal: confirmation step info is best-effort
        });
    }
  }, []);

  if (!checkpoint) {
    return null; // No stale checkpoint, don't render
  }

  const handleResume = async () => {
    if (!checkpoint.transactionHash) {
      // IPFS uploaded but contract not yet submitted — resume the form
      onResume(checkpoint);
      return;
    }

    setStatusLoading(true);
    setStatusError(null);

    try {
      const status = await getDeploymentStatus(checkpoint.transactionHash, checkpoint.network);

      if (status.status === 'CONFIRMED') {
        DeploymentRecoveryStorage.clearCheckpoint();
        onResume(checkpoint);
        return;
      }

      if (status.status === 'FAILED') {
        setStatusError(
          `On-chain transaction failed: ${status.reason || 'Unknown error'}. ` +
          'Discard this deployment to try again.'
        );
        setStatusLoading(false);
        return;
      }

      // PENDING - still waiting; resume and let monitor continue polling
      onResume(checkpoint);
    } catch (error) {
      setStatusError(`Failed to check deployment status: ${getErrorMessage(error)}`);
      setStatusLoading(false);
    }
  };

  const handleDiscard = () => {
    DeploymentRecoveryStorage.clearCheckpoint();
    onDiscard();
  };

  return (
    <div className="mb-4 p-4 border-l-4 border-amber-500 bg-amber-50 rounded">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-amber-900">Incomplete Deployment Detected</h3>
          <p className="text-sm text-amber-800 mt-1">
            A previous deployment of <strong>{checkpoint.formData.symbol}</strong> didn't complete.
            Step: <code className="bg-amber-100 px-1 rounded">{checkpoint.step}</code>
          </p>

          {confirmationInfo && (
            <StepIndicator
              currentStep={confirmationInfo.step}
              confirmations={confirmationInfo.confirmations}
              totalConfirmations={confirmationInfo.totalConfirmations}
            />
          )}

          {statusError && (
            <p className="text-sm text-red-700 mt-2 font-medium">{statusError}</p>
          )}

          <div className="text-xs text-amber-700 mt-2 space-y-1">
            <p>Network: <code className="bg-amber-100 px-1">{checkpoint.network}</code></p>
            {checkpoint.transactionHash && (
              <p>Tx Hash: <code className="bg-amber-100 px-1 truncate">{checkpoint.transactionHash.slice(0, 20)}...</code></p>
            )}
          </div>
        </div>

        <div className="flex gap-2 ml-4 shrink-0">
          <button
            onClick={handleResume}
            disabled={statusLoading}
            className="px-3 py-1.5 text-sm font-medium rounded bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            {statusLoading ? 'Checking...' : 'Resume'}
          </button>
          <button
            onClick={handleDiscard}
            disabled={statusLoading}
            className="px-3 py-1.5 text-sm font-medium rounded bg-gray-200 text-gray-800 hover:bg-gray-300 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}
