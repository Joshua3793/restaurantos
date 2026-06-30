// scripts/apply-location-default-index.ts
// Adds a partial unique index so the DB guarantees AT MOST ONE default Location
// (mirrors the primary-offer partial-unique pattern). Applied over the pgBouncer
// pooler via $executeRawUnsafe (transaction mode rejects named prepared
// statements). Re-running is tolerated (IF NOT EXISTS).
//
// Run: npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/apply-location-default-index.ts

import { prisma } from '../src/lib/prisma'

const DDL = `CREATE UNIQUE INDEX IF NOT EXISTS "Location_one_default" ON "Location" ("isDefault") WHERE "isDefault";`

async function main() {
  // Safety: confirm existing data has at most one default before creating the index.
  const pre = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT COUNT(*)::bigint AS count FROM "Location" WHERE "isDefault" = true`
  )
  const defaults = Number(pre[0].count)
  console.log('default Locations before index:', defaults)
  if (defaults > 1) {
    throw new Error(`Refusing to create index: ${defaults} default Locations exist (must be <= 1).`)
  }

  await prisma.$executeRawUnsafe(DDL)
  console.log('applied:', DDL)

  // verify the index exists
  const rows = await prisma.$queryRawUnsafe(
    `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'Location' AND indexname = 'Location_one_default'`
  )
  console.log('index check:', JSON.stringify(rows))
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1) })
