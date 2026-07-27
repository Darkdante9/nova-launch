import { describe, it, expect, beforeEach, vi } from "vitest";
import express, { Request, Response } from "express";
import request from "supertest";
import {
  IdempotencyStore,
  createIdempotencyMiddleware,
  DEFAULT_IDEMPOTENCY_WINDOW_MS,
  IDEMPOTENCY_HEADER,
} from "../middleware/idempotency";

function buildApp(store: IdempotencyStore) {
  const app = express();
  app.use(express.json());
  app.use(createIdempotencyMiddleware(store));

  let callCount = 0;
  app.post("/tokens", (_req: Request, res: Response) => {
    callCount++;
    res.status(201).json({ id: `tok-${callCount}`, callCount });
  });

  return { app, getCallCount: () => callCount };
}

describe("IdempotencyStore", () => {
  it("returns undefined for an unseen key", () => {
    const store = new IdempotencyStore();
    expect(store.get("missing")).toBeUndefined();
  });

  it("returns the stored result within the window", () => {
    const store = new IdempotencyStore(60_000);
    store.set("k1", 201, { id: "abc" });
    const result = store.get("k1");
    expect(result?.body).toEqual({ id: "abc" });
    expect(result?.statusCode).toBe(201);
  });

  it("returns undefined after the window expires", () => {
    vi.useFakeTimers();
    const store = new IdempotencyStore(1_000);
    store.set("k2", 201, { id: "xyz" });
    vi.advanceTimersByTime(1_001);
    expect(store.get("k2")).toBeUndefined();
    vi.useRealTimers();
  });

  it("purgeExpired removes stale entries", () => {
    vi.useFakeTimers();
    const store = new IdempotencyStore(500);
    store.set("a", 201, {});
    store.set("b", 201, {});
    vi.advanceTimersByTime(600);
    store.purgeExpired();
    expect(store.size).toBe(0);
    vi.useRealTimers();
  });

  it("tracks in-flight keys", () => {
    const store = new IdempotencyStore();
    expect(store.isInFlight("key-x")).toBe(false);
    store.markInFlight("key-x");
    expect(store.isInFlight("key-x")).toBe(true);
    store.clearInFlight("key-x");
    expect(store.isInFlight("key-x")).toBe(false);
  });

  it("complete() stores result and clears in-flight", () => {
    const store = new IdempotencyStore();
    store.markInFlight("key-y");
    expect(store.isInFlight("key-y")).toBe(true);
    store.complete("key-y", 201, { done: true });
    expect(store.isInFlight("key-y")).toBe(false);
    const result = store.get("key-y");
    expect(result?.statusCode).toBe(201);
    expect(result?.body).toEqual({ done: true });
  });

  it("delete() removes both stored result and in-flight marker", () => {
    const store = new IdempotencyStore();
    store.markInFlight("key-z");
    store.complete("key-z", 200, {});
    store.delete("key-z");
    expect(store.get("key-z")).toBeUndefined();
    expect(store.isInFlight("key-z")).toBe(false);
  });
});

