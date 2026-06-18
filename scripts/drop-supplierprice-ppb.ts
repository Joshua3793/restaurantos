/**
 * CONTRACT step — drops the cached pricePerBaseUnit column from InventorySupplierPrice.
 * ⚠️ RUN ONLY AFTER the schema-trimmed code is DEPLOYED and verify-offer-ppb-parity passes.
 * Uses $executeRawUnsafe over the pgBouncer pooler (direct host unreachable;
 * prisma migrate diff against the full schema fails — see project_prisma_migrate_shadow_broken).
 * Run: TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/drop-supplierprice-ppb.ts
 */
import { prisma } from '../src/lib/prisma'

async function main() {
  const stmt = `ALTER TABLE "InventorySupplierPrice" DROP COLUMN IF EXISTS "pricePerBaseUnit"`
  console.log(stmt)
  await prisma.$executeRawUnsafe(stmt)
  console.log('\nDropped pricePerBaseUnit from InventorySupplierPrice.')
  await prisma.$disconnect()
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
