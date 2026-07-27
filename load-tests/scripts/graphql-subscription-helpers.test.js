import { describe, it, expect } from 'vitest';
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
  summarizeSubscriberResults,
  assessMemoryGrowth,
  formatSubscriptionLoadSummary,
} from '../lib/graphql-subscription-helpers.js';

// ── buildTokenDeployedSubscriptionQuery ───────────────────────────────────

describe('buildTokenDeployedSubscriptionQuery', () => {
  it('includes the creatorAddress filter when provided', () => {
    const q = buildTokenDeployedSubscriptionQuery('GCREATOR1');
    expect(q).toContain('creatorAddress: "GCREATOR1"');
    expect(q).toContain('tokenDeployed');
  });

  it('omits the filter argument when no creator is provided', () => {
    const q = buildTokenDeployedSubscriptionQuery();
    expect(q).not.toContain('creatorAddress');
  });
});

// ── buildSubscribeMessage / buildConnectionInitMessage ────────────────────

describe('buildSubscribeMessage', () => {
  it('produces a valid graphql-ws subscribe envelope', () => {
    const msg = JSON.parse(buildSubscribeMessage('op-1', 'subscription { x }', { a: 1 }));
    expect(msg).toEqual({ id: 'op-1', type: 'subscribe', payload: { query: 'subscription { x }', variables: { a: 1 } } });
  });
});

describe('buildConnectionInitMessage', () => {
  it('wraps the JWT as a Bearer authorization payload', () => {
    const msg = JSON.parse(buildConnectionInitMessage('abc.def.ghi'));
    expect(msg).toEqual({ type: 'connection_init', payload: { authorization: 'Bearer abc.def.ghi' } });
  });
});

// ── parseWsMessage ─────────────────────────────────────────────────────────

describe('parseWsMessage', () => {
  it('parses valid JSON', () => {
    expect(parseWsMessage('{"a":1}')).toEqual({ a: 1 });
  });

  it('returns null for invalid JSON', () => {
    expect(parseWsMessage('not json')).toBeNull();
  });
});

// ── isNextMessageForSubscription ──────────────────────────────────────────

describe('isNextMessageForSubscription', () => {
  it('matches a well-formed next message for the given id', () => {
    const msg = { id: 'op-1', type: 'next', payload: { data: { tokenDeployed: {} } } };
    expect(isNextMessageForSubscription(msg, 'op-1')).toBe(true);
  });

  it('rejects messages for a different operation id', () => {
    const msg = { id: 'op-2', type: 'next', payload: { data: {} } };
    expect(isNextMessageForSubscription(msg, 'op-1')).toBe(false);
  });

  it('rejects non-next message types', () => {
    expect(isNextMessageForSubscription({ id: 'op-1', type: 'complete' }, 'op-1')).toBe(false);
  });

  it('rejects null messages', () => {
    expect(isNextMessageForSubscription(null, 'op-1')).toBe(false);
  });

  it('rejects next messages with no payload data', () => {
    expect(isNextMessageForSubscription({ id: 'op-1', type: 'next', payload: {} }, 'op-1')).toBe(false);
  });
});

// ── extractEmittedAtFromMetadataUri ───────────────────────────────────────

describe('extractEmittedAtFromMetadataUri', () => {
  it('extracts the ts query param', () => {
    expect(extractEmittedAtFromMetadataUri('https://x.local/meta?ts=1700000000000&i=3')).toBe(1700000000000);
  });

  it('returns null when ts is absent', () => {
    expect(extractEmittedAtFromMetadataUri('https://x.local/meta?i=3')).toBeNull();
  });

  it('returns null for null/undefined input', () => {
    expect(extractEmittedAtFromMetadataUri(null)).toBeNull();
    expect(extractEmittedAtFromMetadataUri(undefined)).toBeNull();
  });
});

// ── computeMessageLatencyMs ────────────────────────────────────────────────

describe('computeMessageLatencyMs', () => {
  it('computes the difference between receipt and emission time', () => {
    expect(computeMessageLatencyMs(1000, 800)).toBe(200);
  });

  it('clamps negative latency (clock skew) to zero', () => {
    expect(computeMessageLatencyMs(800, 1000)).toBe(0);
  });

  it('returns null when emittedAtMs is unavailable', () => {
    expect(computeMessageLatencyMs(1000, null)).toBeNull();
  });
});

// ── buildBatchTokenPayload ─────────────────────────────────────────────────

