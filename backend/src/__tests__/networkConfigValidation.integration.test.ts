/**
 * Integration tests for multi-network Stellar configuration validation (#1160)
 * and runtime network reachability validation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateNetworkConfig, runNetworkValidation } from "../config/startupValidation";
import { BackendEnv } from "../config/env";

// ---------------------------------------------------------------------------
// Module-level mock for outboundFetch — intercepts all HTTP probes issued by
// runNetworkValidation without requiring nock or a live network.
// ---------------------------------------------------------------------------

const { mockOutboundFetch } = vi.hoisted(() => ({
  mockOutboundFetch: vi.fn(),
}));

vi.mock("../lib/outboundHttpClient", () => ({
  outboundFetch: mockOutboundFetch,
  buildPropagationHeaders: () => ({}),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnv(overrides: Partial<BackendEnv> = {}): BackendEnv {
  return {
    NODE_ENV: "test",
    PORT: 3001,
    STELLAR_NETWORK: "testnet",
    STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
    STELLAR_SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
    STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
    FACTORY_CONTRACT_ID: "",
    DATABASE_URL: "postgresql://localhost/test",
    JWT_SECRET: "test-secret",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validateNetworkConfig (#1160)", () => {
  it("passes for a consistent testnet configuration", () => {
    expect(() => validateNetworkConfig(makeEnv())).not.toThrow();
  });

  it("passes for a consistent mainnet configuration", () => {
    const env = makeEnv({
      STELLAR_NETWORK: "mainnet",
      STELLAR_HORIZON_URL: "https://horizon.stellar.org",
      STELLAR_SOROBAN_RPC_URL: "https://soroban-mainnet.stellar.org",
      STELLAR_NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
      FACTORY_CONTRACT_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    });
    expect(() => validateNetworkConfig(env)).not.toThrow();
  });

  it("throws when the passphrase does not match the network", () => {
    const env = makeEnv({
      STELLAR_NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
    });
    expect(() => validateNetworkConfig(env)).toThrow(/passphrase mismatch/i);
  });

  it("throws when Horizon URL points at the opposite network", () => {
    const env = makeEnv({
      STELLAR_HORIZON_URL: "https://horizon.stellar.org", // mainnet URL on testnet config
    });
    expect(() => validateNetworkConfig(env)).toThrow(/mainnet/);
  });

  it("throws when Soroban RPC URL points at the opposite network", () => {
    const env = makeEnv({
      STELLAR_SOROBAN_RPC_URL: "https://soroban-mainnet.stellar.org",
    });
    expect(() => validateNetworkConfig(env)).toThrow(/mainnet/);
  });

  it("throws when mainnet is configured without a contract address", () => {
    const env = makeEnv({
      STELLAR_NETWORK: "mainnet",
      STELLAR_HORIZON_URL: "https://horizon.stellar.org",
      STELLAR_SOROBAN_RPC_URL: "https://soroban-mainnet.stellar.org",
      STELLAR_NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
      FACTORY_CONTRACT_ID: "", // missing
    });
    expect(() => validateNetworkConfig(env)).toThrow(/FACTORY_CONTRACT_ID/);
  });

  it("throws for an unknown network value", () => {
    const env = makeEnv({ STELLAR_NETWORK: "devnet" as any });
    expect(() => validateNetworkConfig(env)).toThrow(/Unknown STELLAR_NETWORK/);
  });
});

// ---------------------------------------------------------------------------
// Runtime reachability validation — runNetworkValidation
// ---------------------------------------------------------------------------

/**
 * Build a minimal Response-like object suitable for use as a mock return value.
 * Real network calls are replaced by mockOutboundFetch configured per test.
 */
function makeResponse(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  } as unknown as Response;
}

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const IPFS_GATEWAY = "https://gateway.pinata.cloud";

