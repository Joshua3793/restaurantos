import { prisma } from '../../src/lib/prisma'

async function main() {
  // Idempotent: ADD COLUMN IF NOT EXISTS over the pooler (no shadow DB).
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "densityGPerMl" DECIMAL`,
  )
  const [{ count }] = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*)::bigint AS count FROM information_schema.columns
     WHERE table_name = 'InventoryItem' AND column_name = 'densityGPerMl'`,
  )
  if (Number(count) !== 1) throw new Error('densityGPerMl column not present after ALTER')
  console.log('OK: densityGPerMl present')
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
