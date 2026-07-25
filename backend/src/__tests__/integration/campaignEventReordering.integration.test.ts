import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventBus } from "../../services/eventBus";
import { EventBuffer, BufferedEvent } from "../../services/campaignProjectionService";

interface CampaignEvent {
  campaignId: number;
  tokenId: string;
  creator: string;
  type: "BUYBACK" | "AIRDROP" | "LIQUIDITY";
  targetAmount: bigint;
  startTime: Date;
  endTime?: Date;
  metadata?: string;
  txHash: string;
}

interface CampaignExecutionEvent {
  campaignId: number;
  executor: string;
  amount: bigint;
  recipient?: string;
  txHash: string;
  executedAt: Date;
}

interface CampaignStatusEvent {
  campaignId: number;
  status: "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED";
  txHash: string;
}

interface CampaignProjection {
  campaignId: number;
  tokenId: string;
  creator: string;
  type: string;
  status: string;
  targetAmount: bigint;
  currentAmount: bigint;
  executionCount: number;
  txHash: string;
  startTime: Date;
  endTime?: Date;
  metadata?: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  cancelledAt?: Date;
  pausedAt?: Date;
}

class InMemoryCampaignStore {
  private campaigns = new Map<number, CampaignProjection>();
  private executionTxHashes = new Set<string>();
  processedOrder: number[] = [];

