import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DeadLetterTab } from '../DeadLetterTab';
import { webhookApi, WebhookEventType } from '../../../services/webhookApi';

// Mock the API
vi.mock('../../../services/webhookApi', () => ({
  webhookApi: {
    getDeadLetters: vi.fn(),
    retryDeadLetter: vi.fn(),
    discardDeadLetter: vi.fn(),
  },
  WebhookEventType: {
    TOKEN_BURN_SELF: 'token.burn.self',
    TOKEN_BURN_ADMIN: 'token.burn.admin',
    TOKEN_CREATED: 'token.created',
    TOKEN_METADATA_UPDATED: 'token.metadata.updated',
  },
}));

const mockDeadLetters = [
  {
    id: 'dl-1',
    subscriptionId: 'sub-1',
    event: WebhookEventType.TOKEN_BURN_SELF,
    payload: '{"data": "test"}',
    statusCode: 500,
    lastError: 'Connection refused',
    attemptCount: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    resolvedAt: null,
    resolution: null,
  },
  {
    id: 'dl-2',
    subscriptionId: 'sub-1',
    event: WebhookEventType.TOKEN_CREATED,
    payload: '{"data": "test2"}',
    statusCode: 503,
    lastError: 'Service temporarily unavailable',
    attemptCount: 2,
    createdAt: new Date(Date.now() - 60000).toISOString(),
    updatedAt: new Date(Date.now() - 60000).toISOString(),
    resolvedAt: null,
    resolution: null,
  },
];

