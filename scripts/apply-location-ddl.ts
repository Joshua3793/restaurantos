// scripts/apply-location-ddl.ts
// Applies the Location-hierarchy DDL (/tmp/loc-mig.sql) over the pgBouncer
// pooler using $executeRawUnsafe (transaction mode rejects named prepared
// statements, so never use $executeRaw tagged templates for DDL).
//
// The DDL is additive only (CREATE TABLE Location/UserScope, ADD COLUMN
// locationId/targetCostPct on RevenueCenter, ALTER type default, indexes + FKs).
// Re-running is tolerated: "already exists" (42P07/42710/42701) errors are
// treated as no-ops so a partial first run can be resumed safely.
//
// Run: npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/apply-location-ddl.ts

import { readFileSync } from 'fs'
import { prisma } from '../src/lib/prisma'

const ALREADY_EXISTS = ['42P07', '42710', '42701'] // duplicate table / object / column

async function main() {
  const sql = readFileSync('/tmp/loc-mig.sql', 'utf8')
  // split on statement terminators, drop comments/blanks
  const stmts = sql
    .split(/;\s*$/m)
    .map((s) => s.replace(/--.*$/gm, '').trim())
    .filter((s) => s.length > 0)

  let applied = 0
  let skipped = 0
  for (const stmt of stmts) {
    const label = stmt.slice(0, 80).replace(/\n/g, ' ')
    try {
      await prisma.$executeRawUnsafe(stmt)
      console.log('applied:', label, '...')
      applied++
    } catch (e: any) {
      if (e?.code && ALREADY_EXISTS.includes(e.code)) {
        console.log('skip (exists):', label, '...')
        skipped++
        continue
      }
      console.error('FAILED:', label)
      throw e
    }
  }
  console.log(`done — ${applied} applied, ${skipped} skipped (already existed)`)

  // verify the new tables exist in the live DB (cast regclass→text; Prisma
  // can't deserialize the raw regclass type)
  const rows = await prisma.$queryRawUnsafe(
    `SELECT to_regclass('public."Location"')::text AS location, to_regclass('public."UserScope"')::text AS user_scope`
  )
  console.log('table check:', JSON.stringify(rows))
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
