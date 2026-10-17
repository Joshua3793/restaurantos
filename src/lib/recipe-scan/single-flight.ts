// Recipe Scan — at most one autosave in flight. The draft PATCH is
// last-write-wins on the server, so two overlapping PATCHes could let an older
// copy land after a newer one. `trigger()` while a run is in flight only marks
// `again`; the same run goes round once more (reading the newest copy) after
// the current send settles. A step returning 'stop' (an error, a locked
// draft) ends the run; whoever triggered it can await the returned promise.

export type FlightStep = 'done' | 'stop'

export interface SingleFlight {
  /** Start a run, or ask the running one to go round again. Resolves when the run ends. */
  trigger: () => Promise<void>
  /** The running run, or null. */
  current: () => Promise<void> | null
  /** True when a trigger arrived during the current send (its answer is already stale). */
  againRequested: () => boolean
}

export function singleFlight(step: () => Promise<FlightStep>): SingleFlight {
  let running: Promise<void> | null = null
  let again = false

  const trigger = (): Promise<void> => {
    if (running) { again = true; return running }
    const run = async () => {
      do {
        again = false
        if ((await step()) === 'stop') return
      } while (again)
    }
    const p = run().finally(() => { running = null })
    running = p
    return p
  }

  return { trigger, current: () => running, againRequested: () => again }
}
