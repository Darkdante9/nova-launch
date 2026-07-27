/**
 * Integration tests for IPFS CID integrity verification on retrieval (#1352).
 *
 * Covers:
 *  - verifyRetrievedContent: match, mismatch, Redis cache hit/miss, re-pin
 *  - metadata.cid_mismatch Prometheus counter
 *  - rePinFromGateway helper
 *
 * All network calls are mocked — no live IPFS or Redis required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "crypto";
import {
  verifyRetrievedContent,
  sha256Hex,
  CIDMismatchError,
} from "../lib/ipfs/cidVerification";

// Top-level mocks so dynamic imports of pinata.ts work correctly
vi.mock("node-cache", () => ({
  default: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockReturnValue(undefined),
    set: vi.fn(),
    del: vi.fn(),
  })),
}));

vi.mock("@pinata/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    pinJSONToIPFS: vi.fn().mockResolvedValue({ IpfsHash: "QmMockedHash" }),
    pinFileToIPFS: vi.fn().mockResolvedValue({ IpfsHash: "QmMockedHash" }),
    pinByHash: vi.fn().mockResolvedValue({ IpfsHash: "QmMockedHash" }),
  })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GATEWAY = "https://gateway.pinata.cloud/ipfs";
const TEST_CID = "QmIntegrityTestCid";

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Build a minimal mock Redis client.
 */
function makeMockRedis(storedHash: string | null = null) {
  const store = new Map<string, string>();
  if (storedHash !== null) {
    store.set(`ipfs:cid_hash:${TEST_CID}`, storedHash);
  }
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    }),
    del: vi.fn(async (key: string) => {
      store.delete(key);
      return 1;
    }),
    _store: store,
  };
}

/**
 * Build a mock fetch that returns the given buffer as an ArrayBuffer response.
 */
function mockFetchReturning(content: Buffer, ok = true, status = 200) {
  const ab = new ArrayBuffer(content.length);
  new Uint8Array(ab).set(content);
  return vi.fn().mockResolvedValueOnce({
    ok,
    status,
    arrayBuffer: () => Promise.resolve(ab),
  } as unknown as Response);
}

// ---------------------------------------------------------------------------
// sha256Hex
// ---------------------------------------------------------------------------

describe("sha256Hex", () => {
  it("returns the correct SHA-256 hex digest of a buffer", () => {
    const content = Buffer.from("hello world");
    const expected = createHash("sha256").update(content).digest("hex");
    expect(sha256Hex(content)).toBe(expected);
  });

  it("produces different digests for different inputs", () => {
    expect(sha256Hex(Buffer.from("a"))).not.toBe(sha256Hex(Buffer.from("b")));
  });
});

// ---------------------------------------------------------------------------
// verifyRetrievedContent — match scenarios
// ---------------------------------------------------------------------------

