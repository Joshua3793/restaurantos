-- AlterTable
ALTER TABLE "InventorySupplierPrice" ADD COLUMN     "lastInvoiceSessionId" TEXT,
ADD COLUMN     "packQty" DECIMAL(65,30),
ADD COLUMN     "packSize" DECIMAL(65,30),
ADD COLUMN     "packUOM" TEXT,
ADD COLUMN     "supplierItemCode" TEXT;

-- Dedupe before unique constraint: keep the most recently updated row per (item, supplier)
DELETE FROM "InventorySupplierPrice" a
USING "InventorySupplierPrice" b
WHERE a."inventoryItemId" = b."inventoryItemId"
  AND a."supplierName"    = b."supplierName"
  AND (a."lastUpdated" < b."lastUpdated"
       OR (a."lastUpdated" = b."lastUpdated" AND a."id" < b."id"));

-- CreateIndex
CREATE UNIQUE INDEX "InventorySupplierPrice_inventoryItemId_supplierName_key" ON "InventorySupplierPrice"("inventoryItemId", "supplierName");

-- CreateIndex
CREATE INDEX "InvoiceScanItem_matchedItemId_idx" ON "InvoiceScanItem"("matchedItemId");

