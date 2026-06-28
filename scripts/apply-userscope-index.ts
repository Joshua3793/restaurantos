// scripts/apply-userscope-index.ts
// Adds a NULLS NOT DISTINCT unique index on UserScope over the pgBouncer pooler.
//
// WHY: the Prisma @@unique([userId, locationId, revenueCenterId]) does NOT
// prevent duplicate rows when a column is NULL — Postgres treats NULLs as
// distinct. Every UserScope row has exactly ONE of locationId/revenueCenterId
// set (the other NULL), so that unique index never actually blocks duplicates.
// Postgres 15+ NULLS NOT DISTINCT closes the gap. Prisma can't express it, so
// this raw index (out-of-band) is the source of truth.
//
// DDL over the pooler uses $executeRawUnsafe (transaction mode rejects named
// prepared statements — never use $executeRaw tagged templates for DDL).
//
// Run: npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/apply-userscope-index.ts

import { prisma } from '../src/lib/prisma'

const INDEX_NAME = 'UserScope_user_node_unique'
const DDL = `CREATE UNIQUE INDEX IF NOT EXISTS "${INDEX_NAME}" ON "UserScope" ("userId", "locationId", "revenueCenterId") NULLS NOT DISTINCT`

async function main() {
  // 1) guard: refuse to create the index if duplicate rows already exist
  const dups = (await prisma.$queryRawUnsafe(
    `SELECT "userId", "locationId", "revenueCenterId", COUNT(*)::int AS n
       FROM "UserScope"
      GROUP BY "userId", "locationId", "revenueCenterId"
     HAVING COUNT(*) > 1`,
  )) as Array<Record<string, unknown>>

  if (dups.length > 0) {
    console.error('ABORT — existing duplicate UserScope rows would block the index:')
    console.error(JSON.stringify(dups, null, 2))
    process.exit(1)
  }
  console.log('no duplicate rows — safe to create the index')

  // 2) create the index
  await prisma.$executeRawUnsafe(DDL)
  console.log('applied:', DDL)

  // 3) verify it exists
  const rows = await prisma.$queryRawUnsafe(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'UserScope' AND indexname = '${INDEX_NAME}'`,
  )
  console.log('index check:', JSON.stringify(rows, null, 2))
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