describe('buildBatchTokenPayload', () => {
  it('builds a schema-shaped token input with a unique symbol per index', () => {
    const token = buildBatchTokenPayload('GCREATOR1', 7, 1700000000000);
    expect(token.creator).toBe('GCREATOR1');
    expect(token.symbol).toBe('LT7');
    expect(token.decimals).toBe(7);
    expect(token.initialSupply).toBe('1000000');
    expect(token.metadataUri).toContain('ts=1700000000000');
    expect(token.metadataUri).toContain('i=7');
  });

  it('produces a valid URL for metadataUri', () => {
    const token = buildBatchTokenPayload('GCREATOR1', 0, 1700000000000);
    expect(() => new URL(token.metadataUri)).not.toThrow();
  });
});

// ── chunkIntoBatches ───────────────────────────────────────────────────────

describe('chunkIntoBatches', () => {
  it('splits evenly divisible arrays', () => {
    const chunks = chunkIntoBatches(Array.from({ length: 100 }, (_, i) => i), 10);
    expect(chunks).toHaveLength(10);
    expect(chunks[0]).toHaveLength(10);
  });

  it('handles a remainder chunk', () => {
    const chunks = chunkIntoBatches(Array.from({ length: 23 }, (_, i) => i), 10);
    expect(chunks).toHaveLength(3);
    expect(chunks[2]).toHaveLength(3);
  });

  it('returns an empty array for empty input', () => {
    expect(chunkIntoBatches([], 10)).toEqual([]);
  });
});

// ── summarizeSubscriberResults ─────────────────────────────────────────────

describe('summarizeSubscriberResults', () => {
  it('passes when every subscriber received exactly the expected count', () => {
    const results = Array.from({ length: 200 }, () => ({ received: 100 }));
    const report = summarizeSubscriberResults(results, 100);
    expect(report.passed).toBe(true);
    expect(report.subscribersWithLoss).toBe(0);
    expect(report.subscribersWithDuplicates).toBe(0);
    expect(report.totalMessagesReceived).toBe(20000);
  });

  it('flags subscribers with message loss', () => {
    const results = [{ received: 100 }, { received: 97 }];
    const report = summarizeSubscriberResults(results, 100);
    expect(report.passed).toBe(false);
    expect(report.subscribersWithLoss).toBe(1);
  });

  it('flags subscribers with duplicate delivery', () => {
    const results = [{ received: 100 }, { received: 103 }];
    const report = summarizeSubscriberResults(results, 100);
    expect(report.passed).toBe(false);
    expect(report.subscribersWithDuplicates).toBe(1);
  });

  it('fails when there are zero subscribers', () => {
    expect(summarizeSubscriberResults([], 100).passed).toBe(false);
  });
});

// ── assessMemoryGrowth ─────────────────────────────────────────────────────

describe('assessMemoryGrowth', () => {
  const MB = 1024 * 1024;

  it('passes when growth is under budget', () => {
    const result = assessMemoryGrowth(100 * MB, 130 * MB, 50 * MB);
    expect(result.growthBytes).toBe(30 * MB);
    expect(result.withinBudget).toBe(true);
  });

  it('fails when growth meets or exceeds budget', () => {
    const result = assessMemoryGrowth(100 * MB, 151 * MB, 50 * MB);
    expect(result.withinBudget).toBe(false);
  });

  it('treats memory shrinkage as zero-risk', () => {
    const result = assessMemoryGrowth(150 * MB, 100 * MB, 50 * MB);
    expect(result.growthBytes).toBe(-50 * MB);
    expect(result.withinBudget).toBe(true);
  });
});

// ── formatSubscriptionLoadSummary ──────────────────────────────────────────

describe('formatSubscriptionLoadSummary', () => {
  const ts = '2026-01-01T00:00:00.000Z';

  it('reports PASSED when both the report and memory budget pass', () => {
    const report = summarizeSubscriberResults(Array.from({ length: 200 }, () => ({ received: 100 })), 100);
    const memory = assessMemoryGrowth(100 * 1024 * 1024, 110 * 1024 * 1024, 50 * 1024 * 1024);
    const text = formatSubscriptionLoadSummary(report, memory, { p99: 120 }, ts);
    expect(text).toContain('PASSED');
    expect(text).toContain('200');
    expect(text).toContain(ts);
  });

  it('reports FAILED when message loss occurred', () => {
    const report = summarizeSubscriberResults([{ received: 50 }], 100);
    const memory = assessMemoryGrowth(100 * 1024 * 1024, 110 * 1024 * 1024, 50 * 1024 * 1024);
    const text = formatSubscriptionLoadSummary(report, memory, { p99: 120 }, ts);
    expect(text).toContain('FAILED');
  });
});
