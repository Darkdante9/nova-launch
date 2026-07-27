/**
 * GET /api/webhooks/deliveries/:id/verification — Integration Tests
 *
 * Tests HTTP layer: validation, status codes, and response shape for the
 * delivery signature verification endpoint. The webhook service is mocked
 * so these tests focus purely on the route handler and the real
 * verifyStoredWebhookSignature implementation.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import webhookRoutes from "../routes/webhooks";
import { generateWebhookSignature } from "../utils/crypto";

vi.mock("../services/webhookService", () => ({
  default: {
    getDeliveryLogById: vi.fn(),
    getSubscription: vi.fn(),
  },
}));

import webhookService from "../services/webhookService";

const app = express();
app.use(express.json());
app.use("/api/webhooks", webhookRoutes);

const SUBSCRIPTION_ID = "6d799280-fafc-4ecd-b056-6d6a3755d381";
const DELIVERY_ID = "91bbe401-fd72-443d-b926-1b543fc20f2c";
const SECRET = "test-webhook-secret";

function buildLog(secret: string) {
  const unsignedPayload = {
    event: "token.created",
    timestamp: "2026-01-01T00:00:00.000Z",
    data: { tokenAddress: "GTEST..." },
  };
  const signature = generateWebhookSignature(JSON.stringify(unsignedPayload), secret);

  return {
    id: DELIVERY_ID,
    subscriptionId: SUBSCRIPTION_ID,
    event: "token.created",
    payload: { ...unsignedPayload, signature },
    statusCode: 200,
    success: true,
    attempts: 1,
    lastAttemptAt: new Date(),
    errorMessage: null,
    createdAt: new Date(),
  };
}

describe("GET /api/webhooks/deliveries/:id/verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns verified: true when the signature matches the current secret", async () => {
    vi.mocked(webhookService.getDeliveryLogById).mockResolvedValue(buildLog(SECRET) as any);
    vi.mocked(webhookService.getSubscription).mockResolvedValue({
      id: SUBSCRIPTION_ID,
      secret: SECRET,
    } as any);

    const res = await request(app).get(`/api/webhooks/deliveries/${DELIVERY_ID}/verification`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.verified).toBe(true);
    expect(res.body.data.algorithm).toBe("HMAC-SHA256");
    expect(res.body.data.keyId).toBe(SECRET.slice(-8));
  });

  it("returns verified: false when the secret has since rotated", async () => {
    vi.mocked(webhookService.getDeliveryLogById).mockResolvedValue(buildLog(SECRET) as any);
    vi.mocked(webhookService.getSubscription).mockResolvedValue({
      id: SUBSCRIPTION_ID,
      secret: "a-different-rotated-secret",
    } as any);

    const res = await request(app).get(`/api/webhooks/deliveries/${DELIVERY_ID}/verification`);

    expect(res.status).toBe(200);
    expect(res.body.data.verified).toBe(false);
    expect(res.body.data.keyId).toBe("a-different-rotated-secret".slice(-8));
  });

  it("never returns the full secret in the response body", async () => {
    vi.mocked(webhookService.getDeliveryLogById).mockResolvedValue(buildLog(SECRET) as any);
    vi.mocked(webhookService.getSubscription).mockResolvedValue({
      id: SUBSCRIPTION_ID,
      secret: SECRET,
    } as any);

    const res = await request(app).get(`/api/webhooks/deliveries/${DELIVERY_ID}/verification`);

    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });

  it("returns 404 when the delivery log does not exist", async () => {
    vi.mocked(webhookService.getDeliveryLogById).mockResolvedValue(null);

    const res = await request(app).get(`/api/webhooks/deliveries/${DELIVERY_ID}/verification`);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it("returns 404 when the associated subscription no longer exists", async () => {
    vi.mocked(webhookService.getDeliveryLogById).mockResolvedValue(buildLog(SECRET) as any);
    vi.mocked(webhookService.getSubscription).mockResolvedValue(null);

    const res = await request(app).get(`/api/webhooks/deliveries/${DELIVERY_ID}/verification`);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it("returns 400 for a malformed delivery ID", async () => {
    const res = await request(app).get("/api/webhooks/deliveries/not-a-uuid/verification");

    expect(res.status).toBe(400);
  });
});
