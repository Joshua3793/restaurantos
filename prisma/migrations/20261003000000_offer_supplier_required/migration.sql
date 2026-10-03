-- Every supplier box links to its supplier; the one-offer-per-supplier-product
-- key moves from the free-text supplierName to supplierId. supplierName stays as
-- display/provenance. Backfill (scripts/backfill-offer-supplier-fk.ts) ran first;
-- SET NOT NULL below fails loudly if any NULL remains.
ALTER TABLE "InventorySupplierPrice" ALTER COLUMN "supplierId" SET NOT NULL;
ALTER TABLE "InventorySupplierPrice" DROP CONSTRAINT IF EXISTS "InventorySupplierPrice_supplierId_fkey";
ALTER TABLE "InventorySupplierPrice" ADD CONSTRAINT "InventorySupplierPrice_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
DROP INDEX IF EXISTS "InventorySupplierPrice_item_supplier_sku_key";
DROP INDEX IF EXISTS "InventorySupplierPrice_inventoryItemId_supplierName_idx";
CREATE UNIQUE INDEX "InventorySupplierPrice_item_supplier_sku_key" ON "InventorySupplierPrice" ("inventoryItemId", "supplierId", (COALESCE("supplierItemCode", '')));
CREATE INDEX "InventorySupplierPrice_inventoryItemId_supplierId_idx" ON "InventorySupplierPrice" ("inventoryItemId", "supplierId");
