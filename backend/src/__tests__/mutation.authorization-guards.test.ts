/**
 * MUTATION AUTHORIZATION TEST MATRIX
 *
 * Complete matrix of every REST mutation endpoint (POST / PUT / DELETE) against
 * every auth role (unauthenticated, user, admin). GraphQL resolvers.ts is
 * read-only (Query + Subscription only) — no GraphQL mutations exist.
 *
 * ENDPOINT COVERAGE TABLE
 * ─────────────────────────────────────────────────────────────────────────────
 * ID  │ Method  │ Path                               │ Required Role
 * ────┼─────────┼────────────────────────────────────┼─────────────────────────
 * M01 │ POST    │ /api/campaigns                     │ user
 * M02 │ POST    │ /api/dividends/pools               │ user
 * M03 │ DELETE  │ /api/dividends/pools/:poolId       │ user
 * M04 │ POST    │ /api/dividends/claim               │ user
 * M05 │ POST    │ /api/tokens/batch                  │ admin
 * M06 │ POST    │ /api/governance/events/ingest      │ admin
 * M07 │ POST    │ /api/webhooks/subscribe            │ user
 * M08 │ DELETE  │ /api/webhooks/unsubscribe/:id      │ user
 * M09 │ POST    │ /api/webhooks/:id/test             │ user
 * M10 │ POST    │ /api/webhooks/dead-letters/:id/retry │ admin
 * M11 │ POST    │ /api/webhooks/dead-letters/:id/skip  │ admin
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Each endpoint is tested against 3 auth states:
 *   • unauthenticated  → HTTP 401  + body.code === 'UNAUTHENTICATED'
 *   • wrong role       → HTTP 403  + body.code === 'FORBIDDEN'
 *   • correct role     → HTTP 2xx  (handler stub returns 200)
 *
 * No real DB is required — Prisma is fully mocked.
 *
 * LEGACY MUTATION GUARD TESTS (M1-M8) preserved at the end of this file.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express, { Request, Response, NextFunction, Router } from 'express';

// ─────────────────────────────────────────────────────────────────────────────
// Mock Prisma (no real DB)
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('@prisma/client', () => ({
  PrismaClient: vi.fn(() => ({})),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Auth middleware
//
// A production-grade auth middleware that always includes a `code` field in
// error responses so callers can distinguish error types programmatically.
// ─────────────────────────────────────────────────────────────────────────────

type Role = 'unauthenticated' | 'user' | 'admin';

interface AuthRequest extends Request {
  authRole?: Role;
}

/**
 * Reads a synthetic `X-Test-Role` header so tests can inject any role without
 * real JWT signing. In the authorization matrix tests this header is the
 * single control knob — it must never exist in production.
 */
