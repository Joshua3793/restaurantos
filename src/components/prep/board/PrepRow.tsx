'use client'
import { useState } from 'react'
import type { PrepItemRich } from '@/components/prep/types'
import { BoardRow, dotClass, fmtQty } from './prep-board-utils'
import { IcRecipe } from '@/components/prep/icons'

// NOTE: this row is SMART-PREP ONLY. It used to carry a `view: 'todo' | 'smart'`
// discriminator, but the To-Do board was replaced by the run sheet (RunSheet /
// RunSheetMobile) and `PrepBoard` has only ever been rendered with view="smart"
// since. The todo branches — status chips, Start/Done/Reset/Restore actions, the
// make column, the in-progress progress-fill — were unreachable, so they are gone
// along with the `onStatusChange` / `onQuickDone` handlers that only they called.
// The run sheet owns all of that now.
export interface RowHandlers {
  onOpen: (item: PrepItemRich) => void
  onOpenRecipe: (item: PrepItemRich) => void
  onToggleOnList: (id: string, next: boolean) => void
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

  const act = row.onList
    ? <button className="act-btn act-onlist" onClick={() => h.onToggleOnList(row.id, false)}>On list ✓</button>
    : <button className={`act-btn ${u === 'par' ? 'act-ghost' : 'act-add'}`} onClick={() => h.onToggleOnList(row.id, true)}><span className="ic">+</span> Add</button>

  // Inline priority pill — shows the effective priority and lets you override it
  // without a full drawer trip (mirrors the mobile Smart Prep chip).
  const eff = item.manualPriorityOverride ?? item.priority
  const priChip = u === 'critical'
    ? { label: 'Critical', cls: 'crit' }
    : u === 'low'
      ? { label: 'Needed', cls: 'low' }
      : { label: 'On par', cls: 'par' }
  const priorityPill = (
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
  )

  // Highlight accent — critical → red, low/needed → gold, on-par → green.
  const accent = u === 'critical' ? '#dc2626' : u === 'low' ? '#d97706' : '#16a34a'
  const rowStyle = {
    boxShadow: `inset 3px 0 0 ${accent}`,
    ...(saving ? { opacity: 0.55, transition: 'opacity 120ms' } : {}),
  } as React.CSSProperties

  return (
    <div className="row smart" style={rowStyle}>
      <span className={`r-dot ${dotClass(u)}`} style={{ background: accent }} />
      <span className="r-name">
        <span className="nm" onClick={() => h.onOpen(item)}>{row.name}</span>
        {row.stockOut && <span className="tag out">STOCK OUT</span>}
      </span>
      <span className="r-stock">{stock}</span>
      {/* Smart Prep deliberately hides the make/pct column to give the name more room. */}
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
