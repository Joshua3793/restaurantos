'use client'

// How many things on THIS phone are still waiting to reach the server — the
// More drawer's "N waiting to send" pill. Read-only: it never sends, drops or
// rewrites a queue; each queue's own page still owns its flush.
//
// Counts what a person would call "one thing": a prep or count edit made twice
// before it sent is one change, not two (the same de-duplication the flush
// uses). Any queue that cannot be read counts as 0.
import { loadCountQueue, type CountMutation } from '@/lib/count-offline'
import { loadTempQueue } from '@/components/temps/temp-queue'
import { loadLineQueue } from '@/components/checklists/line-queue'
import { loadQueue as loadPrepQueue, deduplicateQueue as dedupePrep } from '@/lib/prep-offline'
import { countPendingScans } from '@/lib/pending-scans'

// Mirrors count-offline's own dedupe key (one per line per field).
const countKey = (m: CountMutation) => `${m.lineId}:${m.type === 'uom' ? 'uom' : 'state'}`

function safe(fn: () => number): number {
  try { return fn() } catch { return 0 }
}

/** Items waiting on this device across every offline queue. */
export async function countWaitingToSend(): Promise<number> {
  if (typeof window === 'undefined') return 0
  const sync =
    safe(() => new Set(loadCountQueue().map(countKey)).size) +
    safe(() => loadTempQueue().length) +
    safe(() => loadLineQueue().length) +
    safe(() => dedupePrep(loadPrepQueue()).length)
  const scans = await countPendingScans().catch(() => 0)
  return sync + scans
}
