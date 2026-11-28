-- Round 5: count in shelf order + photos on waste and flagged checklist lines.
-- Additive, nullable: safe to apply before the code that reads them.
ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "shelfOrder" INTEGER;
ALTER TABLE "WastageLog" ADD COLUMN IF NOT EXISTS "photoUrl" TEXT;
ALTER TABLE "ChecklistRunLine" ADD COLUMN IF NOT EXISTS "flagPhotoUrl" TEXT;
