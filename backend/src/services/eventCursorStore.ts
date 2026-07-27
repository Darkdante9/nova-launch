import { PrismaClient } from "@prisma/client";

const CURSOR_KEY = "stellar_event_cursor";

/**
 * Key used to store the last processed ledger sequence for governance event catchup.
 * Stored separately from the Stellar paging cursor so governance replay is independent
 * of the general event stream position.
 */
export const GOVERNANCE_LEDGER_CURSOR_KEY = "governance_last_ledger";

/**
 * Durable cursor store backed by Prisma IntegrationState.
 *
 * Provides gap-free event stream resumption after restarts by persisting the
 * last processed paging_token to the database.
 *
 * Cursor format: "<ledger>-<seq>" (e.g. "1234567-1").
 * Ledger number is extracted for lag calculations.
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

  /**
   * Return how many ledgers behind the stored cursor is relative to
   * `currentLedger`.  Returns null when no cursor is persisted.
   *
   * Cursor format is "<ledger>-<seq>" — we parse the numeric prefix.
   */
  async getCursorLag(currentLedger: number): Promise<number | null> {
    const cursor = await this.load();
    if (!cursor) return null;
    const ledger = parseLedgerFromCursor(cursor);
    if (ledger === null) return null;
    return Math.max(0, currentLedger - ledger);
  }
}

/**
 * Extract the ledger sequence number from a Horizon paging_token.
 * Returns null if the cursor does not match the expected "<ledger>-<seq>" format.
 */
export function parseLedgerFromCursor(cursor: string): number | null {
  const match = cursor.match(/^(\d+)-\d+$/);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  return Number.isFinite(n) ? n : null;
}
