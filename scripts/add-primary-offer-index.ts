// scripts/add-primary-offer-index.ts
// Creates the partial unique index enforcing one primary offer per item, over
// the pgBouncer pooler. Idempotent (IF NOT EXISTS). Run AFTER backfill dedupes
// primaries, else it errors on rows with two primaries.
//
// Run: TS_NODE_BASEURL=. npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/add-primary-offer-index.ts

import { prisma } from '../src/lib/prisma'

async function main() {
  await prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "InventorySupplierPrice_one_primary_per_item" ` +
    `ON "InventorySupplierPrice" ("inventoryItemId") WHERE "isPrimary";`
  )
  console.log('Created partial unique index InventorySupplierPrice_one_primary_per_item.')
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