describe("runNetworkValidation — runtime reachability probes", () => {
  beforeEach(() => {
    mockOutboundFetch.mockReset();
  });

  // ── Helper: configure mock so every service succeeds ──────────────────────

  function mockAllReachable() {
    mockOutboundFetch.mockImplementation(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes("horizon-testnet")) {
        return makeResponse(200, { network_passphrase: TESTNET_PASSPHRASE });
      }
      if (u.includes("soroban-testnet")) {
        return makeResponse(200, { jsonrpc: "2.0", result: { status: "healthy" }, id: 1 });
      }
      // IPFS gateway HEAD probe
      return makeResponse(200);
    });
  }

  // ── All services reachable ────────────────────────────────────────────────

  it("reports all services reachable when every probe succeeds", async () => {
    mockAllReachable();

    const result = await runNetworkValidation(makeEnv(), IPFS_GATEWAY);

    expect(result.horizon.reachable).toBe(true);
    expect(result.horizon.passphraseMatches).toBe(true);
    expect(result.horizon.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.rpc.reachable).toBe(true);
    expect(result.ipfs.reachable).toBe(true);
  });

  it("horizon latencyMs is null when Horizon is unreachable", async () => {
    mockOutboundFetch.mockImplementation(async (url: string | URL) => {
      if (url.toString().includes("horizon-testnet")) throw new Error("ECONNREFUSED");
      return makeResponse(200, { result: { status: "healthy" } });
    });

    const result = await runNetworkValidation(makeEnv(), IPFS_GATEWAY);

    expect(result.horizon.reachable).toBe(false);
    expect(result.horizon.latencyMs).toBeNull();
    expect(result.horizon.passphraseMatches).toBe(false);
  });

  // ── Each service unreachable in isolation ─────────────────────────────────

  it("reports horizon unreachable when Horizon fetch throws (connection refused)", async () => {
    mockOutboundFetch.mockImplementation(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes("horizon-testnet")) throw new Error("ECONNREFUSED");
      if (u.includes("soroban-testnet")) return makeResponse(200, { result: { status: "healthy" } });
      return makeResponse(200);
    });

    const result = await runNetworkValidation(makeEnv(), IPFS_GATEWAY);

    expect(result.horizon.reachable).toBe(false);
    expect(result.rpc.reachable).toBe(true);
    expect(result.ipfs.reachable).toBe(true);
  });

  it("reports rpc unreachable when Soroban RPC fetch throws", async () => {
    mockOutboundFetch.mockImplementation(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes("soroban-testnet")) throw new Error("ECONNREFUSED");
      if (u.includes("horizon-testnet")) return makeResponse(200, { network_passphrase: TESTNET_PASSPHRASE });
      return makeResponse(200);
    });

    const result = await runNetworkValidation(makeEnv(), IPFS_GATEWAY);

    expect(result.horizon.reachable).toBe(true);
    expect(result.rpc.reachable).toBe(false);
    expect(result.ipfs.reachable).toBe(true);
  });

  it("reports ipfs unreachable when IPFS gateway fetch throws", async () => {
    mockOutboundFetch.mockImplementation(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes("gateway.pinata.cloud")) throw new Error("ENOTFOUND");
      if (u.includes("horizon-testnet")) return makeResponse(200, { network_passphrase: TESTNET_PASSPHRASE });
      return makeResponse(200, { result: { status: "healthy" } });
    });

    const result = await runNetworkValidation(makeEnv(), IPFS_GATEWAY);

    expect(result.horizon.reachable).toBe(true);
    expect(result.rpc.reachable).toBe(true);
    expect(result.ipfs.reachable).toBe(false);
  });

  // ── Passphrase mismatch ───────────────────────────────────────────────────

  it("reports passphraseMatches:false when Horizon returns an unexpected passphrase", async () => {
    mockOutboundFetch.mockImplementation(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes("horizon-testnet")) {
        // Reachable, but passphrase is wrong (e.g. misconfigured proxy returning mainnet data)
        return makeResponse(200, { network_passphrase: "Public Global Stellar Network ; September 2015" });
      }
      if (u.includes("soroban-testnet")) return makeResponse(200);
      return makeResponse(200);
    });

    const result = await runNetworkValidation(makeEnv(), IPFS_GATEWAY);

    expect(result.horizon.reachable).toBe(true);
    expect(result.horizon.passphraseMatches).toBe(false);
    expect(result.horizon.latencyMs).toBeGreaterThanOrEqual(0);
  });

  // ── Non-2xx HTTP status codes ─────────────────────────────────────────────

  it("reports horizon unreachable when Horizon returns HTTP 503", async () => {
    mockOutboundFetch.mockImplementation(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes("horizon-testnet")) return makeResponse(503);
      if (u.includes("soroban-testnet")) return makeResponse(200);
      return makeResponse(200);
    });

    const result = await runNetworkValidation(makeEnv(), IPFS_GATEWAY);

    expect(result.horizon.reachable).toBe(false);
    expect(result.horizon.latencyMs).toBeNull();
    expect(result.horizon.passphraseMatches).toBe(false);
  });

  it("reports ipfs reachable when gateway returns 404 (server up, path not found)", async () => {
    mockOutboundFetch.mockImplementation(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes("gateway.pinata.cloud")) return makeResponse(404);
      if (u.includes("horizon-testnet")) return makeResponse(200, { network_passphrase: TESTNET_PASSPHRASE });
      return makeResponse(200);
    });

    const result = await runNetworkValidation(makeEnv(), IPFS_GATEWAY);

    // 404 < 500 → gateway is reachable even if the root path returns 404
    expect(result.ipfs.reachable).toBe(true);
  });

  // ── Total outage ──────────────────────────────────────────────────────────

  it("reports all services unreachable when every probe throws", async () => {
    mockOutboundFetch.mockRejectedValue(new Error("Network error"));

    const result = await runNetworkValidation(makeEnv(), IPFS_GATEWAY);

    expect(result.horizon.reachable).toBe(false);
    expect(result.rpc.reachable).toBe(false);
    expect(result.ipfs.reachable).toBe(false);
  });
});