describe("verifyRetrievedContent — content matches trusted hash", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves without error when hash matches a cached trusted hash", async () => {
    const content = Buffer.from('{"name":"Token A"}');
    const hash = sha256(content);
    const redis = makeMockRedis(hash);

    await expect(
      verifyRetrievedContent(content, TEST_CID, { redis: redis as any, gatewayBaseUrl: GATEWAY })
    ).resolves.toBeUndefined();

    // Redis was consulted
    expect(redis.get).toHaveBeenCalledWith(`ipfs:cid_hash:${TEST_CID}`);
    // No gateway fetch was called (Redis cache hit means no network round-trip)
    // The redis.set should NOT have been called since we had a cache hit
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("resolves when hash matches after a gateway seed (cache miss)", async () => {
    const content = Buffer.from('{"name":"Token B"}');
    const redis = makeMockRedis(null); // empty cache

    // Stub global.fetch so the gateway seed returns the same content
    vi.stubGlobal("fetch", mockFetchReturning(content));

    await expect(
      verifyRetrievedContent(content, TEST_CID, { redis: redis as any, gatewayBaseUrl: GATEWAY })
    ).resolves.toBeUndefined();

    // Hash should now be cached in Redis
    expect(redis.set).toHaveBeenCalledWith(
      `ipfs:cid_hash:${TEST_CID}`,
      sha256(content),
      "EX",
      86400
    );

    vi.unstubAllGlobals();
  });

  it("resolves when no Redis is provided and content matches the gateway seed", async () => {
    const content = Buffer.from('{"name":"Token C"}');

    vi.stubGlobal("fetch", mockFetchReturning(content));

    await expect(
      verifyRetrievedContent(content, TEST_CID, { gatewayBaseUrl: GATEWAY })
    ).resolves.toBeUndefined();

    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// verifyRetrievedContent — mismatch scenarios
// ---------------------------------------------------------------------------

describe("verifyRetrievedContent — content does NOT match trusted hash", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws CIDMismatchError when retrieved hash differs from cached hash", async () => {
    const trustedContent = Buffer.from('{"name":"Original"}');
    const tamperedContent = Buffer.from('{"name":"Tampered"}');
    const trustedHash = sha256(trustedContent);

    const redis = makeMockRedis(trustedHash);

    await expect(
      verifyRetrievedContent(tamperedContent, TEST_CID, {
        redis: redis as any,
        gatewayBaseUrl: GATEWAY,
      })
    ).rejects.toThrow(CIDMismatchError);
  });

  it("includes both hashes in the error message for diagnosis", async () => {
    const trustedContent = Buffer.from("trusted");
    const tamperedContent = Buffer.from("tampered");
    const trustedHash = sha256(trustedContent);

    const redis = makeMockRedis(trustedHash);

    const err = await verifyRetrievedContent(tamperedContent, TEST_CID, {
      redis: redis as any,
      gatewayBaseUrl: GATEWAY,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(CIDMismatchError);
    expect(err.message).toContain(trustedHash);
    expect(err.message).toContain(sha256(tamperedContent));
  });

  it("calls onMismatch callback with the CID and both hashes", async () => {
    const trustedContent = Buffer.from("trusted data");
    const tamperedContent = Buffer.from("tampered data");
    const trustedHash = sha256(trustedContent);

    const redis = makeMockRedis(trustedHash);
    const onMismatch = vi.fn();

    await verifyRetrievedContent(tamperedContent, TEST_CID, {
      redis: redis as any,
      gatewayBaseUrl: GATEWAY,
      onMismatch,
    }).catch(() => {});

    expect(onMismatch).toHaveBeenCalledWith(
      TEST_CID,
      trustedHash,
      sha256(tamperedContent)
    );
  });

  it("evicts the stale cache entry on mismatch", async () => {
    const trustedContent = Buffer.from("trusted");
    const tamperedContent = Buffer.from("tampered");
    const redis = makeMockRedis(sha256(trustedContent));

    await verifyRetrievedContent(tamperedContent, TEST_CID, {
      redis: redis as any,
      gatewayBaseUrl: GATEWAY,
    }).catch(() => {});

    expect(redis.del).toHaveBeenCalledWith(`ipfs:cid_hash:${TEST_CID}`);
  });

  it("triggers rePinFromGateway callback asynchronously on mismatch", async () => {
    const trustedContent = Buffer.from("trusted");
    const tamperedContent = Buffer.from("tampered");
    const redis = makeMockRedis(sha256(trustedContent));

    const rePinFromGateway = vi.fn().mockResolvedValue(undefined);

    await verifyRetrievedContent(tamperedContent, TEST_CID, {
      redis: redis as any,
      gatewayBaseUrl: GATEWAY,
      rePinFromGateway,
    }).catch(() => {});

    // Allow the micro-task queue to flush
    await Promise.resolve();

    expect(rePinFromGateway).toHaveBeenCalledWith(TEST_CID);
  });

  it("mismatch from gateway seed (cache miss) also throws CIDMismatchError", async () => {
    const trustedContent = Buffer.from("trusted seed");
    const tamperedContent = Buffer.from("corrupted node content");
    const redis = makeMockRedis(null); // empty cache

    // Gateway returns the trusted version; node served tampered version
    vi.stubGlobal("fetch", mockFetchReturning(trustedContent));

    await expect(
      verifyRetrievedContent(tamperedContent, TEST_CID, {
        redis: redis as any,
        gatewayBaseUrl: GATEWAY,
      })
    ).rejects.toThrow(CIDMismatchError);
  });
});

// ---------------------------------------------------------------------------
// verifyRetrievedContent — Redis resilience
// ---------------------------------------------------------------------------

describe("verifyRetrievedContent — Redis unavailability", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to gateway seed when Redis.get throws", async () => {
    const content = Buffer.from("content");
    const failingRedis = {
      get: vi.fn().mockRejectedValue(new Error("Redis connection refused")),
      set: vi.fn().mockRejectedValue(new Error("Redis connection refused")),
      del: vi.fn(),
    };

    // Gateway returns the same content => no mismatch
    vi.stubGlobal("fetch", mockFetchReturning(content));

    await expect(
      verifyRetrievedContent(content, TEST_CID, {
        redis: failingRedis as any,
        gatewayBaseUrl: GATEWAY,
      })
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// verifyRetrievedContent — gateway failures during seed
// ---------------------------------------------------------------------------

describe("verifyRetrievedContent — gateway seed failures", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws CIDMismatchError when gateway returns non-OK during seed", async () => {
    const content = Buffer.from("content");
    const redis = makeMockRedis(null);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({ ok: false, status: 503, arrayBuffer: vi.fn() } as unknown as Response)
    );

    await expect(
      verifyRetrievedContent(content, TEST_CID, {
        redis: redis as any,
        gatewayBaseUrl: GATEWAY,
      })
    ).rejects.toThrow(CIDMismatchError);
  });

  it("throws CIDMismatchError when gateway network fails during seed", async () => {
    const content = Buffer.from("content");
    const redis = makeMockRedis(null);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValueOnce(new Error("gateway unreachable"))
    );

    await expect(
      verifyRetrievedContent(content, TEST_CID, {
        redis: redis as any,
        gatewayBaseUrl: GATEWAY,
      })
    ).rejects.toThrow(/gateway unreachable/);
  });
});

