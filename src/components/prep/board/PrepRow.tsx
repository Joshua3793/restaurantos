'use client'
import type { PrepItemRich } from '@/components/prep/types'
import { BoardRow, dotClass, fmtQty } from './prep-board-utils'

export interface RowHandlers {
  view: 'todo' | 'smart'
  onOpen: (item: PrepItemRich) => void
  onOpenRecipe: (item: PrepItemRich) => void
  onToggleOnList: (id: string, next: boolean) => void
  onStatusChange: (item: PrepItemRich, status: string, qty?: number) => void
  onPriorityChange: (id: string, priority: string) => void
}

const Recipe = () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h12a4 4 0 0 1 4 4v12H8a4 4 0 0 1-4-4V4z"/><path d="M4 16a4 4 0 0 1 4-4h12"/></svg>)
const Prio = () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 21V4M4 4h13l-2 4 2 4H4"/></svg>)
const More = () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>)

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
    else if (row.status === 'in-progress') act = <button className="act-btn act-done" onClick={() => h.onStatusChange(item, 'DONE')}>✓ Done</button>
    else if (row.status === 'done') act = <button className="act-btn act-ghost" onClick={() => h.onStatusChange(item, 'NOT_STARTED')}>↻ Reset</button>
    else act = <button className="act-btn act-ghost" onClick={() => h.onStatusChange(item, 'NOT_STARTED')}>↩ Restore</button>
  }

  const cls = `row${h.view === 'todo' && row.status === 'in-progress' ? ' inprog' : ''}${h.view === 'todo' && row.status === 'done' ? ' done' : ''}${h.view === 'todo' && row.status === 'skipped' ? ' skipped' : ''}`
  const progStyle = h.view === 'todo' && row.status === 'in-progress' ? ({ ['--pw' as string]: `${Math.max(8, row.pct)}%` } as React.CSSProperties) : undefined

  return (
    <div className={cls} style={progStyle}>
      <span className={`r-dot ${dotClass(u)}`} />
      <span className="r-name">
        <span className="nm" onClick={() => h.onOpen(item)}>{row.name}</span>
        {row.stockOut && <span className="tag out">STOCK OUT</span>}
        {row.overridden && <span className="r-edit" title="Priority overridden by chef">✎</span>}
        {statusChip}
      </span>
      <span className="r-stock">{stock}</span>
      <span className="r-make-cell" style={{ textAlign: 'right' }}>{make}</span>
      <span className="r-reveal">
        <button onClick={() => h.onOpenRecipe(item)} title="View recipe"><Recipe /></button>
        <button onClick={() => h.onOpen(item)} title="Change priority"><Prio /></button>
        <button onClick={() => h.onOpen(item)} title="More"><More /></button>
      </span>
      <span className="r-act">{act}</span>
    </div>
  )
}
