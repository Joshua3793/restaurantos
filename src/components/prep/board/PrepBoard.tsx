'use client'
import type { PrepItemRich } from '@/components/prep/types'
import { toBoardRow, BoardRow } from './prep-board-utils'
import { PrepBlock } from './PrepBlock'
import { PrepLater } from './PrepLater'
import { RowHandlers } from './PrepRow'

export interface PrepBoardProps {
  view: 'todo' | 'smart'
  groupBy: 'urgency' | 'category' | 'station'
  items: PrepItemRich[]          // already RC/active-filtered by the page
  todayItems: PrepItemRich[]     // isOnList items (for To Do)
  handlers: Omit<RowHandlers, 'view'>
  onAddAll: (ids: string[]) => void
  tasksSlot?: React.ReactNode    // checklist Tasks block — rendered as the first grid cell
}

const notOnListIds = (rows: BoardRow[]) => rows.filter(r => !r.onList).map(r => r.id)

// Pin started (in-progress) items to the top of a block; stable for the rest.
const startedFirst = (rows: BoardRow[]) =>
  [...rows].sort((a, b) => (a.status === 'in-progress' ? 0 : 1) - (b.status === 'in-progress' ? 0 : 1))

export function PrepBoard({ view, groupBy, items, todayItems, handlers, onAddAll, tasksSlot }: PrepBoardProps) {
  const h: RowHandlers = { ...handlers, view }

  if (view === 'todo') {
    const list = todayItems.map(toBoardRow)
    const open = (r: BoardRow) => r.status !== 'done' && r.status !== 'skipped'
    const crit  = startedFirst(list.filter(r => r.urgency === 'critical' && open(r)))
    const low   = startedFirst(list.filter(r => r.urgency === 'low'      && open(r)))
    const later = startedFirst(list.filter(r => r.urgency === 'par'      && open(r)))
    const closed = list.filter(r => r.status === 'done')
    return (
      <div className="board">
        <div className="actionable">
          <div className="col">
            {tasksSlot}
            <PrepBlock kind="crit" title="CRITICAL" rows={crit} h={h} emptyText="No critical items" />
          </div>
          <div className="col">
            <PrepBlock kind="low" title="NEEDED TODAY" rows={low} h={h} emptyText="All par levels met" />
            {later.length > 0 && <PrepLater variant="later" rows={later} h={h} />}
            <PrepLater variant="closed" rows={closed} h={h} />
          </div>
        </div>
      </div>
    )
  }

  // SMART PREP
  const rows = items.map(toBoardRow)
  if (groupBy === 'urgency') {
    const crit = rows.filter(r => r.urgency === 'critical')
    const low = rows.filter(r => r.urgency === 'low')
    const par = rows.filter(r => r.urgency === 'par')
    return (
      <div className="board">
        <div className="actionable">
          <div className="col">
            {tasksSlot}
            <PrepBlock kind="crit" title="CRITICAL" rows={crit} h={h} addAll onAddAll={() => onAddAll(notOnListIds(crit))} />
          </div>
          <div className="col">
            <PrepBlock kind="low" title="LOW STOCK / NEEDED TODAY" rows={low} h={h} addAll onAddAll={() => onAddAll(notOnListIds(low))} />
            <PrepLater variant="par" rows={par} h={h} />
          </div>
        </div>
      </div>
    )
  }

  // category / station grouping → tri grid of tinted blocks
  const keyOf = (r: BoardRow) => (groupBy === 'category' ? r.cat : r.station)
  const groupKeys = Array.from(new Set(rows.map(keyOf))).sort((a, b) => a.localeCompare(b))
  return (
    <div className="board">
      <div className="actionable tri">
        {tasksSlot}
        {groupKeys.map(g => {
          const grp = rows.filter(r => keyOf(r) === g)
          const hasCrit = grp.some(r => r.urgency === 'critical')
          const hasLow = grp.some(r => r.urgency === 'low')
          const kind = hasCrit ? 'crit' : hasLow ? 'low' : ''
          return <PrepBlock key={g} kind={kind} title={g.toUpperCase()} rows={grp} h={h} addAll={hasCrit || hasLow} onAddAll={() => onAddAll(notOnListIds(grp))} />
        })}
      </div>
    </div>
  )
}
