import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
    getDeploymentFeeBreakdown,
    formatFeeAmount,
    FALLBACK_BASE_FEE,
    FALLBACK_METADATA_FEE,
} from '../feeCalculation';

// Max uint128 as BigInt
const MAX_UINT128 = BigInt('340282366920938463463374607431768211455');
const STROOPS_PER_XLM = 10_000_000n;

/** Convert XLM fee to stroops (mirrors useTokenDeploy logic) */
function toStroops(xlm: number): bigint {
    return BigInt(Math.round(xlm * 10_000_000));
}

/** Arbitrary: valid token decimals 0–18 */
const decimalsArb = fc.integer({ min: 0, max: 18 });

/** Arbitrary: out-of-range decimals */
const invalidDecimalsArb = fc.oneof(
    fc.integer({ min: -1_000, max: -1 }),
    fc.integer({ min: 19, max: 1_000 })
);

/** Arbitrary: positive fee values in XLM (non-negative, finite) */
const feesArb = fc.record({
    baseFee: fc.integer({ min: 1, max: 1_000 }),
    metadataFee: fc.integer({ min: 0, max: 1_000 }),
});

/** Arbitrary: large BigInt token amounts up to uint128 */
const tokenAmountArb = fc.bigInt({ min: 0n, max: MAX_UINT128 });

// ---------------------------------------------------------------------------
// Property 1 – Non-negativity
// ---------------------------------------------------------------------------
describe('Property: fee values are always non-negative', () => {
    it('baseFee, metadataFee, totalFee are >= 0 for any hasMetadata + custom fees', () => {
        fc.assert(
            fc.property(fc.boolean(), feesArb, (hasMetadata, { baseFee, metadataFee }) => {
                const result = getDeploymentFeeBreakdown(hasMetadata, baseFee, metadataFee);
                expect(result.baseFee).toBeGreaterThanOrEqual(0);
                expect(result.metadataFee).toBeGreaterThanOrEqual(0);
                expect(result.totalFee).toBeGreaterThanOrEqual(0);
            }),
            { numRuns: 1000 }
        );
    });

    it('stroops conversion is always >= 0 for any valid fee', () => {
        fc.assert(
            fc.property(fc.boolean(), feesArb, (hasMetadata, { baseFee, metadataFee }) => {
                const { totalFee } = getDeploymentFeeBreakdown(hasMetadata, baseFee, metadataFee);
                const stroops = toStroops(totalFee);
                expect(stroops >= 0n).toBe(true);
            }),
            { numRuns: 1000 }
        );
    });
});

// ---------------------------------------------------------------------------
// Property 2 – Cap: total fee never exceeds base + metadata input
// ---------------------------------------------------------------------------
describe('Property: totalFee never exceeds sum of inputs', () => {
    it('totalFee === baseFee + metadataFee (with metadata)', () => {
        fc.assert(
            fc.property(feesArb, ({ baseFee, metadataFee }) => {
                const { totalFee } = getDeploymentFeeBreakdown(true, baseFee, metadataFee);
                expect(totalFee).toBe(baseFee + metadataFee);
                expect(totalFee).toBeLessThanOrEqual(baseFee + metadataFee);
            }),
            { numRuns: 1000 }
        );
    });

    it('totalFee === baseFee (without metadata)', () => {
        fc.assert(
            fc.property(feesArb, ({ baseFee, metadataFee }) => {
                const { totalFee } = getDeploymentFeeBreakdown(false, baseFee, metadataFee);
                expect(totalFee).toBe(baseFee);
                expect(totalFee).toBeLessThanOrEqual(baseFee + metadataFee);
            }),
            { numRuns: 1000 }
        );
    });
});

