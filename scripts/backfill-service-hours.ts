/**
 * One-off, idempotent backfill: carry RevenueCenter.serviceSchedule (legacy JSON
 * weekday windows) into the Service model, which becomes the single source of
 * service type + hours.
 *
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/backfill-service-hours.ts
 *
 * Non-destructive: fills missing endMinutes and creates missing Service rows.
 * Never deletes or overwrites an endMinutes that is already set.
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

type Window = { label?: string; start?: string; end?: string }

const toMin = (hm: string | undefined): number | null => {
  if (!hm) return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim())
  if (!m) return null
  const h = Number(m[1]), mm = Number(m[2])
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null
  return h * 60 + mm
}

const hhmm = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`

/** Distinct windows across the whole week, keyed by label+start+end. */
function distinctWindows(schedule: unknown): { name: string; start: number; end: number | null }[] {
  if (!schedule || typeof schedule !== 'object') return []
  const out = new Map<string, { name: string; start: number; end: number | null }>()
  for (const list of Object.values(schedule as Record<string, Window[]>)) {
    if (!Array.isArray(list)) continue
    for (const w of list) {
      const start = toMin(w.start)
      if (start == null) continue
      const end = toMin(w.end)
      const name = (w.label || '').trim() || 'Service'
      out.set(`${name}|${start}|${end}`, { name, start, end })
    }
  }
  return [...out.values()].sort((a, b) => a.start - b.start)
}

async function main() {
  const rcs = await prisma.revenueCenter.findMany({
    select: { id: true, name: true, serviceSchedule: true, services: true },
  })

  let filled = 0, created = 0
  for (const rc of rcs) {
    const windows = distinctWindows(rc.serviceSchedule)
    console.log(`\n=== ${rc.name} (${rc.id})`)
    console.log(`  legacy windows: ${windows.length ? windows.map(w => `${w.name} ${hhmm(w.start)}-${w.end != null ? hhmm(w.end) : '?'}`).join(', ') : '(none)'}`)
    console.log(`  services before: ${rc.services.length ? rc.services.map(s => `${s.name} ${hhmm(s.timeMinutes)}-${s.endMinutes != null ? hhmm(s.endMinutes) : '?'}`).join(', ') : '(none)'}`)

    // 1) Fill endMinutes on existing services that lack it.
    for (const svc of rc.services) {
      if (svc.endMinutes != null) continue
      const byName = windows.find(w => w.name.toLowerCase() === svc.name.toLowerCase() && w.end != null)
      const byStart = windows.filter(w => w.end != null)
        .sort((a, b) => Math.abs(a.start - svc.timeMinutes) - Math.abs(b.start - svc.timeMinutes))[0]
      const match = byName ?? byStart
      if (!match?.end) { console.log(`  ! ${svc.name}: no window to source hours from — set it in the RC editor`); continue }
      await prisma.service.update({ where: { id: svc.id }, data: { endMinutes: match.end } })
      console.log(`  + ${svc.name}: endMinutes ← ${hhmm(match.end)}`)
      filled++
    }

    // 2) Create a Service for any legacy window that has none.
    // Seed from rc.services and append each newly created row, so a second
    // window in this same run that shares a name/start with the first
    // doesn't also pass the `exists` check and get duplicated.
    const knownServices = [...rc.services]
    for (const w of windows) {
      const exists = knownServices.some(
        s => s.name.toLowerCase() === w.name.toLowerCase() || s.timeMinutes === w.start,
      )
      if (exists) continue
      const created_ = await prisma.service.create({
        data: { revenueCenterId: rc.id, name: w.name, timeMinutes: w.start, endMinutes: w.end ?? null },
      })
      knownServices.push(created_)
      console.log(`  + created service ${w.name} ${hhmm(w.start)}-${w.end != null ? hhmm(w.end) : '?'}`)
      created++
    }

    const after = await prisma.service.findMany({
      where: { revenueCenterId: rc.id }, orderBy: [{ sortOrder: 'asc' }, { timeMinutes: 'asc' }],
    })
    console.log(`  services after:  ${after.length ? after.map(s => `${s.name} ${hhmm(s.timeMinutes)}-${s.endMinutes != null ? hhmm(s.endMinutes) : '?'}`).join(', ') : '(none) → ON-DEMAND'}`)
  }

  console.log(`\nDone. endMinutes filled: ${filled}, services created: ${created}.`)
  console.log('Any RC printed as "(none) → ON-DEMAND" has no services and will show no countdown.')
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
