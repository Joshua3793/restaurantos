// Pure: the one-word state of a station's run on the manager board.
// No Prisma, no React, so the page and the route share it.
import { runProgress, sharedRunComplete, type LineLike, type Phase } from './rules'

export type StationTone = 'red' | 'gold' | 'green' | 'grey'
export type StationStatus = { label: string; tone: StationTone }

export function stationStatus(input: {
  isShared: boolean
  run: { status: 'OPEN' | 'SIGNED'; lines: LineLike[] } | null
  phase: Phase
  /** With no run: how many jobs would apply today. 0 means there is nothing to start. */
  jobCount?: number
}): StationStatus {
  const { run, isShared, phase, jobCount } = input
  if (!run) {
    // Nothing on the list today: not a station that is late, and the close gate ignores it.
    if (jobCount === 0) return { label: 'NOTHING TODAY', tone: 'grey' }
    return { label: 'NOT STARTED', tone: 'red' }
  }
  if (run.status === 'SIGNED' || (isShared && sharedRunComplete(run.lines))) {
    return { label: 'DONE', tone: 'green' }
  }
  const p = runProgress(run.lines)
  if (p.blockersLeft > 0) {
    return { label: `${p.blockersLeft} ${phase === 'OPEN' ? 'BEFORE DOORS' : 'BEFORE YOU LEAVE'}`, tone: 'gold' }
  }
  if (p.flagged > 0) return { label: `${p.flagged} FLAGGED`, tone: 'gold' }
  return { label: 'IN PROGRESS', tone: 'grey' }
}

const TONE_RANK: Record<StationTone, number> = { red: 0, gold: 1, green: 2, grey: 3 }

/** Needs-attention first: red, gold, green, grey. The whole-kitchen station goes last in its tone; otherwise the given order holds. */
export function sortStations<T extends { isShared: boolean; status: { tone: StationTone } }>(stations: T[]): T[] {
  return stations
    .map((s, i) => ({ s, i }))
    .sort((a, b) =>
      TONE_RANK[a.s.status.tone] - TONE_RANK[b.s.status.tone]
      || Number(a.s.isShared) - Number(b.s.isShared)
      || a.i - b.i)
    .map(x => x.s)
}
