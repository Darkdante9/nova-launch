/**
 * Property-based tests for burnValidation BigInt overflow/underflow scenarios.
 *
 * Uses fast-check with fc.bigInt generators to assert four core properties:
 *  1. burn > supply   → always rejected
 *  2. zero amount     → always rejected
 *  3. burn = supply   → accepted (full burn)
 *  4. negative amount → always rejected
 *
 * Also includes explicit edge-case fixtures for boundary values.
 *
 * Run: npx vitest run src/utils/__tests__/burnValidation.property.test.ts
 *
 * Closes #1302
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

// ---------------------------------------------------------------------------
// The functions under test work with numeric strings (the existing API).
// We convert BigInt test values to string to feed them in.
// ---------------------------------------------------------------------------
import {
  validateBurnAmount,
  isValidBurnAmount,
} from '../burnValidation';

// ---------------------------------------------------------------------------
// Valid address stubs (required by validateBurnAmount)
// ---------------------------------------------------------------------------
const USER_ADDRESS = `G${'A'.repeat(55)}`;
const TOKEN_ADDRESS = `C${'A'.repeat(55)}`;

function makeParams(amount: string, balance: string) {
  return {
    amount,
    balance,
    decimals: 7,
    userAddress: USER_ADDRESS,
    tokenAddress: TOKEN_ADDRESS,
  };
}

// ---------------------------------------------------------------------------
// BigInt arbitrary helpers
// ---------------------------------------------------------------------------

// Positive supply in range [1, 2^63-1] — avoids floats losing precision
const positiveSupply = () =>
  fc.bigInt({ min: 1n, max: 9_223_372_036_854_775_807n });

// Amount strictly greater than supply
const amountExceedingSupply = (supply: bigint) =>
  fc.bigInt({ min: supply + 1n, max: supply * 2n + 1n });

// Amount in range [1, supply]
const validBurnAmount = (supply: bigint) =>
  fc.bigInt({ min: 1n, max: supply });

// ---------------------------------------------------------------------------
// Property 1: burn amount > supply → always rejected
// ---------------------------------------------------------------------------
describe('burnValidation property tests (#1302)', () => {
  it('P1: amount > supply is always rejected', () => {
    fc.assert(
      fc.property(
        positiveSupply().chain((supply) =>
          amountExceedingSupply(supply).map((amount) => ({ supply, amount }))
        ),
        ({ supply, amount }) => {
          const result = validateBurnAmount(
            makeParams(amount.toString(), supply.toString())
          );
          expect(result.valid).toBe(false);
          expect(result.errors.amount).toBeTruthy();
        }
      ),
      { numRuns: 500 }
    );
  });

  // ---------------------------------------------------------------------------
  // Property 2: zero amount → always rejected
  // ---------------------------------------------------------------------------
  it('P2: zero amount is always rejected regardless of supply', () => {
    fc.assert(
      fc.property(positiveSupply(), (supply) => {
        const result = validateBurnAmount(makeParams('0', supply.toString()));
        expect(result.valid).toBe(false);
        expect(result.errors.amount).toBeTruthy();
        expect(result.errors.amount).toMatch(/greater than zero/i);
      }),
      { numRuns: 500 }
    );
  });

  // ---------------------------------------------------------------------------
  // Property 3: amount = supply → accepted (full burn is valid)
  // ---------------------------------------------------------------------------
  it('P3: amount equal to supply is accepted (full burn)', () => {
    fc.assert(
      fc.property(positiveSupply(), (supply) => {
        const result = validateBurnAmount(
          makeParams(supply.toString(), supply.toString())
        );
        // Only amount/address errors matter — a full burn should be valid
        expect(result.errors.amount).toBeUndefined();
      }),
      { numRuns: 500 }
    );
  });

  // ---------------------------------------------------------------------------
  // Property 4: negative amount → always rejected
  // ---------------------------------------------------------------------------
  it('P4: negative amount is always rejected', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -9_223_372_036_854_775_807n, max: -1n }),
        positiveSupply(),
        (negativeAmount, supply) => {
          const result = validateBurnAmount(
            makeParams(negativeAmount.toString(), supply.toString())
          );
          expect(result.valid).toBe(false);
          expect(result.errors.amount).toBeTruthy();
        }
      ),
      { numRuns: 500 }
    );
  });

  // ---------------------------------------------------------------------------
  // Property 5 (bonus): valid [1, supply] amounts produce human-readable errors
  //   for OTHER fields (address) but no amount error
  // ---------------------------------------------------------------------------
  it('P5: any amount in [1, supply] produces no amount validation error', () => {
    fc.assert(
      fc.property(
        positiveSupply().chain((supply) =>
          validBurnAmount(supply).map((amount) => ({ supply, amount }))
        ),
        ({ supply, amount }) => {
          const params = makeParams(amount.toString(), supply.toString());
          const result = validateBurnAmount(params);
          expect(result.errors.amount).toBeUndefined();
        }
      ),
      { numRuns: 500 }
    );
  });

  // ---------------------------------------------------------------------------
  // Explicit edge-case fixtures
  // ---------------------------------------------------------------------------
  describe('edge-case fixtures', () => {
    const SUPPLY = '1000000';

    it('BigInt(0) is rejected with a human-readable message', () => {
      const result = validateBurnAmount(makeParams('0', SUPPLY));
      expect(result.valid).toBe(false);
      expect(result.errors.amount).toMatch(/greater than zero/i);
    });

    it('BigInt(-1) is rejected with a human-readable message', () => {
      const result = validateBurnAmount(makeParams('-1', SUPPLY));
      expect(result.valid).toBe(false);
      expect(result.errors.amount).toBeTruthy();
    });

    it('supply + BigInt(1) is rejected with an insufficient-balance message', () => {
      const overAmount = (BigInt(SUPPLY) + 1n).toString();
      const result = validateBurnAmount(makeParams(overAmount, SUPPLY));
      expect(result.valid).toBe(false);
      expect(result.errors.amount).toMatch(/insufficient balance/i);
    });

    it('near Number.MAX_SAFE_INTEGER: amount === supply is accepted', () => {
      const near = BigInt(Number.MAX_SAFE_INTEGER).toString();
      const result = validateBurnAmount(makeParams(near, near));
      expect(result.errors.amount).toBeUndefined();
    });

    it('near Number.MAX_SAFE_INTEGER: amount > supply is rejected', () => {
      const supply = BigInt(Number.MAX_SAFE_INTEGER);
      const over = (supply + 1n).toString();
      const result = validateBurnAmount(makeParams(over, supply.toString()));
      expect(result.valid).toBe(false);
      expect(result.errors.amount).toMatch(/insufficient balance/i);
    });

    it('amount = supply = 1 is the smallest valid full burn', () => {
      const result = validateBurnAmount(makeParams('1', '1'));
      expect(result.errors.amount).toBeUndefined();
    });

    it('empty string amount is rejected', () => {
      const result = validateBurnAmount(makeParams('', SUPPLY));
      expect(result.valid).toBe(false);
      expect(result.errors.amount).toBeTruthy();
    });
  });

  // ---------------------------------------------------------------------------
  // isValidBurnAmount: quick helper parity checks
  // ---------------------------------------------------------------------------
  describe('isValidBurnAmount parity', () => {
    it('returns false for zero amount', () => {
      expect(isValidBurnAmount('0', '1000')).toBe(false);
    });

    it('returns false for negative amount', () => {
      expect(isValidBurnAmount('-1', '1000')).toBe(false);
    });

    it('returns false when amount exceeds balance', () => {
      expect(isValidBurnAmount('1001', '1000')).toBe(false);
    });

    it('returns true for amount equal to balance', () => {
      expect(isValidBurnAmount('1000', '1000')).toBe(true);
    });

    it('returns true for a valid partial amount', () => {
      expect(isValidBurnAmount('500', '1000')).toBe(true);
    });
  });
});
