/**
 * useCampaignStepSubscription
 *
 * Subscribes to the backend's `campaignStepExecuted` GraphQL subscription over
 * the graphql-transport-ws protocol and invokes `onStepExecuted` whenever a
 * buyback campaign step completes on-chain. Intended to run alongside (not
 * replace) the dashboard's existing REST fetch — it's a real-time nudge to
 * refetch/patch state immediately instead of waiting on the next poll.
 *
 * A minimal hand-rolled client is used here (rather than the `graphql-ws`
 * package) since the frontend has no GraphQL client dependency yet; this
 * implements just the handful of message types the dashboard needs.
 *
 * Usage:
 *   const { connected } = useCampaignStepSubscription({
 *     campaignId,
 *     onStepExecuted: (event) => { ... },
 *   });
 */
import { useEffect, useRef, useState } from 'react';

export interface CampaignStepExecutedEvent {
  campaignId: number;
  stepNumber: number;
  amount: string;
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  txHash: string;
  executedAt: string;
  totalSteps: number;
  executedAmount: string;
  campaignStatus: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
}

export interface UseCampaignStepSubscriptionOptions {
  /** Campaign to subscribe to. Subscription is torn down when null. */
  campaignId: number | null;
  /** Invoked for every delivered `campaignStepExecuted` event. */
  onStepExecuted: (event: CampaignStepExecutedEvent) => void;
  /** Auth token forwarded to the connection_init handshake, if any. */
  authToken?: string | null;
  /** Override the derived ws(s):// endpoint — primarily for tests. */
  wsUrl?: string;
  /** Override the WebSocket constructor — primarily for tests. */
  WebSocketImpl?: typeof WebSocket;
  /** Reconnect backoff in ms — default 2000. */
  reconnectDelayMs?: number;
  /** Override the REST base URL for catchup calls — primarily for tests. */
  restBaseUrl?: string;
}

export interface UseCampaignStepSubscriptionReturn {
  /** True once the connection_ack handshake has completed. */
  connected: boolean;
  /** True when the server signalled truncation and a full refresh is needed. */
  needsFullRefresh: boolean;
}

const SUBSCRIPTION_QUERY = /* GraphQL */ `
  subscription OnCampaignStepExecuted($campaignId: Int) {
    campaignStepExecuted(campaignId: $campaignId) {
      campaignId
      stepNumber
      amount
      status
      txHash
      executedAt
      totalSteps
      executedAmount
      campaignStatus
    }
  }
`;

function deriveWsUrl(): string {
  const backendUrl = import.meta.env.VITE_BACKEND_URL ?? '';
  if (backendUrl) {
    return `${backendUrl.replace(/^http/, 'ws')}/graphql`;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.host}/graphql`;
}

export function useCampaignStepSubscription({
  campaignId,
  onStepExecuted,
  authToken,
  wsUrl,
  WebSocketImpl,
  reconnectDelayMs = 2_000,
  restBaseUrl,
}: UseCampaignStepSubscriptionOptions): UseCampaignStepSubscriptionReturn {
  const [connected, setConnected] = useState(false);
  const [needsFullRefresh, setNeedsFullRefresh] = useState(false);

  const onStepExecutedRef = useRef(onStepExecuted);
  onStepExecutedRef.current = onStepExecuted;
  const authTokenRef = useRef(authToken);
  authTokenRef.current = authToken;

  /** Last received event sequence number — persists across reconnects. */
  const lastSequenceRef = useRef<number>(0);

  useEffect(() => {
    if (campaignId === null) {
      setConnected(false);
      return;
    }

    const Impl = WebSocketImpl ?? WebSocket;
    const url = wsUrl ?? deriveWsUrl();
    const subscriptionId = 'campaign-step-executed';

    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    /** Fetch missed events via REST catchup then resume live subscription. */
    async function runCatchup(): Promise<void> {
      const since = lastSequenceRef.current;
      if (since === 0) return; // first connect — no catchup needed

      const base = restBaseUrl ?? (typeof import.meta !== 'undefined'
        ? ((import.meta as any)?.env?.VITE_API_BASE_URL ?? '')
        : '');

      try {
        const res = await fetch(`${base}/api/events/catchup?since=${since}`);
        if (!res.ok) return;
        const body: {
          truncated: boolean;
          currentSequence?: number;
          events?: Array<{ payload?: { campaignStepExecuted?: CampaignStepExecutedEvent }; sequence?: number }>;
        } = await res.json();

        if (body.truncated) {
          setNeedsFullRefresh(true);
          return;
        }

        for (const ev of body.events ?? []) {
          const data = ev.payload as any;
          // The event payload may be the raw step event or wrapped under campaignStepExecuted
          const step: CampaignStepExecutedEvent | undefined =
            data?.campaignStepExecuted ?? (data?.campaignId !== undefined ? data : undefined);
          if (step) onStepExecutedRef.current(step);
          if (ev.sequence != null) lastSequenceRef.current = ev.sequence;
        }
      } catch {
        // Non-fatal — live events will cover any remaining gap
      }
    }

    function connect() {
      socket = new Impl(url, 'graphql-transport-ws');

      socket.onopen = () => {
        const initPayload = authTokenRef.current
          ? { authorization: `Bearer ${authTokenRef.current}` }
          : {};
        socket?.send(
          JSON.stringify({ type: 'connection_init', payload: initPayload })
        );
      };

      socket.onmessage = (rawEvent: MessageEvent) => {
        let message: { type?: string; id?: string; payload?: unknown };
        try {
          message = JSON.parse(rawEvent.data as string);
        } catch {
          return;
        }

        switch (message.type) {
          case 'connection_ack':
            // Run catchup before marking connected so callers see events in order
            void runCatchup().then(() => {
              setConnected(true);
              socket?.send(
                JSON.stringify({
                  id: subscriptionId,
                  type: 'subscribe',
                  payload: {
                    query: SUBSCRIPTION_QUERY,
                    variables: { campaignId },
                  },
                })
              );
            });
            break;
          case 'next': {
            const data = (
              message.payload as {
                data?: { campaignStepExecuted?: CampaignStepExecutedEvent & { sequence?: number } };
              }
            )?.data?.campaignStepExecuted;
            if (data) {
              if (data.sequence != null) lastSequenceRef.current = data.sequence;
              onStepExecutedRef.current(data);
            }
            break;
          }
          case 'ping':
            socket?.send(JSON.stringify({ type: 'pong' }));
            break;
          default:
            break;
        }
      };

      socket.onclose = () => {
        setConnected(false);
        if (!stopped) {
          reconnectTimer = setTimeout(connect, reconnectDelayMs);
        }
      };

      socket.onerror = () => {
        // onclose follows; reconnection is handled there.
      };
    }

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (socket) {
        if (socket.readyState === Impl.OPEN) {
          socket.send(JSON.stringify({ id: subscriptionId, type: 'complete' }));
        }
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        socket.close();
      }
    };
  }, [campaignId, wsUrl, WebSocketImpl, reconnectDelayMs, restBaseUrl]);

  return { connected, needsFullRefresh };
}
