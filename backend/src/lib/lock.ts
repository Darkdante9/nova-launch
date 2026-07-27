/**
 * Distributed lock helpers for Nova Launch backend.
 *
 * Uses Redis SET NX PX (set-if-not-exists with millisecond TTL) to implement
 * a simple, single-instance distributed lock. This is suitable for preventing
 * duplicate on-chain submissions when a client retries a slow request.
 *
 * Lock key format:  campaign_step_lock:<campaignId>:<stepNumber>
 * Lock value:       a caller-supplied request ID (used to identify the holder)
 *
 * Security / correctness notes:
 *   - Only the lock holder may release the lock (checked via Lua script).
 *   - The TTL (default 30 s) exceeds the maximum expected on-chain submission
 *     time, ensuring the lock expires automatically if the holder crashes.
 *   - On Redis unavailability the acquire call throws; callers must decide
 *     whether to fail open or closed. The execute-step handler fails open
 *     (proceeds without the lock) to avoid blocking legitimate requests during
 *     a Redis outage.
 *
 * References:
 *   https://redis.io/docs/manual/patterns/distributed-locks/
 */

import Redis from "ioredis";

/** Default lock TTL in milliseconds (30 seconds). */
export const STEP_LOCK_TTL_MS = 30_000;

/** Key prefix for campaign step locks. */
const LOCK_PREFIX = "campaign_step_lock";

/**
 * Builds the Redis key for a campaign step lock.
 *
 * @param campaignId  Numeric campaign identifier
 * @param stepNumber  Zero-based step index within the campaign
 */
export function stepLockKey(campaignId: number | string, stepNumber: number | string): string {
  return `${LOCK_PREFIX}:${campaignId}:${stepNumber}`;
}

/**
 * Result returned by `acquireStepLock`.
 *
 * - `acquired: true`  → the caller now holds the lock; call `releaseStepLock` when done.
 * - `acquired: false` → another request is already processing this step.
 *   `holderRequestId` identifies the current lock holder.
 */
export type AcquireLockResult =
  | { acquired: true; holderRequestId: string }
  | { acquired: false; holderRequestId: string };

/**
 * Attempts to acquire a distributed lock for a campaign execution step.
 *
 * Internally executes:
 *   SET <key> <requestId> NX PX <ttlMs>
 *
 * @param redis       ioredis client (must be connected)
 * @param campaignId  Campaign identifier
 * @param stepNumber  Step number within the campaign
 * @param requestId   Unique identifier for this request (e.g. UUID or correlation ID)
 * @param ttlMs       Lock TTL in milliseconds (default: STEP_LOCK_TTL_MS)
 *
 * @returns AcquireLockResult — contains `acquired` flag and `holderRequestId`
 */
export async function acquireStepLock(
  redis: Redis,
  campaignId: number | string,
  stepNumber: number | string,
  requestId: string,
  ttlMs: number = STEP_LOCK_TTL_MS,
): Promise<AcquireLockResult> {
  const key = stepLockKey(campaignId, stepNumber);

  // SET NX PX is atomic: returns "OK" on success, null if key already exists.
  const result = await redis.set(key, requestId, "PX", ttlMs, "NX");

  if (result === "OK") {
    return { acquired: true, holderRequestId: requestId };
  }

  // Lock already held — return the current holder's request ID.
  const holderRequestId = (await redis.get(key)) ?? "unknown";
  return { acquired: false, holderRequestId };
}

/**
 * Releases a campaign step lock, but only if the caller still holds it.
 *
 * Uses a Lua script to make the check-and-delete atomic, preventing a lock
 * holder from accidentally deleting a lock that was re-acquired after expiry.
 *
 * @param redis       ioredis client
 * @param campaignId  Campaign identifier
 * @param stepNumber  Step number within the campaign
 * @param requestId   The same requestId used when the lock was acquired
 *
 * @returns `true` if the lock was released, `false` if it was already gone or held by another
 */
export async function releaseStepLock(
  redis: Redis,
  campaignId: number | string,
  stepNumber: number | string,
  requestId: string,
): Promise<boolean> {
  const key = stepLockKey(campaignId, stepNumber);

  // Atomic compare-and-delete via Lua
  const luaScript = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("DEL", KEYS[1])
    else
      return 0
    end
  `;

  const deleted = await redis.eval(luaScript, 1, key, requestId) as number;
  return deleted === 1;
}
