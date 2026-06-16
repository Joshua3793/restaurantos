-- Item Model Redesign — drop the two CACHED derivations now computed on-read
-- from packChain/pricing. ONLY these two columns; all other legacy fields stay
-- (count/UOM conversion code still reads them). Hand-authored; NOT migrate diff.
-- Applied via $executeRawUnsafe over the pooler (direct host unreachable).
ALTER TABLE "InventoryItem" DROP COLUMN IF EXISTS "pricePerBaseUnit";
ALTER TABLE "InventoryItem" DROP COLUMN IF EXISTS "conversionFactor";
