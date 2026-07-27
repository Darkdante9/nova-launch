/**
 * Tests for Event Bus Architecture (#843)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventBus, BusEvent } from "../services/eventBus";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBus() {
  return new EventBus();
}

// ---------------------------------------------------------------------------
// subscribe / publish
// ---------------------------------------------------------------------------

describe("EventBus — subscribe & publish", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = makeBus();
  });

  it("delivers event to a subscriber", async () => {
    const handler = vi.fn();
    bus.subscribe("token.created", handler);

    await bus.publish("token.created", { symbol: "TKN" });

    expect(handler).toHaveBeenCalledOnce();
    const event: BusEvent = handler.mock.calls[0][0];
    expect(event.type).toBe("token.created");
    expect(event.payload).toEqual({ symbol: "TKN" });
  });

  it("delivers to multiple subscribers for the same event", async () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.subscribe("token.created", h1);
    bus.subscribe("token.created", h2);

    await bus.publish("token.created", {});

    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it("does not deliver to subscribers of a different event type", async () => {
    const handler = vi.fn();
    bus.subscribe("token.burned", handler);

    await bus.publish("token.created", {});

    expect(handler).not.toHaveBeenCalled();
  });

  it("returns the published BusEvent", async () => {
    const event = await bus.publish("test.event", { x: 1 });

    expect(event.id).toBeDefined();
    expect(event.type).toBe("test.event");
    expect(event.payload).toEqual({ x: 1 });
    expect(event.timestamp).toBeDefined();
  });

  it("attaches correlationId when provided", async () => {
    const event = await bus.publish("test.event", {}, { correlationId: "abc-123" });
    expect(event.correlationId).toBe("abc-123");
  });

  it("awaits async handlers before resolving", async () => {
    const order: string[] = [];
    bus.subscribe("seq.event", async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push("handler");
    });

    await bus.publish("seq.event", {});
    order.push("after publish");

    expect(order).toEqual(["handler", "after publish"]);
  });
});

// ---------------------------------------------------------------------------
// Wildcard subscription
// ---------------------------------------------------------------------------

describe("EventBus — wildcard subscription", () => {
  it("wildcard handler receives all events", async () => {
    const bus = makeBus();
    const handler = vi.fn();
    bus.subscribe("*", handler);

    await bus.publish("token.created", {});
    await bus.publish("webhook.failed", {});

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("wildcard and specific handlers both fire", async () => {
    const bus = makeBus();
    const specific = vi.fn();
    const wildcard = vi.fn();
    bus.subscribe("token.created", specific);
    bus.subscribe("*", wildcard);

    await bus.publish("token.created", {});

    expect(specific).toHaveBeenCalledOnce();
    expect(wildcard).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// once()
// ---------------------------------------------------------------------------

describe("EventBus — once()", () => {
  it("fires only on the first matching event", async () => {
    const bus = makeBus();
    const handler = vi.fn();
    bus.once("token.created", handler);

    await bus.publish("token.created", {});
    await bus.publish("token.created", {});

    expect(handler).toHaveBeenCalledOnce();
  });

  it("does not affect other subscribers", async () => {
    const bus = makeBus();
    const persistent = vi.fn();
    const oneTime = vi.fn();
    bus.subscribe("ev", persistent);
    bus.once("ev", oneTime);

    await bus.publish("ev", {});
    await bus.publish("ev", {});

    expect(persistent).toHaveBeenCalledTimes(2);
    expect(oneTime).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// unsubscribe()
// ---------------------------------------------------------------------------

describe("EventBus — unsubscribe()", () => {
  it("stops delivering after unsubscribe", async () => {
    const bus = makeBus();
    const handler = vi.fn();
    const sub = bus.subscribe("ev", handler);

    await bus.publish("ev", {});
    sub.unsubscribe();
    await bus.publish("ev", {});

    expect(handler).toHaveBeenCalledOnce();
  });

  it("subscriberCount decreases after unsubscribe", () => {
    const bus = makeBus();
    const sub = bus.subscribe("ev", vi.fn());
    expect(bus.subscriberCount("ev")).toBe(1);
    sub.unsubscribe();
    expect(bus.subscriberCount("ev")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Dead-letter queue
// ---------------------------------------------------------------------------

describe("EventBus — dead-letter queue", () => {
  it("records failed handler in DLQ without throwing", async () => {
    const bus = makeBus();
    bus.subscribe("ev", async () => {
      throw new Error("handler boom");
    });

    await expect(bus.publish("ev", {})).resolves.toBeDefined();

    const dlq = bus.getDeadLetterQueue();
    expect(dlq).toHaveLength(1);
    expect(dlq[0].error).toBe("handler boom");
    expect(dlq[0].event.type).toBe("ev");
  });

  it("other handlers still run when one fails", async () => {
    const bus = makeBus();
    const good = vi.fn();
    bus.subscribe("ev", async () => { throw new Error("fail"); });
    bus.subscribe("ev", good);

    await bus.publish("ev", {});

    expect(good).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

describe("EventBus — history", () => {
  it("records published events", async () => {
    const bus = makeBus();
    await bus.publish("a", { n: 1 });
    await bus.publish("b", { n: 2 });

    expect(bus.getHistory()).toHaveLength(2);
  });

  it("filters history by event type", async () => {
    const bus = makeBus();
    await bus.publish("a", {});
    await bus.publish("b", {});
    await bus.publish("a", {});

    expect(bus.getHistory("a")).toHaveLength(2);
    expect(bus.getHistory("b")).toHaveLength(1);
  });

  it("respects maxHistory cap", async () => {
    const bus = new EventBus({ maxHistory: 3 });
    for (let i = 0; i < 5; i++) await bus.publish("ev", { i });

    expect(bus.getHistory()).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// subscriberCount / reset
// ---------------------------------------------------------------------------

describe("EventBus — subscriberCount & reset", () => {
  it("counts total subscribers across all types", () => {
    const bus = makeBus();
    bus.subscribe("a", vi.fn());
    bus.subscribe("a", vi.fn());
    bus.subscribe("b", vi.fn());

    expect(bus.subscriberCount()).toBe(3);
  });

  it("reset clears everything", async () => {
    const bus = makeBus();
    const handler = vi.fn();
    bus.subscribe("ev", handler);
    await bus.publish("ev", {});

    bus.reset();

    await bus.publish("ev", {});
    expect(handler).toHaveBeenCalledOnce(); // only the pre-reset call
    expect(bus.getHistory()).toHaveLength(1); // only post-reset event
    expect(bus.subscriberCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Issue #1064: Event Bus Pub/Sub Delivery Guarantees
// ---------------------------------------------------------------------------

describe("Issue #1064: Event bus pub/sub delivery guarantees", () => {
  it("published event reaches all current subscribers", async () => {
    const bus = makeBus();
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    const handler3 = vi.fn();

    bus.subscribe("order.created", handler1);
    bus.subscribe("order.created", handler2);
    bus.subscribe("order.created", handler3);

    const event = await bus.publish("order.created", { orderId: "123" });

    expect(handler1).toHaveBeenCalledOnce();
    expect(handler2).toHaveBeenCalledOnce();
    expect(handler3).toHaveBeenCalledOnce();

    // All receive the same event
    expect(handler1.mock.calls[0][0]).toEqual(event);
    expect(handler2.mock.calls[0][0]).toEqual(event);
    expect(handler3.mock.calls[0][0]).toEqual(event);
  });

  it("unsubscribed handlers no longer receive events", async () => {
    const bus = makeBus();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    const sub1 = bus.subscribe("payment.processed", handler1);
    const sub2 = bus.subscribe("payment.processed", handler2);

    await bus.publish("payment.processed", { amount: 100 });
    expect(handler1).toHaveBeenCalledOnce();
    expect(handler2).toHaveBeenCalledOnce();

    // Unsubscribe handler1
    sub1.unsubscribe();

    await bus.publish("payment.processed", { amount: 200 });
    expect(handler1).toHaveBeenCalledOnce(); // still 1, not called again
    expect(handler2).toHaveBeenCalledTimes(2); // called again
  });

  it("throwing subscriber does not prevent delivery to others", async () => {
    const bus = makeBus();
    const goodHandler = vi.fn();
    const badHandler = vi.fn().mockImplementation(() => {
      throw new Error("handler crashed");
    });
    const anotherGoodHandler = vi.fn();

    bus.subscribe("webhook.sent", badHandler);
    bus.subscribe("webhook.sent", goodHandler);
    bus.subscribe("webhook.sent", anotherGoodHandler);

    // Publish should not throw despite badHandler failing
    await expect(bus.publish("webhook.sent", { id: "w1" })).resolves.toBeDefined();

    // Good handlers still executed
    expect(goodHandler).toHaveBeenCalledOnce();
    expect(anotherGoodHandler).toHaveBeenCalledOnce();

    // Bad handler was called but error was caught
    expect(badHandler).toHaveBeenCalledOnce();

    // Error recorded in DLQ
    const dlq = bus.getDeadLetterQueue();
    expect(dlq).toHaveLength(1);
    expect(dlq[0].error).toBe("handler crashed");
  });

  it("publishing with no subscribers is a no-op", async () => {
    const bus = makeBus();

    // No subscribers registered
    const event = await bus.publish("orphan.event", { data: "test" });

    expect(event.type).toBe("orphan.event");
    expect(event.payload).toEqual({ data: "test" });

    // Event is still recorded in history
    expect(bus.getHistory()).toHaveLength(1);

    // No DLQ entries
    expect(bus.getDeadLetterQueue()).toHaveLength(0);
  });

  it("multiple async handlers all complete before publish resolves", async () => {
    const bus = makeBus();
    const order: string[] = [];

    bus.subscribe("async.event", async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push("handler1");
    });

    bus.subscribe("async.event", async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push("handler2");
    });

    bus.subscribe("async.event", async () => {
      order.push("handler3");
    });

    await bus.publish("async.event", {});
    order.push("after publish");

    // All handlers completed before "after publish"
    expect(order).toContain("handler1");
    expect(order).toContain("handler2");
    expect(order).toContain("handler3");
    expect(order[order.length - 1]).toBe("after publish");
  });

  it("wildcard subscribers receive all events alongside specific subscribers", async () => {
    const bus = makeBus();
    const specificHandler = vi.fn();
    const wildcardHandler = vi.fn();

    bus.subscribe("token.minted", specificHandler);
    bus.subscribe("*", wildcardHandler);

    await bus.publish("token.minted", { amount: 1000 });

    expect(specificHandler).toHaveBeenCalledOnce();
    expect(wildcardHandler).toHaveBeenCalledOnce();

    // Both receive the same event
    const event = specificHandler.mock.calls[0][0];
    expect(wildcardHandler.mock.calls[0][0]).toEqual(event);
  });

  it("one failing wildcard subscriber does not block specific subscribers", async () => {
    const bus = makeBus();
    const specificHandler = vi.fn();
    const badWildcardHandler = vi.fn().mockImplementation(() => {
      throw new Error("wildcard boom");
    });

    bus.subscribe("token.burned", specificHandler);
    bus.subscribe("*", badWildcardHandler);

    await expect(bus.publish("token.burned", { amount: 500 })).resolves.toBeDefined();

    expect(specificHandler).toHaveBeenCalledOnce();
    expect(badWildcardHandler).toHaveBeenCalledOnce();

    const dlq = bus.getDeadLetterQueue();
    expect(dlq).toHaveLength(1);
    expect(dlq[0].error).toBe("wildcard boom");
  });

  it("correlationId is propagated through all subscribers", async () => {
    const bus = makeBus();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    bus.subscribe("traced.event", handler1);
    bus.subscribe("traced.event", handler2);

    const correlationId = "trace-abc-123";
    await bus.publish("traced.event", { data: "x" }, { correlationId });

    expect(handler1.mock.calls[0][0].correlationId).toBe(correlationId);
    expect(handler2.mock.calls[0][0].correlationId).toBe(correlationId);
  });

  it("dead-letter queue preserves subscription ID for debugging", async () => {
    const bus = makeBus();
    const badHandler = vi.fn().mockImplementation(() => {
      throw new Error("debug me");
    });

    const sub = bus.subscribe("debug.event", badHandler);

    await bus.publish("debug.event", {});

    const dlq = bus.getDeadLetterQueue();
    expect(dlq).toHaveLength(1);
    expect(dlq[0].handlerSubscriptionId).toBe(sub.id);
    expect(dlq[0].event.type).toBe("debug.event");
    expect(dlq[0].failedAt).toBeDefined();
  });

  it("concurrent publishes to different event types do not interfere", async () => {
    const bus = makeBus();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    bus.subscribe("event.a", handler1);
    bus.subscribe("event.b", handler2);

    await Promise.all([
      bus.publish("event.a", { id: 1 }),
      bus.publish("event.b", { id: 2 }),
    ]);

    expect(handler1).toHaveBeenCalledOnce();
    expect(handler2).toHaveBeenCalledOnce();

    const history = bus.getHistory();
    expect(history).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Issue #1406: Schema validation in EventBus.publish (non-production only)
// ---------------------------------------------------------------------------

describe("Issue #1406: Event schema validation in publish()", () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it("publishes successfully when the payload matches its registered schema", async () => {
    const bus = makeBus();
    process.env.NODE_ENV = "test";

    await expect(
      bus.publish("burn.executed", {
        creatorAddress: "GCREATOR",
        tokenAddress: "CTOKEN1",
        amount: "500",
        burnedBy: "GBURNER",
        isAdminBurn: false,
        txHash: "hashB",
        timestamp: "2026-06-23T00:00:00.000Z",
      })
    ).resolves.toBeDefined();
  });

  it("throws synchronously in non-production when the payload violates its registered schema", async () => {
    const bus = makeBus();
    process.env.NODE_ENV = "development";

    await expect(
      bus.publish("burn.executed", {
        // missing every required field
        unexpected: true,
      })
    ).rejects.toThrow(/failed schema validation/);
  });

  it("does not record an invalid event in history (validation happens before dispatch)", async () => {
    const bus = makeBus();
    process.env.NODE_ENV = "test";

    await expect(bus.publish("burn.executed", {})).rejects.toThrow();
    expect(bus.getHistory("burn.executed")).toHaveLength(0);
  });

  it("does not deliver an invalid event to subscribers", async () => {
    const bus = makeBus();
    process.env.NODE_ENV = "test";
    const handler = vi.fn();
    bus.subscribe("burn.executed", handler);

    await expect(bus.publish("burn.executed", {})).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not validate (and does not throw) for event types with no registered schema", async () => {
    const bus = makeBus();
    process.env.NODE_ENV = "test";

    await expect(
      bus.publish("totally.unschematized.event", { whatever: "goes" })
    ).resolves.toBeDefined();
  });

  it("skips validation entirely in production, even for an invalid payload", async () => {
    const bus = makeBus();
    process.env.NODE_ENV = "production";

    await expect(bus.publish("burn.executed", {})).resolves.toBeDefined();
  });
});
