-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "defaultRevenueCenterId" TEXT;

-- AlterTable
ALTER TABLE "ToastRevenueCenterMap" ADD COLUMN     "locationId" TEXT;

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_defaultRevenueCenterId_fkey" FOREIGN KEY ("defaultRevenueCenterId") REFERENCES "RevenueCenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToastRevenueCenterMap" ADD CONSTRAINT "ToastRevenueCenterMap_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

