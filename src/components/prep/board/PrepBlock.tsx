'use client'
import { BoardRow, fmtMin, totalMin } from './prep-board-utils'
import { PrepRow, RowHandlers } from './PrepRow'

const Check = () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><polyline points="20 6 9 17 4 12"/></svg>)

export interface BlockProps {
  kind: 'crit' | 'low' | ''
  title: string
  rows: BoardRow[]
  h: RowHandlers
  addAll?: boolean
  onAddAll?: () => void
}

export function PrepBlock({ kind, title, rows, h, addAll, onAddAll }: BlockProps) {
  const mins = totalMin(rows)
  const meta = rows.length ? `· ${rows.length} item${rows.length > 1 ? 's' : ''}${mins ? ` · ~${fmtMin(mins)}` : ''}` : ''
  const dotCls = kind === 'crit' ? 'dot-red' : kind === 'low' ? 'dot-amber' : 'dot-gray'
  const showAddAll = addAll && rows.some(r => !r.onList) && rows.length > 0
  return (
    <div className={`block ${kind}`}>
      <div className="bk-head">
        <span className={`bk-dot ${dotCls}`} />
        <span className="bk-title">{title}</span>
        <span className="bk-meta" dangerouslySetInnerHTML={{ __html: meta.replace(/~([\dhm ]+)/, '<b>~$1</b>') }} />
        {showAddAll && <button className="bk-action" onClick={onAddAll}>+ Add all</button>}
      </div>
      <div className="bk-body">
        {rows.length === 0 ? (
          <div className="bk-empty">
            <div className="ei"><Check /></div>
            <div className="et">All clear</div>
            <div className="es">Nothing needs prepping here.</div>
          </div>
        ) : rows.map(r => <PrepRow key={r.id} row={r} h={h} />)}
      </div>
    </div>
  )
}
