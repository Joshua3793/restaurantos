-- AlterTable
ALTER TABLE "RevenueCenter" ADD COLUMN     "locationId" TEXT,
ADD COLUMN     "targetCostPct" DECIMAL(65,30),
ALTER COLUMN "type" SET DEFAULT 'FOOD';

-- CreateTable
CREATE TABLE "Location" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'restaurant',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "managerName" TEXT,
    "notes" TEXT,
    "schedulingMode" TEXT NOT NULL DEFAULT 'FIXED',
    "prepLeadMinutes" INTEGER,
    "serviceSchedule" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserScope" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "locationId" TEXT,
    "revenueCenterId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserScope_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserScope_userId_idx" ON "UserScope"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserScope_userId_locationId_revenueCenterId_key" ON "UserScope"("userId", "locationId", "revenueCenterId");

-- AddForeignKey
ALTER TABLE "RevenueCenter" ADD CONSTRAINT "RevenueCenter_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserScope" ADD CONSTRAINT "UserScope_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserScope" ADD CONSTRAINT "UserScope_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserScope" ADD CONSTRAINT "UserScope_revenueCenterId_fkey" FOREIGN KEY ("revenueCenterId") REFERENCES "RevenueCenter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

