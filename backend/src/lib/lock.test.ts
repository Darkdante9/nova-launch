/**
 * Unit tests for the distributed lock helpers in lib/lock.ts.
 *
 * Tests run entirely in-memory using a mock Redis client — no live Redis needed.
 *
 * Scenarios:
 *   U1  acquireStepLock returns acquired:true when key does not exist
 *   U2  acquireStepLock returns acquired:false when key already exists
 *   U3  acquireStepLock returns the existing holder's requestId on failure
 *   U4  releaseStepLock deletes the key and returns true when the caller is the holder
 *   U5  releaseStepLock returns false when a different requestId holds the lock
 *   U6  releaseStepLock returns false when the key has already expired/been deleted
 *   U7  stepLockKey produces the expected key format
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  acquireStepLock,
  releaseStepLock,
  stepLockKey,
  STEP_LOCK_TTL_MS,
} from './lock';

// ---------------------------------------------------------------------------
// Minimal in-memory Redis mock
// ---------------------------------------------------------------------------

function makeRedisMock() {
  const store = new Map<string, string>();

  const mock = {
    store,
    set: vi.fn(async (
      key: string,
      value: string,
      ...args: unknown[]
    ): Promise<'OK' | null> => {
      // Detect NX option (SET key val PX ttl NX)
      const isNX = args.includes('NX');
      if (isNX && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
    get: vi.fn(async (key: string): Promise<string | null> => {
      return store.get(key) ?? null;
    }),
    eval: vi.fn(async (
      _script: string,
      _numKeys: number,
      key: string,
      argv: string,
    ): Promise<number> => {
      // Implements: if GET(key) == argv then DEL(key) return 1 else return 0
      if (store.get(key) === argv) {
        store.delete(key);
        return 1;
      }
      return 0;
    }),
  };

  return mock;
}

type RedisMock = ReturnType<typeof makeRedisMock>;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('lib/lock — distributed lock helpers', () => {
  let redis: RedisMock;

  beforeEach(() => {
    redis = makeRedisMock();
  });

  // ── U7: Key format ────────────────────────────────────────────────────────

  it('U7: stepLockKey produces the expected key format', () => {
    expect(stepLockKey(42, 3)).toBe('campaign_step_lock:42:3');
    expect(stepLockKey('abc', 0)).toBe('campaign_step_lock:abc:0');
  });

  // ── U1: Acquire free lock ─────────────────────────────────────────────────

  it('U1: acquireStepLock returns acquired:true when the key does not exist', async () => {
    const result = await acquireStepLock(redis as any, 1, 0, 'req-A');

    expect(result.acquired).toBe(true);
    expect(result.holderRequestId).toBe('req-A');
    expect(redis.set).toHaveBeenCalledWith(
      stepLockKey(1, 0),
      'req-A',
      'PX',
      STEP_LOCK_TTL_MS,
      'NX',
    );
  });

  // ── U2: Acquire already-held lock ─────────────────────────────────────────

  it('U2: acquireStepLock returns acquired:false when the key already exists', async () => {
    // Pre-seed the lock as held by another request
    redis.store.set(stepLockKey(1, 0), 'req-holder');

    const result = await acquireStepLock(redis as any, 1, 0, 'req-B');

    expect(result.acquired).toBe(false);
  });

  // ── U3: Holder's requestId is returned on failure ─────────────────────────

  it('U3: acquireStepLock returns the existing holder requestId when lock is taken', async () => {
    redis.store.set(stepLockKey(5, 2), 'req-original-holder');

    const result = await acquireStepLock(redis as any, 5, 2, 'req-newcomer');

    expect(result.acquired).toBe(false);
    expect(result.holderRequestId).toBe('req-original-holder');
  });

  // ── U4: Release lock as holder ────────────────────────────────────────────

  it('U4: releaseStepLock deletes the key and returns true when called by the holder', async () => {
    redis.store.set(stepLockKey(1, 0), 'req-holder');

    const released = await releaseStepLock(redis as any, 1, 0, 'req-holder');

    expect(released).toBe(true);
    expect(redis.store.has(stepLockKey(1, 0))).toBe(false);
  });

  // ── U5: Release by non-holder is a no-op ─────────────────────────────────

  it('U5: releaseStepLock returns false when a different requestId tries to release', async () => {
    redis.store.set(stepLockKey(1, 0), 'req-real-holder');

    const released = await releaseStepLock(redis as any, 1, 0, 'req-imposter');

    expect(released).toBe(false);
    // Key must still be present
    expect(redis.store.get(stepLockKey(1, 0))).toBe('req-real-holder');
  });

  // ── U6: Release of expired/deleted key ───────────────────────────────────

  it('U6: releaseStepLock returns false when the key does not exist (already expired)', async () => {
    // Key never set
    const released = await releaseStepLock(redis as any, 1, 0, 'req-any');

    expect(released).toBe(false);
  });

  // ── Integration: acquire → release cycle ─────────────────────────────────

  it('full cycle: acquire → lock held → release → can acquire again', async () => {
    const campaignId = 10;
    const stepNumber = 1;

    // First request acquires
    const r1 = await acquireStepLock(redis as any, campaignId, stepNumber, 'req-first');
    expect(r1.acquired).toBe(true);

    // Second request is blocked
    const r2 = await acquireStepLock(redis as any, campaignId, stepNumber, 'req-second');
    expect(r2.acquired).toBe(false);
    expect(r2.holderRequestId).toBe('req-first');

    // First request releases
    const released = await releaseStepLock(redis as any, campaignId, stepNumber, 'req-first');
    expect(released).toBe(true);

    // Third request can now acquire
    const r3 = await acquireStepLock(redis as any, campaignId, stepNumber, 'req-third');
    expect(r3.acquired).toBe(true);
    expect(r3.holderRequestId).toBe('req-third');
  });

  // ── Custom TTL is forwarded ───────────────────────────────────────────────

  it('acquireStepLock uses the provided custom TTL', async () => {
    await acquireStepLock(redis as any, 1, 0, 'req-ttl', 5_000);

    expect(redis.set).toHaveBeenCalledWith(
      expect.any(String),
      'req-ttl',
      'PX',
      5_000,
      'NX',
    );
  });
});
