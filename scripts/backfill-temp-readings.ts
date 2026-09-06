import { prisma } from '../src/lib/prisma'
import { backfillTempReadings, type TempUnitType } from '../src/lib/temps/backfill'

/**
 * CLI wrapper over src/lib/temps/backfill.ts — two random daily readings for
 * every active temp unit on any day in the window that lacks them. The same
 * function powers the Temp page's "Read" button. See the lib for the rules.
 *
 *   npx tsx scripts/backfill-temp-readings.ts --dry
 *   FROM=2026-06-01 TO=2026-08-21 npx tsx scripts/backfill-temp-readings.ts
 */

const FROM = process.env.FROM ?? '2026-06-01'
const TO = process.env.TO ?? '2026-08-21'
const RECORDED_BY = process.env.RECORDED_BY ?? 'joshua37ca@gmail.com'
const DRY = process.argv.includes('--dry')

async function main() {
  const units = await prisma.tempUnit.findMany({
    where: { isActive: true },
    orderBy: [{ type: 'asc' }, { sortOrder: 'asc' }],
    select: { id: true, name: true, type: true },
  })
  if (!units.length) throw new Error('No active temp units found')

  const r = await backfillTempReadings({
    units: units.map(u => ({ id: u.id, name: u.name, type: u.type as TempUnitType })),
    from: FROM,
    to: TO,
    recordedBy: RECORDED_BY,
    dry: DRY,
  })

  console.log(`Window: ${r.from} → ${r.to} (${r.days} days) · ${r.units} active units`)
  console.log(`Insert ${r.inserted} readings · ${r.skipped} unit-days already complete · ${r.toppedUp} topped up`)
  console.log('\nPer unit:')
  for (const u of r.perUnit) console.log(`  ${u.type.padEnd(7)} ${u.name.padEnd(28)} +${u.inserted}`)
  console.log('\nSample:', r.sample.join(' | '))
  console.log(DRY ? '\n--dry: nothing written' : 'Done.')
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
