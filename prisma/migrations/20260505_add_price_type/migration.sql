-- AddColumn
ALTER TABLE "InventoryItem" ADD COLUMN "priceType" TEXT NOT NULL DEFAULT 'CASE';
