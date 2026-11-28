'use client'

import { useEffect, useRef, useState } from 'react'
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
import { whyLabel, effectiveUrgency, ANY_STATION } from '@/lib/prep-plan'
import { resolveStages, currentStage, stageLabel } from '@/lib/prep-stages'
import PrepRecipeSection from '@/components/prep/PrepRecipeSection'
import { ChefNote } from '@/components/prep/runsheet/atoms'
import type { PrepProgress } from '@/lib/prep-progress'
import { CookModeBlock, CookFooter, cookState } from '@/components/prep/CookMode'
import { JobMenu } from '@/components/prep/runsheet/step-ui'
import { useNowMinute } from '@/components/prep/runsheet/useNowMinute'
import { useBackDismiss } from '@/lib/back-stack'

interface PrepDrawerProps {
  item: PrepItemRich | null
  detail: PrepItemDetail | null
  countdown: PrepCountdown | null
  /** Linked recipe (steps + cost) for the embedded cook-along; null when the item has none. */
  recipe: RecipeStepsData | null
  recipeLoading: boolean
  /** The cook-along upscale slider's yield — the Log yield sheet's prefill, never a credit. */
  makeQty: number
  onMakeQtyChange: (qty: number) => void
  onClose: () => void
  onStatusChange: (item: PrepItemRich, status: PrepStatus, actualQty?: number) => void
  /** Open the Log yield sheet for this item — the only way a yield is recorded. */
  onLogYield: (item: PrepItemRich) => void
  /** Open a sub-recipe ingredient's recipe (e.g. tap "Custard" inside French Toast). */
  onOpenSubRecipe: (recipeId: string, name: string) => void
  /**
   * Take the item off the list this drawer was opened from. The drawer does not decide
   * what that means — the host passes the handler matching its own context (To Do →
   * clear the posted stamp; Smart Prep draft → isOnList=false). Omit it when the viewer
   * may not change the list (below LEAD, read-only, or no RC picked) and the action hides.
   */
  onRemove?: (item: PrepItemRich) => void
  /** Move a job on the go ONE method step (cook mode's Back / Next). */
  onStep?: (item: PrepItemRich, stepKey: string) => void
  /** Saved cook-along state for the item's live log (kept while it is on the To Do). */
  progress?: PrepProgress | null
  onProgressChange?: (patch: { ingredients?: string[]; steps?: string[] }) => void
  /** The chef's switch (Smart Prep context only): off keeps the item out of prep while the recipe stays. Omit to hide it. */
  onSetPrepEnabled?: (item: PrepItemRich, enabled: boolean) => void
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

// ── Phone helpers (module scope) ───────────────────────────────────

const isPhone = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches

// "Ingredients, batch & stock" during a job: open by default on a phone, and the
// cook's last choice is remembered on the device. Desktop keeps today's fold.
const SHOW_MORE_KEY = 'prep.drawer.showIngredients'
function readShowMore(): boolean {
  if (!isPhone()) return false
  try {
    const v = window.localStorage.getItem(SHOW_MORE_KEY)
    return v == null ? true : v === '1'
  } catch {
    return true
  }
}
function writeShowMore(v: boolean) {
  if (!isPhone()) return
  try { window.localStorage.setItem(SHOW_MORE_KEY, v ? '1' : '0') } catch { /* private mode */ }
}

// Swipe down on the drawer's header to close it (phones only). The header
// holds no scrolled list, so a downward drag there is never a scroll.
// A release past the threshold carries on DOWN off the screen (never snaps
// back up first); once it is off, the panel is parked at its normal closed
// spot without a transition, so the next open slides in as usual.
const CLOSE_DRAG_PX = 90
const SLIDE_MS = 300
type SwipePhase = 'idle' | 'drag' | 'closing' | 'parked'
function useSwipeDownToClose(open: boolean, onClose: () => void) {
  const start = useRef<{ x: number; y: number } | null>(null)
  const dragging = useRef(false)
  const [dy, setDy] = useState(0)
  const [phase, setPhase] = useState<SwipePhase>('idle')
  const reset = () => { start.current = null; dragging.current = false; setDy(0); setPhase('idle') }
  // Off the screen -> park (no transition). Reopened -> back to normal.
  useEffect(() => {
    if (phase !== 'closing') return
    const t = setTimeout(() => setPhase('parked'), SLIDE_MS + 20)
    return () => clearTimeout(t)
  }, [phase])
  useEffect(() => {
    if (open && phase === 'parked') { setDy(0); setPhase('idle') }
  }, [open, phase])
  const handlers = {
    onTouchStart: (e: React.TouchEvent) => {
      if (!isPhone() || e.touches.length !== 1) return
      // React bubbles touches out of portals (the ⋯ sheet): only real header touches count.
      const t = e.target as HTMLElement
      if (!e.currentTarget.contains(t)) return
      // Never hijack a drag that starts inside something already scrolled.
      for (let n: HTMLElement | null = t; n && n !== e.currentTarget; n = n.parentElement) {
        if (n.scrollTop > 0) return
      }
      start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
      dragging.current = false
    },
    onTouchMove: (e: React.TouchEvent) => {
      const s = start.current
      if (!s) return
      const ddy = e.touches[0].clientY - s.y
      const ddx = e.touches[0].clientX - s.x
      // Decide once: a mostly-downward move past 8px is a drag; anything else lets go.
      if (!dragging.current) {
        if (Math.abs(ddy) < 8 && Math.abs(ddx) < 8) return
        if (ddy <= 0 || Math.abs(ddx) > Math.abs(ddy)) { start.current = null; return }
        dragging.current = true
        setPhase('drag')
      }
      setDy(Math.max(0, ddy))
    },
    onTouchEnd: () => {
      if (dragging.current && dy > CLOSE_DRAG_PX) {
        start.current = null
        dragging.current = false
        setPhase('closing')   // keep the offset; the style animates on down from it
        onClose()
      } else {
        reset()
      }
    },
    onTouchCancel: () => reset(),
  }
  const style: React.CSSProperties | undefined =
    phase === 'drag' && dy > 0 ? { transform: `translateY(${dy}px)`, transition: 'none' }
    : phase === 'closing' ? { transform: 'translateY(100%)', transition: `transform ${SLIDE_MS}ms ease-out` }
    // Only while still closed: the render that reopens it must slide in normally.
    : phase === 'parked' && !open ? { transition: 'none' }
    : undefined
  return { style, handlers }
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
  onLogYield,
  onOpenSubRecipe,
  onRemove,
  onStep,
  progress,
  onProgressChange,
  onSetPrepEnabled,
}: PrepDrawerProps) {
  const open = item !== null
  useBackDismiss(open, onClose)

  // Escape closes the drawer.
  useEffect(() => {
    if (!open) return
    function handle(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handle)
    return () => document.removeEventListener('keydown', handle)
  }, [open, onClose])

  // Cook mode: a job on the go with a method opens on its current step, with
  // Back / Next in the footer; everything else folds away under "show".
  const { nowMs } = useNowMinute()
  const liveNow = Math.max(nowMs, Date.now())
  const cook = onStep ? cookState(item, liveNow) : null
  const [showMore, setShowMore] = useState(false)
  useEffect(() => { setShowMore(readShowMore()) }, [item?.id])
  const toggleShowMore = () => setShowMore(m => { writeShowMore(!m); return !m })
  const swipe = useSwipeDownToClose(open, onClose)

  const status: PrepStatus = item?.todayLog?.status ?? 'NOT_STARTED'
  const stateKey = PREP_STATE_META[status].key as StateKey
  // Urgency step for the "why it's on the list" tint. Hooks/derivations run on
  // every render, so it has to tolerate the closed (item === null) state.
  const urgency = item ? effectiveUrgency(item) : null
  // Staged prep: the chain and where the live log is in it (null = unstaged).
  const stages = item ? resolveStages(item.linkedRecipe) : null
  const stageAt = stages && item?.todayLog?.status === 'IN_PROGRESS' ? currentStage(stages, item.todayLog) : null

  const shortCount = detail?.ingredientShortCount ?? item?.ingredientShortCount ?? 0
  const totalCount =
    detail?.ingredientTotalCount ??
    detail?.ingredients.length ??
    item?.ingredientTotalCount ??
    0

  return (
    <>
      {/* SCRIM */}
      <div
        onClick={onClose}
        // Plain dim overlay — NO backdrop-blur. A full-viewport `backdrop-filter: blur()`
        // re-blurs the entire animating prep page every frame and stacks over the nav's
        // own backdrop-filter, which froze the app on weaker laptops (see LogYieldSheet).
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
        // Follows the thumb while the header is dragged down, and slides on
        // down when let go past the line (phones only).
        style={swipe.style}
      >
        {item && (
          <>
            {/* HEAD */}
            <div
              {...swipe.handlers}
              className="relative px-[22px] py-[18px] bg-paper border-b border-line flex items-start gap-3.5 max-md:touch-none"
              style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 18px)' }}
            >
              {/* grab handle — says "pull me down" on a phone */}
              <span aria-hidden="true" className="md:hidden absolute left-1/2 -translate-x-1/2 w-10 h-1 rounded-full bg-line-2" style={{ top: 'calc(env(safe-area-inset-top, 0px) + 6px)' }} />
              <button
                type="button"
                aria-label="Close"
                onClick={onClose}
                className="w-11 h-11 md:w-8 md:h-8 rounded-lg border border-line grid place-items-center text-ink-2 hover:border-ink-3 shrink-0"
              >
                <IcX size={15} />
              </button>
              <div className="flex-1 min-w-0">
                {(item.priority === '911' || item.isBlocked || stageAt) && (
                  <div className="flex items-center gap-[7px] mb-2 flex-wrap">
                    {stageAt && stages && (
                      <Pill className={stageAt.stage.kind === 'PASSIVE' ? 'bg-blue-soft text-blue-text' : 'bg-ink text-gold'}>
                        {stageLabel(stageAt.index, stages.length, stageAt.stage)}
                      </Pill>
                    )}
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
                  {item.category} · {item.station ?? ANY_STATION} · carries over daily
                </div>
                <ChefNote note={item.todayLog?.note} className="mt-3" />
              </div>
              {cook && (
                <JobMenu
                  size={44}
                  entries={[
                    { label: 'Log yield now', sub: 'finish early — record what you made', onClick: () => onLogYield(item) },
                    { label: 'Stop for now', sub: 'keeps the step — Start carries on from here', onClick: () => onStatusChange(item, 'NOT_STARTED') },
                    ...(onRemove ? [{ label: 'Remove from the list', danger: true, onClick: () => onRemove(item) }] : []),
                  ]}
                />
              )}
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
              {cook && (
                <div className="mb-[22px]">
                  <CookModeBlock state={cook} nowMs={liveNow} />
                  <button
                    type="button"
                    onClick={toggleShowMore}
                    aria-expanded={showMore}
                    className="mt-4 w-full flex justify-between items-center bg-paper border border-line rounded-[12px] px-4 py-3 max-md:min-h-[48px] cursor-pointer"
                  >
                    <span className="text-[13.5px] max-md:text-[15px] font-semibold">Ingredients, batch &amp; stock</span>
                    <span className="font-mono text-[10.5px] max-md:text-[12px] text-ink-3">{showMore ? 'HIDE' : 'SHOW'}</span>
                  </button>
                </div>
              )}
              {(!cook || showMore) && (<>
              {/* Status */}
              {!cook && (
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
              )}

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
                    log={item.todayLog ?? null}
                    progress={progress}
                    onProgressChange={onProgressChange}
                  />
                </div>
              )}

              {/* Prepped on the line — the chef's switch (Smart Prep only). Off keeps
                  the item out of prep while the recipe stays; locked while the item
                  is on the draft or the To Do. */}
              {onSetPrepEnabled && (() => {
                const enabled = item.prepEnabled !== false
                const onList = item.isOnList || !!item.todayLog?.postedAt
                const lockedSwitch = enabled && onList
                return (
                  <div className="mb-[22px]">
                    <SecLabel>Prepped on the line</SecLabel>
                    <div className="flex items-start gap-3 rounded-[11px] border border-line bg-paper px-3.5 py-3">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={enabled}
                        aria-label={enabled ? 'Prepped on the line' : 'Not prepped'}
                        disabled={lockedSwitch}
                        onClick={() => onSetPrepEnabled(item, !enabled)}
                        className={`relative shrink-0 mt-0.5 w-[38px] h-[22px] rounded-full border transition-colors ${enabled ? 'bg-green border-green' : 'bg-bg-2 border-line-2'} ${lockedSwitch ? 'opacity-40' : ''}`}
                      >
                        <span className={`absolute top-[2px] w-[16px] h-[16px] rounded-full bg-white transition-all ${enabled ? 'left-[18px]' : 'left-[2px]'}`} />
                      </button>
                      <span className="text-[13px] text-ink-2 leading-snug">
                        {enabled
                          ? 'On the prep list. Switch off to keep this recipe out of prep — it stays in the Recipe Book.'
                          : 'Not prepped. Switch on to see it in Smart Prep again.'}
                        {lockedSwitch && <span className="block font-mono text-[11px] text-ink-4 mt-1">Take it off the list first.</span>}
                      </span>
                    </div>
                  </div>
                )
              })()}

              {/* Stock context */}
              <div className="mb-[22px]">
                <SecLabel>Stock context</SecLabel>
                {/* Why it's on the list — the run-sheet rows used to carry this
                    sentence beside the item name, where it truncated the name on
                    iPad/narrow desktop. It reads here instead, with room to wrap. */}
                <div
                  className={`rounded-[11px] border px-3.5 py-3 mb-2.5 ${
                    urgency === 'PASS'
                      ? 'bg-red-soft border-red-soft text-red-text'
                      : urgency === 'MID'
                        ? 'bg-gold-soft border-[#fcd34d] text-gold-2'
                        : 'bg-paper border-line text-ink-2'
                  }`}
                >
                  <div className="font-mono text-[9.5px] uppercase tracking-[0.04em] opacity-70">
                    Why it&apos;s on the list
                  </div>
                  <div className="text-[13px] font-medium mt-1 leading-snug first-letter:uppercase">
                    {whyLabel(item)}
                  </div>
                  {item.blockedReason && (
                    <div className="flex items-start gap-1.5 font-mono text-[11px] mt-2 leading-snug">
                      <span className="shrink-0 mt-px"><IcAlert size={12} /></span>
                      <span>{item.blockedReason}</span>
                    </div>
                  )}
                </div>
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
              </>)}

              {/* Phones: a plain way back at the end of the read, so a cook never has
                  to reach for the corner ×. Not in the footer — that holds the job's
                  own buttons. */}
              <button
                type="button"
                onClick={onClose}
                className="md:hidden mt-1 w-full h-12 rounded-[11px] border border-line bg-paper text-[15px] font-semibold text-ink-2 inline-flex items-center justify-center gap-2 active:bg-bg-2"
              >
                <span aria-hidden="true">←</span> Back to list
              </button>
            </div>

            {/* FOOTER */}
            <div className="bg-paper border-t border-line px-[22px] py-3.5 flex flex-col gap-2.5" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 14px)' }}>
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
                    onClick={() => onLogYield(item)}
                    className="h-[46px] rounded-[10px] text-sm font-semibold inline-flex items-center justify-center gap-2 bg-green text-white"
                  >
                    <IcCheck size={16} />
                    Log yield
                  </button>
                  {onRemove && (
                    <button
                      type="button"
                      onClick={() => onRemove(item)}
                      className="h-[46px] rounded-[10px] text-sm font-semibold inline-flex items-center justify-center gap-2 text-ink-3"
                    >
                      Remove from list
                    </button>
                  )}
                </>
              )}

              {cook && onStep && (
                <CookFooter item={item} state={cook} onStep={onStep} onLogYield={onLogYield} />
              )}

              {stateKey === 'in-progress' && !cook && (
                <>
                  <button
                    type="button"
                    onClick={() => onLogYield(item)}
                    className="h-[46px] rounded-[10px] text-sm font-semibold inline-flex items-center justify-center gap-2 bg-green text-white"
                  >
                    <IcCheck size={16} />
                    Log yield
                  </button>
                  {/* Stop = abandon the in-progress prep without logging any qty (back to the
                      to-do list, still on it). Remove = take it off whichever list this drawer
                      was opened from; the host supplies the meaning (see `onRemove`). */}
                  <div className="flex gap-2.5">
                    <button
                      type="button"
                      onClick={() => onStatusChange(item, 'NOT_STARTED')}
                      className="flex-1 h-[46px] rounded-[10px] text-sm font-semibold inline-flex items-center justify-center gap-2 bg-paper border border-line text-ink-2"
                    >
                      <IcUndo size={16} />
                      Stop
                    </button>
                    {onRemove && (
                      <button
                        type="button"
                        onClick={() => onRemove(item)}
                        className="flex-1 h-[46px] rounded-[10px] text-sm font-semibold inline-flex items-center justify-center gap-2 text-ink-3"
                      >
                        Remove from list
                      </button>
                    )}
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
