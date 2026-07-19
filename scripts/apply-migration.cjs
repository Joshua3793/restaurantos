/**
 * Apply a hand-written migration over the POOLER and record it in _prisma_migrations.
 *
 *   node scripts/apply-migration.cjs prisma/migrations/<name>
 *
 * The direct Postgres host is intermittently unresolvable from this environment, so
 * `prisma db execute --url $DIRECT_URL` / `prisma migrate resolve` can't be used.
 * pgBouncer (transaction mode) rejects named prepared statements, so every statement
 * goes through $executeRawUnsafe — never the tagged-template $executeRaw.
 * Idempotent: re-running is a no-op when the migration is already recorded.
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { PrismaClient } = require('@prisma/client')

const dir = process.argv[2]
if (!dir) { console.error('usage: node scripts/apply-migration.cjs <migration-dir>'); process.exit(1) }
const name = path.basename(dir)
if (!/^[0-9]{14}_[a-z0-9_]+$/.test(name)) {
  console.error(`invalid migration name: "${name}" (expected <14-digit timestamp>_<snake_case>, e.g. 20260719143538_service_end_minutes)`)
  process.exit(1)
}
const sqlPath = path.join(dir, 'migration.sql')
const sql = fs.readFileSync(sqlPath, 'utf8')
const checksum = crypto.createHash('sha256').update(sql).digest('hex')

// Drop full-line comments, join the remaining lines back into one string, then
// split globally on every ';'. This is a naive statement splitter: a semicolon
// inside a string literal or a dollar-quoted body (e.g. `$$ ... ; ... $$`)
// would be split incorrectly. Migrations fed to this runner must therefore be
// plain statements with no embedded semicolons.
const statements = sql
  .split('\n')
  .filter(l => !l.trim().startsWith('--'))
  .join('\n')
  .split(';')
  .map(s => s.trim())
  .filter(Boolean)

const prisma = new PrismaClient()

;(async () => {
  const already = await prisma.$queryRawUnsafe(
    `SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '${name}' AND rolled_back_at IS NULL LIMIT 1`,
  )
  if (already.length) { console.log(`already applied: ${name}`); return }

  // Interactive transaction: Prisma holds one dedicated connection for the
  // whole callback, so this is atomic even under pgBouncer transaction-mode
  // pooling. Do not use bare BEGIN/COMMIT via separate $executeRawUnsafe
  // calls instead — those could land on different pooled backend
  // connections and would not actually be transactional.
  await prisma.$transaction(async (tx) => {
    for (const stmt of statements) {
      console.log(`> ${stmt.split('\n')[0].slice(0, 100)}`)
      await tx.$executeRawUnsafe(stmt)
    }

    await tx.$executeRawUnsafe(
      `INSERT INTO "_prisma_migrations"
         (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
       VALUES
         ('${crypto.randomUUID()}', '${checksum}', now(), '${name}', NULL, NULL, now(), ${statements.length})`,
    )
  })
  console.log(`applied + recorded: ${name} (${statements.length} statement(s))`)
})()
  .catch(e => { console.error('FAILED:', e.message); process.exit(1) })
  .finally(() => prisma.$disconnect())
