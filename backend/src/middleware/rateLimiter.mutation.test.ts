/**
 * Mutation-coverage tests for RateLimiter sliding-window boundary conditions
 *
 * Closes #1283
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Request, Response, NextFunction } from "express";
import {
  createRateLimiter,
  incrementSlidingWindow,
  extractClientIP,
  resolveKey,
} from "./rateLimiter";

// ---------------------------------------------------------------------------
// Fake clock
// ---------------------------------------------------------------------------

let fakeNow = 1_700_000_000_000;

beforeEach(() => {
  fakeNow = 1_700_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => fakeNow);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// In-memory Redis that drives real sliding-window logic
// ---------------------------------------------------------------------------

class FakeRedis {
  private sets: Map<string, { score: number; member: string }[]> = new Map();

  pipeline() {
    const ops: Array<() => void> = [];
    const results: [null, any][] = [];
    const pipe: any = {
      zremrangebyscore: (key: string, _min: string, max: number) => {
        ops.push(() => {
          const entries = this.sets.get(key) ?? [];
          this.sets.set(key, entries.filter((e) => e.score > max));
          results.push([null, 0]);
        });
        return pipe;
      },
      zadd: (key: string, score: number, member: string) => {
        ops.push(() => {
          const entries = this.sets.get(key) ?? [];
          entries.push({ score, member });
          this.sets.set(key, entries);
          results.push([null, 1]);
        });
        return pipe;
      },
      zcard: (key: string) => {
        ops.push(() => {
          results.push([null, (this.sets.get(key) ?? []).length]);
        });
        return pipe;
      },
      expire: (_key: string, _ttl: number) => {
        ops.push(() => results.push([null, 1]));
        return pipe;
      },
      exec: async () => {
        ops.forEach((op) => op());
        return results;
      },
    };
    return pipe;
  }

  on() {}

  zcard(key: string): number {
    return (this.sets.get(key) ?? []).length;
  }

  flush(key: string) {
    this.sets.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Express mock helpers
// ---------------------------------------------------------------------------

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    ip: "10.0.0.1",
    socket: { remoteAddress: "10.0.0.1" },
    headers: {},
    ...overrides,
  } as any;
}

function mockRes() {
  const headers: Record<string, any> = {};
  let statusCode = 200;
  let body: any;
  const res: any = {
    headers,
    setHeader: vi.fn((k: string, v: any) => { headers[k] = v; }),
    status: vi.fn((c: number) => { statusCode = c; return res; }),
    json: vi.fn((b: any) => { body = b; return res; }),
    get statusCode() { return statusCode; },
    get body() { return body; },
  };
  return res;
}

function makeNext(): NextFunction & { called: boolean } {
  const fn: any = vi.fn(() => { fn.called = true; });
  fn.called = false;
  return fn;
}

// ---------------------------------------------------------------------------
// incrementSlidingWindow — boundary mutations
// ---------------------------------------------------------------------------

describe("incrementSlidingWindow", () => {
  const WINDOW_SIZES = [1_000, 60_000, 3_600_000];

  it.each(WINDOW_SIZES)(
    "counts only entries within window at exact boundary (windowMs=%i)",
    async (windowMs) => {
      const redis = new FakeRedis() as any;
      const key = `test:boundary:${windowMs}`;

      // Record a request at t=0
      await incrementSlidingWindow(redis, key, windowMs);

      // Advance time to exactly the window boundary (entry should expire)
      fakeNow += windowMs;
      const count = await incrementSlidingWindow(redis, key, windowMs);

      // Only the new request should be inside the window
      expect(count).toBe(1);
    }
  );

  it.each(WINDOW_SIZES)(
    "counts entry one tick inside window (windowMs=%i)",
    async (windowMs) => {
      const redis = new FakeRedis() as any;
      const key = `test:inside:${windowMs}`;

      await incrementSlidingWindow(redis, key, windowMs);

      // One tick before expiry — old entry still inside window
      fakeNow += windowMs - 1;
      const count = await incrementSlidingWindow(redis, key, windowMs);

      expect(count).toBe(2);
    }
  );

  it("accumulates counts across multiple requests in same window", async () => {
    const redis = new FakeRedis() as any;
    const key = "test:accumulate";
    for (let i = 0; i < 5; i++) {
      fakeNow += 10;
      await incrementSlidingWindow(redis, key, 10_000);
    }
    const count = await incrementSlidingWindow(redis, key, 10_000);
    expect(count).toBe(6);
  });

  it("resets count after full window elapses", async () => {
    const redis = new FakeRedis() as any;
    const key = "test:reset";
    for (let i = 0; i < 3; i++) {
      await incrementSlidingWindow(redis, key, 1_000);
    }
    fakeNow += 1_001;
    const count = await incrementSlidingWindow(redis, key, 1_000);
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Burst allowance overflow
// ---------------------------------------------------------------------------

describe("burst allowance overflow", () => {
  it("allows exactly max requests then blocks the next", async () => {
    const redis = new FakeRedis() as any;
    const max = 5;
    const middleware = createRateLimiter(redis, { windowMs: 60_000, max, keyPrefix: "rl:burst" });

    const nexts: boolean[] = [];
    const statuses: number[] = [];

    for (let i = 0; i < max + 1; i++) {
      const req = mockReq();
      const res = mockRes();
      const next = makeNext();
      await middleware(req, res, next);
      nexts.push(next.called);
      statuses.push(res.statusCode);
    }

    expect(nexts.slice(0, max).every(Boolean)).toBe(true);
    expect(nexts[max]).toBe(false);
    expect(statuses[max]).toBe(429);
  });

  it("returns correct Retry-After header on 429", async () => {
    const redis = new FakeRedis() as any;
    const windowMs = 60_000;
    const max = 2;
    const middleware = createRateLimiter(redis, { windowMs, max, keyPrefix: "rl:retry" });

    for (let i = 0; i <= max; i++) {
      const req = mockReq();
      const res = mockRes();
      const next = makeNext();
      await middleware(req, res, next);

      if (i === max) {
        const retryAfter = res.headers["Retry-After"] as number;
        expect(retryAfter).toBeGreaterThan(0);
        expect(retryAfter).toBeLessThanOrEqual(Math.ceil(windowMs / 1000) + 1);
      }
    }
  });

  it("sets X-RateLimit-Remaining to 0 when limit hit", async () => {
    const redis = new FakeRedis() as any;
    const max = 1;
    const middleware = createRateLimiter(redis, { windowMs: 10_000, max, keyPrefix: "rl:remain" });

    for (let i = 0; i <= max; i++) {
      const req = mockReq();
      const res = mockRes();
      await middleware(req, res, makeNext());
      if (i === max) {
        expect(res.headers["X-RateLimit-Remaining"]).toBe(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Concurrent request interleaving (Promise.all with shared fake clock)
// ---------------------------------------------------------------------------

describe("concurrent burst simulation", () => {
  it("handles N concurrent requests atomically via shared key", async () => {
    const redis = new FakeRedis() as any;
    const max = 10;
    const middleware = createRateLimiter(redis, {
      windowMs: 5_000,
      max,
      keyPrefix: "rl:concurrent",
    });

    const CONCURRENCY = 15;
    const req = mockReq(); // same IP → same key
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => {
        const res = mockRes();
        const next = makeNext();
        return middleware(req, res, next).then(() => ({
          passed: next.called,
          status: res.statusCode,
        }));
      })
    );

    const passed = results.filter((r) => r.passed).length;
    const blocked = results.filter((r) => r.status === 429).length;

    expect(passed).toBe(max);
    expect(blocked).toBe(CONCURRENCY - max);
  });

  it("distinct IPs have independent counters", async () => {
    const redis = new FakeRedis() as any;
    const max = 3;
    const middleware = createRateLimiter(redis, { windowMs: 10_000, max, keyPrefix: "rl:multi-ip" });

    const run = async (ip: string) => {
      const results: boolean[] = [];
      for (let i = 0; i < max + 1; i++) {
        const req = mockReq({ ip, socket: { remoteAddress: ip } as any });
        const res = mockRes();
        const next = makeNext();
        await middleware(req, res, next);
        results.push(next.called);
      }
      return results;
    };

    const [ip1, ip2] = await Promise.all([run("1.2.3.4"), run("5.6.7.8")]);
    // Both should allow exactly `max` requests
    expect(ip1.filter(Boolean).length).toBe(max);
    expect(ip2.filter(Boolean).length).toBe(max);
  });
});

// ---------------------------------------------------------------------------
// IP-header spoofing rejection
// ---------------------------------------------------------------------------

describe("IP-header spoofing rejection", () => {
  it("ignores X-Forwarded-For when no trusted proxies configured", () => {
    delete process.env.TRUSTED_PROXY_IPS;
    const req = mockReq({
      headers: { "x-forwarded-for": "1.1.1.1" },
      ip: "10.0.0.2",
      socket: { remoteAddress: "10.0.0.2" } as any,
    });
    const ip = extractClientIP(req);
    expect(ip).toBe("10.0.0.2");
  });

  it("uses X-Forwarded-For client IP when request comes from trusted proxy", () => {
    process.env.TRUSTED_PROXY_IPS = "10.0.0.3";
    const req = mockReq({
      headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.3" },
      ip: "10.0.0.3",
      socket: { remoteAddress: "10.0.0.3" } as any,
    });
    const ip = extractClientIP(req);
    expect(ip).toBe("203.0.113.5");
    delete process.env.TRUSTED_PROXY_IPS;
  });

  it("falls back to X-Real-IP when X-Forwarded-For absent and proxy trusted", () => {
    process.env.TRUSTED_PROXY_IPS = "10.0.0.4";
    const req = mockReq({
      headers: { "x-real-ip": "192.168.1.100" },
      ip: "10.0.0.4",
      socket: { remoteAddress: "10.0.0.4" } as any,
    });
    const ip = extractClientIP(req);
    expect(ip).toBe("192.168.1.100");
    delete process.env.TRUSTED_PROXY_IPS;
  });

  it("rates wallet-authenticated users by wallet address, not IP", async () => {
    const redis = new FakeRedis() as any;
    const max = 2;
    const middleware = createRateLimiter(redis, { windowMs: 10_000, max, keyPrefix: "rl:wallet" });

    // Abuse: same wallet from two different IPs should share the counter
    const wallet = "GABC1234";
    for (let i = 0; i < max + 1; i++) {
      const ip = `10.0.${i}.1`;
      const req: any = {
        ip,
        socket: { remoteAddress: ip },
        headers: {},
        user: { walletAddress: wallet },
      };
      const res = mockRes();
      const next = makeNext();
      await middleware(req, res, next);
      if (i === max) {
        expect(res.statusCode).toBe(429);
      }
    }
  });

  it("resolveKey uses wallet prefix when walletAddress present", () => {
    const req: any = { ip: "1.2.3.4", socket: {}, headers: {}, user: { walletAddress: "GABC" } };
    const key = resolveKey(req, "rl:test");
    expect(key).toContain("wallet:GABC");
  });

  it("resolveKey uses ip prefix when no auth", () => {
    const req = mockReq({ ip: "9.9.9.9", socket: { remoteAddress: "9.9.9.9" } as any });
    const key = resolveKey(req, "rl:test");
    expect(key).toContain("ip:");
  });
});

// ---------------------------------------------------------------------------
// Redis failure → fail-open behaviour
// ---------------------------------------------------------------------------

describe("Redis failure handling", () => {
  it("fails open when Redis throws", async () => {
    const brokenRedis: any = {
      pipeline: () => ({ exec: async () => { throw new Error("Redis down"); } }),
      on: vi.fn(),
    };
    const middleware = createRateLimiter(brokenRedis, { windowMs: 1_000, max: 5 });
    const next = makeNext();
    await middleware(mockReq(), mockRes(), next);
    expect(next.called).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Off-by-one: counter reset at exact window boundary
// ---------------------------------------------------------------------------

describe("off-by-one window boundary", () => {
  it("does not count entry scored exactly at windowStart cutoff", async () => {
    const redis = new FakeRedis() as any;
    const windowMs = 1_000;
    const key = "test:exact-boundary";

    // t=0: record first request
    await incrementSlidingWindow(redis, key, windowMs);

    // Advance to t=windowMs: windowStart = now - windowMs = t=0
    // ZADD removes entries with score <= windowStart (score 0 == windowStart)
    fakeNow += windowMs;
    const count = await incrementSlidingWindow(redis, key, windowMs);

    // Entry at score=t0 should be pruned (score <= windowStart)
    expect(count).toBe(1);
  });
});
