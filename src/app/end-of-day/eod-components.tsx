'use client'
import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { TrendingUp, AlertTriangle, RotateCw, Check, RotateCcw, ClipboardList, Truck } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import { computeDayMetrics, type TempUnit } from '@/components/temps/temp-utils'
import { SafetyTempsSummary } from '@/components/preshift/SafetyTempsSummary'
import type { RevenueCenter } from '@/contexts/RevenueCenterContext'
import type { EodSummary, EodCloseState, EodCheckItemDTO } from './page'
import type { PrepItemRich } from '@/components/prep/types'

const card = 'bg-paper border border-line rounded-[12px] overflow-hidden'
const cardHead = 'flex items-center justify-between px-[18px] py-3 border-b border-line bg-bg-2'
const railCard = 'bg-paper border border-line rounded-[12px] p-[18px] mb-4'

// Placeholder metrics — no data source yet (labour/forecast). Rendered with an
// explicit "est" tag so they read as estimates, never live numbers. Wired in a later phase.
export const PH_TARGET_PCT = 27
export const PH_LABOUR_PCT = 31.4

// ── KPI row ──────────────────────────────────────────────────────────────────
export function EodKpiRow({ data, target, labourPct }: { data: EodSummary | null; target: number; labourPct: number }) {
  const fc = data?.foodCostPct ?? null
  const over = fc != null && fc > target
  return (
    <div className="grid gap-3 mb-6 grid-cols-2 lg:grid-cols-4">
      <Kpi label="NET SALES · TODAY" value={data ? formatCurrency(data.netSales) : '—'}
        sub={data ? `${data.covers} covers` : ''} hero />
      <Kpi label="FOOD COST · TODAY" value={fc != null ? `${fc.toFixed(1)}%` : '—'}
        sub={`target ${target.toFixed(1)}`} valueClass={over ? 'text-red-text' : ''} accent="bg-red" />
      <Kpi label="AVG SPEND" value={data?.avgSpend != null ? formatCurrency(data.avgSpend) : '—'}
        sub="per cover" />
      {/* PLACEHOLDER — no labour data source yet */}
      <Kpi label="LABOUR" value={`${labourPct.toFixed(1)}%`} sub="est · not yet wired" placeholder />
    </div>
  )
}

function Kpi({ label, value, sub, valueClass = '', accent, hero, placeholder }:
  { label: string; value: string; sub: string; valueClass?: string; accent?: string; hero?: boolean; placeholder?: boolean }) {
  return (
    <div className={`relative flex flex-col justify-between min-h-[110px] rounded-[12px] p-5 border ${hero ? 'bg-ink text-paper border-ink' : 'bg-paper border-line'} ${placeholder ? 'opacity-70' : ''}`}>
      {accent && <div className={`absolute top-0 left-0 w-8 h-0.5 ${accent}`} />}
      <div>
        <div className="font-mono text-[10.5px] tracking-[0.01em] uppercase text-ink-3">{label}</div>
        <div className={`text-[30px] font-semibold tracking-[-0.04em] leading-none mt-2 ${hero ? '' : valueClass || 'text-ink'}`}>{value}</div>
      </div>
      <div className="font-mono text-[11px] text-ink-3">{sub}</div>
    </div>
  )
}

// ── Day in review ─────────────────────────────────────────────────────────────
export function DayInReview({ data, target }: { data: EodSummary | null; target: number }) {
  return (
    <div className="mt-1">
      <BandLabel title="Day in review" note="READ-ONLY · PULLED FROM POS + COUNTS" />
      <DaypartPlaceholder />
      <div className="grid gap-3 md:grid-cols-2 mb-4">
        <MoversCard title="Top sellers" hint="UNITS" rows={data?.topSellers ?? []} tone="ok" />
        <MoversCard title="Slow movers" hint="REVIEW" rows={data?.slowMovers ?? []} tone="warn" />
      </div>
      <FlagsCard data={data} />
    </div>
  )
}

