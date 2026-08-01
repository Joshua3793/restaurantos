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
