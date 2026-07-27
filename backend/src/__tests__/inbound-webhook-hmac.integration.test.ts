/**
 * Integration tests for inbound webhook HMAC verification (#1157, #1300).
 * Extended with timing-attack vector coverage per issue #1300.
 */

import { describe, it, expect, vi } from "vitest";
import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import {
  verifyInboundWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
} from "../middleware/webhookSignature";
import {
  generateWebhookSignature,
  generateWebhookSecret,
} from "../utils/crypto";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(body: string, signatureHeader?: string): Partial<Request> {
  return {
    headers: signatureHeader
      ? { [WEBHOOK_SIGNATURE_HEADER]: signatureHeader }
      : {},
    body,
    rawBody: body,
  } as any;
}

interface MockRes {
  res: Partial<Response>;
  statusCode: number | null;
  jsonBody: any;
}

function makeRes(): MockRes {
  const state = { statusCode: null as number | null, jsonBody: null as any };

  const res: Partial<Response> = {
    status(code: number) {
      state.statusCode = code;
      return this as Response;
    },
    json(data: any) {
      state.jsonBody = data;
      return this as Response;
    },
  };

  return {
    res,
    get statusCode() { return state.statusCode; },
    get jsonBody() { return state.jsonBody; },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("verifyInboundWebhookSignature (#1157)", () => {
  const secret = generateWebhookSecret();
  const payload = JSON.stringify({ event: "token.created", data: { id: "abc" } });

  it("calls next() for a valid signature", async () => {
    const signature = generateWebhookSignature(payload, secret);
    const req = makeReq(payload, signature);
    const mock = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    const middleware = verifyInboundWebhookSignature(async () => secret);
    await middleware(req as Request, mock.res as Response, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("returns 401 when the signature header is missing", async () => {
    const req = makeReq(payload);
    const mock = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    const middleware = verifyInboundWebhookSignature(async () => secret);
    await middleware(req as Request, mock.res as Response, next);

    expect(mock.statusCode).toBe(401);
    expect(mock.jsonBody.error).toMatch(/missing/i);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when the signature is invalid (wrong secret)", async () => {
    const signature = generateWebhookSignature(payload, "wrong-secret");
    const req = makeReq(payload, signature);
    const mock = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    const middleware = verifyInboundWebhookSignature(async () => secret);
    await middleware(req as Request, mock.res as Response, next);

    expect(mock.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when the payload has been tampered with", async () => {
    const signature = generateWebhookSignature(payload, secret);
    const tampered = payload.replace("abc", "xyz");
    const req = makeReq(tampered, signature);
    const mock = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    const middleware = verifyInboundWebhookSignature(async () => secret);
    await middleware(req as Request, mock.res as Response, next);

    expect(mock.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when the subscription secret cannot be resolved", async () => {
    const signature = generateWebhookSignature(payload, secret);
    const req = makeReq(payload, signature);
    const mock = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    const middleware = verifyInboundWebhookSignature(async () => null);
    await middleware(req as Request, mock.res as Response, next);

    expect(mock.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 for a replayed (old) signature", async () => {
    const oldTimestamp = Math.floor(Date.now() / 1000) - 600; // 10 min ago
    const signature = generateWebhookSignature(payload, secret, oldTimestamp);
    const req = makeReq(payload, signature);
    const mock = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    const middleware = verifyInboundWebhookSignature(async () => secret);
    await middleware(req as Request, mock.res as Response, next);

    expect(mock.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Timing-attack vector coverage (#1300)
// ---------------------------------------------------------------------------

describe("HMAC timing-attack vector coverage (#1300)", () => {
  const secret = generateWebhookSecret();
  const payload = JSON.stringify({ event: "token.burned", data: { id: "t1" } });

  // Helper: run the middleware and return elapsed nanoseconds
  async function measureVerification(signatureHeader: string): Promise<bigint> {
    const req = makeReq(payload, signatureHeader);
    const mock = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    const middleware = verifyInboundWebhookSignature(async () => secret);

    const start = process.hrtime.bigint();
    await middleware(req as Request, mock.res as Response, next);
    return process.hrtime.bigint() - start;
  }

  it("crypto.timingSafeEqual is invoked for every valid-format verification", async () => {
    const spy = vi.spyOn(crypto, "timingSafeEqual");
    spy.mockClear();

    const signature = generateWebhookSignature(payload, secret);
    const req = makeReq(payload, signature);
    const mock = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    const middleware = verifyInboundWebhookSignature(async () => secret);
    await middleware(req as Request, mock.res as Response, next);

    // timingSafeEqual must have been called at least once
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("truncated signature is rejected", async () => {
    const full = generateWebhookSignature(payload, secret);
    const truncated = full.slice(0, full.length - 8); // strip last 8 hex chars
    const req = makeReq(payload, truncated);
    const mock = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    const middleware = verifyInboundWebhookSignature(async () => secret);
    await middleware(req as Request, mock.res as Response, next);

    expect(mock.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("replay attack: timestamp older than 5 minutes is rejected", async () => {
    const staleTimestamp = Math.floor(Date.now() / 1000) - 301; // 5 min 1 sec ago
    const signature = generateWebhookSignature(payload, secret, staleTimestamp);
    const req = makeReq(payload, signature);
    const mock = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    const middleware = verifyInboundWebhookSignature(async () => secret);
    await middleware(req as Request, mock.res as Response, next);

    expect(mock.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("p95 response-time variance between valid and invalid signatures is < 5 ms", async () => {
    const TRIALS = 100;
    const validSig = generateWebhookSignature(payload, secret);
    const invalidSig = generateWebhookSignature(payload, "wrong-secret-key-value");

    const validTimes: bigint[] = [];
    const invalidTimes: bigint[] = [];

    for (let i = 0; i < TRIALS; i++) {
      validTimes.push(await measureVerification(validSig));
      invalidTimes.push(await measureVerification(invalidSig));
    }

    const p95 = (times: bigint[]): number => {
      const sorted = [...times].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const idx = Math.floor(sorted.length * 0.95);
      return Number(sorted[idx]) / 1_000_000; // ns → ms
    };

    const diff = Math.abs(p95(validTimes) - p95(invalidTimes));

    // p95 timing difference must stay under 5 ms to be timing-safe
    expect(diff).toBeLessThan(5);
  }, 30_000); // allow 30s for 200 sequential async calls
});
