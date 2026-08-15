-- Additive only. IF NOT EXISTS on purpose: the direct DB host was unreachable
-- when this migration was authored, so it was applied out-of-band via the
-- pooler ($executeRawUnsafe). If `migrate resolve` never records it, a later
-- `migrate deploy` re-applies it as a no-op and records it itself.

-- AlterTable
ALTER TABLE "InvoiceFile" ADD COLUMN IF NOT EXISTS "peekMeta" JSONB;

-- AlterTable
ALTER TABLE "InvoiceSession" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
