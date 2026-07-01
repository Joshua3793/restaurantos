-- CreateTable
CREATE TABLE "EodCheckItem" (
    "id" TEXT NOT NULL,
    "revenueCenterId" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "meta" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isBlocker" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EodCheckItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EodClose" (
    "id" TEXT NOT NULL,
    "revenueCenterId" TEXT NOT NULL,
    "businessDate" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "handoverNote" TEXT,
    "signedOffBy" TEXT,
    "signedOffByName" TEXT,
    "signedOffAt" TIMESTAMP(3),
    "snapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EodClose_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EodCheckEntry" (
    "id" TEXT NOT NULL,
    "closeId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "updatedByName" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EodCheckEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EodCheckItem_revenueCenterId_isActive_idx" ON "EodCheckItem"("revenueCenterId", "isActive");

-- CreateIndex
CREATE INDEX "EodClose_revenueCenterId_status_idx" ON "EodClose"("revenueCenterId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "EodClose_revenueCenterId_businessDate_key" ON "EodClose"("revenueCenterId", "businessDate");

-- CreateIndex
CREATE UNIQUE INDEX "EodCheckEntry_closeId_itemId_key" ON "EodCheckEntry"("closeId", "itemId");

-- AddForeignKey
ALTER TABLE "EodCheckItem" ADD CONSTRAINT "EodCheckItem_revenueCenterId_fkey" FOREIGN KEY ("revenueCenterId") REFERENCES "RevenueCenter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EodClose" ADD CONSTRAINT "EodClose_revenueCenterId_fkey" FOREIGN KEY ("revenueCenterId") REFERENCES "RevenueCenter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EodCheckEntry" ADD CONSTRAINT "EodCheckEntry_closeId_fkey" FOREIGN KEY ("closeId") REFERENCES "EodClose"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EodCheckEntry" ADD CONSTRAINT "EodCheckEntry_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "EodCheckItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
