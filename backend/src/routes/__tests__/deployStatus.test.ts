/**
 * Integration tests for GET /api/deploy/status/:txHash
 *
 * Covers all 4 step transitions by mocking Horizon responses:
 *   submitted  – Horizon returns 404 (tx not yet seen)
 *   confirming – Horizon has tx in ledger, confirmations < 7
 *   finalized  – Horizon has tx in ledger, confirmations >= 7
 *   + failed tx, invalid params, Horizon error
 *
 * Issue: #1374
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import nock from "nock";
import request from "supertest";
import express from "express";

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const VALID_TX_HASH = "a".repeat(64);

describe("GET /deploy/status/:txHash", () => {
  let app: express.Express;

  beforeEach(async () => {
    process.env.STELLAR_HORIZON_URL = HORIZON_URL;
    nock.cleanAll();
    vi.resetModules();

    const deployStatusRouter = (await import("../deployStatus")).default;
    app = express();
    app.use(express.json());
    app.use("/deploy", deployStatusRouter);
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it("returns step=submitted when Horizon returns 404 (tx not yet seen)", async () => {
    nock(HORIZON_URL)
      .get(`/transactions/${VALID_TX_HASH}`)
      .reply(404, { status: 404, title: "Resource Missing" });

    const res = await request(app)
      .get(`/deploy/${VALID_TX_HASH}`)
      .query({ network: "testnet" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.step).toBe("submitted");
    expect(res.body.data.txHash).toBe(VALID_TX_HASH);
    expect(res.body.data.totalConfirmations).toBe(7);
  });

  it("returns step=confirming with n<7 when tx is in a ledger with few confirmations", async () => {
    const txLedger = 1000;
    const latestLedger = 1003; // 4 confirmations (1003 - 1000 + 1)

    nock(HORIZON_URL)
      .get(`/transactions/${VALID_TX_HASH}`)
      .reply(200, { successful: true, ledger: txLedger });

    nock(HORIZON_URL)
      .get("/ledgers")
      .query({ order: "desc", limit: "1" })
      .reply(200, {
        _embedded: { records: [{ sequence: latestLedger }] },
      });

    const res = await request(app)
      .get(`/deploy/${VALID_TX_HASH}`)
      .query({ network: "testnet" });

    expect(res.status).toBe(200);
    expect(res.body.data.step).toBe("confirming");
    expect(res.body.data.confirmations).toBe(4);
    expect(res.body.data.totalConfirmations).toBe(7);
  });

  it("returns step=finalized when tx has >= 7 confirmations", async () => {
    const txLedger = 1000;
    const latestLedger = 1006; // 7 confirmations

    nock(HORIZON_URL)
      .get(`/transactions/${VALID_TX_HASH}`)
      .reply(200, { successful: true, ledger: txLedger });

    nock(HORIZON_URL)
      .get("/ledgers")
      .query({ order: "desc", limit: "1" })
      .reply(200, {
        _embedded: { records: [{ sequence: latestLedger }] },
      });

    const res = await request(app)
      .get(`/deploy/${VALID_TX_HASH}`)
      .query({ network: "testnet" });

    expect(res.status).toBe(200);
    expect(res.body.data.step).toBe("finalized");
    expect(res.body.data.confirmations).toBe(7);
  });

  it("returns step=submitted with reason when transaction failed on-chain", async () => {
    nock(HORIZON_URL)
      .get(`/transactions/${VALID_TX_HASH}`)
      .reply(200, { successful: false, ledger: 999 });

    const res = await request(app)
      .get(`/deploy/${VALID_TX_HASH}`)
      .query({ network: "testnet" });

    expect(res.status).toBe(200);
    expect(res.body.data.step).toBe("submitted");
    expect(res.body.data.reason).toMatch(/failed/i);
  });

  it("returns 400 for an invalid txHash", async () => {
    const res = await request(app)
      .get("/deploy/invalid-hash")
      .query({ network: "testnet" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("INVALID_TX_HASH");
  });

  it("returns 400 for an invalid network", async () => {
    const res = await request(app)
      .get(`/deploy/${VALID_TX_HASH}`)
      .query({ network: "stagenet" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_NETWORK");
  });

  it("returns 502 when Horizon is unreachable", async () => {
    nock(HORIZON_URL)
      .get(`/transactions/${VALID_TX_HASH}`)
      .replyWithError("Connection refused");

    const res = await request(app)
      .get(`/deploy/${VALID_TX_HASH}`)
      .query({ network: "testnet" });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("HORIZON_ERROR");
  });
});
