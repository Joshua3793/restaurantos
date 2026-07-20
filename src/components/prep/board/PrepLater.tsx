'use client'
import { useState } from 'react'
import { BoardRow } from './prep-board-utils'
import { PrepRow, RowHandlers } from './PrepRow'

// Smart Prep's "on par / get ahead" strip. The `later` and `closed` variants
// belonged to the To-Do board, which the run sheet replaced — both were
// unreachable, so the variant discriminator is gone. See PrepRow for the note.
export interface LaterProps {
  rows: BoardRow[]
  h: RowHandlers
}

export function PrepLater({ rows, h }: LaterProps) {
  // Collapsed by default — these are suggestions, not today's plan.
  const [open, setOpen] = useState(false)
  const title = 'ON PAR / LATER'
  const meta  = '· at or above par — no action needed'
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
        <div className="later-note">ADD MANUALLY ONLY IF YOU HAVE AN EVENT OR KNOW SOMETHING THE SYSTEM DOESN&apos;T</div>
      </div>
    </div>
  )
}
