// One-off DDL: add InvoiceSession.purchaseDate + index. Run with: npx tsx scripts/apply-purchase-date-ddl.ts
// Uses $executeRawUnsafe over the pooler — never `prisma migrate deploy` (direct DB host unreachable).
import { prisma } from '../src/lib/prisma'

async function main() {
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "InvoiceSession" ADD COLUMN IF NOT EXISTS "purchaseDate" TIMESTAMP(3)`
  )
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "InvoiceSession_purchaseDate_idx" ON "InvoiceSession"("purchaseDate")`
  )
  console.log('✓ purchaseDate column + index ensured')
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
