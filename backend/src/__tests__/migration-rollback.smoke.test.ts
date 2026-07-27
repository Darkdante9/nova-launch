/**
 * Migration rollback smoke tests — Issue #1320
 *
 * Verifies post-rollback database state by:
 *   1. Executing the real production migration SQL against an isolated schema.
 *   2. Seeding baseline data BEFORE each migration runs.
 *   3. Running the rollback (DOWN SQL) and asserting via information_schema that
 *      every table / index / enum introduced by the migration is fully removed.
 *   4. Asserting that pre-migration baseline data is untouched after rollback.
 *   5. Confirming the client connection stays live and usable post-rollback.
 *   6. Running the rollback a second time to verify idempotency.
 *
 * Run locally:
 *   DATABASE_URL=postgresql://... npx vitest run src/__tests__/migration-rollback.smoke.test.ts
 *
 * Skipped automatically when DATABASE_URL is not set.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Environment / connection
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;

/** Unique per-run schema to guarantee complete test isolation. */
const SCHEMA = `rollback_smoke_${Date.now()}`;

/** Absolute path to the prisma migrations directory. */
const MIGRATIONS_DIR = path.resolve(
  __dirname,
  "../../..",
  "prisma/migrations"
);

/** Read an UP migration sql file by folder name. */
function readMigration(folderName: string): string {
  return fs.readFileSync(
    path.join(MIGRATIONS_DIR, folderName, "migration.sql"),
    "utf-8"
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function tableExists(
  client: Client,
  schema: string,
  tableName: string
): Promise<boolean> {
  const res = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = $1 AND table_name = $2`,
    [schema, tableName]
  );
  return (res.rowCount ?? 0) > 0;
}

async function columnExists(
  client: Client,
  schema: string,
  tableName: string,
  columnName: string
): Promise<boolean> {
  const res = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
    [schema, tableName, columnName]
  );
  return (res.rowCount ?? 0) > 0;
}

async function indexExists(
  client: Client,
  schema: string,
  indexName: string
): Promise<boolean> {
  const res = await client.query(
    `SELECT 1 FROM pg_indexes
     WHERE schemaname = $1 AND indexname = $2`,
    [schema, indexName]
  );
  return (res.rowCount ?? 0) > 0;
}

async function enumExists(
  client: Client,
  enumName: string
): Promise<boolean> {
  const res = await client.query(
    `SELECT 1 FROM pg_type
     WHERE typtype = 'e' AND typname = $1`,
    [enumName]
  );
  return (res.rowCount ?? 0) > 0;
}

async function constraintExists(
  client: Client,
  schema: string,
  tableName: string,
  constraintName: string
): Promise<boolean> {
  const res = await client.query(
    `SELECT 1 FROM information_schema.table_constraints
     WHERE constraint_schema = $1
       AND table_name = $2
       AND constraint_name = $3`,
    [schema, tableName, constraintName]
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Rewrites all unqualified identifiers in the migration SQL to use the
 * isolated test schema.  The real migration SQL uses the public search_path,
 * so we prepend `SET search_path TO "<schema>";` instead of text-mangling.
 */
function scopedSql(sql: string): string {
  return `SET search_path TO "${SCHEMA}", public;\n${sql}`;
}

// ---------------------------------------------------------------------------
// Baseline schema (Token table + supporting enums present before campaigns)
// ---------------------------------------------------------------------------

/**
 * Minimal Token + supporting enum DDL — mirrors the subset of schema.prisma
 * that must exist before the campaign migration runs.  We replicate only what
 * the migration FK / enum references actually need.
 */
const BASELINE_UP = `
CREATE SCHEMA IF NOT EXISTS "${SCHEMA}";
SET search_path TO "${SCHEMA}", public;

CREATE TABLE IF NOT EXISTS "Token" (
  "id"            TEXT        NOT NULL,
  "address"       TEXT        NOT NULL,
  "creator"       TEXT        NOT NULL,
  "name"          TEXT        NOT NULL,
  "symbol"        TEXT        NOT NULL,
  "decimals"      INTEGER     NOT NULL DEFAULT 18,
  "totalSupply"   BIGINT      NOT NULL,
  "initialSupply" BIGINT      NOT NULL,
  "totalBurned"   BIGINT      NOT NULL DEFAULT 0,
  "burnCount"     INTEGER     NOT NULL DEFAULT 0,
  "metadataUri"   TEXT,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "Token_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Token_address_key" ON "Token"("address");
`;

const BASELINE_DOWN = `
SET search_path TO "${SCHEMA}", public;
DROP TABLE IF EXISTS "Token" CASCADE;
DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE;
`;

// ---------------------------------------------------------------------------
// DOWN SQL for each migration (rollback DDL)
// ---------------------------------------------------------------------------

const DOWN_ADD_CAMPAIGNS = `
SET search_path TO "${SCHEMA}", public;
DROP TABLE IF EXISTS "CampaignExecution" CASCADE;
DROP TABLE IF EXISTS "Campaign" CASCADE;
DROP TYPE  IF EXISTS "CampaignStatus";
DROP TYPE  IF EXISTS "CampaignType";
`;

const DOWN_ADD_CAMPAIGN_AUDIT_TRAIL = `
SET search_path TO "${SCHEMA}", public;
ALTER TABLE IF EXISTS "Campaign"
  DROP CONSTRAINT IF EXISTS "CampaignAuditTrail_campaignId_fkey";
DROP TABLE IF EXISTS "CampaignAuditTrail" CASCADE;
`;

const DOWN_ADD_TOKEN_CREATOR_FULLTEXT_SEARCH = `
SET search_path TO "${SCHEMA}", public;
DROP INDEX IF EXISTS "Token_creator_fulltext_idx";
DROP INDEX IF EXISTS "Token_fulltext_idx";
`;

// ---------------------------------------------------------------------------
// Suite helpers
// ---------------------------------------------------------------------------

/** Seed a canonical Token row into the isolated schema. */
async function seedBaselineToken(client: Client): Promise<string> {
  const tokenId = `seed-token-${Date.now()}`;
  await client.query(
    `INSERT INTO "${SCHEMA}"."Token"
       ("id","address","creator","name","symbol","totalSupply","initialSupply","updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,now())
     ON CONFLICT DO NOTHING`,
    [tokenId, `G${tokenId}`, "GCREATOR001", "SeedToken", "SEED", 1000000, 1000000]
  );
  return tokenId;
}

/** Assert the seeded Token row is still intact (data preservation check). */
async function assertBaselineTokenIntact(
  client: Client,
  tokenId: string
): Promise<void> {
  const res = await client.query(
    `SELECT "id" FROM "${SCHEMA}"."Token" WHERE "id" = $1`,
    [tokenId]
  );
  expect(res.rowCount, "baseline Token row must survive rollback").toBe(1);
}

// ===========================================================================
// TEST SUITES
// ===========================================================================

describe.skipIf(!DATABASE_URL)(
  "migration rollback smoke tests — post-rollback state verification",
  () => {
    let client: Client;

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    beforeAll(async () => {
      client = new Client({ connectionString: DATABASE_URL });
      await client.connect();
      // Build the baseline schema once for the entire suite.
      await client.query(BASELINE_UP);
    });

    afterAll(async () => {
      // Unconditional teardown — drop the isolated schema regardless of failures.
      await client.query(BASELINE_DOWN).catch(() => {});
      await client.end();
    });

    // =======================================================================
    // Suite 1: 20260309_add_campaigns
    // =======================================================================

    describe("20260309_add_campaigns", () => {
      let baselineTokenId: string;

      beforeAll(async () => {
        // Seed baseline data BEFORE the migration runs.
        baselineTokenId = await seedBaselineToken(client);
        // Apply the real production UP SQL inside the isolated schema.
        await client.query(scopedSql(readMigration("20260309_add_campaigns")));
      });

      afterAll(async () => {
        await client.query(DOWN_ADD_CAMPAIGNS).catch(() => {});
      });

      // --- UP verification ------------------------------------------------

      it("Campaign table exists with expected columns after UP", async () => {
        expect(await tableExists(client, SCHEMA, "Campaign")).toBe(true);
        for (const col of [
          "id", "campaignId", "tokenId", "creator", "type", "status",
          "targetAmount", "currentAmount", "executionCount", "startTime",
          "txHash", "createdAt", "updatedAt",
        ]) {
          expect(
            await columnExists(client, SCHEMA, "Campaign", col),
            `Campaign.${col} must exist after UP`
          ).toBe(true);
        }
      });

      it("CampaignExecution table exists with expected columns after UP", async () => {
        expect(await tableExists(client, SCHEMA, "CampaignExecution")).toBe(true);
        for (const col of ["id", "campaignId", "executor", "amount", "txHash", "executedAt"]) {
          expect(
            await columnExists(client, SCHEMA, "CampaignExecution", col),
            `CampaignExecution.${col} must exist after UP`
          ).toBe(true);
        }
      });

      it("CampaignStatus and CampaignType enums exist after UP", async () => {
        expect(await enumExists(client, "CampaignStatus")).toBe(true);
        expect(await enumExists(client, "CampaignType")).toBe(true);
      });

      it("Campaign indexes exist after UP", async () => {
        for (const idx of [
          "Campaign_campaignId_key",
          "Campaign_txHash_key",
          "Campaign_tokenId_idx",
          "Campaign_creator_idx",
          "Campaign_status_idx",
          "Campaign_type_idx",
          "Campaign_startTime_idx",
          "Campaign_createdAt_idx",
        ]) {
          expect(
            await indexExists(client, SCHEMA, idx),
            `index ${idx} must exist after UP`
          ).toBe(true);
        }
      });

      // --- Post-rollback verification -------------------------------------

      it("rolls back: Campaign and CampaignExecution tables are fully dropped", async () => {
        await client.query(DOWN_ADD_CAMPAIGNS);

        expect(
          await tableExists(client, SCHEMA, "Campaign"),
          "Campaign table must not exist after DOWN"
        ).toBe(false);

        expect(
          await tableExists(client, SCHEMA, "CampaignExecution"),
          "CampaignExecution table must not exist after DOWN"
        ).toBe(false);
      });

      it("rolls back: CampaignStatus and CampaignType enums are dropped", async () => {
        expect(
          await enumExists(client, "CampaignStatus"),
          "CampaignStatus enum must not exist after DOWN"
        ).toBe(false);

        expect(
          await enumExists(client, "CampaignType"),
          "CampaignType enum must not exist after DOWN"
        ).toBe(false);
      });

      it("rolls back: all Campaign indexes are gone from pg_indexes", async () => {
        for (const idx of [
          "Campaign_campaignId_key",
          "Campaign_txHash_key",
          "Campaign_tokenId_idx",
          "Campaign_creator_idx",
          "Campaign_status_idx",
          "Campaign_type_idx",
          "Campaign_startTime_idx",
          "Campaign_createdAt_idx",
          "CampaignExecution_txHash_key",
          "CampaignExecution_campaignId_idx",
          "CampaignExecution_executor_idx",
          "CampaignExecution_executedAt_idx",
        ]) {
          expect(
            await indexExists(client, SCHEMA, idx),
            `index ${idx} must not exist after DOWN`
          ).toBe(false);
        }
      });

      it("data preservation: baseline Token row is intact after DOWN", async () => {
        await assertBaselineTokenIntact(client, baselineTokenId);
      });

      it("connection continuity: client can query after rollback", async () => {
        const res = await client.query("SELECT 1 AS alive");
        expect(res.rows[0]?.alive).toBe(1);
      });

      it("idempotency: running DOWN a second time produces identical state", async () => {
        // Second execution must not throw.
        await expect(client.query(DOWN_ADD_CAMPAIGNS)).resolves.toBeDefined();

        // State must be identical to first rollback.
        expect(await tableExists(client, SCHEMA, "Campaign")).toBe(false);
        expect(await tableExists(client, SCHEMA, "CampaignExecution")).toBe(false);
        expect(await enumExists(client, "CampaignStatus")).toBe(false);
        expect(await enumExists(client, "CampaignType")).toBe(false);
      });
    });

    // =======================================================================
    // Suite 2: 20260527000000_add_campaign_audit_trail
    // =======================================================================

    describe("20260527000000_add_campaign_audit_trail", () => {
      let baselineTokenId: string;

      beforeAll(async () => {
        baselineTokenId = await seedBaselineToken(client);

        // Re-apply campaigns migration so CampaignAuditTrail FK target exists.
        await client.query(scopedSql(readMigration("20260309_add_campaigns")));
        // Apply the audit trail migration.
        await client.query(
          scopedSql(readMigration("20260527000000_add_campaign_audit_trail"))
        );
      });

      afterAll(async () => {
        await client.query(DOWN_ADD_CAMPAIGN_AUDIT_TRAIL).catch(() => {});
        await client.query(DOWN_ADD_CAMPAIGNS).catch(() => {});
      });

      // --- UP verification ------------------------------------------------

      it("CampaignAuditTrail table exists with all columns after UP", async () => {
        expect(await tableExists(client, SCHEMA, "CampaignAuditTrail")).toBe(true);
        for (const col of [
          "id", "campaignId", "fromStatus", "toStatus", "actor", "txHash", "transitionAt",
        ]) {
          expect(
            await columnExists(client, SCHEMA, "CampaignAuditTrail", col),
            `CampaignAuditTrail.${col} must exist after UP`
          ).toBe(true);
        }
      });

      it("CampaignAuditTrail indexes exist after UP", async () => {
        for (const idx of [
          "CampaignAuditTrail_campaignId_idx",
          "CampaignAuditTrail_actor_idx",
          "CampaignAuditTrail_transitionAt_idx",
        ]) {
          expect(
            await indexExists(client, SCHEMA, idx),
            `index ${idx} must exist after UP`
          ).toBe(true);
        }
      });

      it("CampaignAuditTrail FK constraint exists after UP", async () => {
        expect(
          await constraintExists(
            client,
            SCHEMA,
            "CampaignAuditTrail",
            "CampaignAuditTrail_campaignId_fkey"
          )
        ).toBe(true);
      });

      // --- Post-rollback verification -------------------------------------

      it("rolls back: CampaignAuditTrail table is fully dropped", async () => {
        await client.query(DOWN_ADD_CAMPAIGN_AUDIT_TRAIL);

        expect(
          await tableExists(client, SCHEMA, "CampaignAuditTrail"),
          "CampaignAuditTrail table must not exist after DOWN"
        ).toBe(false);
      });

      it("rolls back: CampaignAuditTrail columns no longer visible in information_schema", async () => {
        for (const col of ["id", "campaignId", "fromStatus", "toStatus", "actor"]) {
          expect(
            await columnExists(client, SCHEMA, "CampaignAuditTrail", col),
            `CampaignAuditTrail.${col} must not exist after DOWN`
          ).toBe(false);
        }
      });

      it("rolls back: CampaignAuditTrail indexes are removed from pg_indexes", async () => {
        for (const idx of [
          "CampaignAuditTrail_campaignId_idx",
          "CampaignAuditTrail_actor_idx",
          "CampaignAuditTrail_transitionAt_idx",
        ]) {
          expect(
            await indexExists(client, SCHEMA, idx),
            `index ${idx} must not exist after DOWN`
          ).toBe(false);
        }
      });

      it("rolls back: Campaign table survives audit trail rollback (no partial drop)", async () => {
        expect(
          await tableExists(client, SCHEMA, "Campaign"),
          "Campaign table must still exist after audit trail rollback"
        ).toBe(true);
      });

      it("data preservation: baseline Token row is intact after DOWN", async () => {
        await assertBaselineTokenIntact(client, baselineTokenId);
      });

      it("connection continuity: client can query Token after rollback", async () => {
        const res = await client.query(
          `SELECT COUNT(*) AS cnt FROM "${SCHEMA}"."Token"`
        );
        expect(Number(res.rows[0]?.cnt)).toBeGreaterThanOrEqual(1);
      });

      it("idempotency: running DOWN a second time produces identical state", async () => {
        await expect(
          client.query(DOWN_ADD_CAMPAIGN_AUDIT_TRAIL)
        ).resolves.toBeDefined();

        expect(await tableExists(client, SCHEMA, "CampaignAuditTrail")).toBe(false);
        expect(await tableExists(client, SCHEMA, "Campaign")).toBe(true);
      });
    });

    // =======================================================================
    // Suite 3: 20260528000000_add_token_creator_fulltext_search
    // =======================================================================

    describe("20260528000000_add_token_creator_fulltext_search", () => {
      let baselineTokenId: string;

      beforeAll(async () => {
        baselineTokenId = await seedBaselineToken(client);
        await client.query(
          scopedSql(readMigration("20260528000000_add_token_creator_fulltext_search"))
        );
      });

      afterAll(async () => {
        await client.query(DOWN_ADD_TOKEN_CREATOR_FULLTEXT_SEARCH).catch(() => {});
      });

      // --- UP verification ------------------------------------------------

      it("GIN index Token_creator_fulltext_idx exists after UP", async () => {
        expect(
          await indexExists(client, SCHEMA, "Token_creator_fulltext_idx")
        ).toBe(true);
      });

      it("GIN index Token_fulltext_idx exists after UP", async () => {
        expect(await indexExists(client, SCHEMA, "Token_fulltext_idx")).toBe(true);
      });

      it("GIN indexes use gin access method", async () => {
        const res = await client.query(
          `SELECT indexname, indexdef FROM pg_indexes
           WHERE schemaname = $1
             AND indexname IN ('Token_creator_fulltext_idx','Token_fulltext_idx')`,
          [SCHEMA]
        );
        expect(res.rowCount).toBe(2);
        for (const row of res.rows) {
          expect(
            row.indexdef.toLowerCase(),
            `${row.indexname} must be a GIN index`
          ).toContain("using gin");
        }
      });

      // --- Post-rollback verification -------------------------------------

      it("rolls back: Token_creator_fulltext_idx is removed", async () => {
        await client.query(DOWN_ADD_TOKEN_CREATOR_FULLTEXT_SEARCH);

        expect(
          await indexExists(client, SCHEMA, "Token_creator_fulltext_idx"),
          "Token_creator_fulltext_idx must not exist after DOWN"
        ).toBe(false);
      });

      it("rolls back: Token_fulltext_idx is removed", async () => {
        expect(
          await indexExists(client, SCHEMA, "Token_fulltext_idx"),
          "Token_fulltext_idx must not exist after DOWN"
        ).toBe(false);
      });

      it("rolls back: Token table itself is unaffected (only indexes dropped)", async () => {
        expect(await tableExists(client, SCHEMA, "Token")).toBe(true);
      });

      it("rolls back: Token columns are fully intact after index rollback", async () => {
        for (const col of ["id", "address", "creator", "name", "symbol"]) {
          expect(
            await columnExists(client, SCHEMA, "Token", col),
            `Token.${col} must survive index rollback`
          ).toBe(true);
        }
      });

      it("data preservation: baseline Token row is intact after DOWN", async () => {
        await assertBaselineTokenIntact(client, baselineTokenId);
      });

      it("connection continuity: full-text query executes without the dropped index", async () => {
        // Query must succeed (falls back to seq scan) even without the GIN index.
        const res = await client.query(
          `SELECT "id" FROM "${SCHEMA}"."Token"
           WHERE to_tsvector('english', "creator") @@ plainto_tsquery('english', $1)`,
          ["GCREATOR001"]
        );
        expect(Array.isArray(res.rows)).toBe(true);
      });

      it("idempotency: running DOWN a second time produces identical state", async () => {
        await expect(
          client.query(DOWN_ADD_TOKEN_CREATOR_FULLTEXT_SEARCH)
        ).resolves.toBeDefined();

        expect(await indexExists(client, SCHEMA, "Token_creator_fulltext_idx")).toBe(false);
        expect(await indexExists(client, SCHEMA, "Token_fulltext_idx")).toBe(false);
        expect(await tableExists(client, SCHEMA, "Token")).toBe(true);
      });
    });
  }
);