describe("createIdempotencyMiddleware", () => {
  let store: IdempotencyStore;

  beforeEach(() => {
    store = new IdempotencyStore();
  });

  it("passes through requests without an idempotency key", async () => {
    const { app, getCallCount } = buildApp(store);
    await request(app).post("/tokens").send({}).expect(201);
    await request(app).post("/tokens").send({}).expect(201);
    expect(getCallCount()).toBe(2);
  });

  it("returns the original response on a retried key", async () => {
    const { app, getCallCount } = buildApp(store);

    const r1 = await request(app)
      .post("/tokens")
      .set(IDEMPOTENCY_HEADER, "key-001")
      .send({})
      .expect(201);

    const r2 = await request(app)
      .post("/tokens")
      .set(IDEMPOTENCY_HEADER, "key-001")
      .send({})
      .expect(201);

    // Handler only called once
    expect(getCallCount()).toBe(1);
    // Both responses have the same body
    expect(r2.body).toEqual(r1.body);
  });

  it("treats different keys as independent requests", async () => {
    const { app, getCallCount } = buildApp(store);

    await request(app).post("/tokens").set(IDEMPOTENCY_HEADER, "key-A").send({}).expect(201);
    await request(app).post("/tokens").set(IDEMPOTENCY_HEADER, "key-B").send({}).expect(201);

    expect(getCallCount()).toBe(2);
  });

  it("rejects a key that is too long", async () => {
    const { app } = buildApp(store);
    const longKey = "x".repeat(256);
    const r = await request(app)
      .post("/tokens")
      .set(IDEMPOTENCY_HEADER, longKey)
      .send({});
    expect(r.status).toBe(400);
  });

  it("does not cache error responses", async () => {
    const store2 = new IdempotencyStore();
    const app2 = express();
    app2.use(express.json());
    app2.use(createIdempotencyMiddleware(store2));

    let calls = 0;
    app2.post("/fail-then-succeed", (_req, res) => {
      calls++;
      if (calls === 1) return res.status(500).json({ error: "boom" });
      return res.status(201).json({ id: "ok" });
    });

    await request(app2).post("/fail-then-succeed").set(IDEMPOTENCY_HEADER, "k-err").send({});
    const r2 = await request(app2).post("/fail-then-succeed").set(IDEMPOTENCY_HEADER, "k-err").send({});

    // Second call should have reached the handler (error not cached)
    expect(calls).toBe(2);
    expect(r2.status).toBe(201);
  });

  it("expires stored key after the configured window", async () => {
    vi.useFakeTimers();
    const shortStore = new IdempotencyStore(500);
    const { app, getCallCount } = buildApp(shortStore);

    await request(app).post("/tokens").set(IDEMPOTENCY_HEADER, "expire-key").send({}).expect(201);

    // Advance past the window
    vi.advanceTimersByTime(600);

    await request(app).post("/tokens").set(IDEMPOTENCY_HEADER, "expire-key").send({}).expect(201);

    expect(getCallCount()).toBe(2);
    vi.useRealTimers();
  });

  it("returns 409 with PROCESSING status when a key is in-flight", async () => {
    const { app } = buildApp(store);

    // Pre-mark the key as in-flight to simulate a concurrent request
    store.markInFlight("inflight-key");

    const r = await request(app)
      .post("/tokens")
      .set(IDEMPOTENCY_HEADER, "inflight-key")
      .send({});

    expect(r.status).toBe(409);
    expect(r.body).toEqual({ status: "PROCESSING", requestId: "inflight-key" });
  });

  it("sets Idempotency-Status: processing header on 409 response", async () => {
    const { app } = buildApp(store);

    store.markInFlight("inflight-key-2");

    const r = await request(app)
      .post("/tokens")
      .set(IDEMPOTENCY_HEADER, "inflight-key-2")
      .send({});

    expect(r.status).toBe(409);
    expect(r.headers["idempotency-status"]).toBe("processing");
    expect(r.headers[IDEMPOTENCY_HEADER]).toBe("inflight-key-2");
  });

  it("sets Idempotency-Status: replayed header on cached response", async () => {
    const { app } = buildApp(store);

    // First request — completes and caches
    await request(app)
      .post("/tokens")
      .set(IDEMPOTENCY_HEADER, "replay-key")
      .send({})
      .expect(201);

    // Second request — should be a replay
    const r2 = await request(app)
      .post("/tokens")
      .set(IDEMPOTENCY_HEADER, "replay-key")
      .send({});

    expect(r2.status).toBe(201);
    expect(r2.headers["idempotency-status"]).toBe("replayed");
    expect(r2.headers[IDEMPOTENCY_HEADER]).toBe("replay-key");
  });

  it("sets Idempotency-Key header on cached response", async () => {
    const { app } = buildApp(store);

    await request(app)
      .post("/tokens")
      .set(IDEMPOTENCY_HEADER, "header-key")
      .send({})
      .expect(201);

    const r2 = await request(app)
      .post("/tokens")
      .set(IDEMPOTENCY_HEADER, "header-key")
      .send({});

    expect(r2.headers[IDEMPOTENCY_HEADER]).toBe("header-key");
  });

  it("allows retry after in-flight is cleared (failed request)", async () => {
    const store2 = new IdempotencyStore();
    const app2 = express();
    app2.use(express.json());
    app2.use(createIdempotencyMiddleware(store2));

    let calls = 0;
    app2.post("/maybe-fail", (_req, res) => {
      calls++;
      if (calls === 1) return res.status(500).json({ error: "temporary failure" });
      return res.status(201).json({ id: "recovered" });
    });

    // First attempt fails → in-flight should be cleared
    const r1 = await request(app2)
      .post("/maybe-fail")
      .set(IDEMPOTENCY_HEADER, "retry-after-fail")
      .send({});
    expect(r1.status).toBe(500);
    expect(store2.isInFlight("retry-after-fail")).toBe(false);

    // Second attempt should reach the handler (not blocked or cached)
    const r2 = await request(app2)
      .post("/maybe-fail")
      .set(IDEMPOTENCY_HEADER, "retry-after-fail")
      .send({});
    expect(r2.status).toBe(201);
    expect(calls).toBe(2);
  });

  it("expired key is re-executed normally (no 409, no cached replay)", async () => {
    vi.useFakeTimers();
    const shortStore = new IdempotencyStore(500);
    const { app, getCallCount } = buildApp(shortStore);

    // First request
    const r1 = await request(app)
      .post("/tokens")
      .set(IDEMPOTENCY_HEADER, "short-key")
      .send({})
      .expect(201);

    // Advance past window so entry expires
    vi.advanceTimersByTime(600);

    // Second request — should re-execute
    const r2 = await request(app)
      .post("/tokens")
      .set(IDEMPOTENCY_HEADER, "short-key")
      .send({})
      .expect(201);

    expect(getCallCount()).toBe(2);
    // Bodies differ because handler was called twice
    expect(r2.body).not.toEqual(r1.body);
    vi.useRealTimers();
  });
});