  parseCampaignCreated(event: CampaignEvent): void {
    this.campaigns.set(event.campaignId, {
      campaignId: event.campaignId,
      tokenId: event.tokenId,
      creator: event.creator,
      type: event.type,
      status: "ACTIVE",
      targetAmount: event.targetAmount,
      currentAmount: BigInt(0),
      executionCount: 0,
      txHash: event.txHash,
      startTime: event.startTime,
      endTime: event.endTime,
      metadata: event.metadata,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  parseCampaignExecution(event: CampaignExecutionEvent): void {
    const campaign = this.campaigns.get(event.campaignId);
    if (!campaign) {
      throw new Error(`Campaign ${event.campaignId} not found`);
    }
    if (this.executionTxHashes.has(event.txHash)) {
      return;
    }
    this.executionTxHashes.add(event.txHash);
    campaign.currentAmount += event.amount;
    campaign.executionCount += 1;
    campaign.txHash = event.txHash;
    campaign.updatedAt = new Date();
  }

  parseCampaignStatusChange(event: CampaignStatusEvent): void {
    const campaign = this.campaigns.get(event.campaignId);
    if (!campaign) {
      throw new Error(`Campaign ${event.campaignId} not found`);
    }
    const now = new Date();
    campaign.status = event.status;
    campaign.txHash = event.txHash;
    campaign.updatedAt = now;
    if (event.status === "COMPLETED") {
      campaign.completedAt = now;
    } else if (event.status === "CANCELLED") {
      campaign.cancelledAt = now;
    } else if (event.status === "PAUSED") {
      campaign.pausedAt = now;
    }
  }

  getCampaign(campaignId: number): CampaignProjection | undefined {
    return this.campaigns.get(campaignId);
  }
}

type CampaignBusEvent =
  | { kind: "created"; payload: CampaignEvent }
  | { kind: "execution"; payload: CampaignExecutionEvent }
  | { kind: "status"; payload: CampaignStatusEvent };

describe("Campaign Event Reordering — EventBus Integration", () => {
  let bus: EventBus;
  let store: InMemoryCampaignStore;
  let buffer: EventBuffer<CampaignBusEvent>;
  const onReorder = vi.fn();
  const now = new Date("2026-01-15T12:00:00Z");

  beforeEach(() => {
    bus = new EventBus({ maxHistory: 100 });
    store = new InMemoryCampaignStore();
    onReorder.mockClear();

    const processEvent = async (event: BufferedEvent<CampaignBusEvent>) => {
      const ev = event.payload;
      if (ev.kind === "created") {
        store.parseCampaignCreated(ev.payload);
      } else if (ev.kind === "execution") {
        store.parseCampaignExecution(ev.payload);
      } else if (ev.kind === "status") {
        store.parseCampaignStatusChange(ev.payload);
      }
    };

    buffer = new EventBuffer<CampaignBusEvent>(processEvent, 500, onReorder);
  });

  afterEach(() => {
    bus.reset();
  });

  it("converges to the correct state when events are delivered in reverse ledger order", async () => {
    const campaignEvent: CampaignEvent = {
      campaignId: 10,
      tokenId: "TKN-REV",
      creator: "creator-rev",
      type: "BUYBACK",
      targetAmount: BigInt(1_000_000),
      startTime: now,
      txHash: "tx-rev-create",
    };

    const exec1: CampaignExecutionEvent = {
      campaignId: 10,
      executor: "exec-1",
      amount: BigInt(100_000),
      txHash: "tx-rev-exec1",
      executedAt: new Date(now.getTime() + 3600000),
    };

    const exec2: CampaignExecutionEvent = {
      campaignId: 10,
      executor: "exec-2",
      amount: BigInt(200_000),
      txHash: "tx-rev-exec2",
      executedAt: new Date(now.getTime() + 7200000),
    };

    const statusEvent: CampaignStatusEvent = {
      campaignId: 10,
      status: "COMPLETED",
      txHash: "tx-rev-status",
    };

    const events: { ledger: number; event: CampaignBusEvent }[] = [
      { ledger: 4, event: { kind: "status", payload: statusEvent } },
      { ledger: 3, event: { kind: "execution", payload: exec2 } },
      { ledger: 2, event: { kind: "execution", payload: exec1 } },
      { ledger: 1, event: { kind: "created", payload: campaignEvent } },
    ];

    for (const { ledger, event } of events) {
      await buffer.ingest({ ledger, payload: event });
    }

    await buffer.flush();

    const proj = store.getCampaign(10);
    expect(proj).toBeDefined();
    expect(proj!.currentAmount).toBe(BigInt(300_000));
    expect(proj!.executionCount).toBe(2);
    expect(proj!.status).toBe("COMPLETED");
    expect(proj!.completedAt).toBeDefined();
  });

  it("converges correctly when events arrive in a fully shuffled sequence through the EventBus", async () => {
    interface BusPayload {
      ledger: number;
      kind: "created" | "execution" | "status";
      payload: unknown;
    }

    bus.subscribe("campaign.event", async (event) => {
      const msg = event.payload as BusPayload;
      await buffer.ingest({
        ledger: msg.ledger,
        payload: { kind: msg.kind, payload: msg.payload },
      });
    });

    const campaignEvent: CampaignEvent = {
      campaignId: 20,
      tokenId: "TKN-SHUF",
      creator: "creator-shuf",
      type: "LIQUIDITY",
      targetAmount: BigInt(2_000_000),
      startTime: now,
      txHash: "tx-shuf-create",
    };

    const exec1: CampaignExecutionEvent = {
      campaignId: 20,
      executor: "exec-1",
      amount: BigInt(500_000),
      txHash: "tx-shuf-exec1",
      executedAt: new Date(now.getTime() + 3600000),
    };

    const exec2: CampaignExecutionEvent = {
      campaignId: 20,
      executor: "exec-2",
      amount: BigInt(300_000),
      txHash: "tx-shuf-exec2",
      executedAt: new Date(now.getTime() + 7200000),
    };

    const exec3: CampaignExecutionEvent = {
      campaignId: 20,
      executor: "exec-3",
      amount: BigInt(200_000),
      txHash: "tx-shuf-exec3",
      executedAt: new Date(now.getTime() + 10800000),
    };

    const statusEvent: CampaignStatusEvent = {
      campaignId: 20,
      status: "COMPLETED",
      txHash: "tx-shuf-status",
    };

    const shuffled: BusPayload[] = [
      { ledger: 3, kind: "execution", payload: exec2 },
      { ledger: 5, kind: "status", payload: statusEvent },
      { ledger: 1, kind: "created", payload: campaignEvent },
      { ledger: 4, kind: "execution", payload: exec3 },
      { ledger: 2, kind: "execution", payload: exec1 },
    ];

    for (const item of shuffled) {
      await bus.publish("campaign.event", item);
    }

    await buffer.flush();

    const proj = store.getCampaign(20);
    expect(proj).toBeDefined();
    expect(proj!.currentAmount).toBe(BigInt(1_000_000));
    expect(proj!.executionCount).toBe(3);
    expect(proj!.status).toBe("COMPLETED");
  });

  it("flushes buffered events when a missing ledger never arrives (timeout)", async () => {
    const campaignEvent: CampaignEvent = {
      campaignId: 30,
      tokenId: "TKN-TIMEOUT",
      creator: "creator-timeout",
      type: "BUYBACK",
      targetAmount: BigInt(500_000),
      startTime: now,
      txHash: "tx-timeout-create",
    };

    const exec1: CampaignExecutionEvent = {
      campaignId: 30,
      executor: "exec-1",
      amount: BigInt(100_000),
      txHash: "tx-timeout-exec1",
      executedAt: new Date(now.getTime() + 3600000),
    };

    const exec2: CampaignExecutionEvent = {
      campaignId: 30,
      executor: "exec-2",
      amount: BigInt(150_000),
      txHash: "tx-timeout-exec2",
      executedAt: new Date(now.getTime() + 7200000),
    };

    await buffer.ingest({ ledger: 1, payload: { kind: "created", payload: campaignEvent } });
    await buffer.flush();

    expect(store.getCampaign(30)).toBeDefined();
    expect(store.getCampaign(30)!.status).toBe("ACTIVE");

    await buffer.ingest({ ledger: 3, payload: { kind: "execution", payload: exec2 } });
    await buffer.ingest({ ledger: 4, payload: { kind: "execution", payload: exec1 } });

    expect(store.getCampaign(30)!.currentAmount).toBe(BigInt(0));

    await buffer.flush();

    const proj = store.getCampaign(30);
    expect(proj!.currentAmount).toBe(BigInt(250_000));
    expect(proj!.executionCount).toBe(2);
  });

  it("detects reordering when an event with a lower ledger arrives after a later one was already processed", async () => {
    await buffer.ingest({ ledger: 1, payload: { kind: "created", payload: {
      campaignId: 25, tokenId: "TKN-REORDER", creator: "creator-reorder",
      type: "BUYBACK", targetAmount: BigInt(500_000), startTime: now, txHash: "tx-reorder-create",
    } } });
    await buffer.flush();

    await buffer.ingest({ ledger: 2, payload: { kind: "execution", payload: {
      campaignId: 25, executor: "exec-1", amount: BigInt(50_000),
      txHash: "tx-reorder-exec1", executedAt: new Date(now.getTime() + 3600000),
    } } });
    await buffer.flush();

    expect(store.getCampaign(25)!.currentAmount).toBe(BigInt(50_000));

    await buffer.ingest({ ledger: 1, payload: { kind: "execution", payload: {
      campaignId: 25, executor: "exec-0", amount: BigInt(25_000),
      txHash: "tx-reorder-exec0", executedAt: new Date(now.getTime() + 1800000),
    } } });

    expect(onReorder).toHaveBeenCalled();
  });

  it("does not grow the buffer unboundedly when a missing event never arrives", async () => {
    const campaignEvent: CampaignEvent = {
      campaignId: 40,
      tokenId: "TKN-UNBOUNDED",
      creator: "creator-unbounded",
      type: "AIRDROP",
      targetAmount: BigInt(1_000_000),
      startTime: now,
      txHash: "tx-unbounded-create",
    };

    await buffer.ingest({ ledger: 1, payload: { kind: "created", payload: campaignEvent } });

    for (let i = 3; i <= 100; i++) {
      await buffer.ingest({
        ledger: i,
        payload: {
          kind: "execution",
          payload: {
            campaignId: 40,
            executor: `exec-${i}`,
            amount: BigInt(10_000),
            txHash: `tx-unbounded-exec-${i}`,
            executedAt: new Date(now.getTime() + i * 3600000),
          },
        },
      });
    }

    await buffer.flush();

    const proj = store.getCampaign(40);
    expect(proj!.currentAmount).toBe(BigInt(98 * 10_000));
    expect(proj!.executionCount).toBe(98);
  });
});
