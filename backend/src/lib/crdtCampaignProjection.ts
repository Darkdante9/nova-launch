/**
 * CRDT-based Campaign Projection Types (#1628)
 *
 * This module defines Conflict-Free Replicated Data Types (CRDTs) for the
 * mutable fields of the campaign projection that can be safely written from
 * two active regions simultaneously.
 *
 * ## Fields Modelled as CRDTs
 *
 * | Field            | CRDT Type  | Rationale                                      |
 * |------------------|------------|------------------------------------------------|
 * | pledgedAmount    | PN-Counter | Accumulates pledges (+) and refunds (-)         |
 * | executionCount   | G-Counter  | Monotonically increases; no decrements needed   |
 * | participantList  | OR-Set     | Add/remove participants idempotently            |
 *
 * ## Fields That Require Single-Writer Semantics
 *
 * | Field         | Reason                                                    |
 * |---------------|-----------------------------------------------------------|
 * | status        | State machine transitions (ACTIVE→PAUSED→COMPLETED etc.)  |
 *                   are ordered and not commutative; use a coordinator lock.   |
 * | targetAmount  | Set once at creation; immutable thereafter.               |
 * | creatorId     | Immutable after creation.                                 |
 * | endTime       | Set once; may be extended via ordered operation.          |
 *
 * For single-writer fields, the primary region owns the write and the
 * secondary region replicates asynchronously via the standard replication
 * stream. On conflict, the primary wins (last-write-wins is acceptable
 * here because these fields are only written by admins, not end-users).
 *
 * ## Merge Semantics
 *
 * merge(A, B) == merge(B, A)   (commutativity)
 * merge(A, A) == A              (idempotency)
 * merge(merge(A, B), C) == merge(A, merge(B, C))  (associativity)
 */

// ─── G-Counter (Grow-only Counter) ───────────────────────────────────────────

/**
 * A G-Counter maps each region ID to its local increment total.
 * The value of the counter is the sum of all region entries.
 *
 * Merge rule: max of each region's value.
 */
export interface GCounter {
  /** regionId → count */
  readonly counters: Readonly<Record<string, bigint>>;
}

export function gCounterZero(): GCounter {
  return { counters: {} };
}

export function gCounterIncrement(c: GCounter, regionId: string, delta: bigint): GCounter {
  if (delta < 0n) throw new RangeError("G-Counter delta must be non-negative");
  const current = c.counters[regionId] ?? 0n;
  return { counters: { ...c.counters, [regionId]: current + delta } };
}

export function gCounterValue(c: GCounter): bigint {
  return Object.values(c.counters).reduce((a, v) => a + v, 0n);
}

export function mergeGCounters(a: GCounter, b: GCounter): GCounter {
  const merged: Record<string, bigint> = { ...a.counters };
  for (const [regionId, val] of Object.entries(b.counters)) {
    const existing = merged[regionId] ?? 0n;
    merged[regionId] = existing > val ? existing : val;
  }
  return { counters: merged };
}

// ─── PN-Counter (Positive-Negative Counter) ───────────────────────────────────

/**
 * A PN-Counter is two G-Counters: one for increments (P) and one for
 * decrements (N). The value is P.value - N.value.
 *
 * Merge rule: merge each G-Counter independently.
 */
export interface PNCounter {
  readonly p: GCounter; // positive increments
  readonly n: GCounter; // negative decrements
}

export function pnCounterZero(): PNCounter {
  return { p: gCounterZero(), n: gCounterZero() };
}

export function pnCounterIncrement(c: PNCounter, regionId: string, delta: bigint): PNCounter {
  if (delta < 0n) throw new RangeError("Use pnCounterDecrement for negative deltas");
  return { ...c, p: gCounterIncrement(c.p, regionId, delta) };
}

export function pnCounterDecrement(c: PNCounter, regionId: string, delta: bigint): PNCounter {
  if (delta < 0n) throw new RangeError("Decrement delta must be non-negative");
  return { ...c, n: gCounterIncrement(c.n, regionId, delta) };
}

export function pnCounterValue(c: PNCounter): bigint {
  return gCounterValue(c.p) - gCounterValue(c.n);
}

export function mergePNCounters(a: PNCounter, b: PNCounter): PNCounter {
  return {
    p: mergeGCounters(a.p, b.p),
    n: mergeGCounters(a.n, b.n),
  };
}

// ─── OR-Set (Observed-Remove Set) ────────────────────────────────────────────

/**
 * An OR-Set allows adding and removing elements idempotently.
 *
 * Each element in the set is tagged with a unique token (UUID or similar)
 * so that concurrent adds and removes are resolved correctly:
 * - Add(x, tag) → inserts (x, tag) into the "added" map
 * - Remove(x) → moves all (x, _) entries to the "removed" set
 * - Contains(x) → any (x, tag) in added but not in removed
 *
 * Merge rule: union of adds, union of removes.
 */
