-- RevenueCenter→Location FK: ON DELETE RESTRICT (was SET NULL, which conflicts
-- with the now-NOT NULL locationId column).
ALTER TABLE "RevenueCenter" DROP CONSTRAINT "RevenueCenter_locationId_fkey";
ALTER TABLE "RevenueCenter" ADD CONSTRAINT "RevenueCenter_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
