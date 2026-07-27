/**
 * Integration tests for useProjectionRefresh polling under network
 * degradation conditions (intermittent failures, high latency, recovery).
 *
 * `useProjectionRefresh` takes an injected `check()` function rather than
 * performing its own fetch — there is no internal HTTP boundary to
 * intercept with MSW. Network degradation is therefore simulated by making
 * the injected `check()` behave the way a degraded backend would (rejecting
 * like a transient 503, resolving slowly, or never resolving truthy),
 * exercising the hook's real status machine, attempt counting, and
 * analytics instrumentation.
 *
 * Run:
 *   npx vitest run src/hooks/__tests__/useProjectionRefresh.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useProjectionRefresh } from '../useProjectionRefresh';

vi.mock('../../services/analytics', () => ({
  analytics: { track: vi.fn() },
}));

import { analytics } from '../../services/analytics';

async function flushPoll() {
  // Let the in-flight check() promise (and its .then chain) settle.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useProjectionRefresh — network degradation', () => {
  it('keeps polling through intermittent 503-style rejections and recovers', async () => {
    const check = vi
      .fn<[], Promise<boolean>>()
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockResolvedValueOnce(true);

    const onIndexed = vi.fn();
    const { result } = renderHook(() =>
      useProjectionRefresh({ txHash: 'tx-1', check, onIndexed, intervalMs: 1000, maxAttempts: 20 })
    );

    await flushPoll();
    expect(result.current.status).toBe('polling');
    expect(result.current.attempts).toBe(1);
    expect(check).toHaveBeenCalledTimes(1);

    await advance(1000);
    expect(result.current.attempts).toBe(2);
    expect(result.current.status).toBe('polling');

    await advance(1000);
    expect(result.current.attempts).toBe(3);
    expect(result.current.status).toBe('indexed');
    expect(onIndexed).toHaveBeenCalledTimes(1);
    expect(analytics.track).toHaveBeenCalledWith(
      'projection_refresh_indexed',
      expect.objectContaining({ attempts: 3 })
    );
  });

  it('shows stale/polling state while latency is high, then recovers within the attempt budget', async () => {
    let resolveSlowCheck: (v: boolean) => void = () => {};
    const check = vi
      .fn<[], Promise<boolean>>()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSlowCheck = resolve; }))
      .mockResolvedValueOnce(true);

    const { result } = renderHook(() =>
      useProjectionRefresh({ txHash: 'tx-2', check, intervalMs: 1000, maxAttempts: 20 })
    );

    await flushPoll();
    // First check is still in flight — the hook reports 'polling' (stale
    // data should be treated as not-yet-indexed) rather than indexed.
    expect(result.current.status).toBe('polling');
    expect(result.current.attempts).toBe(1);

    await act(async () => {
      resolveSlowCheck(false);
      await Promise.resolve();
    });
    expect(result.current.status).toBe('polling');

    await advance(1000);
    expect(result.current.status).toBe('indexed');
    expect(result.current.attempts).toBe(2);
  });

  it('gives up after maxAttempts of sustained degradation and tracks the failure', async () => {
    const check = vi.fn<[], Promise<boolean>>().mockResolvedValue(false);

    const { result } = renderHook(() =>
      useProjectionRefresh({ txHash: 'tx-3', check, intervalMs: 1000, maxAttempts: 2 })
    );

    await flushPoll(); // attempt 1
    await advance(1000); // attempt 2
    await advance(1000); // attempt 3 — exceeds maxAttempts, gives up

    expect(result.current.status).toBe('failed');
    expect(check).toHaveBeenCalledTimes(3);
    expect(analytics.track).toHaveBeenCalledWith(
      'projection_refresh_failed',
      expect.objectContaining({ attempts: 3 })
    );
  });

  it('manual refresh via retry() restarts polling from attempt zero after a failure', async () => {
    const check = vi
      .fn<[], Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const { result } = renderHook(() =>
      useProjectionRefresh({ txHash: 'tx-4', check, intervalMs: 1000, maxAttempts: 1 })
    );

    await flushPoll(); // attempt 1
    await advance(1000); // attempt 2 — exceeds maxAttempts(1), fails
    expect(result.current.status).toBe('failed');

    act(() => {
      result.current.retry();
    });
    await flushPoll();

    expect(result.current.attempts).toBe(1);
    expect(result.current.status).toBe('indexed');
    expect(check).toHaveBeenCalledTimes(3);
  });

  it('stops polling and goes idle once txHash is cleared', async () => {
    const check = vi.fn<[], Promise<boolean>>().mockResolvedValue(false);

    const { result, rerender } = renderHook(
      ({ txHash }: { txHash: string | null }) =>
        useProjectionRefresh({ txHash, check, intervalMs: 1000, maxAttempts: 20 }),
      { initialProps: { txHash: 'tx-5' as string | null } }
    );

    await flushPoll();
    expect(check).toHaveBeenCalledTimes(1);

    rerender({ txHash: null });
    expect(result.current.status).toBe('idle');

    await advance(5000);
    // No further polling once stopped.
    expect(check).toHaveBeenCalledTimes(1);
  });
});
