-- Many-to-one Toast revenue-center → app RevenueCenter mapping.
CREATE TABLE IF NOT EXISTS "ToastRevenueCenterMap" (
  "id" TEXT NOT NULL,
  "toastGuid" TEXT NOT NULL,
  "revenueCenterId" TEXT,
  "orderCountSeen" INTEGER NOT NULL DEFAULT 0,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ToastRevenueCenterMap_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ToastRevenueCenterMap_toastGuid_key" ON "ToastRevenueCenterMap"("toastGuid");
DO $$ BEGIN
  ALTER TABLE "ToastRevenueCenterMap" ADD CONSTRAINT "ToastRevenueCenterMap_revenueCenterId_fkey"
    FOREIGN KEY ("revenueCenterId") REFERENCES "RevenueCenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
