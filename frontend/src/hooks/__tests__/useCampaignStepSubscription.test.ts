import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import {
  useCampaignStepSubscription,
  type CampaignStepExecutedEvent,
} from '../useCampaignStepSubscription';

/** Minimal fake of the WebSocket API driven manually from each test. */
class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string, public protocol: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.onclose?.();
  }

  /** Test helper: simulate the server sending a graphql-ws message. */
  emit(message: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
});

function latestSocket(): FakeWebSocket {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

describe('useCampaignStepSubscription', () => {
  it('performs the connection_init -> subscribe handshake and reports connected', async () => {
    const onStepExecuted = vi.fn();

    const { result } = renderHook(() =>
      useCampaignStepSubscription({
        campaignId: 1,
        onStepExecuted,
        wsUrl: 'ws://test/graphql',
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      })
    );

    const socket = latestSocket();
    socket.onopen?.();
    expect(JSON.parse(socket.sent[0])).toMatchObject({ type: 'connection_init' });

    socket.emit({ type: 'connection_ack' });

    await waitFor(() => expect(result.current.connected).toBe(true));

    const subscribeMessage = JSON.parse(socket.sent[1]);
    expect(subscribeMessage.type).toBe('subscribe');
    expect(subscribeMessage.payload.variables).toEqual({ campaignId: 1 });
  });

  it('invokes onStepExecuted when a next message delivers a payload', async () => {
    const onStepExecuted = vi.fn();
    const event: CampaignStepExecutedEvent = {
      campaignId: 1,
      stepNumber: 2,
      amount: '2000',
      status: 'COMPLETED',
      txHash: 'hash3',
      executedAt: '2026-03-09T11:30:00Z',
      totalSteps: 5,
      executedAmount: '7000',
      campaignStatus: 'ACTIVE',
    };

    renderHook(() =>
      useCampaignStepSubscription({
        campaignId: 1,
        onStepExecuted,
        wsUrl: 'ws://test/graphql',
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      })
    );

    const socket = latestSocket();
    socket.onopen?.();
    socket.emit({ type: 'connection_ack' });
    socket.emit({ type: 'next', payload: { data: { campaignStepExecuted: event } } });

    expect(onStepExecuted).toHaveBeenCalledWith(event);
  });

  it('responds to server pings to keep the connection alive', () => {
    renderHook(() =>
      useCampaignStepSubscription({
        campaignId: 1,
        onStepExecuted: vi.fn(),
        wsUrl: 'ws://test/graphql',
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      })
    );

    const socket = latestSocket();
    socket.onopen?.();
    socket.emit({ type: 'connection_ack' });
    socket.emit({ type: 'ping' });

    expect(JSON.parse(socket.sent[socket.sent.length - 1])).toEqual({ type: 'pong' });
  });

  it('does not open a connection when campaignId is null', () => {
    renderHook(() =>
      useCampaignStepSubscription({
        campaignId: null,
        onStepExecuted: vi.fn(),
        wsUrl: 'ws://test/graphql',
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      })
    );

    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('sends a complete message and closes the socket on unmount', () => {
    const { unmount } = renderHook(() =>
      useCampaignStepSubscription({
        campaignId: 1,
        onStepExecuted: vi.fn(),
        wsUrl: 'ws://test/graphql',
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      })
    );

    const socket = latestSocket();
    socket.onopen?.();
    socket.emit({ type: 'connection_ack' });

    unmount();

    expect(JSON.parse(socket.sent[socket.sent.length - 1])).toMatchObject({
      type: 'complete',
    });
  });
});
