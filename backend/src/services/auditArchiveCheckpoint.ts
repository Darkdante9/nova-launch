/**
 * AuditArchiveCheckpointStore
 *
 * Provides durable, file-backed persistence for the tiered audit-log archival
 * job.  Writing a checkpoint before each tier completes allows an interrupted
 * job to resume from where it left off rather than re-archiving (or worse,
 * skipping) records.
 *
 * The checkpoint file is stored at:
 *   <storagePath>/audit/checkpoint.json
 */

import fs from "fs/promises";
import path from "path";

export interface CheckpointData {
  /** ISO-8601 timestamp of the most-recently archived record. */
  lastArchivedAt: string;
  /** Tier that was active when the checkpoint was written. */
  tier: "warm" | "cold";
  /** Running total of archived records across all tiers in this run. */
  totalArchived: number;
  /** Whether the job is currently in-progress (false means completed). */
  inProgress: boolean;
  /** ISO-8601 timestamp when the job started. */
  startedAt: string;
  /** ISO-8601 timestamp when the job completed (only present if not in progress). */
  completedAt?: string;
}

export class AuditArchiveCheckpointStore {
  private checkpoint: CheckpointData | null = null;
  private readonly filePath: string;

  constructor(storagePath: string) {
    this.filePath = path.join(storagePath, "audit", "checkpoint.json");
  }

  /**
   * Load the checkpoint from disk.  Returns null if no checkpoint exists yet.
   */
  async load(): Promise<CheckpointData | null> {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      this.checkpoint = JSON.parse(raw) as CheckpointData;
      return this.checkpoint;
    } catch {
      this.checkpoint = null;
      return null;
    }
  }

  /**
   * Persist a checkpoint to disk, overwriting any previous one.
   */
  async save(data: CheckpointData): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), "utf-8");
    this.checkpoint = data;
  }

  /**
   * Remove the checkpoint file.  Called after a job completes successfully so
   * the next run starts clean.
   */
  async clear(): Promise<void> {
    try {
      await fs.unlink(this.filePath);
    } catch {
      // Ignore – file may not exist.
    }
    this.checkpoint = null;
  }

  /** Return the in-memory checkpoint without hitting disk. */
  getCached(): CheckpointData | null {
    return this.checkpoint;
  }
}
