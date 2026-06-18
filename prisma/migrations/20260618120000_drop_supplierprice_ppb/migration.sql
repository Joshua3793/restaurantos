-- Offer divergence contract step. Drop the cached pricePerBaseUnit on
-- InventorySupplierPrice — fully replaced by chain-derived offerPricePerBase().
-- Applied via $executeRawUnsafe over the pooler (direct host unreachable),
-- AFTER the field-removed schema is deployed (scripts/drop-supplierprice-ppb.ts).
-- Safe: the deployed Prisma client no longer selects this column.
ALTER TABLE "InventorySupplierPrice" DROP COLUMN IF EXISTS "pricePerBaseUnit";
