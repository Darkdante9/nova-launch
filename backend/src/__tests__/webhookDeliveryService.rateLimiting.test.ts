/**
 * Integration tests: per-tenant rate limiting wired into
 * WebhookDeliveryService (Issue #1336).
 *
 * Verifies the TenantWebhookRateLimiter is actually applied BEFORE the
 * outbound HTTP call in `deliverWebhook`, keyed by `subscription.createdBy`
 * ("tenant" — see comment on `WebhookDeliveryService.getTenantId`):
 *   - A tenant within its burst budget delivers immediately.
 *   - A tenant exceeding burst has the excess QUEUED (delivered later, once
 *     tokens refill) rather than dropped — every subscription still ends up
 *     delivered and logged exactly once.
 *   - One busy tenant does not starve a different tenant's delivery.
 *
 * Uses vi.useFakeTimers() to advance the token-bucket refill loop
 * deterministically instead of real sleeps.
 */

// Set env vars BEFORE any imports so module-level constants pick them up.
process.env.WEBHOOK_MAX_RETRIES = "1";
process.env.WEBHOOK_RETRY_DELAY_MS = "0";
process.env.WEBHOOK_TIMEOUT_MS = "5000";
// Small, easy-to-reason-about rate limit for this file's assertions:
// 1 token/sec sustained, burst of 3.
process.env.WEBHOOK_RATE_LIMIT_PER_MINUTE = "60";
process.env.WEBHOOK_RATE_LIMIT_BURST = "3";

import nock from "nock";
import { describe, it, beforeEach, afterEach, vi, expect } from "vitest";
import { v4 as uuidv4 } from "uuid";
import {
  WebhookEventType,
  WebhookSubscription,
  TokenCreatedEventData,
} from "../types/webhook";

const BASE_URL = "http://rate-limit-test.local";

function makeSubscription(tenant: string, path: string): WebhookSubscription {
  return {
    id: `sub-${uuidv4()}`,
    url: `${BASE_URL}${path}`,
    events: [WebhookEventType.TOKEN_CREATED],
    secret: "rate-limit-test-secret",
    active: true,
    createdBy: tenant,
    createdAt: new Date(),
    lastTriggered: null,
    tokenAddress: null,
  };
}

const eventData: TokenCreatedEventData = {
  tokenAddress: "GTOKEN_RATE_LIMIT_TEST",
  creator: "GCREATOR_RATE_LIMIT_TEST",
  name: "Rate Limit Token",
  symbol: "RLT",
  decimals: 7,
  initialSupply: "1000000",
  transactionHash: "rate-limit-tx-hash",
  ledger: 77777,
};

let service: import("../services/webhookDeliveryService").WebhookDeliveryService;
let webhookServiceMod: typeof import("../services/webhookService").default;
let rateLimiterMod: typeof import("../services/tenantWebhookRateLimiter").default;
let deliveredOrder: string[] = [];

beforeEach(async () => {
  vi.resetModules();
  deliveredOrder = [];

  const wsMod = await import("../services/webhookService");
  webhookServiceMod = wsMod.default;
  vi.spyOn(webhookServiceMod, "logDelivery").mockResolvedValue(undefined);
  vi.spyOn(webhookServiceMod, "updateLastTriggered").mockResolvedValue(undefined);

  const rlMod = await import("../services/tenantWebhookRateLimiter");
  rateLimiterMod = rlMod.default;

  const mod = await import("../services/webhookDeliveryService");
  service = mod.default;
});

