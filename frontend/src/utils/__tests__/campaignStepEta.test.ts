import { describe, it, expect } from 'vitest';
import { estimateNextStepEtaMs, formatEta } from '../campaignStepEta';
import type { BuybackStepModel } from '../../types/campaign';

function step(overrides: Partial<BuybackStepModel>): BuybackStepModel {
  return {
    id: 1,
    stepNumber: 0,
    amount: '1000',
    status: 'PENDING',
    ...overrides,
  };
}

describe('estimateNextStepEtaMs', () => {
  it('returns null with fewer than two completed steps', () => {
    const steps = [step({ status: 'COMPLETED', executedAt: '2026-01-01T00:00:00Z' })];
    expect(estimateNextStepEtaMs(steps)).toBeNull();
  });

  it('averages the gap between completed steps and projects from the last one', () => {
    const steps = [
      step({ stepNumber: 0, status: 'COMPLETED', executedAt: '2026-01-01T00:00:00Z' }),
      step({ stepNumber: 1, status: 'COMPLETED', executedAt: '2026-01-01T00:10:00Z' }),
      step({ stepNumber: 2, status: 'PENDING' }),
    ];

    // Last completion + 10 minute average gap is far in the past relative to
    // "now", so the ETA clamps to 0 rather than going negative.
    expect(estimateNextStepEtaMs(steps)).toBe(0);
  });

  it('ignores pending/failed steps when computing the average', () => {
    const steps = [
      step({ stepNumber: 0, status: 'COMPLETED', executedAt: '2026-01-01T00:00:00Z' }),
      step({ stepNumber: 1, status: 'FAILED', executedAt: '2026-01-01T00:05:00Z' }),
      step({ stepNumber: 2, status: 'COMPLETED', executedAt: '2026-01-01T00:10:00Z' }),
    ];

    expect(estimateNextStepEtaMs(steps)).toBe(0);
  });
});

describe('formatEta', () => {
  it('formats sub-minute durations', () => {
    expect(formatEta(10_000)).toBe('< 1m');
  });

  it('formats minute durations', () => {
    expect(formatEta(5 * 60_000)).toBe('~5m');
  });

  it('formats hour + minute durations', () => {
    expect(formatEta(65 * 60_000)).toBe('~1h 5m');
  });

  it('formats whole-hour durations without a minutes suffix', () => {
    expect(formatEta(120 * 60_000)).toBe('~2h');
  });
});
