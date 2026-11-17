// Pure rules for one job on several lists ("shared jobs"). No Prisma, no React.
//
// Copies of a job on different stations share a linkId. They carry the same job
// fields (title, answer, must-do, days, due by…) and each sits in its own
// category on its own list. On a shift day, the copies of a phase are ONE job:
// answering any copy answers them all (see lines/[id] PUT and ensureRun).

/** The job fields every copy shares. Category and place on the list stay per copy. */
export const JOB_FIELDS = [
  'title', 'howTo', 'isBlocker', 'answer', 'unit', 'safeMin', 'safeMax', 'tempUnitId', 'days', 'dueBy',
] as const

export type Copy = { id: string; stationId: string }

/**
 * Which stations get a new copy and which copies come off, to make the job sit
 * on exactly `targets`. The job's own station always stays (it is taken off
 * with Remove, not here).
 */
export function planListChange(
  copies: Copy[],
  targets: string[],
  ownStationId: string,
): { add: string[]; remove: string[] } {
  const want = new Set([...targets, ownStationId])
  const have = new Set(copies.map(c => c.stationId))
  return {
    add: Array.from(want).filter(s => !have.has(s)),
    remove: copies.filter(c => !want.has(c.stationId)).map(c => c.id),
  }
}

/** The category on the target list a new copy lands in: same name (any case), else null = make one. */
export function matchCategory<T extends { id: string; name: string }>(cats: T[], name: string): T | null {
  const key = name.trim().toLowerCase()
  return cats.find(c => c.name.trim().toLowerCase() === key) ?? null
}

/** The answer state one line of a shared job passes to its copies. Temps-log ownership is not part of it. */
export const SHARED_STATE = [
  'status', 'value', 'doneById', 'doneByName', 'doneAt', 'flagReason', 'flagNote',
  'resolvedById', 'resolvedByName', 'resolvedAt',
] as const

export type SharedState = Record<(typeof SHARED_STATE)[number], unknown>

/** Picks the shared answer state from a line row. */
export function sharedState(line: Record<string, unknown>): SharedState {
  return Object.fromEntries(SHARED_STATE.map(k => [k, line[k] ?? null])) as SharedState
}