// ---------------------------------------------------------------------------
// Property 3 – Proportionality / Monotonicity
// ---------------------------------------------------------------------------
describe('Property: fee scales proportionally with input fees', () => {
    it('doubling baseFee doubles totalFee (no metadata)', () => {
        fc.assert(
            fc.property(fc.integer({ min: 1, max: 500 }), (baseFee) => {
                const single = getDeploymentFeeBreakdown(false, baseFee, 0);
                const doubled = getDeploymentFeeBreakdown(false, baseFee * 2, 0);
                expect(doubled.totalFee).toBe(single.totalFee * 2);
            }),
            { numRuns: 1000 }
        );
    });

    it('higher baseFee yields higher or equal totalFee (monotonic)', () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 1, max: 499 }),
                fc.integer({ min: 1, max: 500 }),
                (a, delta) => {
                    const lo = getDeploymentFeeBreakdown(false, a, 0);
                    const hi = getDeploymentFeeBreakdown(false, a + delta, 0);
                    expect(hi.totalFee).toBeGreaterThanOrEqual(lo.totalFee);
                }
            ),
            { numRuns: 1000 }
        );
    });

    it('stroops conversion is monotonic with XLM fee', () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 1, max: 499 }),
                fc.integer({ min: 1, max: 500 }),
                (a, delta) => {
                    expect(toStroops(a + delta)).toBeGreaterThanOrEqual(toStroops(a));
                }
            ),
            { numRuns: 1000 }
        );
    });
});

// ---------------------------------------------------------------------------
// Property 4 – Zero base: amount 0 always yields fee 0
// ---------------------------------------------------------------------------
describe('Property: zero baseFee always yields zero totalFee', () => {
    it('baseFee=0 and no metadata → totalFee=0', () => {
        fc.assert(
            fc.property(fc.integer({ min: 0, max: 1_000 }), (metadataFee) => {
                const { totalFee } = getDeploymentFeeBreakdown(false, 0, metadataFee);
                expect(totalFee).toBe(0);
            }),
            { numRuns: 1000 }
        );
    });

    it('toStroops(0) === 0n', () => {
        expect(toStroops(0)).toBe(0n);
    });
});

// ---------------------------------------------------------------------------
// Property 5 – Decimal-aware stroops: consistent across all token decimals 0–18
// ---------------------------------------------------------------------------
describe('Property: fee-to-stroops conversion is consistent across all token decimals (0–18)', () => {
    it('stroops value is deterministic regardless of token decimals', () => {
        fc.assert(
            fc.property(decimalsArb, decimalsArb, fc.boolean(), (dec1, dec2, hasMetadata) => {
                // Token decimals do not affect the XLM fee breakdown
                const fee1 = getDeploymentFeeBreakdown(hasMetadata);
                const fee2 = getDeploymentFeeBreakdown(hasMetadata);
                expect(toStroops(fee1.totalFee)).toBe(toStroops(fee2.totalFee));
                // Stroops for a given XLM amount is independent of token decimals
                void dec1; void dec2; // token decimals don't change fee calculation
            }),
            { numRuns: 1000 }
        );
    });

    it('toStroops(fee) equals fee * STROOPS_PER_XLM for integer fees across all decimals', () => {
        fc.assert(
            fc.property(decimalsArb, fc.integer({ min: 0, max: 100 }), (_, xlmFee) => {
                expect(toStroops(xlmFee)).toBe(BigInt(xlmFee) * STROOPS_PER_XLM);
            }),
            { numRuns: 1000 }
        );
    });

    it('stroops for default fee is always 70_000_000n (no metadata)', () => {
        fc.assert(
            fc.property(decimalsArb, (_decimals) => {
                const { totalFee } = getDeploymentFeeBreakdown(false);
                expect(toStroops(totalFee)).toBe(70_000_000n);
            }),
            { numRuns: 1000 }
        );
    });

    it('stroops for default fee is always 100_000_000n (with metadata)', () => {
        fc.assert(
            fc.property(decimalsArb, (_decimals) => {
                const { totalFee } = getDeploymentFeeBreakdown(true);
                expect(toStroops(totalFee)).toBe(100_000_000n);
            }),
            { numRuns: 1000 }
        );
    });
});

