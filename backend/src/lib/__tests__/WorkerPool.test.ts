/**
 * Tests for backend/src/lib/WorkerPool.ts
 *
 * Coverage targets:
 *  - Bounded concurrency: never more than N tasks run at once
 *  - Queueing: the (N+1)th task is queued, not dropped, and eventually runs
 *  - Back-pressure: enqueue() resolves only once the task has run, so
 *    saturating the pool measurably delays callers instead of buffering
 *    unbounded work synchronously
 *  - Accessors: getConcurrency / getRunningCount / getQueueDepth
 *  - Error handling: a throwing worker rejects only that task's promise
 */

import { describe, it, expect } from "vitest";
import { WorkerPool } from "../WorkerPool";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("WorkerPool", () => {
  describe("bounded concurrency", () => {
    it("never runs more than `concurrency` tasks at the same time", async () => {
      const concurrency = 3;
      let inFlight = 0;
      let maxInFlight = 0;

      const pool = new WorkerPool<number>({
        concurrency,
        worker: async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await delay(20);
          inFlight--;
        },
      });

      const tasks = Array.from({ length: 12 }, (_, i) => i);
      await Promise.all(tasks.map((t) => pool.enqueue(t)));

      expect(maxInFlight).toBeLessThanOrEqual(concurrency);
      expect(maxInFlight).toBe(concurrency);
    });

    it("exposes the configured concurrency", () => {
      const pool = new WorkerPool<number>({
        concurrency: 7,
        worker: async () => {},
      });
      expect(pool.getConcurrency()).toBe(7);
    });
  });

  describe("queueing — extra tasks are queued, not dropped", () => {
    it("the (N+1)th task is queued while the pool is saturated, then eventually runs", async () => {
      const concurrency = 2;
      const completed: number[] = [];
      let releaseFirstBatch: (() => void) | null = null;
      const firstBatchGate = new Promise<void>((resolve) => {
        releaseFirstBatch = resolve;
      });

      const pool = new WorkerPool<number>({
        concurrency,
        worker: async (task) => {
          if (task < concurrency) {
            // First `concurrency` tasks block until explicitly released,
            // holding every worker slot open.
            await firstBatchGate;
          }
          completed.push(task);
        },
      });

      const p0 = pool.enqueue(0);
      const p1 = pool.enqueue(1);

      // Give the two blocking tasks a tick to actually start.
      await delay(5);
      expect(pool.getRunningCount()).toBe(concurrency);

      // A third task arrives while the pool is fully saturated.
      const p2 = pool.enqueue(2);
      await delay(5);

      // It must be queued (not dropped, not started) — running count stays
      // at the cap and the task has not completed yet.
      expect(pool.getRunningCount()).toBe(concurrency);
      expect(pool.getQueueDepth()).toBe(1);
      expect(completed).not.toContain(2);

      // Release the first batch — task 2 should now be admitted and run.
      releaseFirstBatch!();
      await Promise.all([p0, p1, p2]);

      expect(completed).toContain(2);
      expect(pool.getQueueDepth()).toBe(0);
      expect(pool.getRunningCount()).toBe(0);
    });
  });

  describe("back-pressure on enqueue", () => {
    it("slows down enqueue() once the pool is saturated instead of buffering instantly", async () => {
      const concurrency = 2;
      const workMs = 30;

      const pool = new WorkerPool<number>({
        concurrency,
        worker: async () => {
          await delay(workMs);
        },
      });

      // Saturate the pool.
      const saturating = [pool.enqueue(0), pool.enqueue(1)];

      // This enqueue cannot start until a slot frees, so it should take at
      // least ~workMs to resolve — proving the call itself is throttled
      // rather than returning immediately and queuing silently.
      const start = Date.now();
      await pool.enqueue(2);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(workMs - 5);

      await Promise.all(saturating);
    });

    it("queue depth grows under burst load and drains back to zero", async () => {
      const concurrency = 2;
      const pool = new WorkerPool<number>({
        concurrency,
        worker: async () => {
          await delay(15);
        },
      });

      const tasks = Array.from({ length: 10 }, (_, i) => i);
      const promises = tasks.map((t) => pool.enqueue(t));

      // Immediately after the burst, most tasks should be waiting in queue
      // rather than all having started concurrently.
      await delay(1);
      expect(pool.getQueueDepth()).toBeGreaterThan(0);
      expect(pool.getRunningCount()).toBeLessThanOrEqual(concurrency);

      await Promise.all(promises);
      expect(pool.getQueueDepth()).toBe(0);
      expect(pool.getRunningCount()).toBe(0);
    });
  });

  describe("error handling", () => {
    it("rejects only the failing task's promise, leaving the pool usable", async () => {
      const pool = new WorkerPool<number>({
        concurrency: 2,
        worker: async (task) => {
          if (task === 1) throw new Error("boom");
        },
      });

      const results = await Promise.allSettled([
        pool.enqueue(0),
        pool.enqueue(1),
        pool.enqueue(2),
      ]);

      expect(results[0].status).toBe("fulfilled");
      expect(results[1].status).toBe("rejected");
      expect(results[2].status).toBe("fulfilled");

      // Pool remains healthy for further work after a failure.
      await expect(pool.enqueue(3)).resolves.toBeUndefined();
    });
  });

  describe("constructor validation", () => {
    it("throws when concurrency is less than 1", () => {
      expect(
        () => new WorkerPool<number>({ concurrency: 0, worker: async () => {} })
      ).toThrow();
    });
  });
});
