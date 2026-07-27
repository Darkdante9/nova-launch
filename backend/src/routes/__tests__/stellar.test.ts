/**
 * Integration tests for GET /api/stellar/fee-stats
 *
 * Covers:
 *  - Happy path: proxies and normalizes Horizon's /fee_stats response
 *  - Caching: a second request within the cache window does not re-hit Horizon
 *  - Upstream failure: Horizon error surfaces as a 502 with errorResponse shape
 *
 * Issue: #1405
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import nock from "nock";
import request from "supertest";
import express from "express";

const HORIZON_URL = "https://horizon-testnet.stellar.org";

function mockHorizonFeeStats(overrides: Partial<Record<string, string>> = {}) {
  const bucket = {
    max: "10000",
    min: "100",
    mode: "100",
    p10: "100",
    p20: "100",
    p30: "100",
    p40: "100",
    p50: "100",
    p60: "150",
    p70: "200",
    p80: "300",
    p90: "500",
    p95: "1000",
    p99: "5000",
    ...overrides,
  };

  return {
    last_ledger: "123456",
    last_ledger_base_fee: "100",
    ledger_capacity_usage: "0.42",
    fee_charged: bucket,
    max_fee: bucket,
  };
}

describe("GET /api/stellar/fee-stats", () => {
  let app: express.Express;

  beforeEach(async () => {
    process.env.STELLAR_HORIZON_URL = HORIZON_URL;
    nock.cleanAll();
    vi.resetModules();

    // Import after setting env vars so module-level reads (if any) pick them up.
    const stellarRoutes = (await import("../stellar")).default;
    app = express();
    app.use(express.json());
    app.use("/api/stellar", stellarRoutes);
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it("returns normalized fee stats on success", async () => {
    nock(HORIZON_URL).get("/fee_stats").reply(200, mockHorizonFeeStats());

    const response = await request(app).get("/api/stellar/fee-stats").expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data).toMatchObject({
      lastLedger: 123456,
      lastLedgerBaseFee: 100,
      ledgerCapacityUsage: 0.42,
      feeCharged: {
        min: 100,
        max: 10000,
        mode: 100,
        p50: 100,
        p90: 500,
        p99: 5000,
      },
    });
    expect(typeof response.body.data.fetchedAt).toBe("string");
    expect(() => new Date(response.body.data.fetchedAt)).not.toThrow();
  });

  it("returns numeric types, not strings, for percentile fields", async () => {
    nock(HORIZON_URL).get("/fee_stats").reply(200, mockHorizonFeeStats());

    const response = await request(app).get("/api/stellar/fee-stats").expect(200);

    const { feeCharged } = response.body.data;
    for (const key of ["min", "max", "mode", "p50", "p75", "p90", "p99"]) {
      if (key in feeCharged) {
        expect(typeof feeCharged[key]).toBe("number");
      }
    }
  });

  it("caches results for subsequent requests within the cache window", async () => {
    const scope = nock(HORIZON_URL)
      .get("/fee_stats")
      .reply(200, mockHorizonFeeStats());

    const first = await request(app).get("/api/stellar/fee-stats").expect(200);
    // Second request should be served from cache — no second Horizon call configured.
    const second = await request(app).get("/api/stellar/fee-stats").expect(200);

    expect(first.body.data.fetchedAt).toBe(second.body.data.fetchedAt);
    expect(scope.isDone()).toBe(true);
  });

  it("returns a 502 error envelope when Horizon is unreachable", async () => {
    nock(HORIZON_URL).get("/fee_stats").replyWithError("network error");

    const response = await request(app).get("/api/stellar/fee-stats").expect(502);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toMatchObject({
      code: "HORIZON_FEE_STATS_ERROR",
    });
  });

  it("returns a 502 error envelope when Horizon responds with 5xx", async () => {
    nock(HORIZON_URL).get("/fee_stats").reply(503, { error: "unavailable" });

    const response = await request(app).get("/api/stellar/fee-stats").expect(502);

    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe("HORIZON_FEE_STATS_ERROR");
  });
});
