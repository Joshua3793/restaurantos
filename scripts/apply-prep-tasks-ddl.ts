import { readFileSync } from 'fs'
import { prisma } from '../src/lib/prisma'

async function main() {
  const sql = readFileSync('prisma/migrations/20260625000000_prep_tasks/migration.sql', 'utf8')
  const statements = sql.split(';').map(s => s.trim()).filter(Boolean)
  for (const stmt of statements) {
    console.log('apply:', stmt.slice(0, 60).replace(/\s+/g, ' '), '…')
    await prisma.$executeRawUnsafe(stmt)
  }
  console.log('done')
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
