-- ItemOffer semantics: per-supplier-offer pack chain + pricing (ppb derived on read).
ALTER TABLE "InventorySupplierPrice" ADD COLUMN IF NOT EXISTS "packChain" JSONB;
ALTER TABLE "InventorySupplierPrice" ADD COLUMN IF NOT EXISTS "pricing" JSONB;
