/**
 * EXPAND step for retiring InventorySupplierPrice.pricePerBaseUnit.
 * Drops the NOT NULL constraint so the chain-only code (which stops writing this
 * column) and the rebuilt backfill (which inserts NULL) don't violate it.
 * SAFE while old code is live — it only relaxes the constraint. Run this BEFORE
 * deploying the branch and BEFORE running backfill-supplier-offers.ts.
 * Uses $executeRawUnsafe over the pgBouncer pooler (direct host unreachable).
 * Run: TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/alter-supplierprice-ppb-nullable.ts
 */
import { prisma } from '../src/lib/prisma'

async function main() {
  const stmt = `ALTER TABLE "InventorySupplierPrice" ALTER COLUMN "pricePerBaseUnit" DROP NOT NULL`
  console.log(stmt)
  await prisma.$executeRawUnsafe(stmt)
  console.log('\nInventorySupplierPrice.pricePerBaseUnit is now nullable.')
  await prisma.$disconnect()
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
