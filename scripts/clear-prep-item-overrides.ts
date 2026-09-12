/**
 * One-off, idempotent: null the prep-item columns nothing reads any more.
 *
 * As of 2026-09-11 the run sheet's timing comes from the recipe method
 * (resolveActive in src/lib/prep-runsheet.ts has no override layer) and every
 * deadline comes from the urgency step (urgencyDeadline no longer takes a
 * per-item service). The columns stay in the schema until the follow-up drop
 * migration; clearing them now means a rollback of the code would not
 * resurrect the stale numbers (45 of 57 items carried an override copied from
 * the legacy estimatedPrepTime, 19 of them shadowing a timed method).
 *
 * Usage:  npx tsx scripts/clear-prep-item-overrides.ts [--dry]
 */
import { prisma } from '../src/lib/prisma'

async function main() {
  const dry = process.argv.includes('--dry')
  const where = {
    OR: [
      { targetServiceId: { not: null } },
      { activeMinutesOverride: { not: null } },
      { passiveMinutesOverride: { not: null } },
      { passiveNoteOverride: { not: null } },
    ],
  }
  const n = await prisma.prepItem.count({ where })
  console.log(`${n} prep item(s) still carry a service or timing override`)
  if (dry || n === 0) { await prisma.$disconnect(); return }
  const r = await prisma.prepItem.updateMany({
    where,
    data: { targetServiceId: null, activeMinutesOverride: null, passiveMinutesOverride: null, passiveNoteOverride: null },
  })
  console.log(`cleared ${r.count}`)
  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
