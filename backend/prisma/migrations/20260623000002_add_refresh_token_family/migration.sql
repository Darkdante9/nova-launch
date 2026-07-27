CREATE TABLE IF NOT EXISTS "RefreshToken" (
  "id"        TEXT         NOT NULL,
  "familyId"  TEXT         NOT NULL,
  "token"     TEXT         NOT NULL,
  "used"      BOOLEAN      NOT NULL DEFAULT false,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "RefreshToken_token_key"      ON "RefreshToken"("token");
CREATE INDEX IF NOT EXISTS "RefreshToken_familyId_idx"           ON "RefreshToken"("familyId");
CREATE INDEX IF NOT EXISTS "RefreshToken_token_idx"              ON "RefreshToken"("token");
CREATE INDEX IF NOT EXISTS "RefreshToken_expiresAt_idx"          ON "RefreshToken"("expiresAt");
