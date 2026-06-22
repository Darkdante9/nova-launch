/**
 * Governance Proposal Creation Form
 * Multi-step form for submitting on-chain governance proposals.
 * Steps: type selection → parameters → description → preview → submit
 */

import { useState } from 'react';
import DOMPurify from 'dompurify';
import { Card } from '../UI/Card';
import { Button } from '../UI/Button';
import { Spinner } from '../UI/Spinner';
import { truncateAddress } from '../../utils/formatting';
import { useGovernance } from '../../hooks/useGovernance';
import type { WalletState } from '../../types';

// ─── Constants ────────────────────────────────────────────────────────────────

export const PROPOSAL_TYPES = [
  {
    value: 'PARAMETER_CHANGE',
    label: 'Parameter Change',
    description: 'Modify on-chain protocol parameters such as fees or limits.',
  },
  {
    value: 'ADMIN_TRANSFER',
    label: 'Admin Transfer',
    description: 'Transfer admin authority to a new address.',
  },
  {
    value: 'TREASURY_SPEND',
    label: 'Treasury Spend',
    description: 'Authorize a treasury disbursement to a specified recipient.',
  },
  {
    value: 'CONTRACT_UPGRADE',
    label: 'Contract Upgrade',
    description: 'Upgrade the smart contract to a new implementation.',
  },
  {
    value: 'CUSTOM',
    label: 'Custom',
    description: 'A general-purpose proposal with arbitrary payload data.',
  },
] as const;

export type ProposalTypeValue = (typeof PROPOSAL_TYPES)[number]['value'];

/** Minimum voting period: 1 day in seconds */
export const MIN_VOTING_PERIOD_SECONDS = 86_400;
/** Maximum voting period: 30 days in seconds */
export const MAX_VOTING_PERIOD_SECONDS = 2_592_000;
/** Maximum title length */
export const MAX_TITLE_LENGTH = 200;
/** Minimum quorum percentage */
export const MIN_QUORUM_PERCENT = 1;
/** Maximum quorum percentage */
export const MAX_QUORUM_PERCENT = 100;

// ─── Validation ───────────────────────────────────────────────────────────────

export interface ValidationErrors {
  title?: string;
  votingPeriodDays?: string;
  description?: string;
  payload?: string;
}

export function validateProposalForm(fields: {
  title: string;
  votingPeriodDays: number;
  description: string;
  payload: string;
}): ValidationErrors {
  const errors: ValidationErrors = {};

  if (!fields.title.trim()) {
    errors.title = 'Title is required.';
  } else if (fields.title.trim().length > MAX_TITLE_LENGTH) {
    errors.title = `Title must be ${MAX_TITLE_LENGTH} characters or fewer.`;
  }

  const periodSeconds = fields.votingPeriodDays * 86_400;
  if (
    !Number.isFinite(fields.votingPeriodDays) ||
    fields.votingPeriodDays <= 0 ||
    periodSeconds < MIN_VOTING_PERIOD_SECONDS
  ) {
    errors.votingPeriodDays = `Voting period must be at least ${MIN_VOTING_PERIOD_SECONDS / 86_400} day(s).`;
  } else if (periodSeconds > MAX_VOTING_PERIOD_SECONDS) {
    errors.votingPeriodDays = `Voting period must be at most ${MAX_VOTING_PERIOD_SECONDS / 86_400} days.`;
  }

  if (!fields.description.trim()) {
    errors.description = 'Description is required.';
  }

  if (!fields.payload.trim()) {
    errors.payload = 'Payload is required.';
  }

  return errors;
}

// ─── Sanitize helper ─────────────────────────────────────────────────────────

export function sanitizeHtml(input: string): string {
  return DOMPurify.sanitize(input, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] });
}

// ─── Step types ───────────────────────────────────────────────────────────────

type Step = 'type' | 'parameters' | 'description' | 'preview' | 'submit';

const STEPS: Step[] = ['type', 'parameters', 'description', 'preview', 'submit'];

const STEP_LABELS: Record<Step, string> = {
  type: 'Type',
  parameters: 'Parameters',
  description: 'Description',
  preview: 'Preview',
  submit: 'Submit',
};

// ─── Component ───────────────────────────────────────────────────────────────

export interface CreateProposalFormProps {
  /** Token address used to scope governance power checks */
  tokenAddress: string;
  /** Connected wallet state */
  wallet: WalletState;
  /** Called after a proposal is successfully submitted */
  onSuccess?: (proposalId: string, txHash: string) => void;
  /** Called when the user cancels the form */
  onCancel?: () => void;
}