// ---------------------------------------------------------------------------
// Prometheus metric: metadata.cid_mismatch counter
// ---------------------------------------------------------------------------

import {
  metadataCidMismatchCounter,
  rePinFromGateway,
} from "../lib/ipfs/pinata";

describe("metadata.cid_mismatch Prometheus counter", () => {
  it("is exported from pinata.ts and can be incremented", () => {
    expect(metadataCidMismatchCounter).toBeDefined();
    // The counter should be a prom-client Counter (has .inc method)
    expect(typeof metadataCidMismatchCounter.inc).toBe("function");
  });

  it("increments without throwing", () => {
    expect(() => metadataCidMismatchCounter.inc({ cid: TEST_CID })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Integration: rePinFromGateway helper
// ---------------------------------------------------------------------------

describe("rePinFromGateway", () => {
  const ORIG_API_KEY = process.env.PINATA_API_KEY;
  const ORIG_API_SECRET = process.env.PINATA_API_SECRET;

  beforeEach(() => {
    // pinata.ts reads activeCredentials from process.env at module load time,
    // but rotatePinataCredentials/setActiveCredentials mutates the module-level
    // variable. We ensure the module's live credentials are set via env vars
    // that were present when the module was first loaded, so we patch the
    // module's exported setter function instead.
    process.env.PINATA_API_KEY = "test-key";
    process.env.PINATA_API_SECRET = "test-secret";
  });

  afterEach(() => {
    process.env.PINATA_API_KEY = ORIG_API_KEY;
    process.env.PINATA_API_SECRET = ORIG_API_SECRET;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("calls pinata.pinByHash with the given CID", async () => {
    const pinataModule = await import("@pinata/sdk");
    const pinByHashMock = vi.fn().mockResolvedValue({ IpfsHash: TEST_CID });
    (pinataModule.default as any).mockImplementation(() => ({
      pinByHash: pinByHashMock,
    }));

    // Rotate credentials so activeCredentials in the module gets updated
    const { rotatePinataCredentials } = await import("../lib/ipfs/pinata");

    // Stub fetch for credential validation
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true } as Response)
    );

    await rotatePinataCredentials("test-key", "test-secret");
    await rePinFromGateway(TEST_CID);

    expect(pinByHashMock).toHaveBeenCalledWith(
      TEST_CID,
      expect.objectContaining({ pinataMetadata: { name: `repin-${TEST_CID}` } })
    );
  });
});
