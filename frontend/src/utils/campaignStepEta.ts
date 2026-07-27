import type { BuybackStepModel } from '../types/campaign';

/**
 * Estimate the time until the next step executes, based on the average gap
 * between this campaign's already-completed steps. Returns null when there
 * are fewer than two completed steps to derive an average from.
 */
export function estimateNextStepEtaMs(steps: BuybackStepModel[]): number | null {
  const executedAtTimes = steps
    .filter((step) => step.status === 'COMPLETED' && step.executedAt)
    .map((step) => new Date(step.executedAt as string).getTime())
    .sort((a, b) => a - b);

  if (executedAtTimes.length < 2) return null;

  const gaps: number[] = [];
  for (let i = 1; i < executedAtTimes.length; i++) {
    gaps.push(executedAtTimes[i] - executedAtTimes[i - 1]);
  }

  const averageGapMs = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
  const lastExecutedAt = executedAtTimes[executedAtTimes.length - 1];
  const etaMs = lastExecutedAt + averageGapMs - Date.now();

  return Math.max(0, etaMs);
}

/** Format a millisecond duration as a short human-readable string (e.g. "~12m", "~1h 5m"). */
export function formatEta(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 1) return '< 1m';
  if (totalMinutes < 60) return `~${totalMinutes}m`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `~${hours}h ${minutes}m` : `~${hours}h`;
}
