import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
    isValidCampaignTitle,
    isValidCampaignDescription,
    isValidCampaignBudget,
    isValidCampaignDuration,
    isValidSlippage,
    validateCampaignForm,
    getFieldError,
    parseDurationToSeconds,
} from '../campaignValidation';
import type { CampaignFormData } from '../../types/campaign';

/**
 * Property-Based Boundary Tests for CampaignValidation
 *
 * Invariants under test (grounded in the real constraints in
 * campaignValidation.ts — title/description/budget/duration/slippage,
 * since this codebase's "campaign" is the title+budget+duration+slippage
 * form, not a buyback step schedule):
 *   1. Any form built from values inside the documented bounds always
 *      validates successfully.
 *   2. A budget at or below zero always fails validation.
 *   3. parseDurationToSeconds always rounds downward (floor), never up.
 *   4. Error messages returned for invalid fields are non-empty and
 *      human-readable; valid fields produce no error message.
 */

const validTitle = () =>
    fc
        .string({ minLength: 3, maxLength: 100, unit: fc.constantFrom(
            ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_.,!?()".split('')
        ) })
        .filter((s) => s.trim().length >= 3 && s.trim().length <= 100);

const validDescription = () =>
    fc.string({ minLength: 10, maxLength: 1000 }).filter((s) => s.trim().length >= 10);

const validBudget = () =>
    fc
        .integer({ min: 1, max: 1_000_000_000 })
        .map((n) => String(n));

const validDuration = () => fc.integer({ min: 3600, max: 31_536_000 });

const validSlippage = () =>
    fc.integer({ min: 0, max: 10_000 }).map((n) => Math.round(n) / 100);

function validFormData(): fc.Arbitrary<CampaignFormData> {
    return fc.record({
        title: validTitle(),
        description: validDescription(),
        budget: validBudget(),
        duration: validDuration(),
        slippage: validSlippage(),
    });
}

describe('Property: valid campaign params always pass validation', () => {
    it('any form built entirely from in-bounds generators validates successfully', () => {
        fc.assert(
            fc.property(validFormData(), (data) => {
                const result = validateCampaignForm(data);
                if (!result.valid) {
                    throw new Error(
                        `Expected valid form to pass, got errors: ${JSON.stringify(result.errors)} for data ${JSON.stringify(data)}`
                    );
                }
                expect(Object.keys(result.errors)).toHaveLength(0);
            }),
            { numRuns: 500 }
        );
    });

    it('each individual field validator accepts its own in-bounds generator', () => {
        fc.assert(
            fc.property(
                validTitle(),
                validDescription(),
                validBudget(),
                validDuration(),
                validSlippage(),
                (title, description, budget, duration, slippage) => {
                    expect(isValidCampaignTitle(title)).toBe(true);
                    expect(isValidCampaignDescription(description)).toBe(true);
                    expect(isValidCampaignBudget(budget)).toBe(true);
                    expect(isValidCampaignDuration(duration)).toBe(true);
                    expect(isValidSlippage(slippage)).toBe(true);
                }
            ),
            { numRuns: 500 }
        );
    });
});

describe('Property: zero or negative budget always fails', () => {
    it('a budget of zero is always invalid', () => {
        expect(isValidCampaignBudget('0')).toBe(false);
        expect(isValidCampaignBudget('0.0')).toBe(false);
        expect(isValidCampaignBudget('0.0000000')).toBe(false);
    });

    it('any non-positive budget value is always invalid', () => {
        fc.assert(
            fc.property(fc.integer({ min: -1_000_000, max: 0 }), (n) => {
                expect(isValidCampaignBudget(String(n))).toBe(false);
            }),
            { numRuns: 500 }
        );
    });
});

