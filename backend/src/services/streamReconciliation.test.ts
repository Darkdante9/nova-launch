import { describe, it, expect, vi, beforeEach } from "vitest";
import { StreamStatus } from "@prisma/client";
import { StreamReconciliationService } from "./streamReconciliation";
import { eventBus } from "./eventBus";

function mockPrisma(streams: unknown[]) {
  return {
    stream: {
      findMany: vi.fn().mockResolvedValue(streams),
    },
  } as any;
}

describe("StreamReconciliationService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("flags a divergence and publishes stream.divergence_detected when balances mismatch", async () => {
    const publishSpy = vi.spyOn(eventBus, "publish");
    const prisma = mockPrisma([
      {
        streamId: 1,
        creator: "GCREATOR",
        recipient: "GRECIPIENT",
        amount: BigInt(1000),
        claimedAt: null,
        status: StreamStatus.CREATED,
      },
    ]);

    const service = new StreamReconciliationService(prisma, 300_000);
    const result = await service.reconcile();

    expect(result.divergences).toHaveLength(1);
    expect(result.divergences[0]).toMatchObject({
      streamId: 1,
      field: "balance",
      projectedValue: "1000",
      onChainValue: "0",
    });

    expect(publishSpy).toHaveBeenCalledWith("stream.divergence_detected", {
      streamId: 1,
      field: "balance",
      onChainValue: "0",
      projectedValue: "1000",
    });
  });

  it("does not publish an event when the projected balance matches on-chain state", async () => {
    const publishSpy = vi.spyOn(eventBus, "publish");
    const prisma = mockPrisma([
      {
        streamId: 2,
        creator: "GCREATOR",
        recipient: "GRECIPIENT",
        amount: BigInt(0),
        claimedAt: new Date(),
        status: StreamStatus.CLAIMED,
      },
    ]);

    const service = new StreamReconciliationService(prisma, 300_000);
    const result = await service.reconcile();

    expect(result.divergences).toHaveLength(0);
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("reports a divergence per mismatched stream across multiple streams", async () => {
    const publishSpy = vi.spyOn(eventBus, "publish");
    const prisma = mockPrisma([
      {
        streamId: 1,
        creator: "GCREATOR",
        recipient: "GRECIPIENT",
        amount: BigInt(1000),
        claimedAt: null,
        status: StreamStatus.CREATED,
      },
      {
        streamId: 2,
        creator: "GCREATOR2",
        recipient: "GRECIPIENT2",
        amount: BigInt(0),
        claimedAt: new Date(),
        status: StreamStatus.CLAIMED,
      },
      {
        streamId: 3,
        creator: "GCREATOR3",
        recipient: "GRECIPIENT3",
        amount: BigInt(500),
        claimedAt: null,
        status: StreamStatus.CREATED,
      },
    ]);

    const service = new StreamReconciliationService(prisma, 300_000);
    const result = await service.reconcile();

    expect(result.totalStreams).toBe(3);
    expect(result.divergences.map((d) => d.streamId)).toEqual([1, 3]);
    expect(publishSpy).toHaveBeenCalledTimes(2);
  });

  it("defaults to a 5-minute reconciliation interval", () => {
    const original = process.env.STREAM_RECONCILIATION_INTERVAL_MS;
    delete process.env.STREAM_RECONCILIATION_INTERVAL_MS;
    try {
      const prisma = mockPrisma([]);
      const service = new StreamReconciliationService(prisma);

      expect((service as any).reconciliationIntervalMs).toBe(300_000);
    } finally {
      process.env.STREAM_RECONCILIATION_INTERVAL_MS = original;
    }
  });
});
