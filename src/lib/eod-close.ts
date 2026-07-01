import { prisma } from '@/lib/prisma'

// Local 'YYYY-MM-DD' — matches TempReading.logDate convention.
export function businessDateLocal(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Temp safety: a reading is in-range when within [safeMin, safeMax] (either bound
// may be null). A unit is "logged & ok today" if it has ≥1 reading today and its
// latest reading is in range. Mirrors temp-utils.unitStatus without importing a
// client module.
function readingInRange(temp: number, safeMin: number | null, safeMax: number | null): boolean {
  if (safeMin != null && temp < safeMin) return false
  if (safeMax != null && temp > safeMax) return false
  return true
}

// Returns { total, ready } for the RC's temp units on `date`. total===0 → ready.
export async function computeTempsReady(revenueCenterId: string, date: string): Promise<{ total: number; ready: boolean }> {
  const units = await prisma.tempUnit.findMany({
    where: { isActive: true, OR: [{ revenueCenterId }, { revenueCenterId: null }] },
    select: {
      id: true, safeMin: true, safeMax: true,
      readings: { where: { logDate: date }, orderBy: { time: 'asc' }, select: { temp: true } },
    },
  })
  const total = units.length
  if (total === 0) return { total: 0, ready: true }
  let logged = 0, flagged = 0
  for (const u of units) {
    if (u.readings.length === 0) continue
    logged++
    const latest = u.readings[u.readings.length - 1]
    if (!readingInRange(Number(latest.temp), u.safeMin == null ? null : Number(u.safeMin), u.safeMax == null ? null : Number(u.safeMax))) flagged++
  }
  return { total, ready: logged === total && flagged === 0 }
}

export interface EodProgress {
  done: number      // checklist items done + (tempsReady ? 1 : 0)
  total: number     // active checklist items + (hasTempUnits ? 1 : 0)
  blockers: number  // open blocker checklist items + (tempsReady ? 0 : 1 when hasTempUnits)
  ready: boolean    // all checklist items done AND tempsReady
  tempsReady: boolean
  hasTempUnits: boolean
}

export function computeProgress(
  items: { id: string; isBlocker: boolean }[],
  doneItemIds: Set<string>,
  temps: { total: number; ready: boolean },
): EodProgress {
  const checklistDone = items.filter(i => doneItemIds.has(i.id)).length
  const checklistBlockersOpen = items.filter(i => i.isBlocker && !doneItemIds.has(i.id)).length
  const hasTempUnits = temps.total > 0
  const done = checklistDone + (hasTempUnits && temps.ready ? 1 : 0)
  const total = items.length + (hasTempUnits ? 1 : 0)
  const blockers = checklistBlockersOpen + (hasTempUnits && !temps.ready ? 1 : 0)
  const ready = checklistDone === items.length && temps.ready
  return { done, total, blockers, ready, tempsReady: temps.ready, hasTempUnits }
}
