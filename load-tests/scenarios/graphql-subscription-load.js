/**
 * GraphQL Subscription Throughput — 200 Concurrent WebSocket Connections
 * load-tests/scenarios/graphql-subscription-load.js
 *
 * Opens SUB_VUS (default 200) concurrent `graphql-ws` connections subscribed
 * to `tokenDeployed`, then drives EVENT_COUNT (default 100) real deploy
 * events through the existing `POST /api/tokens/batch` endpoint (the same
 * endpoint that powers `batchTokenDeployService`'s `eventBus.publish(
 * "token.deployed", ...)` call) and asserts every subscriber receives every
 * event exactly once, with bounded delivery latency and bounded server
 * memory growth.
 *
 * Topology (two scenarios sharing one run, staggered by startTime so every
 * subscriber is connected and subscribed before the emitter fires):
 *   - "subscribers" : SUB_VUS VUs, 1 iteration each, open+listen for LISTEN_WINDOW_MS
 *   - "emitter"     : 1 VU,        1 iteration,      starts EMIT_START_DELAY_MS in
 *
 * IMPORTANT — known contract risk this load test is designed to surface:
 * `batchTokenDeployService.deployToken` publishes `{ address, creator, ... }`
 * onto the eventBus, while the subscription resolver's tenant filter
 * (`tenantOwnsEvent`) and `TokenDeployedPayload` type expect `creatorAddress`
 * / `tokenAddress` / `txHash` / `timestamp`. If those field names have not
 * been reconciled, every subscriber will legitimately receive zero messages
 * and this scenario's thresholds will fail — that is the load test correctly
 * catching a real producer/consumer mismatch, not a bug in the scenario.
 *
 * Thresholds:
 *   sub_message_latency_ms : p99 < 500 ms
 *   sub_loss_events        : count == 0  (zero message loss)
 *   sub_duplicate_events    : count == 0  (zero duplicate delivery)
 *   memory_growth_bytes     : < 50 MB
 *
 * Environment variables:
 *   BASE_URL            API base URL, http(s) (default: http://localhost:3001)
 *   WS_PATH             GraphQL WS path (default: /graphql)
 *   SUB_VUS             Concurrent subscribers (default: 200)
 *   EVENT_COUNT         Events emitted (default: 100)
 *   BATCH_SIZE          Tokens per /api/tokens/batch request (default: 10, server max)
 *   JWT_SECRET           Must match the server's JWT_SECRET (default: dev-secret-key)
 *   LISTEN_WINDOW_MS     How long each subscriber stays connected (default: 25000)
 *   EMIT_START_DELAY_MS  Delay before the emitter fires, to let subscriptions
 *                        establish first (default: 8000)
 *
 * Run:
 *   k6 run load-tests/scenarios/graphql-subscription-load.js
 */

import ws from 'k6/ws';
import http from 'k6/http';
import crypto from 'k6/crypto';
import encoding from 'k6/encoding';
import { check, sleep } from 'k6';
import { Trend, Counter, Gauge } from 'k6/metrics';
import { config } from '../config/test-config.js';
import {
  buildTokenDeployedSubscriptionQuery,
  buildSubscribeMessage,
  buildConnectionInitMessage,
  parseWsMessage,
  isNextMessageForSubscription,
  extractEmittedAtFromMetadataUri,
  computeMessageLatencyMs,
  buildBatchTokenPayload,
  chunkIntoBatches,
} from '../lib/graphql-subscription-helpers.js';

// ── Parameters ────────────────────────────────────────────────────────────

const BASE_URL = __ENV.BASE_URL || config.baseUrl;
const WS_PATH = __ENV.WS_PATH || '/graphql';
const SUB_VUS = parseInt(__ENV.SUB_VUS || '200');
const EVENT_COUNT = parseInt(__ENV.EVENT_COUNT || '100');
const BATCH_SIZE = parseInt(__ENV.BATCH_SIZE || '10');
const JWT_SECRET = __ENV.JWT_SECRET || 'dev-secret-key';
const LISTEN_WINDOW_MS = parseInt(__ENV.LISTEN_WINDOW_MS || '25000');
const EMIT_START_DELAY_MS = parseInt(__ENV.EMIT_START_DELAY_MS || '8000');
const MAX_MEMORY_GROWTH_BYTES = 50 * 1024 * 1024;

const WS_URL = `${BASE_URL.replace(/^http/, 'ws')}${WS_PATH}`;
const CREATOR = 'LOADTESTSUBSCRIPTIONCREATOR01';
const GRAPHQL_WS_PROTOCOL = 'graphql-transport-ws';

// ── Custom metrics ────────────────────────────────────────────────────────

const messageLatency = new Trend('sub_message_latency_ms');
const receivedPerSubscriber = new Trend('sub_received_count');
const lossEvents = new Counter('sub_loss_events');
const duplicateEvents = new Counter('sub_duplicate_events');
const memoryGrowthBytes = new Gauge('memory_growth_bytes');
const emitAckRate = new Counter('emit_batches_acknowledged');

// ── Options ───────────────────────────────────────────────────────────────

export const options = {
  scenarios: {
    subscribers: {
      executor: 'per-vu-iterations',
      vus: SUB_VUS,
      iterations: 1,
      maxDuration: `${Math.ceil(LISTEN_WINDOW_MS / 1000) + 30}s`,
      exec: 'subscriberScenario',
    },
    emitter: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      startTime: `${EMIT_START_DELAY_MS}ms`,
      maxDuration: '30s',
      exec: 'emitterScenario',
    },
  },
  thresholds: {
    sub_message_latency_ms: ['p(99)<500'],
    sub_loss_events: ['count<1'],
    sub_duplicate_events: ['count<1'],
    memory_growth_bytes: [`value<${MAX_MEMORY_GROWTH_BYTES}`],
  },
  tags: { test_type: 'graphql_subscription_load' },
};

