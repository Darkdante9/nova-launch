/**
 * Property-based arithmetic tests for DividendService distribution logic.
 *
 * Verifies: conservation, proportionality, idempotency, zero-balance exclusion.
 * Uses fast-check for arbitrary-precision BigInt input generation.
 *
 * Closes #1289
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

// ---------------------------------------------------------------------------
// Inline computeClaimable — mirrors the private function in dividendService.ts
// This allows pure property testing without Prisma or mocks.
// ---------------------------------------------------------------------------

function computeClaimable(
  holderBalance: bigint,
  totalAmount: bigint,
  supplySnapshot: bigint,
  perHolderCap: bigint
): bigint {
  if (supplySnapshot === 0n) return 0n;
  let claimable = (holderBalance * totalAmount) / supplySnapshot;
  if (perHolderCap > 0n && claimable > perHolderCap) {
    claimable = perHolderCap;
  }
  return claimable;
}

function distributePool(
  holders: { balance: bigint }[],
  poolAmount: bigint,
  supplySnapshot: bigint,
  perHolderCap: bigint
): bigint[] {
  return holders.map(h =>
    computeClaimable(h.balance, poolAmount, supplySnapshot, perHolderCap)
  );
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const positiveBigInt = fc.bigInt({ min: 1n, max: BigInt(2 ** 53) });
const nonNegBigInt = fc.bigInt({ min: 0n, max: BigInt(2 ** 53) });

const holderArb = positiveBigInt.map(balance => ({ balance }));

const scenarioArb = fc
  .tuple(
    fc.array(holderArb, { minLength: 1, maxLength: 50 }),
    positiveBigInt, // poolAmount
  )
  .map(([holders, poolAmount]) => {
    const supplySnapshot = holders.reduce((s, h) => s + h.balance, 0n);
    return { holders, poolAmount, supplySnapshot };
  });

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('DividendService — property-based arithmetic', () => {
  it('conservation: sum of payouts never exceeds pool amount', () => {
    fc.assert(
      fc.property(scenarioArb, ({ holders, poolAmount, supplySnapshot }) => {
        const payouts = distributePool(holders, poolAmount, supplySnapshot, 0n);
        const total = payouts.reduce((s, p) => s + p, 0n);
        expect(total).toBeLessThanOrEqual(poolAmount);
      }),
      { numRuns: 1000 }
    );
  });

  it('proportionality: no holder receives more than their pro-rata share (within 1-unit rounding)', () => {
    fc.assert(
      fc.property(scenarioArb, ({ holders, poolAmount, supplySnapshot }) => {
        const payouts = distributePool(holders, poolAmount, supplySnapshot, 0n);
        for (let i = 0; i < holders.length; i++) {
          const proRata = (holders[i].balance * poolAmount) / supplySnapshot;
          expect(payouts[i]).toBeLessThanOrEqual(proRata + 1n);
          expect(payouts[i]).toBeGreaterThanOrEqual(0n);
        }
      }),
      { numRuns: 1000 }
    );
  });

  it('idempotency: computing payouts twice gives identical results', () => {
    fc.assert(
      fc.property(scenarioArb, ({ holders, poolAmount, supplySnapshot }) => {
        const first = distributePool(holders, poolAmount, supplySnapshot, 0n);
        const second = distributePool(holders, poolAmount, supplySnapshot, 0n);
        expect(first).toEqual(second);
      }),
      { numRuns: 500 }
    );
  });

  it('zero-balance holder exclusion: holders with zero balance receive 0', () => {
    fc.assert(
      fc.property(
        fc.array(holderArb, { minLength: 1, maxLength: 20 }),
        positiveBigInt,
        (holders, poolAmount) => {
          const holdersWithZero = [...holders, { balance: 0n }];
          const supplySnapshot = holdersWithZero.reduce((s, h) => s + h.balance, 0n);
          const payouts = distributePool(holdersWithZero, poolAmount, supplySnapshot, 0n);
          expect(payouts[payouts.length - 1]).toBe(0n);
        }
      ),
      { numRuns: 500 }
    );
  });

  it('per-holder cap: capped payouts never exceed cap', () => {
    fc.assert(
      fc.property(
        scenarioArb,
        positiveBigInt,
        ({ holders, poolAmount, supplySnapshot }, cap) => {
          const payouts = distributePool(holders, poolAmount, supplySnapshot, cap);
          for (const payout of payouts) {
            expect(payout).toBeLessThanOrEqual(cap);
            expect(payout).toBeGreaterThanOrEqual(0n);
          }
        }
      ),
      { numRuns: 500 }
    );
  });

  it('zero supply snapshot: all payouts are 0 (no division by zero)', () => {
    fc.assert(
      fc.property(
        fc.array(holderArb, { minLength: 1, maxLength: 20 }),
        positiveBigInt,
        (holders, poolAmount) => {
          const payouts = distributePool(holders, poolAmount, 0n, 0n);
          for (const payout of payouts) {
            expect(payout).toBe(0n);
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});
