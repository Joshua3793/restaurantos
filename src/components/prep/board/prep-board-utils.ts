import type { PrepItemRich } from '@/components/prep/types'

export type Urgency = 'critical' | 'low' | 'par'
export type BoardStatus = 'not-started' | 'in-progress' | 'done' | 'skipped'

export interface BoardRow {
  id: string
  name: string
  cat: string
  station: string
  unit: string
  onHand: number
  par: number
  make: number
  urgency: Urgency
  stockOut: boolean
  overridden: boolean
  onList: boolean
  status: BoardStatus
  prepMin: number
  pct: number            // onHand/par as % (0–100+), for par display
  item: PrepItemRich     // escape hatch for handlers / drawer
}

const fmt = (n: number) => {
  const v = Number(n) || 0
  return (v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)).replace(/\.0$/, '')
}
export const fmtQty = fmt

export function urgencyOf(item: PrepItemRich): Urgency {
  const eff = item.manualPriorityOverride ?? item.priority
  return eff === '911' ? 'critical' : eff === 'NEEDED_TODAY' ? 'low' : 'par'
}

export function statusOf(item: PrepItemRich): BoardStatus {
  const s = item.todayLog?.status
  if (s === 'IN_PROGRESS') return 'in-progress'
  if (s === 'DONE' || s === 'PARTIAL') return 'done'
  if (s === 'SKIPPED') return 'skipped'
  return 'not-started'
}

export function toBoardRow(item: PrepItemRich): BoardRow {
  const par = Number(item.parLevel) || 0
  const onHand = Number(item.onHand) || 0
  return {
    id: item.id,
    name: item.name,
    cat: item.category,
    station: item.station ?? '—',
    unit: item.unit,
    onHand,
    par,
    make: Number(item.suggestedQty) || 0,
    urgency: urgencyOf(item),
    stockOut: item.isBlocked || onHand <= 0,
    overridden: item.manualPriorityOverride != null,
    onList: item.isOnList,
    status: statusOf(item),
    prepMin: Number(item.estimatedPrepTime) || 0,
    pct: par > 0 ? Math.round((onHand / par) * 100) : 100,
    item,
  }
}

export function dotClass(u: Urgency) {
  return u === 'critical' ? 'dot-red' : u === 'low' ? 'dot-amber' : 'dot-green'
}

export function fmtMin(m: number): string {
  if (m >= 60) { const h = Math.floor(m / 60), mm = m % 60; return mm ? `${h}h ${mm}m` : `${h}h` }
  return `${m}m`
}

/** Total prep minutes for a block (skip par items, which need no make). */
export function totalMin(rows: BoardRow[]): number {
  return rows.reduce((a, r) => a + (r.make > 0 ? r.prepMin : 0), 0)
}
