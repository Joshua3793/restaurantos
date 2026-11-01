// How the cook's list is laid out on screen, shared by the list itself and the
// desktop keyboard (↑ ↓ walk the same order the eye reads). Pure.
import type { Phase } from './rules'

type LineLike = { id: string; status: 'TODO' | 'DONE' | 'FLAGGED'; isBlocker: boolean; categoryName: string }
type RunLike<L extends LineLike> = { lines: L[] }

export type ListRow<L> = { line: L; shared: boolean; locked: boolean }
export type ListSection<L> = { key: string; label: string; urgent: boolean; count: string; rows: ListRow<L>[] }
/** Desktop filter chips: every job, the ones still to do, or the ones handled. */
export type ListFilter = 'all' | 'left' | 'done'

const handled = <L extends LineLike>(rows: ListRow<L>[]) => rows.filter(r => r.line.status !== 'TODO').length

/** Blockers first ("BEFORE DOORS" / "BEFORE YOU LEAVE"), then each category in line order. */
export function sectionsFor<L extends LineLike>(rows: ListRow<L>[], phase: Phase): ListSection<L>[] {
  const out: ListSection<L>[] = []
  const blockers = rows.filter(r => r.line.isBlocker)
  if (blockers.length > 0) {
    const left = blockers.filter(r => r.line.status === 'TODO').length
    const base = phase === 'OPEN' ? 'BEFORE DOORS' : 'BEFORE YOU LEAVE'
    out.push({
      key: '__blockers',
      label: left > 0 ? `${base} · ${left} LEFT` : base,
      urgent: left > 0,
      count: `${handled(blockers)}/${blockers.length}`,
      rows: blockers,
    })
  }
  const byCat = new Map<string, ListRow<L>[]>()
  for (const r of rows) {
    if (r.line.isBlocker) continue
    const name = r.line.categoryName.trim()
    const list = byCat.get(name)
    if (list) list.push(r)
    else byCat.set(name, [r])
  }
  for (const [name, list] of Array.from(byCat)) {
    out.push({
      key: `cat:${name}`,
      label: (name || 'Other jobs').toUpperCase(),
      urgent: false,
      count: `${handled(list)}/${list.length}`,
      rows: list,
    })
  }
  return out
}

/**
 * The rows of one card. The whole-kitchen run's lines join the first picked
 * station's card; with no station picked the whole-kitchen run is its own card.
 */
export function cardRows<L extends LineLike>(
  run: RunLike<L> & { status: string },
  index: number,
  shared: (RunLike<L> & { status: string }) | null,
): ListRow<L>[] {
  const locked = run.status === 'SIGNED'
  const rows: ListRow<L>[] = run.lines.map(line => ({ line, shared: false, locked }))
  if (index === 0 && shared) {
    const sharedLocked = shared.status === 'SIGNED'
    for (const line of shared.lines) rows.push({ line, shared: true, locked: sharedLocked })
  }
  return rows
}

export function keepRow(filter: ListFilter, line: { status: 'TODO' | 'DONE' | 'FLAGGED' }): boolean {
  if (filter === 'left') return line.status === 'TODO'
  if (filter === 'done') return line.status !== 'TODO'
  return true
}

/** Every line id in the order the list draws it, after the filter. */
export function lineOrder<L extends LineLike>(
  mine: (RunLike<L> & { status: string })[],
  shared: (RunLike<L> & { status: string }) | null,
  phase: Phase,
  filter: ListFilter = 'all',
): string[] {
  const cards = mine.length > 0
    ? mine.map((run, i) => cardRows(run, i, shared))
    : shared ? [cardRows(shared, 0, null)] : []
  return cards.flatMap(rows =>
    sectionsFor(rows, phase).flatMap(s => s.rows.filter(r => keepRow(filter, r.line)).map(r => r.line.id)),
  )
}
