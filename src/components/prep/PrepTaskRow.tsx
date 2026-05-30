'use client'

import { forwardRef, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  IcAlert,
  IcCheck,
  IcPlay,
  IcMore,
  IcHalf,
  IcUndo,
  IcSkip,
  IcBlock,
  IcClock,
  IcChevron,
  IcCart,
  IcSync,
} from '@/components/prep/icons'
import { PrepItemRich, PrepStatus } from '@/components/prep/types'
import { PREP_STATE_META, formatShortAge } from '@/lib/prep-utils'

interface PrepTaskRowProps {
  item: PrepItemRich
  kind?: 'critical' | 'needed' | 'later'
  onOpen: (item: PrepItemRich) => void
  onOpenRecipe: (item: PrepItemRich) => void
  onStatusChange: (item: PrepItemRich, status: PrepStatus, actualQty?: number) => void
  onOrderStock?: (item: PrepItemRich) => void
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

function Medallion({
  state,
  needed,
  onClick,
}: {
  state: StateKey
  needed: boolean
  onClick: (e: React.MouseEvent) => void
}) {
  let cls = 'bg-red-soft text-red'
  let glyph: React.ReactNode = <IcAlert size={21} />
  if (state === 'not-started') {
    if (needed) {
      cls = 'bg-gold-soft text-gold-2'
      glyph = <IcClock size={21} />
    } else {
      cls = 'bg-red-soft text-red'
      glyph = <IcAlert size={21} />
    }
  } else if (state === 'in-progress') {
    cls = 'bg-blue-soft text-blue'
    glyph = <Loader2 size={21} className="animate-spin" />
  } else if (state === 'done') {
    cls = 'bg-green text-white shadow-[0_4px_12px_-4px_rgba(22,163,74,0.5)]'
    glyph = <IcCheck size={22} />
  } else if (state === 'skipped') {
    cls = 'bg-bg text-ink-4 border border-line-2'
    glyph = <IcSkip size={20} />
  }
  return (
    <button
      type="button"
      title="Click to toggle done"
      onClick={onClick}
      className={`w-12 h-12 rounded-[13px] grid place-items-center shrink-0 cursor-pointer transition-transform hover:scale-105 active:scale-95 ${cls}`}
    >
      {glyph}
    </button>
  )
}

// ── Main component ─────────────────────────────────────────────────

export default function PrepTaskRow({
  item,
  kind,
  onOpen,
  onOpenRecipe,
  onStatusChange,
  onOrderStock,
}: PrepTaskRowProps) {
  const status: PrepStatus = item.todayLog?.status ?? 'NOT_STARTED'
  const state = PREP_STATE_META[status].key as StateKey
  const needed = kind === 'needed'

  const [menuOpen, setMenuOpen] = useState(false)
  const [showPartial, setShowPartial] = useState(false)
  const [partialValue, setPartialValue] = useState('')

  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    function handle(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('click', handle)
    return () => document.removeEventListener('click', handle)
  }, [menuOpen])

  // ── derived wash + stripe per state ──
  let washCls = 'bg-gradient-to-r from-[#fff8f7] to-paper'
  let borderCls = 'border-line'
  let stripeCls = 'bg-red'
  if (state === 'not-started') {
    if (needed) {
      washCls = 'bg-gradient-to-r from-[#fffdf4] to-paper'
      stripeCls = 'bg-gold'
    } else {
      washCls = 'bg-gradient-to-r from-[#fff8f7] to-paper'
      stripeCls = 'bg-red'
    }
  } else if (state === 'in-progress') {
    washCls = 'bg-gradient-to-r from-[#f3f7ff] to-paper'
    borderCls = 'border-[#bfdbfe]'
    stripeCls = 'bg-blue'
  } else if (state === 'done') {
    washCls = 'bg-gradient-to-r from-[#f2faf4] to-paper'
    borderCls = 'border-[#bbf7d0]'
    stripeCls = 'bg-green'
  } else if (state === 'skipped') {
    washCls = 'bg-bg-2'
    borderCls = 'border-line'
    stripeCls = 'bg-ink-4'
  }

