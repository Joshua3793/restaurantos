/**
 * Folds a period's clock punches and per-day adjustments into the TipPerson[]
 * the engine and the audit consume.
 *
 * PURE, and the ONLY copy of this logic. Both callers — the page payload route
 * and the server-side freeze/export path in build.ts — import this function.
 * Two divergent copies would silently change what people get paid.
 */
import type { TipPerson } from './types'

export interface RosterCook {
  id: string
  name: string
  lastName: string | null
  clockId: string | null
  wage: number | null
  dailyHourCap: number | null
  tipRoleId: string | null
  onTipPool: boolean
}

export interface RosterPunch {
  clockId: string
  department: string
  dayIndex: number
  hours: number
  status: string
}

export interface RosterAdjustment {
  cookId: string
  dayIndex: number
  /** null = fall back to the clocked hours for that day. */
  hours: number | null
  boost: number
}

export interface ResolveRosterInput {
  cooks: RosterCook[]
  punches: RosterPunch[]
  adjustments: RosterAdjustment[]
  dayCount: number
  /** Empty = accept every department. */
  poolDepartments: string[]
}

/** What `readHoursCell` decided a typed hours cell means. */
export type HoursCellCommit =
  /** Send nothing — the value did not change, or clearing an already-clear box. */
  | { kind: 'skip' }
  /** Unreadable or negative — reset the box, send nothing. */
  | { kind: 'invalid' }
  /** Send this to the adjustments API. `null` CLEARS the override. */
  | { kind: 'commit'; hours: number | null }

/**
 * What a manual hours cell on the split table MEANS — the inverse of the
 * adjustment fold below.
 *
 * Pure, and here rather than inline in SplitTab's onBlur, because two
 * silent-wrongness bugs lived in that one handler:
 *
 *  - It fired UNCONDITIONALLY, so merely tabbing through a day cell wrote a
 *    TipDayAdjustment whose hours equalled the clocked value. Not a cent moved,
 *    so nothing looked wrong — but it set `edited[d]`, and `auditPeriod` skips
 *    edited days, so it silently switched off that day's per-person
 *    `hours-<code>` reconciliation with no signal anywhere in the app.
 *  - An EMPTY box went through `parseFloat('') = NaN → 0` and stored a 0-hour
 *    override, rather than reverting the day to the clock file. The adjustments
 *    API already accepts `hours: null` for exactly that.
 *
 * @param raw    the hours currently shown for that day (`person.hours[d]`)
 * @param edited whether that day already carries a manual override
 */
export function readHoursCell(text: string, raw: number, edited: boolean): HoursCellCommit {
  const s = text.trim()
  // Empty means "no opinion", never "zero hours": clear an existing override,
  // and do nothing at all when there was none to clear.
  if (s === '') return edited ? { kind: 'commit', hours: null } : { kind: 'skip' }
  const v = parseFloat(s)
  if (!Number.isFinite(v) || v < 0) return { kind: 'invalid' }
  return Math.abs(v - raw) < 1e-9 ? { kind: 'skip' } : { kind: 'commit', hours: v }
}

export function resolveRoster(input: ResolveRosterInput): TipPerson[] {
  const { cooks, punches, adjustments, dayCount, poolDepartments } = input

  // Clocked hours per day per code — filtered exactly as the pool filters them:
  // right department, inside the period, approved.
  const clockedByCode = new Map<string, number[]>()
  for (const p of punches) {
    if (poolDepartments.length && !poolDepartments.includes(p.department)) continue
    if (p.dayIndex < 0 || p.dayIndex >= dayCount) continue
    if (!/approved/i.test(p.status)) continue
    const code = String(p.clockId)
    const days = clockedByCode.get(code) ?? Array(dayCount).fill(0)
    days[p.dayIndex] = Math.round((days[p.dayIndex] + p.hours) * 100) / 100
    clockedByCode.set(code, days)
  }

  const adjByCook = new Map<string, Map<number, RosterAdjustment>>()
  for (const a of adjustments) {
    const m = adjByCook.get(a.cookId) ?? new Map<number, RosterAdjustment>()
    m.set(a.dayIndex, a)
    adjByCook.set(a.cookId, m)
  }

  return cooks.map(c => {
    const clocked = (c.clockId ? clockedByCode.get(String(c.clockId)) : null) ?? Array(dayCount).fill(0)
    const adj = adjByCook.get(c.id)
    const hours: number[] = []
    const boosts: number[] = []
    const edited: boolean[] = []
    for (let d = 0; d < dayCount; d++) {
      const a = adj?.get(d)
      hours.push(a?.hours ?? clocked[d])
      boosts.push(a?.boost ?? 1)
      edited.push(a?.hours != null)
    }
    return {
      cookId: c.id,
      name: c.name,
      lastName: c.lastName,
      clockId: c.clockId,
      wage: c.wage,
      dailyHourCap: c.dailyHourCap,
      roleId: c.tipRoleId,
      onPool: c.onTipPool,
      hours, boosts, edited,
    }
  })
}
