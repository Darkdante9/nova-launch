/**
 * Tests for GET/PATCH /api/admin/users — #1694.
 *
 * The Database class now delegates to Prisma instead of an in-memory Map.
 * These tests mock Prisma and verify that route handlers read/write real
 * database rows rather than operating on a stub that resets on restart.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ── Mock auth so routes are reachable without a real JWT ──────────────────
vi.mock("../../../middleware/auth", () => ({
  authenticateAdmin: (_req: any, _res: any, next: any) => {
    _req.admin = { id: "admin-1", role: "super_admin" };
    next();
  },
  requireSuperAdmin: (_req: any, _res: any, next: any) => next(),
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));

// ── Mock Prisma so no real DB is needed ────────────────────────────────────
const _userRows: Record<string, any> = {
  "user-1": {
    id: "user-1",
    address: "GUSER1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    role: "user",
    banned: false,
    createdAt: new Date("2024-01-01"),
    lastActive: new Date("2024-01-02"),
  },
  "admin-1": {
    id: "admin-1",
    address: "GADMIN1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    role: "super_admin",
    banned: false,
    createdAt: new Date("2024-01-01"),
    lastActive: new Date("2024-01-02"),
  },
};

const _tokenRows: Record<string, any> = {
  "token-1": {
    id: "token-1",
    name: "Test Token",
    symbol: "TEST",
    address: "CTOKEN1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    creator: "GUSER1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    totalSupply: BigInt("1000000"),
    totalBurned: BigInt("5000"),
    flagged: false,
    deleted: false,
    metadata: { description: "A test token" },
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-02"),
  },
};

const _auditRows: any[] = [];

vi.mock("../../../lib/prisma", () => ({
  default: {
    user: {
      findUnique: vi.fn(({ where }: any) => {
        if (where.id) return Promise.resolve(_userRows[where.id] ?? null);
        if (where.address)
          return Promise.resolve(
            Object.values(_userRows).find((u: any) => u.address === where.address) ?? null
          );
        return Promise.resolve(null);
      }),
      findMany: vi.fn(() => Promise.resolve(Object.values(_userRows))),
      update: vi.fn(({ where, data }: any) => {
        const row = _userRows[where.id];
        if (!row) return Promise.resolve(null);
        const updated = { ...row, ...data };
        _userRows[where.id] = updated;
        return Promise.resolve(updated);
      }),
    },
    token: {
      findUnique: vi.fn(({ where }: any) =>
        Promise.resolve(_tokenRows[where.id] ?? null)
      ),
      findMany: vi.fn(({ where }: any) => {
        let rows = Object.values(_tokenRows);
        if (where && where.deleted === false) {
          rows = rows.filter((r: any) => !r.deleted);
        }
        return Promise.resolve(rows);
      }),
      update: vi.fn(({ where, data }: any) => {
        const row = _tokenRows[where.id];
        if (!row) return Promise.resolve(null);
        const updated = { ...row, ...data };
        _tokenRows[where.id] = updated;
        return Promise.resolve(updated);
      }),
    },
    adminAuditLog: {
      create: vi.fn((d: any) => {
        const row = { id: `log-${Date.now()}`, timestamp: new Date(), ...d.data };
        _auditRows.push(row);
        return Promise.resolve(row);
      }),
      findMany: vi.fn(({ where }: any) => {
        let logs = [..._auditRows];
        if (where?.adminId) logs = logs.filter((l) => l.adminId === where.adminId);
        return Promise.resolve(logs);
      }),
      deleteMany: vi.fn(() => Promise.resolve({ count: _auditRows.length })),
    },
  },
}));

// Import router AFTER mocks are registered
import usersRouter from "../users";

const app = express();
app.use(express.json());
app.use("/", usersRouter);

// ─────────────────────────────────────────────────────────────────────────────
describe("GET /api/admin/users — list users (#1694)", () => {
  it("returns users from the database", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.users)).toBe(true);
    expect(res.body.data.users.length).toBeGreaterThan(0);
  });

  it("response includes expected user fields", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    const user = res.body.data.users[0];
    expect(user).toHaveProperty("id");
    expect(user).toHaveProperty("address");
    expect(user).toHaveProperty("role");
    expect(user).toHaveProperty("banned");
  });

  it("filters by banned=true", async () => {
    const res = await request(app).get("/?banned=true");
    expect(res.status).toBe(200);
    // No users are banned in our seed data — result should be empty
    expect(res.body.data.users.length).toBe(0);
  });

  it("filters by role super_admin", async () => {
    const res = await request(app).get("/?role=super_admin");
    expect(res.status).toBe(200);
    for (const u of res.body.data.users) {
      expect(u.role).toBe("super_admin");
    }
  });
});

describe("GET /api/admin/users/:id — get user details (#1694)", () => {
  it("returns user with id user-1", async () => {
    const res = await request(app).get("/user-1");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user.id).toBe("user-1");
  });

  it("returns 404 for unknown user", async () => {
    const res = await request(app).get("/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it("includes token activity for the user", async () => {
    const res = await request(app).get("/user-1");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty("tokens");
    expect(res.body.data).toHaveProperty("activity");
  });
});

describe("PATCH /api/admin/users/:id — update user (#1694)", () => {
  it("bans an existing user and reflects the change", async () => {
    const res = await request(app).patch("/user-1").send({ banned: true });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user.banned).toBe(true);
  });

  it("changes user role", async () => {
    const res = await request(app).patch("/user-1").send({ role: "admin" });
    expect(res.status).toBe(200);
    expect(res.body.data.user.role).toBe("admin");
  });

  it("returns 404 for unknown user", async () => {
    const res = await request(app).patch("/ghost").send({ banned: true });
    expect(res.status).toBe(404);
  });

  it("rejects invalid role value", async () => {
    const res = await request(app).patch("/user-1").send({ role: "overlord" });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
