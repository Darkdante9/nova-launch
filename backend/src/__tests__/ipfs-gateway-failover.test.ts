/**
 * IPFS Gateway Failover Tests (#1369)
 *
 * Verifies that GatewayRouter falls back through the gateway priority list,
 * emits the failover metric, and triggers background re-pinning when the
 * primary gateway is unavailable.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  GatewayRouter,
  PinataClient,
  CloudflareGatewayClient,
  PublicGatewayClient,
  gatewayFailoverCounter,
  type GatewayClient,
} from "../lib/ipfs/gatewayRouter";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeGateway(
  name: string,
  fetchResult: "ok" | "fail",
  pinResult = false
): GatewayClient & { fetchCalls: number; pinCalls: number } {
  return {
    name,
    fetchCalls: 0,
    pinCalls: 0,
    async fetch(_cid: string, _timeoutMs: number) {
      this.fetchCalls++;
      if (fetchResult === "fail") throw new Error(`${name} unavailable`);
      return { from: name };
    },
    async pin(_cid: string) {
      this.pinCalls++;
      return pinResult;
    },
  };
}

/** Drain all microtasks / background promises. */
const flushPromises = () => new Promise((r) => setImmediate(r));

// ─── tests ───────────────────────────────────────────────────────────────────

describe("GatewayRouter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns content from the primary gateway when it succeeds", async () => {
    const primary = makeGateway("pinata", "ok");
    const secondary = makeGateway("cloudflare", "ok");
    const router = new GatewayRouter([primary, secondary]);

    const result = await router.fetch("QmABC");

    expect(result).toEqual({ from: "pinata" });
    expect(primary.fetchCalls).toBe(1);
    expect(secondary.fetchCalls).toBe(0);
  });

  it("falls back to secondary when primary fails", async () => {
    const primary = makeGateway("pinata", "fail");
    const secondary = makeGateway("cloudflare", "ok");
    const router = new GatewayRouter([primary, secondary]);

    const result = await router.fetch("QmABC");

    expect(result).toEqual({ from: "cloudflare" });
    expect(primary.fetchCalls).toBe(1);
    expect(secondary.fetchCalls).toBe(1);
  });

  it("falls back to tertiary when primary and secondary both fail", async () => {
    const primary = makeGateway("pinata", "fail");
    const secondary = makeGateway("cloudflare", "fail");
    const tertiary = makeGateway("public", "ok");
    const router = new GatewayRouter([primary, secondary, tertiary]);

    const result = await router.fetch("QmABC");

    expect(result).toEqual({ from: "public" });
    expect(tertiary.fetchCalls).toBe(1);
  });

  it("throws when all gateways fail", async () => {
    const router = new GatewayRouter([
      makeGateway("pinata", "fail"),
      makeGateway("cloudflare", "fail"),
      makeGateway("public", "fail"),
    ]);

    await expect(router.fetch("QmABC")).rejects.toThrow(
      /All IPFS gateways failed/
    );
  });

  it("emits ipfs.gateway.failover metric with the serving gateway name on failover", async () => {
    const primary = makeGateway("pinata", "fail");
    const secondary = makeGateway("cloudflare", "ok");
    const router = new GatewayRouter([primary, secondary]);

    const incSpy = vi.spyOn(gatewayFailoverCounter, "inc");

    await router.fetch("QmABC");

    expect(incSpy).toHaveBeenCalledWith({ gateway: "cloudflare" });
  });

  it("does NOT emit failover metric when primary succeeds", async () => {
    const primary = makeGateway("pinata", "ok");
    const router = new GatewayRouter([primary]);

    const incSpy = vi.spyOn(gatewayFailoverCounter, "inc");

    await router.fetch("QmABC");

    expect(incSpy).not.toHaveBeenCalled();
  });

  it("triggers background re-pin to primary after failover", async () => {
    const primary = makeGateway("pinata", "fail", true);
    const secondary = makeGateway("cloudflare", "ok");
    const router = new GatewayRouter([primary, secondary]);

    await router.fetch("QmABC");
    await flushPromises();

    // Primary.pin should have been called for re-pinning
    expect(primary.pinCalls).toBe(1);
  });

  it("does not re-pin when primary serves the response", async () => {
    const primary = makeGateway("pinata", "ok", true);
    const router = new GatewayRouter([primary]);

    await router.fetch("QmABC");
    await flushPromises();

    expect(primary.pinCalls).toBe(0);
  });

  it("swallows re-pin errors — does not reject the main fetch promise", async () => {
    const primary: GatewayClient = {
      name: "pinata",
      async fetch() { throw new Error("pinata down"); },
      async pin() { throw new Error("pin also broken"); },
    };
    const secondary = makeGateway("cloudflare", "ok");
    const router = new GatewayRouter([primary, secondary]);

    // Should not throw even though pin() will throw in the background
    await expect(router.fetch("QmABC")).resolves.toEqual({ from: "cloudflare" });
    await flushPromises();
  });
});

// ─── Gateway client unit tests ────────────────────────────────────────────────

describe("PinataClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetches successfully on 200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ name: "token" }),
    }));

    const client = new PinataClient("key", "secret", "https://gw.pinata.test/ipfs");
    const result = await client.fetch("QmABC", 2000);
    expect(result).toEqual({ name: "token" });
  });

  it("throws on non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));

    const client = new PinataClient("key", "secret");
    await expect(client.fetch("QmABC", 2000)).rejects.toThrow("503");
  });

  it("pin returns true on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const client = new PinataClient("key", "secret");
    expect(await client.pin("QmABC")).toBe(true);
  });

  it("pin returns false on error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    const client = new PinataClient("key", "secret");
    expect(await client.pin("QmABC")).toBe(false);
  });
});

describe("CloudflareGatewayClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetches from cloudflare gateway", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ name: "token" }),
    }));

    const client = new CloudflareGatewayClient("https://cf.test/ipfs");
    const result = await client.fetch("QmABC", 2000);
    expect(result).toEqual({ name: "token" });

    const url = (vi.mocked(globalThis.fetch).mock.calls[0][0] as string);
    expect(url).toContain("cf.test");
  });

  it("pin always returns false (read-only gateway)", async () => {
    const client = new CloudflareGatewayClient();
    expect(await client.pin("QmABC")).toBe(false);
  });
});

describe("PublicGatewayClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetches from public gateway", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ name: "token" }),
    }));

    const client = new PublicGatewayClient("https://ipfs.io/ipfs");
    await client.fetch("QmABC", 2000);

    const url = (vi.mocked(globalThis.fetch).mock.calls[0][0] as string);
    expect(url).toBe("https://ipfs.io/ipfs/QmABC");
  });

  it("pin always returns false (read-only gateway)", async () => {
    const client = new PublicGatewayClient();
    expect(await client.pin("QmABC")).toBe(false);
  });
});
