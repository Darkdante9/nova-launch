/**
 * Tests for Event Schema Validator (#1406)
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  validateEventPayload,
  resetEventSchemaCache,
  EventSchemaValidationError,
} from "./eventSchemaValidator";

describe("eventSchemaValidator — validateEventPayload", () => {
  beforeEach(() => {
    resetEventSchemaCache();
  });

  it("does not throw for an event type with no registered schema", () => {
    expect(() =>
      validateEventPayload("some.unschematized.event", { anything: true })
    ).not.toThrow();
  });

  it("passes a valid burn.executed payload", () => {
    expect(() =>
      validateEventPayload("burn.executed", {
        creatorAddress: "GCREATOR",
        tokenAddress: "CTOKEN1",
        amount: "500",
        burnedBy: "GBURNER",
        isAdminBurn: false,
        txHash: "hashB",
        timestamp: "2026-06-23T00:00:00.000Z",
      })
    ).not.toThrow();
  });

  it("passes a burn.executed payload whose amount is a raw bigint", () => {
    expect(() =>
      validateEventPayload("burn.executed", {
        creatorAddress: "GCREATOR",
        tokenAddress: "CTOKEN1",
        amount: BigInt("500"),
        burnedBy: "GBURNER",
        isAdminBurn: false,
        txHash: "hashB",
        timestamp: "2026-06-23T00:00:00.000Z",
      })
    ).not.toThrow();
  });

  it("rejects a burn.executed payload missing a required field", () => {
    expect(() =>
      validateEventPayload("burn.executed", {
        creatorAddress: "GCREATOR",
        tokenAddress: "CTOKEN1",
        // amount missing
        burnedBy: "GBURNER",
        isAdminBurn: false,
        txHash: "hashB",
        timestamp: "2026-06-23T00:00:00.000Z",
      })
    ).toThrow(EventSchemaValidationError);
  });

  it("rejects a burn.executed payload with the wrong type for a field", () => {
    expect(() =>
      validateEventPayload("burn.executed", {
        creatorAddress: "GCREATOR",
        tokenAddress: "CTOKEN1",
        amount: "500",
        burnedBy: "GBURNER",
        isAdminBurn: "no", // should be boolean
        txHash: "hashB",
        timestamp: "2026-06-23T00:00:00.000Z",
      })
    ).toThrow(/failed schema validation/);
  });

  it("rejects a burn.executed payload with unexpected extra fields", () => {
    expect(() =>
      validateEventPayload("burn.executed", {
        creatorAddress: "GCREATOR",
        tokenAddress: "CTOKEN1",
        amount: "500",
        burnedBy: "GBURNER",
        isAdminBurn: false,
        txHash: "hashB",
        timestamp: "2026-06-23T00:00:00.000Z",
        unexpectedField: "nope",
      })
    ).toThrow(EventSchemaValidationError);
  });

  it("accepts either anyOf branch for token.deployed", () => {
    // Branch 1 (batchTokenDeployService shape)
    expect(() =>
      validateEventPayload("token.deployed", {
        tokenId: "tok_1",
        address: "CADDR",
        creator: "GCREATOR",
        name: "Test Token",
        symbol: "TST",
        decimals: 7,
        initialSupply: "1000000",
        metadataUri: null,
      })
    ).not.toThrow();

    // Branch 2 (GraphQL subscription shape)
    expect(() =>
      validateEventPayload("token.deployed", {
        tokenAddress: "CADDR",
        creatorAddress: "GCREATOR",
        name: "Test Token",
        symbol: "TST",
        totalSupply: BigInt("1000000"),
        txHash: "hashT",
        timestamp: "2026-06-23T00:00:00.000Z",
      })
    ).not.toThrow();
  });

  it("rejects a token.deployed payload matching neither anyOf branch", () => {
    expect(() =>
      validateEventPayload("token.deployed", {
        somethingElse: true,
      })
    ).toThrow(EventSchemaValidationError);
  });

  it("error message includes the event type", () => {
    try {
      validateEventPayload("vault.matured", {});
      throw new Error("expected validateEventPayload to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EventSchemaValidationError);
      expect((err as EventSchemaValidationError).eventType).toBe("vault.matured");
      expect((err as Error).message).toContain("vault.matured");
    }
  });
});