// ── JWT (HS256) — must match the server's connection_init JWT contract ────

function signJwtHS256(payload, secret) {
  const headerB64 = encoding.b64encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'rawurl');
  const payloadB64 = encoding.b64encode(JSON.stringify(payload), 'rawurl');
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = crypto.hmac('sha256', secret, signingInput, 'rawurl');
  return `${signingInput}.${signature}`;
}

// ── Lifecycle hooks ────────────────────────────────────────────────────────

export function setup() {
  const before = http.get(`${BASE_URL}/health`).json('data.metrics.memory.used') || 0;
  const jwt = signJwtHS256(
    { tenantId: CREATOR, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 },
    JWT_SECRET
  );
  return { jwt, creator: CREATOR, beforeMemoryBytes: before };
}

export function teardown(data) {
  const after = http.get(`${BASE_URL}/health`).json('data.metrics.memory.used') || 0;
  memoryGrowthBytes.add(after - data.beforeMemoryBytes);
}

// ── Subscriber VU ─────────────────────────────────────────────────────────

export function subscriberScenario(data) {
  const opId = `op-${__VU}`;
  const query = buildTokenDeployedSubscriptionQuery(data.creator);
  let received = 0;

  const res = ws.connect(
    WS_URL,
    { headers: { 'Sec-WebSocket-Protocol': GRAPHQL_WS_PROTOCOL } },
    (socket) => {
      socket.on('open', () => {
        socket.send(buildConnectionInitMessage(data.jwt));
      });

      socket.on('message', (raw) => {
        const msg = parseWsMessage(raw);
        if (!msg) return;

        if (msg.type === 'connection_ack') {
          socket.send(buildSubscribeMessage(opId, query));
          return;
        }

        if (isNextMessageForSubscription(msg, opId)) {
          received += 1;
          const emittedAt = extractEmittedAtFromMetadataUri(msg.payload.data?.tokenDeployed?.metadataUri);
          const latency = computeMessageLatencyMs(Date.now(), emittedAt);
          if (latency !== null) messageLatency.add(latency);
        }
      });

      socket.setTimeout(() => socket.close(), LISTEN_WINDOW_MS);
    }
  );

  check(res, { 'websocket handshake succeeded': (r) => r && r.status === 101 });

  receivedPerSubscriber.add(received);
  if (received < EVENT_COUNT) lossEvents.add(1);
  if (received > EVENT_COUNT) duplicateEvents.add(1);
}

// ── Emitter VU ─────────────────────────────────────────────────────────────

export function emitterScenario(data) {
  const tokens = Array.from({ length: EVENT_COUNT }, (_, i) =>
    buildBatchTokenPayload(data.creator, i, Date.now())
  );

  for (const batch of chunkIntoBatches(tokens, BATCH_SIZE)) {
    const res = http.post(
      `${BASE_URL}/api/tokens/batch`,
      JSON.stringify({ tokens: batch }),
      {
        headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': data.creator },
        tags: { name: 'BatchTokenDeploy' },
      }
    );

    const ok = res.status === 200 || res.status === 207;
    emitAckRate.add(ok ? 1 : 0);
    check(res, { 'batch deploy accepted (200/207)': () => ok });

    sleep(0.2);
  }
}

// ── Summary ───────────────────────────────────────────────────────────────

export function handleSummary(data) {
  const recv = data.metrics.sub_received_count?.values ?? {};
  const lat99 = data.metrics.sub_message_latency_ms?.values?.['p(99)'] ?? 0;
  const loss = data.metrics.sub_loss_events?.values?.count ?? 0;
  const dupes = data.metrics.sub_duplicate_events?.values?.count ?? 0;
  const growth = data.metrics.memory_growth_bytes?.values?.value ?? 0;

  const passed = loss === 0 && dupes === 0 && lat99 < 500 && growth < MAX_MEMORY_GROWTH_BYTES;
  const status = passed ? 'PASSED' : 'FAILED';

  const summary = {
    passed,
    timestamp: new Date().toISOString(),
    subscribers: SUB_VUS,
    eventsEmitted: EVENT_COUNT,
    messagesPerSubscriber: { min: recv.min ?? 0, max: recv.max ?? 0, avg: recv.avg ?? 0 },
    lossEvents: loss,
    duplicateEvents: dupes,
    latencyP99Ms: lat99,
    memoryGrowthBytes: growth,
  };

  const lines = [
    '',
    `=== GraphQL Subscription Load (${SUB_VUS} connections) — ${status} ===`,
    `  Timestamp           : ${summary.timestamp}`,
    `  Subscribers         : ${SUB_VUS}`,
    `  Events emitted      : ${EVENT_COUNT}`,
    `  Msgs/subscriber     : min ${summary.messagesPerSubscriber.min} · max ${summary.messagesPerSubscriber.max} · avg ${summary.messagesPerSubscriber.avg.toFixed(1)}`,
    `  Subscribers w/ loss : ${loss}`,
    `  Subscribers w/ dupes: ${dupes}`,
    `  Latency p99 (ms)    : ${lat99.toFixed(1)}  (threshold: < 500)`,
    `  Memory growth (MB)  : ${(growth / (1024 * 1024)).toFixed(2)}  (threshold: < 50)`,
    '',
  ].join('\n');

  return {
    'load-tests/results/graphql-subscription-load-summary.json': JSON.stringify(summary, null, 2),
    stdout: lines,
  };
}
