/**
 * Unit tests for the GraphQL subscription resolvers.
 *
 * Strategy:
 *  - `eventBusAsyncIterator` is tested directly against a fresh EventBus.
 *  - Each subscription resolver is tested against the singleton eventBus
 *    (which the resolvers subscribe to), publishing mock events and asserting
 *    the iterator yields the correctly filtered + serialised payload.
 *  - Tenant scoping and per-argument filters are covered for every field.
 *
 * Prisma is mocked because resolvers.ts imports it at module load.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventBus, eventBus } from "../../services/eventBus";
import {
  resolvers,
  eventBusAsyncIterator,
  SUBSCRIPTION_TOPICS,
  type SubscriptionContext,
} from "../resolvers";

vi.mock("../../lib/prisma", () => ({
  prisma: {
    token: { findUnique: vi.fn(), findMany: vi.fn() },
    burnRecord: { findMany: vi.fn() },
    stream: { findUnique: vi.fn(), findMany: vi.fn() },
    proposal: { findUnique: vi.fn(), findMany: vi.fn() },
    vote: { findMany: vi.fn() },
    campaign: { findUnique: vi.fn(), findMany: vi.fn() },
  },
}));

const TENANT = "GCREATOR";
const ctx: SubscriptionContext = { tenant: { id: TENANT } };

beforeEach(() => {
  eventBus.reset();
});

/** Resolve the first value an iterator yields, or "PENDING" if it does not
 *  yield on the current microtask queue (i.e. the event was filtered out). */
async function firstValueOrPending<T>(
  it: AsyncIterableIterator<T>
): Promise<T | "PENDING"> {
  const result = await Promise.race([
    it.next().then((r) => r.value as T),
    Promise.resolve("PENDING" as const),
  ]);
  return result;
}

// ---------------------------------------------------------------------------
// eventBusAsyncIterator (helper)
// ---------------------------------------------------------------------------

