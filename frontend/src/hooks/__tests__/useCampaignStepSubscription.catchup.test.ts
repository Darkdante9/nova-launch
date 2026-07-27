/**
 * Tests — useCampaignStepSubscription catchup flow (#1372)
 *
 * Covers:
 *  1. Normal catchup: missed events delivered in order on reconnect
 *  2. Truncation: gap > 1000 sets needsFullRefresh
 *  3. No gap: catchup returns empty, live resumes immediately
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  useCampaignStepSubscription,
  type CampaignStepExecutedEvent,
} from '../useCampaignStepSubscription';

// ---------------------------------------------------------------------------
// FakeWebSocket (same pattern as existing tests)
// ---------------------------------------------------------------------------
class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string, public protocol: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) { this.sent.push(data); }
  close() { this.onclose?.(); }
  emit(msg: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

beforeEach(() => { FakeWebSocket.instances = []; });
const latest = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

const BASE_EVENT: CampaignStepExecutedEvent = {
  campaignId: 1, stepNumber: 1, amount: '100', status: 'COMPLETED',
  txHash: 'h1', executedAt: '2026-01-01T00:00:00Z',
  totalSteps: 3, executedAmount: '100', campaignStatus: 'ACTIVE',
};

function mockFetch(response: object, ok = true) {
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    json: async () => response,
  });
}

// ---------------------------------------------------------------------------
// Scenario 1 — Normal catchup: missed events delivered on reconnect
// ---------------------------------------------------------------------------
describe('catchup — normal gap', () => {
  it('replays missed events in order on reconnect', async () => {
    const missed = [
      { ...BASE_EVENT, stepNumber: 2, sequence: 2 },
      { ...BASE_EVENT, stepNumber: 3, sequence: 3 },
    ];
    mockFetch({ truncated: false, events: missed.map(e => ({ sequence: e.sequence, payload: e })), currentSequence: 3 });

    const onStepExecuted = vi.fn();
    const { result } = renderHook(() =>
      useCampaignStepSubscription({
        campaignId: 1,
        onStepExecuted,
        wsUrl: 'ws://test/graphql',
        restBaseUrl: 'http://test',
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      })
    );

    const sock = latest();
    sock.onopen?.();
    // Simulate first connection: set lastSequence to 1 via a live event
    sock.emit({ type: 'connection_ack' });

    // After ack, catchup is called (since=0 on first connect, skipped)
    await waitFor(() => expect(result.current.connected).toBe(true));

    // Simulate disconnect + reconnect to trigger catchup with non-zero lastSequence
    // First: deliver a live event to bump lastSequence
    sock.emit({
      type: 'next',
      payload: { data: { campaignStepExecuted: { ...BASE_EVENT, stepNumber: 1, sequence: 1 } } },
    });

    expect(onStepExecuted).toHaveBeenCalledTimes(1);
    expect((onStepExecuted.mock.calls[0][0] as any).stepNumber).toBe(1);

    // Now disconnect
    act(() => { sock.close(); });
    await waitFor(() => expect(result.current.connected).toBe(false));
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — Truncation: gap > 1000 → needsFullRefresh
// ---------------------------------------------------------------------------
describe('catchup — truncation', () => {
  it('sets needsFullRefresh when server responds truncated:true', async () => {
    mockFetch({ truncated: true, currentSequence: 1500 });

    const onStepExecuted = vi.fn();
    const { result } = renderHook(() =>
      useCampaignStepSubscription({
        campaignId: 1,
        onStepExecuted,
        wsUrl: 'ws://test/graphql',
        restBaseUrl: 'http://test',
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
        reconnectDelayMs: 50,
      })
    );

    const sock = latest();
    sock.onopen?.();

    // Bump lastSequence by delivering a live event, then force reconnect
    sock.emit({ type: 'connection_ack' });
    await waitFor(() => expect(result.current.connected).toBe(true));
    sock.emit({
      type: 'next',
      payload: { data: { campaignStepExecuted: { ...BASE_EVENT, sequence: 1 } } },
    });

    // Disconnect to trigger reconnect + catchup
    act(() => { sock.close(); });

    // Wait for reconnect and catchup to run
    await waitFor(() => FakeWebSocket.instances.length >= 2);
    const sock2 = latest();
    sock2.onopen?.();
    sock2.emit({ type: 'connection_ack' });

    await waitFor(() => expect(result.current.needsFullRefresh).toBe(true));
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — No gap: catchup returns empty, live resumes immediately
// ---------------------------------------------------------------------------
describe('catchup — no gap', () => {
  it('returns connected without replaying any events when no gap', async () => {
    mockFetch({ truncated: false, events: [], currentSequence: 5 });

    const onStepExecuted = vi.fn();
    const { result } = renderHook(() =>
      useCampaignStepSubscription({
        campaignId: 1,
        onStepExecuted,
        wsUrl: 'ws://test/graphql',
        restBaseUrl: 'http://test',
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      })
    );

    const sock = latest();
    sock.onopen?.();
    sock.emit({ type: 'connection_ack' });

    await waitFor(() => expect(result.current.connected).toBe(true));
    expect(result.current.needsFullRefresh).toBe(false);
    // No catchup events replayed
    expect(onStepExecuted).not.toHaveBeenCalled();
  });
});