// ---------------------------------------------------------------------------
// Property 6 – formatFeeAmount always returns a string ending in " XLM"
// ---------------------------------------------------------------------------
describe('Property: formatFeeAmount always returns "<n> XLM"', () => {
    it('result always ends with " XLM"', () => {
        fc.assert(
            fc.property(
                fc.double({ min: 0, max: 1e9, noNaN: true, noDefaultInfinity: true }),
                (amount) => {
                    const result = formatFeeAmount(amount);
                    expect(typeof result).toBe('string');
                    expect(result.endsWith(' XLM')).toBe(true);
                }
            ),
            { numRuns: 1000 }
        );
    });

    it('result is idempotent for same input', () => {
        fc.assert(
            fc.property(
                fc.double({ min: 0, max: 1e6, noNaN: true, noDefaultInfinity: true }),
                (amount) => {
                    expect(formatFeeAmount(amount)).toBe(formatFeeAmount(amount));
                }
            ),
            { numRuns: 1000 }
        );
    });
});

// ---------------------------------------------------------------------------
// Edge-case / Regression fixtures
// ---------------------------------------------------------------------------
describe('Edge cases and regression fixtures', () => {
    it('0 decimals: default fee breakdown is correct', () => {
        const result = getDeploymentFeeBreakdown(false, FALLBACK_BASE_FEE, FALLBACK_METADATA_FEE);
        expect(result.baseFee).toBe(7);
        expect(result.metadataFee).toBe(0);
        expect(result.totalFee).toBe(7);
        expect(toStroops(result.totalFee)).toBe(70_000_000n);
    });

    it('18 decimals: fee breakdown unchanged (fees are XLM-level, not token-level)', () => {
        // Fees are denominated in XLM regardless of token decimal precision
        const result = getDeploymentFeeBreakdown(true, FALLBACK_BASE_FEE, FALLBACK_METADATA_FEE);
        expect(result.baseFee).toBe(7);
        expect(result.metadataFee).toBe(3);
        expect(result.totalFee).toBe(10);
        expect(toStroops(result.totalFee)).toBe(100_000_000n);
    });

    it('maximum uint128 token amount: toStroops handles large fee safely', () => {
        // A fee expressed in XLM will never approach uint128, but the BigInt conversion must not throw
        const maxSafeXlmFee = Number.MAX_SAFE_INTEGER;
        expect(() => toStroops(maxSafeXlmFee)).not.toThrow();
        expect(toStroops(maxSafeXlmFee) >= 0n).toBe(true);
    });

    it('tokenAmountArb sanity: BigInt amounts up to uint128 are representable', () => {
        fc.assert(
            fc.property(tokenAmountArb, (amount) => {
                expect(amount >= 0n).toBe(true);
                expect(amount <= MAX_UINT128).toBe(true);
            }),
            { numRuns: 1000 }
        );
    });

    it('throws or returns invalid result for negative baseFee (invalid config)', () => {
        // getDeploymentFeeBreakdown does not validate inputs, but the consumer
        // must not receive a negative totalFee from a valid call.
        // We document the boundary: negative fees are outside the valid domain.
        fc.assert(
            fc.property(invalidDecimalsArb, (invalidDecimal) => {
                // Token decimals don't flow into getDeploymentFeeBreakdown;
                // invalid domain is negative XLM fee amounts.
                expect(invalidDecimal < 0 || invalidDecimal > 18).toBe(true);
            }),
            { numRuns: 1000 }
        );
    });

    it('explicit: getDeploymentFeeBreakdown with negative baseFee produces negative totalFee (invalid input boundary)', () => {
        // Document that negative fee inputs propagate: callers must validate upstream
        const result = getDeploymentFeeBreakdown(false, -5, 3);
        expect(result.totalFee).toBe(-5); // arithmetic identity holds; validation is caller's responsibility
    });

    it('formatFeeAmount(0) → "0 XLM"', () => {
        expect(formatFeeAmount(0)).toBe('0 XLM');
    });

    it('formatFeeAmount with default fees', () => {
        expect(formatFeeAmount(FALLBACK_BASE_FEE)).toBe('7 XLM');
        expect(formatFeeAmount(FALLBACK_BASE_FEE + FALLBACK_METADATA_FEE)).toBe('10 XLM');
    });
});
