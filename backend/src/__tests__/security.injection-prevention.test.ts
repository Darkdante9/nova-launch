/**
 * SECURITY TEST: API Endpoint Injection Prevention
 *
 * RISK COVERAGE:
 * - INJ-001: SQL injection via search/query string parameters
 * - INJ-002: SQL injection via sort and order parameters
 * - INJ-003: SQL injection via pagination parameters
 * - INJ-004: NoSQL/operator injection via body parameters
 * - INJ-005: Error responses must not leak SQL/schema details
 * - INJ-006: Injection attempts in analytics cursor/limit params
 * - INJ-007: Parameterized-query proof — Prisma never receives raw SQL strings
 *
 * SEVERITY: CRITICAL
 *
 * Approach:
 *   Payloads are submitted to representative HTTP endpoints and the response
 *   is asserted to be a structured rejection or a safe empty result — never a
 *   successful injection outcome.  The Prisma mock captures what arguments
 *   reach the query layer, so we can confirm that string-type user input is
 *   treated as a value parameter, not as raw SQL.
 *
 * @see https://owasp.org/www-project-top-ten/
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import tokenRoutes from '../routes/tokens';
import analyticsRouter, { clearCache } from '../routes/analytics';
import { prisma } from '../lib/prisma';
import { Database } from '../config/database';
import { AuthRequest } from '../middleware/auth';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../lib/prisma', () => ({
  prisma: {
    token: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}));

vi.mock('../config/database', () => ({
  Database: {
    getAllTokens: vi.fn(),
    getAllUsers: vi.fn(),
  },
}));

vi.mock('../middleware/auth', () => ({
  authenticateAdmin: (
    req: AuthRequest,
    _res: express.Response,
    next: express.NextFunction
  ) => {
    req.admin = { id: 'admin_1', role: 'super_admin', banned: false } as any;
    next();
  },
}));

// ---------------------------------------------------------------------------
// Classic SQL injection payloads
// ---------------------------------------------------------------------------

const SQL_PAYLOADS = [
  "' OR '1'='1",
  "' OR 1=1--",
  "'; DROP TABLE tokens--",
  "' UNION SELECT NULL--",
  "admin'--",
  "' AND SLEEP(5)--",
  "'; WAITFOR DELAY '00:00:05'--",
  "' AND 1=CONVERT(int,(SELECT @@version))--",
  "\x00",
  "%27%20OR%20%271%27%3D%271",
];

// ---------------------------------------------------------------------------
// App factories
// ---------------------------------------------------------------------------

function buildTokenApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/tokens', tokenRoutes);
  return app;
}

function buildAnalyticsApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/analytics', analyticsRouter);
  return app;
}

// ---------------------------------------------------------------------------
// [INJ-001] SQL injection via search/query string parameters
// ---------------------------------------------------------------------------

describe('[INJ-001] Injection in search/query string parameters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.token.findMany).mockResolvedValue([]);
    vi.mocked(prisma.token.count).mockResolvedValue(0);
  });

  it('treats injection payload in ?q= as a literal search string, not SQL', async () => {
    for (const payload of SQL_PAYLOADS) {
      const res = await request(buildTokenApp())
        .get(`/api/tokens/search`)
        .query({ q: payload });

      // The endpoint either returns 200 (empty results) or 400 (invalid input).
      // It must never return 500 (which would indicate an unhandled DB error from raw SQL).
      expect(res.status).not.toBe(500);

      if (res.status === 200) {
        // If accepted, verify that Prisma received the value as a parameter
        const findManyCall = vi.mocked(prisma.token.findMany).mock.calls.at(-1);
        if (findManyCall) {
          const whereArg = findManyCall[0]?.where;
          // The payload must appear as a value inside an OR clause, not injected into SQL
          const receivedQuery = JSON.stringify(whereArg);
          expect(receivedQuery).toContain(payload.replace(/"/g, ''));
        }
      }
    }
  });

  it('treats injection payload in ?creator= as a literal value', async () => {
    for (const payload of SQL_PAYLOADS.slice(0, 5)) {
      const res = await request(buildTokenApp())
        .get('/api/tokens/search')
        .query({ creator: payload });

      expect(res.status).not.toBe(500);

      if (res.status === 200 && vi.mocked(prisma.token.findMany).mock.calls.length > 0) {
        const lastCall = vi.mocked(prisma.token.findMany).mock.calls.at(-1)!;
        const where = lastCall[0]?.where as any;
        // creator is passed as an exact-match string parameter
        expect(where?.creator).toBe(payload);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// [INJ-002] Injection via sort and order parameters
// ---------------------------------------------------------------------------

describe('[INJ-002] Injection in sort and order parameters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.token.findMany).mockResolvedValue([]);
    vi.mocked(prisma.token.count).mockResolvedValue(0);
  });

  it('rejects invalid sortBy values with 400', async () => {
    const maliciousSortValues = [
      "name; DROP TABLE tokens",
      "name' OR '1'='1",
      "name UNION SELECT NULL",
      "createdAt--",
      "1=1",
      "totally_invalid_field",
    ];

    for (const val of maliciousSortValues) {
      const res = await request(buildTokenApp())
        .get('/api/tokens/search')
        .query({ sortBy: val });

      expect(res.status).toBe(400);
      // Prisma must not be called when Zod rejects the input
      expect(vi.mocked(prisma.token.findMany)).not.toHaveBeenCalled();
      vi.clearAllMocks();
    }
  });

  it('rejects invalid sortOrder values with 400', async () => {
    const maliciousOrderValues = [
      "asc; DROP TABLE tokens",
      "asc' OR '1'='1",
      "DESC--",
      "asc UNION SELECT NULL",
      "random_order",
    ];

    for (const val of maliciousOrderValues) {
      const res = await request(buildTokenApp())
        .get('/api/tokens/search')
        .query({ sortOrder: val });

      expect(res.status).toBe(400);
      expect(vi.mocked(prisma.token.findMany)).not.toHaveBeenCalled();
      vi.clearAllMocks();
    }
  });
});

// ---------------------------------------------------------------------------
// [INJ-003] Injection via pagination parameters
// ---------------------------------------------------------------------------

describe('[INJ-003] Injection in pagination parameters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.token.findMany).mockResolvedValue([]);
    vi.mocked(prisma.token.count).mockResolvedValue(0);
  });

  it('rejects non-numeric page values with 400', async () => {
    const maliciousPageValues = [
      "1 OR 1=1",
      "1; DROP TABLE tokens",
      "1 UNION SELECT NULL",
      "abc",
      "1'",
    ];

    for (const val of maliciousPageValues) {
      const res = await request(buildTokenApp())
        .get('/api/tokens/search')
        .query({ page: val });

      expect(res.status).toBe(400);
      expect(vi.mocked(prisma.token.findMany)).not.toHaveBeenCalled();
      vi.clearAllMocks();
    }
  });

  it('rejects non-numeric limit values with 400', async () => {
    const maliciousLimitValues = [
      "10 OR 1=1",
      "10; DROP TABLE tokens",
      "10 UNION SELECT NULL",
      "abc",
      "10'",
    ];

    for (const val of maliciousLimitValues) {
      const res = await request(buildTokenApp())
        .get('/api/tokens/search')
        .query({ limit: val });

      expect(res.status).toBe(400);
      expect(vi.mocked(prisma.token.findMany)).not.toHaveBeenCalled();
      vi.clearAllMocks();
    }
  });

  it('rejects invalid minSupply/maxSupply values with 400', async () => {
    const maliciousSupplyValues = [
      "1000 OR 1=1",
      "1000; DROP TABLE tokens",
      "1000abc",
      "'1000'",
    ];

    for (const val of maliciousSupplyValues) {
      const res = await request(buildTokenApp())
        .get('/api/tokens/search')
        .query({ minSupply: val });

      expect(res.status).toBe(400);
      vi.clearAllMocks();
    }
  });
});

// ---------------------------------------------------------------------------
// [INJ-004] NoSQL / operator injection via body
// ---------------------------------------------------------------------------

describe('[INJ-004] NoSQL operator injection in body parameters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.token.findMany).mockResolvedValue([]);
    vi.mocked(prisma.token.count).mockResolvedValue(0);
  });

  it('treats MongoDB-style operator objects in ?q= as literal strings', async () => {
    // When sent as query string, these arrive as plain strings
    const res = await request(buildTokenApp())
      .get('/api/tokens/search')
      .query({ q: '{"$gt": ""}' });

    expect(res.status).not.toBe(500);
  });

  it('treats deeply nested JSON-like strings in ?creator= safely', async () => {
    const res = await request(buildTokenApp())
      .get('/api/tokens/search')
      .query({ creator: '{"$where": "function(){return true}"}' });

    expect(res.status).not.toBe(500);
  });
});

// ---------------------------------------------------------------------------
// [INJ-005] Error responses must not leak SQL / schema details
// ---------------------------------------------------------------------------

describe('[INJ-005] No SQL detail leakage in error responses', () => {
  const SQL_LEAK_PATTERNS = [
    'table',
    'column',
    'syntax error',
    'postgresql',
    'pg_',
    'information_schema',
    'prisma',
    'select ',
    'from ',
    'where ',
    'sql',
  ];

  function containsSqlLeak(body: any): boolean {
    const text = JSON.stringify(body).toLowerCase();
    return SQL_LEAK_PATTERNS.some((p) => text.includes(p));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.token.findMany).mockResolvedValue([]);
    vi.mocked(prisma.token.count).mockResolvedValue(0);
  });

  it('does not leak schema info in 400 responses for invalid sort params', async () => {
    const res = await request(buildTokenApp())
      .get('/api/tokens/search')
      .query({ sortBy: "name' OR '1'='1" });

    expect(res.status).toBe(400);
    expect(containsSqlLeak(res.body)).toBe(false);
  });

  it('does not leak schema info in 400 responses for invalid pagination', async () => {
    const res = await request(buildTokenApp())
      .get('/api/tokens/search')
      .query({ page: "1 UNION SELECT NULL" });

    expect(res.status).toBe(400);
    expect(containsSqlLeak(res.body)).toBe(false);
  });

  it('does not leak schema info when database throws', async () => {
    vi.mocked(prisma.token.findMany).mockRejectedValue(
      new Error('relation "tokens" does not exist')
    );

    const res = await request(buildTokenApp())
      .get('/api/tokens/search');

    // Should be 500 but must not expose the raw error message
    if (res.status === 500) {
      const bodyText = JSON.stringify(res.body).toLowerCase();
      // Raw Prisma error message must not be forwarded verbatim
      expect(bodyText).not.toContain('relation "tokens"');
    }
  });
});

// ---------------------------------------------------------------------------
// [INJ-006] Injection in analytics cursor/limit parameters
// ---------------------------------------------------------------------------

describe('[INJ-006] Injection in analytics pagination parameters', () => {
  const now = Date.now();
  const DAY = 86_400_000;
  const mockTokens = [
    { id: 't1', name: 'A', symbol: 'A', creator: 'GC1', burned: '0', createdAt: new Date(now - DAY), deleted: false },
  ];
  const mockUsers = [
    { id: 'u1', banned: false, createdAt: new Date(now - DAY) },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
    vi.mocked(Database.getAllTokens).mockResolvedValue(mockTokens as any);
    vi.mocked(Database.getAllUsers).mockResolvedValue(mockUsers as any);
  });

  it('rejects injection in ?limit= for tokens/list', async () => {
    const maliciousLimits = ["10 OR 1=1", "10; DROP TABLE tokens", "abc", "-1", "0"];

    for (const val of maliciousLimits) {
      const res = await request(buildAnalyticsApp())
        .get('/api/analytics/tokens/list')
        .query({ limit: val });

      expect(res.status).toBe(400);
    }
  });

  it('rejects a malformed cursor for tokens/list', async () => {
    const res = await request(buildAnalyticsApp())
      .get('/api/analytics/tokens/list')
      .query({ cursor: "' OR '1'='1" });

    expect(res.status).toBe(400);
  });

  it('rejects injection in ?limit= for users/list', async () => {
    const res = await request(buildAnalyticsApp())
      .get('/api/analytics/users/list')
      .query({ limit: "10; DROP TABLE users" });

    expect(res.status).toBe(400);
  });

  it('rejects a malformed cursor for users/list', async () => {
    const res = await request(buildAnalyticsApp())
      .get('/api/analytics/users/list')
      .query({ cursor: "' UNION SELECT NULL--" });

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// [INJ-007] Parameterized-query proof
// ---------------------------------------------------------------------------

describe('[INJ-007] Prisma parameterized query verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.token.findMany).mockResolvedValue([]);
    vi.mocked(prisma.token.count).mockResolvedValue(0);
  });

  it('passes the search string as a Prisma contains value, not raw SQL', async () => {
    const payload = "'; DROP TABLE tokens--";

    await request(buildTokenApp())
      .get('/api/tokens/search')
      .query({ q: payload });

    const calls = vi.mocked(prisma.token.findMany).mock.calls;
    if (calls.length > 0) {
      const whereArg = calls[0][0]?.where as any;
      // The payload must appear only inside a { contains: ... } value object
      if (whereArg?.OR) {
        whereArg.OR.forEach((clause: any) => {
          // Each OR clause must be a Prisma filter object, not a raw string
          expect(typeof clause).toBe('object');
          const val = clause?.name?.contains ?? clause?.symbol?.contains;
          if (val !== undefined) {
            expect(val).toBe(payload); // treated as literal string
          }
        });
      }
    }
  });

  it('passes the creator filter as a Prisma exact-match string, not raw SQL', async () => {
    const payload = "GCREATOR' OR '1'='1";

    await request(buildTokenApp())
      .get('/api/tokens/search')
      .query({ creator: payload });

    const calls = vi.mocked(prisma.token.findMany).mock.calls;
    if (calls.length > 0) {
      const where = calls[0][0]?.where as any;
      // creator arrives as a plain string — Prisma will parameterize it
      expect(where?.creator).toBe(payload);
    }
  });

  it('passes numeric page/limit as integers, never as strings, to skip/take', async () => {
    await request(buildTokenApp())
      .get('/api/tokens/search')
      .query({ page: '2', limit: '5' });

    const calls = vi.mocked(prisma.token.findMany).mock.calls;
    if (calls.length > 0) {
      const args = calls[0][0] as any;
      expect(typeof args.skip).toBe('number');
      expect(typeof args.take).toBe('number');
    }
  });
});
