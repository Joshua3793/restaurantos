-- Additive only. IF NOT EXISTS on purpose: applied out-of-band via the session
-- pooler when authored (the direct host is unreachable from dev machines). If
-- `migrate resolve` never records it, `migrate deploy` re-applies it as a no-op.

-- AlterTable
ALTER TABLE "InvoiceSession" ADD COLUMN IF NOT EXISTS "groupingDraft" JSONB;