  // ── handlers ──
  const handleMedallion = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (state === 'done' || state === 'skipped') {
      onStatusChange(item, 'NOT_STARTED')
    } else {
      onStatusChange(item, 'DONE', item.suggestedQty)
    }
  }

  const handleRowKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onOpen(item)
    }
  }

  const stop = (e: React.MouseEvent) => e.stopPropagation()

  const openPartial = () => {
    if (state !== 'in-progress') onStatusChange(item, 'IN_PROGRESS')
    setShowPartial(true)
  }

  const logPartial = () => {
    const v = parseFloat(partialValue)
    if (!v || v <= 0) return
    if (v >= item.suggestedQty) onStatusChange(item, 'DONE', v)
    else onStatusChange(item, 'PARTIAL', v)
    setShowPartial(false)
  }

  // ── note line content ──
  const doneQty = item.todayLog?.actualPrepQty ?? item.suggestedQty
  let note: React.ReactNode = null
  if (state === 'in-progress') {
    note = (
      <>
        <b className="text-ink font-semibold">In progress</b> · prepping
      </>
    )
  } else if (state === 'done') {
    note = (
      <>
        <b className="text-ink font-semibold">Done</b> · {formatShortAge(item.lastMadeAt)} ·{' '}
        {fmt(Number(doneQty))} {item.unit} made
      </>
    )
  } else if (state === 'skipped') {
    note = <>Skipped for today · still on the list</>
  } else if (item.ingredientShortCount && item.ingredientTotalCount) {
    note = (
      <>
        <b className="text-ink font-semibold">
          {item.ingredientShortCount} of {item.ingredientTotalCount} ingredients out of stock
        </b>
      </>
    )
  }

  // ── make bar fill ──
  const onHand = Number(item.onHand) || 0
  const parLevel = Number(item.parLevel) || 0
  const fillPct = parLevel > 0 ? Math.max(0, Math.min(100, (onHand / parLevel) * 100)) : 0
  const makeDim = state === 'done' || state === 'skipped'

  // ── status pill colors ──
  let pillCls = 'bg-bg-2 text-ink-3'
  let dotCls = 'bg-ink-3'
  if (state === 'in-progress') {
    pillCls = 'bg-blue-soft text-blue-text'
    dotCls = 'bg-blue animate-pulse'
  } else if (state === 'done') {
    pillCls = 'bg-green-soft text-green-text'
    dotCls = 'bg-green-text'
  } else if (state === 'skipped') {
    pillCls = 'bg-bg-2 text-ink-3'
    dotCls = 'bg-ink-3'
  }

  return (
    <div
      role="button"
      tabIndex={0}
      data-state={state}
      data-kind={kind}
      onClick={() => onOpen(item)}
      onKeyDown={handleRowKeyDown}
      className={`grid grid-cols-[auto_1fr_auto_auto] gap-5 items-center border rounded-[14px] px-[22px] py-5 relative cursor-pointer mb-3.5 transition-[box-shadow,border-color,background] hover:shadow-[0_10px_30px_-16px_rgba(0,0,0,0.26)] hover:border-line-2 focus-visible:outline-2 focus-visible:outline-ink ${washCls} ${borderCls}`}
    >
      {/* left accent stripe */}
      <span
        className={`absolute left-0 top-0 bottom-0 w-[5px] rounded-l-[14px] ${stripeCls}`}
        aria-hidden="true"
      />

      {/* col 1 — medallion */}
      <Medallion state={state} needed={needed} onClick={handleMedallion} />

      {/* col 2 — body */}
      <div className="min-w-0">
        <div className="flex items-center gap-[7px] mb-2.5 flex-wrap">
          {item.priority === '911' && (
            <Pill className="bg-red-soft text-red-text">
              <span className="w-1.5 h-1.5 rounded-full bg-red" />
              Critical
            </Pill>
          )}
          {item.isBlocked && (
            <Pill className="bg-gold-soft text-gold-2">Blocked · stock out</Pill>
          )}
          <Pill className="bg-bg-2 text-ink-2">{item.category}</Pill>
          {item.station && <Pill className="bg-bg-2 text-ink-2">{item.station}</Pill>}
        </div>

        <h3
          className={`text-[23px] font-semibold tracking-[-0.025em] leading-[1.1] m-0 ${
            state === 'skipped' ? 'line-through text-ink-3' : ''
          }`}
        >
          {item.name}
        </h3>

        {note && <div className="font-mono text-[11.5px] text-ink-3 mt-2">{note}</div>}

        {item.linkedRecipeId && (
          <button
            type="button"
            onClick={(e) => {
              stop(e)
              onOpenRecipe(item)
            }}
            className="inline-flex items-center gap-2 mt-3 px-3 py-[7px] rounded-[10px] border border-line bg-bg text-ink-2 text-[12.5px] font-medium hover:border-ink-3 hover:bg-paper"
          >
            <span className="w-6 h-6 rounded-[7px] bg-ink text-gold grid place-items-center shrink-0">
              <IcSync size={13} />
            </span>
            View recipe
            <span className="text-gold-2 grid place-items-center">
              <IcChevron size={13} />
            </span>
          </button>
        )}
      </div>

      {/* col 3 — make block */}
      <div className={`shrink-0 min-w-[150px] ${makeDim ? 'opacity-40' : ''}`}>
        <div className="font-mono text-[10px] uppercase tracking-[0.05em] text-ink-3">Make</div>
        <div className="text-[32px] font-semibold tracking-[-0.04em] leading-none mt-[5px]">
          {fmt(Number(item.suggestedQty))}
          <span className="text-[15px] text-ink-3 font-medium ml-0.5">{item.unit}</span>
        </div>
        <div className="mt-2.5 flex flex-col gap-1.5">
          <div className="h-1.5 rounded-full bg-bg-2 overflow-hidden">
            <div className="h-full rounded-full bg-red" style={{ width: `${fillPct}%` }} />
          </div>
          <div className="font-mono text-[10.5px] text-ink-3">
            <b className="text-ink font-semibold">{fmt(onHand)}</b> on hand · par {fmt(parLevel)}{' '}
            {item.unit}
          </div>
        </div>
      </div>

      {/* col 4 — end */}
      <div className="flex flex-col items-end gap-3 shrink-0 min-w-[150px]">
        <span
          className={`font-mono text-[10px] px-2.5 py-1 rounded-full font-semibold uppercase inline-flex items-center gap-1.5 ${pillCls}`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${dotCls}`} />
          {PREP_STATE_META[status].label}
        </span>

        {/* actions area — swallow clicks so they don't open the drawer */}
        <div className="w-full flex flex-col items-end gap-3" onClick={stop}>
          {/* action set by state */}
          <div className="flex items-center justify-end gap-2 w-full relative">
            {state === 'not-started' && (
              <>
                <button
                  type="button"
                  onClick={() => onStatusChange(item, 'IN_PROGRESS')}
                  className="h-[42px] px-4 rounded-[10px] text-[13px] font-semibold inline-flex items-center justify-center gap-2 bg-ink text-paper"
                >
                  <IcPlay size={15} className="text-gold" />
                  {item.isBlocked ? 'Start anyway' : 'Start'}
                </button>
                <MoreMenu
                  ref={menuRef}
                  open={menuOpen}
                  setOpen={setMenuOpen}
                  item={item}
                  onStatusChange={onStatusChange}
                  onOrderStock={onOrderStock}
                  openPartial={openPartial}
                />
              </>
            )}

            {state === 'in-progress' && (
              <>
                <button
                  type="button"
                  onClick={() =>
                    onStatusChange(item, 'DONE', parseFloat(partialValue) || item.suggestedQty)
                  }
                  className="h-[42px] px-4 rounded-[10px] text-[13px] font-semibold inline-flex items-center justify-center gap-2 bg-green text-white"
                >
                  <IcCheck size={15} />
                  Mark done
                </button>
                <MoreMenu
                  ref={menuRef}
                  open={menuOpen}
                  setOpen={setMenuOpen}
                  item={item}
                  onStatusChange={onStatusChange}
                  onOrderStock={onOrderStock}
                  openPartial={openPartial}
                />
              </>
            )}

            {state === 'done' && (
              <button
                type="button"
                onClick={() => onStatusChange(item, 'NOT_STARTED')}
                className="h-[42px] px-4 rounded-[10px] text-[13px] font-semibold inline-flex items-center justify-center gap-2 bg-paper border border-line text-ink-2"
              >
                <IcUndo size={15} />
                Reopen
              </button>
            )}

            {state === 'skipped' && (
              <button
                type="button"
                onClick={() => onStatusChange(item, 'NOT_STARTED')}
                className="h-[42px] px-4 rounded-[10px] text-[13px] font-semibold inline-flex items-center justify-center gap-2 bg-paper border border-line text-ink-2"
              >
                <IcUndo size={15} />
                Restore
              </button>
            )}
          </div>

          {/* partial input */}
          {showPartial && (
            <div className="flex flex-col gap-[7px] w-full">
              <label className="font-mono text-[10px] uppercase text-ink-3">
                Actual qty made ({item.unit})
              </label>
              <div className="flex gap-[7px]">
                <input
                  type="number"
                  value={partialValue}
                  onChange={(e) => setPartialValue(e.target.value)}
                  placeholder="e.g. 6.5"
                  className="flex-1 min-w-0 border border-line-2 rounded-[9px] px-3 py-2.5 text-sm font-mono outline-none focus:border-ink-3"
                />
                <button
                  type="button"
                  onClick={logPartial}
                  className="bg-green text-white px-4 rounded-[9px] h-auto text-[13px] font-semibold"
                >
                  Log
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── ⋯ menu (module scope, forwardRef so outside-click handler can read it) ──

interface MoreMenuProps {
  open: boolean
  setOpen: (v: boolean) => void
  item: PrepItemRich
  onStatusChange: (item: PrepItemRich, status: PrepStatus, actualQty?: number) => void
  onOrderStock?: (item: PrepItemRich) => void
  openPartial: () => void
}

const MoreMenu = forwardRef<HTMLDivElement, MoreMenuProps>(function MoreMenu(
  { open, setOpen, item, onStatusChange, onOrderStock, openPartial },
  ref,
) {
  const close = () => setOpen(false)
  return (
      <div className="relative" ref={ref}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setOpen(!open)
          }}
          className="w-[42px] h-[42px] rounded-[10px] border border-line text-ink-3 grid place-items-center hover:border-ink-3"
        >
          <IcMore size={18} />
        </button>
        {open && (
          <div className="absolute right-0 bottom-12 w-[188px] bg-paper border border-line-2 rounded-[11px] shadow-xl p-1.5 z-20">
            <button
              type="button"
              onClick={() => {
                openPartial()
                close()
              }}
              className="flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-[13px] text-ink-2 hover:bg-bg-2 text-left"
            >
              <span className="text-ink-3 grid place-items-center">
                <IcHalf size={15} />
              </span>
              Log partial qty
            </button>
            <button
              type="button"
              onClick={() => {
                onStatusChange(item, 'BLOCKED')
                close()
              }}
              className="flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-[13px] text-ink-2 hover:bg-bg-2 text-left"
            >
              <span className="text-ink-3 grid place-items-center">
                <IcBlock size={15} />
              </span>
              Mark blocked
            </button>
            {onOrderStock && (
              <button
                type="button"
                onClick={() => {
                  onOrderStock(item)
                  close()
                }}
                className="flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-[13px] text-ink-2 hover:bg-bg-2 text-left"
              >
                <span className="text-ink-3 grid place-items-center">
                  <IcCart size={15} />
                </span>
                Add to order
              </button>
            )}
            <div className="h-px bg-line my-[5px] mx-1.5" />
            <button
              type="button"
              onClick={() => {
                onStatusChange(item, 'SKIPPED')
                close()
              }}
              className="flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-[13px] text-red-text hover:bg-bg-2 text-left"
            >
              <span className="text-red grid place-items-center">
                <IcSkip size={15} />
              </span>
              Skip today
            </button>
          </div>
        )}
    </div>
  )
})
