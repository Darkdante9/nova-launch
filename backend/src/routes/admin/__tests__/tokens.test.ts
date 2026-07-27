/**
 * Tests for GET/PATCH/DELETE /api/admin/tokens — #1694.
 *
 * The Database class now delegates to Prisma instead of an in-memory Map.
 * These tests mock Prisma and verify that route handlers read/write real
 * database rows rather than operating on a stub that resets on restart.
 */
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

// ── Mock auth ─────────────────────────────────────────────────────────────
vi.mock("../../../middleware/auth", () => ({
  authenticateAdmin: (_req: any, _res: any, next: any) => {
    _req.admin = { id: "admin-1", role: "super_admin" };
    next();
  },
  requireSuperAdmin: (_req: any, _res: any, next: any) => next(),
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));

// ── Mutable in-test token store ────────────────────────────────────────────
const _tokenRows: Record<string, any> = {
  "token-1": {
    id: "token-1",
    name: "Alpha",
    symbol: "ALPH",
    address: "CTOKEN1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    creator: "GCREATOR1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    totalSupply: BigInt("2000000"),
    totalBurned: BigInt("100"),
    flagged: false,
    deleted: false,
    metadata: {},
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-02"),
  },
  "token-2": {
    id: "token-2",
    name: "Beta",
    symbol: "BETA",
    address: "CTOKEN2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    creator: "GCREATOR2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    totalSupply: BigInt("500000"),
    totalBurned: BigInt("0"),
    flagged: true,
    deleted: false,
    metadata: {},
    createdAt: new Date("2024-02-01"),
    updatedAt: new Date("2024-02-02"),
  },
};

const _userRows: Record<string, any> = {
  "GCREATOR1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA": {
    id: "user-1",
    address: "GCREATOR1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    role: "user",
    banned: false,
    createdAt: new Date("2024-01-01"),
    lastActive: new Date("2024-01-02"),
  },
};

// ── Mock Prisma ────────────────────────────────────────────────────────────
vi.mock("../../../lib/prisma", () => ({
  default: {
    user: {
      findUnique: vi.fn(({ where }: any) => {
        if (where.id) return Promise.resolve(_userRows[where.id] ?? null);
        if (where.address) return Promise.resolve(_userRows[where.address] ?? null);
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
        const updated = { ...row, ...data, updatedAt: new Date() };
        _tokenRows[where.id] = updated;
        return Promise.resolve(updated);
      }),
    },
    adminAuditLog: {
      create: vi.fn((d: any) =>
        Promise.resolve({ id: "log-1", timestamp: new Date(), ...d.data })
      ),
      findMany: vi.fn(() => Promise.resolve([])),
      deleteMany: vi.fn(() => Promise.resolve({ count: 0 })),
    },
  },
}));

// Import router AFTER mocks are registered
import tokensRouter from "../tokens";

const app = express();
app.use(express.json());
app.use("/", tokensRouter);

// ─────────────────────────────────────────────────────────────────────────────
describe("GET /api/admin/tokens — list tokens (#1694)", () => {
  it("returns tokens from the database", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.tokens)).toBe(true);
    expect(res.body.data.tokens.length).toBeGreaterThan(0);
  });

  it("response maps Prisma fields to app field names", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    const token = res.body.data.tokens[0];
    // contractAddress comes from Prisma's `address` column
    expect(token).toHaveProperty("contractAddress");
    // creatorAddress comes from Prisma's `creator` column
    expect(token).toHaveProperty("creatorAddress");
    // burned comes from Prisma's `totalBurned` BigInt
    expect(token).toHaveProperty("burned");
    expect(token).toHaveProperty("flagged");
    expect(token).toHaveProperty("deleted");
  });

  it("filters flagged=true", async () => {
    const res = await request(app).get("/?flagged=true");
    expect(res.status).toBe(200);
    for (const t of res.body.data.tokens) {
      expect(t.flagged).toBe(true);
    }
  });

  it("filters flagged=false", async () => {
    const res = await request(app).get("/?flagged=false");
    expect(res.status).toBe(200);
    for (const t of res.body.data.tokens) {
      expect(t.flagged).toBe(false);
    }
  });

  it("filters by creator address", async () => {
    const creator = "GCREATOR1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const res = await request(app).get(`/?creator=${creator}`);
    expect(res.status).toBe(200);
    for (const t of res.body.data.tokens) {
      expect(t.creatorAddress).toBe(creator);
    }
  });
});

describe("GET /api/admin/tokens/:id — get token details (#1694)", () => {
  it("returns token-1 by id", async () => {
    const res = await request(app).get("/token-1");
    expect(res.status).toBe(200);
    expect(res.body.data.token.id).toBe("token-1");
  });

  it("returns 404 for unknown token", async () => {
    const res = await request(app).get("/not-a-token");
    expect(res.status).toBe(404);
  });

  it("includes creator info when found", async () => {
    const res = await request(app).get("/token-1");
    expect(res.status).toBe(200);
    // creator address exists in userStore → creator should be populated
    expect(res.body.data.creator).not.toBeNull();
  });
});

describe("PATCH /api/admin/tokens/:id — update token (#1694)", () => {
  it("flags a token and persists the change", async () => {
    const res = await request(app).patch("/token-1").send({ flagged: true });
    expect(res.status).toBe(200);
    expect(res.body.data.token.flagged).toBe(true);
  });

  it("updates token metadata", async () => {
    const metadata = { description: "Updated via Prisma", verified: true };
    const res = await request(app).patch("/token-1").send({ metadata });
    expect(res.status).toBe(200);
    expect(res.body.data.token.metadata).toEqual(metadata);
  });

  it("returns 404 for unknown token", async () => {
    const res = await request(app).patch("/ghost").send({ flagged: true });
    expect(res.status).toBe(404);
  });

  it("rejects invalid payload", async () => {
    const res = await request(app).patch("/token-1").send({ flagged: "yes" });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/admin/tokens/:id — soft delete (#1694)", () => {
  it("soft-deletes token-2", async () => {
    const res = await request(app).delete("/token-2");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // The in-test store should now have deleted=true
    expect(_tokenRows["token-2"].deleted).toBe(true);
  });

  it("returns 404 for already-absent token", async () => {
    const res = await request(app).delete("/no-such-token");
    expect(res.status).toBe(404);
  });
});
