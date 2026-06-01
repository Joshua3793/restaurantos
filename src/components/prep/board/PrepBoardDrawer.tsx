'use client'
import { useEffect, useState } from 'react'
import type { PrepItemRich, PrepItemDetail } from '@/components/prep/types'
import { toBoardRow, dotClass, fmtMin, fmtQty } from './prep-board-utils'

const X = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12"/></svg>)

export interface DrawerProps {
  item: PrepItemRich | null
  view: 'todo' | 'smart'
  onClose: () => void
  onToggleOnList: (id: string, next: boolean) => void
  onStatusChange: (item: PrepItemRich, status: string) => void
  onPriorityChange: (id: string, priority: string) => void
  onEdit: (item: PrepItemRich) => void
}

export function PrepBoardDrawer({ item, view, onClose, onToggleOnList, onStatusChange, onPriorityChange, onEdit }: DrawerProps) {
  const [detail, setDetail] = useState<PrepItemDetail | null>(null)
  const [steps, setSteps] = useState<string[]>([])

  useEffect(() => {
    setDetail(null); setSteps([])
    if (!item) return
    let cancelled = false
    ;(async () => {
      try {
        const d = await fetch(`/api/prep/items/${item.id}`).then(r => r.ok ? r.json() : null)
        if (!cancelled && d) setDetail(d)
      } catch { /* ignore */ }
      if (item.linkedRecipeId) {
        try {
          const r = await fetch(`/api/recipes/${item.linkedRecipeId}`).then(r => r.ok ? r.json() : null)
          const arr: string[] = Array.isArray(r?.steps) ? r.steps.map(String)
            : (typeof r?.notes === 'string' ? r.notes.replace(/^\s*(instructions?|method|steps)\s*:?\s*/i, '').split(/\n+|(?=\d+[.)]\s)/).map((s: string) => s.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean) : [])
          if (!cancelled) setSteps(arr)
        } catch { /* ignore */ }
      }
    })()
    return () => { cancelled = true }
  }, [item])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const open = !!item
  const r = item ? toBoardRow(item) : null
  const u = r?.urgency ?? 'par'
  const uLabel = u === 'critical' ? 'CRITICAL' : u === 'low' ? 'NEEDED TODAY' : 'ON PAR'
  const barColor = u === 'critical' ? 'var(--red)' : u === 'low' ? 'var(--gold)' : 'var(--green)'
  const rationale = r
    ? (r.make > 0
        ? `${fmtQty(r.onHand)} ${r.unit} on hand against a ${fmtQty(r.par)} par — system suggests making ${fmtQty(r.make)} ${r.unit} to cover through the next count.`
        : `At or above par (${r.pct}%). No make needed right now; the board updates as sales and wastage move stock.`)
    : ''

  return (
    <>
      <div className={`pb-scrim${open ? ' show' : ''}`} onClick={onClose} />
      <aside className={`pb-drawer${open ? ' show' : ''}`}>
        {r && item && (
          <>
            <div className="dr-head">
              <div className="dr-top">
                <div>
                  <div className="dr-cat"><span className={`r-dot ${dotClass(u)}`} style={{ display: 'inline-block' }} /> {r.cat.toUpperCase()} · {r.station} · {uLabel}</div>
                  <div className="dr-title">{r.name}</div>
                </div>
                <button className="dr-close" onClick={onClose}><X /></button>
              </div>
              <div className="dr-chips">
                {r.stockOut && <span className="tag out">STOCK OUT</span>}
                {r.overridden && <span className="tag ovr">✎ CHEF OVERRIDE</span>}
                <span className="tag station">{r.station}</span>
                {r.prepMin > 0 && <span className="tag station">~{fmtMin(r.prepMin)} PREP</span>}
              </div>
            </div>
            <div className="dr-body">
              <div className="dr-sec">
                <div className="dr-suggest">
                  {r.make > 0
                    ? <span className={`big ${u === 'critical' ? 'crit' : 'low'}`}>make {fmtQty(r.make)} {r.unit}</span>
                    : <span className="big" style={{ color: 'var(--green-text)' }}>At par — no make needed</span>}
                  <div className="rat">{rationale}</div>
                </div>
                <div className="dr-barlbl"><span><b>{fmtQty(r.onHand)}</b> / {fmtQty(r.par)} {r.unit} on hand</span><span>{r.pct}% of par</span></div>
                <div className="dr-bar"><div className="fill" style={{ width: `${Math.max(2, Math.min(100, r.pct))}%`, background: barColor }} /></div>
              </div>

              <div className="dr-sec">
                <div className="sl">Priority override</div>
                <div className="ovr-row">
                  <button className={`ovr-btn crit ${u === 'critical' ? 'on' : ''}`} onClick={() => onPriorityChange(r.id, '911')}>Critical</button>
                  <button className={`ovr-btn low ${u === 'low' ? 'on' : ''}`} onClick={() => onPriorityChange(r.id, 'NEEDED_TODAY')}>Needed today</button>
                  <button className={`ovr-btn par ${u === 'par' ? 'on' : ''}`} onClick={() => onPriorityChange(r.id, 'LATER')}>Later</button>
                </div>
              </div>

              {steps.length > 0 && (
                <div className="dr-sec">
                  <div className="sl">Method · {steps.length} steps</div>
                  <div className="steps">{steps.map((s, n) => <div className="step" key={n}><span className="n">{n + 1}</span><span>{s}</span></div>)}</div>
                </div>
              )}

              {detail?.ingredients && detail.ingredients.length > 0 && (
                <div className="dr-sec">
                  <div className="sl">Ingredients</div>
                  <div>{detail.ingredients.map(ing => {
                    const short = ing.isAvailable === false
                    return <div className="ing" key={ing.id}><span>{ing.itemName}</span><span className={`iq ${short ? 'short' : ''}`}>{fmtQty(ing.qtyBase)} {ing.unit}{short ? ' · short' : ''}</span></div>
                  })}</div>
                </div>
              )}

              {item.lastMadeAt && (
                <div className="dr-sec">
                  <div className="sl">Recent history</div>
                  <div><div className="hist"><span>Last made</span><span>{new Date(item.lastMadeAt).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase()}</span><span style={{ color: 'var(--green-text)' }}>DONE</span></div></div>
                </div>
              )}
            </div>
            <div className="dr-foot">
              {view === 'smart'
                ? (r.onList ? <button className="btn" onClick={onClose}>On today&apos;s list ✓</button> : <button className="btn btn-primary" onClick={() => { onToggleOnList(r.id, true); onClose() }}><span className="ic">+</span> Add to today</button>)
                : (r.status === 'not-started' ? <button className="btn btn-primary" onClick={() => { onStatusChange(item, 'IN_PROGRESS'); onClose() }}><span className="ic">▶</span> Start prep</button>
                  : r.status === 'in-progress' ? <button className="btn btn-primary" onClick={() => { onStatusChange(item, 'DONE'); onClose() }}><span className="ic">✓</span> Mark done</button>
                  : <button className="btn" onClick={onClose}>Close</button>)}
              <button className="btn" onClick={() => onEdit(item)}>
                <span className="ic"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></span>
                Edit prep settings
              </button>
            </div>
          </>
        )}
      </aside>
    </>
  )
}