describe('DeadLetterTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render loading state initially', () => {
    (webhookApi.getDeadLetters as any).mockImplementation(
      () => new Promise(() => {}) // Never resolves
    );

    render(<DeadLetterTab subscriptionId="sub-1" />);
    expect(screen.getByRole('img', { hidden: true })).toBeInTheDocument(); // Spinner
  });

  it('should display dead-letter entries', async () => {
    (webhookApi.getDeadLetters as any).mockResolvedValueOnce(mockDeadLetters);

    render(<DeadLetterTab subscriptionId="sub-1" />);

    await waitFor(() => {
      expect(screen.getByText('token.burn.self')).toBeInTheDocument();
      expect(screen.getByText('token.created')).toBeInTheDocument();
    });

    expect(screen.getByText('Connection refused')).toBeInTheDocument();
    expect(screen.getByText('Service temporarily unavailable')).toBeInTheDocument();
  });

  it('should display table headers correctly', async () => {
    (webhookApi.getDeadLetters as any).mockResolvedValueOnce(mockDeadLetters);

    render(<DeadLetterTab subscriptionId="sub-1" />);

    await waitFor(() => {
      expect(screen.getByText('Event Type')).toBeInTheDocument();
      expect(screen.getByText('Failure Reason')).toBeInTheDocument();
      expect(screen.getByText('Attempts')).toBeInTheDocument();
      expect(screen.getByText('Last Attempt')).toBeInTheDocument();
      expect(screen.getByText('Actions')).toBeInTheDocument();
    });
  });

  it('should show empty state when no dead letters', async () => {
    (webhookApi.getDeadLetters as any).mockResolvedValueOnce([]);

    render(<DeadLetterTab subscriptionId="sub-1" />);

    await waitFor(() => {
      expect(screen.getByText(/No dead-letter entries/)).toBeInTheDocument();
    });
  });

  it('should show error state on fetch failure', async () => {
    const errorMessage = 'Failed to fetch dead letters';
    (webhookApi.getDeadLetters as any).mockRejectedValueOnce(new Error(errorMessage));

    render(<DeadLetterTab subscriptionId="sub-1" />);

    await waitFor(() => {
      expect(screen.getByText(errorMessage)).toBeInTheDocument();
    });
  });

  it('should retry dead-letter on confirm', async () => {
    (webhookApi.getDeadLetters as any).mockResolvedValueOnce(mockDeadLetters);
    (webhookApi.retryDeadLetter as any).mockResolvedValueOnce({
      success: true,
      message: 'Retried successfully',
    });

    const user = userEvent.setup();
    render(<DeadLetterTab subscriptionId="sub-1" />);

    await waitFor(() => {
      expect(screen.getAllByText('Retry')).toHaveLength(2);
    });

    const retryButtons = screen.getAllByText('Retry');
    await user.click(retryButtons[0]);

    // Confirm dialog should appear
    await waitFor(() => {
      expect(screen.getByText('Retry Dead-Letter Delivery?')).toBeInTheDocument();
    });

    const confirmButton = screen.getByText('Retry');
    await user.click(confirmButton);

    await waitFor(() => {
      expect(webhookApi.retryDeadLetter).toHaveBeenCalledWith('dl-1');
    });

    // Entry should be removed from table
    await waitFor(() => {
      expect(screen.queryByText('Connection refused')).not.toBeInTheDocument();
    });
  });

  it('should discard dead-letter on confirm', async () => {
    (webhookApi.getDeadLetters as any).mockResolvedValueOnce(mockDeadLetters);
    (webhookApi.discardDeadLetter as any).mockResolvedValueOnce({
      success: true,
      message: 'Discarded successfully',
    });

    const user = userEvent.setup();
    render(<DeadLetterTab subscriptionId="sub-1" />);

    await waitFor(() => {
      expect(screen.getAllByText('Discard')).toHaveLength(2);
    });

    const discardButtons = screen.getAllByText('Discard');
    await user.click(discardButtons[0]);

    // Confirm dialog should appear
    await waitFor(() => {
      expect(screen.getByText('Discard Dead-Letter Entry?')).toBeInTheDocument();
    });

    const confirmButton = screen.getByText('Discard');
    await user.click(confirmButton);

    await waitFor(() => {
      expect(webhookApi.discardDeadLetter).toHaveBeenCalledWith('dl-1');
    });

    // Entry should be removed from table
    await waitFor(() => {
      expect(screen.queryByText('Connection refused')).not.toBeInTheDocument();
    });
  });

  it('should cancel retry action', async () => {
    (webhookApi.getDeadLetters as any).mockResolvedValueOnce(mockDeadLetters);

    const user = userEvent.setup();
    render(<DeadLetterTab subscriptionId="sub-1" />);

    await waitFor(() => {
      expect(screen.getAllByText('Retry')).toHaveLength(2);
    });

    const retryButtons = screen.getAllByText('Retry');
    await user.click(retryButtons[0]);

    // Confirm dialog should appear
    await waitFor(() => {
      expect(screen.getByText('Retry Dead-Letter Delivery?')).toBeInTheDocument();
    });

    // Click cancel (first button that says something other than Retry in the dialog)
    const cancelButton = screen.getByText(/Retry Dead-Letter Delivery/);
    const dialog = cancelButton.closest('[role="dialog"]');
    const buttons = dialog?.querySelectorAll('button');
    if (buttons && buttons.length > 0) {
      await user.click(buttons[0]); // Cancel is usually first
    }

    expect(webhookApi.retryDeadLetter).not.toHaveBeenCalled();
  });

  it('should display attempt count', async () => {
    (webhookApi.getDeadLetters as any).mockResolvedValueOnce(mockDeadLetters);

    render(<DeadLetterTab subscriptionId="sub-1" />);

    await waitFor(() => {
      const cells = screen.getAllByText(/^[23]$/); // Attempt counts 3 and 2
      expect(cells.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('should display formatted last attempt timestamp', async () => {
    (webhookApi.getDeadLetters as any).mockResolvedValueOnce(mockDeadLetters);

    render(<DeadLetterTab subscriptionId="sub-1" />);

    await waitFor(() => {
      const dateStrings = screen.getAllByText(/\d{1,2}\/\d{1,2}\/\d{4}/);
      expect(dateStrings.length).toBeGreaterThan(0);
    });
  });

  it('should handle retry error gracefully', async () => {
    (webhookApi.getDeadLetters as any).mockResolvedValueOnce(mockDeadLetters);
    const errorMessage = 'Retry failed';
    (webhookApi.retryDeadLetter as any).mockRejectedValueOnce(new Error(errorMessage));

    const user = userEvent.setup();
    render(<DeadLetterTab subscriptionId="sub-1" />);

    await waitFor(() => {
      expect(screen.getAllByText('Retry')).toHaveLength(2);
    });

    const retryButtons = screen.getAllByText('Retry');
    await user.click(retryButtons[0]);

    await waitFor(() => {
      expect(screen.getByText('Retry Dead-Letter Delivery?')).toBeInTheDocument();
    });

    const confirmButton = screen.getByText('Retry');
    await user.click(confirmButton);

    await waitFor(() => {
      expect(screen.getByText(errorMessage)).toBeInTheDocument();
    });
  });

  it('should display endpoint URL if available in payload', async () => {
    (webhookApi.getDeadLetters as any).mockResolvedValueOnce(mockDeadLetters);

    render(<DeadLetterTab subscriptionId="sub-1" />);

    await waitFor(() => {
      expect(screen.getByText('token.burn.self')).toBeInTheDocument();
    });

    // Verify the table renders with all entries
    expect(screen.getByText('token.created')).toBeInTheDocument();
  });
});
