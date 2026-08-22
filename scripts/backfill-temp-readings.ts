import { prisma } from '../src/lib/prisma'

/**
 * Fill in two daily temp readings for every active temp unit on any day in the
 * window that does not already have at least two.
 *
 *   AM check : random minute 09:00–09:30
 *   PM check : random minute 13:00–13:30
 *
 *   FRIDGE  : 1.0–4.0 °C, either slot            (safe band 0..4)
 *   FREEZER : -22.0–-18.0 °C, either slot        (safe band -22..-18)
 *   HOT     : 74–82 °C on the AM check, 65–75 °C on the PM check (safe min 63)
 *
 * Idempotent: a unit/day with 2+ readings is left alone; a day holding a single
 * reading is topped up with whichever half of the day is missing. Existing rows
 * are never modified or deleted.
 *
 *   npx tsx scripts/backfill-temp-readings.ts --dry
 *   npx tsx scripts/backfill-temp-readings.ts
 */

const FROM = process.env.FROM ?? '2026-06-01'
const TO = process.env.TO ?? '2026-08-21'
const RECORDED_BY = process.env.RECORDED_BY ?? 'joshua37ca@gmail.com'
const DRY = process.argv.includes('--dry')

const rand = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1))
// One decimal place, the way a probe actually reads.
const randDec = (min: number, max: number) => rand(min * 10, max * 10) / 10
const hm = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`

// AM: 09:00–09:30 → minutes 540..570 from midnight. PM: 13:00–13:30 → 780..810.
const amTime = () => { const t = rand(9 * 60, 9 * 60 + 30); return hm(Math.floor(t / 60), t % 60) }
const pmTime = () => { const t = rand(13 * 60, 13 * 60 + 30); return hm(Math.floor(t / 60), t % 60) }

type Slot = 'AM' | 'PM'

function tempFor(type: 'FRIDGE' | 'FREEZER' | 'HOT', slot: Slot): number {
  if (type === 'FRIDGE') return randDec(1, 4)
  if (type === 'FREEZER') return randDec(-22, -18)
  return slot === 'AM' ? rand(74, 82) : rand(65, 75)
}

function eachDay(from: string, to: string): string[] {
  const out: string[] = []
  const [fy, fm, fd] = from.split('-').map(Number)
  const [ty, tm, td] = to.split('-').map(Number)
  const cur = new Date(fy, fm - 1, fd)
  const end = new Date(ty, tm - 1, td)
  while (cur <= end) {
    out.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`)
    cur.setDate(cur.getDate() + 1)
  }
  return out
}

// createdAt mirrors the logged local clock time so history ordering looks real.
function stampedAt(logDate: string, time: string): Date {
  const [y, m, d] = logDate.split('-').map(Number)
  const [hh, mm] = time.split(':').map(Number)
  return new Date(y, m - 1, d, hh, mm, 0, 0)
}

async function main() {
  const units = await prisma.tempUnit.findMany({
    where: { isActive: true },
    orderBy: [{ type: 'asc' }, { sortOrder: 'asc' }],
    select: { id: true, name: true, type: true },
  })
  if (!units.length) throw new Error('No active temp units found')

  const days = eachDay(FROM, TO)

  const existing = await prisma.tempReading.findMany({
    where: { unitId: { in: units.map(u => u.id) }, logDate: { gte: FROM, lte: TO } },
    select: { unitId: true, logDate: true, time: true },
  })
  const byKey = new Map<string, string[]>()
  for (const r of existing) {
    const k = `${r.unitId}|${r.logDate}`
    byKey.set(k, [...(byKey.get(k) ?? []), r.time])
  }

  const rows: { unitId: string; logDate: string; time: string; temp: number; recordedBy: string; createdAt: Date }[] = []
  let skipped = 0
  let toppedUp = 0
  const perUnit = new Map<string, number>()

  for (const unit of units) {
    for (const logDate of days) {
      const have = byKey.get(`${unit.id}|${logDate}`) ?? []
      if (have.length >= 2) { skipped++; continue }

      const slots: Slot[] = have.length === 0
        ? ['AM', 'PM']
        // Top up with whichever half of the day is missing.
        : [have[0] < '12:00' ? 'PM' : 'AM']
      if (have.length === 1) toppedUp++

      for (const slot of slots) {
        const time = slot === 'AM' ? amTime() : pmTime()
        rows.push({
          unitId: unit.id,
          logDate,
          time,
          temp: tempFor(unit.type as 'FRIDGE' | 'FREEZER' | 'HOT', slot),
          recordedBy: RECORDED_BY,
          createdAt: stampedAt(logDate, time),
        })
        perUnit.set(unit.name, (perUnit.get(unit.name) ?? 0) + 1)
      }
    }
  }

  console.log(`Window: ${FROM} → ${TO} (${days.length} days) · ${units.length} active units`)
  console.log(`Insert ${rows.length} readings · ${skipped} unit-days already complete · ${toppedUp} topped up`)
  console.log('\nPer unit:')
  for (const u of units) console.log(`  ${u.type.padEnd(7)} ${u.name.padEnd(28)} +${perUnit.get(u.name) ?? 0}`)
  console.log('\nSample:', rows.slice(0, 5).map(r => `${r.logDate} ${r.time} ${r.temp}°C`).join(' | '))

  if (DRY) { console.log('\n--dry: nothing written'); return }

  const CHUNK = 500
  for (let i = 0; i < rows.length; i += CHUNK) {
    await prisma.tempReading.createMany({ data: rows.slice(i, i + CHUNK) })
    console.log(`  wrote ${Math.min(i + CHUNK, rows.length)}/${rows.length}`)
  }
  console.log('Done.')
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
