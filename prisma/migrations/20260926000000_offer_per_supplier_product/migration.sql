-- One offer per supplier PRODUCT (SKU), not per supplier. A merged item keeps
-- each supplier SKU's own pack; the old (item, supplier) key forced a merge to
-- drop all but one of them. Blank SKU = '' so legacy uncoded rows still collide.
ALTER TABLE "InventorySupplierPrice" DROP CONSTRAINT IF EXISTS "InventorySupplierPrice_inventoryItemId_supplierName_key";
DROP INDEX IF EXISTS "InventorySupplierPrice_inventoryItemId_supplierName_key";
CREATE UNIQUE INDEX "InventorySupplierPrice_item_supplier_sku_key"
  ON "InventorySupplierPrice" ("inventoryItemId", "supplierName", (COALESCE("supplierItemCode", '')));
CREATE INDEX "InventorySupplierPrice_inventoryItemId_supplierName_idx"
  ON "InventorySupplierPrice" ("inventoryItemId", "supplierName");
