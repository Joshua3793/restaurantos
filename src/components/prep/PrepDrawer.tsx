'use client'

import { useEffect, useState } from 'react'
import {
  IcX,
  IcCheck,
  IcPlay,
  IcUndo,
  IcAlert,
  IcClock,
  IcChevron,
  IcSync,
} from '@/components/prep/icons'
import { PrepItemRich, PrepItemDetail, PrepStatus } from '@/components/prep/types'
import { PREP_STATE_META, formatShortAge, PrepCountdown } from '@/lib/prep-utils'

interface PrepDrawerProps {
  item: PrepItemRich | null
  detail: PrepItemDetail | null
  countdown: PrepCountdown | null
  recipeCost: number | null
  onClose: () => void
  onStatusChange: (item: PrepItemRich, status: PrepStatus, actualQty?: number) => void
  onOpenRecipe: (item: PrepItemRich) => void
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
      <span className="font-mono text-[10px] uppercase tracking-[0.03em] text-zinc-400">{label}</span>
      <span className="font-mono text-[13px] font-semibold text-white">{value}</span>
    </div>
  )
}

function Divider() {
  return <span className="w-px h-3.5 bg-zinc-800" aria-hidden="true" />
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
      <div className={`font-mono text-[9.5px] uppercase tracking-[0.04em] ${dark ? 'text-zinc-400' : 'text-ink-3'}`}>
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
  recipeCost,
  onClose,
  onStatusChange,
  onOpenRecipe,
}: PrepDrawerProps) {
  const [showPartial, setShowPartial] = useState(false)
  const [partialValue, setPartialValue] = useState('')

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

  // Reset the partial-qty input whenever the drawer's item changes / closes.
  useEffect(() => {
    setShowPartial(false)
    setPartialValue('')
  }, [item?.id])

  const status: PrepStatus = item?.todayLog?.status ?? 'NOT_STARTED'
  const stateKey = PREP_STATE_META[status].key as StateKey

  const shortCount = detail?.ingredientShortCount ?? item?.ingredientShortCount ?? 0
  const totalCount =
    detail?.ingredientTotalCount ??
    detail?.ingredients.length ??
    item?.ingredientTotalCount ??
    0

  const logPartial = () => {
    if (!item) return
    const v = parseFloat(partialValue)
    if (!v || v <= 0) return
    if (v >= item.suggestedQty) onStatusChange(item, 'DONE', v)
    else onStatusChange(item, 'PARTIAL', v)
    setShowPartial(false)
  }

  return (
    <>
      {/* SCRIM */}
      <div
        onClick={onClose}
        className={`fixed inset-0 z-40 bg-[rgba(9,9,11,0.36)] backdrop-blur-[2px] transition-opacity ${
          open ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        aria-hidden="true"
      />

      {/* PANEL */}
      <aside
        role="dialog"
        aria-label="Prep item detail"
        aria-hidden={!open}
        className={`fixed top-0 right-0 bottom-0 z-50 w-full max-w-[580px] bg-bg border-l border-line-2 shadow-2xl flex flex-col overflow-hidden transition-transform duration-300 ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {item && (
          <>
            {/* HEAD */}
            <div className="px-[22px] py-[18px] bg-paper border-b border-line flex items-start gap-3.5">
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
              {recipeCost != null && (
                <>
                  <Divider />
                  <StatItem label="Product value" value={`$${recipeCost.toFixed(2)}`} />
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
                  what's on hand.
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

              {/* Recipe & method */}
              {item.linkedRecipeId && (
                <div className="mb-[22px]">
                  <SecLabel>Recipe &amp; method</SecLabel>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpenRecipe(item)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onOpenRecipe(item)
                      }
                    }}
                    className="flex items-center gap-3 bg-paper border border-line rounded-xl px-4 py-[13px] cursor-pointer hover:border-ink-3"
                  >
                    <span className="w-[34px] h-[34px] rounded-[9px] bg-ink text-gold grid place-items-center shrink-0">
                      <IcSync size={16} />
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13.5px] font-semibold tracking-[-0.01em] truncate">
                        {item.linkedRecipe?.name ?? item.name}
                      </div>
                      <div className="font-mono text-[11px] text-ink-3 mt-[3px]">
                        Base yield {item.linkedRecipe?.baseYieldQty ?? '—'}{' '}
                        {item.linkedRecipe?.yieldUnit ?? ''} · tap to cook along
                      </div>
                    </div>
                    <span className="text-[12.5px] font-semibold text-gold-2 inline-flex items-center gap-[5px] shrink-0">
                      Open recipe
                      <IcChevron size={14} />
                    </span>
                  </div>
                </div>
              )}

              {/* Ingredients */}
              <div className="mb-[22px]">
                <SecLabel right={`${shortCount} short`}>Ingredients</SecLabel>
                {detail == null ? (
                  <div className="font-mono text-[11px] text-ink-3">Loading ingredients…</div>
                ) : (
                  <>
                    <div className="bg-[#fff7ed] border border-[#fed7aa] rounded-[10px] px-3.5 py-2.5 flex items-center gap-3">
                      <div className="flex gap-[3px] flex-wrap max-w-[104px]">
                        {detail.ingredients.map((ing) => (
                          <span
                            key={ing.id}
                            className={`w-2 h-2 rounded-[2px] ${ing.isAvailable ? 'bg-green' : 'bg-red'}`}
                          />
                        ))}
                      </div>
                      <div className="text-[12px] text-[#9a3412] leading-[1.35]">
                        <b className="font-semibold text-ink">
                          {shortCount} of {totalCount} ingredients out of stock.
                        </b>
                      </div>
                    </div>

                    <div className="bg-paper border border-line rounded-xl px-3.5 py-2 mt-3">
                      {detail.ingredients.map((ing) => (
                        <div
                          key={ing.id}
                          className="flex items-center gap-2.5 py-2 text-[13px] border-b border-bg-2 last:border-0"
                        >
                          <span
                            className={`w-[18px] h-[18px] rounded-[5px] grid place-items-center shrink-0 ${
                              ing.isAvailable
                                ? 'bg-green-soft text-green-text'
                                : 'bg-red-soft text-red-text'
                            }`}
                          >
                            {ing.isAvailable ? <IcCheck size={12} /> : <IcX size={12} />}
                          </span>
                          <span className="flex-1 text-ink-2 font-medium min-w-0 truncate">
                            {ing.itemName}
                          </span>
                          {!ing.isAvailable && (
                            <span className="font-mono text-[9.5px] text-red-text bg-red-soft px-1.5 rounded">
                              out
                            </span>
                          )}
                          <span className="font-mono text-[12.5px] font-semibold shrink-0">
                            {fmt(Number(ing.qtyBase))}
                            <span className="text-ink-3 font-normal text-[10.5px] ml-0.5">
                              {ing.unit}
                            </span>
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>

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
            <div className="bg-paper border-t border-line px-[22px] py-3.5 flex flex-col gap-2.5">
              {showPartial && (
                <div className="flex flex-col gap-[7px]">
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
                      className="bg-green text-white px-4 rounded-[9px] text-[13px] font-semibold"
                    >
                      Log
                    </button>
                  </div>
                </div>
              )}

              {(stateKey === 'not-started') && (
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
                    onClick={() => setShowPartial(true)}
                    className="h-[46px] rounded-[10px] text-sm font-semibold inline-flex items-center justify-center gap-2 bg-paper border border-line text-ink-2"
                  >
                    Log partial
                  </button>
                  <button
                    type="button"
                    onClick={() => onStatusChange(item, 'SKIPPED')}
                    className="h-[46px] rounded-[10px] text-sm font-semibold inline-flex items-center justify-center gap-2 text-ink-3"
                  >
                    Skip today
                  </button>
                </>
              )}

              {stateKey === 'in-progress' && (
                <>
                  <button
                    type="button"
                    onClick={() => onStatusChange(item, 'DONE', item.suggestedQty)}
                    className="h-[46px] rounded-[10px] text-sm font-semibold inline-flex items-center justify-center gap-2 bg-green text-white"
                  >
                    <IcCheck size={16} />
                    Mark done
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowPartial(true)}
                    className="h-[46px] rounded-[10px] text-sm font-semibold inline-flex items-center justify-center gap-2 bg-paper border border-line text-ink-2"
                  >
                    Log partial
                  </button>
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
