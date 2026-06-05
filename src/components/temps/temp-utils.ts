// Shared logic for the Temp charts feature — ported from the Claude Design
// prototypes (desktop `Temp charts` + mobile `m-temp`), adapted to the app's
// Postgres-backed API. Numbers here are already JS numbers (the API coerces
// Prisma Decimals before sending), so callers never touch raw Decimals.

export type TempType = 'FRIDGE' | 'FREEZER' | 'HOT'

export interface TempReading {
  id: string
  time: string // 'HH:MM'
  temp: number
}

export interface TempUnit {
  id: string
  name: string
  type: TempType
  safeMin: number | null
  safeMax: number | null
  revenueCenterId: string | null
  sortOrder: number
  readings?: TempReading[] // today's readings, when loaded with ?date=
}

export interface HistoryReading {
  id: string
  unitId: string
  logDate: string // 'YYYY-MM-DD'
  time: string
  temp: number
  recordedBy: string | null
  unit: { id: string; name: string; type: TempType; safeMin: number | null; safeMax: number | null }
}

export type UnitStatus = 'wait' | 'ok' | 'bad'
export type TempGroupKey = 'cold' | 'frz' | 'hot'

// Type config — label, group, accent color, default safe range (°C).
export const TEMP_TYPES: Record<
  TempType,
  { label: string; group: TempGroupKey; color: string; def: { min: number | null; max: number | null } }
> = {
  FRIDGE: { label: 'Fridge', group: 'cold', color: '#2563eb', def: { min: 0, max: 4 } },
  FREEZER: { label: 'Freezer', group: 'frz', color: '#7c3aed', def: { min: -22, max: -18 } },
  HOT: { label: 'Hot held food', group: 'hot', color: '#d97706', def: { min: 63, max: null } },
}

export const TEMP_GROUPS: { key: TempGroupKey; title: string; type: TempType }[] = [
  { key: 'cold', title: 'Refrigeration', type: 'FRIDGE' },
  { key: 'frz', title: 'Freezers', type: 'FREEZER' },
  { key: 'hot', title: 'Hot holding', type: 'HOT' },
]

export const groupOf = (type: TempType): TempGroupKey => TEMP_TYPES[type]?.group ?? 'cold'

// ── date / number helpers ────────────────────────────────────────────────────
export const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export const nowHM = () => {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
// Format a temperature: whole numbers show no decimal, otherwise one place.
export const fmtTemp = (n: number | null): string =>
  n == null ? '' : n % 1 === 0 ? n.toFixed(0) : n.toFixed(1)

// ── range / safety ───────────────────────────────────────────────────────────
// Returns true (safe), false (out of range), or null (no reading to judge).
export function isSafe(
  u: { safeMin: number | null; safeMax: number | null },
  t: number | null | undefined,
): boolean | null {
  if (t == null || Number.isNaN(t)) return null
  if (u.safeMin != null && t < u.safeMin) return false
  if (u.safeMax != null && t > u.safeMax) return false
  return true
}

export function rangeText(u: { safeMin: number | null; safeMax: number | null }): string {
  if (u.safeMin != null && u.safeMax != null) return `${fmtTemp(u.safeMin)} – ${fmtTemp(u.safeMax)}°C`
  if (u.safeMax != null) return `≤ ${fmtTemp(u.safeMax)}°C`
  if (u.safeMin != null) return `≥ ${fmtTemp(u.safeMin)}°C`
  return 'no limit set'
}

// Today status for a unit given its readings: no readings → wait, any
// out-of-range reading → bad, otherwise ok.
export function unitStatus(u: TempUnit, readings: TempReading[]): UnitStatus {
  if (!readings.length) return 'wait'
  return readings.some(r => isSafe(u, r.temp) === false) ? 'bad' : 'ok'
}

// Pretty day label for History (e.g. "Mon, 2 Jun").
export const prettyDate = (s: string) =>
  new Date(s + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })

// ── day rollup ───────────────────────────────────────────────────────────────
export interface TempDayMetrics {
  total: number
  logged: number
  flagged: number
  readings: number
  last: string
  pct: number
  allClear: boolean
  flagItems: TempUnit[]
  waitItems: TempUnit[]
  nextWait?: TempUnit
}

// Compute today's rollup from units that carry their `readings` (loaded via
// GET /api/temps/units?date=…).
export function computeDayMetrics(units: TempUnit[]): TempDayMetrics {
  let logged = 0
  let flagged = 0
  let readings = 0
  let last = ''
  const flagItems: TempUnit[] = []
  const waitItems: TempUnit[] = []
  units.forEach(u => {
    const rs = u.readings ?? []
    const st = unitStatus(u, rs)
    readings += rs.length
    rs.forEach(r => {
      if (r.time > last) last = r.time
    })
    if (st !== 'wait') logged++
    if (st === 'bad') flagged++
    if (st === 'bad') flagItems.push(u)
    if (st === 'wait') waitItems.push(u)
  })
  const total = units.length
  return {
    total,
    logged,
    flagged,
    readings,
    last,
    pct: total ? Math.round((logged / total) * 100) : 0,
    allClear: total > 0 && logged === total && flagged === 0,
    flagItems,
    waitItems,
    nextWait: waitItems[0],
  }
}

// Handlers the page wires to the API; both renderers call these.
export interface TempHandlers {
  logReading: (uid: string, temp: number, time: string) => void | Promise<void>
  removeReading: (id: string, uid: string) => void | Promise<void>
  addUnit: (u: { name: string; type: TempType; safeMin: number | null; safeMax: number | null }) => void | Promise<void>
  updateUnit: (id: string, patch: { name?: string; safeMin?: number | null; safeMax?: number | null }) => void | Promise<void>
  deleteUnit: (id: string) => void | Promise<void>
}

// ── CSV / Excel export ───────────────────────────────────────────────────────
// Builds the food-safety record from a flat History reading list and triggers
// a download. UTF-8 BOM so Excel opens it cleanly; columns mirror the prototype.
export function exportTempCSV(readings: HistoryReading[], filename?: string) {
  const rows: (string | number)[][] = [
    ['Date', 'Unit', 'Type', 'Safe min (°C)', 'Safe max (°C)', 'Time', 'Temp (°C)', 'Status'],
  ]
  // Oldest first reads better in a record.
  const sorted = [...readings].sort((a, b) =>
    a.logDate === b.logDate ? a.time.localeCompare(b.time) : a.logDate.localeCompare(b.logDate),
  )
  sorted.forEach(r => {
    const safe = isSafe(r.unit, r.temp)
    rows.push([
      r.logDate,
      r.unit.name,
      TEMP_TYPES[r.unit.type].label,
      r.unit.safeMin ?? '',
      r.unit.safeMax ?? '',
      r.time,
      fmtTemp(r.temp),
      safe === false ? 'OUT OF RANGE' : 'OK',
    ])
  })
  const csv = rows
    .map(r =>
      r
        .map(c => {
          const s = String(c)
          return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
        })
        .join(','),
    )
    .join('\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename || `temp-charts-${ymd(new Date())}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
}
