-- CreateTable
CREATE TABLE "IPFSPin" (
    "id" TEXT NOT NULL,
    "cid" TEXT NOT NULL,
    "tokenName" TEXT,
    "tokenAddress" TEXT,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastChecked" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IPFSPin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IPFSPin_cid_key" ON "IPFSPin"("cid");

-- CreateIndex
CREATE INDEX "IPFSPin_pinned_idx" ON "IPFSPin"("pinned");

-- CreateIndex
CREATE INDEX "IPFSPin_failureCount_idx" ON "IPFSPin"("failureCount");

-- CreateIndex
CREATE INDEX "IPFSPin_tokenAddress_idx" ON "IPFSPin"("tokenAddress");
