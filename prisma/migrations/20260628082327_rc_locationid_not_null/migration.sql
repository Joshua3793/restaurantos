-- Tighten RevenueCenter.locationId to NOT NULL after auto-wrap backfill.
ALTER TABLE "RevenueCenter" ALTER COLUMN "locationId" SET NOT NULL;