afterEach(() => {
  nock.cleanAll();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("WebhookDeliveryService — per-tenant rate limiting", () => {
  it("delivers immediately while a tenant is within its burst budget", async () => {
    const tenant = "tenant-within-budget";
    const sub1 = makeSubscription(tenant, "/hook-1");
    const sub2 = makeSubscription(tenant, "/hook-2");
    const sub3 = makeSubscription(tenant, "/hook-3");

    nock(BASE_URL).post("/hook-1").reply(200, () => {
      deliveredOrder.push(sub1.id);
      return {};
    });
    nock(BASE_URL).post("/hook-2").reply(200, () => {
      deliveredOrder.push(sub2.id);
      return {};
    });
    nock(BASE_URL).post("/hook-3").reply(200, () => {
      deliveredOrder.push(sub3.id);
      return {};
    });

    // Burst capacity is 3 — exactly these 3 deliveries must succeed
    // without any artificial delay.
    await Promise.all([
      service.deliverWebhook(sub1, WebhookEventType.TOKEN_CREATED, eventData),
      service.deliverWebhook(sub2, WebhookEventType.TOKEN_CREATED, eventData),
      service.deliverWebhook(sub3, WebhookEventType.TOKEN_CREATED, eventData),
    ]);

    expect(deliveredOrder.sort()).toEqual([sub1.id, sub2.id, sub3.id].sort());
    expect(webhookServiceMod.logDelivery).toHaveBeenCalledTimes(3);
    expect(nock.isDone()).toBe(true);
  });

  it("queues excess deliveries beyond burst capacity instead of dropping them", async () => {
    vi.useFakeTimers();
    const tenant = "tenant-over-budget";

    const subs = Array.from({ length: 5 }, (_, i) =>
      makeSubscription(tenant, `/hook-${i}`)
    );
    subs.forEach((sub, i) => {
      nock(BASE_URL)
        .post(`/hook-${i}`)
        .reply(200, () => {
          deliveredOrder.push(sub.id);
          return {};
        });
    });

    // Fire all 5 deliveries "at once" for one tenant. Burst capacity is 3,
    // so the other 2 must be queued, not dropped.
    const deliveryPromises = subs.map((sub) =>
      service.deliverWebhook(sub, WebhookEventType.TOKEN_CREATED, eventData)
    );

    // Let the first wave (immediate, within-burst) settle. Two ticks are
    // needed: the first lets the rate limiter's immediately-resolved
    // `acquire()` promise settle, the second lets the now-unblocked
    // axios/nock request-response microtask chain resolve.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(deliveredOrder.length).toBe(3);
    expect(rateLimiterMod.getQueueLength(tenant)).toBe(2);

    // Advance fake time enough for the remaining 2 tokens to refill
    // (1 token/sec at our configured rate) and the queue to drain.
    await vi.advanceTimersByTimeAsync(2200);

    await Promise.all(deliveryPromises);

    // Crucially: ALL 5 subscriptions were eventually delivered — none
    // silently dropped because the tenant was over budget.
    expect(deliveredOrder.length).toBe(5);
    expect(new Set(deliveredOrder).size).toBe(5);
    expect(webhookServiceMod.logDelivery).toHaveBeenCalledTimes(5);
    expect(rateLimiterMod.getQueueLength(tenant)).toBe(0);
    expect(nock.isDone()).toBe(true);
  });

  it("does not let a busy tenant starve a different tenant's deliveries", async () => {
    vi.useFakeTimers();
    const busyTenant = "tenant-busy";
    const quietTenant = "tenant-quiet";

    // Busy tenant fires 6 deliveries — well beyond its burst of 3.
    const busySubs = Array.from({ length: 6 }, (_, i) =>
      makeSubscription(busyTenant, `/busy-${i}`)
    );
    busySubs.forEach((sub, i) => {
      nock(BASE_URL)
        .post(`/busy-${i}`)
        .reply(200, () => {
          deliveredOrder.push(sub.id);
          return {};
        });
    });

    // Quiet tenant fires a single delivery — comfortably within its own budget.
    const quietSub = makeSubscription(quietTenant, "/quiet-0");
    nock(BASE_URL)
      .post("/quiet-0")
      .reply(200, () => {
        deliveredOrder.push(quietSub.id);
        return {};
      });

    const busyPromises = busySubs.map((sub) =>
      service.deliverWebhook(sub, WebhookEventType.TOKEN_CREATED, eventData)
    );
    const quietPromise = service.deliverWebhook(
      quietSub,
      WebhookEventType.TOKEN_CREATED,
      eventData
    );

    // Two ticks: one for `acquire()` to settle, one for the unblocked
    // axios/nock request-response microtask chain to resolve.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    // The quiet tenant's single delivery must succeed immediately,
    // regardless of how backed up the busy tenant's queue is.
    expect(deliveredOrder).toContain(quietSub.id);
    expect(rateLimiterMod.getQueueLength(quietTenant)).toBe(0);

    // The busy tenant should have exactly 3 delivered immediately and 3 queued.
    const busyDeliveredSoFar = deliveredOrder.filter((id) =>
      busySubs.some((s) => s.id === id)
    );
    expect(busyDeliveredSoFar.length).toBe(3);
    expect(rateLimiterMod.getQueueLength(busyTenant)).toBe(3);

    // Drain the busy tenant's queue.
    await vi.advanceTimersByTimeAsync(3200);
    await Promise.all(busyPromises);
    await quietPromise;

    expect(deliveredOrder.length).toBe(7);
    expect(rateLimiterMod.getQueueLength(busyTenant)).toBe(0);
  });
});
