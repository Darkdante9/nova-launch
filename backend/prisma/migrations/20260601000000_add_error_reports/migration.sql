-- CreateTable
CREATE TABLE "ErrorReport" (
    "id" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "componentStack" TEXT,
    "txHash" TEXT,
    "ledgerSequence" INTEGER,
    "walletAddress" TEXT,
    "route" TEXT,
    "network" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErrorReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ErrorReport_createdAt_idx" ON "ErrorReport"("createdAt");

-- CreateIndex
CREATE INDEX "ErrorReport_txHash_idx" ON "ErrorReport"("txHash");

-- CreateIndex
CREATE INDEX "ErrorReport_walletAddress_idx" ON "ErrorReport"("walletAddress");
