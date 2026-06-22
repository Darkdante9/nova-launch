/**
 * Unit + integration tests for POST /api/tokens/batch
 *
 * Covers:
 *  - Valid batch (all succeed)
 *  - Oversized batch (> 10 tokens) → 400
 *  - Partial failure rollback (Stellar call fails mid-batch)
 *  - DB transaction failure rollback
 *  - Authentication / tenant failure → 400
 *  - Empty tokens array → 400
 *  - Per-item validation errors (missing name, bad symbol, etc.)
 *  - Mixed success/failure returns HTTP 207
 *
 * Issue: #1263
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import tokenRoutes from "../tokens";

// ---------------------------------------------------------------------------
// Mock prisma
// ---------------------------------------------------------------------------
vi.mock("../../lib/prisma", () => ({
  prisma: {
    token: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Mock the batch deploy service so we can control on-chain + DB behaviour
// ---------------------------------------------------------------------------
vi.mock("../../services/batchTokenDeployService", () => ({
  batchDeployTokens: vi.fn(),
}));

import { prisma } from "../../lib/prisma";
import { batchDeployTokens } from "../../services/batchTokenDeployService";
import type {
  TokenDeployInput,
  BatchDeployResult,
  DeployedToken,
} from "../../services/batchTokenDeployService";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

const TENANT_ID = "GCREATOR1";

const app = express();
app.use(express.json());
app.use("/api/tokens", tokenRoutes);

function withTenant(r: request.Test): request.Test {
  return r.set("X-Tenant-ID", TENANT_ID);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function buildInput(overrides: Partial<TokenDeployInput> = {}): TokenDeployInput {
  return {
    creator: "GCREATORABC123",
    name: "Test Token",
    symbol: "TEST",
    decimals: 7,
    initialSupply: "1000000",
    ...overrides,
  };
}

function buildDeployedToken(overrides: Partial<DeployedToken> = {}): DeployedToken {
  return {
    id: "uuid-1",
    address: "GCREATEST0000000000000000000000000000000000000000000000",
    creator: "GCREATORABC123",
    name: "Test Token",
    symbol: "TEST",
    decimals: 7,
    totalSupply: "1000000",
    initialSupply: "1000000",
    totalBurned: "0",
    burnCount: 0,
    metadataUri: null,
    createdAt: new Date("2024-01-01").toISOString(),
    updatedAt: new Date("2024-01-01").toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/tokens/batch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Tenant / auth ─────────────────────────────────────────────────────────

  it("returns 400 when the X-Tenant-ID header is missing", async () => {
    const res = await request(app)
      .post("/api/tokens/batch")
      .send({ tokens: [buildInput()] });

    expect(res.status).toBe(400);
    // batchDeployTokens should never be called
    expect(batchDeployTokens).not.toHaveBeenCalled();
  });

  // ── Validation: oversized batch ───────────────────────────────────────────

  it("returns 400 when more than 10 tokens are submitted", async () => {
    const tokens = Array.from({ length: 11 }, (_, i) =>
      buildInput({ symbol: `TK${String(i).padStart(2, "0")}` })
    );

    const res = await withTenant(
      request(app).post("/api/tokens/batch").send({ tokens })
    );

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(batchDeployTokens).not.toHaveBeenCalled();
  });

  // ── Validation: empty array ───────────────────────────────────────────────

  it("returns 400 when tokens array is empty", async () => {
    const res = await withTenant(
      request(app).post("/api/tokens/batch").send({ tokens: [] })
    );

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(batchDeployTokens).not.toHaveBeenCalled();
  });

  // ── Validation: missing body ──────────────────────────────────────────────

  it("returns 400 when request body is missing the tokens field", async () => {
    const res = await withTenant(
      request(app).post("/api/tokens/batch").send({})
    );

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  // ── Validation: per-item rules ────────────────────────────────────────────

  it("returns 400 when a token has an invalid symbol (lowercase)", async () => {
    const res = await withTenant(
      request(app)
        .post("/api/tokens/batch")
        .send({ tokens: [buildInput({ symbol: "bad" })] })
    );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when a token has an invalid symbol (too long)", async () => {
    const res = await withTenant(
      request(app)
        .post("/api/tokens/batch")
        .send({ tokens: [buildInput({ symbol: "TOOLONGSYMBOL" })] }) // 13 chars
    );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when decimals is out of range (> 18)", async () => {
    const res = await withTenant(
      request(app)
        .post("/api/tokens/batch")
        .send({ tokens: [buildInput({ decimals: 19 })] })
    );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when decimals is negative", async () => {
    const res = await withTenant(
      request(app)
        .post("/api/tokens/batch")
        .send({ tokens: [buildInput({ decimals: -1 })] })
    );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when initialSupply is not a numeric string", async () => {
    const res = await withTenant(
      request(app)
        .post("/api/tokens/batch")
        .send({ tokens: [buildInput({ initialSupply: "not-a-number" })] })
    );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when metadataUri is not a valid URL", async () => {
    const res = await withTenant(
      request(app)
        .post("/api/tokens/batch")
        .send({ tokens: [buildInput({ metadataUri: "not-a-url" })] })
    );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when name is empty", async () => {
    const res = await withTenant(
      request(app)
        .post("/api/tokens/batch")
        .send({ tokens: [buildInput({ name: "" })] })
    );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  it("returns 200 with succeeded tokens when all deployments succeed", async () => {
    const inputs = [buildInput({ symbol: "TKA" }), buildInput({ symbol: "TKB" })];
    const succeeded: DeployedToken[] = inputs.map((inp, i) =>
      buildDeployedToken({ id: `uuid-${i}`, symbol: inp.symbol! })
    );

    vi.mocked(batchDeployTokens).mockResolvedValueOnce({
      succeeded,
      failed: [],
    } satisfies BatchDeployResult);

    const res = await withTenant(
      request(app).post("/api/tokens/batch").send({ tokens: inputs })
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.succeeded).toHaveLength(2);
    expect(res.body.data.failed).toHaveLength(0);
    expect(batchDeployTokens).toHaveBeenCalledWith(inputs);
  });

  it("accepts an optional valid metadataUri", async () => {
    const input = buildInput({ metadataUri: "https://ipfs.io/ipfs/QmTest" });

    vi.mocked(batchDeployTokens).mockResolvedValueOnce({
      succeeded: [buildDeployedToken({ metadataUri: input.metadataUri! })],
      failed: [],
    } satisfies BatchDeployResult);

    const res = await withTenant(
      request(app).post("/api/tokens/batch").send({ tokens: [input] })
    );

    expect(res.status).toBe(200);
    expect(res.body.data.succeeded[0].metadataUri).toBe(input.metadataUri);
  });

  it("accepts the maximum batch size of 10 tokens", async () => {
    const inputs = Array.from({ length: 10 }, (_, i) =>
      buildInput({ symbol: `TK${String(i).padStart(2, "0")}` })
    );
    const succeeded = inputs.map((inp, i) =>
      buildDeployedToken({ id: `uuid-${i}`, symbol: inp.symbol! })
    );

    vi.mocked(batchDeployTokens).mockResolvedValueOnce({
      succeeded,
      failed: [],
    } satisfies BatchDeployResult);

    const res = await withTenant(
      request(app).post("/api/tokens/batch").send({ tokens: inputs })
    );

    expect(res.status).toBe(200);
    expect(res.body.data.succeeded).toHaveLength(10);
  });

  // ── Partial failure / rollback ────────────────────────────────────────────

  it("returns 422 when all deployments fail (full rollback)", async () => {
    const input = buildInput();

    vi.mocked(batchDeployTokens).mockResolvedValueOnce({
      succeeded: [],
      failed: [{ input, error: "Stellar contract call failed" }],
    } satisfies BatchDeployResult);

    const res = await withTenant(
      request(app).post("/api/tokens/batch").send({ tokens: [input] })
    );

    expect(res.status).toBe(422);
    expect(res.body.success).toBe(true); // envelope is still success
    expect(res.body.data.succeeded).toHaveLength(0);
    expect(res.body.data.failed).toHaveLength(1);
    expect(res.body.data.failed[0].error).toBe("Stellar contract call failed");
  });

  it("returns 207 Multi-Status when some succeed and some fail", async () => {
    const inputs = [buildInput({ symbol: "TKA" }), buildInput({ symbol: "TKB" })];

    vi.mocked(batchDeployTokens).mockResolvedValueOnce({
      succeeded: [buildDeployedToken({ symbol: "TKA" })],
      failed: [{ input: inputs[1], error: "Contract call timed out" }],
    } satisfies BatchDeployResult);

    const res = await withTenant(
      request(app).post("/api/tokens/batch").send({ tokens: inputs })
    );

    expect(res.status).toBe(207);
    expect(res.body.data.succeeded).toHaveLength(1);
    expect(res.body.data.failed).toHaveLength(1);
    expect(res.body.data.failed[0].input.symbol).toBe("TKB");
  });

  it("passes inputs to batchDeployTokens exactly as validated", async () => {
    const inputs = [buildInput()];

    vi.mocked(batchDeployTokens).mockResolvedValueOnce({
      succeeded: [buildDeployedToken()],
      failed: [],
    } satisfies BatchDeployResult);

    await withTenant(
      request(app).post("/api/tokens/batch").send({ tokens: inputs })
    );

    expect(batchDeployTokens).toHaveBeenCalledWith(inputs);
  });

  // ── Service-level errors ──────────────────────────────────────────────────

  it("returns 500 when batchDeployTokens throws an unexpected error", async () => {
    vi.mocked(batchDeployTokens).mockRejectedValueOnce(
      new Error("Unexpected DB failure")
    );

    const res = await withTenant(
      request(app)
        .post("/api/tokens/batch")
        .send({ tokens: [buildInput()] })
    );

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
  });
});
