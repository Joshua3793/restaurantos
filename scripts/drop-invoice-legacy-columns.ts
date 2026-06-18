/**
 * Drops the four legacy format/mode-mismatch columns from InvoiceScanItem.
 * Run: TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/drop-invoice-legacy-columns.ts
 *   (tsconfig.scripts.json supplies the baseUrl that tsconfig-paths needs to resolve the @/* alias.)
 *
 * ⚠️ EXPAND-CONTRACT — RUN ONLY AFTER feat/invoice-page-rework IS DEPLOYED.
 * The live Supabase DB is shared with production. Until the schema-trimmed code
 * is the running build, production reads these columns; dropping them first 500s
 * production. The columns have @default values and are no longer read/written by
 * the deployed code, so the DB tolerates them sitting unused until this runs.
 *
 * Uses $executeRawUnsafe over the pgBouncer pooler (transaction mode) because the
 * direct DB host is unreachable from this environment and `prisma migrate diff`
 * against a full schema fails (see memory project_prisma_migrate_shadow_broken).
 *
 * NOTE: InvoiceLineItem is intentionally NOT dropped — it is still referenced by
 * inventory delete-semantics (inventory/[id] block-if-referenced count + bulk
 * cascade). Dropping it is a separate change.
 */
import { prisma } from '../src/lib/prisma'

async function main() {
  const stmts = [
    `ALTER TABLE "InvoiceScanItem" DROP COLUMN IF EXISTS "formatMismatch"`,
    `ALTER TABLE "InvoiceScanItem" DROP COLUMN IF EXISTS "needsFormatConfirm"`,
    `ALTER TABLE "InvoiceScanItem" DROP COLUMN IF EXISTS "applyInvoiceFormat"`,
    `ALTER TABLE "InvoiceScanItem" DROP COLUMN IF EXISTS "rawPriceType"`,
  ]
  for (const s of stmts) {
    console.log(s)
    await prisma.$executeRawUnsafe(s)
  }
  console.log('\nDropped 4 legacy columns from InvoiceScanItem.')
  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
