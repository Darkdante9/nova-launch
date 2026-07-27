/**
 * Redis Sorted-Set Leaderboard Cache
 *
 * Maintains the "most-burned" and "most-active" leaderboards as Redis
 * sorted sets (ZSETs), updated incrementally via ZADD/ZINCRBY whenever a
 * `token.burned` or `token.deployed` event is published, instead of doing
 * a full Prisma recompute (groupBy + aggregate over BurnRecord) on every
 * cache miss.
 *
 * Scoping decision (see leaderboardService.ts for the call sites):
 *   - "most-burned" and "most-active" get the sorted-set treatment because
 *     they are rank/score leaderboards driven directly by burn volume and
 *     burn count — exactly what ZINCRBY is for.
 *   - "newest" (time-ordered) and "largest-supply" (a point-in-time Token
 *     column) are NOT moved to a sorted set: they don't have an
 *     incrementally-accumulated score driven by these events, so a
 *     ZADD/ZINCRBY strategy would not provide any benefit over the
 *     existing full-recompute + in-memory TTL cache. They keep the
 *     original approach.
 *   - "most-burners" (unique burner count) is also left on the existing
 *     path: counting *distinct* burners cannot be maintained correctly
 *     with a simple ZINCRBY (it would require a HyperLogLog/PFADD or a
 *     per-token Set of burner addresses, which is a different data
 *     structure/strategy than the sorted-set ranking this issue asks for).
 *
 * Fallback behaviour:
 *   - Redis connection failure (ZADD/ZINCRBY/ZREVRANGE throws) -> caller
 *     falls back to the full Prisma recompute path.
 *   - Cold start (sorted set key does not exist yet) -> caller falls back
 *     to the full Prisma recompute path, then this module's `warmSortedSet`
 *     is used to populate Redis from that result so subsequent reads can
 *     use the fast incremental path.
 */

import type Redis from "ioredis";
import { getRedis } from "./redis";

export type SortedSetBoard = "most-burned" | "most-active";

const KEY_PREFIX = "leaderboard:zset";

/** Redis key for a given board + time period. */
export function sortedSetKey(board: SortedSetBoard, period: string): string {
  return `${KEY_PREFIX}:${board}:${period}`;
}

export interface SortedSetMember {
  tokenId: string;
  score: number;
}

export interface SortedSetStatus {
  /** Whether the Redis command round-trip succeeded. */
  reachable: boolean;
  /** Whether the sorted set key exists (has been warmed) for this board/period. */
  warm: boolean;
  /** Error message, if any, from the last attempted command. */
  error?: string;
}

/**
 * Health probe used by the `/cache-status` endpoint and by the read path to
 * decide whether to trust the sorted set or fall back to full recompute.
 */
export async function getSortedSetStatus(
  board: SortedSetBoard,
  period: string,
  redis: Redis = getRedis()
): Promise<SortedSetStatus> {
  try {
    const exists = await redis.exists(sortedSetKey(board, period));
    return { reachable: true, warm: exists === 1 };
  } catch (err) {
    return {
      reachable: false,
      warm: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Reads the top N members (descending score) from the sorted set.
 * Returns `null` on cold-start (key missing) or Redis failure so the
 * caller can fall back to full recomputation.
 */
export async function readTopFromSortedSet(
  board: SortedSetBoard,
  period: string,
  skip: number,
  limit: number,
  redis: Redis = getRedis()
): Promise<{ members: SortedSetMember[]; total: number } | null> {
  const key = sortedSetKey(board, period);
  try {
    const exists = await redis.exists(key);
    if (exists !== 1) {
      // Cold start — nothing warmed yet.
      return null;
    }

    const total = await redis.zcard(key);
    const raw = await redis.zrevrange(
      key,
      skip,
      skip + limit - 1,
      "WITHSCORES"
    );

    const members: SortedSetMember[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      members.push({ tokenId: raw[i], score: Number(raw[i + 1]) });
    }

    return { members, total };
  } catch (err) {
    console.error(
      `[leaderboardSortedSetCache] read failed for ${key}:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/**
 * Warms (or fully rebuilds) the sorted set from an authoritative list of
 * { tokenId, score } pairs, typically produced by the existing
 * full-recompute Prisma path. Uses a single ZADD call with all members.
 *
 * Returns `true` on success, `false` if Redis was unreachable (the caller
 * should simply continue serving from the full-recompute result — warming
 * is best-effort).
 */
export async function warmSortedSet(
  board: SortedSetBoard,
  period: string,
  members: SortedSetMember[],
  redis: Redis = getRedis()
): Promise<boolean> {
  const key = sortedSetKey(board, period);
  try {
    if (members.length === 0) {
      // Still mark the key as "warm" with an empty set so cold-start checks
      // don't keep retrying a genuinely-empty leaderboard.
      await redis.del(key);
      await redis.zadd(key, "GT", 0, "__warm_marker__");
      await redis.zrem(key, "__warm_marker__");
      return true;
    }

    const args: (string | number)[] = [];
    for (const m of members) {
      args.push(m.score, m.tokenId);
    }

    await redis.del(key);
    await redis.zadd(key, ...args);
    return true;
  } catch (err) {
    console.error(
      `[leaderboardSortedSetCache] warm failed for ${key}:`,
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

/**
 * Incrementally bumps a single token's score in the sorted set(s) for a
 * board across all known time periods using ZINCRBY. Used by the
 * token.burned / token.deployed event handlers.
 *
 * Silently no-ops on Redis failure — incremental updates are best-effort;
 * the next cache miss will fall back to full recomputation and re-warm.
 */
export async function incrementScore(
  board: SortedSetBoard,
  period: string,
  tokenId: string,
  delta: number,
  redis: Redis = getRedis()
): Promise<boolean> {
  const key = sortedSetKey(board, period);
  try {
    await redis.zincrby(key, delta, tokenId);
    return true;
  } catch (err) {
    console.error(
      `[leaderboardSortedSetCache] zincrby failed for ${key}:`,
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

/**
 * Ensures a token has an entry in the sorted set (score 0) so newly
 * deployed tokens with no burns yet show up once they start accumulating
 * burns. Uses ZADD with NX semantics (do not overwrite an existing score).
 */
export async function ensureMember(
  board: SortedSetBoard,
  period: string,
  tokenId: string,
  redis: Redis = getRedis()
): Promise<boolean> {
  const key = sortedSetKey(board, period);
  try {
    await redis.zadd(key, "NX", 0, tokenId);
    return true;
  } catch (err) {
    console.error(
      `[leaderboardSortedSetCache] ensureMember failed for ${key}:`,
      err instanceof Error ? err.message : err
    );
    return false;
  }
}
