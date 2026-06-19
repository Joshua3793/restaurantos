-- prisma/migrations/20260618120000_primary_offer_index/migration.sql
-- Enforce: at most one primary offer per inventory item.
-- Applied over the pooler via scripts/add-primary-offer-index.ts ($executeRawUnsafe);
-- Prisma cannot model a partial unique index, so this is not reflected in schema.prisma.
CREATE UNIQUE INDEX IF NOT EXISTS "InventorySupplierPrice_one_primary_per_item"
  ON "InventorySupplierPrice" ("inventoryItemId")
  WHERE "isPrimary";
