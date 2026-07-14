'use client'
import { useState } from 'react'
import type { PrepItemRich } from '@/components/prep/types'
import { BoardRow, dotClass, fmtQty } from './prep-board-utils'
import { IcRecipe } from '@/components/prep/icons'

export interface RowHandlers {
  view: 'todo' | 'smart'
  onOpen: (item: PrepItemRich) => void
  onOpenRecipe: (item: PrepItemRich) => void
  onToggleOnList: (id: string, next: boolean) => void
  onStatusChange: (item: PrepItemRich, status: string, qty?: number) => void
  /** One-tap "Done" on an in-progress row: pops the yield prompt directly (no full drawer). */
  onQuickDone: (item: PrepItemRich) => void
  onPriorityChange: (id: string, priority: string) => void
  /** Item ids whose mutation is in flight — row dims while saving. */
  savingIds?: Set<string>
}

export function PrepRow({ row, h }: { row: BoardRow; h: RowHandlers }) {
  const { item, urgency: u } = row
  const saving = h.savingIds?.has(row.id) ?? false
  const [priOpen, setPriOpen] = useState(false)
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
    else if (row.status === 'in-progress') act = <button className="act-btn act-done" onClick={() => h.onQuickDone(item)}>✓ Done</button>
    else if (row.status === 'done') act = <button className="act-btn act-ghost" onClick={() => h.onStatusChange(item, 'NOT_STARTED')}>↻ Reset</button>
    else act = <button className="act-btn act-ghost" onClick={() => h.onStatusChange(item, 'NOT_STARTED')}>↩ Restore</button>
  }

  // Inline priority pill — smart view only; shows the effective priority and lets
  // you override it without a full drawer trip (mirrors the mobile Smart Prep chip).
  const eff = item.manualPriorityOverride ?? item.priority
  const priChip = u === 'critical'
    ? { label: 'Critical', cls: 'crit' }
    : u === 'low'
      ? { label: 'Needed', cls: 'low' }
      : { label: 'On par', cls: 'par' }
  const priorityPill = h.view === 'smart' ? (
    <span className="r-pri" onClick={e => e.stopPropagation()}>
      <button type="button" className={`pri-chip ${priChip.cls}`} title="Change priority"
        onClick={() => setPriOpen(o => !o)}>
        {row.overridden && <span className="ov">✎</span>}{priChip.label}
      </button>
      {priOpen && (
        <>
          <span className="pri-scrim" onClick={() => setPriOpen(false)} />
          <span className="pri-menu" role="menu">
            {([['911', 'Critical'], ['NEEDED_TODAY', 'Needed today'], ['LATER', 'Later']] as const).map(([p, label]) => (
              <button key={p} role="menuitem" className={eff === p ? 'on' : ''}
                onClick={() => { setPriOpen(false); h.onPriorityChange(row.id, p) }}>
                {eff === p ? '✓ ' : ''}{label}
              </button>
            ))}
            {row.overridden && (
              <button role="menuitem" className="reset"
                onClick={() => { setPriOpen(false); h.onPriorityChange(row.id, '') }}>
                Reset to auto
              </button>
            )}
          </span>
        </>
      )}
    </span>
  ) : null

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
  const rowStyle = { boxShadow: `inset 3px 0 0 ${accent}`, ...(saving ? { opacity: 0.55, transition: 'opacity 120ms' } : {}) } as React.CSSProperties
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
        {priorityPill}
        {/* Labeled tinted pill (mirrors the mobile row) — a bare book icon read as
            decoration; the label makes the cook-along shortcut discoverable. */}
        {item.linkedRecipeId && <button className="r-recipe" onClick={() => h.onOpenRecipe(item)} title="View recipe"><IcRecipe size={12} /> Recipe</button>}
        {act}
      </span>
    </div>
  )
}