export interface ORSet<T extends string> {
  /** element → set of add-tags */
  readonly added: Readonly<Record<T, ReadonlySet<string>>>;
  /** element → set of removed add-tags */
  readonly removed: Readonly<Record<T, ReadonlySet<string>>>;
}

export function orSetEmpty<T extends string>(): ORSet<T> {
  return { added: {} as Record<T, ReadonlySet<string>>, removed: {} as Record<T, ReadonlySet<string>> };
}

export function orSetAdd<T extends string>(s: ORSet<T>, element: T, tag: string): ORSet<T> {
  const existing = new Set(s.added[element] ?? []);
  existing.add(tag);
  return {
    ...s,
    added: { ...s.added, [element]: existing },
  };
}

export function orSetRemove<T extends string>(s: ORSet<T>, element: T): ORSet<T> {
  const addedTags = new Set(s.added[element] ?? []);
  const removedTags = new Set(s.removed[element] ?? []);
  for (const tag of addedTags) {
    removedTags.add(tag);
  }
  return {
    ...s,
    removed: { ...s.removed, [element]: removedTags },
  };
}

export function orSetContains<T extends string>(s: ORSet<T>, element: T): boolean {
  const addedTags = s.added[element] ?? new Set<string>();
  const removedTags = s.removed[element] ?? new Set<string>();
  for (const tag of addedTags) {
    if (!removedTags.has(tag)) return true;
  }
  return false;
}

export function orSetElements<T extends string>(s: ORSet<T>): T[] {
  return (Object.keys(s.added) as T[]).filter((e) => orSetContains(s, e));
}

export function mergeORSets<T extends string>(a: ORSet<T>, b: ORSet<T>): ORSet<T> {
  // Merge added: union of tags per element
  const mergedAdded = { ...a.added } as Record<T, Set<string>>;
  for (const [elem, tags] of Object.entries(b.added) as [T, ReadonlySet<string>][]) {
    const existing = new Set(mergedAdded[elem] ?? []);
    for (const tag of tags) existing.add(tag);
    mergedAdded[elem] = existing;
  }
  // Merge removed: union of tags per element
  const mergedRemoved = { ...a.removed } as Record<T, Set<string>>;
  for (const [elem, tags] of Object.entries(b.removed) as [T, ReadonlySet<string>][]) {
    const existing = new Set(mergedRemoved[elem] ?? []);
    for (const tag of tags) existing.add(tag);
    mergedRemoved[elem] = existing;
  }
  return { added: mergedAdded, removed: mergedRemoved };
}

// ─── CRDT Campaign Projection ─────────────────────────────────────────────────

/**
 * The CRDT-based mutable portion of a campaign projection.
 *
 * This struct holds only the fields that are safe to replicate with CRDT
 * merge semantics. Immutable / single-writer fields (status, targetAmount,
 * creatorId, endTime) are stored separately and not included here.
 */
export interface CRDTCampaignProjection {
  readonly campaignId: string;
  /** Total XLM pledged (PN-Counter allows refunds) */
  readonly pledgedAmount: PNCounter;
  /** Number of successful executions (G-Counter; only ever increments) */
  readonly executionCount: GCounter;
  /** Set of participant addresses (OR-Set; add/remove idempotent) */
  readonly participants: ORSet<string>;
}

export function crdtCampaignProjectionZero(campaignId: string): CRDTCampaignProjection {
  return {
    campaignId,
    pledgedAmount: pnCounterZero(),
    executionCount: gCounterZero(),
    participants: orSetEmpty<string>(),
  };
}

/**
 * Merge two CRDT campaign projections from different regions.
 *
 * This operation is commutative, idempotent, and associative.
 *
 * @example
 * ```ts
 * const merged = mergeCRDTCampaignProjections(regionA, regionB);
 * // merge(A, B) === merge(B, A)
 * ```
 */
export function mergeCRDTCampaignProjections(
  a: CRDTCampaignProjection,
  b: CRDTCampaignProjection
): CRDTCampaignProjection {
  if (a.campaignId !== b.campaignId) {
    throw new Error(
      `Cannot merge projections for different campaigns: ${a.campaignId} vs ${b.campaignId}`
    );
  }
  return {
    campaignId: a.campaignId,
    pledgedAmount: mergePNCounters(a.pledgedAmount, b.pledgedAmount),
    executionCount: mergeGCounters(a.executionCount, b.executionCount),
    participants: mergeORSets<string>(a.participants, b.participants),
  };
}

/**
 * Convenience: derive summary values from a CRDT projection.
 */
export function crdtProjectionSummary(p: CRDTCampaignProjection) {
  return {
    campaignId: p.campaignId,
    pledgedAmount: pnCounterValue(p.pledgedAmount),
    executionCount: gCounterValue(p.executionCount),
    participants: orSetElements(p.participants),
    participantCount: orSetElements(p.participants).length,
  };
}
