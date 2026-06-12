ALTER TABLE "PrepItem" ADD COLUMN "revenueCenterId" TEXT;
ALTER TABLE "PrepLog"  ADD COLUMN "revenueCenterId" TEXT;
ALTER TABLE "PrepItem" ADD CONSTRAINT "PrepItem_revenueCenterId_fkey"
  FOREIGN KEY ("revenueCenterId") REFERENCES "RevenueCenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PrepLog" ADD CONSTRAINT "PrepLog_revenueCenterId_fkey"
  FOREIGN KEY ("revenueCenterId") REFERENCES "RevenueCenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;
