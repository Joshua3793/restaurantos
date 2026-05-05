-- AlterTable: add barcode to InventoryItem
ALTER TABLE "InventoryItem" ADD COLUMN "barcode" TEXT;

-- AlterTable: add parLevel and reorderQty to StockAllocation
ALTER TABLE "StockAllocation" ADD COLUMN "parLevel" DECIMAL(65,30);
ALTER TABLE "StockAllocation" ADD COLUMN "reorderQty" DECIMAL(65,30);
