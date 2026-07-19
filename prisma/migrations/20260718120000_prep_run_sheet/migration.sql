ALTER TABLE "Recipe" ADD COLUMN "activeMinutes" INTEGER, ADD COLUMN "passiveMinutes" INTEGER, ADD COLUMN "passiveNote" TEXT;
ALTER TABLE "PrepItem" ADD COLUMN "targetServiceId" TEXT, ADD COLUMN "activeMinutesOverride" INTEGER, ADD COLUMN "passiveMinutesOverride" INTEGER, ADD COLUMN "passiveNoteOverride" TEXT;
ALTER TABLE "PrepLog" ADD COLUMN "startedAt" TIMESTAMP(3), ADD COLUMN "completedAt" TIMESTAMP(3);
CREATE TABLE "Service" ("id" TEXT NOT NULL, "revenueCenterId" TEXT NOT NULL, "name" TEXT NOT NULL, "timeMinutes" INTEGER NOT NULL, "sortOrder" INTEGER NOT NULL DEFAULT 0, "isActive" BOOLEAN NOT NULL DEFAULT true, CONSTRAINT "Service_pkey" PRIMARY KEY ("id"));
CREATE INDEX "Service_revenueCenterId_idx" ON "Service"("revenueCenterId");
CREATE TABLE "Cook" ("id" TEXT NOT NULL, "name" TEXT NOT NULL, "initials" TEXT NOT NULL, "homeStation" TEXT, "isActive" BOOLEAN NOT NULL DEFAULT true, "sortOrder" INTEGER NOT NULL DEFAULT 0, CONSTRAINT "Cook_pkey" PRIMARY KEY ("id"));
ALTER TABLE "Service" ADD CONSTRAINT "Service_revenueCenterId_fkey" FOREIGN KEY ("revenueCenterId") REFERENCES "RevenueCenter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PrepItem" ADD CONSTRAINT "PrepItem_targetServiceId_fkey" FOREIGN KEY ("targetServiceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;
