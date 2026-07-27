/**
 * Tests for CRDT-based multi-region active-active campaign projections (#1628)
 *
 * Covers:
 *   - PN-Counter arithmetic (pledge + refund)
 *   - G-Counter monotonicity
 *   - OR-Set add/remove idempotency
 *   - merge(A, B) === merge(B, A) — commutativity
 *   - merge(A, A) === A — idempotency
 *   - Convergence under randomised concurrent update sequences (fast-check)
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

import {
  // G-Counter
  gCounterZero,
  gCounterIncrement,
  gCounterValue,
  mergeGCounters,
  // PN-Counter
  pnCounterZero,
  pnCounterIncrement,
  pnCounterDecrement,
  pnCounterValue,
  mergePNCounters,
  // OR-Set
  orSetEmpty,
  orSetAdd,
  orSetRemove,
  orSetContains,
  orSetElements,
  mergeORSets,
  // Campaign CRDT
  crdtCampaignProjectionZero,
  mergeCRDTCampaignProjections,
  crdtProjectionSummary,
} from "../../lib/crdtCampaignProjection";

// ─── G-Counter tests ──────────────────────────────────────────────────────────

describe("G-Counter", () => {
  it("starts at zero", () => {
    expect(gCounterValue(gCounterZero())).toBe(0n);
  });

  it("increments per region", () => {
    let c = gCounterZero();
    c = gCounterIncrement(c, "us-east-1", 100n);
    c = gCounterIncrement(c, "eu-west-1", 200n);
    expect(gCounterValue(c)).toBe(300n);
  });

  it("merges by taking max per region", () => {
    let a = gCounterZero();
    a = gCounterIncrement(a, "r1", 50n);
    a = gCounterIncrement(a, "r2", 20n);

    let b = gCounterZero();
    b = gCounterIncrement(b, "r1", 30n); // lower than a
    b = gCounterIncrement(b, "r3", 80n); // new region

    const merged = mergeGCounters(a, b);
    // r1: max(50, 30) = 50; r2: 20; r3: 80 → total 150
    expect(gCounterValue(merged)).toBe(150n);
  });

  it("merge is commutative", () => {
    let a = gCounterZero();
    a = gCounterIncrement(a, "r1", 10n);
    let b = gCounterZero();
    b = gCounterIncrement(b, "r2", 20n);

    expect(gCounterValue(mergeGCounters(a, b))).toBe(
      gCounterValue(mergeGCounters(b, a))
    );
  });

  it("merge is idempotent", () => {
    let c = gCounterZero();
    c = gCounterIncrement(c, "r1", 7n);
    expect(gCounterValue(mergeGCounters(c, c))).toBe(gCounterValue(c));
  });
});

// ─── PN-Counter tests ─────────────────────────────────────────────────────────

describe("PN-Counter", () => {
  it("starts at zero", () => {
    expect(pnCounterValue(pnCounterZero())).toBe(0n);
  });

  it("supports increments and decrements", () => {
    let c = pnCounterZero();
    c = pnCounterIncrement(c, "r1", 1000n); // pledge
    c = pnCounterDecrement(c, "r1", 200n); // refund
    expect(pnCounterValue(c)).toBe(800n);
  });

  it("merge is commutative for pledges from two regions", () => {
    let a = pnCounterZero();
    a = pnCounterIncrement(a, "us-east-1", 500n);

    let b = pnCounterZero();
    b = pnCounterIncrement(b, "eu-west-1", 300n);

    const ab = mergePNCounters(a, b);
    const ba = mergePNCounters(b, a);
    expect(pnCounterValue(ab)).toBe(pnCounterValue(ba));
    expect(pnCounterValue(ab)).toBe(800n);
  });

  it("merge is idempotent", () => {
    let c = pnCounterZero();
    c = pnCounterIncrement(c, "r1", 100n);
    const merged = mergePNCounters(c, c);
    expect(pnCounterValue(merged)).toBe(pnCounterValue(c));
  });
});

// ─── OR-Set tests ─────────────────────────────────────────────────────────────

describe("OR-Set", () => {
  it("starts empty", () => {
    const s = orSetEmpty<string>();
    expect(orSetElements(s)).toHaveLength(0);
  });

  it("add and contains", () => {
    let s = orSetEmpty<string>();
    s = orSetAdd(s, "alice", "tag-1");
    expect(orSetContains(s, "alice")).toBe(true);
    expect(orSetContains(s, "bob")).toBe(false);
  });

  it("remove clears all tags for an element", () => {
    let s = orSetEmpty<string>();
    s = orSetAdd(s, "alice", "tag-1");
    s = orSetAdd(s, "alice", "tag-2");
    s = orSetRemove(s, "alice");
    expect(orSetContains(s, "alice")).toBe(false);
  });

  it("concurrent add on two regions survives merge (add-wins)", () => {
    // Region A removes alice; Region B concurrently adds alice with new tag
    let a = orSetEmpty<string>();
    a = orSetAdd(a, "alice", "tag-a");

    let b = orSetAdd(a, "alice", "tag-b"); // based on same state as a
    a = orSetRemove(a, "alice"); // region A removes

    const merged = mergeORSets<string>(a, b);
    // Region B's add with "tag-b" is not in a's removed set → alice survives
    expect(orSetContains(merged, "alice")).toBe(true);
  });

  it("merge is commutative", () => {
    let a = orSetEmpty<string>();
    a = orSetAdd(a, "alice", "t1");
    let b = orSetEmpty<string>();
    b = orSetAdd(b, "bob", "t2");

    const ab = mergeORSets<string>(a, b);
    const ba = mergeORSets<string>(b, a);
    expect(orSetElements(ab).sort()).toEqual(orSetElements(ba).sort());
  });

  it("merge is idempotent", () => {
    let s = orSetEmpty<string>();
    s = orSetAdd(s, "alice", "t1");
    const merged = mergeORSets<string>(s, s);
    expect(orSetElements(merged)).toEqual(orSetElements(s));
  });
});

// ─── CRDTCampaignProjection tests ─────────────────────────────────────────────

describe("CRDTCampaignProjection", () => {
  it("zero projection is empty", () => {
    const p = crdtCampaignProjectionZero("campaign-1");
    const s = crdtProjectionSummary(p);
    expect(s.pledgedAmount).toBe(0n);
    expect(s.executionCount).toBe(0n);
    expect(s.participants).toHaveLength(0);
  });

  it("merging two regions' projections converges to combined state", () => {
    let regionA = crdtCampaignProjectionZero("c1");
    regionA = {
      ...regionA,
      pledgedAmount: pnCounterIncrement(regionA.pledgedAmount, "us-east-1", 1000n),
      executionCount: gCounterIncrement(regionA.executionCount, "us-east-1", 3n),
      participants: orSetAdd(regionA.participants, "alice", "tag-a1"),
    };

    let regionB = crdtCampaignProjectionZero("c1");
    regionB = {
      ...regionB,
      pledgedAmount: pnCounterIncrement(regionB.pledgedAmount, "eu-west-1", 500n),
      executionCount: gCounterIncrement(regionB.executionCount, "eu-west-1", 2n),
      participants: orSetAdd(regionB.participants, "bob", "tag-b1"),
    };

    const merged = mergeCRDTCampaignProjections(regionA, regionB);
    const summary = crdtProjectionSummary(merged);

    expect(summary.pledgedAmount).toBe(1500n);
    expect(summary.executionCount).toBe(5n);
    expect(summary.participants.sort()).toEqual(["alice", "bob"]);
  });

  it("merge(A, B) === merge(B, A) — commutativity", () => {
    let a = crdtCampaignProjectionZero("c2");
    a = {
      ...a,
      pledgedAmount: pnCounterIncrement(a.pledgedAmount, "r1", 100n),
      executionCount: gCounterIncrement(a.executionCount, "r1", 1n),
      participants: orSetAdd(a.participants, "charlie", "t1"),
    };

    let b = crdtCampaignProjectionZero("c2");
    b = {
      ...b,
      pledgedAmount: pnCounterIncrement(b.pledgedAmount, "r2", 200n),
      executionCount: gCounterIncrement(b.executionCount, "r2", 4n),
      participants: orSetAdd(b.participants, "diana", "t2"),
    };

    const ab = crdtProjectionSummary(mergeCRDTCampaignProjections(a, b));
    const ba = crdtProjectionSummary(mergeCRDTCampaignProjections(b, a));

    expect(ab.pledgedAmount).toBe(ba.pledgedAmount);
    expect(ab.executionCount).toBe(ba.executionCount);
    expect(ab.participants.sort()).toEqual(ba.participants.sort());
  });

  it("throws when merging projections with different campaign IDs", () => {
    const a = crdtCampaignProjectionZero("c1");
    const b = crdtCampaignProjectionZero("c2");
    expect(() => mergeCRDTCampaignProjections(a, b)).toThrow();
  });
});

// ─── Property-based tests (fast-check) ───────────────────────────────────────

describe("CRDT properties (fast-check)", () => {
  // Property 1: PN-Counter merge commutativity
  it("PN-Counter merge(A, B) === merge(B, A) for any increments", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000n }),
        fc.bigInt({ min: 0n, max: 10_000n }),
        (incA, incB) => {
          let a = pnCounterZero();
          a = pnCounterIncrement(a, "r1", incA);
          let b = pnCounterZero();
          b = pnCounterIncrement(b, "r2", incB);

          const ab = pnCounterValue(mergePNCounters(a, b));
          const ba = pnCounterValue(mergePNCounters(b, a));
          return ab === ba;
        }
      )
    );
  });

  // Property 2: G-Counter merge convergence under random update sequences
  it("G-Counter converges regardless of merge order", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.string({ minLength: 1, maxLength: 5 }), fc.bigInt({ min: 0n, max: 1_000n })), { minLength: 1, maxLength: 20 }),
        (updates) => {
          let a = gCounterZero();
          let b = gCounterZero();

          // Apply first half to A, second half to B
          const mid = Math.floor(updates.length / 2);
          for (let i = 0; i < mid; i++) {
            const [region, delta] = updates[i]!;
            a = gCounterIncrement(a, region, delta);
          }
          for (let i = mid; i < updates.length; i++) {
            const [region, delta] = updates[i]!;
            b = gCounterIncrement(b, region, delta);
          }

          const ab = mergeGCounters(a, b);
          const ba = mergeGCounters(b, a);
          return gCounterValue(ab) === gCounterValue(ba);
        }
      )
    );
  });

  // Property 3: OR-Set merge commutativity
  it("OR-Set merge(A, B) === merge(B, A) for random add/remove sequences", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.constantFrom("add" as const, "remove" as const),
            fc.string({ minLength: 1, maxLength: 8 }),
            fc.uuid()
          ),
          { minLength: 0, maxLength: 20 }
        ),
        fc.array(
          fc.tuple(
            fc.constantFrom("add" as const, "remove" as const),
            fc.string({ minLength: 1, maxLength: 8 }),
            fc.uuid()
          ),
          { minLength: 0, maxLength: 20 }
        ),
        (opsA, opsB) => {
          let a = orSetEmpty<string>();
          for (const [op, elem, tag] of opsA) {
            a = op === "add" ? orSetAdd(a, elem, tag) : orSetRemove(a, elem);
          }
          let b = orSetEmpty<string>();
          for (const [op, elem, tag] of opsB) {
            b = op === "add" ? orSetAdd(b, elem, tag) : orSetRemove(b, elem);
          }

          const ab = orSetElements(mergeORSets<string>(a, b)).sort();
          const ba = orSetElements(mergeORSets<string>(b, a)).sort();
          return JSON.stringify(ab) === JSON.stringify(ba);
        }
      )
    );
  });

  // Property 4: CRDTCampaignProjection convergence
  it("mergeCRDTCampaignProjections converges for random concurrent updates", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 100_000n }),
        fc.bigInt({ min: 0n, max: 100_000n }),
        fc.nat({ max: 50 }),
        fc.nat({ max: 50 }),
        (pledgeA, pledgeB, execA, execB) => {
          let a = crdtCampaignProjectionZero("c-prop");
          a = {
            ...a,
            pledgedAmount: pnCounterIncrement(a.pledgedAmount, "r1", pledgeA),
            executionCount: gCounterIncrement(a.executionCount, "r1", BigInt(execA)),
          };

          let b = crdtCampaignProjectionZero("c-prop");
          b = {
            ...b,
            pledgedAmount: pnCounterIncrement(b.pledgedAmount, "r2", pledgeB),
            executionCount: gCounterIncrement(b.executionCount, "r2", BigInt(execB)),
          };

          const ab = crdtProjectionSummary(mergeCRDTCampaignProjections(a, b));
          const ba = crdtProjectionSummary(mergeCRDTCampaignProjections(b, a));

          return ab.pledgedAmount === ba.pledgedAmount && ab.executionCount === ba.executionCount;
        }
      )
    );
  });
});
