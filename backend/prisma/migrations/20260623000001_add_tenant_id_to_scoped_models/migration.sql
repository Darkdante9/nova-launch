ALTER TABLE "WebhookSubscription" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "BuybackCampaign"     ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "DividendPool"        ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

CREATE INDEX IF NOT EXISTS "WebhookSubscription_tenantId_idx" ON "WebhookSubscription"("tenantId");
CREATE INDEX IF NOT EXISTS "BuybackCampaign_tenantId_idx"     ON "BuybackCampaign"("tenantId");
CREATE INDEX IF NOT EXISTS "DividendPool_tenantId_idx"        ON "DividendPool"("tenantId");
