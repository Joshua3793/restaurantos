-- CreateEnum
CREATE TYPE "TempUnitType" AS ENUM ('FRIDGE', 'FREEZER', 'HOT');

-- CreateTable
CREATE TABLE "TempUnit" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "TempUnitType" NOT NULL,
    "safeMin" DECIMAL(65,30),
    "safeMax" DECIMAL(65,30),
    "revenueCenterId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TempUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TempReading" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "logDate" TEXT NOT NULL,
    "time" TEXT NOT NULL,
    "temp" DECIMAL(65,30) NOT NULL,
    "recordedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TempReading_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TempUnit_revenueCenterId_isActive_idx" ON "TempUnit"("revenueCenterId", "isActive");

-- CreateIndex
CREATE INDEX "TempReading_unitId_logDate_idx" ON "TempReading"("unitId", "logDate");

-- AddForeignKey
ALTER TABLE "TempUnit" ADD CONSTRAINT "TempUnit_revenueCenterId_fkey" FOREIGN KEY ("revenueCenterId") REFERENCES "RevenueCenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TempReading" ADD CONSTRAINT "TempReading_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "TempUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

