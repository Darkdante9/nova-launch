/**
 * Generic async worker pool with bounded concurrency and back-pressure.
 *
 * Unlike a naive `Promise.allSettled(tasks.map(fn))` fan-out — which starts
 * every task immediately regardless of how many there are — this pool caps
 * the number of tasks running at once. When the pool is saturated, new
 * tasks wait in an internal queue and `enqueue()` only resolves once its
 * task has actually run to completion. Back-pressure falls out naturally:
 * a caller awaiting `enqueue()` for the (concurrency + 1)-th task is
 * delayed until a worker slot frees up, rather than the call returning
 * immediately and letting an unbounded queue build up in memory.
 */

export interface WorkerPoolOptions<T> {
  /** Maximum number of tasks that may run concurrently. */
  concurrency: number;
  /** Function invoked for each enqueued task. */
  worker: (task: T) => Promise<void>;
}

interface QueuedTask<T> {
  task: T;
  resolve: () => void;
  reject: (err: unknown) => void;
}

export class WorkerPool<T> {
  private readonly concurrency: number;
  private readonly workerFn: (task: T) => Promise<void>;
  private readonly queue: QueuedTask<T>[] = [];
  private running = 0;

  constructor(options: WorkerPoolOptions<T>) {
    if (!Number.isFinite(options.concurrency) || options.concurrency < 1) {
      throw new Error("WorkerPool concurrency must be >= 1");
    }
    this.concurrency = options.concurrency;
    this.workerFn = options.worker;
  }

  /**
   * Enqueue a task for processing.
   *
   * Resolves once the task has actually run to completion (or rejects if
   * the worker throws). When all worker slots are busy the task sits in
   * the internal queue and this promise simply stays pending — that delay
   * IS the back-pressure signal: producers that `await pool.enqueue(...)`
   * are naturally throttled to the pool's processing rate instead of
   * flooding it with queued work.
   */
  enqueue(task: T): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.drain();
    });
  }

  /** Number of tasks waiting for a free worker slot (not yet started). */
  getQueueDepth(): number {
    return this.queue.length;
  }

  /** Number of tasks currently being processed. */
  getRunningCount(): number {
    return this.running;
  }

  /** Configured maximum concurrency for this pool. */
  getConcurrency(): number {
    return this.concurrency;
  }

  private drain(): void {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) break;
      this.running++;

      this.workerFn(next.task)
        .then(next.resolve, next.reject)
        .finally(() => {
          this.running--;
          // A slot just freed up — try to admit the next queued task.
          this.drain();
        });
    }
  }
}
