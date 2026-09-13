// src/lib/cogs-bounds.ts
//
// Pure per-item merge behind periodSnapshotBounds (src/lib/cogs.ts).
//
// A period bound used to be ONE finalized FULL count, summed over every snapshot
// row — including rows that were never counted and merely carried the
// theoretical quantity (the 31 Jul 2026 "prep count" was typed FULL and 85% of
// its $26,967 was theoretical). A bound is now built per item:
//
//   • the latest FULL count on or before the bound date defines the UNIVERSE
//     (which items a full count covers) and the bound's date/id;
//   • each item in that universe is valued at its most recent OBSERVED snapshot
//     (COUNTED or CARRIED) from ANY finalized count on or before the bound —
//     full, partial or quick — so a prep-only count fills in the prep items and
//     the rest keep the last time somebody actually counted them;
//   • an item nobody has ever observed contributes nothing and is reported in
//     `itemsUnobserved` so the UI can caveat the total.
//
// This is the rule the month-end valuation export already applied by hand.
import { isObservedSource } from './count-snapshot-source'

export interface BoundSession {
  id: string
  type: string
  sessionDate: Date
  finalizedAt: Date | null
  snapshots: { inventoryItemId: string; totalValue: number; category: string; source: string }[]
}

export interface ItemBound {
  sessionId: string
  sessionDate: Date
  value: number
  byCategory: Record<string, number>
  /** Items the bounding FULL count covered. */
  itemsTotal: number
  /** Items valued from an observation in the bounding FULL count itself. */
  itemsFromBound: number
  /** Items valued from an observation in a different (earlier or later) count. */
  itemsFromOtherCounts: number
  /** Items with no observation on record — contribute 0. */
  itemsUnobserved: number
  /** Date of the oldest observation the bound relies on. */
  earliestObservation: Date | null
}

const ms = (d: Date) => d.getTime()

/** Most recent first: by effective count date, then by when approve was clicked. */
export function sortSessionsDesc<T extends { sessionDate: Date; finalizedAt: Date | null }>(sessions: T[]): T[] {
  return [...sessions].sort((a, b) =>
    ms(b.sessionDate) - ms(a.sessionDate) ||
    (b.finalizedAt ? ms(b.finalizedAt) : 0) - (a.finalizedAt ? ms(a.finalizedAt) : 0))
}

/**
 * Resolve one bound from finalized sessions (any order) at `boundMs`.
 * Returns null when no FULL count precedes the bound.
 */
export function resolveItemBound(sessions: BoundSession[], boundMs: number): ItemBound | null {
  const eligible = sortSessionsDesc(sessions.filter(s => ms(s.sessionDate) <= boundMs))
  const full = eligible.find(s => s.type === 'FULL')
  if (!full) return null

  const universe = new Set(full.snapshots.map(s => s.inventoryItemId))
  const resolved = new Map<string, { value: number; category: string; sessionId: string; sessionDate: Date }>()
  for (const s of eligible) {
    for (const snap of s.snapshots) {
      if (!universe.has(snap.inventoryItemId) || resolved.has(snap.inventoryItemId)) continue
      if (!isObservedSource(snap.source)) continue
      resolved.set(snap.inventoryItemId, {
        value: snap.totalValue, category: snap.category, sessionId: s.id, sessionDate: s.sessionDate,
      })
    }
    if (resolved.size === universe.size) break
  }

  let value = 0
  let itemsFromBound = 0
  let itemsFromOtherCounts = 0
  let earliest: Date | null = null
  const byCategory: Record<string, number> = {}
  for (const r of resolved.values()) {
    value += r.value
    byCategory[r.category] = (byCategory[r.category] ?? 0) + r.value
    if (r.sessionId === full.id) itemsFromBound++
    else itemsFromOtherCounts++
    if (!earliest || ms(r.sessionDate) < ms(earliest)) earliest = r.sessionDate
  }

  return {
    sessionId: full.id,
    sessionDate: full.sessionDate,
    value,
    byCategory,
    itemsTotal: universe.size,
    itemsFromBound,
    itemsFromOtherCounts,
    itemsUnobserved: universe.size - resolved.size,
    earliestObservation: earliest,
  }
}
