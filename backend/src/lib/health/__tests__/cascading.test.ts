/**
 * Tests — cascading failure detection (#1373)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { HealthService } from "../health.service";
import { ServiceHealth, DEFAULT_DEPENDENCY_GRAPH } from "../health.types";

vi.mock("../../prisma", () => ({
  prisma: { $queryRaw: vi.fn().mockResolvedValue([{ count: 1n }]) },
}));
vi.mock("../circuitBreaker", () => ({
  getCircuitBreakerRegistrySnapshot: () => ({}),
}));

const mockDispatchAlert = vi.fn().mockResolvedValue({ status: "ok" });
// Path must match what health.service.ts imports (resolved from src/lib/health/)
vi.mock(
  new URL("../../../../../monitoring/pagerduty/incident-response.ts", import.meta.url).pathname,
  () => ({ dispatchAlert: (...args: unknown[]) => mockDispatchAlert(...args) })
);

global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);

function up(): ServiceHealth { return { status: "up" }; }
function down(err = "connection refused"): ServiceHealth { return { status: "down", error: err }; }

function freshService(): HealthService {
  (HealthService as any).instance = undefined;
  return HealthService.getInstance();
}

beforeEach(() => {
  mockDispatchAlert.mockClear();
  vi.mocked(global.fetch).mockResolvedValue({ ok: true, status: 200 } as Response);
});

// ---------------------------------------------------------------------------
// Pure unit tests on applyCascadingFailures
// ---------------------------------------------------------------------------

describe("applyCascadingFailures", () => {
  it("returns no root causes when all services healthy", () => {
    const svc = freshService();
    const services = {
      database: up(), cache: up(),
      stellarHorizon: up(), stellarSoroban: up(), ipfs: up(),
    };
    const roots = svc.applyCascadingFailures(services, DEFAULT_DEPENDENCY_GRAPH);
    expect(roots).toHaveLength(0);
    for (const s of Object.values(services)) expect(s.cascaded).toBeFalsy();
  });

  it("cache failure marks stellarHorizon, stellarSoroban, ipfs as cascaded", () => {
    const svc = freshService();
    const services = {
      database: up(), cache: down(),
      stellarHorizon: up(), stellarSoroban: up(), ipfs: up(),
    };
    const roots = svc.applyCascadingFailures(services, DEFAULT_DEPENDENCY_GRAPH);

    expect(roots).toEqual(["cache"]);
    expect(services.cache.cascaded).toBeFalsy();
    expect(services.stellarHorizon.cascaded).toBe(true);
    expect(services.stellarHorizon.rootCause).toBe("cache");
    expect(services.stellarSoroban.cascaded).toBe(true);
    expect(services.ipfs.cascaded).toBe(true);
  });

  it("database failure marks ipfs as cascaded, not stellarHorizon", () => {
    const svc = freshService();
    const services = {
      database: down(), cache: up(),
      stellarHorizon: up(), stellarSoroban: up(), ipfs: up(),
    };
    const roots = svc.applyCascadingFailures(services, DEFAULT_DEPENDENCY_GRAPH);

    expect(roots).toContain("database");
    expect(services.ipfs.cascaded).toBe(true);
    expect(services.ipfs.rootCause).toBe("database");
    expect(services.stellarHorizon.cascaded).toBeFalsy();
  });

  it("independently failing service with no upstream is its own root cause", () => {
    const svc = freshService();
    const services = {
      database: up(), cache: up(),
      stellarHorizon: down(), stellarSoroban: up(), ipfs: up(),
    };
    const roots = svc.applyCascadingFailures(services, DEFAULT_DEPENDENCY_GRAPH);
    expect(roots).toContain("stellarHorizon");
    expect(services.stellarHorizon.cascaded).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// Integration — PagerDuty fires exactly 1 alert per root cause
// ---------------------------------------------------------------------------

describe("checkDetailedHealth — PagerDuty alerting", () => {
  it("fires no alerts when all services healthy", async () => {
    const svc = freshService();
    await svc.checkDetailedHealth();
    expect(mockDispatchAlert).not.toHaveBeenCalled();
  });

  it("fires exactly 1 alert for cache failure, not 3 for cascaded dependents", async () => {
    const svc = freshService();
    vi.spyOn(svc as any, "checkCache")
      .mockResolvedValue({ status: "down", error: "Redis unavailable" });

    const result = await svc.checkDetailedHealth();

    expect(result.rootCauses).toEqual(["cache"]);
    expect(mockDispatchAlert).toHaveBeenCalledTimes(1);
    expect(mockDispatchAlert.mock.calls[0][0]).toContain("cache");
  });
});
