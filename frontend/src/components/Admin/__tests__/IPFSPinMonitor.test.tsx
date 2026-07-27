/**
 * IPFSPinMonitor — Component Tests (#1403)
 *
 * Verifies:
 *   1. Pins render with the correct color-coded status per row
 *      (pinned=green, warning=yellow, failed=red)
 *   2. The Re-Pin button calls the re-pin endpoint and refreshes the table
 *   3. Auto-refresh polls the list endpoint every 30 seconds
 *   4. Error and empty states render correctly
 */
import React from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IPFSPinMonitor } from '../IPFSPinMonitor';
import { apiClient } from '../../../services/apiClient';

vi.mock('../../../services/apiClient', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

const PINNED_RECORD = {
  cid: 'QmPinned111',
  tokenName: 'GoodToken',
  tokenAddress: '0xabc',
  pinned: true,
  failureCount: 0,
  lastChecked: '2026-06-25T10:00:00.000Z',
  error: null,
  status: 'pinned' as const,
  createdAt: '2026-06-20T10:00:00.000Z',
  updatedAt: '2026-06-25T10:00:00.000Z',
};

const WARNING_RECORD = {
  cid: 'QmWarning222',
  tokenName: 'WarnToken',
  tokenAddress: '0xdef',
  pinned: false,
  failureCount: 2,
  lastChecked: '2026-06-25T09:00:00.000Z',
  error: 'timeout',
  status: 'warning' as const,
  createdAt: '2026-06-20T10:00:00.000Z',
  updatedAt: '2026-06-25T09:00:00.000Z',
};

const FAILED_RECORD = {
  cid: 'QmFailed333',
  tokenName: 'FailToken',
  tokenAddress: '0xghi',
  pinned: false,
  failureCount: 5,
  lastChecked: '2026-06-25T08:00:00.000Z',
  error: 'not found',
  status: 'failed' as const,
  createdAt: '2026-06-20T10:00:00.000Z',
  updatedAt: '2026-06-25T08:00:00.000Z',
};

function mockPinsResponse(pins: unknown[]) {
  return {
    success: true,
    data: { pins, total: pins.length },
  };
}

describe('IPFSPinMonitor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders rows color-coded by pin health status', async () => {
    vi.mocked(apiClient.get).mockResolvedValueOnce(
      mockPinsResponse([PINNED_RECORD, WARNING_RECORD, FAILED_RECORD])
    );

    render(<IPFSPinMonitor />);

    await waitFor(() => expect(apiClient.get).toHaveBeenCalledWith('/api/admin/ipfs/pins'));

    const pinnedRow = await screen.findByTestId(`pin-row-${PINNED_RECORD.cid}`);
    const warningRow = screen.getByTestId(`pin-row-${WARNING_RECORD.cid}`);
    const failedRow = screen.getByTestId(`pin-row-${FAILED_RECORD.cid}`);

    expect(pinnedRow.className).toMatch(/bg-green-50/);
    expect(pinnedRow.getAttribute('data-status')).toBe('pinned');

    expect(warningRow.className).toMatch(/bg-yellow-50/);
    expect(warningRow.getAttribute('data-status')).toBe('warning');

    expect(failedRow.className).toMatch(/bg-red-50/);
    expect(failedRow.getAttribute('data-status')).toBe('failed');

    expect(screen.getByText('Pinned')).toBeTruthy();
    expect(screen.getByText('Warning')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
  });

  it('shows an empty state when no CIDs are tracked', async () => {
    vi.mocked(apiClient.get).mockResolvedValueOnce(mockPinsResponse([]));

    render(<IPFSPinMonitor />);

    expect(await screen.findByText(/No CIDs are currently tracked/)).toBeTruthy();
  });

  it('shows an error state when the list request fails', async () => {
    vi.mocked(apiClient.get).mockRejectedValueOnce(new Error('Network error'));

    render(<IPFSPinMonitor />);

    expect(await screen.findByText(/Failed to load IPFS pin status/)).toBeTruthy();
    expect(screen.getByText('Network error')).toBeTruthy();
  });

  it('calls the re-pin endpoint when the Re-Pin button is clicked and refreshes the table', async () => {
    vi.mocked(apiClient.get)
      .mockResolvedValueOnce(mockPinsResponse([FAILED_RECORD]))
      .mockResolvedValueOnce(
        mockPinsResponse([{ ...FAILED_RECORD, pinned: true, failureCount: 0, status: 'pinned' }])
      );
    vi.mocked(apiClient.post).mockResolvedValueOnce({
      success: true,
      data: { cid: FAILED_RECORD.cid, pinned: true, message: 'Re-pin successful' },
    });

    render(<IPFSPinMonitor />);

    const rePinButton = await screen.findByRole('button', { name: 'Re-Pin' });
    fireEvent.click(rePinButton);

    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith(`/api/admin/ipfs/re-pin/${FAILED_RECORD.cid}`)
    );

    expect(await screen.findByText('Re-pin successful')).toBeTruthy();
    // Table reload triggered after a successful re-pin
    await waitFor(() => expect(apiClient.get).toHaveBeenCalledTimes(2));
  });

  it('shows an error message when the re-pin request fails', async () => {
    vi.mocked(apiClient.get).mockResolvedValueOnce(mockPinsResponse([FAILED_RECORD]));
    vi.mocked(apiClient.post).mockRejectedValueOnce(new Error('Pinata unavailable'));

    render(<IPFSPinMonitor />);

    const rePinButton = await screen.findByRole('button', { name: 'Re-Pin' });
    fireEvent.click(rePinButton);

    expect(await screen.findByText('Pinata unavailable')).toBeTruthy();
  });

  it('auto-refreshes the pin list on the configured interval', async () => {
    vi.useFakeTimers();
    vi.mocked(apiClient.get).mockResolvedValue(mockPinsResponse([PINNED_RECORD]));

    render(<IPFSPinMonitor refreshIntervalMs={30_000} />);

    await waitFor(() => expect(apiClient.get).toHaveBeenCalledTimes(1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(apiClient.get).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(apiClient.get).toHaveBeenCalledTimes(3);
  });

  it('clears the auto-refresh interval on unmount', async () => {
    vi.useFakeTimers();
    vi.mocked(apiClient.get).mockResolvedValue(mockPinsResponse([PINNED_RECORD]));

    const { unmount } = render(<IPFSPinMonitor refreshIntervalMs={30_000} />);
    await waitFor(() => expect(apiClient.get).toHaveBeenCalledTimes(1));

    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    // No further calls should have been made after unmount
    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });
});