describe('Property: parseDurationToSeconds always rounds downward', () => {
    it('never produces a result greater than the exact (unfloored) value', () => {
        fc.assert(
            fc.property(
                fc.double({ min: 0.0001, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
                fc.constantFrom('hours', 'days', 'weeks'),
                (num, unit) => {
                    const multipliers = { hours: 3600, days: 86400, weeks: 604800 } as const;
                    const exact = num * multipliers[unit];
                    const result = parseDurationToSeconds(String(num), unit);

                    expect(Number.isInteger(result)).toBe(true);
                    expect(result).toBeLessThanOrEqual(exact);
                    expect(result).toBeGreaterThan(exact - 1);
                }
            ),
            { numRuns: 500 }
        );
    });

    it('zero or negative input always yields zero seconds', () => {
        fc.assert(
            fc.property(fc.double({ min: -1000, max: 0, noNaN: true }), fc.constantFrom('hours', 'days', 'weeks'), (num, unit) => {
                expect(parseDurationToSeconds(String(num), unit)).toBe(0);
            }),
            { numRuns: 200 }
        );
    });
});

describe('Property: error messages are human-readable for every failure mode', () => {
    it('getFieldError returns a non-empty message for out-of-bounds values, and empty for in-bounds ones', () => {
        fc.assert(
            fc.property(validTitle(), (title) => {
                expect(getFieldError('title', title)).toBe('');
            }),
            { numRuns: 100 }
        );

        fc.assert(
            fc.property(fc.string({ maxLength: 2 }), (shortTitle) => {
                const message = getFieldError('title', shortTitle);
                expect(message.length).toBeGreaterThan(0);
                expect(message).toContain('Title');
            }),
            { numRuns: 100 }
        );

        fc.assert(
            fc.property(fc.integer({ min: -1_000_000, max: 0 }), (negativeDuration) => {
                const message = getFieldError('duration', negativeDuration);
                expect(message.length).toBeGreaterThan(0);
                expect(message).toContain('Duration');
            }),
            { numRuns: 100 }
        );
    });
});

describe('Named boundary fixtures', () => {
    it('budget at exactly the minimum (1 XLM) is valid', () => {
        expect(isValidCampaignBudget('1')).toBe(true);
    });

    it('budget at exactly the maximum (1e9 XLM) is valid', () => {
        expect(isValidCampaignBudget('1000000000')).toBe(true);
    });

    it('budget one stroop above the maximum is invalid', () => {
        expect(isValidCampaignBudget('1000000000.0000001')).toBe(false);
    });

    it('duration at exactly the minimum (1 hour) is valid', () => {
        expect(isValidCampaignDuration(3600)).toBe(true);
    });

    it('duration at exactly the maximum (1 year) is valid', () => {
        expect(isValidCampaignDuration(31_536_000)).toBe(true);
    });

    it('duration of zero is invalid', () => {
        expect(isValidCampaignDuration(0)).toBe(false);
    });

    it('slippage of 0% and 100% are both valid (boundary inclusive)', () => {
        expect(isValidSlippage(0)).toBe(true);
        expect(isValidSlippage(100)).toBe(true);
    });

    it('slippage above 100% is invalid', () => {
        expect(isValidSlippage(100.01)).toBe(false);
    });

    it('regression: common decimal percentages are valid despite floating-point representation', () => {
        // isValidSlippage previously used `slippage % 0.01 === 0`, which is
        // unreliable for floats and rejected nearly every realistic value
        // (including 1, 50, and 100) due to floating-point rounding error.
        for (const value of [1, 2, 5, 50, 0.5, 0.07, 33.33, 100]) {
            expect(isValidSlippage(value)).toBe(true);
        }
    });

    it('slippage with more than 2 decimal places is invalid', () => {
        expect(isValidSlippage(12.345)).toBe(false);
    });

    it('a campaign with identical-looking start/end (zero duration) fails as zero duration, not silently passing', () => {
        const data: CampaignFormData = {
            title: 'Boundary Campaign',
            description: 'A description long enough to pass validation checks.',
            budget: '100',
            duration: 0,
            slippage: 1,
        };
        const result = validateCampaignForm(data);
        expect(result.valid).toBe(false);
        expect(result.errors.duration).toBeTruthy();
    });
});
