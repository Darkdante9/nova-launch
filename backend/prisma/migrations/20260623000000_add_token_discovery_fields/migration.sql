-- Add token discovery fields: isPublic visibility flag and category enum

CREATE TYPE "TokenCategory" AS ENUM ('DEFI', 'COMMUNITY', 'CREATOR', 'UTILITY', 'OTHER');

ALTER TABLE "Token"
  ADD COLUMN "isPublic"  BOOLEAN         NOT NULL DEFAULT true,
  ADD COLUMN "category"  "TokenCategory" NOT NULL DEFAULT 'OTHER',
  ADD COLUMN "network"   TEXT            NOT NULL DEFAULT 'testnet';

-- GIN index for full-text search across name + symbol
CREATE INDEX IF NOT EXISTS "Token_discovery_fulltext_idx" ON "Token" USING gin (
  to_tsvector('english', "name" || ' ' || "symbol")
);

-- Partial index: only public tokens are eligible for discovery queries
CREATE INDEX IF NOT EXISTS "Token_isPublic_createdAt_idx" ON "Token" ("isPublic", "createdAt" DESC)
  WHERE "isPublic" = true;

CREATE INDEX IF NOT EXISTS "Token_category_idx"   ON "Token" ("category");
CREATE INDEX IF NOT EXISTS "Token_network_idx"    ON "Token" ("network");
