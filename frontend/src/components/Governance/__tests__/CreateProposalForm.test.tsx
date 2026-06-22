/**
 * Tests for CreateProposalForm
 *
 * Covers:
 *  1. Form validation — title length, voting period bounds, description, payload
 *  2. XSS sanitization of description fields
 *  3. Integration flow — simulates a full proposal creation with a mocked API call
 *  4. Step navigation — next/back behaviour
 *  5. Submit button disabled when wallet disconnected
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  CreateProposalForm,
  validateProposalForm,
  sanitizeHtml,
  MAX_TITLE_LENGTH,
  MIN_VOTING_PERIOD_SECONDS,
  MAX_VOTING_PERIOD_SECONDS,
} from '../CreateProposalForm';
import * as governanceApi from '../../../services/governanceApi';
import type { WalletState } from '../../../types';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const CONNECTED_WALLET: WalletState = {
  connected: true,
  address: 'GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQSTBE2EURIDVXL6B',
  network: 'testnet',
};

const DISCONNECTED_WALLET: WalletState = {
  connected: false,
  address: null,
  network: 'testnet',
};

// ─── 1. Validation unit tests ────────────────────────────────────────────────

describe('validateProposalForm', () => {
  const BASE = {
    title: 'Valid title',
    votingPeriodDays: 7,
    description: 'A valid description.',
    payload: '{}',
  };

  it('returns no errors for valid inputs', () => {
    expect(validateProposalForm(BASE)).toEqual({});
  });

  it('requires a non-empty title', () => {
    const errors = validateProposalForm({ ...BASE, title: '   ' });
    expect(errors.title).toBeDefined();
  });

  it(`rejects titles longer than ${MAX_TITLE_LENGTH} characters`, () => {
    const errors = validateProposalForm({ ...BASE, title: 'x'.repeat(MAX_TITLE_LENGTH + 1) });
    expect(errors.title).toMatch(/200/);
  });

  it(`accepts titles of exactly ${MAX_TITLE_LENGTH} characters`, () => {
    const errors = validateProposalForm({ ...BASE, title: 'x'.repeat(MAX_TITLE_LENGTH) });
    expect(errors.title).toBeUndefined();
  });

  it(`rejects voting period below ${MIN_VOTING_PERIOD_SECONDS / 86_400} day`, () => {
    const errors = validateProposalForm({ ...BASE, votingPeriodDays: 0 });
    expect(errors.votingPeriodDays).toBeDefined();
  });

  it(`rejects voting period above ${MAX_VOTING_PERIOD_SECONDS / 86_400} days`, () => {
    const errors = validateProposalForm({ ...BASE, votingPeriodDays: 31 });
    expect(errors.votingPeriodDays).toBeDefined();
  });

  it('accepts voting period of 1 day (minimum)', () => {
    const errors = validateProposalForm({ ...BASE, votingPeriodDays: 1 });
    expect(errors.votingPeriodDays).toBeUndefined();
  });

  it('accepts voting period of 30 days (maximum)', () => {
    const errors = validateProposalForm({ ...BASE, votingPeriodDays: 30 });
    expect(errors.votingPeriodDays).toBeUndefined();
  });

  it('requires a non-empty description', () => {
    const errors = validateProposalForm({ ...BASE, description: '' });
    expect(errors.description).toBeDefined();
  });

  it('requires a non-empty payload', () => {
    const errors = validateProposalForm({ ...BASE, payload: '   ' });
    expect(errors.payload).toBeDefined();
  });
});

// ─── 2. XSS sanitization tests ───────────────────────────────────────────────

describe('sanitizeHtml', () => {
  it('strips script tags from input', () => {
    const malicious = '<script>alert("xss")</script>Hello';
    expect(sanitizeHtml(malicious)).toBe('Hello');
  });

  it('strips img onerror attributes', () => {
    const malicious = '<img src=x onerror="alert(1)">text';
    expect(sanitizeHtml(malicious)).toBe('text');
  });

  it('strips all HTML tags, preserving text content', () => {
    const input = '<b>Bold</b> and <em>italic</em>';
    expect(sanitizeHtml(input)).toBe('Bold and italic');
  });

  it('passes through plain text unchanged', () => {
    const plain = 'No HTML here, just text.';
    expect(sanitizeHtml(plain)).toBe(plain);
  });

  it('handles empty string', () => {
    expect(sanitizeHtml('')).toBe('');
  });
});

// ─── 3. Component rendering and step navigation ───────────────────────────────

describe('CreateProposalForm — rendering', () => {
  it('renders the type selection step by default', () => {
    render(
      <CreateProposalForm
        tokenAddress=""
        wallet={CONNECTED_WALLET}
      />
    );
    expect(screen.getByText('Select Proposal Type')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Parameter Change/i })).toBeInTheDocument();
  });

  it('navigates to parameters step on Next', async () => {
    const user = userEvent.setup();
    render(<CreateProposalForm tokenAddress="" wallet={CONNECTED_WALLET} />);

    await user.click(screen.getByRole('button', { name: /Next/i }));
    expect(screen.getByText('Set Parameters')).toBeInTheDocument();
  });

  it('shows validation errors when advancing from parameters with empty title', async () => {
    const user = userEvent.setup();
    render(<CreateProposalForm tokenAddress="" wallet={CONNECTED_WALLET} />);

    // Go to parameters step
    await user.click(screen.getByRole('button', { name: /Next/i }));

    // Clear title and try to advance
    const titleInput = screen.getByLabelText(/Title/i);
    await user.clear(titleInput);
    await user.click(screen.getByRole('button', { name: /Next/i }));

    expect(screen.getByText(/Title is required/i)).toBeInTheDocument();
  });

  it('shows error when voting period exceeds 30 days', async () => {
    const user = userEvent.setup();
    render(<CreateProposalForm tokenAddress="" wallet={CONNECTED_WALLET} />);

    await user.click(screen.getByRole('button', { name: /Next/i }));

    const titleInput = screen.getByLabelText(/Title/i);
    await user.type(titleInput, 'My Proposal');

    const periodInput = screen.getByLabelText(/Voting Period/i);
    fireEvent.change(periodInput, { target: { value: '31' } });

    await user.click(screen.getByRole('button', { name: /Next/i }));
    expect(screen.getByText(/at most 30 days/i)).toBeInTheDocument();
  });

  it('navigates back from parameters to type step', async () => {
    const user = userEvent.setup();
    render(<CreateProposalForm tokenAddress="" wallet={CONNECTED_WALLET} />);

    await user.click(screen.getByRole('button', { name: /Next/i }));
    expect(screen.getByText('Set Parameters')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Back/i }));
    expect(screen.getByText('Select Proposal Type')).toBeInTheDocument();
  });

  it('disables Submit Proposal button when wallet is disconnected', async () => {
    const user = userEvent.setup();
    render(<CreateProposalForm tokenAddress="" wallet={DISCONNECTED_WALLET} />);

    // Navigate all the way to submit step
    // Step 1 → type (default), click Next
    await user.click(screen.getByRole('button', { name: /Next/i }));

    // Step 2 → parameters: fill required fields
    await user.type(screen.getByLabelText(/Title/i), 'Test Proposal');
    await user.click(screen.getByRole('button', { name: /Next/i }));

    // Step 3 → description
    await user.type(screen.getByLabelText(/Description/i), 'A detailed description.');
    await user.click(screen.getByRole('button', { name: /Next/i }));

    // Step 4 → preview
    await user.click(screen.getByRole('button', { name: /Next/i }));

    // Step 5 → submit
    const submitBtn = screen.getByRole('button', { name: /Submit Proposal/i });
    expect(submitBtn).toBeDisabled();
  });

  it('calls onCancel when Cancel button is clicked on first step', async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(
      <CreateProposalForm tokenAddress="" wallet={CONNECTED_WALLET} onCancel={onCancel} />
    );

    // The footer "Cancel" button is visible on the first step
    const cancelButtons = screen.getAllByRole('button', { name: /Cancel/i });
    // Click the visible footer Cancel button (last one found, or the one named exactly "Cancel")
    await user.click(cancelButtons[cancelButtons.length - 1]);
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

// ─── 4. Integration flow ──────────────────────────────────────────────────────

describe('CreateProposalForm — full creation flow (mocked API)', () => {
  beforeEach(() => {
    vi.spyOn(governanceApi, 'submitProposal').mockResolvedValue({
      txHash: 'tx-abc-123',
      proposalId: 'prop-42',
    });
    vi.spyOn(governanceApi, 'invalidateProposalListCache').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('completes the full flow and shows the success screen', async () => {
    const onSuccess = vi.fn();
    const user = userEvent.setup();

    render(
      <CreateProposalForm
        tokenAddress="TOKEN_ADDR"
        wallet={CONNECTED_WALLET}
        onSuccess={onSuccess}
      />
    );

    // Step 1 — type (select CUSTOM)
    const customRadio = screen.getByRole('radio', { name: /Custom/i });
    await user.click(customRadio);
    await user.click(screen.getByRole('button', { name: /Next/i }));

    // Step 2 — parameters
    await user.type(screen.getByLabelText(/Title/i), 'My integration test proposal');
    // Voting period defaults to 7 — keep it
    await user.click(screen.getByRole('button', { name: /Next/i }));

    // Step 3 — description
    await user.type(screen.getByLabelText(/Description/i), 'Detailed description here.');
    await user.click(screen.getByRole('button', { name: /Next/i }));

    // Step 4 — preview (just advance)
    expect(screen.getByText('Preview Proposal')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Next/i }));

    // Step 5 — submit
    expect(screen.getByText('Sign & Submit')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Submit Proposal/i }));

    // Wait for success screen
    await waitFor(() => {
      expect(screen.getByText('Proposal Created')).toBeInTheDocument();
    });

    expect(governanceApi.submitProposal).toHaveBeenCalledWith(
      'My integration test proposal',
      'Detailed description here.',
      'CUSTOM',
      expect.any(String),
      7 * 86_400,
      CONNECTED_WALLET
    );

    expect(screen.getByText('prop-42')).toBeInTheDocument();
  });

  it('shows an error message when the API call fails', async () => {
    vi.spyOn(governanceApi, 'submitProposal').mockRejectedValue(
      new Error('Network error: proposal rejected')
    );

    const user = userEvent.setup();
    render(<CreateProposalForm tokenAddress="" wallet={CONNECTED_WALLET} />);

    // Navigate to submit
    await user.click(screen.getByRole('button', { name: /Next/i }));
    await user.type(screen.getByLabelText(/Title/i), 'Failing proposal');
    await user.click(screen.getByRole('button', { name: /Next/i }));
    await user.type(screen.getByLabelText(/Description/i), 'This will fail.');
    await user.click(screen.getByRole('button', { name: /Next/i }));
    await user.click(screen.getByRole('button', { name: /Next/i }));

    await user.click(screen.getByRole('button', { name: /Submit Proposal/i }));

    await waitFor(() => {
      expect(screen.getByText(/Network error: proposal rejected/i)).toBeInTheDocument();
    });
  });

  it('renders sanitized description in the preview step (XSS test)', async () => {
    const user = userEvent.setup();
    render(<CreateProposalForm tokenAddress="" wallet={CONNECTED_WALLET} />);

    await user.click(screen.getByRole('button', { name: /Next/i }));
    await user.type(screen.getByLabelText(/Title/i), 'XSS Test');
    await user.click(screen.getByRole('button', { name: /Next/i }));

    const xssInput = '<script>alert("xss")</script>Safe text';
    await user.type(screen.getByLabelText(/Description/i), xssInput);
    await user.click(screen.getByRole('button', { name: /Next/i }));

    // On preview step — script tag must not be rendered
    const preview = screen.getByTestId('proposal-preview');
    expect(within(preview).queryByText(/alert/)).not.toBeInTheDocument();
    expect(within(preview).getByText(/Safe text/)).toBeInTheDocument();
  });
});
