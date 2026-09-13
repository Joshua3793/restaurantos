'use client'
import { useEffect } from 'react'
import type { PrepItemRich, PrepItemDetail, RecipeStepsData } from '@/components/prep/types'
import { toBoardRow, dotClass, fmtMin, fmtQty } from './prep-board-utils'
import { effectiveUrgency, autoUrgencyOf, whyLabel } from '@/lib/prep-plan'
import { resolveStages, currentStage, stageLabel } from '@/lib/prep-stages'
import PrepRecipeSection from '@/components/prep/PrepRecipeSection'
import { StageList } from '@/components/prep/StageList'
import type { PrepProgress } from '@/lib/prep-progress'

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
  /** Staged prep — move the live log to a stage (Back / Next in the stage list). */
  onStage?: (item: PrepItemRich, stageIndex: number) => void
  /** Saved cook-along state for the item's live log (kept while it is on the To Do). */
  progress?: PrepProgress | null
  onProgressChange?: (patch: { ingredients?: string[]; steps?: string[] }) => void
  /** The chef's switch (Smart Prep view only): off keeps the item out of prep while the recipe stays. Omit to hide it. */
  onSetPrepEnabled?: (item: PrepItemRich, enabled: boolean) => void
}

export function PrepBoardDrawer({ item, detail, view, recipe, recipeLoading, makeQty, onMakeQtyChange, onComplete, onOpenSubRecipe, onClose, onToggleOnList, onStatusChange, onPriorityChange, onEdit, onStage, progress, onProgressChange, onSetPrepEnabled }: DrawerProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const open = !!item
  const r = item ? toBoardRow(item) : null
  // Urgency step behind the "why it's on the list" tint (null while closed).
  const urgency = item ? effectiveUrgency(item) : null
  // Staged prep: the chain and where the live log is in it (null = unstaged).
  const stages = item ? resolveStages(item.linkedRecipe) : null
  const stageAt = stages && item?.todayLog?.status === 'IN_PROGRESS' ? currentStage(stages, item.todayLog) : null
  const u = r?.urgency ?? 'par'
  // Switched off the prep list — the footer offers no "Add to today".
  const prepEnabled = item ? item.prepEnabled !== false : true
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
                {stageAt && stages && <span className="tag station">{stageLabel(stageAt.index, stages.length, stageAt.stage).toUpperCase()}</span>}
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

                {/* Why it's on the list. The run-sheet rows used to carry this
                    sentence (and the "LOW STOCK: …" pill) beside the item name,
                    where it truncated the name on iPad and narrow desktop — it
                    reads here instead, with room to wrap. */}
                <div
                  className={`rounded-[10px] border px-3.5 py-3 ${
                    urgency === 'PASS'
                      ? 'bg-red-soft border-red-soft text-red-text'
                      : urgency === 'MID'
                        ? 'bg-gold-soft border-gold text-gold-2'
                        : 'bg-paper border-line text-ink-2'
                  }`}
                >
                  <div className="font-mono text-[9.5px] uppercase tracking-[0.06em] opacity-70">
                    Why it&apos;s on the list
                  </div>
                  <div className="text-[12.5px] font-medium mt-1 leading-snug first-letter:uppercase">
                    {whyLabel(item)}
                  </div>
                  {item.blockedReason && (
                    <div className="font-mono text-[11px] mt-1.5 leading-snug">⚠ {item.blockedReason}</div>
                  )}
                </div>
              </div>

              <div className="dr-sec">
                <div className="sl">Needed — the step sets the deadline{item.manualPriorityOverride ? ' · chef override' : ''}</div>
                <div className="ovr-row">
                  {/* ONE urgency dial (Smart Prep v2). Clicking the active overridden
                      step clears back to smart; picking the auto step also clears. */}
                  {([['PASS', 'Critical', 'crit'], ['MID', 'Mid-svc', 'low'], ['CLOSE', 'By close', 'mid'], ['TMRW', 'Tomorrow', 'par']] as const).map(([step, label, cls]) => {
                    const active = effectiveUrgency(item) === step
                    return (
                      <button key={step} className={`ovr-btn ${cls} ${active ? 'on' : ''}`}
                        onClick={() => onPriorityChange(r.id, (active && item.manualPriorityOverride) || step === autoUrgencyOf(item) ? '' : step)}>
                        {label}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Stage chain — current stage lit; Back / Next mirror the run sheet. */}
              {stages && (
                <div className="dr-sec">
                  <div className="sl">Stages{stageAt ? ` · ${stageLabel(stageAt.index, stages.length, stageAt.stage)}` : ''}</div>
                  <StageList
                    stages={stages}
                    log={item.todayLog ?? null}
                    onStage={onStage && view !== 'smart' && r.status === 'in-progress' ? (idx) => onStage(item, idx) : undefined}
                  />
                </div>
              )}

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
                    log={item.todayLog ?? null}
                    onStage={onStage && view !== 'smart' && r.status === 'in-progress' ? (idx) => onStage(item, idx) : undefined}
                    progress={progress}
                    onProgressChange={onProgressChange}
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

              {/* Prepped on the line — the chef's switch. Off keeps the item out of
                  Smart Prep and every prep view while the recipe stays exactly as it
                  is (feature / special recipes). Locked while the item is on the draft
                  or the kitchen's To Do: take it off the list first. */}
              {view === 'smart' && onSetPrepEnabled && (() => {
                const onList = item.isOnList || !!item.todayLog?.postedAt
                const lockedSwitch = prepEnabled && onList
                return (
                  <div className="dr-sec">
                    <div className="sl">Prepped on the line</div>
                    <div className="flex items-start gap-3 mt-1">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={prepEnabled}
                        aria-label={prepEnabled ? 'Prepped on the line' : 'Not prepped'}
                        disabled={lockedSwitch}
                        onClick={() => onSetPrepEnabled(item, !prepEnabled)}
                        title={lockedSwitch ? 'On the list — take it off before switching it out of prep' : undefined}
                        className={`relative shrink-0 mt-0.5 w-[34px] h-[20px] rounded-full border transition-colors ${prepEnabled ? 'bg-green border-green' : 'bg-bg-2 border-line-2'} ${lockedSwitch ? 'opacity-40 cursor-not-allowed' : ''}`}
                      >
                        <span className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white transition-all ${prepEnabled ? 'left-[16px]' : 'left-[2px]'}`} />
                      </button>
                      <span className="text-[12.5px] text-ink-2 leading-snug">
                        {prepEnabled
                          ? 'On the prep list. Switch off to keep this recipe out of prep — it stays in the Recipe Book.'
                          : 'Not prepped. Switch on to see it in Smart Prep again.'}
                        {lockedSwitch && <span className="block font-mono text-[10.5px] text-ink-4 mt-1">Take it off the list first.</span>}
                      </span>
                    </div>
                  </div>
                )
              })()}
            </div>
            <div className="dr-foot">
              {view === 'smart'
                ? (!prepEnabled
                    ? <button className="btn" onClick={onClose}>Not prepped</button>
                    : r.onList ? <button className="btn" onClick={onClose}>On today&apos;s list ✓</button> : <button className="btn btn-primary" onClick={() => { onToggleOnList(r.id, true); onClose() }}><span className="ic">+</span> Add to today</button>)
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
              {item.linkedRecipeId && (
                <button className="btn" onClick={() => onEdit(item)} title="Par, shelf life and stations live on the recipe">
                  <span className="ic"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></span>
                  Edit recipe
                </button>
              )}
            </div>
          </>
        )}
      </aside>
    </>
  )
}
