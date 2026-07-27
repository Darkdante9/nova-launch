/**
 * SECURITY TEST: API Key Guard — Brute-Force & Enumeration
 *
 * RISK COVERAGE:
 * - AUTH-BF-001: Brute-force 100 sequential wrong keys all return 401
 * - AUTH-BF-002: Response body is identical regardless of key format
 * - AUTH-BF-003: Timing-safe comparison (p95 variance < threshold)
 * - AUTH-BF-004: Guard does not log the attempted key value
 * - AUTH-BF-005: Valid key accepted with 200
 * - AUTH-BF-006: Missing key returns 401 (not 403)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiKeyGuard } from '../auth/api-key.guard';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_VALID_KEY = 'test-valid-key-abcdef1234567890';
const TEST_VALID_KEY_2 = 'test-valid-key-second-0987654321';

function makeGuard(keys: string[] = [TEST_VALID_KEY, TEST_VALID_KEY_2]): ApiKeyGuard {
  const configService = {
    get: vi.fn((key: string, fallback = '') =>
      key === 'API_KEYS' ? keys.join(',') : fallback,
    ),
  } as unknown as ConfigService;

  return new ApiKeyGuard(configService);
}

function makeContext(apiKey: string | undefined, via: 'header' | 'query' = 'header') {
  const request: Record<string, unknown> = {
    ip: '127.0.0.1',
    headers: {},
    query: {},
  };

  if (via === 'header' && apiKey !== undefined) {
    (request.headers as Record<string, string>)['x-api-key'] = apiKey;
  }
  if (via === 'query' && apiKey !== undefined) {
    (request.query as Record<string, string>)['api_key'] = apiKey;
  }

  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ApiKeyGuard – Security Penetration Tests', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  // ─── AUTH-BF-005 / AUTH-BF-006: basic acceptance ─────────────────────────

  it('accepts a valid API key and returns true', () => {
    const guard = makeGuard();
    expect(guard.canActivate(makeContext(TEST_VALID_KEY))).toBe(true);
  });

  it('accepts valid key passed as query parameter', () => {
    const guard = makeGuard();
    expect(guard.canActivate(makeContext(TEST_VALID_KEY, 'query'))).toBe(true);
  });

  it('accepts the second valid key from a comma-separated list', () => {
    const guard = makeGuard();
    expect(guard.canActivate(makeContext(TEST_VALID_KEY_2))).toBe(true);
  });

  it('throws UnauthorizedException (401) for an invalid key — not 403', () => {
    const guard = makeGuard();
    expect(() => guard.canActivate(makeContext('wrong-key'))).toThrow(
      UnauthorizedException,
    );
  });

  it('throws UnauthorizedException when no key is provided', () => {
    const guard = makeGuard();
    expect(() => guard.canActivate(makeContext(undefined))).toThrow(
      UnauthorizedException,
    );
  });

  // ─── AUTH-BF-001 / AUTH-BF-002: brute-force simulation ───────────────────

  it('returns identical UnauthorizedException body for 100 sequential wrong keys', () => {
    const guard = makeGuard();
    const bodies: string[] = [];

    for (let i = 0; i < 100; i++) {
      try {
        guard.canActivate(makeContext(`brute-force-attempt-${i}`));
      } catch (err) {
        const e = err as { message?: string; status?: number };
        bodies.push(JSON.stringify({ message: e.message, status: e.status ?? 401 }));
      }
    }

    expect(bodies).toHaveLength(100);
    const uniqueBodies = new Set(bodies);
    // All 100 responses must have identical structure
    expect(uniqueBodies.size).toBe(1);
  });

  it('all 401 responses have identical error message regardless of key format', () => {
    const guard = makeGuard();
    const variants = [
      '',
      ' ',
      'a',
      'A'.repeat(32),
      '!@#$%^&*()',
      'null',
      'undefined',
      '{"admin":true}',
      TEST_VALID_KEY.slice(0, -1),
      TEST_VALID_KEY + '_extra',
    ];

    const messages = variants.map((key) => {
      try {
        guard.canActivate(makeContext(key));
        return null;
      } catch (err) {
        return (err as UnauthorizedException).message;
      }
    });

    const nonNull = messages.filter(Boolean);
    expect(nonNull).toHaveLength(variants.length);
    expect(new Set(nonNull).size).toBe(1);
  });

  // ─── AUTH-BF-003: timing consistency ────────────────────────────────────

  it('p95 response time variance between valid and invalid keys is below 10ms', () => {
    const guard = makeGuard();
    const validTimes: number[] = [];
    const invalidTimes: number[] = [];
    const RUNS = 50;

    for (let i = 0; i < RUNS; i++) {
      const t0 = performance.now();
      try {
        guard.canActivate(makeContext(TEST_VALID_KEY));
      } catch {}
      validTimes.push(performance.now() - t0);

      const t1 = performance.now();
      try {
        guard.canActivate(makeContext(`invalid-key-${i}`));
      } catch {}
      invalidTimes.push(performance.now() - t1);
    }

    const p95 = (arr: number[]) => {
      const sorted = [...arr].sort((a, b) => a - b);
      return sorted[Math.floor(arr.length * 0.95)];
    };

    const variance = Math.abs(p95(validTimes) - p95(invalidTimes));
    // Timing variance should be well under 10ms for synchronous comparison
    expect(variance).toBeLessThan(10);
  });

  // ─── AUTH-BF-004: key value not logged ───────────────────────────────────

  it('does not log the attempted key value in warn output on invalid key', () => {
    const guard = makeGuard();
    const logSpy = vi.spyOn(
      (guard as unknown as { logger: { warn: (msg: string) => void } }).logger,
      'warn',
    ).mockImplementation(() => {});

    const secretAttempt = 'super-secret-brute-force-key-12345';
    try {
      guard.canActivate(makeContext(secretAttempt));
    } catch {}

    for (const call of logSpy.mock.calls) {
      const logMessage = String(call[0]);
      expect(logMessage).not.toContain(secretAttempt);
    }
  });

  it('does not include attempted key in thrown UnauthorizedException message', () => {
    const guard = makeGuard();
    const secretKey = 'my-enumeration-probe-key';

    try {
      guard.canActivate(makeContext(secretKey));
      expect.fail('should have thrown');
    } catch (err) {
      const e = err as UnauthorizedException;
      expect(e.message).not.toContain(secretKey);
    }
  });

  // ─── Edge: empty config / no valid keys ──────────────────────────────────

  it('rejects all keys when configured with an empty key list', () => {
    const guard = makeGuard([]);
    expect(() => guard.canActivate(makeContext(TEST_VALID_KEY))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects whitespace-only keys that would match after trim', () => {
    const guard = makeGuard(['   ']);
    expect(() => guard.canActivate(makeContext('   '))).toThrow(
      UnauthorizedException,
    );
  });
});
