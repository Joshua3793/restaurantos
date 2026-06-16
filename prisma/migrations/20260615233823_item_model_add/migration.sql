-- Item Model Redesign — additive only. Adds the pack-chain columns to
-- InventoryItem. NO drops, NO data loss. Coexists with the legacy pricing
-- fields during the migration. Hand-authored (NOT via full-schema migrate diff,
-- which diverges from this branch's stale schema.prisma).
CREATE TYPE "Dimension" AS ENUM ('MASS', 'VOLUME', 'COUNT');

ALTER TABLE "InventoryItem"
  ADD COLUMN "dimension" "Dimension" NOT NULL DEFAULT 'COUNT',
  ADD COLUMN "packChain" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "pricing"   JSONB NOT NULL DEFAULT '{"mode":"PACK","purchasePrice":0}',
  ADD COLUMN "countUnit" TEXT  NOT NULL DEFAULT 'each';
