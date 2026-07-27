import { createHash } from "crypto";
import type Redis from "ioredis";

export class CIDMismatchError extends Error {
  constructor(
    public readonly cid: string,
    public readonly detail: string
  ) {
    super(
      `IPFS CID integrity check failed for "${cid}": ${detail}`
    );
    this.name = "CIDMismatchError";
  }
}

/**
 * Fetches the content stored under a CID from an IPFS gateway and compares
 * it byte-for-byte against the originally uploaded content.
 *
 * This round-trip approach works regardless of the CID version or the encoding
 * strategy used by the pinning provider (dag-pb, raw, etc.) and guarantees
 * that what was stored under the returned CID matches what was uploaded.
 *
 * @param originalContent  The content that was uploaded (as a Buffer).
 * @param cid              The CID returned by the provider after upload.
 * @param gatewayBaseUrl   IPFS gateway base URL (no trailing slash).
 */
export async function verifyCIDContent(
  originalContent: Buffer,
  cid: string,
  gatewayBaseUrl = "https://gateway.pinata.cloud/ipfs"
): Promise<void> {
  let response: Response;

  try {
    response = await fetch(`${gatewayBaseUrl}/${cid}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CIDMismatchError(
      cid,
      `Failed to fetch content from gateway: ${msg}`
    );
  }

  if (!response.ok) {
    throw new CIDMismatchError(
      cid,
      `Gateway returned HTTP ${response.status} when fetching CID content`
    );
  }

  const fetched = Buffer.from(await response.arrayBuffer());

  const originalHash = createHash("sha256").update(originalContent).digest("hex");
  const fetchedHash = createHash("sha256").update(fetched).digest("hex");

  if (originalHash !== fetchedHash) {
    throw new CIDMismatchError(
      cid,
      `Content hash mismatch — uploaded sha256=${originalHash}, ` +
        `gateway returned sha256=${fetchedHash}`
    );
  }
}

/**
 * Verifies that a JSON metadata object matches the content stored under a CID.
 * The object is serialised with JSON.stringify before comparison.
 */
export async function verifyMetadataCID(
  metadata: unknown,
  cid: string,
  gatewayBaseUrl?: string
): Promise<void> {
  const content = Buffer.from(JSON.stringify(metadata));
  await verifyCIDContent(content, cid, gatewayBaseUrl);
}

// ---------------------------------------------------------------------------
// Retrieval-time CID integrity verification
// ---------------------------------------------------------------------------

/** Redis key prefix for cached content hashes. TTL: 24 hours. */
const HASH_CACHE_PREFIX = "ipfs:cid_hash:";
const HASH_CACHE_TTL_SECONDS = 86_400; // 24 hours

/**
 * Compute the SHA-256 hash of a buffer, returning a hex string.
 */
export function sha256Hex(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Options for verifyRetrievedContent.
 */
export interface VerifyRetrievedOptions {
  /** Redis client for hash caching. When omitted, caching is skipped. */
  redis?: Redis;
  /** IPFS gateway base URL (no trailing slash). */
  gatewayBaseUrl?: string;
  /** Callback invoked when a mismatch is detected — before re-pinning. */
  onMismatch?: (cid: string, storedHash: string, retrievedHash: string) => void;
  /** Function that re-pins the CID from the trusted gateway. */
  rePinFromGateway?: (cid: string) => Promise<void>;
}

/**
 * Verifies that content retrieved from IPFS matches the stored content hash
 * for the given CID.  The hash is cached in Redis to avoid recomputing it on
 * every request (addresses the <=50 ms latency requirement).
 *
 * Flow:
 *  1. Look up the expected hash in Redis.
 *  2. If cache miss, fetch content from the trusted public gateway and compute
 *     the hash; store it in Redis for future requests.
 *  3. Compute the hash of the freshly retrieved content.
 *  4. On mismatch: log, invoke onMismatch callback, trigger re-pin from the
 *     public gateway, and throw CIDMismatchError (caller should respond with
 *     503 until re-pin completes).
 *
 * @param retrievedContent  Content just fetched from the IPFS node.
 * @param cid               The CID under which the content is stored.
 * @param opts              Optional Redis client, gateway URL, and callbacks.
 */
export async function verifyRetrievedContent(
  retrievedContent: Buffer,
  cid: string,
  opts: VerifyRetrievedOptions = {}
): Promise<void> {
  const {
    redis,
    gatewayBaseUrl = "https://gateway.pinata.cloud/ipfs",
    onMismatch,
    rePinFromGateway,
  } = opts;

  const retrievedHash = sha256Hex(retrievedContent);

  // ── 1. Try to get the trusted hash from cache ────────────────────────────
  let trustedHash: string | null = null;

  if (redis) {
    try {
      trustedHash = await redis.get(`${HASH_CACHE_PREFIX}${cid}`);
    } catch {
      // Redis unavailable — fall through to gateway fetch
    }
  }

  // ── 2. Cache miss: fetch from trusted gateway and populate cache ──────────
  if (!trustedHash) {
    let gatewayResponse: Response;
    try {
      gatewayResponse = await fetch(`${gatewayBaseUrl}/${cid}`, {
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CIDMismatchError(
        cid,
        `Failed to fetch trusted content from gateway for hash seeding: ${msg}`
      );
    }

    if (!gatewayResponse.ok) {
      throw new CIDMismatchError(
        cid,
        `Trusted gateway returned HTTP ${gatewayResponse.status} when seeding hash for CID`
      );
    }

    const gatewayContent = Buffer.from(await gatewayResponse.arrayBuffer());
    trustedHash = sha256Hex(gatewayContent);

    if (redis) {
      try {
        await redis.set(
          `${HASH_CACHE_PREFIX}${cid}`,
          trustedHash,
          "EX",
          HASH_CACHE_TTL_SECONDS
        );
      } catch {
        // Non-fatal: we have the hash in memory for this request
      }
    }
  }

  // ── 3. Compare hashes ─────────────────────────────────────────────────────
  if (retrievedHash === trustedHash) {
    return; // All good
  }

  // ── 4. Mismatch handling ──────────────────────────────────────────────────
  console.error(
    `[cidVerification] CID mismatch detected for ${cid}: ` +
      `trusted sha256=${trustedHash}, retrieved sha256=${retrievedHash}`
  );

  if (onMismatch) {
    onMismatch(cid, trustedHash, retrievedHash);
  }

  // Evict stale cache entry so re-pin can refresh it
  if (redis) {
    try {
      await redis.del(`${HASH_CACHE_PREFIX}${cid}`);
    } catch {
      // Non-fatal
    }
  }

  // Trigger async re-pin without blocking the error response
  if (rePinFromGateway) {
    rePinFromGateway(cid).catch((err) => {
      console.error(
        `[cidVerification] Re-pin failed for ${cid}:`,
        err instanceof Error ? err.message : String(err)
      );
    });
  }

  throw new CIDMismatchError(
    cid,
    `Retrieved content hash mismatch — trusted sha256=${trustedHash}, ` +
      `retrieved sha256=${retrievedHash}`
  );
}
