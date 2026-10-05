-- The opening checklist (cook start page). Additive only: two new tables, no
-- existing table or row is touched.
CREATE TABLE "OpenCheckItem" (
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
    CONSTRAINT "OpenCheckItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OpenCheckTick" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "businessDate" TEXT NOT NULL,
    "doneByName" TEXT,
    "doneAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OpenCheckTick_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OpenCheckItem_revenueCenterId_isActive_idx" ON "OpenCheckItem"("revenueCenterId", "isActive");

CREATE UNIQUE INDEX "OpenCheckTick_itemId_businessDate_key" ON "OpenCheckTick"("itemId", "businessDate");

ALTER TABLE "OpenCheckItem" ADD CONSTRAINT "OpenCheckItem_revenueCenterId_fkey" FOREIGN KEY ("revenueCenterId") REFERENCES "RevenueCenter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OpenCheckTick" ADD CONSTRAINT "OpenCheckTick_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "OpenCheckItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
