-- AlterTable
ALTER TABLE "InventoryItem" ADD COLUMN "qtyUOM" TEXT NOT NULL DEFAULT 'each';
ALTER TABLE "InventoryItem" ADD COLUMN "innerQty" DECIMAL(65,30);
ALTER TABLE "InventoryItem" ADD COLUMN "needsReview" BOOLEAN NOT NULL DEFAULT false;
