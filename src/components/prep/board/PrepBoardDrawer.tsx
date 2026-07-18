'use client'
import { useEffect } from 'react'
import type { PrepItemRich, PrepItemDetail, RecipeStepsData } from '@/components/prep/types'
import { toBoardRow, dotClass, fmtMin, fmtQty } from './prep-board-utils'
import PrepRecipeSection from '@/components/prep/PrepRecipeSection'

const X = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12"/></svg>)

export interface DrawerProps {
  item: PrepItemRich | null
  detail: PrepItemDetail | null
  view: 'todo' | 'smart'
  /** Linked recipe (steps + cost) for the embedded cook-along; null when the item has none. */
  recipe: RecipeStepsData | null
  recipeLoading: boolean
  /** Make quantity from the cook-along slider (or the no-recipe qty input) — what "Done" credits. */
  makeQty: number
  onMakeQtyChange: (qty: number) => void
  /** Complete the prep at makeQty (host decides DONE vs PARTIAL by the suggested rule). */
  onComplete: (item: PrepItemRich, qty: number) => void
  /** Open a sub-recipe ingredient's recipe (e.g. tap "Custard" inside French Toast). */
  onOpenSubRecipe: (recipeId: string, name: string) => void
  onClose: () => void
  onToggleOnList: (id: string, next: boolean) => void
  onStatusChange: (item: PrepItemRich, status: string, qty?: number) => void
  onPriorityChange: (id: string, priority: string) => void
  onEdit: (item: PrepItemRich) => void
}

export function PrepBoardDrawer({ item, detail, view, recipe, recipeLoading, makeQty, onMakeQtyChange, onComplete, onOpenSubRecipe, onClose, onToggleOnList, onStatusChange, onPriorityChange, onEdit }: DrawerProps) {
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

  const complete = () => { if (item) { onComplete(item, makeQty); onClose() } }

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

              {/* Recipe & method — embedded cook-along (upscale · ingredients · method) */}
              {item.linkedRecipeId && (
                <div className="dr-sec">
                  <div className="sl">Recipe &amp; method</div>
                  <PrepRecipeSection
                    recipe={recipe}
                    ingredients={detail?.ingredients ?? []}
                    loading={recipeLoading}
                    unit={r.unit}
                    makeQty={makeQty}
                    onMakeQtyChange={onMakeQtyChange}
                    onOpenSubRecipe={onOpenSubRecipe}
                  />
                </div>
              )}

              {/* No-recipe items have no upscale slider — a plain qty input keeps the yield editable. */}
              {!item.linkedRecipeId && view !== 'smart' && r.status !== 'done' && (
                <div className="dr-sec">
                  <div className="sl">Make ({r.unit})</div>
                  <input
                    type="number" inputMode="decimal" value={makeQty || ''}
                    onChange={e => onMakeQtyChange(parseFloat(e.target.value) || 0)}
                    placeholder={`e.g. ${fmtQty(r.make)}`}
                    className="bg-paper border border-line rounded-[9px] px-3 py-2 text-[13px] font-mono outline-none focus:border-ink-3"
                  />
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
                : (r.status === 'not-started'
                    ? <button className="btn btn-primary" onClick={() => { onStatusChange(item, 'IN_PROGRESS'); onClose() }}><span className="ic">▶</span> Start prep</button>
                    : r.status === 'in-progress'
                      ? <button className="btn" style={{ background: 'var(--green)', color: '#fff', borderColor: 'var(--green)' }} title={`Add ${fmtQty(makeQty)} ${r.unit}`} onClick={complete}><span className="ic" style={{ color: '#fff' }}>✓</span> Done · {fmtQty(makeQty)} {r.unit}</button>
                      : <button className="btn" onClick={onClose}>Close</button>)}
              {/* Stop = abandon the in-progress prep (no qty logged) → back to the
                  to-do list. No inventory effect (only DONE/PARTIAL credit). */}
              {view !== 'smart' && r.status === 'in-progress' && (
                <button className="btn" onClick={() => { onStatusChange(item, 'NOT_STARTED'); onClose() }}><span className="ic">↩</span> Stop</button>
              )}
              <button className="btn" onClick={() => onEdit(item)}>
                <span className="ic"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></span>
                Edit
              </button>
            </div>
          </>
        )}
      </aside>
    </>
  )
}
