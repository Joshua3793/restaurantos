-- Add creation-time anchor to InventoryItem. Existing rows default to the moment
-- of this ALTER (best available; no prior creation timestamp existed).
ALTER TABLE "InventoryItem" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
