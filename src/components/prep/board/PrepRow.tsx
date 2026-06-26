'use client'
import type { PrepItemRich } from '@/components/prep/types'
import { BoardRow, dotClass, fmtQty } from './prep-board-utils'
import { IcRecipe } from '@/components/prep/icons'

export interface RowHandlers {
  view: 'todo' | 'smart'
  onOpen: (item: PrepItemRich) => void
  onOpenRecipe: (item: PrepItemRich) => void
  onToggleOnList: (id: string, next: boolean) => void
  onStatusChange: (item: PrepItemRich, status: string, qty?: number) => void
  onPriorityChange: (id: string, priority: string) => void
}

export function PrepRow({ row, h }: { row: BoardRow; h: RowHandlers }) {
  const { item, urgency: u } = row
  const stock = (
    <>{row.onHand === 0 ? <span className="z">0</span> : fmtQty(row.onHand)} / {fmtQty(row.par)} <small>{row.unit}</small></>
  )
  const make = row.make > 0
    ? <span className={`r-make ${u === 'critical' ? 'crit' : 'low'}`}>make {fmtQty(row.make)}</span>
    : <span className="r-make par" style={row.pct > 100 ? { color: 'var(--green-text)' } : undefined}>{row.pct > 100 ? `+${row.pct - 100}%` : 'on par'}</span>

  let statusChip: React.ReactNode = null
  if (h.view === 'todo') {
    if (row.status === 'in-progress') statusChip = <span className="r-status prog"><span className="pdot" />IN PROGRESS</span>
    else if (row.status === 'done') statusChip = <span className="r-status done">✓ DONE</span>
    else if (row.status === 'skipped') statusChip = <span className="r-status" style={{ color: 'var(--ink-4)' }}>REMOVED</span>
  }

  let act: React.ReactNode
  if (h.view === 'smart') {
    if (row.onList) act = <button className="act-btn act-onlist" onClick={() => h.onToggleOnList(row.id, false)}>On list ✓</button>
    else act = <button className={`act-btn ${u === 'par' ? 'act-ghost' : 'act-add'}`} onClick={() => h.onToggleOnList(row.id, true)}><span className="ic">+</span> Add</button>
  } else {
    if (row.status === 'not-started') act = <button className="act-btn act-start" onClick={() => h.onStatusChange(item, 'IN_PROGRESS')}><span className="ic">▶</span> Start</button>
    else if (row.status === 'in-progress') act = <button className="act-btn act-done" onClick={() => h.onOpen(item)}>✓ Done</button>
    else if (row.status === 'done') act = <button className="act-btn act-ghost" onClick={() => h.onStatusChange(item, 'NOT_STARTED')}>↻ Reset</button>
    else act = <button className="act-btn act-ghost" onClick={() => h.onStatusChange(item, 'NOT_STARTED')}>↩ Restore</button>
  }

  const cls = `row${h.view === 'todo' && row.status === 'in-progress' ? ' inprog' : ''}${h.view === 'todo' && row.status === 'done' ? ' done' : ''}${h.view === 'todo' && row.status === 'skipped' ? ' skipped' : ''}`

  // Highlight accent — matches the mobile rows: status (To-Do) overrides urgency.
  // in-progress → blue, done → green, removed → gray; else critical → red,
  // low/needed → gold, on-par → green.
  const accent =
    h.view === 'todo' && row.status === 'in-progress' ? '#2563eb'
    : h.view === 'todo' && row.status === 'done' ? '#16a34a'
    : h.view === 'todo' && row.status === 'skipped' ? '#a1a1aa'
    : u === 'critical' ? '#dc2626'
    : u === 'low' ? '#d97706'
    : '#16a34a'
  const rowStyle = { boxShadow: `inset 3px 0 0 ${accent}` } as React.CSSProperties
  if (h.view === 'todo' && row.status === 'in-progress') {
    (rowStyle as Record<string, string>)['--pw'] = `${Math.max(8, row.pct)}%`
  }

  return (
    <div className={cls} style={rowStyle}>
      <span className={`r-dot ${dotClass(u)}`} style={{ background: accent }} />
      <span className="r-name">
        <span className="nm" onClick={() => h.onOpen(item)}>{row.name}</span>
        {row.stockOut && <span className="tag out">STOCK OUT</span>}
        {statusChip}
      </span>
      <span className="r-stock">{stock}</span>
      <span className="r-make-cell" style={{ textAlign: 'right' }}>{make}</span>
      <span className="r-act">
        {item.linkedRecipeId && <button className="r-recipe" onClick={() => h.onOpenRecipe(item)} title="View recipe"><IcRecipe /></button>}
        {act}
      </span>
    </div>
  )
}
