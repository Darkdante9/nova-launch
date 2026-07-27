/**
 * Unit tests for POST /api/admin/reconcile/:tokenAddress
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import reconcileRouter from "../reconcile";

// ─── mock prisma ────────────────────────────────────────────────────────────
vi.mock("../../../lib/prisma", () => ({
  prisma: {},
}));

// ─── mock verifier ──────────────────────────────────────────────────────────
const mockReconcileProjection = vi.fn();

vi.mock(
  "../../../services/consistency/onchainProjectionVerifier",
  () => ({
    OnChainProjectionVerifier: vi.fn().mockImplementation(() => ({
      reconcileProjection: mockReconcileProjection,
    })),
  })
);

// ─── mock auth ──────────────────────────────────────────────────────────────
vi.mock("../../../middleware/auth", () => ({
  authenticateAdmin: (_req: any, _res: any, next: any) => next(),
}));

// ─── app setup ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use("/api/admin/reconcile", reconcileRouter);

// ─── tests ──────────────────────────────────────────────────────────────────

describe("POST /api/admin/reconcile/:tokenAddress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with reconciliation result on success", async () => {
    const tokenAddress = "CTOKEN1AAABBBCCC";
    mockReconcileProjection.mockResolvedValue({
      tokenAddress,
      fieldsUpdated: ["totalBurned", "burnCount"],
      alreadyConsistent: false,
      lastReconciledAt: new Date("2026-06-24T00:00:00Z"),
    });

    const res = await request(app)
      .post(`/api/admin/reconcile/${tokenAddress}`)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.tokenAddress).toBe(tokenAddress);
    expect(res.body.data.fieldsUpdated).toEqual(["totalBurned", "burnCount"]);
    expect(res.body.data.alreadyConsistent).toBe(false);
    expect(mockReconcileProjection).toHaveBeenCalledWith(tokenAddress);
  });

  it("returns 200 when projection is already consistent", async () => {
    mockReconcileProjection.mockResolvedValue({
      tokenAddress: "CTOKEN1AAABBBCCC",
      fieldsUpdated: [],
      alreadyConsistent: true,
      lastReconciledAt: new Date(),
    });

    const res = await request(app)
      .post("/api/admin/reconcile/CTOKEN1AAABBBCCC")
      .expect(200);

    expect(res.body.data.alreadyConsistent).toBe(true);
    expect(res.body.data.fieldsUpdated).toHaveLength(0);
  });

  it("returns 404 when token is not in the projection", async () => {
    mockReconcileProjection.mockRejectedValue(
      new Error("token not found in projection: CUNKNOWN")
    );

    const res = await request(app)
      .post("/api/admin/reconcile/CUNKNOWN")
      .expect(404);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 500 on unexpected reconciliation error", async () => {
    mockReconcileProjection.mockRejectedValue(new Error("Horizon unavailable"));

    const res = await request(app)
      .post("/api/admin/reconcile/CTOKEN1AAABBBCCC")
      .expect(500);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("INTERNAL_SERVER_ERROR");
  });
});
