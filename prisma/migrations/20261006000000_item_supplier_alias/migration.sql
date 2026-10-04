-- Stage 3: one supplier's own wording (and code) for one item. Additive only —
-- InvoiceMatchRule stays (unread) until the Stage 1e drop PR.
-- Uniqueness is (supplierId, text) on the NORMALISED text (normaliseAliasText).
CREATE TABLE "ItemSupplierAlias" (
    "id" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "rawText" TEXT NOT NULL,
    "supplierItemCode" TEXT,
    "packQty" DECIMAL(65,30),
    "packSize" DECIMAL(65,30),
    "packUOM" TEXT,
    "source" TEXT NOT NULL,
    "useCount" INTEGER NOT NULL DEFAULT 1,
    "lastUsed" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ItemSupplierAlias_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ItemSupplierAlias_supplierId_text_key" ON "ItemSupplierAlias"("supplierId", "text");

CREATE INDEX "ItemSupplierAlias_supplierId_supplierItemCode_idx" ON "ItemSupplierAlias"("supplierId", "supplierItemCode");

CREATE INDEX "ItemSupplierAlias_inventoryItemId_idx" ON "ItemSupplierAlias"("inventoryItemId");

ALTER TABLE "ItemSupplierAlias" ADD CONSTRAINT "ItemSupplierAlias_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ItemSupplierAlias" ADD CONSTRAINT "ItemSupplierAlias_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
