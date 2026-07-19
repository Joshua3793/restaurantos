'use client'

import { useEffect } from 'react'
import {
  IcX,
  IcCheck,
  IcPlay,
  IcUndo,
  IcAlert,
  IcClock,
} from '@/components/prep/icons'
import { PrepItemRich, PrepItemDetail, PrepStatus, RecipeStepsData } from '@/components/prep/types'
import { PREP_STATE_META, formatShortAge, PrepCountdown } from '@/lib/prep-utils'
import PrepRecipeSection from '@/components/prep/PrepRecipeSection'

interface PrepDrawerProps {
  item: PrepItemRich | null
  detail: PrepItemDetail | null
  countdown: PrepCountdown | null
  /** Linked recipe (steps + cost) for the embedded cook-along; null when the item has none. */
  recipe: RecipeStepsData | null
  recipeLoading: boolean
  /** Make quantity from the cook-along slider (or the no-recipe qty input) — what "Done" credits. */
  makeQty: number
  onMakeQtyChange: (qty: number) => void
  onClose: () => void
  onStatusChange: (item: PrepItemRich, status: PrepStatus, actualQty?: number) => void
  /** Complete the prep at makeQty (host decides DONE vs PARTIAL by the suggested rule). */
  onComplete: (item: PrepItemRich, qty: number) => void
  /** Open a sub-recipe ingredient's recipe (e.g. tap "Custard" inside French Toast). */
  onOpenSubRecipe: (recipeId: string, name: string) => void
  /** Remove from today's list → back to Smart Prep (isOnList=false). No log written. */
  onRemove: (item: PrepItemRich) => void
}

type StateKey = 'not-started' | 'in-progress' | 'done' | 'skipped'

/** Mirrors the design's fmt(): >=100 int w/ commas, >=10 one decimal, else two; strip trailing .0 */
function fmt(n: number): string {
  const v = Number(n) || 0
  let s: string
  if (v >= 100) s = Math.round(v).toLocaleString()
  else if (v >= 10) s = (Math.round(v * 10) / 10).toString()
  else s = (Math.round(v * 100) / 100).toString()
  return s.replace(/\.0+$/, '')
}

// ── Sub-components (module scope) ──────────────────────────────────

function Pill({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span
      className={`font-mono text-[9.5px] uppercase font-semibold px-2 py-[3px] rounded-[5px] inline-flex items-center gap-1.5 ${className}`}
    >
      {children}
    </span>
  )
}

function StatItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-[7px]">
      <span className="font-mono text-[10px] uppercase tracking-[0.03em] text-ink-4">{label}</span>
      <span className="font-mono text-[13px] font-semibold text-white">{value}</span>
    </div>
  )
}

function Divider() {
  return <span className="w-px h-3.5 bg-ink-2" aria-hidden="true" />
}

function SecLabel({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="font-mono text-[10px] uppercase tracking-[0.05em] text-ink-3 mb-2.5 flex items-center justify-between">
      <span>{children}</span>
      {right != null && <span className="text-ink-2 font-semibold">{right}</span>}
    </div>
  )
}

function Tile({
  label,
  value,
  unit,
  danger,
  dark,
}: {
  label: string
  value: string
  unit: string
  danger?: boolean
  dark?: boolean
}) {
  return (
    <div
      className={`rounded-[11px] px-3.5 py-3 ${dark ? 'bg-ink border-ink' : 'bg-paper border-line'} border`}
    >
      <div className={`font-mono text-[9.5px] uppercase tracking-[0.04em] ${dark ? 'text-ink-4' : 'text-ink-3'}`}>
        {label}
      </div>
      <div
        className={`text-[23px] font-semibold tracking-[-0.03em] mt-[7px] leading-none ${
          dark ? 'text-white' : danger ? 'text-red-text' : ''
        }`}
      >
        {value}
        <span className={`text-[12px] font-medium ml-0.5 ${dark ? 'text-gold' : 'text-ink-3'}`}>{unit}</span>
      </div>
    </div>
  )
}

function StatusPill({ stateKey, label }: { stateKey: StateKey; label: string }) {
  let pillCls = 'bg-bg-2 text-ink-3'
  let dotCls = 'bg-ink-3'
  if (stateKey === 'in-progress') {
    pillCls = 'bg-blue-soft text-blue-text'
    dotCls = 'bg-blue animate-pulse'
  } else if (stateKey === 'done') {
    pillCls = 'bg-green-soft text-green-text'
    dotCls = 'bg-green-text'
  }
  return (
    <span
      className={`font-mono text-[10px] px-2.5 py-1 rounded-full font-semibold uppercase inline-flex items-center gap-1.5 ${pillCls}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${dotCls}`} />
      {label}
    </span>
  )
}

// ── Main component ─────────────────────────────────────────────────

