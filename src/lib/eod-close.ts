import { prisma } from '@/lib/prisma'
import { shiftBusinessDate } from '@/lib/checklists/rules'

// Restaurant-local calendar day (Pacific). MUST NOT use server wall-clock — on
// Vercel that's UTC, which rolls to "tomorrow" during evening Pacific service.
// Matches the Toast sync convention (src/lib/toast/sales-sync.ts) and the
// client-computed TempReading.logDate. 'en-CA' formats as 'YYYY-MM-DD'.
const RESTAURANT_TZ = 'America/Los_Angeles'
export function businessDateLocal(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: RESTAURANT_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d)
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

// ── Station closing (the station checklists) ────────────────────────────────

export interface StationsClosed {
  signed: number
  total: number
  ready: boolean
}

/**
 * Pure: how many station closing runs are signed off. The whole-kitchen
 * (shared) station never signs off, so it is left out. Ready when every
 * counted run is signed — and when there are none.
 */
export function stationsClosed(runs: Array<{ isShared: boolean; status: 'OPEN' | 'SIGNED' }>): StationsClosed {
  const counted = runs.filter(r => !r.isShared)
  const signed = counted.filter(r => r.status === 'SIGNED').length
  return { signed, total: counted.length, ready: signed === counted.length }
}

/** One CLOSE run as the gate reads it. */
export interface CloseRunInfo {
  isShared: boolean
  status: 'OPEN' | 'SIGNED'
  lineCount: number
  crewCount: number
  /** Lines DONE or FLAGGED. */
  handledCount: number
  blockerCount: number
  /** Blocker lines still TODO. */
  blockersLeft: number
}

/**
 * Pure: does a station's CLOSE run hold the day open? Not when it has no lines
 * (nothing applied tonight — it could never be signed), and not when nobody is
 * on it and nothing was ticked (a cook picked it, then switched station).
 */
export function isLiveCloseRun(r: Pick<CloseRunInfo, 'lineCount' | 'crewCount' | 'handledCount'>): boolean {
  if (r.lineCount === 0) return false
  return r.crewCount > 0 || r.handledCount > 0
}

export interface CloseGate extends StationsClosed {
  /** Blocker jobs on the whole-kitchen closing list (e.g. gas off). */
  sharedBlockersTotal: number
  sharedBlockersLeft: number
}

/**
 * Pure: the station half of the end-of-day gate. Live station runs must all be
 * signed off, and the whole-kitchen run's blockers must all be handled — the
 * old end-of-day blockers moved onto that list.
 */
export function closeGateFrom(runs: CloseRunInfo[]): CloseGate {
  const stations = stationsClosed(runs.filter(r => !r.isShared && isLiveCloseRun(r)))
  const shared = runs.filter(r => r.isShared)
  return {
    ...stations,
    sharedBlockersTotal: shared.reduce((n, r) => n + r.blockerCount, 0),
    sharedBlockersLeft: shared.reduce((n, r) => n + r.blockersLeft, 0),
  }
}

/**
 * Tonight's CLOSE runs for the RC's active stations, at the closing shift's
 * business date (shiftBusinessDate('CLOSE') — the date the station board and
 * the cook screen use, so a close finished after midnight still counts).
 * A station nobody picked has no run, so it does not hold the day open.
 */
export async function loadStationsClosed(revenueCenterId: string): Promise<CloseGate> {
  const runs = await prisma.checklistRun.findMany({
    where: {
      phase: 'CLOSE',
      businessDate: shiftBusinessDate('CLOSE'),
      station: { revenueCenterId, isActive: true },
    },
    select: {
      status: true,
      station: { select: { isShared: true } },
      _count: { select: { lines: true, crew: true } },
      // Only the lines the gate reads: handled ones and blockers.
      lines: {
        where: { OR: [{ status: { in: ['DONE', 'FLAGGED'] } }, { isBlocker: true }] },
        select: { status: true, isBlocker: true },
      },
    },
  })
  return closeGateFrom(runs.map(r => ({
    isShared: r.station.isShared,
    status: r.status,
    lineCount: r._count.lines,
    crewCount: r._count.crew,
    handledCount: r.lines.filter(l => l.status !== 'TODO').length,
    blockerCount: r.lines.filter(l => l.isBlocker).length,
    blockersLeft: r.lines.filter(l => l.isBlocker && l.status === 'TODO').length,
  })))
}

// ── The sign-off gate ────────────────────────────────────────────────────────

export interface EodProgress {
  done: number      // stations signed + shared blockers handled + (tempsReady ? 1 : 0)
  total: number     // live stations + shared blockers + (hasTempUnits ? 1 : 0)
  blockers: number  // stations not signed + shared blockers left + (tempsReady ? 0 : 1 when hasTempUnits)
  ready: boolean    // stations signed AND shared blockers handled AND tempsReady
  tempsReady: boolean
  hasTempUnits: boolean
  stationsSigned: number
  stationsTotal: number
  sharedBlockersLeft: number
}

/**
 * The end-of-day sign-off gate: temps ready AND every live non-shared station
 * closing run tonight is signed off AND the whole-kitchen closing blockers are
 * handled. (The old kitchen-wide EOD checklist no longer gates; its tables stay
 * until a later drop.)
 */
export function computeProgress(
  gate: CloseGate,
  temps: { total: number; ready: boolean },
): EodProgress {
  const hasTempUnits = temps.total > 0
  const tempsOk = hasTempUnits && temps.ready ? 1 : 0
  const done = gate.signed + (gate.sharedBlockersTotal - gate.sharedBlockersLeft) + tempsOk
  const total = gate.total + gate.sharedBlockersTotal + (hasTempUnits ? 1 : 0)
  const blockers = (gate.total - gate.signed) + gate.sharedBlockersLeft + (hasTempUnits && !temps.ready ? 1 : 0)
  const ready = gate.ready && gate.sharedBlockersLeft === 0 && temps.ready
  return {
    done, total, blockers, ready, tempsReady: temps.ready, hasTempUnits,
    stationsSigned: gate.signed, stationsTotal: gate.total, sharedBlockersLeft: gate.sharedBlockersLeft,
  }
}
