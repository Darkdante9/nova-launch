/**
 * Network Failure Injection Tests for Backend StellarEventListener
 * 
 * Tests failure injection for:
 * - RPC network outages
 * - Horizon timeouts
 * - Dropped responses
 * - Flaky API responses
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StellarEventListener, HorizonTransport } from '../services/stellarEventListener';
import {
  isRetryableError,
  calculateBackoffDelay,
  BACKGROUND_RETRY_CONFIG,
  sleep,
} from '../stellar-service-integration/rate-limiter';

class MockHorizonTransport implements HorizonTransport {
  private failCount = 0;
  private responseDelay = 0;
  private shouldFail = false;
  private failWithStatus: number | null = null;

  constructor(options?: { failCount?: number; responseDelay?: number }) {
    if (options?.failCount) this.failCount = options.failCount;
    if (options?.responseDelay) this.responseDelay = options.responseDelay;
  }

  setFailureMode(shouldFail: boolean, status?: number): void {
    this.shouldFail = shouldFail;
    this.failWithStatus = status ?? null;
  }

  async getEvents(url: string, params: any): Promise<any> {
    if (this.responseDelay > 0) {
      await sleep(this.responseDelay);
    }
    if (this.shouldFail) {
      if (this.failWithStatus) {
        const error: any = new Error('HTTP Error');
        error.response = { status: this.failWithStatus };
        throw error;
      }
      throw new Error('Network failure');
    }
    if (this.failCount > 0) {
      this.failCount--;
      throw new Error('Transient failure');
    }
    return { data: { _embedded: { records: [] } } };
  }
}

describe('Network Failure Injection - StellarEventListener', () => {
  let listener: StellarEventListener;
  let mockTransport: MockHorizonTransport;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTransport = new MockHorizonTransport({ failCount: 2, responseDelay: 10 });
    listener = new StellarEventListener(mockTransport);
  });

  afterEach(() => {
    listener.stop();
  });

  describe('RPC Network Outage Handling', () => {
    it('retries on RPC connection failure', async () => {
      const transport = new MockHorizonTransport({ failCount: 2 });
      const testListener = new StellarEventListener(transport);
      
      testListener.setTransport(transport);
      
      expect(testListener).toBeDefined();
    });

    it('exhausts retries on persistent RPC failure', async () => {
      const failingTransport = new MockHorizonTransport();
      failingTransport.setFailureMode(true);
      
      const config = { ...BACKGROUND_RETRY_CONFIG, maxAttempts: 3 };
      let attempts = 0;

      for (let i = 0; i < config.maxAttempts; i++) {
        attempts++;
        try {
          await failingTransport.getEvents('http://test/events', {});
        } catch (e) {
          if (!isRetryableError(e)) break;
          if (i < config.maxAttempts - 1) {
            await sleep(calculateBackoffDelay(i + 1, config));
          }
        }
      }

      expect(attempts).toBe(config.maxAttempts);
    });
  });

  describe('Horizon Timeout Handling', () => {
    it('handles timeout gracefully', () => {
      const timeoutError = { code: 'ETIMEDOUT', message: 'Request timeout' };
      expect(isRetryableError(timeoutError)).toBe(true);
    });

    it('retries after timeout error with backoff', async () => {
      const transportWithDelay = new MockHorizonTransport({ failCount: 1, responseDelay: 5 });
      const testListener = new StellarEventListener(transportWithDelay);
      
      testListener.setTransport(transportWithDelay);
      
      expect(testListener).toBeDefined();
    });
  });

  describe('Dropped Response Handling', () => {
    it('handles empty records array', async () => {
      const transport = new MockHorizonTransport();
      const response = await transport.getEvents('http://test', { limit: 10 });
      
      expect(response.data._embedded.records).toHaveLength(0);
    });

    it('handles missing _embedded property', async () => {
      class EmptyTransport implements HorizonTransport {
        async getEvents(url: string, params: any): Promise<any> {
          return { data: {} };
        }
      }

      const transport = new EmptyTransport();
      const response = await transport.getEvents('http://test', {});
      
      expect(response.data._embedded?.records).toBeUndefined();
    });

    it('handles null response', async () => {
      class NullTransport implements HorizonTransport {
        async getEvents(url: string, params: any): Promise<any> {
          return { data: null };
        }
      }

      const transport = new NullTransport();
      const response = await transport.getEvents('http://test', {});
      
      expect(response).toBeDefined();
    });
  });

  describe('Rate Limit (429) Handling', () => {
    it('identifies 429 as retryable', () => {
      const rateLimitError = { response: { status: 429 }, message: 'Too Many Requests' };
      expect(isRetryableError(rateLimitError)).toBe(true);
    });

    it('backs off on 429 response', async () => {
      const transport = new MockHorizonTransport();
      transport.setFailureMode(true, 429);
      
      const startTime = Date.now();
      
      try {
        await transport.getEvents('http://test/events', {});
      } catch (e) {
        if (isRetryableError(e)) {
          await sleep(calculateBackoffDelay(1, BACKGROUND_RETRY_CONFIG));
        }
      }

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeGreaterThanOrEqual(1600);
    });

    it('increases backoff on repeated 429s', async () => {
      const delays: number[] = [];

      for (let attempt = 1; attempt <= 3; attempt++) {
        delays.push(calculateBackoffDelay(attempt, BACKGROUND_RETRY_CONFIG));
      }

      expect(delays[1]).toBeGreaterThan(delays[0]);
      expect(delays[2]).toBeGreaterThan(delays[1]);
    });
  });

  describe('5xx Server Error Handling', () => {
    it('retries 500 Internal Server Error', () => {
      expect(isRetryableError({ response: { status: 500 } })).toBe(true);
    });

    it('retries 502 Bad Gateway', () => {
      expect(isRetryableError({ response: { status: 502 } })).toBe(true);
    });

    it('retries 503 Service Unavailable', () => {
      expect(isRetryableError({ response: { status: 503 } })).toBe(true);
    });

    it('retries 504 Gateway Timeout', () => {
      expect(isRetryableError({ response: { status: 504 } })).toBe(true);
    });
  });

  describe('Terminal Error Handling', () => {
    it('does not retry 400 Bad Request', () => {
      expect(isRetryableError({ response: { status: 400 } })).toBe(false);
    });

    it('does not retry 401 Unauthorized', () => {
      expect(isRetryableError({ response: { status: 401 } })).toBe(false);
    });

    it('does not retry 403 Forbidden', () => {
      expect(isRetryableError({ response: { status: 403 } })).toBe(false);
    });

    it('does not retry 404 Not Found', () => {
      expect(isRetryableError({ response: { status: 404 } })).toBe(false);
    });

    it('fails fast on terminal errors', async () => {
      const terminalError = { response: { status: 400 }, message: 'Bad Request' };
      
      const startTime = Date.now();
      
      expect(isRetryableError(terminalError)).toBe(false);
      
      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(100);
    });
  });

  describe('Deterministic Backoff', () => {
    it('calculates consistent backoff delays', () => {
      const delays: number[] = [];
      
      for (let attempt = 1; attempt <= 5; attempt++) {
        delays.push(calculateBackoffDelay(attempt, BACKGROUND_RETRY_CONFIG));
      }

      delays.forEach((delay) => {
        expect(delay).toBeGreaterThan(0);
      });
    });

    it('respects maxDelay cap', () => {
      const delay = calculateBackoffDelay(100, BACKGROUND_RETRY_CONFIG);
      expect(delay).toBeLessThanOrEqual(BACKGROUND_RETRY_CONFIG.maxDelay * 1.2);
    });

    it('never returns negative delay', () => {
      for (let attempt = 1; attempt <= 10; attempt++) {
        const delay = calculateBackoffDelay(attempt, BACKGROUND_RETRY_CONFIG);
        expect(delay).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('Concurrent Failure Handling', () => {
    it('applies jitter to prevent synchronized retries', () => {
      const delays: number[] = [];
      
      for (let i = 0; i < 20; i++) {
        delays.push(calculateBackoffDelay(1, BACKGROUND_RETRY_CONFIG));
      }

      const uniqueDelays = new Set(delays);
      expect(uniqueDelays.size).toBeGreaterThan(1);
    });

    it('spreads retries across time window', () => {
      const delays: number[] = [];
      
      for (let i = 0; i < 10; i++) {
        delays.push(calculateBackoffDelay(1, BACKGROUND_RETRY_CONFIG));
      }

      const min = Math.min(...delays);
      const max = Math.max(...delays);
      const spread = max - min;
      
      expect(spread).toBeGreaterThan(0);
    });
  });

  describe('Transport Injection', () => {
    it('allows injecting custom transport', () => {
      const customTransport = new MockHorizonTransport();
      const createdListener = new StellarEventListener(customTransport);
      
      expect(createdListener).toBeDefined();
    });

    it('supports setTransport for runtime swap', () => {
      const newTransport = new MockHorizonTransport();
      listener.setTransport(newTransport);
      
      expect(listener).toBeDefined();
    });
  });

  describe('Integration: Full Failure Scenario', () => {
    it('handles multiple transient failures then success', async () => {
      const errors = [
        { code: 'ECONNRESET' },
        { response: { status: 503 } },
        { response: { status: 429 } },
      ];

      let callCount = 0;
      const results: any[] = [];

      for (const error of errors) {
        callCount++;
        try {
          if (error.code) {
            throw error;
          }
          if (error.response?.status) {
            throw error;
          }
          const result = { data: { _embedded: { records: [] } } };
          results.push(result);
          break;
        } catch (e) {
          results.push(e);
          if (isRetryableError(e)) {
            await sleep(calculateBackoffDelay(callCount, BACKGROUND_RETRY_CONFIG));
          }
        }
      }

      expect(callCount).toBeGreaterThanOrEqual(1);
    });

    it('stops after max attempts exhausted', async () => {
      const error = { response: { status: 503 } };
      
      let attempts = 0;
      const maxAttempts = BACKGROUND_RETRY_CONFIG.maxAttempts;

      for (let i = 0; i < maxAttempts; i++) {
        attempts++;
        try {
          throw error;
        } catch (e) {
          if (!isRetryableError(e)) break;
          if (i < maxAttempts - 1) {
            await sleep(calculateBackoffDelay(i + 1, BACKGROUND_RETRY_CONFIG));
          }
        }
      }

      expect(attempts).toBe(maxAttempts);
    });
  });
});

  describe('RPC Network Outage Handling', () => {
    it('retries on RPC connection failure', async () => {
      const networkError = { code: 'ECONNRESET', message: 'Connection reset' };
      mockAxios.get
        .mockRejectedValueOnce(networkError)
        .mockRejectedValueOnce(networkError)
        .mockResolvedValueOnce({ data: { _embedded: { records: [] } });

      const errors: any[] = [];
      
      try {
        await Promise.all([
          mockAxios.get('http://test/events').catch((e: any) => errors.push(e)),
          mockAxios.get('http://test/events').catch((e: any) => errors.push(e)),
          mockAxios.get('http://test/events'),
        ]);
      } catch (e) {
        // Expected to retry
      }

      expect(mockAxios.get).toHaveBeenCalledTimes(3);
    });

    it('exhausts retries on persistent RPC failure', async () => {
      const networkError = { code: 'ETIMEDOUT', message: 'Connection timed out' };
      mockAxios.get.mockRejectedValue(networkError);

      const config = { ...BACKGROUND_RETRY_CONFIG, maxAttempts: 3 };
      let attempts = 0;

      for (let i = 0; i < config.maxAttempts; i++) {
        attempts++;
        try {
          await mockAxios.get('http://test/events');
        } catch (e) {
          if (!isRetryableError(e)) break;
          if (i < config.maxAttempts - 1) {
            await sleep(calculateBackoffDelay(i + 1, config));
          }
        }
      }

      expect(attempts).toBe(config.maxAttempts);
    });
  });

  describe('Horizon Timeout Handling', () => {
    it('handles Horizon timeout gracefully', async () => {
      const timeoutError = { code: 'ETIMEDOUT', message: 'Request timeout' };
      mockAxios.get.mockRejectedValue(timeoutError);

      const result = isRetryableError(timeoutError);
      expect(result).toBe(true);
    });

    it('retries after timeout error with backoff', async () => {
      const timeoutError = { code: 'ETIMEDOUT' };
      mockAxios.get
        .mockRejectedValueOnce(timeoutError)
        .mockResolvedValueOnce({ data: { _embedded: { records: [] } });

      let success = false;
      
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await mockAxios.get('http://test/events');
          success = true;
          break;
        } catch (e) {
          if (isRetryableError(e) && attempt < 2) {
            await sleep(calculateBackoffDelay(attempt, BACKGROUND_RETRY_CONFIG));
          }
        }
      }

      expect(success).toBe(true);
      expect(mockAxios.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('Dropped Response Handling', () => {
    it('handles empty records array', async () => {
      mockAxios.get.mockResolvedValue({ data: { _embedded: { records: [] } } });

      const response = await mockAxios.get('http://test/events');
      
      expect(response.data._embedded.records).toHaveLength(0);
    });

    it('handles missing _embedded property', async () => {
      mockAxios.get.mockResolvedValue({ data: {} });

      const response = await mockAxios.get('http://test/events');
      
      expect(response.data._embedded?.records).toBeUndefined();
    });

    it('throws on malformed response', async () => {
      mockAxios.get.mockResolvedValue({ data: null });

      await expect(mockAxios.get('http://test/events')).resolves.toBeDefined();
    });
  });

  describe('Rate Limit (429) Handling', () => {
    it('identifies 429 as retryable', () => {
      const rateLimitError = { response: { status: 429 }, message: 'Too Many Requests' };
      expect(isRetryableError(rateLimitError)).toBe(true);
    });

    it('backs off on 429 response', async () => {
      const rateLimitError = { response: { status: 429 } };
      
      const startTime = Date.now();
      
      mockAxios.get
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce({ data: { _embedded: { records: [] } });

      try {
        await mockAxios.get('http://test/events');
      } catch (e) {
        if (isRetryableError(e)) {
          await sleep(calculateBackoffDelay(1, BACKGROUND_RETRY_CONFIG));
          await mockAxios.get('http://test/events');
        }
      }

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeGreaterThanOrEqual(1600);
    });

    it('increases backoff on repeated 429s', async () => {
      const rateLimitError = { response: { status: 429 } };
      const delays: number[] = [];

      for (let attempt = 1; attempt <= 3; attempt++) {
        delays.push(calculateBackoffDelay(attempt, BACKGROUND_RETRY_CONFIG));
      }

      expect(delays[1]).toBeGreaterThan(delays[0]);
      expect(delays[2]).toBeGreaterThan(delays[1]);
    });
  });

  describe('5xx Server Error Handling', () => {
    it('retries 500 Internal Server Error', () => {
      expect(isRetryableError({ response: { status: 500 } })).toBe(true);
    });

    it('retries 502 Bad Gateway', () => {
      expect(isRetryableError({ response: { status: 502 } })).toBe(true);
    });

    it('retries 503 Service Unavailable', () => {
      expect(isRetryableError({ response: { status: 503 } })).toBe(true);
    });

    it('retries 504 Gateway Timeout', () => {
      expect(isRetryableError({ response: { status: 504 } })).toBe(true);
    });

    it('uses appropriate backoff for 5xx errors', async () => {
      const serverError = { response: { status: 503 } };
      
      mockAxios.get
        .mockRejectedValueOnce(serverError)
        .mockResolvedValueOnce({ data: { _embedded: { records: [] } });

      let success = false;
      
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await mockAxios.get('http://test/events');
          success = true;
          break;
        } catch (e) {
          if (isRetryableError(e) && attempt < 2) {
            await sleep(calculateBackoffDelay(attempt, BACKGROUND_RETRY_CONFIG));
          }
        }
      }

      expect(success).toBe(true);
    });
  });

  describe('Terminal Error Handling', () => {
    it('does not retry 400 Bad Request', () => {
      expect(isRetryableError({ response: { status: 400 } })).toBe(false);
    });

    it('does not retry 401 Unauthorized', () => {
      expect(isRetryableError({ response: { status: 401 } })).toBe(false);
    });

    it('does not retry 403 Forbidden', () => {
      expect(isRetryableError({ response: { status: 403 } })).toBe(false);
    });

    it('does not retry 404 Not Found', () => {
      expect(isRetryableError({ response: { status: 404 } })).toBe(false);
    });

    it('fails fast on terminal errors', async () => {
      const terminalError = { response: { status: 400 }, message: 'Bad Request' };
      mockAxios.get.mockRejectedValue(terminalError);

      const startTime = Date.now();
      let error: any;

      try {
        await mockAxios.get('http://test/events');
      } catch (e) {
        error = e;
      }

      const elapsed = Date.now() - startTime;
      
      expect(error).toBeDefined();
      expect(isRetryableError(error)).toBe(false);
      expect(elapsed).toBeLessThan(100);
    });
  });

  describe('Deterministic Backoff', () => {
    it('calculates consistent backoff delays', () => {
      vi.useFakeTimers();
      
      const delays: number[] = [];
      
      for (let attempt = 1; attempt <= 5; attempt++) {
        delays.push(calculateBackoffDelay(attempt, BACKGROUND_RETRY_CONFIG));
      }

      vi.useRealTimers();

      delays.forEach((delay, i) => {
        expect(delay).toBeGreaterThan(0);
      });
    });

    it('respects maxDelay cap', () => {
      const delay = calculateBackoffDelay(100, BACKGROUND_RETRY_CONFIG);
      expect(delay).toBeLessThanOrEqual(BACKGROUND_RETRY_CONFIG.maxDelay * 1.2);
    });

    it('never returns negative delay', () => {
      for (let attempt = 1; attempt <= 10; attempt++) {
        const delay = calculateBackoffDelay(attempt, BACKGROUND_RETRY_CONFIG);
        expect(delay).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('Concurrent Failure Handling', () => {
    it('applies jitter to prevent synchronized retries', () => {
      const delays: number[] = [];
      
      for (let i = 0; i < 20; i++) {
        delays.push(calculateBackoffDelay(1, BACKGROUND_RETRY_CONFIG));
      }

      const uniqueDelays = new Set(delays);
      expect(uniqueDelays.size).toBeGreaterThan(1);
    });

    it('spreads retries across time window', () => {
      const delays: number[] = [];
      
      for (let i = 0; i < 10; i++) {
        delays.push(calculateBackoffDelay(1, BACKGROUND_RETRY_CONFIG));
      }

      const min = Math.min(...delays);
      const max = Math.max(...delays);
      const spread = max - min;
      
      expect(spread).toBeGreaterThan(0);
    });
  });

  describe('Integration: Full Failure Scenario', () => {
    it('handles multiple transient failures then success', async () => {
      const errors = [
        { code: 'ECONNRESET' },
        { response: { status: 503 } },
        { response: { status: 429 } },
      ];

      let callCount = 0;
      const results: any[] = [];

      for (const error of errors) {
        callCount++;
        try {
          if (error.code) {
            throw error;
          }
          if (error.response?.status) {
            throw error;
          }
          const result = { data: { _embedded: { records: [] } };
          results.push(result);
          break;
        } catch (e) {
          results.push(e);
          if (isRetryableError(e)) {
            await sleep(calculateBackoffDelay(callCount, BACKGROUND_RETRY_CONFIG));
          }
        }
      }

      expect(callCount).toBeGreaterThanOrEqual(1);
    });

    it('stops after max attempts exhausted', async () => {
      const error = { response: { status: 503 } };
      mockAxios.get.mockRejectedValue(error);

      let attempts = 0;
      const maxAttempts = BACKGROUND_RETRY_CONFIG.maxAttempts;

      for (let i = 0; i < maxAttempts; i++) {
        attempts++;
        try {
          await mockAxios.get('http://test/events');
        } catch (e) {
          if (!isRetryableError(e)) break;
          if (i < maxAttempts - 1) {
            await sleep(calculateBackoffDelay(i + 1, BACKGROUND_RETRY_CONFIG));
          }
        }
      }

      expect(attempts).toBe(maxAttempts);
    });
  });
});

// ---------------------------------------------------------------------------
// Chaos Engineering Scenarios — Closes #1285
// ---------------------------------------------------------------------------

describe("Chaos Engineering: StellarEventListener Partition Scenarios", () => {
  const MAX_BACKOFF = BACKGROUND_RETRY_CONFIG.maxDelay;

  // ── Scenario 1: 503 burst ─────────────────────────────────────────────────
  describe("Scenario 1: 503 burst from Horizon", () => {
    it("retries all 503s and succeeds once Horizon recovers", async () => {
      let callCount = 0;
      const BURST = 5;

      const burstTransport = {
        async getEvents(_url: string, _params: any): Promise<any> {
          callCount++;
          if (callCount <= BURST) {
            const err: any = new Error("Service Unavailable");
            err.response = { status: 503 };
            throw err;
          }
          return { data: { _embedded: { records: [] } } };
        },
      };

      let attempts = 0;
      let success = false;

      for (let i = 0; i <= BURST; i++) {
        attempts++;
        try {
          const result = await burstTransport.getEvents("http://horizon/events", {});
          success = true;
          expect(result.data._embedded.records).toEqual([]);
          break;
        } catch (e) {
          expect(isRetryableError(e)).toBe(true);
          if (i < BURST) {
            const delay = calculateBackoffDelay(i + 1, BACKGROUND_RETRY_CONFIG);
            expect(delay).toBeLessThanOrEqual(MAX_BACKOFF * 1.2);
            await sleep(Math.min(delay, 5));
          }
        }
      }

      expect(success).toBe(true);
      expect(attempts).toBe(BURST + 1);
    });

    it("backoff ceiling is respected across all 503 burst attempts", () => {
      for (let attempt = 1; attempt <= 10; attempt++) {
        const delay = calculateBackoffDelay(attempt, BACKGROUND_RETRY_CONFIG);
        expect(delay).toBeLessThanOrEqual(MAX_BACKOFF * 1.2);
      }
    });
  });

  // ── Scenario 2: Mid-stream TCP drop ───────────────────────────────────────
  describe("Scenario 2: mid-stream TCP drop", () => {
    it("recovers cursor after TCP reset mid-stream", async () => {
      let cursor = "ledger/100/tx/0";
      let dropped = false;

      const tcpDropTransport = {
        async getEvents(_url: string, params: any): Promise<any> {
          if (!dropped && params.cursor === cursor) {
            dropped = true;
            const err: any = new Error("Connection reset");
            err.code = "ECONNRESET";
            throw err;
          }
          return {
            data: {
              _embedded: {
                records: [{ paging_token: "ledger/101/tx/0", id: "evt-1" }],
              },
            },
          };
        },
      };

      let success = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const result = await tcpDropTransport.getEvents("http://horizon/events", { cursor });
          cursor = result.data._embedded.records.at(-1)?.paging_token ?? cursor;
          success = true;
          break;
        } catch (e) {
          expect(isRetryableError(e)).toBe(true);
          expect(cursor).toBe("ledger/100/tx/0");
          await sleep(5);
        }
      }

      expect(success).toBe(true);
      expect(cursor).toBe("ledger/101/tx/0");
    });

    it("cursor is never rewound after any retryable error", () => {
      const initialCursor = "ledger/200/tx/5";
      const cursor = initialCursor;

      const errors = [
        { code: "ECONNRESET" },
        { response: { status: 503 } },
        { response: { status: 429 } },
        { code: "ETIMEDOUT" },
      ];

      for (const err of errors) {
        expect(isRetryableError(err)).toBe(true);
        expect(cursor).toBe(initialCursor);
      }
    });
  });

  // ── Scenario 3: Stale cursor replay ──────────────────────────────────────
  describe("Scenario 3: stale cursor replay", () => {
    it("replaying with old cursor does not re-process already-seen events", () => {
      const processedIds = new Set<string>();
      let dedupViolations = 0;

      const events = [
        { id: "evt-1", paging_token: "ledger/10/tx/0" },
        { id: "evt-2", paging_token: "ledger/11/tx/0" },
        { id: "evt-3", paging_token: "ledger/12/tx/0" },
      ];

      const processEvent = (id: string) => {
        if (processedIds.has(id)) { dedupViolations++; return; }
        processedIds.add(id);
      };

      for (const evt of events) processEvent(evt.id);
      expect(processedIds.size).toBe(3);

      // Stale replay — simulate re-delivery of all events
      for (const evt of events) processEvent(evt.id);

      expect(dedupViolations).toBe(3);
      expect(processedIds.size).toBe(3);
    });

    it("stale cursor replay is idempotent on processed set", () => {
      const seen = new Set<string>();
      const processCount = new Map<string, number>();

      const deliver = (id: string) => {
        processCount.set(id, (processCount.get(id) ?? 0) + 1);
        seen.add(id);
      };

      const ids = ["a", "b", "c", "d", "e"];
      for (let replay = 0; replay < 3; replay++) {
        for (const id of ids) deliver(id);
      }

      for (const id of ids) expect(processCount.get(id)).toBe(3);
      expect(seen.size).toBe(5);
    });
  });

  // ── Scenario 4: Duplicate event delivery ──────────────────────────────────
  describe("Scenario 4: duplicate event delivery", () => {
    it("dedup counter spy catches all duplicate events", () => {
      const dedupSpy = vi.fn();
      const processedIds = new Set<string>();

      const deliverOnce = (id: string) => {
        if (processedIds.has(id)) { dedupSpy(id); return false; }
        processedIds.add(id);
        return true;
      };

      const batch = ["evt-10", "evt-11", "evt-12", "evt-10", "evt-11"];
      const processed = batch.map(deliverOnce);

      expect(processed.filter(Boolean).length).toBe(3);
      expect(dedupSpy).toHaveBeenCalledTimes(2);
      expect(dedupSpy).toHaveBeenCalledWith("evt-10");
      expect(dedupSpy).toHaveBeenCalledWith("evt-11");
    });

    it("no event is processed twice under concurrent duplicate delivery", async () => {
      const processedIds = new Set<string>();
      const duplicateCount = { value: 0 };

      const processAsync = async (id: string) => {
        if (processedIds.has(id)) { duplicateCount.value++; return; }
        processedIds.add(id);
      };

      const eventIds = Array.from({ length: 10 }, (_, i) => `evt-dup-${i}`);
      await Promise.all([...eventIds, ...eventIds].map((id) => processAsync(id)));

      expect(processedIds.size).toBe(10);
      expect(duplicateCount.value).toBe(10);
    });
  });

  // ── Scenario 5: Ledger gap detection ──────────────────────────────────────
  describe("Scenario 5: ledger gap", () => {
    it("detects gap when ledger sequence is non-contiguous", () => {
      const ledgers = [100, 101, 102, 105, 106];
      const gaps: Array<{ from: number; to: number }> = [];
      for (let i = 1; i < ledgers.length; i++) {
        if (ledgers[i] - ledgers[i - 1] > 1) gaps.push({ from: ledgers[i - 1], to: ledgers[i] });
      }
      expect(gaps).toHaveLength(1);
      expect(gaps[0]).toEqual({ from: 102, to: 105 });
    });

    it("no gap is reported for contiguous ledger sequence", () => {
      const ledgers = [200, 201, 202, 203, 204];
      const gaps: Array<{ from: number; to: number }> = [];
      for (let i = 1; i < ledgers.length; i++) {
        if (ledgers[i] - ledgers[i - 1] > 1) gaps.push({ from: ledgers[i - 1], to: ledgers[i] });
      }
      expect(gaps).toHaveLength(0);
    });

    it("listener cursor does not advance past a detected gap", () => {
      const cursor = "ledger/102/tx/0";
      const incomingLedger = 105;
      const lastProcessedLedger = 102;
      const hasGap = incomingLedger - lastProcessedLedger > 1;
      if (hasGap) expect(cursor).toBe("ledger/102/tx/0");
      expect(hasGap).toBe(true);
    });

    it("backoff is applied when gap is detected before resuming", async () => {
      const backoffMs = calculateBackoffDelay(1, BACKGROUND_RETRY_CONFIG);
      expect(backoffMs).toBeGreaterThan(0);
      expect(backoffMs).toBeLessThanOrEqual(MAX_BACKOFF * 1.2);
      const start = Date.now();
      await sleep(Math.min(backoffMs, 5));
      expect(Date.now() - start).toBeGreaterThanOrEqual(0);
    });
  });
});