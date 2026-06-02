import { PrismaClient } from "@prisma/client";

const CURSOR_KEY = "stellar_event_cursor";

/**
 * Durable cursor store backed by Prisma IntegrationState.
 * 
 * **Issue #1156: Persist Stellar event subscription cursor for gap-free resume**
 * 
 * This implementation provides gap-free event stream resumption after service restarts,
 * crashes, or deployments by persisting the last processed cursor to the database.
 *
 * ## Semantics: At-Least-Once Delivery
 * 
 * This implementation provides **at-least-once** semantics:
 * - Events are processed BEFORE cursor is saved
 * - If process crashes after processing but before save, event may be replayed
 * - Downstream handlers MUST be idempotent (deduplicate by txHash/ledger)
 * - This is safer than at-most-once (losing events) for financial data
 * 
 * ## Replay Strategy
 * 
 * **First Boot (no persisted cursor):**
 * - Checks for STELLAR_CURSOR_ORIGIN environment variable
 * - If set, starts from that cursor (for historical replay)
 * - If not set, returns null → Horizon starts from "now" (skip history)
 * - Only new events are ingested (no historical backfill by default)
 * 
 * **Restart (cursor exists):**
 * - Loads persisted cursor from database
 * - Passes cursor to Horizon API as `cursor` parameter
 * - Horizon returns events AFTER that cursor
 * - Resumes exactly where processing stopped
 * - No gaps, no duplicates (beyond at-least-once guarantee)
 * 
 * ## Cursor Format
 * 
 * Cursors are opaque paging tokens from Horizon API:
 * - Format: "12345-67890" (ledger-sequence based)
 * - Monotonically increasing (newer events have higher cursors)
 * - Cursor points to a specific event position in ledger history
 * 
 * ## Atomicity & Safety
 * 
 * - Uses Prisma upsert for atomic cursor updates
 * - Single row per cursor key (stellar_event_cursor)
 * - Concurrent saves are serialized by database transaction
 * - Idempotent saves (same cursor written multiple times is safe)
 * 
 * ## Testing
 * 
 * See `__tests__/stellarEventListener.cursor.test.ts` for:
 * - C1: Cursor persistence and reload
 * - C2: Resume after simulated restart
 * - C3: Idempotent saves
 * - C4: Cursor monotonicity
 * - C5: Concurrent updates
 * - C6: Environment variable precedence
 * - C7: Atomic updates
 * - C8: Edge case handling
 * - P1-P3: Property-based tests
 */
export class EventCursorStore {
  constructor(private readonly prisma: PrismaClient) {}

  async load(): Promise<string | null> {
    const row = await this.prisma.integrationState.findUnique({
      where: { key: CURSOR_KEY },
    });
    return row?.value ?? process.env.STELLAR_CURSOR_ORIGIN ?? null;
  }

  async save(cursor: string): Promise<void> {
    await this.prisma.integrationState.upsert({
      where: { key: CURSOR_KEY },
      create: { key: CURSOR_KEY, value: cursor },
      update: { value: cursor },
    });
  }
}
