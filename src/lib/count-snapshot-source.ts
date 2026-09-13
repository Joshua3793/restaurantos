// src/lib/count-snapshot-source.ts
//
// Where an InventorySnapshot row's quantity came from. Written by finalize on
// every row; the ONLY way to tell a physically observed row from a theoretical
// one, so every reader that sums snapshots must filter on it.
//
//   COUNTED      — the cook entered a quantity.
//   CARRIED      — "Same as last": the cook confirmed the item is unchanged since
//                  its last count (reads as counted, flagged so it can be shown).
//   SKIPPED      — the cook explicitly skipped the line; qty is the expected qty.
//   THEORETICAL  — the line was left blank; qty is the expected qty. Never a
//                  count. Kept so the row set still describes the whole session,
//                  but excluded from every counted total.

export type SnapshotSource = 'COUNTED' | 'CARRIED' | 'SKIPPED' | 'THEORETICAL'

/** Sources that count as a physical observation of the item. */
export const OBSERVED_SOURCES: readonly SnapshotSource[] = ['COUNTED', 'CARRIED']

export function isObservedSource(source: string): boolean {
  return source === 'COUNTED' || source === 'CARRIED'
}

/** Classify a count line the way finalize does — one rule, mirrored by the migration's backfill SQL. */
export function snapshotSourceOf(line: {
  skipped: boolean
  countedQty: unknown | null
  carriedForward: boolean
}): SnapshotSource {
  if (line.skipped) return 'SKIPPED'
  if (line.countedQty === null || line.countedQty === undefined) return 'THEORETICAL'
  return line.carriedForward ? 'CARRIED' : 'COUNTED'
}