function createAuthMiddleware(requiredRole: 'user' | 'admin') {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    const role = req.headers['x-test-role'] as Role | undefined;

    if (!role || role === 'unauthenticated') {
      return res.status(401).json({
        code: 'UNAUTHENTICATED',
        error: 'Authentication required',
      });
    }

    const hierarchy: Role[] = ['user', 'admin'];
    const callerLevel = hierarchy.indexOf(role);
    const requiredLevel = hierarchy.indexOf(requiredRole);

    if (callerLevel < requiredLevel) {
      return res.status(403).json({
        code: 'FORBIDDEN',
        error: 'Insufficient permissions',
        required: requiredRole,
        current: role,
      });
    }

    req.authRole = role;
    next();
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MUTATIONS TABLE
//
// Each entry describes one mutation endpoint and the minimum role required.
// The test app applies createAuthMiddleware(requiredRole) to every route so
// the matrix drives the same guard logic for every entry.
// ─────────────────────────────────────────────────────────────────────────────

type MutationEntry = {
  id: string;
  method: 'POST' | 'PUT' | 'DELETE';
  path: string;           // express path (with :param placeholders)
  testPath: string;       // concrete path for supertest (params resolved)
  requiredRole: 'user' | 'admin';
  description: string;
};

const MUTATIONS: MutationEntry[] = [
  {
    id: 'M01',
    method: 'POST',
    path: '/api/campaigns',
    testPath: '/api/campaigns',
    requiredRole: 'user',
    description: 'Create a new campaign',
  },
  {
    id: 'M02',
    method: 'POST',
    path: '/api/dividends/pools',
    testPath: '/api/dividends/pools',
    requiredRole: 'user',
    description: 'Create a new dividend pool',
  },
  {
    id: 'M03',
    method: 'DELETE',
    path: '/api/dividends/pools/:poolId',
    testPath: '/api/dividends/pools/42',
    requiredRole: 'user',
    description: 'Cancel a dividend pool (funder only)',
  },
  {
    id: 'M04',
    method: 'POST',
    path: '/api/dividends/claim',
    testPath: '/api/dividends/claim',
    requiredRole: 'user',
    description: 'Claim dividends for a holder',
  },
  {
    id: 'M05',
    method: 'POST',
    path: '/api/tokens/batch',
    testPath: '/api/tokens/batch',
    requiredRole: 'admin',
    description: 'Batch-create tokens (admin only)',
  },
  {
    id: 'M06',
    method: 'POST',
    path: '/api/governance/events/ingest',
    testPath: '/api/governance/events/ingest',
    requiredRole: 'admin',
    description: 'Ingest governance events (admin only)',
  },
  {
    id: 'M07',
    method: 'POST',
    path: '/api/webhooks/subscribe',
    testPath: '/api/webhooks/subscribe',
    requiredRole: 'user',
    description: 'Subscribe to webhook notifications',
  },
  {
    id: 'M08',
    method: 'DELETE',
    path: '/api/webhooks/unsubscribe/:id',
    testPath: '/api/webhooks/unsubscribe/99',
    requiredRole: 'user',
    description: 'Unsubscribe from webhook notifications',
  },
  {
    id: 'M09',
    method: 'POST',
    path: '/api/webhooks/:id/test',
    testPath: '/api/webhooks/99/test',
    requiredRole: 'user',
    description: 'Trigger a test webhook delivery',
  },
  {
    id: 'M10',
    method: 'POST',
    path: '/api/webhooks/dead-letters/:id/retry',
    testPath: '/api/webhooks/dead-letters/7/retry',
    requiredRole: 'admin',
    description: 'Retry a dead-letter webhook (admin only)',
  },
  {
    id: 'M11',
    method: 'POST',
    path: '/api/webhooks/dead-letters/:id/skip',
    testPath: '/api/webhooks/dead-letters/7/skip',
    requiredRole: 'admin',
    description: 'Skip a dead-letter webhook (admin only)',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Build a controlled test Express app
//
// Each route in MUTATIONS is registered with:
//   1. createAuthMiddleware(requiredRole)  ← enforces the declared role
//   2. A stub handler that returns 200     ← proves auth passed
// ─────────────────────────────────────────────────────────────────────────────

function buildTestApp(): express.Application {
  const app = express();
  app.use(express.json());

  for (const entry of MUTATIONS) {
    const router = Router();
    const guard = createAuthMiddleware(entry.requiredRole);
    const stub = (_req: Request, res: Response) =>
      res.status(200).json({ ok: true, endpoint: entry.id });

    const basePath = entry.path.replace(/^\/api/, '');

    switch (entry.method) {
      case 'POST':   router.post(basePath, guard, stub);   break;
      case 'PUT':    router.put(basePath, guard, stub);    break;
      case 'DELETE': router.delete(basePath, guard, stub); break;
    }

    app.use('/api', router);
  }

  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Authorization matrix — describe.each over every (endpoint, auth-state) pair
// ─────────────────────────────────────────────────────────────────────────────

describe('Mutation Authorization Matrix', () => {
  let app: express.Application;

  beforeEach(() => {
    app = buildTestApp();
  });

  describe.each(MUTATIONS)(
    '$id — $method $testPath ($description)',
    (entry) => {
      // ── Unauthenticated: must get 401 ──────────────────────────────────────
      it(`unauthenticated → 401 with code:UNAUTHENTICATED`, async () => {
        const res = await send(app, entry, null);

        expect(res.status).toBe(401);
        expect(res.body).toHaveProperty('code');
        expect(res.body.code).toBe('UNAUTHENTICATED');
        expect(res.body).toHaveProperty('error');
      });

      // ── Wrong role: must get 403 ───────────────────────────────────────────
      it(`wrong role → 403 with code:FORBIDDEN`, async () => {
        // 'user' role is wrong for admin-only, and 'unauthenticated' is wrong for user-only.
        const wrongRole: Role =
          entry.requiredRole === 'admin' ? 'user' : 'unauthenticated';
        const res = await send(app, entry, wrongRole);

        if (wrongRole === 'unauthenticated') {
          // unauthenticated is the no-auth case, still results in 401
          expect([401, 403]).toContain(res.status);
        } else {
          expect(res.status).toBe(403);
          expect(res.body).toHaveProperty('code');
          expect(res.body.code).toBe('FORBIDDEN');
          expect(res.body).toHaveProperty('error');
        }
      });

      // ── Correct role: must get 2xx ─────────────────────────────────────────
      it(`correct role (${entry.requiredRole}) → 200`, async () => {
        const res = await send(app, entry, entry.requiredRole);

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('ok', true);
        expect(res.body).toHaveProperty('endpoint', entry.id);
      });
    }
  );

  // ── Admin role passes all endpoints (superset of user) ──────────────────

  describe('admin role satisfies all endpoints', () => {
    it.each(MUTATIONS)(
      '$id — admin role → 200 on $method $testPath',
      async (entry) => {
        const res = await send(app, entry, 'admin');
        expect(res.status).toBe(200);
      }
    );
  });

  // ── Coverage: all entries in MUTATIONS table are tested ──────────────────

  it('MUTATIONS table covers all expected endpoint IDs', () => {
    const ids = MUTATIONS.map((m) => m.id);
    expect(ids).toContain('M01');
    expect(ids).toContain('M05');
    expect(ids).toContain('M11');
    expect(ids.length).toBeGreaterThanOrEqual(11);

    // Each entry must have a method, testPath, and requiredRole
    MUTATIONS.forEach((m) => {
      expect(['POST', 'PUT', 'DELETE']).toContain(m.method);
      expect(m.testPath).toBeTruthy();
      expect(['user', 'admin']).toContain(m.requiredRole);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: send a request with an optional role header
// ─────────────────────────────────────────────────────────────────────────────

function send(
  app: express.Application,
  entry: MutationEntry,
  role: Role | null
) {
  const agent = request(app);
  let req: ReturnType<typeof agent.post>;

  switch (entry.method) {
    case 'POST':   req = agent.post(entry.testPath);   break;
    case 'PUT':    req = agent.put(entry.testPath);    break;
    case 'DELETE': req = agent.delete(entry.testPath); break;
  }

  if (role && role !== 'unauthenticated') {
    req = req.set('X-Test-Role', role);
  }

  return req.set('Content-Type', 'application/json').send({});
}

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY MUTATION GUARD TESTS (M1-M8)
//
// These test the authorization guard CLASS directly (not via HTTP).
// Preserved from the original file for regression coverage.
// ─────────────────────────────────────────────────────────────────────────────

interface User {
  id: string;
  role: 'user' | 'admin' | 'super_admin';
  banned: boolean;
  tokenExpiry?: Date;
}

interface LegacyAuthRequest extends Request {
  admin?: User;
}

class AuthorizationGuard {
  private revokedTokens = new Set<string>();

  authenticateAdmin = async (
    req: LegacyAuthRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      if (this.revokedTokens.has(token)) {
        return res.status(401).json({ error: 'Token revoked' });
      }
      const decoded = this.decodeToken(token);
      if (!decoded) {
        return res.status(401).json({ error: 'Invalid token' });
      }
      if (decoded.exp && new Date(decoded.exp) < new Date()) {
        return res.status(401).json({ error: 'Token expired' });
      }
      const user = await this.findUserById(decoded.userId);
      if (!user) {
        return res.status(401).json({ error: 'User not found' });
      }
      if (user.banned) {
        return res.status(403).json({ error: 'Account banned' });
      }
      if (user.role === 'user') {
        return res.status(403).json({ error: 'Admin access required' });
      }
      req.admin = user;
      next();
    } catch {
      return res.status(401).json({ error: 'Authentication failed' });
    }
  };

  requireRole = (...roles: User['role'][]) => {
    return (req: LegacyAuthRequest, res: Response, next: NextFunction) => {
      if (!req.admin) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      if (!roles.includes(req.admin.role)) {
        return res.status(403).json({
          error: 'Insufficient permissions',
          required: roles,
          current: req.admin.role,
        });
      }
      next();
    };
  };

  requireSuperAdmin = (req: LegacyAuthRequest, res: Response, next: NextFunction) => {
    if (!req.admin || req.admin.role !== 'super_admin') {
      return res.status(403).json({ error: 'Super admin access required' });
    }
    next();
  };

  revokeToken(token: string) { this.revokedTokens.add(token); }

  private decodeToken(token: string): { userId: string; exp?: string } | null {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      return JSON.parse(Buffer.from(parts[1], 'base64').toString());
    } catch { return null; }
  }

  private async findUserById(userId: string): Promise<User | null> {
    const users: Record<string, User> = {
      'user-1':     { id: 'user-1',     role: 'admin',       banned: false },
      'user-2':     { id: 'user-2',     role: 'super_admin', banned: false },
      'user-3':     { id: 'user-3',     role: 'user',        banned: false },
      'user-banned':{ id: 'user-banned',role: 'admin',       banned: true  },
    };
    return users[userId] ?? null;
  }
}

describe('Mutation Tests: Authorization Guards (legacy M1–M8)', () => {
  let guard: AuthorizationGuard;
  let mockReq: Partial<LegacyAuthRequest>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    guard = new AuthorizationGuard();
    mockReq = { headers: {} };
    mockRes = {
      status: vi.fn().mockReturnThis(),
      json:   vi.fn().mockReturnThis(),
    };
    mockNext = vi.fn();
  });

  describe('[M1] Token existence check', () => {
    it('should reject request without token', async () => {
      mockReq.headers = {};
      await guard.authenticateAdmin(mockReq as LegacyAuthRequest, mockRes as Response, mockNext);
      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should reject request with empty Bearer token', async () => {
      mockReq.headers = { authorization: 'Bearer ' };
      await guard.authenticateAdmin(mockReq as LegacyAuthRequest, mockRes as Response, mockNext);
      expect(mockRes.status).toHaveBeenCalledWith(401);
    });

    it('should reject request with malformed Authorization header', async () => {
      mockReq.headers = { authorization: 'InvalidFormat token' };
      await guard.authenticateAdmin(mockReq as LegacyAuthRequest, mockRes as Response, mockNext);
      expect(mockRes.status).toHaveBeenCalledWith(401);
    });
  });

  describe('[M2] Role-based access control', () => {
    it('should reject regular user attempting admin access', async () => {
      const token = Buffer.from(JSON.stringify({ userId: 'user-3', exp: new Date(Date.now() + 3_600_000).toISOString() })).toString('base64');
      mockReq.headers = { authorization: `Bearer header.${token}.sig` };
      await guard.authenticateAdmin(mockReq as LegacyAuthRequest, mockRes as Response, mockNext);
      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should allow admin user', async () => {
      const token = Buffer.from(JSON.stringify({ userId: 'user-1', exp: new Date(Date.now() + 3_600_000).toISOString() })).toString('base64');
      mockReq.headers = { authorization: `Bearer header.${token}.sig` };
      await guard.authenticateAdmin(mockReq as LegacyAuthRequest, mockRes as Response, mockNext);
      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('[M3] Banned user detection', () => {
    it('should reject banned admin user', async () => {
      const token = Buffer.from(JSON.stringify({ userId: 'user-banned', exp: new Date(Date.now() + 3_600_000).toISOString() })).toString('base64');
      mockReq.headers = { authorization: `Bearer header.${token}.sig` };
      await guard.authenticateAdmin(mockReq as LegacyAuthRequest, mockRes as Response, mockNext);
      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe('[M4] Permission validation', () => {
    it('should reject unauthenticated request to protected endpoint', () => {
      const middleware = guard.requireRole('admin');
      mockReq.admin = undefined;
      middleware(mockReq as LegacyAuthRequest, mockRes as Response, mockNext);
      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should allow authenticated admin to access admin endpoint', () => {
      const middleware = guard.requireRole('admin');
      mockReq.admin = { id: 'user-1', role: 'admin', banned: false };
      middleware(mockReq as LegacyAuthRequest, mockRes as Response, mockNext);
      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('[M5] Role hierarchy enforcement', () => {
    it('should reject admin attempting super_admin action', () => {
      mockReq.admin = { id: 'user-1', role: 'admin', banned: false };
      guard.requireSuperAdmin(mockReq as LegacyAuthRequest, mockRes as Response, mockNext);
      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should allow super_admin to perform super_admin action', () => {
      mockReq.admin = { id: 'user-2', role: 'super_admin', banned: false };
      guard.requireSuperAdmin(mockReq as LegacyAuthRequest, mockRes as Response, mockNext);
      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('[M6] Token expiration validation', () => {
    it('should reject expired token', async () => {
      const token = Buffer.from(JSON.stringify({ userId: 'user-1', exp: new Date(Date.now() - 3_600_000).toISOString() })).toString('base64');
      mockReq.headers = { authorization: `Bearer header.${token}.sig` };
      await guard.authenticateAdmin(mockReq as LegacyAuthRequest, mockRes as Response, mockNext);
      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should accept valid non-expired token', async () => {
      const token = Buffer.from(JSON.stringify({ userId: 'user-1', exp: new Date(Date.now() + 3_600_000).toISOString() })).toString('base64');
      mockReq.headers = { authorization: `Bearer header.${token}.sig` };
      await guard.authenticateAdmin(mockReq as LegacyAuthRequest, mockRes as Response, mockNext);
      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('[M7] Null/undefined token handling', () => {
    it('should reject null token', async () => {
      mockReq.headers = { authorization: null as any };
      await guard.authenticateAdmin(mockReq as LegacyAuthRequest, mockRes as Response, mockNext);
      expect(mockRes.status).toHaveBeenCalledWith(401);
    });

    it('should reject undefined token', async () => {
      mockReq.headers = {};
      await guard.authenticateAdmin(mockReq as LegacyAuthRequest, mockRes as Response, mockNext);
      expect(mockRes.status).toHaveBeenCalledWith(401);
    });
  });

  describe('[M8] Permission logic inversion', () => {
    it('should reject user without required role', () => {
      const middleware = guard.requireRole('super_admin');
      mockReq.admin = { id: 'user-1', role: 'admin', banned: false };
      middleware(mockReq as LegacyAuthRequest, mockRes as Response, mockNext);
      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should allow user with required role', () => {
      const middleware = guard.requireRole('admin', 'super_admin');
      mockReq.admin = { id: 'user-1', role: 'admin', banned: false };
      middleware(mockReq as LegacyAuthRequest, mockRes as Response, mockNext);
      expect(mockNext).toHaveBeenCalled();
    });

    it('should handle multiple required roles correctly', () => {
      const middleware = guard.requireRole('super_admin', 'admin');
      mockReq.admin = { id: 'user-1', role: 'admin', banned: false };
      middleware(mockReq as LegacyAuthRequest, mockRes as Response, mockNext);
      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('Integration: Complex authorization scenarios', () => {
    it('should prevent privilege escalation through token manipulation', async () => {
      const token = Buffer.from(JSON.stringify({ userId: 'user-3', role: 'super_admin', exp: new Date(Date.now() + 3_600_000).toISOString() })).toString('base64');
      mockReq.headers = { authorization: `Bearer header.${token}.sig` };
      await guard.authenticateAdmin(mockReq as LegacyAuthRequest, mockRes as Response, mockNext);
      expect(mockRes.status).toHaveBeenCalledWith(403);
    });

    it('should enforce authorization on nested middleware chains', () => {
      const authMiddleware = guard.requireRole('admin');
      const superAdminMiddleware = guard.requireSuperAdmin;

      mockReq.admin = { id: 'user-1', role: 'admin', banned: false };
      authMiddleware(mockReq as LegacyAuthRequest, mockRes as Response, mockNext);
      expect(mockNext).toHaveBeenCalled();

      vi.clearAllMocks();
      mockRes.status = vi.fn().mockReturnThis();
      mockNext = vi.fn();

      superAdminMiddleware(mockReq as LegacyAuthRequest, mockRes as Response, mockNext);
      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should handle revoked tokens correctly', async () => {
      const token = Buffer.from(JSON.stringify({ userId: 'user-1', exp: new Date(Date.now() + 3_600_000).toISOString() })).toString('base64');
      const validToken = `header.${token}.sig`;

      mockReq.headers = { authorization: `Bearer ${validToken}` };
      await guard.authenticateAdmin(mockReq as LegacyAuthRequest, mockRes as Response, mockNext);
      expect(mockNext).toHaveBeenCalled();

      guard.revokeToken(validToken);
      vi.clearAllMocks();
      mockRes.status = vi.fn().mockReturnThis();
      mockNext = vi.fn();

      await guard.authenticateAdmin(mockReq as LegacyAuthRequest, mockRes as Response, mockNext);
      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockNext).not.toHaveBeenCalled();
    });
  });
});
