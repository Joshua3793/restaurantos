-- Smart Prep v2 planner: draft order + posted membership on PrepLog, and the
-- per-RC-per-day posted-list header (PrepPost). Hand-trimmed from `migrate diff`
-- output — the raw diff also carried unrelated live-DB drift (FK re-creates,
-- Decimal precision) that must NOT ship here.

-- AlterTable
ALTER TABLE "PrepLog" ADD COLUMN     "listOrder" INTEGER,
ADD COLUMN     "postedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PrepPost" (
    "id" TEXT NOT NULL,
    "revenueCenterId" TEXT NOT NULL,
    "listDate" TIMESTAMP(3) NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL,
    "postedByName" TEXT NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "activeMinutes" INTEGER NOT NULL DEFAULT 0,
    "dirty" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PrepPost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PrepPost_revenueCenterId_listDate_key" ON "PrepPost"("revenueCenterId", "listDate");

-- AddForeignKey
ALTER TABLE "PrepPost" ADD CONSTRAINT "PrepPost_revenueCenterId_fkey" FOREIGN KEY ("revenueCenterId") REFERENCES "RevenueCenter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