export default function PrepDrawer({
  item,
  detail,
  countdown,
  recipe,
  recipeLoading,
  makeQty,
  onMakeQtyChange,
  onClose,
  onStatusChange,
  onComplete,
  onOpenSubRecipe,
  onRemove,
}: PrepDrawerProps) {
  const open = item !== null

  // Escape closes the drawer.
  useEffect(() => {
    if (!open) return
    function handle(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handle)
    return () => document.removeEventListener('keydown', handle)
  }, [open, onClose])

  const status: PrepStatus = item?.todayLog?.status ?? 'NOT_STARTED'
  const stateKey = PREP_STATE_META[status].key as StateKey

  const shortCount = detail?.ingredientShortCount ?? item?.ingredientShortCount ?? 0
  const totalCount =
    detail?.ingredientTotalCount ??
    detail?.ingredients.length ??
    item?.ingredientTotalCount ??
    0

  const complete = () => {
    if (!item) return
    onComplete(item, makeQty)
    onClose()
  }
  const doneLabel = `Done · add ${fmt(makeQty)} ${item?.unit ?? ''}`

  return (
    <>
      {/* SCRIM */}
      <div
        onClick={onClose}
        // Plain dim overlay — NO backdrop-blur. A full-viewport `backdrop-filter: blur()`
        // re-blurs the entire animating prep page every frame and stacks over the nav's
        // own backdrop-filter, which froze the app on weaker laptops (see PrepDoneSheet).
        className={`fixed inset-0 z-40 bg-[rgba(9,9,11,0.6)] transition-opacity ${
          open ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        aria-hidden="true"
      />

      {/* PANEL */}
      <aside
        role="dialog"
        aria-label="Prep item detail"
        aria-hidden={!open}
        className={`fixed top-0 right-0 bottom-0 z-50 w-full max-w-[100vw] sm:max-w-[580px] bg-bg border-l border-line-2 shadow-2xl flex flex-col overflow-hidden transition-transform duration-300 ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {item && (
          <>
            {/* HEAD */}
            <div className="px-[22px] py-[18px] bg-paper border-b border-line flex items-start gap-3.5" style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 18px)' }}>
              <button
                type="button"
                aria-label="Close"
                onClick={onClose}
                className="w-8 h-8 rounded-lg border border-line grid place-items-center text-ink-2 hover:border-ink-3 shrink-0"
              >
                <IcX size={15} />
              </button>
              <div className="flex-1 min-w-0">
                {(item.priority === '911' || item.isBlocked) && (
                  <div className="flex items-center gap-[7px] mb-2 flex-wrap">
                    {item.priority === '911' && (
                      <Pill className="bg-red-soft text-red-text">
                        <span className="w-1.5 h-1.5 rounded-full bg-red" />
                        Critical
                      </Pill>
                    )}
                    {item.isBlocked && (
                      <Pill className="bg-gold-soft text-gold-2">Blocked · stock out</Pill>
                    )}
                  </div>
                )}
                <h2 className="text-[22px] font-semibold tracking-[-0.03em] leading-[1.1]">{item.name}</h2>
                <div className="font-mono text-[11px] text-ink-3 mt-1.5">
                  {item.category} · {item.station ?? 'No station'} · carries over daily
                </div>
              </div>
            </div>

            {/* IMPACT STRIP */}
            <div className="bg-ink text-paper px-[22px] py-[11px] flex items-center gap-5">
              <StatItem label="Make" value={`${fmt(item.suggestedQty)} ${item.unit}`} />
              {recipe && recipe.totalCost > 0 && (
                <>
                  <Divider />
                  <StatItem label="Batch value" value={`$${recipe.totalCost.toFixed(2)}`} />
                </>
              )}
              <Divider />
              <StatItem label="Last made" value={formatShortAge(item.lastMadeAt)} />
            </div>

            {/* BANNER */}
            {item.isBlocked && (
              <div className="bg-gradient-to-b from-[#fffbeb] to-[#fef9ec] border-b border-[#fcd34d] px-[22px] py-[11px] flex items-center gap-2.5 text-[12.5px] text-[#78350f] leading-snug">
                <span className="text-gold-2 grid place-items-center shrink-0">
                  <IcAlert size={16} />
                </span>
                <span>
                  <b className="text-ink font-semibold">Stock changed since scheduling.</b>{' '}
                  {shortCount} of {totalCount} ingredients are now out — order stock or start with
                  what&apos;s on hand.
                </span>
              </div>
            )}

            {/* BODY */}
            <div className="flex-1 overflow-auto px-[22px] py-5">
              {/* Status */}
              <div className="mb-[22px]">
                <SecLabel>Status</SecLabel>
                <div className="bg-paper border border-line rounded-xl px-4 py-[15px] flex items-center justify-between gap-3">
                  <StatusPill stateKey={stateKey} label={PREP_STATE_META[status].label} />
                  {stateKey !== 'in-progress' && (
                    <div className="font-mono text-[11px] text-ink-3 flex items-center gap-1.5">
                      <IcClock size={13} />
                      ~{item.estimatedPrepTime ?? '—'} min
                      {countdown && <> · start by {countdown.startByHHMM}</>}
                    </div>
                  )}
                </div>
              </div>

              {/* Recipe & method — embedded cook-along (upscale · ingredients · method) */}
              {item.linkedRecipeId && (
                <div className="mb-[22px]">
                  <SecLabel>Recipe &amp; method</SecLabel>
                  <PrepRecipeSection
                    recipe={recipe}
                    ingredients={detail?.ingredients ?? []}
                    loading={recipeLoading}
                    unit={item.unit}
                    makeQty={makeQty}
                    onMakeQtyChange={onMakeQtyChange}
                    onOpenSubRecipe={onOpenSubRecipe}
                  />
                </div>
              )}

              {/* Stock context */}
              <div className="mb-[22px]">
                <SecLabel>Stock context</SecLabel>
                <div className="grid grid-cols-3 gap-2.5">
                  <Tile
                    label="On hand"
                    value={fmt(Number(item.onHand))}
                    unit={item.unit}
                    danger={Number(item.onHand) <= 0}
                  />
                  <Tile label="Par level" value={fmt(Number(item.parLevel))} unit={item.unit} />
                  <Tile label="Make" value={fmt(item.suggestedQty)} unit={item.unit} dark />
                </div>
              </div>
            </div>

            {/* FOOTER */}
            <div className="bg-paper border-t border-line px-[22px] py-3.5 flex flex-col gap-2.5" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 14px)' }}>
              {/* No-recipe items have no upscale slider — expose a plain qty input so the
                  yield credited by "Done" is still editable. Recipe items use the slider. */}
              {!item.linkedRecipeId && stateKey !== 'done' && stateKey !== 'skipped' && (
                <div className="flex flex-col gap-[7px]">
                  <label className="font-mono text-[10px] uppercase text-ink-3">Make ({item.unit})</label>
                  <input
                    type="number"
                    inputMode="decimal"
                    value={makeQty || ''}
                    onChange={(e) => onMakeQtyChange(parseFloat(e.target.value) || 0)}
                    placeholder={`e.g. ${fmt(item.suggestedQty)}`}
                    className="w-full border border-line-2 rounded-[9px] px-3 py-2.5 text-sm font-mono outline-none focus:border-ink-3"
                  />
                </div>
              )}

              {stateKey === 'not-started' && (
                <>
                  <button
                    type="button"
                    onClick={() => onStatusChange(item, 'IN_PROGRESS')}
                    className="h-[46px] rounded-[10px] text-sm font-semibold inline-flex items-center justify-center gap-2 bg-ink text-paper"
                  >
                    <IcPlay size={16} className="text-gold" />
                    {item.isBlocked ? 'Start anyway' : 'Start'}
                  </button>
                  <button
                    type="button"
                    onClick={complete}
                    className="h-[46px] rounded-[10px] text-sm font-semibold inline-flex items-center justify-center gap-2 bg-green text-white"
                  >
                    <IcCheck size={16} />
                    {doneLabel}
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemove(item)}
                    className="h-[46px] rounded-[10px] text-sm font-semibold inline-flex items-center justify-center gap-2 text-ink-3"
                  >
                    Remove from list
                  </button>
                </>
              )}

              {stateKey === 'in-progress' && (
                <>
                  <button
                    type="button"
                    onClick={complete}
                    className="h-[46px] rounded-[10px] text-sm font-semibold inline-flex items-center justify-center gap-2 bg-green text-white"
                  >
                    <IcCheck size={16} />
                    {doneLabel}
                  </button>
                  {/* Stop = abandon the in-progress prep without logging any qty (back to the
                      to-do list, still on it). Remove = take it off today's list → Smart Prep. */}
                  <div className="flex gap-2.5">
                    <button
                      type="button"
                      onClick={() => onStatusChange(item, 'NOT_STARTED')}
                      className="flex-1 h-[46px] rounded-[10px] text-sm font-semibold inline-flex items-center justify-center gap-2 bg-paper border border-line text-ink-2"
                    >
                      <IcUndo size={16} />
                      Stop
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemove(item)}
                      className="flex-1 h-[46px] rounded-[10px] text-sm font-semibold inline-flex items-center justify-center gap-2 text-ink-3"
                    >
                      Remove from list
                    </button>
                  </div>
                </>
              )}

              {stateKey === 'done' && (
                <button
                  type="button"
                  onClick={() => onStatusChange(item, 'NOT_STARTED')}
                  className="h-[46px] rounded-[10px] text-sm font-semibold inline-flex items-center justify-center gap-2 bg-paper border border-line text-ink-2"
                >
                  <IcUndo size={16} />
                  Reopen task
                </button>
              )}

              {stateKey === 'skipped' && (
                <button
                  type="button"
                  onClick={() => onStatusChange(item, 'NOT_STARTED')}
                  className="h-[46px] rounded-[10px] text-sm font-semibold inline-flex items-center justify-center gap-2 bg-paper border border-line text-ink-2"
                >
                  <IcUndo size={16} />
                  Restore to list
                </button>
              )}
            </div>
          </>
        )}
      </aside>
    </>
  )
}
