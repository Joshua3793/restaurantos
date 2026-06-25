CREATE TABLE "PrepTask" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "revenueCenterId" TEXT NOT NULL,
  "linkedInventoryItemId" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PrepTask_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PrepTaskLog" (
  "id" TEXT NOT NULL,
  "prepTaskId" TEXT NOT NULL,
  "logDate" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PrepTaskLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PrepTask_revenueCenterId_idx" ON "PrepTask"("revenueCenterId");
CREATE UNIQUE INDEX "PrepTaskLog_prepTaskId_logDate_key" ON "PrepTaskLog"("prepTaskId", "logDate");

ALTER TABLE "PrepTask" ADD CONSTRAINT "PrepTask_revenueCenterId_fkey"
  FOREIGN KEY ("revenueCenterId") REFERENCES "RevenueCenter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PrepTask" ADD CONSTRAINT "PrepTask_linkedInventoryItemId_fkey"
  FOREIGN KEY ("linkedInventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PrepTaskLog" ADD CONSTRAINT "PrepTaskLog_prepTaskId_fkey"
  FOREIGN KEY ("prepTaskId") REFERENCES "PrepTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