export function CreateProposalForm({
  tokenAddress,
  wallet,
  onSuccess,
  onCancel,
}: CreateProposalFormProps) {
  const { createProposal, reset, status, error, txHash, proposalId, isSubmitting } =
    useGovernance(tokenAddress);

  const [step, setStep] = useState<Step>('type');
  const [proposalType, setProposalType] = useState<ProposalTypeValue>('PARAMETER_CHANGE');
  const [title, setTitle] = useState('');
  const [votingPeriodDays, setVotingPeriodDays] = useState(7);
  const [description, setDescription] = useState('');
  const [payload, setPayload] = useState('{}');
  const [fieldErrors, setFieldErrors] = useState<ValidationErrors>({});

  const currentStepIndex = STEPS.indexOf(step);

  // ── Navigation ──────────────────────────────────────────────────────────────

  const goNext = () => {
    if (step === 'parameters') {
      const errors = validateProposalForm({ title, votingPeriodDays, description, payload });
      const stepErrors: ValidationErrors = {};
      if (errors.title) stepErrors.title = errors.title;
      if (errors.votingPeriodDays) stepErrors.votingPeriodDays = errors.votingPeriodDays;
      if (errors.payload) stepErrors.payload = errors.payload;
      if (Object.keys(stepErrors).length > 0) {
        setFieldErrors(stepErrors);
        return;
      }
      setFieldErrors({});
    }

    if (step === 'description') {
      const errors = validateProposalForm({ title, votingPeriodDays, description, payload });
      if (errors.description) {
        setFieldErrors({ description: errors.description });
        return;
      }
      setFieldErrors({});
    }

    const nextIndex = currentStepIndex + 1;
    if (nextIndex < STEPS.length) {
      setStep(STEPS[nextIndex]);
    }
  };

  const goBack = () => {
    const prevIndex = currentStepIndex - 1;
    if (prevIndex >= 0) {
      setStep(STEPS[prevIndex]);
    }
  };

  // ── Submit ──────────────────────────────────────────────────────────────────

  const handleSubmit = async () => {
    const errors = validateProposalForm({ title, votingPeriodDays, description, payload });
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    const sanitizedDescription = sanitizeHtml(description);

    await createProposal(
      {
        title: title.trim(),
        description: sanitizedDescription,
        payloadType: proposalType,
        payload: payload.trim(),
        votingPeriod: votingPeriodDays * 86_400,
      },
      wallet
    );
  };

  // ── Success screen ──────────────────────────────────────────────────────────

  if (status === 'success' && proposalId && txHash) {
    return (
      <Card className="p-6">
        <div className="text-center py-8">
          <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Proposal Created</h2>
          <p className="text-gray-600 mb-6">Your proposal has been submitted on-chain.</p>
          <div className="bg-gray-50 rounded-lg p-4 text-left mb-6 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Proposal ID</span>
              <span className="font-medium">{proposalId}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Transaction</span>
              <span className="font-mono text-xs">{truncateAddress(txHash)}</span>
            </div>
          </div>
          <div className="flex gap-3 justify-center">
            <Button
              variant="outline"
              onClick={() => {
                reset();
                setStep('type');
                setTitle('');
                setDescription('');
                setPayload('{}');
                setVotingPeriodDays(7);
                setProposalType('PARAMETER_CHANGE');
              }}
            >
              Create Another
            </Button>
            {onSuccess && (
              <Button variant="primary" onClick={() => onSuccess(proposalId, txHash)}>
                View Proposal
              </Button>
            )}
          </div>
        </div>
      </Card>
    );
  }

  // ── Step progress indicator ─────────────────────────────────────────────────

  const selectedType = PROPOSAL_TYPES.find((p) => p.value === proposalType);
  const safeDescription = sanitizeHtml(description);

  // ── Render ──────────────────────────────────────────────────────────────────

  const isLastStep = step === 'submit';
  const isFirstStep = step === 'type';

  return (
    <Card className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">Create Proposal</h1>
        {onCancel && (
          <button
            onClick={onCancel}
            className="text-sm text-gray-500 hover:text-gray-700"
            aria-label="Cancel form"
          >
            ✕
          </button>
        )}
      </div>

      {/* Step progress indicator */}
      <div className="flex items-center gap-1 mb-6" aria-label="Form progress">
        {STEPS.map((s, i) => (
          <div key={s} className="flex items-center gap-1">
            <div
              className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium transition-colors ${
                i < currentStepIndex
                  ? 'bg-blue-600 text-white'
                  : i === currentStepIndex
                  ? 'bg-blue-100 text-blue-700 ring-2 ring-blue-600'
                  : 'bg-gray-100 text-gray-400'
              }`}
              aria-current={i === currentStepIndex ? 'step' : undefined}
            >
              {i < currentStepIndex ? (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                i + 1
              )}
            </div>
            <span
              className={`text-xs hidden sm:inline ${
                i === currentStepIndex ? 'text-blue-700 font-medium' : 'text-gray-400'
              }`}
            >
              {STEP_LABELS[s]}
            </span>
            {i < STEPS.length - 1 && (
              <div
                className={`flex-1 h-px w-4 mx-1 ${
                  i < currentStepIndex ? 'bg-blue-600' : 'bg-gray-200'
                }`}
              />
            )}
          </div>
        ))}
      </div>

      {/* Step content — rendered as JSX (not sub-components) to avoid unmount on re-render */}
      <div className="min-h-[280px]">
        {step === 'type' && (
          <div>
            <h2 className="text-lg font-semibold text-gray-900 mb-1">Select Proposal Type</h2>
            <p className="text-sm text-gray-500 mb-4">
              Choose the category that best describes your proposal.
            </p>
            <div className="space-y-3">
              {PROPOSAL_TYPES.map((pt) => (
                <label
                  key={pt.value}
                  className={`flex items-start gap-3 p-4 rounded-lg border-2 cursor-pointer transition-colors ${
                    proposalType === pt.value
                      ? 'border-blue-600 bg-blue-50'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <input
                    type="radio"
                    name="proposalType"
                    value={pt.value}
                    checked={proposalType === pt.value}
                    onChange={() => setProposalType(pt.value)}
                    className="mt-0.5 accent-blue-600"
                  />
                  <div>
                    <p className="font-medium text-gray-900">{pt.label}</p>
                    <p className="text-sm text-gray-500">{pt.description}</p>
                  </div>
                </label>
              ))}
            </div>
          </div>
        )}

        {step === 'parameters' && (
          <div>
            <h2 className="text-lg font-semibold text-gray-900 mb-1">Set Parameters</h2>
            <p className="text-sm text-gray-500 mb-4">
              Define the title, voting period, and payload for your proposal.
            </p>

            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4 text-sm text-amber-800">
              <strong>On-chain constraints:</strong> Voting period must be between{' '}
              {MIN_VOTING_PERIOD_SECONDS / 86_400} and {MAX_VOTING_PERIOD_SECONDS / 86_400} days.
              Minimum quorum is enforced by the contract.
            </div>

            <div className="mb-4">
              <label
                className="block text-sm font-medium text-gray-700 mb-1"
                htmlFor="proposal-title"
              >
                Title <span className="text-red-500">*</span>
              </label>
              <input
                id="proposal-title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={MAX_TITLE_LENGTH}
                placeholder="e.g. Increase base fee to 10 XLM"
                className={`w-full rounded-lg border px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                  fieldErrors.title ? 'border-red-400' : 'border-gray-300'
                }`}
              />
              <div className="flex justify-between mt-1">
                {fieldErrors.title ? (
                  <p className="text-xs text-red-600">{fieldErrors.title}</p>
                ) : (
                  <span />
                )}
                <span className="text-xs text-gray-400">
                  {title.length}/{MAX_TITLE_LENGTH}
                </span>
              </div>
            </div>

            <div className="mb-4">
              <label
                className="block text-sm font-medium text-gray-700 mb-1"
                htmlFor="voting-period"
              >
                Voting Period (days) <span className="text-red-500">*</span>
              </label>
              <input
                id="voting-period"
                type="number"
                min={1}
                max={30}
                value={votingPeriodDays}
                onChange={(e) => setVotingPeriodDays(Number(e.target.value))}
                className={`w-full rounded-lg border px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                  fieldErrors.votingPeriodDays ? 'border-red-400' : 'border-gray-300'
                }`}
              />
              {fieldErrors.votingPeriodDays && (
                <p className="text-xs text-red-600 mt-1">{fieldErrors.votingPeriodDays}</p>
              )}
            </div>

            <div className="mb-2">
              <label
                className="block text-sm font-medium text-gray-700 mb-1"
                htmlFor="proposal-payload"
              >
                Payload (JSON) <span className="text-red-500">*</span>
              </label>
              <textarea
                id="proposal-payload"
                value={payload}
                onChange={(e) => setPayload(e.target.value)}
                rows={4}
                placeholder='{ "key": "value" }'
                className={`w-full rounded-lg border px-3 py-2 text-sm font-mono text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                  fieldErrors.payload ? 'border-red-400' : 'border-gray-300'
                }`}
              />
              {fieldErrors.payload && (
                <p className="text-xs text-red-600 mt-1">{fieldErrors.payload}</p>
              )}
            </div>
          </div>
        )}

        {step === 'description' && (
          <div>
            <h2 className="text-lg font-semibold text-gray-900 mb-1">Write Description</h2>
            <p className="text-sm text-gray-500 mb-4">
              Explain the motivation, context, and expected outcome of your proposal. HTML is
              stripped before storage.
            </p>
            <label
              className="block text-sm font-medium text-gray-700 mb-1"
              htmlFor="proposal-description"
            >
              Description <span className="text-red-500">*</span>
            </label>
            <textarea
              id="proposal-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={10}
              placeholder="Describe your proposal in detail…"
              className={`w-full rounded-lg border px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                fieldErrors.description ? 'border-red-400' : 'border-gray-300'
              }`}
            />
            {fieldErrors.description && (
              <p className="text-xs text-red-600 mt-1">{fieldErrors.description}</p>
            )}
          </div>
        )}

        {step === 'preview' && (
          <div>
            <h2 className="text-lg font-semibold text-gray-900 mb-1">Preview Proposal</h2>
            <p className="text-sm text-gray-500 mb-4">
              Review the finalized proposal before signing the transaction.
            </p>

            {/* Mirrors ProposalDetail layout */}
            <div className="border rounded-lg p-5 space-y-5 bg-gray-50" data-testid="proposal-preview">
              <div className="flex items-start justify-between">
                <div>
                  <h1 className="text-xl font-bold text-gray-900">{title || '(no title)'}</h1>
                  <p className="text-sm text-gray-500 mt-0.5">Draft — not yet submitted</p>
                </div>
                <span className="px-3 py-1 text-sm font-medium rounded-full bg-gray-100 text-gray-700">
                  Draft
                </span>
              </div>

              <div>
                <span className="inline-block px-2 py-1 text-xs font-medium rounded bg-blue-100 text-blue-700">
                  {selectedType?.label ?? proposalType}
                </span>
              </div>

              <div>
                <h2 className="text-base font-medium text-gray-900 mb-1">Description</h2>
                <p className="text-gray-600 whitespace-pre-wrap text-sm">
                  {safeDescription || '(no description)'}
                </p>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <div className="p-3 bg-white rounded-lg border">
                  <div className="text-xs text-gray-500">Proposer</div>
                  <div className="font-medium text-sm">
                    {wallet.address ? truncateAddress(wallet.address) : '—'}
                  </div>
                </div>
                <div className="p-3 bg-white rounded-lg border">
                  <div className="text-xs text-gray-500">Voting Period</div>
                  <div className="font-medium text-sm">{votingPeriodDays} day(s)</div>
                </div>
                <div className="p-3 bg-white rounded-lg border">
                  <div className="text-xs text-gray-500">Type</div>
                  <div className="font-medium text-sm">{selectedType?.label ?? proposalType}</div>
                </div>
              </div>

              <div>
                <h2 className="text-base font-medium text-gray-900 mb-1">Payload</h2>
                <pre className="text-xs bg-white border rounded p-3 overflow-x-auto text-gray-700">
                  {payload}
                </pre>
              </div>
            </div>
          </div>
        )}

        {step === 'submit' && (
          <div>
            <h2 className="text-lg font-semibold text-gray-900 mb-1">Sign &amp; Submit</h2>
            <p className="text-sm text-gray-500 mb-4">
              Your wallet will prompt you to sign the transaction. Once signed, the proposal will
              be submitted on-chain.
            </p>

            {!wallet.connected && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4 text-sm text-amber-800">
                Please connect your wallet before submitting.
              </div>
            )}

            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4 text-sm text-red-700">
                {error}
              </div>
            )}

            {isSubmitting && (
              <div className="flex items-center gap-3 py-6 justify-center">
                <Spinner size="md" />
                <span className="text-gray-600 text-sm">Submitting proposal to the network…</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Navigation buttons */}
      <div className="flex justify-between mt-6 pt-4 border-t border-gray-100">
        <Button
          variant="outline"
          onClick={isFirstStep ? onCancel : goBack}
          disabled={isSubmitting}
        >
          {isFirstStep ? 'Cancel' : 'Back'}
        </Button>

        {isLastStep ? (
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={isSubmitting || !wallet.connected}
            loading={isSubmitting}
          >
            Submit Proposal
          </Button>
        ) : (
          <Button variant="primary" onClick={goNext}>
            Next
          </Button>
        )}
      </div>
    </Card>
  );
}

export default CreateProposalForm;
