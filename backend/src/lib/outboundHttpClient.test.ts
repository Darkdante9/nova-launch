/**
 * Tests for OutboundHttpClient (#1389)
 *
 * Coverage:
 *  - Retries transient failures with backoff, succeeds within maxAttempts
 *  - Does not retry 4xx client errors (axios-style and plain `status`)
 *  - Gives up and throws after exhausting maxAttempts on persistent failures
 *  - Circuit breaker opens after repeated exhausted calls and fails fast
 *  - Self-registers with the shared circuit breaker registry
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  OutboundHttpClient,
  DEFAULT_OUTBOUND_RETRY_CONFIG,
} from "./outboundHttpClient";
import {
  CircuitBreakerOpenError,
  getCircuitBreakerRegistrySnapshot,
  __resetCircuitBreakerRegistryForTests,
} from "./circuitBreaker";

// Real timers with a tiny base delay so retry tests run fast and
// deterministically without needing to fight fake-timer/async interleaving.
const FAST_RETRY = { baseDelayMs: 1, maxDelayMs: 5 };

function axiosLikeError(status: number) {
  const error = new Error(`Request failed with status code ${status}`);
  (error as any).response = { status };
  return error;
}

describe("OutboundHttpClient", () => {
  beforeEach(() => {
    __resetCircuitBreakerRegistryForTests();
  });

  it("exposes sane retry defaults", () => {
    expect(DEFAULT_OUTBOUND_RETRY_CONFIG.maxAttempts).toBe(3);
  });

  it("registers itself in the shared circuit breaker registry on construction", () => {
    new OutboundHttpClient({ serviceName: "test-svc" });

    const snapshot = getCircuitBreakerRegistrySnapshot();
    expect(snapshot["test-svc"]).toEqual({
      state: "closed",
      failureCount: 0,
      successCount: 0,
      lastFailureTime: 0,
      timeSinceLastFailure: expect.any(Number),
    });
  });

  it("returns the result immediately on first-attempt success", async () => {
    const client = new OutboundHttpClient({ serviceName: "svc-success" });
    const fn = vi.fn().mockResolvedValue("ok");

    const result = await client.execute(fn);

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on a 5xx-style failure and succeeds within maxAttempts", async () => {
    const client = new OutboundHttpClient({
      serviceName: "svc-retry-success",
      retry: { ...FAST_RETRY, maxAttempts: 3 },
    });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(axiosLikeError(503))
      .mockRejectedValueOnce(axiosLikeError(503))
      .mockResolvedValueOnce("recovered");

    const result = await client.execute(fn);

    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("retries on a network error with no status", async () => {
    const client = new OutboundHttpClient({
      serviceName: "svc-network-error",
      retry: { ...FAST_RETRY, maxAttempts: 3 },
    });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce("ok");

    const result = await client.execute(fn);

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 4xx client error (axios-style response.status)", async () => {
    const client = new OutboundHttpClient({
      serviceName: "svc-4xx-axios",
      retry: { ...FAST_RETRY, maxAttempts: 3 },
    });
    const fn = vi.fn().mockRejectedValue(axiosLikeError(404));

    await expect(client.execute(fn)).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 4xx client error (plain `status` field)", async () => {
    const client = new OutboundHttpClient({
      serviceName: "svc-4xx-plain",
      retry: { ...FAST_RETRY, maxAttempts: 3 },
    });
    const error = new Error("Bad Request");
    (error as any).status = 400;
    const fn = vi.fn().mockRejectedValue(error);

    await expect(client.execute(fn)).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts on a persistent 5xx failure", async () => {
    const client = new OutboundHttpClient({
      serviceName: "svc-exhausted",
      retry: { ...FAST_RETRY, maxAttempts: 3 },
    });
    const fn = vi.fn().mockRejectedValue(axiosLikeError(503));

    await expect(client.execute(fn)).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("opens the circuit after repeated exhausted calls and fails fast", async () => {
    const client = new OutboundHttpClient({
      serviceName: "svc-circuit-open",
      retry: { ...FAST_RETRY, maxAttempts: 1 },
      circuitBreaker: { failureThreshold: 2, successThreshold: 1, timeoutMs: 60000 },
    });
    const fn = vi.fn().mockRejectedValue(axiosLikeError(503));

    await expect(client.execute(fn)).rejects.toThrow();
    await expect(client.execute(fn)).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(2);

    // Circuit is now open — the next call must fail without invoking fn.
    await expect(client.execute(fn)).rejects.toThrow(CircuitBreakerOpenError);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(client.getCircuitBreakerState()).toBe("open");
  });
});
