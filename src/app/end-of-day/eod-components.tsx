'use client'
import Link from 'next/link'
import { TrendingUp, AlertTriangle, RotateCw } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import type { EodSummary } from './page'

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

// ── Loop strip (brand chrome, static) ─────────────────────────────────────────
export function LoopStrip() {
  return (
    <div className="mt-5 flex flex-col md:flex-row md:items-center gap-3 px-[18px] py-3.5 bg-ink text-paper rounded-[12px]">
      <span className="font-mono text-[10px] text-gold shrink-0"><RotateCw size={11} className="inline mb-0.5" /> THE LOOP</span>
      <span className="text-[12.5px] text-ink-4">You&apos;re at <b className="text-paper">06 · TRUTH</b> — service is counted. Sign-off writes today&apos;s actuals back into <b className="text-paper">01 · IN</b>, so tomorrow&apos;s Pass opens with real numbers.</span>
    </div>
  )
}

// ── Right rail · close ─────────────────────────────────────────────────────────
export function CloseRail({ data }: { data: EodSummary | null }) {
  return (
    <aside>
      {/* Gate — Phase 2 (sign-off + checklist). Static preview. */}
      <div className={`${railCard} text-center`}>
        <div className="mx-auto w-24 h-24 rounded-full border-8 border-bg-2 flex items-center justify-center">
          <span className="text-[22px] font-semibold text-ink-3">—</span>
        </div>
        <div className="text-[14px] font-semibold text-ink mt-3">Close the day</div>
        <div className="text-[11.5px] text-ink-3 mt-1">Checklist &amp; sign-off arrive in Phase 2.</div>
        <button disabled className="w-full mt-3 py-2.5 rounded-[9px] bg-bg-2 text-ink-4 text-[13px] font-medium cursor-not-allowed">
          Close the day
        </button>
      </div>

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

      {/* Handover — Phase 2 (persists to tomorrow's Pass). Non-persistent in MVP. */}
      <div className={railCard}>
        <h4 className="text-[12px] font-semibold text-ink mb-2 flex items-center justify-between">Handover note <span className="font-mono text-[10px] text-ink-3 font-normal">to opener</span></h4>
        <textarea disabled placeholder="Handover persistence arrives in Phase 2." className="w-full h-20 text-[12.5px] p-2.5 rounded-[8px] border border-line bg-bg-2/40 text-ink-3 resize-none" />
      </div>
    </aside>
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