function BandLabel({ title, note }: { title: string; note: string }) {
  return (
    <div className="flex items-center gap-3 my-4">
      <span className="text-[13px] font-semibold tracking-[-0.01em] text-ink">{title}</span>
      <span className="flex-1 h-px bg-line" />
      <span className="font-mono text-[10px] text-ink-3 tracking-wide">{note}</span>
    </div>
  )
}

// Daypart is a placeholder — SalesEntry is a daily aggregate, no intra-day splits yet.
function DaypartPlaceholder() {
  return (
    <div className={`${card} mb-3`}>
      <div className={cardHead}>
        <h3 className="text-[13px] font-semibold flex items-center gap-2">Sales vs forecast <span className="text-ink-3 font-normal">· by daypart</span></h3>
        <span className="font-mono text-[10px] text-ink-3">est · forecast not wired</span>
      </div>
      <div className="p-6 text-center text-ink-3 font-mono text-[11px]">
        Daypart &amp; forecast breakdown lands with the forecast engine (later phase).
      </div>
    </div>
  )
}

function MoversCard({ title, hint, rows, tone }: { title: string; hint: string; rows: EodSummary['topSellers']; tone: 'ok' | 'warn' }) {
  const toneCls = tone === 'ok' ? 'text-green-text' : 'text-gold-2'
  return (
    <div className={card}>
      <div className={cardHead}>
        <h3 className="text-[13px] font-semibold">{title}</h3>
        <span className="font-mono text-[10px] text-ink-3">{hint}</span>
      </div>
      {rows.length === 0 ? (
        <div className="p-5 text-center text-ink-3 font-mono text-[11px]">No sales recorded today.</div>
      ) : (
        <div className="divide-y divide-line">
          {rows.map((r, i) => (
            <Link key={r.id} href={`/menu?highlight=${r.id}`} className="grid grid-cols-[24px_1fr_auto] gap-3 px-[18px] py-2.5 items-center hover:bg-bg-2/40 transition-colors">
              <span className="font-mono text-[11px] text-ink-3">{tone === 'ok' ? i + 1 : '—'}</span>
              <span className="text-[13px] text-ink font-medium truncate">{r.name}</span>
              <span className={`font-mono text-[13px] font-semibold tabular-nums ${toneCls}`}>{r.units}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

// Variance & waste flags — MVP sources: WastageLog (waste) + PriceAlert (price spikes).
// Theoretical-vs-counted variance rows come in Phase 2 (needs the variance recompute).
function FlagsCard({ data }: { data: EodSummary | null }) {
  const waste = data?.wasteFlags ?? []
  const price = data?.priceFlags ?? []
  const empty = waste.length === 0 && price.length === 0
  return (
    <div className={card}>
      <div className={cardHead}>
        <h3 className="text-[13px] font-semibold flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-red" /> Variance &amp; waste flags <span className="text-ink-3 font-normal">· today</span>
        </h3>
        <Link href="/variance" className="font-mono text-[10px] text-gold-2 border-b border-dashed border-current">FULL VARIANCE →</Link>
      </div>
      {empty ? (
        <div className="p-5 text-center text-ink-3 font-mono text-[11px]">No waste or price flags logged today.</div>
      ) : (
        <div className="divide-y divide-line">
          {price.map(p => (
            <div key={p.id} className="grid grid-cols-[20px_1fr_auto] gap-3 px-[18px] py-2.5 items-center">
              <TrendingUp size={13} className="text-red" />
              <span className="text-[13px] text-ink"><b>{p.name}</b><small className="text-ink-3"> · price change today</small></span>
              <span className="font-mono text-[13px] font-semibold text-red-text tabular-nums">{p.pct != null ? `${p.pct > 0 ? '+' : ''}${p.pct.toFixed(0)}%` : '—'}</span>
            </div>
          ))}
          {waste.map(w => (
            <div key={w.id} className="grid grid-cols-[20px_1fr_auto] gap-3 px-[18px] py-2.5 items-center">
              <AlertTriangle size={13} className="text-gold" />
              <span className="text-[13px] text-ink"><b>{w.name}</b><small className="text-ink-3"> · {w.meta} · {w.loggedBy}</small></span>
              <span className="font-mono text-[13px] font-semibold text-red-text tabular-nums">−{formatCurrency(w.cost)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Close-down checklist + safety temps ────────────────────────────────────────
export function CloseDown({ closeState, tempUnits, onToggleItem }: {
  closeState: EodCloseState | null
  tempUnits: TempUnit[]
  onToggleItem: (itemId: string, done: boolean) => void
}) {
  const router = useRouter()
  const m = computeDayMetrics(tempUnits)
  const locked = closeState?.close.status === 'CLOSED'

  // Group items by section, preserving section order by first appearance.
  const sections: { key: string; items: EodCheckItemDTO[] }[] = []
  ;(closeState?.items ?? []).forEach(it => {
    let sec = sections.find(s => s.key === it.section)
    if (!sec) { sec = { key: it.section, items: [] }; sections.push(sec) }
    sec.items.push(it)
  })

  const doneIds = new Set(closeState?.doneItemIds ?? [])

  return (
    <div className="mt-1">
      <BandLabel title="Close-down" note={locked ? 'SIGNED OFF · READ-ONLY' : 'CHECKLIST · GATES SIGN-OFF'} />

      <div className={`${card} mb-3`}>
        <div className={cardHead}>
          <h3 className="text-[13px] font-semibold">Safety &amp; temps</h3>
          <span className="font-mono text-[10px] text-ink-3">{m.total === 0 ? 'no units' : `${m.logged} / ${m.total}`}</span>
        </div>
        <SafetyTempsSummary
          logged={m.logged}
          total={m.total}
          flagged={m.flagged}
          blocking={!(m.total === 0 || m.allClear)}
          onLogTemps={() => router.push('/temps')}
        />
      </div>

      {!closeState ? (
        <div className={card}>
          <div className="p-6 text-center text-ink-3 font-mono text-[11px]">Loading close checklist…</div>
        </div>
      ) : sections.length === 0 ? (
        <div className={card}>
          <div className="p-6 text-center text-ink-3 font-mono text-[11px]">No close-down checks configured for this revenue centre.</div>
        </div>
      ) : sections.map(sec => (
        <div key={sec.key} className={`${card} mb-3`}>
          <div className={cardHead}>
            <h3 className="text-[13px] font-semibold">{sec.key}</h3>
            <span className="font-mono text-[10px] text-ink-3">
              {sec.items.filter(it => doneIds.has(it.id)).length} / {sec.items.length}
            </span>
          </div>
          <div className="divide-y divide-line">
            {sec.items.map(it => {
              const done = doneIds.has(it.id)
              const blocking = it.isBlocker && !done
              return (
                <button
                  key={it.id}
                  type="button"
                  disabled={locked}
                  onClick={() => onToggleItem(it.id, !done)}
                  className={`w-full flex items-center gap-3 px-[18px] py-2.5 text-left transition-colors ${locked ? 'cursor-default' : 'hover:bg-bg-2/40 cursor-pointer'} ${blocking ? 'bg-red-soft/30' : ''}`}
                  style={blocking ? { boxShadow: 'inset 3px 0 0 #dc2626' } : undefined}
                >
                  <span className={`w-[20px] h-[20px] rounded-[6px] border-[1.5px] grid place-items-center shrink-0 transition-all ${done ? 'bg-green border-green text-white' : 'border-line-2 text-transparent'}`}>
                    <Check size={12} strokeWidth={3} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`block text-[13px] font-medium truncate ${done ? 'text-ink-3 line-through decoration-ink-4' : 'text-ink'}`}>{it.title}</span>
                    {it.meta && <span className="block font-mono text-[10.5px] text-ink-3 mt-px truncate">{it.meta}</span>}
                  </span>
                  {blocking && <span className="font-mono text-[10px] text-red-text font-semibold shrink-0">blocker</span>}
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── RC picker (close is per-revenue-centre) ─────────────────────────────────────
export function RcPicker({ revenueCenters, onPick }: {
  revenueCenters: RevenueCenter[]
  onPick: (id: string) => void
}) {
  return (
    <div className="mt-1">
      <BandLabel title="Close-down" note="PICK A REVENUE CENTRE" />
      <div className={card}>
        <div className="p-6 text-center">
          <p className="text-[13px] text-ink-2 mb-4">Close is per revenue centre — pick one to close:</p>
          <div className="flex flex-wrap justify-center gap-2">
            {revenueCenters.map(rc => (
              <button
                key={rc.id}
                onClick={() => onPick(rc.id)}
                className="inline-flex items-center gap-2 border border-line bg-paper text-ink-2 px-3.5 py-2 rounded-[9px] text-[13px] font-medium hover:border-ink-3 transition-colors"
              >
                <span className="w-2 h-2 rounded-full" style={{ background: rc.color }} />
                {rc.name}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Loop strip (brand chrome, static) ─────────────────────────────────────────
export function LoopStrip() {
  return (
    <div className="mt-5 flex flex-col md:flex-row md:items-center gap-3 px-[18px] py-3.5 bg-ink text-paper rounded-[12px]">
      <span className="font-mono text-[10px] text-gold shrink-0"><RotateCw size={11} className="inline mb-0.5" /> THE LOOP</span>
      <span className="text-[12.5px] text-ink-4">You&apos;re at <b className="text-paper">06 · TRUTH</b> — service is counted. Sign-off writes today&apos;s actuals back into <b className="text-paper">01 · IN</b>, so tomorrow&apos;s Pass opens with real numbers.</span>
    </div>
  )
}

// ── Sets up tomorrow · prep-for-tomorrow + order suggestions ───────────────────
interface OrderLine {
  id: string
  name: string
  onHand: number
  par: number
  unit: string
  suggestedQty: number
  unitPrice: number
  lineCost: number
}
interface OrderSupplierGroup {
  supplierId: string | null
  supplierName: string
  lines: OrderLine[]
  subtotal: number
}
interface EodOrdersDTO {
  rcId: string
  suppliers: OrderSupplierGroup[]
  lineCount: number
  total: number
}

export function SetsUpTomorrow({ rcId }: { rcId: string }) {
  return (
    <div className="mt-1">
      <BandLabel title="Sets up tomorrow" note="SUGGESTED FROM PAR + DEPLETION" />
      <PrepForTomorrowCard rcId={rcId} />
      <OrderSuggestionsCard rcId={rcId} />
    </div>
  )
}

function PrepForTomorrowCard({ rcId }: { rcId: string }) {
  const [items, setItems] = useState<PrepItemRich[] | null>(null)
  const [queuing, setQueuing] = useState(false)
  const [justQueued, setJustQueued] = useState(false)

  const load = useCallback(() => {
    fetch('/api/prep/items', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then((d: PrepItemRich[] | null) => { if (Array.isArray(d)) setItems(d) })
      .catch(() => {})
  }, [])

  useEffect(() => { setItems(null); load() }, [rcId, load])

  const targets = (items ?? [])
    .filter(i => i.priority !== 'LATER' && !i.isOnList)
    .sort((a, b) => (a.priority === b.priority ? 0 : a.priority === '911' ? -1 : 1))

  async function queueAll() {
    if (targets.length === 0 || queuing) return
    setQueuing(true)
    try {
      await Promise.all(targets.map(i =>
        fetch(`/api/prep/items/${i.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isOnList: true }),
        })
      ))
      setJustQueued(true)
      load()
      setTimeout(() => setJustQueued(false), 2500)
    } finally {
      setQueuing(false)
    }
  }

  return (
    <div className={`${card} mb-3`}>
      <div className={cardHead}>
        <h3 className="text-[13px] font-semibold flex items-center gap-2">
          <ClipboardList size={13} className="text-ink-3" /> Prep for tomorrow
        </h3>
        <span className={`font-mono text-[10px] ${justQueued ? 'text-green-text' : 'text-ink-3'}`}>
          {justQueued ? 'Queued → Prep board' : items === null ? '…' : `${targets.length} suggested`}
        </span>
      </div>
      {items === null ? (
        <div className="p-6 text-center text-ink-3 font-mono text-[11px]">Loading prep suggestions…</div>
      ) : targets.length === 0 ? (
        <div className="p-6 text-center text-ink-3 font-mono text-[11px]">Nothing below par — prep&apos;s in good shape.</div>
      ) : (
        <>
          <div className="divide-y divide-line">
            {targets.map(it => (
              <div key={it.id} className="grid grid-cols-[1fr_auto] gap-3 px-[18px] py-2.5 items-center">
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="text-[13px] text-ink font-medium truncate">{it.name}</span>
                    <span className={`font-mono text-[9px] uppercase tracking-wide px-[7px] py-0.5 rounded-full font-semibold shrink-0 ${it.priority === '911' ? 'bg-red-soft text-red-text' : 'bg-gold-soft text-gold-2'}`}>
                      {it.priority === '911' ? 'priority' : 'needed'}
                    </span>
                  </span>
                  <span className="block font-mono text-[10.5px] text-ink-3 mt-px">on hand {it.onHand} / par {it.parLevel}</span>
                </span>
                <span className="font-mono text-[13px] font-semibold text-ink tabular-nums text-right shrink-0">
                  {it.suggestedQty}<small className="text-ink-3 font-normal ml-1">{it.unit}</small>
                </span>
              </div>
            ))}
          </div>
          <div className="px-[18px] py-3 border-t border-line bg-bg-2">
            <button
              onClick={queueAll}
              disabled={queuing}
              className="w-full py-2 rounded-[9px] text-[13px] font-semibold bg-ink text-paper hover:bg-[#18181b] transition-colors disabled:opacity-60"
            >
              Queue {targets.length} to board
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function OrderSuggestionsCard({ rcId }: { rcId: string }) {
  const [data, setData] = useState<EodOrdersDTO | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setData(null)
    fetch(`/api/eod/orders?rcId=${rcId}`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then((d: EodOrdersDTO | null) => { if (d) setData(d) })
      .catch(() => {})
  }, [rcId])

  function copyOrderList() {
    if (!data || data.suppliers.length === 0) return
    const text = data.suppliers.map(sup => {
      const lines = sup.lines.map(l => `  ${l.suggestedQty} ${l.unit}  ${l.name}`).join('\n')
      return `${sup.supplierName}\n${lines}`
    }).join('\n\n')
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => {})
  }

  return (
    <div className={`${card} mb-3`}>
      <div className={cardHead}>
        <h3 className="text-[13px] font-semibold flex items-center gap-2">
          <Truck size={13} className="text-ink-3" /> Order suggestions <span className="text-ink-3 font-normal">· below par</span>
        </h3>
        <Link href="/inventory" className="font-mono text-[10px] text-gold-2 border-b border-dashed border-current">SUPPLIERS →</Link>
      </div>
      {data === null ? (
        <div className="p-6 text-center text-ink-3 font-mono text-[11px]">Loading order suggestions…</div>
      ) : data.suppliers.length === 0 ? (
        <div className="p-6 text-center text-ink-3 font-mono text-[11px]">Everything at or above par.</div>
      ) : (
        <>
          {data.suppliers.map(sup => (
            <div key={sup.supplierId ?? sup.supplierName}>
              <div className="flex items-center gap-2 px-[18px] py-2 bg-bg-2 border-b border-line font-mono text-[10.5px] text-ink-3 uppercase tracking-wide">
                <span className="w-[7px] h-[7px] rounded-full bg-ink-4" />
                {sup.supplierName}
                <span className="ml-auto text-ink-2 font-semibold normal-case tracking-normal">{formatCurrency(sup.subtotal)}</span>
              </div>
              <div className="divide-y divide-line">
                {sup.lines.map(l => (
                  <div key={l.id} className="grid grid-cols-[1fr_auto_auto] gap-3 px-[18px] py-2.5 items-center">
                    <span className="min-w-0">
                      <span className="block text-[13px] text-ink font-medium truncate">{l.name}</span>
                      <span className="block font-mono text-[10.5px] text-ink-3 mt-px">on hand {l.onHand} / par {l.par} {l.unit}</span>
                    </span>
                    <span className="font-mono text-[13px] font-semibold text-ink tabular-nums text-right shrink-0">
                      {l.suggestedQty}<small className="text-ink-3 font-normal ml-1">{l.unit}</small>
                    </span>
                    <span className="font-mono text-[12.5px] font-semibold text-ink-2 tabular-nums text-right shrink-0">{formatCurrency(l.lineCost)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div className="flex items-center gap-3.5 px-[18px] py-3.5 bg-bg-2 border-t border-line">
            <span className="text-[12.5px] text-ink-3">
              <b className="text-ink font-semibold">{data.lineCount}</b> lines · <b className="text-ink font-semibold">{data.suppliers.length}</b> suppliers
            </span>
            <span className="ml-auto font-mono text-[16px] font-semibold text-ink tabular-nums">{formatCurrency(data.total)}</span>
            <button
              onClick={copyOrderList}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-[9px] text-[12.5px] font-semibold transition-colors ${copied ? 'bg-green text-white' : 'bg-ink text-paper hover:bg-[#18181b]'}`}
            >
              {copied ? <Check size={13} /> : <ClipboardList size={13} />} {copied ? 'Copied' : 'Copy order list'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// ── Right rail · close ─────────────────────────────────────────────────────────
const GATE_C = 2 * Math.PI * 44

export function CloseRail({ data, closeState, isRcScoped, signoffError, onSaveHandover, onSignOff, onReopen }: {
  data: EodSummary | null
  closeState: EodCloseState | null
  isRcScoped: boolean
  signoffError: string | null
  onSaveHandover: (text: string) => void
  onSignOff: () => void
  onReopen: () => void
}) {
  return (
    <aside>
      <GateCard
        closeState={closeState}
        isRcScoped={isRcScoped}
        signoffError={signoffError}
        onSignOff={onSignOff}
        onReopen={onReopen}
      />

      {/* Day summary — net sales + food cost are LIVE; the rest are placeholders */}
      <div className={railCard}>
        <h4 className="text-[12px] font-semibold text-ink mb-2.5 flex items-center justify-between">Day summary <span className="font-mono text-[10px] text-ink-3 font-normal">closes loop</span></h4>
        <SumRow l="Gross sales" v="—" note="est" />
        <SumRow l="Comps & voids" v="—" note="est" />
        <SumRow l="Discounts" v="—" note="est" />
        <SumRow l="Net sales" v={data ? formatCurrency(data.netSales) : '—'} />
        <div className="flex items-center justify-between pt-2 mt-1 border-t border-line">
          <span className="text-[12px] text-ink font-medium">Food cost</span>
          <span className="font-mono text-[12px] font-semibold text-red-text tabular-nums">
            {data ? formatCurrency(data.foodCostDollars) : '—'}{data?.foodCostPct != null ? ` · ${data.foodCostPct.toFixed(1)}%` : ''}
          </span>
        </div>
      </div>

      {/* Handover — live, persists to tomorrow's Pass via PATCH /api/eod/close */}
      <HandoverCard closeState={closeState} isRcScoped={isRcScoped} onSave={onSaveHandover} />
    </aside>
  )
}

function GateCard({ closeState, isRcScoped, signoffError, onSignOff, onReopen }: {
  closeState: EodCloseState | null
  isRcScoped: boolean
  signoffError: string | null
  onSignOff: () => void
  onReopen: () => void
}) {
  if (!isRcScoped) {
    return (
      <div className={`${railCard} text-center`}>
        <div className="mx-auto w-24 h-24 rounded-full border-8 border-bg-2 flex items-center justify-center">
          <span className="text-[22px] font-semibold text-ink-3">—</span>
        </div>
        <div className="text-[14px] font-semibold text-ink mt-3">Close the day</div>
        <div className="text-[11.5px] text-ink-3 mt-1">Pick a revenue centre to close.</div>
      </div>
    )
  }

  const progress = closeState?.progress ?? null
  const total = progress?.total ?? 0
  const done = progress?.done ?? 0
  const pct = total > 0 ? Math.round((done / total) * 100) : 100
  const ready = progress?.ready ?? true
  const blockers = progress?.blockers ?? 0
  const closed = closeState?.close.status === 'CLOSED'
  const ringColor = closed || ready ? '#16a34a' : blockers > 0 ? '#dc2626' : '#d97706'
  const offset = GATE_C * (1 - pct / 100)

  let title: string
  let sub: string
  if (closed) {
    title = 'Day closed'
    const t = closeState?.close.signedOffAt ? new Date(closeState.close.signedOffAt) : null
    const time = t ? `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}` : ''
    sub = `signed off by ${closeState?.close.signedOffByName ?? 'unknown'}${time ? ` · ${time}` : ''}`
  } else if (blockers > 0) {
    title = 'Not ready to close'
    sub = `${blockers} blocker${blockers > 1 ? 's' : ''} must clear`
  } else if (!ready) {
    title = 'Almost closed'
    sub = `${total - done} check${total - done > 1 ? 's' : ''} left`
  } else {
    title = 'Ready to close'
    sub = 'Every check is clear. Sign off the day.'
  }

  return (
    <div className={`${railCard} text-center`}>
      <div className="w-24 h-24 mx-auto grid place-items-center relative">
        <svg viewBox="0 0 100 100" width="96" height="96" className="absolute inset-0 -rotate-90">
          <circle cx="50" cy="50" r="44" fill="none" stroke="#f4f4f5" strokeWidth="8" />
          <circle
            id="ringFill"
            cx="50" cy="50" r="44" fill="none" stroke={ringColor} strokeWidth="8" strokeLinecap="round"
            strokeDasharray={GATE_C.toFixed(2)} strokeDashoffset={offset.toFixed(2)}
            style={{ transition: 'stroke-dashoffset .3s ease, stroke .3s' }}
          />
        </svg>
        <span className="text-[22px] font-semibold text-ink tracking-[-0.03em]">{pct}<small className="text-[12px] text-ink-3">%</small></span>
      </div>
      <div className="text-[14px] font-semibold text-ink mt-3">{title}</div>
      <div className="text-[11.5px] text-ink-3 mt-1">{sub}</div>
      {signoffError && !closed && (
        <div className="text-[11px] text-red-text font-medium mt-2">{signoffError}</div>
      )}
      {closed ? (
        <button
          onClick={onReopen}
          className="w-full mt-3 inline-flex items-center justify-center gap-1.5 py-2.5 rounded-[9px] border border-line bg-paper text-ink-2 text-[13px] font-medium hover:border-ink-3 transition-colors"
        >
          <RotateCcw size={13} /> Reopen
        </button>
      ) : (
        <button
          onClick={onSignOff}
          disabled={!ready}
          className={`w-full mt-3 py-2.5 rounded-[9px] text-[13px] font-semibold transition-colors ${
            ready ? 'bg-green text-white hover:bg-green-text' : 'bg-bg-2 text-ink-4 cursor-not-allowed'
          }`}
        >
          Close the day
        </button>
      )}
    </div>
  )
}

function HandoverCard({ closeState, isRcScoped, onSave }: {
  closeState: EodCloseState | null
  isRcScoped: boolean
  onSave: (text: string) => void
}) {
  const closed = closeState?.close.status === 'CLOSED'
  const disabled = !isRcScoped || closed
  return (
    <div className={railCard}>
      <h4 className="text-[12px] font-semibold text-ink mb-2 flex items-center justify-between">Handover note <span className="font-mono text-[10px] text-ink-3 font-normal">to opener</span></h4>
      <textarea
        disabled={disabled}
        defaultValue={closeState?.close.handoverNote ?? ''}
        key={closeState?.close.id ?? 'none'}
        onChange={e => onSave(e.target.value)}
        placeholder={isRcScoped ? "Anything tomorrow's opener should know? Deliveries, repairs, VIP bookings…" : 'Pick a revenue centre to leave a note.'}
        className={`w-full h-20 text-[12.5px] p-2.5 rounded-[8px] border border-line resize-none outline-none ${disabled ? 'bg-bg-2/40 text-ink-3' : 'bg-bg text-ink focus:border-ink-3'}`}
      />
    </div>
  )
}

function SumRow({ l, v, note }: { l: string; v: string; note?: string }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-[12px] text-ink-3">{l}</span>
      <span className="font-mono text-[12px] text-ink tabular-nums">{note && <span className="text-ink-4 mr-1">{note}</span>}{v}</span>
    </div>
  )
}
