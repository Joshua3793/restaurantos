'use client'
import { useState } from 'react'
import { BoardRow } from './prep-board-utils'
import { PrepRow, RowHandlers } from './PrepRow'

export interface LaterProps {
  variant: 'par' | 'closed'
  rows: BoardRow[]
  h: RowHandlers
}

export function PrepLater({ variant, rows, h }: LaterProps) {
  const [open, setOpen] = useState(false)
  const title = variant === 'par' ? 'ON PAR / LATER' : 'DONE / REMOVED'
  const meta = variant === 'par' ? '· at or above par — no action needed' : "· completed or taken off today's list"
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
