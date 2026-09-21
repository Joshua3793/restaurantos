ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "mergedIntoId" TEXT;
DO $$ BEGIN
  ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_mergedIntoId_fkey"
    FOREIGN KEY ("mergedIntoId") REFERENCES "InventoryItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "InvoiceScanItem" ADD COLUMN IF NOT EXISTS "receivedQtyBase" DECIMAL(65,30);

CREATE TABLE IF NOT EXISTS "ItemMerge" (
  "id" TEXT NOT NULL,
  "survivorId" TEXT NOT NULL,
  "absorbedId" TEXT NOT NULL,
  "mergedBy" TEXT NOT NULL,
  "mergedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "undoneAt" TIMESTAMP(3),
  "manifest" JSONB NOT NULL,
  CONSTRAINT "ItemMerge_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ItemMerge_survivorId_idx" ON "ItemMerge"("survivorId");
CREATE INDEX IF NOT EXISTS "ItemMerge_absorbedId_idx" ON "ItemMerge"("absorbedId");
