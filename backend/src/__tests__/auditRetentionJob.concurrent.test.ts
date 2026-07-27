/**
 * AuditRetentionJob: Boundary & Concurrent-Write Coverage
 *
 * `runAuditRetention(retentionDays)` computes `cutoff = now - retentionDays`
 * and purges every audit log with `timestamp < cutoff`. The single most
 * dangerous mutation here is flipping `<` to `<=` (or the mirrored `>=` to
 * `>` inside `Database.purgeAuditLogs`), which would delete records sitting
 * exactly ON the retention boundary one period too early.
 *
 * This suite:
 *   1. Pins down the three boundary cases directly (1ms before cutoff is
 *      purged, exactly-at-cutoff is kept, 1ms after cutoff is kept) using
 *      fake system time for precise control over "now" vs. record timestamps.
 *   2. Simulates concurrent writers racing against a single retention run
 *      and asserts none of their freshly-written records are deleted.
 *
 * SEVERITY: HIGH — silent data loss with no test coverage previously.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Database } from "../config/database";
import { runAuditRetention } from "../services/auditRetentionJob";
import { MetricsCollector } from "../lib/metrics";

const DAY_MS = 24 * 60 * 60 * 1000;

function baseLogPayload() {
  return {
    adminId: "admin-1",
    action: "test_action",
    resource: "token",
    resourceId: "res-1",
    beforeState: null,
    afterState: null,
    ipAddress: "127.0.0.1",
    userAgent: "vitest",
  };
}

/**
 * Insert an audit log with a precisely controlled timestamp.
 * `Database.createAuditLog` always stamps `new Date()` at call time, so we
 * drive the clock with fake timers, create the record, then restore "now".
 */
async function createLogAt(timestamp: Date) {
  vi.setSystemTime(timestamp);
  const log = await Database.createAuditLog(baseLogPayload());
  return log;
}

describe("AuditRetentionJob: retention boundary semantics", () => {
  const RETENTION_DAYS = 90;

  beforeEach(() => {
    Database.__resetAuditLogsForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("purges a record exactly 1ms before the retention cutoff", async () => {
    const now = new Date("2026-06-24T12:00:00.000Z");
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY_MS);
    const justBeforeCutoff = new Date(cutoff.getTime() - 1);

    await createLogAt(justBeforeCutoff);

    vi.setSystemTime(now);
    const purgedCount = await runAuditRetention(RETENTION_DAYS);

    expect(purgedCount).toBe(1);
    const remaining = await Database.getAuditLogs();
    expect(remaining).toHaveLength(0);
  });

  it("keeps a record exactly AT the retention cutoff (the < vs <= boundary)", async () => {
    const now = new Date("2026-06-24T12:00:00.000Z");
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY_MS);

    await createLogAt(cutoff);

    vi.setSystemTime(now);
    const purgedCount = await runAuditRetention(RETENTION_DAYS);

    // A `<` to `<=` mutation would purge this record (purgedCount === 1,
    // remaining === 0). The correct behavior keeps it.
    expect(purgedCount).toBe(0);
    const remaining = await Database.getAuditLogs();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].timestamp.getTime()).toBe(cutoff.getTime());
  });

  it("keeps a record exactly 1ms after the retention cutoff", async () => {
    const now = new Date("2026-06-24T12:00:00.000Z");
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY_MS);
    const justAfterCutoff = new Date(cutoff.getTime() + 1);

    await createLogAt(justAfterCutoff);

    vi.setSystemTime(now);
    const purgedCount = await runAuditRetention(RETENTION_DAYS);

    expect(purgedCount).toBe(0);
    const remaining = await Database.getAuditLogs();
    expect(remaining).toHaveLength(1);
  });

  it("purges old records while keeping boundary and fresh records together", async () => {
    const now = new Date("2026-06-24T12:00:00.000Z");
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY_MS);

    await createLogAt(new Date(cutoff.getTime() - 1)); // purge
    await createLogAt(cutoff); // keep (boundary)
    await createLogAt(new Date(cutoff.getTime() + 1)); // keep
    await createLogAt(now); // keep (fresh)

    vi.setSystemTime(now);
    const purgedCount = await runAuditRetention(RETENTION_DAYS);

    expect(purgedCount).toBe(1);
    const remaining = await Database.getAuditLogs();
    expect(remaining).toHaveLength(3);
    expect(remaining.every((l) => l.timestamp.getTime() >= cutoff.getTime())).toBe(
      true
    );
  });

  it("records the background-job metric with the correct job name, status, and duration", async () => {
    const recordSpy = vi.spyOn(MetricsCollector, "recordBackgroundJob");
    const now = new Date("2026-06-24T12:00:00.000Z");
    vi.setSystemTime(now);

    await runAuditRetention(RETENTION_DAYS);

    expect(recordSpy).toHaveBeenCalledTimes(1);
    const [jobName, status, durationSeconds] = recordSpy.mock.calls[0];
    expect(jobName).toBe("audit_retention");
    expect(status).toBe("success");
    // Duration must be a non-negative number of *seconds*, not milliseconds
    // and not the result of an addition (Date.now() + start would be huge).
    expect(durationSeconds).toBeGreaterThanOrEqual(0);
    expect(durationSeconds).toBeLessThan(1);

    recordSpy.mockRestore();
  });

  it("logs a structured completion event with the correct event name and cutoff", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const now = new Date("2026-06-24T12:00:00.000Z");
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY_MS);
    vi.setSystemTime(now);

    await runAuditRetention(RETENTION_DAYS);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(logged.event).toBe("audit_retention.complete");
    expect(logged.cutoff).toBe(cutoff.toISOString());
    expect(logged.retentionDays).toBe(RETENTION_DAYS);
    expect(logged.purged).toBe(0);
    expect(typeof logged.durationMs).toBe("number");
    expect(logged.durationMs).toBeGreaterThanOrEqual(0);

    logSpy.mockRestore();
  });

  it("is idempotent: running twice in a row purges nothing the second time", async () => {
    const now = new Date("2026-06-24T12:00:00.000Z");
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY_MS);

    await createLogAt(new Date(cutoff.getTime() - 1));
    await createLogAt(cutoff);

    vi.setSystemTime(now);
    const firstRun = await runAuditRetention(RETENTION_DAYS);
    const secondRun = await runAuditRetention(RETENTION_DAYS);

    expect(firstRun).toBe(1);
    expect(secondRun).toBe(0);
    const remaining = await Database.getAuditLogs();
    expect(remaining).toHaveLength(1);
  });
});

