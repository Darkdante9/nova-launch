import { describe, it, expect, beforeEach, vi } from "vitest";
import { WebhookService } from "../services/webhookService";
import { WebhookEventType } from "../types/webhook";

// Mock database
vi.mock("../database/db", () => ({
  default: {
    query: vi.fn(),
  },
}));

describe("WebhookService", () => {
  let service: WebhookService;

  beforeEach(() => {
    service = new WebhookService();
    vi.clearAllMocks();
  });

  describe("createSubscription", () => {
    it("should create a webhook subscription with generated secret", async () => {
      const input = {
        url: "https://example.com/webhook",
        events: [WebhookEventType.TOKEN_CREATED],
        createdBy: "GABC123...",
      };

      const mockResult = {
        rows: [
          {
            id: "test-id",
            url: input.url,
            token_address: null,
            events: input.events,
            secret: "generated-secret",
            active: true,
            created_by: input.createdBy,
            created_at: new Date(),
            last_triggered: null,
          },
        ],
      };

      const db = await import("../database/db");
      vi.mocked(db.default.query).mockResolvedValue(mockResult as any);

      const result = await service.createSubscription(input);

      expect(result).toBeDefined();
      expect(result.url).toBe(input.url);
      expect(result.events).toEqual(input.events);
      expect(result.secret).toBeDefined();
    });
  });

  describe("createPayload", () => {
    it("should create payload with valid signature", () => {
      const event = WebhookEventType.TOKEN_CREATED;
      const data = {
        tokenAddress: "GTEST...",
        creator: "GCREATOR...",
        name: "Test Token",
        symbol: "TEST",
        decimals: 7,
        initialSupply: "1000000",
        transactionHash: "hash123",
        ledger: 12345,
      };
      const secret = "test-secret";

      const payload = service.createPayload(event, data, secret);

      expect(payload.event).toBe(event);
      expect(payload.data).toEqual(data);
      expect(payload.signature).toBeDefined();
      expect(payload.timestamp).toBeDefined();
    });
  });

  describe("getDeliveryLogById", () => {
    it("should return a mapped delivery log when found", async () => {
      const mockRow = {
        id: "log-1",
        subscription_id: "sub-1",
        event: WebhookEventType.TOKEN_CREATED,
        payload: { event: WebhookEventType.TOKEN_CREATED, timestamp: "t", data: {}, signature: "v1.1.abc" },
        status_code: 200,
        success: true,
        attempts: 1,
        last_attempt_at: new Date(),
        error_message: null,
        created_at: new Date(),
      };

      const db = await import("../database/db");
      vi.mocked(db.default.query).mockResolvedValue({ rows: [mockRow] } as any);

      const result = await service.getDeliveryLogById("log-1");

      expect(result).not.toBeNull();
      expect(result?.id).toBe("log-1");
      expect(result?.subscriptionId).toBe("sub-1");
      expect(result?.payload.signature).toBe("v1.1.abc");
    });

    it("should return null when no delivery log matches", async () => {
      const db = await import("../database/db");
      vi.mocked(db.default.query).mockResolvedValue({ rows: [] } as any);

      const result = await service.getDeliveryLogById("missing");

      expect(result).toBeNull();
    });
  });

  describe("findMatchingSubscriptions", () => {
    it("should find subscriptions matching event and token", async () => {
      const event = WebhookEventType.TOKEN_BURN_SELF;
      const tokenAddress = "GTOKEN...";

      const mockResult = {
        rows: [
          {
            id: "sub-1",
            url: "https://example.com/webhook",
            token_address: tokenAddress,
            events: [event],
            secret: "secret",
            active: true,
            created_by: "GUSER...",
            created_at: new Date(),
            last_triggered: null,
          },
        ],
      };

      const db = await import("../database/db");
      vi.mocked(db.default.query).mockResolvedValue(mockResult as any);

      const result = await service.findMatchingSubscriptions(
        event,
        tokenAddress
      );

      expect(result).toHaveLength(1);
      expect(result[0].tokenAddress).toBe(tokenAddress);
    });
  });
});
