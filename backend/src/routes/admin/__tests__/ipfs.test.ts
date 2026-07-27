/**
 * Integration tests for Admin IPFS Pin Monitor routes (#1403)
 *
 * Coverage:
 *  - GET /api/admin/ipfs/pins — list tracked pins with derived status
 *  - POST /api/admin/ipfs/re-pin/:cid — trigger re-pin, update tracking record
 *  - Authentication requirements
 *  - Success, validation, and error paths
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express, { Express } from "express";
import ipfsRouter from "../ipfs";
import { prisma } from "../../../lib/prisma";
import { checkPinStatus } from "../../../lib/ipfs/pinMonitor";
import { getActivePinataCredentials } from "../../../lib/ipfs/pinata.js";
import { pinataQueue } from "../../../lib/ipfs/pinataQueue.js";
import { MetricsCollector } from "../../../lib/metrics";

// Mock Prisma
vi.mock("../../../lib/prisma", () => ({
  prisma: {
    iPFSPin: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

// Mock pin monitor
vi.mock("../../../lib/ipfs/pinMonitor", () => ({
  checkPinStatus: vi.fn(),
}));

// Mock Pinata credential accessor
vi.mock("../../../lib/ipfs/pinata.js", () => ({
  getActivePinataCredentials: vi.fn(),
}));

// Mock Pinata queue
vi.mock("../../../lib/ipfs/pinataQueue.js", () => ({
  pinataQueue: {
    enqueue: vi.fn((fn: () => Promise<unknown>) => fn()),
  },
}));

// Mock metrics collector
vi.mock("../../../lib/metrics", () => ({
  MetricsCollector: {
    recordIPFSOperation: vi.fn(),
  },
}));

// Mock the auth middleware
vi.mock("../../../middleware/auth", () => ({
  authenticateAdmin: (_req: any, res: any, next: any) => {
    const token = _req.headers.authorization?.replace("Bearer ", "");
    if (token === "valid-token") {
      next();
    } else {
      res.status(401).json({ success: false, error: { code: "UNAUTHORIZED" } });
    }
  },
}));

let app: Express;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(pinataQueue.enqueue).mockImplementation((fn: () => Promise<unknown>) => fn());
  app = express();
  app.use(express.json());
  app.use("/api/admin/ipfs", ipfsRouter);
});

// ── GET /pins ────────────────────────────────────────────────────────────────

describe("GET /api/admin/ipfs/pins", () => {
  it("returns pins with derived status when authenticated", async () => {
    const now = new Date();
    vi.mocked(prisma.iPFSPin.findMany).mockResolvedValueOnce([
      {
        id: "1",
        cid: "QmGood",
        tokenName: "GoodToken",
        tokenAddress: "0xabc",
        pinned: true,
        failureCount: 0,
        lastChecked: now,
        error: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "2",
        cid: "QmWarn",
        tokenName: "WarnToken",
        tokenAddress: "0xdef",
        pinned: false,
        failureCount: 2,
        lastChecked: now,
        error: "timeout",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "3",
        cid: "QmFail",
        tokenName: "FailToken",
        tokenAddress: "0xghi",
        pinned: false,
        failureCount: 4,
        lastChecked: now,
        error: "not found",
        createdAt: now,
        updatedAt: now,
      },
    ] as any);

    const res = await request(app)
      .get("/api/admin/ipfs/pins")
      .set("Authorization", "Bearer valid-token");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.total).toBe(3);
    expect(res.body.data.pins[0].status).toBe("pinned");
    expect(res.body.data.pins[1].status).toBe("warning");
    expect(res.body.data.pins[2].status).toBe("failed");
  });

  it("returns empty list when no pins are tracked", async () => {
    vi.mocked(prisma.iPFSPin.findMany).mockResolvedValueOnce([]);

    const res = await request(app)
      .get("/api/admin/ipfs/pins")
      .set("Authorization", "Bearer valid-token");

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ pins: [], total: 0 });
  });

  it("returns 401 when not authenticated", async () => {
    const res = await request(app).get("/api/admin/ipfs/pins");
    expect(res.status).toBe(401);
  });

  it("returns 500 when prisma throws", async () => {
    vi.mocked(prisma.iPFSPin.findMany).mockRejectedValueOnce(new Error("DB down"));

    const res = await request(app)
      .get("/api/admin/ipfs/pins")
      .set("Authorization", "Bearer valid-token");

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_SERVER_ERROR");
  });
});

// ── POST /re-pin/:cid ──────────────────────────────────────────────────────────

describe("POST /api/admin/ipfs/re-pin/:cid", () => {
  beforeEach(() => {
    vi.mocked(getActivePinataCredentials).mockReturnValue({
      apiKey: "test-key",
      apiSecret: "test-secret",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
        text: async () => "",
      })
    );
  });

  it("re-pins successfully and updates the tracking record", async () => {
    vi.mocked(checkPinStatus).mockResolvedValueOnce({ cid: "QmABC", pinned: true });
    vi.mocked(prisma.iPFSPin.findUnique).mockResolvedValueOnce(null);
    vi.mocked(prisma.iPFSPin.upsert).mockResolvedValueOnce({
      id: "1",
      cid: "QmABC",
      tokenName: null,
      tokenAddress: null,
      pinned: true,
      failureCount: 0,
      lastChecked: new Date(),
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    const res = await request(app)
      .post("/api/admin/ipfs/re-pin/QmABC")
      .set("Authorization", "Bearer valid-token");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.pinned).toBe(true);
    expect(res.body.data.status).toBe("pinned");
    expect(vi.mocked(prisma.iPFSPin.upsert)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { cid: "QmABC" },
        create: expect.objectContaining({ cid: "QmABC", pinned: true, failureCount: 0 }),
        update: expect.objectContaining({ pinned: true, failureCount: 0 }),
      })
    );
    expect(MetricsCollector.recordIPFSOperation).toHaveBeenCalledWith(
      "re-pin",
      "success",
      expect.any(Number)
    );
  });

  it("increments failureCount when the re-pin cannot be verified", async () => {
    vi.mocked(checkPinStatus).mockResolvedValueOnce({
      cid: "QmBAD",
      pinned: false,
      error: "Pinata API error: HTTP 500",
    });
    vi.mocked(prisma.iPFSPin.findUnique).mockResolvedValueOnce({
      id: "2",
      cid: "QmBAD",
      tokenName: null,
      tokenAddress: null,
      pinned: false,
      failureCount: 2,
      lastChecked: new Date(),
      error: "previous error",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
    vi.mocked(prisma.iPFSPin.upsert).mockResolvedValueOnce({
      id: "2",
      cid: "QmBAD",
      tokenName: null,
      tokenAddress: null,
      pinned: false,
      failureCount: 3,
      lastChecked: new Date(),
      error: "Pinata API error: HTTP 500",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    const res = await request(app)
      .post("/api/admin/ipfs/re-pin/QmBAD")
      .set("Authorization", "Bearer valid-token");

    expect(res.status).toBe(200);
    expect(res.body.data.pinned).toBe(false);
    expect(res.body.data.failureCount).toBe(3);
    expect(res.body.data.status).toBe("warning");
    expect(vi.mocked(prisma.iPFSPin.upsert)).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ failureCount: 3 }),
      })
    );
  });

  it("returns 503 when Pinata credentials are not configured", async () => {
    vi.mocked(getActivePinataCredentials).mockImplementationOnce(() => {
      throw new Error("Pinata credentials are not configured");
    });

    const res = await request(app)
      .post("/api/admin/ipfs/re-pin/QmABC")
      .set("Authorization", "Bearer valid-token");

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("PINATA_NOT_CONFIGURED");
  });

  it("returns 500 and records a failed attempt when the Pinata pin call fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "Internal error",
        json: async () => ({}),
      })
    );
    vi.mocked(prisma.iPFSPin.findUnique).mockResolvedValueOnce(null);
    vi.mocked(prisma.iPFSPin.upsert).mockResolvedValueOnce({} as any);

    const res = await request(app)
      .post("/api/admin/ipfs/re-pin/QmFAIL")
      .set("Authorization", "Bearer valid-token");

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("RE_PIN_FAILED");
    expect(MetricsCollector.recordIPFSOperation).toHaveBeenCalledWith(
      "re-pin",
      "failure",
      expect.any(Number)
    );
    expect(prisma.iPFSPin.upsert).toHaveBeenCalled();
  });

  it("returns 401 when not authenticated", async () => {
    const res = await request(app).post("/api/admin/ipfs/re-pin/QmABC");
    expect(res.status).toBe(401);
  });
});
