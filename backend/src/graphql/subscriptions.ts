/**
 * GraphQL subscription backpressure server (#1344).
 *
 * Mounts a WebSocket endpoint at /api/graphql/subscriptions using the `ws`
 * library. Each connection tracks a send-queue depth counter; when it exceeds
 * SLOW_CONSUMER_THRESHOLD the connection is force-closed with code 1008
 * (Policy Violation) and a Prometheus metric is emitted.
 *
 * Threshold: GRAPHQL_SUBSCRIPTION_QUEUE_DEPTH env var (default 1000).
 */

import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { Counter, Registry } from "prom-client";
import { register as defaultRegistry } from "../lib/metrics";

export const SLOW_CONSUMER_THRESHOLD = parseInt(
  process.env.GRAPHQL_SUBSCRIPTION_QUEUE_DEPTH ?? "1000",
  10
);

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export function createSubscriptionMetrics(registry: Registry = defaultRegistry) {
  const slowConsumerDisconnected = new Counter({
    name: "subscription_slow_consumer_disconnected_total",
    help: "WebSocket subscription connections force-disconnected due to slow consumer backpressure",
    registers: [registry],
  });
  return { slowConsumerDisconnected };
}

let _defaultMetrics: ReturnType<typeof createSubscriptionMetrics> | undefined;

function getDefaultMetrics(): ReturnType<typeof createSubscriptionMetrics> {
  if (!_defaultMetrics) {
    _defaultMetrics = createSubscriptionMetrics();
  }
  return _defaultMetrics;
}

// ---------------------------------------------------------------------------
// Per-connection state
// ---------------------------------------------------------------------------

interface ConnectionState {
  queueDepth: number;
}

const connectionState = new WeakMap<WebSocket, ConnectionState>();

/**
 * Send a message on a WebSocket, tracking queue depth.
 * Disconnects with 1008 if depth exceeds threshold.
 */
export function sendWithBackpressure(
  ws: WebSocket,
  data: string,
  threshold: number = SLOW_CONSUMER_THRESHOLD,
  metrics?: ReturnType<typeof createSubscriptionMetrics>
): void {
  const state = connectionState.get(ws);
  if (!state) return;

  state.queueDepth += 1;

  if (state.queueDepth > threshold) {
    (metrics ?? getDefaultMetrics()).slowConsumerDisconnected.inc();
    ws.close(1008, "Policy Violation: slow consumer");
    return;
  }

  ws.send(data, (err) => {
    if (err) return;
    state.queueDepth = Math.max(0, state.queueDepth - 1);
  });
}

/** Expose queue depth for a connection (tests / monitoring). */
export function getQueueDepth(ws: WebSocket): number {
  return connectionState.get(ws)?.queueDepth ?? 0;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface SubscriptionServerOptions {
  path?: string;
  threshold?: number;
  registry?: Registry;
}

/**
 * Attach a GraphQL subscription WebSocket server to an HTTP server.
 * Returns the WebSocketServer instance for teardown / testing.
 */
export function attachSubscriptionServer(
  httpServer: Server,
  options: SubscriptionServerOptions = {}
): WebSocketServer {
  const {
    path = "/api/graphql/subscriptions",
    threshold = SLOW_CONSUMER_THRESHOLD,
    registry,
  } = options;

  const metrics = registry
    ? createSubscriptionMetrics(registry)
    : getDefaultMetrics();

  const wss = new WebSocketServer({ server: httpServer, path });

  wss.on("connection", (ws: WebSocket) => {
    connectionState.set(ws, { queueDepth: 0 });

    ws.on("message", (raw: Buffer | string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: "error", payload: "Invalid JSON" }));
        return;
      }

      const { type } = msg as { type?: string };

      if (type === "connection_init") {
        ws.send(JSON.stringify({ type: "connection_ack" }));
        return;
      }

      if (type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }

      if (type === "subscribe") {
        // ACK receipt decrements depth (simulates consumer acknowledgement)
        const state = connectionState.get(ws);
        if (state && state.queueDepth > 0) {
          state.queueDepth = Math.max(0, state.queueDepth - 1);
        }
        sendWithBackpressure(
          ws,
          JSON.stringify({ type: "next", id: msg.id, payload: { data: null } }),
          threshold,
          metrics
        );
        return;
      }
    });

    ws.on("close", () => {
      connectionState.delete(ws);
    });
  });

  return wss;
}
