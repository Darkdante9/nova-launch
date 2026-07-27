-- Add last_reconciled_at column to Token table for monitoring reconciliation status.
-- Null indicates the token has never been reconciled against on-chain state.
ALTER TABLE "Token" ADD COLUMN IF NOT EXISTS "lastReconciledAt" TIMESTAMP(3);
