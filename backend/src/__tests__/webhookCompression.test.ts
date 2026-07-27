/**
 * Tests for gzip compression on webhook payload delivery.
 *
 * Verifies that payloads above the threshold are compressed, the correct
 * Content-Encoding header is set, and that delivery falls back to
 * uncompressed when the consumer responds with 415.
 */

// Set BEFORE importing webhookDeliveryService so the per-tenant rate
// limiter singleton (created at module load) picks up a large bucket. This
// file's fixtures share one createdBy/"tenant" across all `it()` blocks
// with no module reset, and is about compression behavior, not rate
// limiting — raise the bucket so deliveries here are never queued.
process.env.WEBHOOK_RATE_LIMIT_PER_MINUTE = "100000";
process.env.WEBHOOK_RATE_LIMIT_BURST = "10000";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import nock from "nock";
import { v4 as uuidv4 } from "uuid";
import {
  WebhookEventType,
  WebhookSubscription,
  TokenCreatedEventData,
} from "../types/webhook";
import { WebhookDeliveryService } from "../services/webhookDeliveryService";
import webhookService from "../services/webhookService";

const BASE_URL = "http://webhook-compression-test.local";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeSubscription(path = "/hook"): WebhookSubscription {
  return {
    id: `sub-${uuidv4()}`,
    url: `${BASE_URL}${path}`,
    events: [WebhookEventType.TOKEN_CREATED],
    secret: "compression-test-secret-32bytes!",
    active: true,
    createdBy: "GCREATOR_COMPRESSION_TEST",
    createdAt: new Date(),
    lastTriggered: null,
    tokenAddress: null,
  };
}

function makeTokenCreatedData(
  overrides: Partial<TokenCreatedEventData> = {}
): TokenCreatedEventData {
  return {
    tokenAddress: "GTOKEN_COMPRESSION_TEST",
    creator: "GCREATOR_COMPRESSION_TEST",
    name: "Compression Test Token",
    symbol: "COMP",
    decimals: 7,
    initialSupply: "1000000",
    transactionHash: "compression-test-tx-hash",
    ledger: 12345,
    ...overrides,
  };
}

/**
 * Creates a WebhookDeliveryService instance with the given compression
 * threshold. The env var must be set BEFORE constructing the service so the
 * constructor reads the correct value.
 */
function makeService(thresholdBytes: number): WebhookDeliveryService {
  process.env.WEBHOOK_COMPRESSION_THRESHOLD_BYTES = String(thresholdBytes);
  return new WebhookDeliveryService();
}

// ── Setup / Teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  nock.cleanAll();
  process.env.WEBHOOK_TIMEOUT_MS = "500";
  process.env.WEBHOOK_MAX_RETRIES = "3";
  process.env.WEBHOOK_RETRY_DELAY_MS = "10";
  process.env.WEBHOOK_CIRCUIT_BREAKER_FAILURE_THRESHOLD = "10";
  process.env.WEBHOOK_CIRCUIT_BREAKER_SUCCESS_THRESHOLD = "1";
  process.env.WEBHOOK_CIRCUIT_BREAKER_TIMEOUT_MS = "100";

  vi.spyOn(webhookService, "findMatchingSubscriptions").mockResolvedValue([]);
  vi.spyOn(webhookService, "createPayload").mockImplementation(
    (event, data, _secret) =>
      ({
        event,
        data,
        timestamp: new Date().toISOString(),
        signature: "mock-sig",
      } as any)
  );
  vi.spyOn(webhookService, "updateLastTriggered").mockResolvedValue(
    undefined as any
  );
  vi.spyOn(webhookService, "logDelivery").mockResolvedValue(undefined as any);
});

afterEach(() => {
  nock.cleanAll();
  vi.restoreAllMocks();
  delete process.env.WEBHOOK_COMPRESSION_THRESHOLD_BYTES;
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("webhook payload compression", () => {
  describe("small payload — no compression", () => {
    it("sends an uncompressed payload when below the threshold", async () => {
      const service = makeService(999_999); // threshold so high nothing compresses
      const subscription = makeSubscription("/small");
      let capturedHeaders: Record<string, string> = {};

      nock(BASE_URL)
        .post("/small")
        .reply(function () {
          capturedHeaders = this.req.headers as Record<string, string>;
          return [200, "ok"];
        });

      await service.deliverWebhook(
        subscription,
        WebhookEventType.TOKEN_CREATED,
        makeTokenCreatedData()
      );

      expect(capturedHeaders["content-encoding"]).toBeUndefined();
      expect(capturedHeaders["content-type"]).toContain("application/json");
    });
  });

  describe("large payload — compressed delivery", () => {
    it("sends Content-Encoding: gzip when payload exceeds the threshold", async () => {
      const service = makeService(1); // threshold of 1 byte — always compresses
      const subscription = makeSubscription("/large");
      let capturedHeaders: Record<string, string> = {};

      nock(BASE_URL)
        .post("/large")
        .reply(function () {
          capturedHeaders = this.req.headers as Record<string, string>;
          return [200, "ok"];
        });

      await service.deliverWebhook(
        subscription,
        WebhookEventType.TOKEN_CREATED,
        makeTokenCreatedData()
      );

      expect(capturedHeaders["content-encoding"]).toBe("gzip");
    });

    it("completes delivery successfully when compression is active", async () => {
      const service = makeService(1);
      const subscription = makeSubscription("/gzip-ok");

      nock(BASE_URL).post("/gzip-ok").reply(200, "ok");

      await expect(
        service.deliverWebhook(
          subscription,
          WebhookEventType.TOKEN_CREATED,
          makeTokenCreatedData()
        )
      ).resolves.not.toThrow();
    });
  });

  describe("415 Unsupported Media Type — fallback to uncompressed", () => {
    it("retries without compression after receiving a 415 response", async () => {
      const service = makeService(1);
      const subscription = makeSubscription("/fallback");
      const receivedEncodings: (string | undefined)[] = [];

      // First attempt: consumer rejects the gzip encoding
      nock(BASE_URL)
        .post("/fallback")
        .reply(function () {
          receivedEncodings.push(
            this.req.headers["content-encoding"] as string
          );
          return [415, "Unsupported Media Type"];
        });

      // Second attempt: consumer accepts the uncompressed body
      nock(BASE_URL)
        .post("/fallback")
        .reply(function () {
          receivedEncodings.push(
            this.req.headers["content-encoding"] as string
          );
          return [200, "ok"];
        });

      await service.deliverWebhook(
        subscription,
        WebhookEventType.TOKEN_CREATED,
        makeTokenCreatedData()
      );

      expect(receivedEncodings[0]).toBe("gzip");
      expect(receivedEncodings[1]).toBeUndefined();
    });
  });
});
