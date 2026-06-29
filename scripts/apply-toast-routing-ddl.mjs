// scripts/apply-toast-routing-ddl.mjs
// Applies the Toast location-routing DDL (/tmp/toast-mig.sql) over the pgBouncer
// pooler using $executeRawUnsafe (transaction mode rejects named prepared
// statements, so never use $executeRaw tagged templates for DDL).
//
// The DDL is additive only:
//   ALTER TABLE "Location" ADD COLUMN "defaultRevenueCenterId" TEXT
//   ALTER TABLE "ToastRevenueCenterMap" ADD COLUMN "locationId" TEXT
//   + the two FK constraints.
// Re-running is tolerated: "already exists" (42P07/42710/42701) errors are
// treated as no-ops so a partial first run can be resumed safely.
//
// Run: set -a; . ./.env; set +a; node scripts/apply-toast-routing-ddl.mjs

import { readFileSync } from 'fs'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const ALREADY_EXISTS = ['42P07', '42710', '42701'] // duplicate table / object / column

async function main() {
  const sql = readFileSync('/tmp/toast-mig.sql', 'utf8')
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
    } catch (e) {
      // FK constraint "already exists" surfaces as 42710 (duplicate object)
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

  // verify the new columns exist (cast to ::text to avoid deserialize issues)
  const rows = await prisma.$queryRawUnsafe(
    `SELECT table_name::text, column_name::text, data_type::text
       FROM information_schema.columns
      WHERE (table_name = 'Location' AND column_name = 'defaultRevenueCenterId')
         OR (table_name = 'ToastRevenueCenterMap' AND column_name = 'locationId')
      ORDER BY table_name, column_name`
  )
  console.log('column check:', JSON.stringify(rows))
}

main()
  .then(() => prisma.$disconnect().then(() => process.exit(0)))
  .catch((e) => {
    console.error(e)
    prisma.$disconnect().finally(() => process.exit(1))
  })
