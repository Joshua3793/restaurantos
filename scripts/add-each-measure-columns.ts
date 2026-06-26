// One-off DDL: add the count↔weight bridge columns. Run with: npx tsx scripts/add-each-measure-columns.ts
// Uses $executeRawUnsafe over the pooler — never `prisma migrate diff` (direct DB host unreachable).
import { prisma } from '../src/lib/prisma'

async function main() {
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "eachMeasureQty" DECIMAL`
  )
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "eachMeasureUnit" TEXT`
  )
  console.log('✓ eachMeasureQty / eachMeasureUnit columns ensured')
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
