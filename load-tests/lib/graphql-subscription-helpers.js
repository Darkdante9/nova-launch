/**
 * Pure helper functions for the GraphQL subscription load scenario
 * (200 concurrent `tokenDeployed` WebSocket subscribers, 100 emitted events).
 *
 * These helpers contain no k6 imports and are unit-testable with vitest.
 */

/**
 * Build the `tokenDeployed` subscription document, optionally filtered by
 * creator address (matches the scenario's tenant-scoped test data).
 *
 * @param {string} [creatorAddress]
 * @returns {string}
 */
export function buildTokenDeployedSubscriptionQuery(creatorAddress) {
  const args = creatorAddress ? `(creatorAddress: "${creatorAddress}")` : '';
  return `subscription TokenDeployedLoad {
    tokenDeployed${args} {
      tokenAddress
      name
      symbol
      totalSupply
      txHash
      timestamp
    }
  }`;
}

/**
 * Build a graphql-ws `subscribe` protocol message.
 *
 * @param {string} id            Unique operation id for this connection.
 * @param {string} query         GraphQL subscription document.
 * @param {object} [variables]
 * @returns {string} JSON-encoded message ready to send over the socket.
 */
export function buildSubscribeMessage(id, query, variables = {}) {
  return JSON.stringify({
    id,
    type: 'subscribe',
    payload: { query, variables },
  });
}

/**
 * Build a graphql-ws `connection_init` protocol message carrying the bearer
 * token used for tenant resolution on the server's `onConnect` handshake.
 *
 * @param {string} jwt
 * @returns {string}
 */
export function buildConnectionInitMessage(jwt) {
  return JSON.stringify({
    type: 'connection_init',
    payload: { authorization: `Bearer ${jwt}` },
  });
}

/**
 * Safely parse a raw WebSocket text frame as JSON.
 *
 * @param {string} raw
 * @returns {object|null} Parsed message, or null if not valid JSON.
 */
export function parseWsMessage(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * True when `msg` is a graphql-ws `next` event delivering data for the
 * given subscription operation id.
 *
 * @param {object|null} msg
 * @param {string} id
 * @returns {boolean}
 */
export function isNextMessageForSubscription(msg, id) {
  return Boolean(msg) && msg.type === 'next' && msg.id === id && Boolean(msg.payload?.data);
}

/**
 * Extract the `ts` (emitted-at epoch ms) query parameter embedded in a
 * synthetic `metadataUri`, used to approximate end-to-end delivery latency
 * without requiring shared state across k6 VUs.
 *
 * @param {string|null|undefined} metadataUri
 * @returns {number|null}
 */
export function extractEmittedAtFromMetadataUri(metadataUri) {
  if (!metadataUri) return null;
  const match = /[?&]ts=(\d+)/.exec(metadataUri);
  if (!match) return null;
  const ts = parseInt(match[1], 10);
  return Number.isFinite(ts) ? ts : null;
}

/**
 * Compute message delivery latency in milliseconds.
 *
 * @param {number} receivedAtMs
 * @param {number|null} emittedAtMs
 * @returns {number|null} null when emittedAtMs is unavailable.
 */
export function computeMessageLatencyMs(receivedAtMs, emittedAtMs) {
  if (emittedAtMs === null || emittedAtMs === undefined) return null;
  return Math.max(0, receivedAtMs - emittedAtMs);
}

/**
 * Build one synthetic token-deploy input for the `/api/tokens/batch`
 * endpoint, embedding the emission timestamp in `metadataUri` for latency
 * tracking by subscribers.
 *
 * @param {string} creator     Tenant/creator address shared by the whole run.
 * @param {number} index       Global event index (0-based) — kept unique.
 * @param {number} sentAtMs    Epoch ms when this batch is being sent.
 * @returns {object}
 */
export function buildBatchTokenPayload(creator, index, sentAtMs) {
  return {
    creator,
    name: `Load Test Token ${index}`,
    symbol: `LT${index}`,
    decimals: 7,
    initialSupply: '1000000',
    metadataUri: `https://load-test.local/meta?ts=${sentAtMs}&i=${index}`,
  };
}

/**
 * Split a flat array into chunks of at most `size` items — used to respect
 * the `/api/tokens/batch` endpoint's per-request item cap.
 *
 * @param {Array<*>} items
 * @param {number} size
 * @returns {Array<Array<*>>}
 */
export function chunkIntoBatches(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Summarize per-subscriber message counts into an overall pass/fail report.
 *
 * @param {Array<{ received: number }>} subscriberResults
 * @param {number} expectedPerSubscriber
 * @returns {{ totalSubscribers: number, expectedPerSubscriber: number,
 *             subscribersWithLoss: number, subscribersWithDuplicates: number,
 *             totalMessagesReceived: number, passed: boolean }}
 */
export function summarizeSubscriberResults(subscriberResults, expectedPerSubscriber) {
  let subscribersWithLoss = 0;
  let subscribersWithDuplicates = 0;
  let totalMessagesReceived = 0;

  for (const r of subscriberResults) {
    totalMessagesReceived += r.received;
    if (r.received < expectedPerSubscriber) subscribersWithLoss += 1;
    if (r.received > expectedPerSubscriber) subscribersWithDuplicates += 1;
  }

  return {
    totalSubscribers: subscriberResults.length,
    expectedPerSubscriber,
    subscribersWithLoss,
    subscribersWithDuplicates,
    totalMessagesReceived,
    passed:
      subscriberResults.length > 0 &&
      subscribersWithLoss === 0 &&
      subscribersWithDuplicates === 0,
  };
}

/**
 * Assess whether server memory growth across the run stays within budget.
 *
 * @param {number} beforeBytes
 * @param {number} afterBytes
 * @param {number} maxGrowthBytes
 * @returns {{ growthBytes: number, withinBudget: boolean }}
 */
export function assessMemoryGrowth(beforeBytes, afterBytes, maxGrowthBytes) {
  const growthBytes = afterBytes - beforeBytes;
  return { growthBytes, withinBudget: growthBytes < maxGrowthBytes };
}

/**
 * Format the final run summary for stdout.
 *
 * @param {ReturnType<typeof summarizeSubscriberResults>} report
 * @param {{ growthBytes: number, withinBudget: boolean }} memory
 * @param {{ p99: number }} latency
 * @param {string} [timestamp]
 * @returns {string}
 */
export function formatSubscriptionLoadSummary(report, memory, latency, timestamp = new Date().toISOString()) {
  const status = report.passed && memory.withinBudget ? 'PASSED' : 'FAILED';
  return [
    '',
    `=== GraphQL Subscription Load (200 connections) — ${status} ===`,
    `  Timestamp              : ${timestamp}`,
    `  Subscribers             : ${report.totalSubscribers}`,
    `  Expected msgs/subscriber: ${report.expectedPerSubscriber}`,
    `  Total messages received : ${report.totalMessagesReceived}`,
    `  Subscribers with loss   : ${report.subscribersWithLoss}`,
    `  Subscribers with dupes  : ${report.subscribersWithDuplicates}`,
    '',
    `  Message latency p99 (ms): ${latency.p99.toFixed(1)}  (threshold: < 500)`,
    '',
    `  Memory growth (MB)      : ${(memory.growthBytes / (1024 * 1024)).toFixed(2)}  (threshold: < 50)`,
    '',
  ].join('\n');
}
