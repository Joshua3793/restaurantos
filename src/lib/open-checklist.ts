// The opening checklist — pure pieces shared by the API, the setup page and the
// cook start page. No DB, no React.

export interface OpenCheckRow {
  id: string
  revenueCenterId: string
  section: string
  title: string
  meta: string | null
  sortOrder: number
  isBlocker: boolean
  /** Ticked for today's business day. */
  done: boolean
  doneByName: string | null
  doneAt: string | null
}

/**
 * The list a kitchen starts with the first time anyone opens it — a manager
 * edits it from there in Setup. Only food revenue centers get it; a bar starts
 * empty. Order here is the order on screen. `isBlocker` = must be done before doors.
 * Fridge/freezer temps are not on it: the Temps log already tracks those and the
 * cook screen shows them beside this list.
 */
export const DEFAULT_OPENING_ITEMS: ReadonlyArray<{ section: string; title: string; meta: string | null; isBlocker: boolean }> = [
  { section: 'Food safety', title: 'Sanitiser buckets made up', meta: 'Test strip reads 200 ppm', isBlocker: true },
  { section: 'Food safety', title: 'Hand sinks stocked', meta: 'Soap, paper towel, warm water', isBlocker: true },
  { section: 'Food safety', title: 'Probe thermometers cleaned', meta: 'Ice water reads 0°C', isBlocker: false },
  { section: 'Food safety', title: 'Fridges checked for dates', meta: 'Toss anything past its date · first in, first out', isBlocker: false },
  { section: 'Line set-up', title: 'Fryer oil checked', meta: 'Change it if dark or foaming', isBlocker: false },
  { section: 'Line set-up', title: 'Dish machine on and up to temp', meta: null, isBlocker: false },
  { section: 'Line set-up', title: 'Flat-top, grill and ovens on', meta: null, isBlocker: false },
  { section: 'Line set-up', title: 'Line stocked against the 86 board', meta: null, isBlocker: false },
  { section: 'Deliveries', title: 'Morning deliveries checked in and put away', meta: 'Cold goods first · check their temp on arrival', isBlocker: false },
]

/** Stable seed ids, so two first-opens at once cannot seed the list twice. */
export const seedItemId = (rcId: string, index: number) => `open-${rcId}-${index}`

export function openProgress(rows: Pick<OpenCheckRow, 'done' | 'isBlocker'>[]): {
  done: number
  total: number
  /** Must-do-before-doors items still open. */
  blockersLeft: number
} {
  return {
    done: rows.filter(r => r.done).length,
    total: rows.length,
    blockersLeft: rows.filter(r => r.isBlocker && !r.done).length,
  }
}

/** Sections in first-appearance order (rows arrive sorted by sortOrder). */
export function bySection<T extends { section: string }>(rows: T[]): { section: string; rows: T[] }[] {
  const out: { section: string; rows: T[] }[] = []
  for (const r of rows) {
    const g = out.find(x => x.section === r.section)
    if (g) g.rows.push(r)
    else out.push({ section: r.section, rows: [r] })
  }
  return out
}
