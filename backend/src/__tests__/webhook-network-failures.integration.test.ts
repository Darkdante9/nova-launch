/**
 * Webhook Network Failure Scenarios Integration Tests
 *
 * Validates webhook delivery survives transient network failures, times out
 * appropriately, and records terminal failures for alerting.
 *
 * Strategy:
 *   - Use Nock to simulate timeouts, 5xx responses, and connection resets
 *   - Assert transient failures are retried and eventually delivered
 *   - Assert persistently failing endpoint is marked failed after retry exhaustion
 *   - Verify delivery records/metrics are updated correctly
 */

// Set BEFORE importing webhookDeliveryService so the per-tenant rate
// limiter singleton (created at module load) picks up a large bucket. This
// file's fixtures share one createdBy/"tenant" across many `it()` blocks
// with no module reset, and is about network-failure handling, not rate
// limiting — raise the bucket so deliveries here are never queued.
process.env.WEBHOOK_RATE_LIMIT_PER_MINUTE = "100000";
process.env.WEBHOOK_RATE_LIMIT_BURST = "10000";

import { describe, it, beforeEach, afterEach, vi, expect } from "vitest";
import nock from "nock";
import { v4 as uuidv4 } from "uuid";
import {
  WebhookEventType,
  WebhookSubscription,
  TokenCreatedEventData,
} from "../types/webhook";
import { WebhookDeliveryService } from "../services/webhookDeliveryService";
import webhookService from "../services/webhookService";

// ── Constants ──────────────────────────────────────────────────────────────

const BASE_URL = "http://webhook-network-test.local";
const WEBHOOK_TIMEOUT_MS = 200;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 50;

// ── Fixtures ───────────────────────────────────────────────────────────────

function makeSubscription(path = "/hook"): WebhookSubscription {
  return {
    id: `sub-${uuidv4()}`,
    url: `${BASE_URL}${path}`,
    events: [WebhookEventType.TOKEN_CREATED],
    secret: "network-test-secret-32-bytes!",
    active: true,
    createdBy: "GCREATOR_NETWORK_TEST",
    createdAt: new Date(),
    lastTriggered: null,
    tokenAddress: null,
  };
}

const tokenCreatedData: TokenCreatedEventData = {
  tokenAddress: "GTOKEN_NETWORK_TEST_ADDRESS",
  creator: "GCREATOR_NETWORK_TEST",
  name: "Network Test Token",
  symbol: "NTWK",
  decimals: 7,
  initialSupply: "1000000",
  transactionHash: "network-test-tx-hash",
  ledger: 12345,
};

// ── In-memory delivery log ─────────────────────────────────────────────────

interface DeliveryLog {
  subscriptionId: string;
  event: WebhookEventType;
  statusCode: number | null;
  success: boolean;
  attempts: number;
  errorMessage: string | null;
  timestamp: Date;
}

let deliveryLogs: DeliveryLog[] = [];

// Mock webhookService.logDelivery
vi.spyOn(webhookService, "logDelivery").mockImplementation(
  async (subscriptionId, event, payload, statusCode, success, attempts, errorMessage) => {
    deliveryLogs.push({
      subscriptionId,
      event,
      statusCode,
      success,
      attempts,
      errorMessage: errorMessage || null,
      timestamp: new Date(),
    });
  }
);

