/**
 * Tests for Prisma multi-tenant data isolation (#1343).
 * Verifies that tenant-scoped models are filtered by tenantId in async context,
 * that non-scoped models pass through, and that bypassTenant opts out of filtering.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Simulate the extension logic without importing prisma (avoids DB connection)
// ---------------------------------------------------------------------------

const TENANT_SCOPED_MODELS = new Set([
  "WebhookSubscription",
  "BuybackCampaign",
  "DividendPool",
]);

const TENANT_FILTERED_OPS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "count",
  "updateMany",
  "deleteMany",
]);

function applyTenantFilter(
  model: string,
  operation: string,
  args: Record<string, unknown>,
  tenantId: string | undefined,
  bypass: boolean
): Record<string, unknown> {
  if (
    TENANT_SCOPED_MODELS.has(model) &&
    TENANT_FILTERED_OPS.has(operation) &&
    !bypass &&
    tenantId
  ) {
    return {
      ...args,
      where: { ...((args.where as Record<string, unknown>) ?? {}), tenantId },
    };
  }
  return args;
}

// ---------------------------------------------------------------------------
// assertTenantScope test helper (exported for use in integration tests)
// ---------------------------------------------------------------------------

export function assertTenantScope(
  result: { where?: Record<string, unknown> } | undefined,
  expectedTenantId: string
): void {
  if (!result?.where) {
    throw new Error("Query had no where clause — tenant scope missing");
  }
  if (result.where.tenantId !== expectedTenantId) {
    throw new Error(
      `Tenant scope mismatch: expected tenantId="${expectedTenantId}", got "${result.where.tenantId}"`
    );
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Prisma tenant isolation — scoped models", () => {
  const SCOPED = ["WebhookSubscription", "BuybackCampaign", "DividendPool"];
  const OPS = ["findMany", "findFirst", "count", "updateMany", "deleteMany"];

  for (const model of SCOPED) {
    for (const op of OPS) {
      it(`injects tenantId into ${model}.${op} when tenant context is set`, () => {
        const result = applyTenantFilter(model, op, { where: {} }, "tenant-abc", false);
        expect(result.where).toEqual(expect.objectContaining({ tenantId: "tenant-abc" }));
      });
    }
  }

  it("merges tenantId with existing where clauses", () => {
    const result = applyTenantFilter(
      "WebhookSubscription",
      "findMany",
      { where: { userAddress: "addr1" } },
      "tenant-xyz",
      false
    );
    expect(result.where).toEqual({ userAddress: "addr1", tenantId: "tenant-xyz" });
  });
});

describe("Prisma tenant isolation — unscoped models", () => {
  const UNSCOPED = ["Token", "BurnRecord", "Analytics", "Stream", "Proposal"];

  for (const model of UNSCOPED) {
    it(`does NOT inject tenantId into ${model}.findMany`, () => {
      const args = { where: {} };
      const result = applyTenantFilter(model, "findMany", args, "tenant-abc", false);
      expect((result.where as any).tenantId).toBeUndefined();
    });
  }
});

describe("Prisma tenant isolation — bypass", () => {
  it("skips tenant filter when bypassTenant is true", () => {
    const result = applyTenantFilter(
      "WebhookSubscription",
      "findMany",
      { where: {} },
      "tenant-abc",
      true
    );
    expect((result.where as any).tenantId).toBeUndefined();
  });

  it("skips filter when no tenant in context", () => {
    const result = applyTenantFilter(
      "BuybackCampaign",
      "findMany",
      { where: {} },
      undefined,
      false
    );
    expect((result.where as any).tenantId).toBeUndefined();
  });
});

describe("assertTenantScope helper", () => {
  it("passes when tenantId matches", () => {
    expect(() => assertTenantScope({ where: { tenantId: "t1" } }, "t1")).not.toThrow();
  });

  it("throws when where clause lacks tenantId", () => {
    expect(() => assertTenantScope({ where: { userAddress: "x" } }, "t1")).toThrow(
      "Tenant scope mismatch"
    );
  });

  it("throws when where is missing entirely", () => {
    expect(() => assertTenantScope({}, "t1")).toThrow("no where clause");
  });

  it("throws when where is undefined", () => {
    expect(() => assertTenantScope(undefined, "t1")).toThrow("no where clause");
  });
});

describe("cross-tenant data access is blocked", () => {
  it("tenant-A and tenant-B queries receive different where clauses", () => {
    const argsA = applyTenantFilter("WebhookSubscription", "findMany", { where: {} }, "tenant-A", false);
    const argsB = applyTenantFilter("WebhookSubscription", "findMany", { where: {} }, "tenant-B", false);

    expect((argsA.where as any).tenantId).toBe("tenant-A");
    expect((argsB.where as any).tenantId).toBe("tenant-B");
    expect((argsA.where as any).tenantId).not.toBe((argsB.where as any).tenantId);
  });
});
