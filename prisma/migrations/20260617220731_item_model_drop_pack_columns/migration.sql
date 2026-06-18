-- Item Model Redesign — final contract step. Drop the 8 legacy pack columns now
-- fully replaced by the pack chain (dimension/packChain/pricing/countUnit).
-- Applied via $executeRawUnsafe over the pooler (direct host unreachable).
-- Safe: the deployed Prisma client no longer selects these columns.
ALTER TABLE "InventoryItem" DROP COLUMN IF EXISTS "purchaseUnit";
ALTER TABLE "InventoryItem" DROP COLUMN IF EXISTS "qtyPerPurchaseUnit";
ALTER TABLE "InventoryItem" DROP COLUMN IF EXISTS "packSize";
ALTER TABLE "InventoryItem" DROP COLUMN IF EXISTS "packUOM";
ALTER TABLE "InventoryItem" DROP COLUMN IF EXISTS "qtyUOM";
ALTER TABLE "InventoryItem" DROP COLUMN IF EXISTS "innerQty";
ALTER TABLE "InventoryItem" DROP COLUMN IF EXISTS "priceType";
ALTER TABLE "InventoryItem" DROP COLUMN IF EXISTS "countUOM";
