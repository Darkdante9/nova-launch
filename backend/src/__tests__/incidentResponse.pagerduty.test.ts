/**
 * Tests for PagerDuty incident response automation (#904)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import https from "https";
import { EventEmitter } from "events";
import {
  triggerIncident,
  resolveIncident,
  acknowledgeIncident,
  alertEventListenerDown,
  alertHighApiErrorRate,
  alertDatabasePoolExhausted,
  resolveEventListenerDown,
  resolveHighApiErrorRate,
  alertStreamDivergence,
  resolveStreamDivergence,
} from "/workspaces/nova-launch/monitoring/pagerduty/incident-response";

// ---------------------------------------------------------------------------
// Helpers to mock Node's https.request
// ---------------------------------------------------------------------------

function mockHttpsRequest(
  statusCode: number,
  responseBody: object
): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(https, "request").mockImplementation((_opts, callback) => {
    const res = Object.assign(new EventEmitter(), { statusCode });
    const req = Object.assign(new EventEmitter(), {
      write: vi.fn(),
      end: vi.fn(() => {
        if (callback) {
          (callback as (res: any) => void)(res);
          res.emit("data", JSON.stringify(responseBody));
          res.emit("end");
        }
      }),
    });
    return req as any;
  });
}

const ROUTING_KEY = "test-routing-key-32chars-padding00";

const SUCCESS_RESPONSE = {
  status: "success",
  message: "Event processed",
  dedup_key: "nova-test-dedup",
};

describe("PagerDuty Incident Response", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // triggerIncident
  // -------------------------------------------------------------------------

  describe("triggerIncident", () => {
    it("sends a trigger event and returns the response", async () => {
      mockHttpsRequest(202, SUCCESS_RESPONSE);

      const result = await triggerIncident(
        {
          summary: "Test alert",
          severity: "critical",
          dedupKey: "nova-test-dedup",
          source: "test-service",
        },
        ROUTING_KEY
      );

      expect(result.status).toBe("success");
      expect(result.dedup_key).toBe("nova-test-dedup");
    });

    it("includes custom details and links in the request body", async () => {
      let capturedBody = "";
      vi.spyOn(https, "request").mockImplementation((_opts, callback) => {
        const res = Object.assign(new EventEmitter(), { statusCode: 202 });
        const req = Object.assign(new EventEmitter(), {
          write: vi.fn((data: string) => {
            capturedBody = data;
          }),
          end: vi.fn(() => {
            if (callback) {
              (callback as (res: any) => void)(res);
              res.emit("data", JSON.stringify(SUCCESS_RESPONSE));
              res.emit("end");
            }
          }),
        });
        return req as any;
      });

      await triggerIncident(
        {
          summary: "Test with details",
          severity: "warning",
          dedupKey: "nova-test-details",
          source: "backend",
          customDetails: { errorRate: 12.5 },
          links: [{ href: "https://example.com/runbook", text: "Runbook" }],
        },
        ROUTING_KEY
      );

      const parsed = JSON.parse(capturedBody);
      expect(parsed.event_action).toBe("trigger");
      expect(parsed.payload.custom_details.errorRate).toBe(12.5);
      expect(parsed.links[0].href).toBe("https://example.com/runbook");
    });

    it("throws when routing key is missing", async () => {
      await expect(
        triggerIncident(
          {
            summary: "No key",
            severity: "info",
            dedupKey: "x",
            source: "test",
          },
          "" // empty key
        )
      ).rejects.toThrow("PAGERDUTY_ROUTING_KEY is not set");
    });

    it("throws on 4xx API response", async () => {
      mockHttpsRequest(400, { status: "invalid event", message: "Bad request" });

      await expect(
        triggerIncident(
          { summary: "Bad", severity: "info", dedupKey: "x", source: "test" },
          ROUTING_KEY
        )
      ).rejects.toThrow("PagerDuty API error 400");
    });

    it("rejects on network error", async () => {
      vi.spyOn(https, "request").mockImplementation(() => {
        const req = Object.assign(new EventEmitter(), {
          write: vi.fn(),
          end: vi.fn(() => {
            req.emit("error", new Error("ECONNREFUSED"));
          }),
        });
        return req as any;
      });

      await expect(
        triggerIncident(
          { summary: "Net err", severity: "error", dedupKey: "x", source: "test" },
          ROUTING_KEY
        )
      ).rejects.toThrow("ECONNREFUSED");
    });
  });

  // -------------------------------------------------------------------------
  // resolveIncident
  // -------------------------------------------------------------------------

  describe("resolveIncident", () => {
    it("sends a resolve event", async () => {
      let capturedBody = "";
      vi.spyOn(https, "request").mockImplementation((_opts, callback) => {
        const res = Object.assign(new EventEmitter(), { statusCode: 202 });
        const req = Object.assign(new EventEmitter(), {
          write: vi.fn((data: string) => {
            capturedBody = data;
          }),
          end: vi.fn(() => {
            if (callback) {
              (callback as (res: any) => void)(res);
              res.emit("data", JSON.stringify(SUCCESS_RESPONSE));
              res.emit("end");
            }
          }),
        });
        return req as any;
      });

      await resolveIncident("nova-test-dedup", ROUTING_KEY);

      const parsed = JSON.parse(capturedBody);
      expect(parsed.event_action).toBe("resolve");
      expect(parsed.dedup_key).toBe("nova-test-dedup");
    });

    it("throws when routing key is missing", async () => {
      await expect(resolveIncident("x", "")).rejects.toThrow(
        "PAGERDUTY_ROUTING_KEY is not set"
      );
    });
  });

  // -------------------------------------------------------------------------
  // acknowledgeIncident
  // -------------------------------------------------------------------------

  describe("acknowledgeIncident", () => {
    it("sends an acknowledge event", async () => {
      let capturedBody = "";
      vi.spyOn(https, "request").mockImplementation((_opts, callback) => {
        const res = Object.assign(new EventEmitter(), { statusCode: 202 });
        const req = Object.assign(new EventEmitter(), {
          write: vi.fn((data: string) => {
            capturedBody = data;
          }),
          end: vi.fn(() => {
            if (callback) {
              (callback as (res: any) => void)(res);
              res.emit("data", JSON.stringify(SUCCESS_RESPONSE));
              res.emit("end");
            }
          }),
        });
        return req as any;
      });

      await acknowledgeIncident("nova-test-dedup", ROUTING_KEY);

      const parsed = JSON.parse(capturedBody);
      expect(parsed.event_action).toBe("acknowledge");
    });
  });

  // -------------------------------------------------------------------------
  // Pre-built helpers
  // -------------------------------------------------------------------------

  describe("pre-built alert helpers", () => {
    beforeEach(() => {
      mockHttpsRequest(202, SUCCESS_RESPONSE);
    });

    it("alertEventListenerDown uses critical severity and correct dedup key", async () => {
      let capturedBody = "";
      vi.spyOn(https, "request").mockImplementation((_opts, callback) => {
        const res = Object.assign(new EventEmitter(), { statusCode: 202 });
        const req = Object.assign(new EventEmitter(), {
          write: vi.fn((data: string) => {
            capturedBody = data;
          }),
          end: vi.fn(() => {
            if (callback) {
              (callback as (res: any) => void)(res);
              res.emit("data", JSON.stringify(SUCCESS_RESPONSE));
              res.emit("end");
            }
          }),
        });
        return req as any;
      });

      // Provide routing key via env
      const original = process.env.PAGERDUTY_ROUTING_KEY;
      process.env.PAGERDUTY_ROUTING_KEY = ROUTING_KEY;
      try {
        await alertEventListenerDown({ lag: 120 });
        const parsed = JSON.parse(capturedBody);
        expect(parsed.payload.severity).toBe("critical");
        expect(parsed.dedup_key).toBe("nova-event-listener-down");
        expect(parsed.payload.custom_details.lag).toBe(120);
      } finally {
        process.env.PAGERDUTY_ROUTING_KEY = original;
      }
    });

    it("alertHighApiErrorRate uses critical severity when rate >= 20%", async () => {
      let capturedBody = "";
      vi.spyOn(https, "request").mockImplementation((_opts, callback) => {
        const res = Object.assign(new EventEmitter(), { statusCode: 202 });
        const req = Object.assign(new EventEmitter(), {
          write: vi.fn((data: string) => {
            capturedBody = data;
          }),
          end: vi.fn(() => {
            if (callback) {
              (callback as (res: any) => void)(res);
              res.emit("data", JSON.stringify(SUCCESS_RESPONSE));
              res.emit("end");
            }
          }),
        });
        return req as any;
      });

      const original = process.env.PAGERDUTY_ROUTING_KEY;
      process.env.PAGERDUTY_ROUTING_KEY = ROUTING_KEY;
      try {
        await alertHighApiErrorRate(25.0);
        const parsed = JSON.parse(capturedBody);
        expect(parsed.payload.severity).toBe("critical");
        expect(parsed.dedup_key).toBe("nova-api-high-error-rate");
      } finally {
        process.env.PAGERDUTY_ROUTING_KEY = original;
      }
    });

    it("alertHighApiErrorRate uses error severity when rate < 20%", async () => {
      let capturedBody = "";
      vi.spyOn(https, "request").mockImplementation((_opts, callback) => {
        const res = Object.assign(new EventEmitter(), { statusCode: 202 });
        const req = Object.assign(new EventEmitter(), {
          write: vi.fn((data: string) => {
            capturedBody = data;
          }),
          end: vi.fn(() => {
            if (callback) {
              (callback as (res: any) => void)(res);
              res.emit("data", JSON.stringify(SUCCESS_RESPONSE));
              res.emit("end");
            }
          }),
        });
        return req as any;
      });

      const original = process.env.PAGERDUTY_ROUTING_KEY;
      process.env.PAGERDUTY_ROUTING_KEY = ROUTING_KEY;
      try {
        await alertHighApiErrorRate(10.0);
        const parsed = JSON.parse(capturedBody);
        expect(parsed.payload.severity).toBe("error");
      } finally {
        process.env.PAGERDUTY_ROUTING_KEY = original;
      }
    });

    it("alertDatabasePoolExhausted uses critical severity", async () => {
      let capturedBody = "";
      vi.spyOn(https, "request").mockImplementation((_opts, callback) => {
        const res = Object.assign(new EventEmitter(), { statusCode: 202 });
        const req = Object.assign(new EventEmitter(), {
          write: vi.fn((data: string) => {
            capturedBody = data;
          }),
          end: vi.fn(() => {
            if (callback) {
              (callback as (res: any) => void)(res);
              res.emit("data", JSON.stringify(SUCCESS_RESPONSE));
              res.emit("end");
            }
          }),
        });
        return req as any;
      });

      const original = process.env.PAGERDUTY_ROUTING_KEY;
      process.env.PAGERDUTY_ROUTING_KEY = ROUTING_KEY;
      try {
        await alertDatabasePoolExhausted({ poolSize: 10, active: 10 });
        const parsed = JSON.parse(capturedBody);
        expect(parsed.payload.severity).toBe("critical");
        expect(parsed.dedup_key).toBe("nova-db-pool-exhausted");
      } finally {
        process.env.PAGERDUTY_ROUTING_KEY = original;
      }
    });

    it("resolveEventListenerDown sends resolve for correct dedup key", async () => {
      let capturedBody = "";
      vi.spyOn(https, "request").mockImplementation((_opts, callback) => {
        const res = Object.assign(new EventEmitter(), { statusCode: 202 });
        const req = Object.assign(new EventEmitter(), {
          write: vi.fn((data: string) => {
            capturedBody = data;
          }),
          end: vi.fn(() => {
            if (callback) {
              (callback as (res: any) => void)(res);
              res.emit("data", JSON.stringify(SUCCESS_RESPONSE));
              res.emit("end");
            }
          }),
        });
        return req as any;
      });

      const original = process.env.PAGERDUTY_ROUTING_KEY;
      process.env.PAGERDUTY_ROUTING_KEY = ROUTING_KEY;
      try {
        await resolveEventListenerDown();
        const parsed = JSON.parse(capturedBody);
        expect(parsed.event_action).toBe("resolve");
        expect(parsed.dedup_key).toBe("nova-event-listener-down");
      } finally {
        process.env.PAGERDUTY_ROUTING_KEY = original;
      }
    });

    it("resolveHighApiErrorRate sends resolve for correct dedup key", async () => {
      let capturedBody = "";
      vi.spyOn(https, "request").mockImplementation((_opts, callback) => {
        const res = Object.assign(new EventEmitter(), { statusCode: 202 });
        const req = Object.assign(new EventEmitter(), {
          write: vi.fn((data: string) => {
            capturedBody = data;
          }),
          end: vi.fn(() => {
            if (callback) {
              (callback as (res: any) => void)(res);
              res.emit("data", JSON.stringify(SUCCESS_RESPONSE));
              res.emit("end");
            }
          }),
        });
        return req as any;
      });

      const original = process.env.PAGERDUTY_ROUTING_KEY;
      process.env.PAGERDUTY_ROUTING_KEY = ROUTING_KEY;
      try {
        await resolveHighApiErrorRate();
        const parsed = JSON.parse(capturedBody);
        expect(parsed.event_action).toBe("resolve");
        expect(parsed.dedup_key).toBe("nova-api-high-error-rate");
      } finally {
        process.env.PAGERDUTY_ROUTING_KEY = original;
      }
    });
  });

  // -------------------------------------------------------------------------
  // Stream divergence alerts
  // -------------------------------------------------------------------------

  describe("stream divergence alerts", () => {
    it("alertStreamDivergence uses error severity (P2) and a per-stream/field dedup key", async () => {
      let capturedBody = "";
      vi.spyOn(https, "request").mockImplementation((_opts, callback) => {
        const res = Object.assign(new EventEmitter(), { statusCode: 202 });
        const req = Object.assign(new EventEmitter(), {
          write: vi.fn((data: string) => {
            capturedBody = data;
          }),
          end: vi.fn(() => {
            if (callback) {
              (callback as (res: any) => void)(res);
              res.emit("data", JSON.stringify(SUCCESS_RESPONSE));
              res.emit("end");
            }
          }),
        });
        return req as any;
      });

      const original = process.env.PAGERDUTY_ROUTING_KEY;
      process.env.PAGERDUTY_ROUTING_KEY = ROUTING_KEY;
      try {
        await alertStreamDivergence({
          streamId: 42,
          field: "balance",
          onChainValue: "100",
          projectedValue: "150",
        });
        const parsed = JSON.parse(capturedBody);
        expect(parsed.payload.severity).toBe("error");
        expect(parsed.dedup_key).toBe("nova-stream-divergence-42-balance");
        expect(parsed.payload.custom_details).toEqual({
          streamId: 42,
          field: "balance",
          onChainValue: "100",
          projectedValue: "150",
        });
      } finally {
        process.env.PAGERDUTY_ROUTING_KEY = original;
      }
    });

    it("resolveStreamDivergence sends resolve for the matching dedup key", async () => {
      let capturedBody = "";
      vi.spyOn(https, "request").mockImplementation((_opts, callback) => {
        const res = Object.assign(new EventEmitter(), { statusCode: 202 });
        const req = Object.assign(new EventEmitter(), {
          write: vi.fn((data: string) => {
            capturedBody = data;
          }),
          end: vi.fn(() => {
            if (callback) {
              (callback as (res: any) => void)(res);
              res.emit("data", JSON.stringify(SUCCESS_RESPONSE));
              res.emit("end");
            }
          }),
        });
        return req as any;
      });

      const original = process.env.PAGERDUTY_ROUTING_KEY;
      process.env.PAGERDUTY_ROUTING_KEY = ROUTING_KEY;
      try {
        await resolveStreamDivergence(42, "balance");
        const parsed = JSON.parse(capturedBody);
        expect(parsed.event_action).toBe("resolve");
        expect(parsed.dedup_key).toBe("nova-stream-divergence-42-balance");
      } finally {
        process.env.PAGERDUTY_ROUTING_KEY = original;
      }
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    it("handles malformed JSON response gracefully", async () => {
      vi.spyOn(https, "request").mockImplementation((_opts, callback) => {
        const res = Object.assign(new EventEmitter(), { statusCode: 202 });
        const req = Object.assign(new EventEmitter(), {
          write: vi.fn(),
          end: vi.fn(() => {
            if (callback) {
              (callback as (res: any) => void)(res);
              res.emit("data", "not-json");
              res.emit("end");
            }
          }),
        });
        return req as any;
      });

      await expect(
        triggerIncident(
          { summary: "x", severity: "info", dedupKey: "x", source: "x" },
          ROUTING_KEY
        )
      ).rejects.toThrow("Failed to parse PagerDuty response");
    });

    it("summary is included in the payload", async () => {
      let capturedBody = "";
      vi.spyOn(https, "request").mockImplementation((_opts, callback) => {
        const res = Object.assign(new EventEmitter(), { statusCode: 202 });
        const req = Object.assign(new EventEmitter(), {
          write: vi.fn((data: string) => {
            capturedBody = data;
          }),
          end: vi.fn(() => {
            if (callback) {
              (callback as (res: any) => void)(res);
              res.emit("data", JSON.stringify(SUCCESS_RESPONSE));
              res.emit("end");
            }
          }),
        });
        return req as any;
      });

      await triggerIncident(
        {
          summary: "Unique summary text",
          severity: "info",
          dedupKey: "x",
          source: "test",
        },
        ROUTING_KEY
      );

      const parsed = JSON.parse(capturedBody);
      expect(parsed.payload.summary).toBe("Unique summary text");
    });
  });
});

// ---------------------------------------------------------------------------
// SEVERITY_ROUTING map
// ---------------------------------------------------------------------------

describe("SEVERITY_ROUTING", () => {
  it("maps contract-divergence to P1 critical with an escalation policy", () => {
    const route = SEVERITY_ROUTING["contract-divergence"];
    expect(route.priority).toBe("P1");
    expect(route.severity).toBe("critical");
    expect(route.escalationPolicyId).toMatch(/^EP-/);
  });

  it("maps auth-failure-spike to P2 error", () => {
    const route = SEVERITY_ROUTING["auth-failure-spike"];
    expect(route.priority).toBe("P2");
    expect(route.severity).toBe("error");
    expect(route.escalationPolicyId).toMatch(/^EP-/);
  });

  it("maps db-connection-loss to P1 critical", () => {
    const route = SEVERITY_ROUTING["db-connection-loss"];
    expect(route.priority).toBe("P1");
    expect(route.severity).toBe("critical");
  });

  it("maps disk-space-low to P3 warning", () => {
    const route = SEVERITY_ROUTING["disk-space-low"];
    expect(route.priority).toBe("P3");
    expect(route.severity).toBe("warning");
    expect(route.escalationPolicyId).toMatch(/^EP-/);
  });

  it("every event type has a non-empty escalation policy ID", () => {
    for (const [, route] of Object.entries(SEVERITY_ROUTING)) {
      expect(route.escalationPolicyId.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// dispatchAlert — severity routing
// ---------------------------------------------------------------------------

function mockHttpsSuccess(capturedBodyRef: { value: string }) {
  vi.spyOn(https, "request").mockImplementation((_opts, callback) => {
    const res = Object.assign(new EventEmitter(), { statusCode: 202 });
    const req = Object.assign(new EventEmitter(), {
      write: vi.fn((data: string) => {
        capturedBodyRef.value = data;
      }),
      end: vi.fn(() => {
        if (callback) {
          (callback as (res: any) => void)(res);
          res.emit("data", JSON.stringify(SUCCESS_RESPONSE));
          res.emit("end");
        }
      }),
    });
    return req as any;
  });
}

describe("dispatchAlert - severity routing", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    _resetRateLimiter();
  });

  it("routes contract-divergence as P1 critical to PagerDuty", async () => {
    const body = { value: "" };
    mockHttpsSuccess(body);

    const original = process.env.PAGERDUTY_ROUTING_KEY;
    process.env.PAGERDUTY_ROUTING_KEY = ROUTING_KEY;
    try {
      await dispatchAlert("contract-divergence", {
        summary: "Contract state diverged from expected",
        dedupKey: "nova-contract-divergence",
        source: "contract-monitor",
      });
      const parsed = JSON.parse(body.value);
      expect(parsed.payload.severity).toBe("critical");
      expect(parsed.event_action).toBe("trigger");
    } finally {
      process.env.PAGERDUTY_ROUTING_KEY = original;
    }
  });

  it("routes auth-failure-spike as P2 error to PagerDuty", async () => {
    const body = { value: "" };
    mockHttpsSuccess(body);

    const original = process.env.PAGERDUTY_ROUTING_KEY;
    process.env.PAGERDUTY_ROUTING_KEY = ROUTING_KEY;
    try {
      await dispatchAlert("auth-failure-spike", {
        summary: "Auth failure rate spiking",
        dedupKey: "nova-auth-spike",
        source: "auth-service",
      });
      const parsed = JSON.parse(body.value);
      expect(parsed.payload.severity).toBe("error");
    } finally {
      process.env.PAGERDUTY_ROUTING_KEY = original;
    }
  });

  it("routes disk-space-low as P3 warning to PagerDuty", async () => {
    const body = { value: "" };
    mockHttpsSuccess(body);

    const original = process.env.PAGERDUTY_ROUTING_KEY;
    process.env.PAGERDUTY_ROUTING_KEY = ROUTING_KEY;
    try {
      await dispatchAlert("disk-space-low", {
        summary: "Disk space below 15%",
        dedupKey: "nova-disk-low",
        source: "infra-monitor",
      });
      const parsed = JSON.parse(body.value);
      expect(parsed.payload.severity).toBe("warning");
    } finally {
      process.env.PAGERDUTY_ROUTING_KEY = original;
    }
  });
});

// ---------------------------------------------------------------------------
// dispatchAlert — dry-run mode
// ---------------------------------------------------------------------------

describe("dispatchAlert - dry-run mode", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    _resetRateLimiter();
  });

  it("returns resolved route without making an API call", async () => {
    const requestSpy = vi.spyOn(https, "request");

    const result = await dispatchAlert(
      "auth-failure-spike",
      {
        summary: "Auth failures spiking",
        dedupKey: "nova-auth-spike-dry",
        source: "auth-service",
      },
      { dryRun: true, routingKey: ROUTING_KEY }
    );

    expect(requestSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      dryRun: true,
      eventType: "auth-failure-spike",
      priority: "P2",
      severity: "error",
    });
  });

  it("dry-run on a P1 event returns correct priority and policy", async () => {
    const requestSpy = vi.spyOn(https, "request");

    const result = await dispatchAlert(
      "contract-divergence",
      {
        summary: "Diverged",
        dedupKey: "nova-contract-divergence-dry",
        source: "monitor",
      },
      { dryRun: true, routingKey: ROUTING_KEY }
    );

    expect(requestSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      dryRun: true,
      priority: "P1",
      severity: "critical",
      escalationPolicyId: "EP-CRITICAL-001",
    });
  });

  it("dry-run on a P3 event returns warning severity without API call", async () => {
    const requestSpy = vi.spyOn(https, "request");

    const result = await dispatchAlert(
      "disk-space-low",
      {
        summary: "Low disk",
        dedupKey: "nova-disk-low-dry",
        source: "infra",
      },
      { dryRun: true }
    );

    expect(requestSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      dryRun: true,
      priority: "P3",
      severity: "warning",
    });
  });
});

// ---------------------------------------------------------------------------
// dispatchAlert — P1 rate-limiter bypass
// ---------------------------------------------------------------------------

describe("dispatchAlert - P1 rate-limiter bypass", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    _resetRateLimiter();
  });

  it("P1 alerts send immediately even when the same dedupKey was just dispatched", async () => {
    let callCount = 0;
    vi.spyOn(https, "request").mockImplementation((_opts, callback) => {
      callCount++;
      const res = Object.assign(new EventEmitter(), { statusCode: 202 });
      const req = Object.assign(new EventEmitter(), {
        write: vi.fn(),
        end: vi.fn(() => {
          if (callback) {
            (callback as (res: any) => void)(res);
            res.emit("data", JSON.stringify(SUCCESS_RESPONSE));
            res.emit("end");
          }
        }),
      });
      return req as any;
    });

    const original = process.env.PAGERDUTY_ROUTING_KEY;
    process.env.PAGERDUTY_ROUTING_KEY = ROUTING_KEY;
    try {
      await dispatchAlert("contract-divergence", {
        summary: "First divergence",
        dedupKey: "nova-contract-divergence",
        source: "monitor",
      });
      await dispatchAlert("contract-divergence", {
        summary: "Second divergence",
        dedupKey: "nova-contract-divergence",
        source: "monitor",
      });
      expect(callCount).toBe(2);
    } finally {
      process.env.PAGERDUTY_ROUTING_KEY = original;
    }
  });

  it("P2 alerts with the same dedupKey are rate-limited after the first delivery", async () => {
    let callCount = 0;
    vi.spyOn(https, "request").mockImplementation((_opts, callback) => {
      callCount++;
      const res = Object.assign(new EventEmitter(), { statusCode: 202 });
      const req = Object.assign(new EventEmitter(), {
        write: vi.fn(),
        end: vi.fn(() => {
          if (callback) {
            (callback as (res: any) => void)(res);
            res.emit("data", JSON.stringify(SUCCESS_RESPONSE));
            res.emit("end");
          }
        }),
      });
      return req as any;
    });

    const original = process.env.PAGERDUTY_ROUTING_KEY;
    process.env.PAGERDUTY_ROUTING_KEY = ROUTING_KEY;
    try {
      await dispatchAlert("auth-failure-spike", {
        summary: "First spike",
        dedupKey: "nova-auth-spike",
        source: "auth",
      });
      const second = await dispatchAlert("auth-failure-spike", {
        summary: "Second spike",
        dedupKey: "nova-auth-spike",
        source: "auth",
      });
      expect(callCount).toBe(1);
      expect(second).toMatchObject({ rateLimited: true, dedupKey: "nova-auth-spike" });
    } finally {
      process.env.PAGERDUTY_ROUTING_KEY = original;
    }
  });

  it("P3 alerts with the same dedupKey are rate-limited after the first delivery", async () => {
    let callCount = 0;
    vi.spyOn(https, "request").mockImplementation((_opts, callback) => {
      callCount++;
      const res = Object.assign(new EventEmitter(), { statusCode: 202 });
      const req = Object.assign(new EventEmitter(), {
        write: vi.fn(),
        end: vi.fn(() => {
          if (callback) {
            (callback as (res: any) => void)(res);
            res.emit("data", JSON.stringify(SUCCESS_RESPONSE));
            res.emit("end");
          }
        }),
      });
      return req as any;
    });

    const original = process.env.PAGERDUTY_ROUTING_KEY;
    process.env.PAGERDUTY_ROUTING_KEY = ROUTING_KEY;
    try {
      await dispatchAlert("disk-space-low", {
        summary: "Low disk first",
        dedupKey: "nova-disk-low",
        source: "infra",
      });
      const second = await dispatchAlert("disk-space-low", {
        summary: "Low disk second",
        dedupKey: "nova-disk-low",
        source: "infra",
      });
      expect(callCount).toBe(1);
      expect(second).toMatchObject({ rateLimited: true });
    } finally {
      process.env.PAGERDUTY_ROUTING_KEY = original;
    }
  });
});
