'use client'
import { useState } from 'react'
import { BoardRow } from './prep-board-utils'
import { PrepRow, RowHandlers } from './PrepRow'

export interface LaterProps {
  // par    → Smart Prep "on par / get ahead" suggestions
  // later  → To Do items the user added that are above par ("if time allows")
  // closed → To Do items completed today
  variant: 'par' | 'later' | 'closed'
  rows: BoardRow[]
  h: RowHandlers
}

const COPY: Record<LaterProps['variant'], { title: string; meta: string }> = {
  par:    { title: 'ON PAR / LATER',         meta: '· at or above par — no action needed' },
  later:  { title: 'LATER · IF TIME ALLOWS', meta: '· above par — added manually, do after the essentials' },
  closed: { title: 'DONE TODAY',            meta: "· prepped this session — kept as today's record" },
}

export function PrepLater({ variant, rows, h }: LaterProps) {
  // Default the "Later" block open (it's part of today's plan); keep the
  // suggestion/done strips collapsed.
  const [open, setOpen] = useState(variant === 'later')
  const { title, meta } = COPY[variant]
  return (
    <div className={`later${open ? ' open' : ''}`}>
      <div className="later-strip" onClick={() => setOpen(o => !o)}>
        <span className="chev">▶</span>
        <span className="lt" style={{ color: 'var(--green-text)' }}>{title}</span>
        <span className="lmeta">{meta}</span>
        <span className="lcount">{rows.length} ITEMS {open ? '· COLLAPSE' : '· EXPAND'}</span>
      </div>
      <div className="later-body">
        <div className="later-grid">{rows.map(r => <PrepRow key={r.id} row={r} h={h} />)}</div>
        {variant === 'par' && <div className="later-note">ADD MANUALLY ONLY IF YOU HAVE AN EVENT OR KNOW SOMETHING THE SYSTEM DOESN&apos;T</div>}
      </div>
    </div>
  )
}
