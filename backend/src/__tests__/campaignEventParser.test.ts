import {
  CampaignEventParser,
  CampaignEvent,
  CampaignExecutionEvent,
  CampaignStatusEvent,
  CampaignParseError,
} from "../services/campaignEventParser";

describe("CampaignEventParser", () => {
  const now = new Date();

  const validCampaignCreated: CampaignEvent = {
    campaignId: 1,
    tokenId: "token-abc",
    creator: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGPCQHQ9PRURP4DGJDRNL",
    type: "BUYBACK",
    targetAmount: BigInt(1000000),
    startTime: now,
    endTime: new Date(now.getTime() + 86400000),
    metadata: "ipfs://QmHash",
    txHash: "abc123def456abc123def456abc123def456abc123def456abc123def456",
  };

  const validCampaignExecution: CampaignExecutionEvent = {
    campaignId: 1,
    executor: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGPCQHQ9PRURP4DGJDRNL",
    amount: BigInt(50000),
    recipient: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGPCQHQ9PRURP4DGJDRNL",
    txHash: "abc123def456abc123def456abc123def456abc123def456abc123def456",
    executedAt: now,
  };

  const validCampaignStatusChange: CampaignStatusEvent = {
    campaignId: 1,
    status: "PAUSED",
    txHash: "abc123def456abc123def456abc123def456abc123def456abc123def456",
  };

  describe("safeParseCampaignCreated", () => {
    it("returns typed parse errors for missing required fields", () => {
      const cases = [
        { payload: {}, missing: "campaignId" },
        { payload: { campaignId: 1 }, missing: "tokenId" },
        { payload: { campaignId: 1, tokenId: "tok" }, missing: "creator" },
        { payload: { campaignId: 1, tokenId: "tok", creator: "addr" }, missing: "type" },
        { payload: { campaignId: 1, tokenId: "tok", creator: "addr", type: "BUYBACK" }, missing: "targetAmount" },
        { payload: { campaignId: 1, tokenId: "tok", creator: "addr", type: "BUYBACK", targetAmount: BigInt(1) }, missing: "startTime" },
        { payload: { campaignId: 1, tokenId: "tok", creator: "addr", type: "BUYBACK", targetAmount: BigInt(1), startTime: now }, missing: "txHash" },
      ];

      for (const { payload, missing } of cases) {
        const result = CampaignEventParser.safeParseCampaignCreated(payload);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.errors.some((e: CampaignParseError) => e.field === missing)).toBe(true);
        }
      }
    });

    it("returns typed parse errors for wrong field types", () => {
      const cases = [
        { field: "campaignId", value: "1" },
        { field: "tokenId", value: 123 },
        { field: "creator", value: 123 },
        { field: "type", value: "UNKNOWN" },
        { field: "targetAmount", value: "not-a-number" },
        { field: "startTime", value: "2025-01-01T00:00:00Z" },
        { field: "endTime", value: "not-a-date" },
        { field: "txHash", value: 42 },
      ];

      for (const { field, value } of cases) {
        const payload = { ...validCampaignCreated, [field]: value };
        const result = CampaignEventParser.safeParseCampaignCreated(payload);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.errors.some((e: CampaignParseError) => e.field === field)).toBe(true);
        }
      }
    });

    it("returns typed parse errors for unknown event variants when routed through safeParseCampaignEvent", () => {
      const result = CampaignEventParser.safeParseCampaignEvent({
        kind: "unknown_event",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((e: CampaignParseError) => e.field === "kind" && e.message.includes("unknown_event"))).toBe(true);
      }
    });

    it("returns typed parse errors for oversized string fields", () => {
      const oversized = "a".repeat(1025);
      const result = CampaignEventParser.safeParseCampaignCreated({
        ...validCampaignCreated,
        metadata: oversized,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((e: CampaignParseError) => e.field === "metadata")).toBe(true);
      }
    });

    it("parses a valid baseline payload correctly", () => {
      const result = CampaignEventParser.safeParseCampaignCreated(validCampaignCreated);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(validCampaignCreated);
      }
    });
  });

  describe("safeParseCampaignExecution", () => {
    it("returns typed parse errors for missing required fields", () => {
      const cases = [
        { payload: {}, missing: "campaignId" },
        { payload: { campaignId: 1 }, missing: "executor" },
        { payload: { campaignId: 1, executor: "addr" }, missing: "amount" },
        { payload: { campaignId: 1, executor: "addr", amount: BigInt(1) }, missing: "txHash" },
        { payload: { campaignId: 1, executor: "addr", amount: BigInt(1), txHash: "tx1" }, missing: "executedAt" },
      ];

      for (const { payload, missing } of cases) {
        const result = CampaignEventParser.safeParseCampaignExecution(payload);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.errors.some((e: CampaignParseError) => e.field === missing)).toBe(true);
        }
      }
    });

    it("returns typed parse errors for wrong field types", () => {
      const cases = [
        { field: "campaignId", value: "1" },
        { field: "executor", value: 42 },
        { field: "amount", value: "not-a-number" },
        { field: "recipient", value: false },
        { field: "txHash", value: {} },
        { field: "executedAt", value: 0 },
      ];

      for (const { field, value } of cases) {
        const payload = { ...validCampaignExecution, [field]: value };
        const result = CampaignEventParser.safeParseCampaignExecution(payload);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.errors.some((e: CampaignParseError) => e.field === field)).toBe(true);
        }
      }
    });

    it("parses a valid payload correctly", () => {
      const result = CampaignEventParser.safeParseCampaignExecution(validCampaignExecution);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(validCampaignExecution);
      }
    });
  });

  describe("safeParseCampaignStatusChange", () => {
    it("returns typed parse errors for missing required fields", () => {
      const cases = [
        { payload: {}, missing: "campaignId" },
        { payload: { campaignId: 1 }, missing: "status" },
        { payload: { campaignId: 1, status: "PAUSED" }, missing: "txHash" },
      ];

      for (const { payload, missing } of cases) {
        const result = CampaignEventParser.safeParseCampaignStatusChange(payload);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.errors.some((e: CampaignParseError) => e.field === missing)).toBe(true);
        }
      }
    });

    it("returns typed parse errors for wrong status values", () => {
      const result = CampaignEventParser.safeParseCampaignStatusChange({
        ...validCampaignStatusChange,
        status: "UNKNOWN",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((e: CampaignParseError) => e.field === "status")).toBe(true);
      }
    });

    it("parses a valid payload correctly", () => {
      const result = CampaignEventParser.safeParseCampaignStatusChange(validCampaignStatusChange);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(validCampaignStatusChange);
      }
    });
  });

  describe("safeParseCampaignEvent", () => {
    it("routes to the correct sub-parser by kind", () => {
      const createdResult = CampaignEventParser.safeParseCampaignEvent({
        kind: "campaign_created",
        ...validCampaignCreated,
      });
      expect(createdResult.success).toBe(true);

      const executedResult = CampaignEventParser.safeParseCampaignEvent({
        kind: "campaign_executed",
        ...validCampaignExecution,
      });
      expect(executedResult.success).toBe(true);

      const statusResult = CampaignEventParser.safeParseCampaignEvent({
        kind: "campaign_status_changed",
        ...validCampaignStatusChange,
      });
      expect(statusResult.success).toBe(true);
    });

    it("returns a typed parse error for unknown event variants", () => {
      const result = CampaignEventParser.safeParseCampaignEvent({
        kind: "unknown_variant",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((e: CampaignParseError) => e.field === "kind")).toBe(true);
        expect(result.errors.some((e: CampaignParseError) => e.message.includes("unknown_variant"))).toBe(true);
      }
    });

    it("does not throw on malformed payloads", () => {
      const malformed = { truncated: true };
      expect(() => CampaignEventParser.safeParseCampaignEvent(malformed)).not.toThrow();
    });
  });
});