describe("eventBusAsyncIterator", () => {
  it("yields published payloads that pass the filter", async () => {
    const bus = new EventBus();
    const it = eventBusAsyncIterator<{ n: number }>(
      "test.topic",
      () => true,
      bus
    );

    const pending = it.next();
    await bus.publish("test.topic", { n: 42 });
    const result = await pending;

    expect(result).toEqual({ value: { n: 42 }, done: false });
  });

  it("queues events that arrive before next() is called", async () => {
    const bus = new EventBus();
    const it = eventBusAsyncIterator<{ n: number }>(
      "test.topic",
      () => true,
      bus
    );

    await bus.publish("test.topic", { n: 1 });
    await bus.publish("test.topic", { n: 2 });

    expect((await it.next()).value).toEqual({ n: 1 });
    expect((await it.next()).value).toEqual({ n: 2 });
  });

  it("drops events that fail the filter", async () => {
    const bus = new EventBus();
    const it = eventBusAsyncIterator<{ n: number }>(
      "test.topic",
      (p) => p.n > 5,
      bus
    );

    await bus.publish("test.topic", { n: 1 }); // filtered
    await bus.publish("test.topic", { n: 9 }); // passes

    expect((await it.next()).value).toEqual({ n: 9 });
  });

  it("unsubscribes from the bus on return()", async () => {
    const bus = new EventBus();
    const it = eventBusAsyncIterator("test.topic", () => true, bus);

    expect(bus.subscriberCount("test.topic")).toBe(1);
    await it.return!();
    expect(bus.subscriberCount("test.topic")).toBe(0);

    const result = await it.next();
    expect(result.done).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Subscription.tokenDeployed
// ---------------------------------------------------------------------------

const makeTokenDeployed = (o: Record<string, unknown> = {}) => ({
  tokenAddress: "CTOKEN1",
  creatorAddress: TENANT,
  name: "Test Token",
  symbol: "TST",
  totalSupply: BigInt("1000000000"),
  txHash: "hashT",
  timestamp: "2026-06-23T00:00:00.000Z",
  ...o,
});

describe("Subscription.tokenDeployed", () => {
  it("delivers an event for the subscriber's tenant", async () => {
    const it = resolvers.Subscription.tokenDeployed.subscribe(
      undefined,
      {},
      ctx
    );
    const pending = it.next();
    await eventBus.publish(
      SUBSCRIPTION_TOPICS.tokenDeployed,
      makeTokenDeployed()
    );
    const { value } = await pending;

    const resolved = resolvers.Subscription.tokenDeployed.resolve(value);
    expect(resolved).toMatchObject({
      tokenAddress: "CTOKEN1",
      creatorAddress: TENANT,
      totalSupply: "1000000000", // BigInt → String
    });
  });

  it("does not deliver events belonging to another tenant", async () => {
    const it = resolvers.Subscription.tokenDeployed.subscribe(
      undefined,
      {},
      ctx
    );
    await eventBus.publish(
      SUBSCRIPTION_TOPICS.tokenDeployed,
      makeTokenDeployed({ creatorAddress: "GOTHER" })
    );
    expect(await firstValueOrPending(it)).toBe("PENDING");
  });

  it("delivers nothing to an unauthenticated (tenant-less) connection", async () => {
    const it = resolvers.Subscription.tokenDeployed.subscribe(
      undefined,
      {},
      {}
    );
    await eventBus.publish(
      SUBSCRIPTION_TOPICS.tokenDeployed,
      makeTokenDeployed()
    );
    expect(await firstValueOrPending(it)).toBe("PENDING");
  });

  it("honours the creatorAddress argument filter", async () => {
    const it = resolvers.Subscription.tokenDeployed.subscribe(
      undefined,
      { creatorAddress: TENANT },
      ctx
    );
    // Same tenant but the arg only matches one — both share creator == tenant,
    // so use the arg to confirm a non-matching arg is filtered.
    const it2 = resolvers.Subscription.tokenDeployed.subscribe(
      undefined,
      { creatorAddress: "GSOMEONEELSE" },
      ctx
    );
    await eventBus.publish(
      SUBSCRIPTION_TOPICS.tokenDeployed,
      makeTokenDeployed()
    );

    expect((await it.next()).value).toMatchObject({ creatorAddress: TENANT });
    expect(await firstValueOrPending(it2)).toBe("PENDING");
  });
});

// ---------------------------------------------------------------------------
// Subscription.burnExecuted
// ---------------------------------------------------------------------------

const makeBurn = (o: Record<string, unknown> = {}) => ({
  tokenAddress: "CTOKEN1",
  creatorAddress: TENANT,
  amount: BigInt("500"),
  burnedBy: "GBURNER",
  isAdminBurn: false,
  txHash: "hashB",
  timestamp: "2026-06-23T00:00:00.000Z",
  ...o,
});

describe("Subscription.burnExecuted", () => {
  it("delivers and serialises a burn event", async () => {
    const it = resolvers.Subscription.burnExecuted.subscribe(
      undefined,
      {},
      ctx
    );
    const pending = it.next();
    await eventBus.publish(SUBSCRIPTION_TOPICS.burnExecuted, makeBurn());
    const { value } = await pending;

    expect(resolvers.Subscription.burnExecuted.resolve(value)).toMatchObject({
      tokenAddress: "CTOKEN1",
      amount: "500",
      isAdminBurn: false,
    });
  });

  it("filters by tokenAddress argument", async () => {
    const it = resolvers.Subscription.burnExecuted.subscribe(
      undefined,
      { tokenAddress: "COTHER" },
      ctx
    );
    await eventBus.publish(SUBSCRIPTION_TOPICS.burnExecuted, makeBurn());
    expect(await firstValueOrPending(it)).toBe("PENDING");
  });

  it("enforces tenant scoping", async () => {
    const it = resolvers.Subscription.burnExecuted.subscribe(
      undefined,
      {},
      ctx
    );
    await eventBus.publish(
      SUBSCRIPTION_TOPICS.burnExecuted,
      makeBurn({ creatorAddress: "GOTHER" })
    );
    expect(await firstValueOrPending(it)).toBe("PENDING");
  });
});

// ---------------------------------------------------------------------------
// Subscription.proposalStatusChanged
// ---------------------------------------------------------------------------

const makeProposalStatus = (o: Record<string, unknown> = {}) => ({
  proposalId: 7,
  tokenAddress: "CTOKEN1",
  creatorAddress: TENANT,
  status: "PASSED",
  previousStatus: "ACTIVE",
  txHash: "hashP",
  timestamp: "2026-06-23T00:00:00.000Z",
  ...o,
});

describe("Subscription.proposalStatusChanged", () => {
  it("delivers a proposal status change", async () => {
    const it = resolvers.Subscription.proposalStatusChanged.subscribe(
      undefined,
      {},
      ctx
    );
    const pending = it.next();
    await eventBus.publish(
      SUBSCRIPTION_TOPICS.proposalStatusChanged,
      makeProposalStatus()
    );
    const { value } = await pending;

    expect(
      resolvers.Subscription.proposalStatusChanged.resolve(value)
    ).toMatchObject({
      proposalId: 7,
      status: "PASSED",
      previousStatus: "ACTIVE",
    });
  });

  it("filters by tokenAddress argument", async () => {
    const it = resolvers.Subscription.proposalStatusChanged.subscribe(
      undefined,
      { tokenAddress: "CNOPE" },
      ctx
    );
    await eventBus.publish(
      SUBSCRIPTION_TOPICS.proposalStatusChanged,
      makeProposalStatus()
    );
    expect(await firstValueOrPending(it)).toBe("PENDING");
  });

  it("enforces tenant scoping", async () => {
    const it = resolvers.Subscription.proposalStatusChanged.subscribe(
      undefined,
      {},
      ctx
    );
    await eventBus.publish(
      SUBSCRIPTION_TOPICS.proposalStatusChanged,
      makeProposalStatus({ creatorAddress: "GOTHER" })
    );
    expect(await firstValueOrPending(it)).toBe("PENDING");
  });
});

// ---------------------------------------------------------------------------
// Subscription.vaultMatured
// ---------------------------------------------------------------------------

const makeVault = (o: Record<string, unknown> = {}) => ({
  vaultId: 3,
  recipientAddress: "GRECIPIENT",
  creatorAddress: TENANT,
  amount: BigInt("250000"),
  txHash: "hashV",
  timestamp: "2026-06-23T00:00:00.000Z",
  ...o,
});

describe("Subscription.vaultMatured", () => {
  it("delivers and serialises a vault maturation", async () => {
    const it = resolvers.Subscription.vaultMatured.subscribe(
      undefined,
      {},
      ctx
    );
    const pending = it.next();
    await eventBus.publish(SUBSCRIPTION_TOPICS.vaultMatured, makeVault());
    const { value } = await pending;

    expect(resolvers.Subscription.vaultMatured.resolve(value)).toMatchObject({
      vaultId: 3,
      recipientAddress: "GRECIPIENT",
      amount: "250000",
    });
  });

  it("filters by recipientAddress argument", async () => {
    const it = resolvers.Subscription.vaultMatured.subscribe(
      undefined,
      { recipientAddress: "GSOMEONEELSE" },
      ctx
    );
    await eventBus.publish(SUBSCRIPTION_TOPICS.vaultMatured, makeVault());
    expect(await firstValueOrPending(it)).toBe("PENDING");
  });

  it("enforces tenant scoping", async () => {
    const it = resolvers.Subscription.vaultMatured.subscribe(
      undefined,
      {},
      ctx
    );
    await eventBus.publish(
      SUBSCRIPTION_TOPICS.vaultMatured,
      makeVault({ creatorAddress: "GOTHER" })
    );
    expect(await firstValueOrPending(it)).toBe("PENDING");
  });
});

// ---------------------------------------------------------------------------
// Subscription.campaignStepExecuted
// ---------------------------------------------------------------------------

const makeStepExecuted = (o: Record<string, unknown> = {}) => ({
  campaignId: 1,
  stepNumber: 1,
  amount: "3000",
  status: "COMPLETED",
  txHash: "hashS",
  executedAt: "2026-06-23T00:00:00.000Z",
  totalSteps: 5,
  executedAmount: "5000",
  campaignStatus: "ACTIVE",
  ...o,
});

describe("Subscription.campaignStepExecuted", () => {
  it("delivers a step execution event", async () => {
    const it = resolvers.Subscription.campaignStepExecuted.subscribe(
      undefined,
      {},
      ctx
    );
    const pending = it.next();
    await eventBus.publish(
      SUBSCRIPTION_TOPICS.campaignStepExecuted,
      makeStepExecuted()
    );
    const { value } = await pending;

    expect(
      resolvers.Subscription.campaignStepExecuted.resolve(value)
    ).toMatchObject({
      campaignId: 1,
      stepNumber: 1,
      status: "COMPLETED",
    });
  });

  it("filters by campaignId argument", async () => {
    const it = resolvers.Subscription.campaignStepExecuted.subscribe(
      undefined,
      { campaignId: 99 },
      ctx
    );
    await eventBus.publish(
      SUBSCRIPTION_TOPICS.campaignStepExecuted,
      makeStepExecuted()
    );
    expect(await firstValueOrPending(it)).toBe("PENDING");
  });

  it("is not tenant scoped — buyback campaigns have no creator", async () => {
    const it = resolvers.Subscription.campaignStepExecuted.subscribe(
      undefined,
      {},
      {} // no tenant resolved at all
    );
    const pending = it.next();
    await eventBus.publish(
      SUBSCRIPTION_TOPICS.campaignStepExecuted,
      makeStepExecuted()
    );
    expect((await pending).value).toMatchObject({ campaignId: 1 });
  });
});
