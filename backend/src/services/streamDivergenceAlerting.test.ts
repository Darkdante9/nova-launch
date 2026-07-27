import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventBus } from "./eventBus";

vi.mock("../../../monitoring/pagerduty/incident-response", () => ({
  alertStreamDivergence: vi.fn().mockResolvedValue({
    status: "success",
    message: "Event processed",
    dedup_key: "nova-stream-divergence-1-balance",
  }),
}));

import { alertStreamDivergence } from "../../../monitoring/pagerduty/incident-response";
import { registerStreamDivergenceAlerting } from "./streamDivergenceAlerting";

describe("streamDivergenceAlerting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("triggers a PagerDuty incident when a stream.divergence_detected event is published", async () => {
    const bus = new EventBus();
    registerStreamDivergenceAlerting(bus);

    await bus.publish("stream.divergence_detected", {
      streamId: 1,
      field: "balance",
      onChainValue: "0",
      projectedValue: "1000",
    });

    expect(alertStreamDivergence).toHaveBeenCalledWith({
      streamId: 1,
      field: "balance",
      onChainValue: "0",
      projectedValue: "1000",
    });
  });

  it("does not call PagerDuty for unrelated events", async () => {
    const bus = new EventBus();
    registerStreamDivergenceAlerting(bus);

    await bus.publish("token.created", { symbol: "TKN" });

    expect(alertStreamDivergence).not.toHaveBeenCalled();
  });
});