describe("AuditRetentionJob: concurrent writes during a deletion run", () => {
  const RETENTION_DAYS = 90;

  beforeEach(() => {
    Database.__resetAuditLogsForTests();
  });

  it("does not delete fresh records written concurrently with a retention pass", async () => {
    // Seed a stale record well outside the retention window so the
    // retention pass has guaranteed work to do.
    const staleTimestamp = new Date(
      Date.now() - (RETENTION_DAYS + 10) * DAY_MS
    );
    vi.useFakeTimers();
    vi.setSystemTime(staleTimestamp);
    await Database.createAuditLog(baseLogPayload());
    vi.useRealTimers();

    // Race 10 concurrent "writer" operations (each stamped with the current
    // real time) against a single concurrently-running retention pass.
    const writerCount = 10;
    const writers = Array.from({ length: writerCount }, (_, i) =>
      Database.createAuditLog({
        ...baseLogPayload(),
        resourceId: `concurrent-${i}`,
      })
    );

    const [retentionResult] = await Promise.all([
      runAuditRetention(RETENTION_DAYS),
      ...writers,
    ]);

    const remaining = await Database.getAuditLogs();

    // The stale seed record should have been purged.
    expect(retentionResult).toBeGreaterThanOrEqual(1);

    // All 10 freshly-written concurrent records must survive — none of them
    // are older than the retention cutoff.
    const concurrentSurvivors = remaining.filter((l) =>
      l.resourceId.startsWith("concurrent-")
    );
    expect(concurrentSurvivors).toHaveLength(writerCount);

    // Sanity: every survivor's resourceId is represented exactly once.
    const survivorIds = new Set(concurrentSurvivors.map((l) => l.resourceId));
    expect(survivorIds.size).toBe(writerCount);
  });

  it("preserves a record written exactly at the retention boundary while writers race", async () => {
    const now = new Date("2026-06-24T12:00:00.000Z");
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY_MS);

    // Keep fake time pinned at `now` for the entire scenario so that the
    // cutoff `runAuditRetention` computes internally (via Date.now()) lines
    // up exactly with the boundary record's timestamp. Real timers would let
    // wall-clock time drift past `now` between setup and the retention call,
    // which would make the boundary record legitimately stale instead of
    // exactly-at-cutoff.
    vi.useFakeTimers();
    vi.setSystemTime(cutoff);
    await Database.createAuditLog({
      ...baseLogPayload(),
      resourceId: "boundary-record",
    });
    vi.setSystemTime(now);

    const writers = Array.from({ length: 10 }, (_, i) =>
      Database.createAuditLog({
        ...baseLogPayload(),
        resourceId: `writer-${i}`,
      })
    );

    await Promise.all([runAuditRetention(RETENTION_DAYS), ...writers]);

    vi.useRealTimers();

    const remaining = await Database.getAuditLogs();
    const boundaryRecord = remaining.find(
      (l) => l.resourceId === "boundary-record"
    );

    // This is the case a `<` -> `<=` mutant gets wrong: the boundary record
    // must be preserved, not purged.
    expect(boundaryRecord).toBeDefined();

    const survivingWriters = remaining.filter((l) =>
      l.resourceId.startsWith("writer-")
    );
    expect(survivingWriters).toHaveLength(10);
  });
});