// Mock webhookService.updateLastTriggered
vi.spyOn(webhookService, "updateLastTriggered").mockResolvedValue(undefined);

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Webhook Network Failure Scenarios", () => {
  let service: WebhookDeliveryService;

  beforeEach(() => {
    service = new WebhookDeliveryService();
    deliveryLogs = [];
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
    vi.clearAllMocks();
  });

  describe("Transient Failures (5xx)", () => {
    it("should retry on 500 and eventually succeed", async () => {
      const subscription = makeSubscription("/retry-500");

      // First two attempts fail with 500, third succeeds
      nock(BASE_URL)
        .post("/retry-500")
        .times(2)
        .reply(500, { error: "Internal Server Error" });

      nock(BASE_URL).post("/retry-500").reply(200, { success: true });

      await service.deliverWebhook(
        subscription,
        WebhookEventType.TOKEN_CREATED,
        tokenCreatedData
      );

      // Should have logged exactly one delivery record
      expect(deliveryLogs).toHaveLength(1);
      expect(deliveryLogs[0].success).toBe(true);
      expect(deliveryLogs[0].attempts).toBe(3);
      expect(deliveryLogs[0].statusCode).toBe(200);
    });

    it("should retry on 502 Bad Gateway", async () => {
      const subscription = makeSubscription("/retry-502");

      nock(BASE_URL)
        .post("/retry-502")
        .times(1)
        .reply(502, { error: "Bad Gateway" });

      nock(BASE_URL).post("/retry-502").reply(200, { success: true });

      await service.deliverWebhook(
        subscription,
        WebhookEventType.TOKEN_CREATED,
        tokenCreatedData
      );

      expect(deliveryLogs[0].success).toBe(true);
      expect(deliveryLogs[0].attempts).toBeGreaterThan(1);
    });

    it("should retry on 503 Service Unavailable", async () => {
      const subscription = makeSubscription("/retry-503");

      nock(BASE_URL)
        .post("/retry-503")
        .times(2)
        .reply(503, { error: "Service Unavailable" });

      nock(BASE_URL).post("/retry-503").reply(200, { success: true });

      await service.deliverWebhook(
        subscription,
        WebhookEventType.TOKEN_CREATED,
        tokenCreatedData
      );

      expect(deliveryLogs[0].success).toBe(true);
    });
  });

  describe("Timeout Scenarios", () => {
    it("should timeout and retry on slow response", async () => {
      const subscription = makeSubscription("/timeout");

      // Simulate slow response that exceeds timeout
      nock(BASE_URL)
        .post("/timeout")
        .times(1)
        .delayConnection(WEBHOOK_TIMEOUT_MS + 100)
        .reply(200, { success: true });

      nock(BASE_URL).post("/timeout").reply(200, { success: true });

      await service.deliverWebhook(
        subscription,
        WebhookEventType.TOKEN_CREATED,
        tokenCreatedData
      );

      // Should have retried after timeout
      expect(deliveryLogs[0].attempts).toBeGreaterThan(1);
    });

    it("should record timeout error message", async () => {
      const subscription = makeSubscription("/timeout-error");

      nock(BASE_URL)
        .post("/timeout-error")
        .times(MAX_RETRIES)
        .delayConnection(WEBHOOK_TIMEOUT_MS + 100)
        .reply(200, { success: true });

      await service.deliverWebhook(
        subscription,
        WebhookEventType.TOKEN_CREATED,
        tokenCreatedData
      );

      expect(deliveryLogs[0].errorMessage).toBeTruthy();
      expect(deliveryLogs[0].errorMessage).toMatch(/timeout|ECONNABORTED/i);
    });
  });

  describe("Connection Failures", () => {
    it("should retry on connection refused", async () => {
      const subscription = makeSubscription("/refused");

      // First attempt refused, second succeeds
      nock(BASE_URL)
        .post("/refused")
        .times(1)
        .replyWithError({ code: "ECONNREFUSED", message: "Connection refused" });

      nock(BASE_URL).post("/refused").reply(200, { success: true });

      await service.deliverWebhook(
        subscription,
        WebhookEventType.TOKEN_CREATED,
        tokenCreatedData
      );

      expect(deliveryLogs[0].success).toBe(true);
      expect(deliveryLogs[0].attempts).toBeGreaterThan(1);
    });

    it("should retry on connection reset", async () => {
      const subscription = makeSubscription("/reset");

      nock(BASE_URL)
        .post("/reset")
        .times(1)
        .replyWithError({ code: "ECONNRESET", message: "Connection reset by peer" });

      nock(BASE_URL).post("/reset").reply(200, { success: true });

      await service.deliverWebhook(
        subscription,
        WebhookEventType.TOKEN_CREATED,
        tokenCreatedData
      );

      expect(deliveryLogs[0].success).toBe(true);
    });

    it("should retry on socket hang up", async () => {
      const subscription = makeSubscription("/hangup");

      nock(BASE_URL)
        .post("/hangup")
        .times(1)
        .replyWithError({ code: "ECONNABORTED", message: "socket hang up" });

      nock(BASE_URL).post("/hangup").reply(200, { success: true });

      await service.deliverWebhook(
        subscription,
        WebhookEventType.TOKEN_CREATED,
        tokenCreatedData
      );

      expect(deliveryLogs[0].success).toBe(true);
    });
  });

  describe("Non-Retryable Failures (4xx)", () => {
    it("should not retry on 400 Bad Request", async () => {
      const subscription = makeSubscription("/bad-request");

      nock(BASE_URL)
        .post("/bad-request")
        .times(1)
        .reply(400, { error: "Bad Request" });

      await service.deliverWebhook(
        subscription,
        WebhookEventType.TOKEN_CREATED,
        tokenCreatedData
      );

      expect(deliveryLogs[0].success).toBe(false);
      expect(deliveryLogs[0].attempts).toBe(1);
      expect(deliveryLogs[0].statusCode).toBe(400);
    });

    it("should not retry on 401 Unauthorized", async () => {
      const subscription = makeSubscription("/unauthorized");

      nock(BASE_URL)
        .post("/unauthorized")
        .times(1)
        .reply(401, { error: "Unauthorized" });

      await service.deliverWebhook(
        subscription,
        WebhookEventType.TOKEN_CREATED,
        tokenCreatedData
      );

      expect(deliveryLogs[0].success).toBe(false);
      expect(deliveryLogs[0].attempts).toBe(1);
    });

    it("should not retry on 404 Not Found", async () => {
      const subscription = makeSubscription("/not-found");

      nock(BASE_URL)
        .post("/not-found")
        .times(1)
        .reply(404, { error: "Not Found" });

      await service.deliverWebhook(
        subscription,
        WebhookEventType.TOKEN_CREATED,
        tokenCreatedData
      );

      expect(deliveryLogs[0].success).toBe(false);
      expect(deliveryLogs[0].attempts).toBe(1);
    });

    it("should not retry on 422 Unprocessable Entity", async () => {
      const subscription = makeSubscription("/unprocessable");

      nock(BASE_URL)
        .post("/unprocessable")
        .times(1)
        .reply(422, { error: "Unprocessable Entity" });

      await service.deliverWebhook(
        subscription,
        WebhookEventType.TOKEN_CREATED,
        tokenCreatedData
      );

      expect(deliveryLogs[0].success).toBe(false);
      expect(deliveryLogs[0].attempts).toBe(1);
    });
  });

  describe("Persistent Failures", () => {
    it("should mark endpoint failed after retry exhaustion", async () => {
      const subscription = makeSubscription("/persistent-fail");

      // All attempts fail with 500
      nock(BASE_URL)
        .post("/persistent-fail")
        .times(MAX_RETRIES)
        .reply(500, { error: "Internal Server Error" });

      await service.deliverWebhook(
        subscription,
        WebhookEventType.TOKEN_CREATED,
        tokenCreatedData
      );

      expect(deliveryLogs[0].success).toBe(false);
      expect(deliveryLogs[0].attempts).toBe(MAX_RETRIES);
      expect(deliveryLogs[0].statusCode).toBe(500);
    });

    it("should record error message for persistent failures", async () => {
      const subscription = makeSubscription("/persistent-error");

      nock(BASE_URL)
        .post("/persistent-error")
        .times(MAX_RETRIES)
        .replyWithError({ message: "Network is unreachable" });

      await service.deliverWebhook(
        subscription,
        WebhookEventType.TOKEN_CREATED,
        tokenCreatedData
      );

      expect(deliveryLogs[0].success).toBe(false);
      expect(deliveryLogs[0].errorMessage).toContain("Network is unreachable");
    });

    it("should log exactly one delivery record per invocation", async () => {
      const subscription = makeSubscription("/single-log");

      nock(BASE_URL)
        .post("/single-log")
        .times(MAX_RETRIES)
        .reply(500, { error: "Server Error" });

      await service.deliverWebhook(
        subscription,
        WebhookEventType.TOKEN_CREATED,
        tokenCreatedData
      );

      expect(deliveryLogs).toHaveLength(1);
      expect(deliveryLogs[0].subscriptionId).toBe(subscription.id);
      expect(deliveryLogs[0].event).toBe(WebhookEventType.TOKEN_CREATED);
    });
  });

  describe("Delivery Metrics", () => {
    it("should record successful delivery with correct attempt count", async () => {
      const subscription = makeSubscription("/metrics-success");

      nock(BASE_URL)
        .post("/metrics-success")
        .times(2)
        .reply(500, { error: "Server Error" });

      nock(BASE_URL).post("/metrics-success").reply(200, { success: true });

      await service.deliverWebhook(
        subscription,
        WebhookEventType.TOKEN_CREATED,
        tokenCreatedData
      );

      expect(deliveryLogs[0].success).toBe(true);
      expect(deliveryLogs[0].attempts).toBe(3);
    });

    it("should record failed delivery with correct attempt count", async () => {
      const subscription = makeSubscription("/metrics-failure");

      nock(BASE_URL)
        .post("/metrics-failure")
        .times(MAX_RETRIES)
        .reply(500, { error: "Server Error" });

      await service.deliverWebhook(
        subscription,
        WebhookEventType.TOKEN_CREATED,
        tokenCreatedData
      );

      expect(deliveryLogs[0].success).toBe(false);
      expect(deliveryLogs[0].attempts).toBe(MAX_RETRIES);
    });

    it("should call updateLastTriggered only on success", async () => {
      const subscription = makeSubscription("/last-triggered");

      nock(BASE_URL).post("/last-triggered").reply(200, { success: true });

      await service.deliverWebhook(
        subscription,
        WebhookEventType.TOKEN_CREATED,
        tokenCreatedData
      );

      expect(webhookService.updateLastTriggered).toHaveBeenCalledWith(subscription.id);
    });

    it("should not call updateLastTriggered on failure", async () => {
      const subscription = makeSubscription("/no-last-triggered");

      nock(BASE_URL)
        .post("/no-last-triggered")
        .times(MAX_RETRIES)
        .reply(500, { error: "Server Error" });

      await service.deliverWebhook(
        subscription,
        WebhookEventType.TOKEN_CREATED,
        tokenCreatedData
      );

      expect(webhookService.updateLastTriggered).not.toHaveBeenCalled();
    });
  });

  describe("Mixed Failure Scenarios", () => {
    it("should handle mixed 5xx and timeout failures", async () => {
      const subscription = makeSubscription("/mixed-failures");

      nock(BASE_URL)
        .post("/mixed-failures")
        .times(1)
        .reply(503, { error: "Service Unavailable" });

      nock(BASE_URL)
        .post("/mixed-failures")
        .times(1)
        .delayConnection(WEBHOOK_TIMEOUT_MS + 100)
        .reply(200, { success: true });

      nock(BASE_URL).post("/mixed-failures").reply(200, { success: true });

      await service.deliverWebhook(
        subscription,
        WebhookEventType.TOKEN_CREATED,
        tokenCreatedData
      );

      expect(deliveryLogs[0].success).toBe(true);
      expect(deliveryLogs[0].attempts).toBeGreaterThan(1);
    });

    it("should handle connection error followed by success", async () => {
      const subscription = makeSubscription("/conn-then-success");

      nock(BASE_URL)
        .post("/conn-then-success")
        .times(1)
        .replyWithError({ code: "ECONNREFUSED" });

      nock(BASE_URL).post("/conn-then-success").reply(200, { success: true });

      await service.deliverWebhook(
        subscription,
        WebhookEventType.TOKEN_CREATED,
        tokenCreatedData
      );

      expect(deliveryLogs[0].success).toBe(true);
    });
  });
});
