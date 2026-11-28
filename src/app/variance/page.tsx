'use client'
import { useEffect, useState, useMemo } from 'react'
import Link from 'next/link'
import { Activity, ArrowRight } from 'lucide-react'
import { PageHead } from '@/components/layout/PageHead'
import { formatCurrency } from '@/lib/utils'
import { useRc } from '@/contexts/RevenueCenterContext'
import { setScopeParams } from '@/lib/scope-params'

interface VarianceRow {
  inventoryItemId: string
  itemName: string
  category: string
  baseUnit: string
  theoreticalQty: number
  countedQty: number | null
  varianceQty: number | null
  varianceValue: number | null
  pricePerBaseUnit: number
}

interface VarianceResp {
  items: VarianceRow[]
  totalVarianceValue: number
  needsCounts?: boolean
  startDate?: string
  endDate?: string
}

export default function VariancePage() {
  const { activeKind, activeRcId, activeRc, activeLocationId, ready } = useRc()
  const [data, setData] = useState<VarianceResp | null>(null)
  const [range, setRange] = useState<7 | 14 | 30>(7)
  const [fc, setFc] = useState<{ needsCounts: boolean; actualFoodCostPct?: number | null; theoreticalFoodCostPct?: number | null; variancePctPoints?: number | null; varianceDollars?: number } | null>(null)
  useEffect(() => {
    fetch('/api/insights/food-cost-variance', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null).then(j => j && setFc(j))
  }, [])

  // Lines follow the active kitchen (the route scopes count sessions by rcId /
  // locationId). Wait for the scope, or the first load is the whole business.
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    const params = new URLSearchParams({ days: String(range) })
    setScopeParams(params, { activeKind, activeRcId, activeRc, activeLocationId })
    setData(null)
    fetch(`/api/insights/variance-lines?${params}`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(json => { if (!cancelled && json) setData(json) })
    return () => { cancelled = true }
  }, [range, ready, activeKind, activeRcId, activeRc, activeLocationId])
  // The food-cost card's route takes no kitchen filter — say so when one is picked.
  const scoped = activeKind !== 'all'

  const top = useMemo(() => {
    const items = data?.items ?? []
    return [...items]
      .filter(i => i.varianceValue !== null && Math.abs(i.varianceValue) > 0.01)
      .sort((a, b) => Math.abs(b.varianceValue ?? 0) - Math.abs(a.varianceValue ?? 0))
      .slice(0, 15)
  }, [data])

  return (
    <div>
      <PageHead
        crumbs={<><Activity size={12} /> INSIGHTS / VARIANCE</>}
        title="Variance"
        sub={data ? <>Theoretical vs counted over the last <b>{range}d</b> · total drift <b className={data.totalVarianceValue < 0 ? 'text-red-text' : ''}>{formatCurrency(data.totalVarianceValue)}</b></> : <>Loading…</>}
        actions={
          <div className="inline-flex bg-paper border border-line rounded-[9px] p-[3px]">
            {([7, 14, 30] as const).map(n => (
              <button key={n} onClick={() => setRange(n)}
                className={`font-mono text-[11px] px-3 py-1.5 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 rounded-[6px] tracking-[0] transition-colors ${
                  range === n ? 'bg-ink text-paper' : 'text-ink-3 hover:text-ink-2'
                }`}>
                {n}d
              </button>
            ))}
          </div>
        }
      />

      {fc && !fc.needsCounts && fc.variancePctPoints != null && (
        <div className="mb-4 rounded-[12px] border border-line bg-paper p-4 flex flex-wrap items-center gap-x-6 gap-y-1 font-mono text-[12px]">
          <span className="text-ink-3">FOOD COST · last count period{scoped && ' · whole business'}</span>
          <span>actual <b className="text-ink">{fc.actualFoodCostPct!.toFixed(1)}%</b></span>
          <span>theoretical <b className="text-ink">{fc.theoreticalFoodCostPct!.toFixed(1)}%</b></span>
          <span>drift <b className={fc.variancePctPoints > 0 ? 'text-red-text' : 'text-green'}>
            {fc.variancePctPoints > 0 ? '+' : ''}{fc.variancePctPoints.toFixed(1)} pts
          </b>{fc.varianceDollars != null && <> ({formatCurrency(fc.varianceDollars)})</>}</span>
        </div>
      )}

      {!data ? null : top.length === 0 ? (
        data.needsCounts ? (
          <div className="bg-paper border border-line rounded-[12px] p-12 text-center">
            <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3">No counts in range</p>
            <p className="text-[14px] text-ink-2 mt-2 max-w-md mx-auto">
              No finalized stock counts in the last <b>{range}d</b>. Variance is measured at count time — finalize a count to see theoretical vs counted drift. Widen the range or <Link href="/count" className="underline">run a count</Link>.
            </p>
          </div>
        ) : (
          <div className="bg-paper border border-line rounded-[12px] p-12 text-center">
            <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-green-text">No variance</p>
            <p className="text-[14px] text-ink-2 mt-2 max-w-md mx-auto">
              Counted stock matched theoretical on every line in the last <b>{range}d</b>. Either you&apos;re running a tight kitchen, or counts were light.
            </p>
          </div>
        )
      ) : (
        <section className="bg-paper border border-line rounded-[12px] overflow-hidden">
          <header className="flex items-center justify-between px-[18px] py-3 border-b border-line bg-bg-2">
            <h3 className="text-[13px] font-semibold tracking-[-0.01em]">
              Top variance lines <span className="font-mono text-[10.5px] text-ink-3 font-normal">· top {top.length}</span>
            </h3>
            <span className="font-mono text-[10.5px] text-ink-3">SORTED BY |Δ$|</span>
          </header>
          <div className="md:hidden grid grid-cols-[1fr_auto] gap-3 px-4 py-2.5 bg-bg-2 border-b border-line font-mono text-[10.5px] uppercase tracking-[0.02em] text-ink-3">
            <span>Item</span>
            <span className="text-right">Δ $</span>
          </div>
          <div className="hidden md:grid grid-cols-[1.6fr_1fr_1fr_auto_auto] gap-3 px-[18px] py-2.5 bg-bg-2 border-b border-line font-mono text-[10.5px] uppercase tracking-[0.02em] text-ink-3">
            <span>Item</span>
            <span className="text-right">Theoretical</span>
            <span className="text-right">Counted</span>
            <span className="text-right">Δ qty</span>
            <span className="text-right">Δ $</span>
          </div>
          {top.map(r => {
            const tone = (r.varianceValue ?? 0) < -5 ? 'bad' : (r.varianceValue ?? 0) > 5 ? 'warn' : 'neutral'
            const toneCls = tone === 'bad' ? 'text-red-text' : tone === 'warn' ? 'text-gold-2' : 'text-ink-3'
            const dollars = r.varianceValue !== null ? (r.varianceValue > 0 ? '+' : '−') + '$' + Math.abs(r.varianceValue).toFixed(0) : '—'
            return (
              <div key={r.inventoryItemId} className="border-b border-line last:border-0">
              {/* Phone: item | Δ$, with theoretical vs counted on the line under the name. */}
              <Link href={`/inventory?highlight=${r.inventoryItemId}`}
                className="md:hidden grid grid-cols-[1fr_auto] gap-3 px-4 py-3 min-h-[56px] items-center active:bg-bg-2/60">
                <div className="min-w-0">
                  <div className="text-[14px] text-ink font-medium tracking-[-0.005em] truncate">{r.itemName}</div>
                  <div className="font-mono text-[11px] text-ink-3 mt-0.5 tabular-nums">
                    expected {r.theoreticalQty.toFixed(1)} · counted {r.countedQty?.toFixed(1) ?? '—'} {r.baseUnit}
                  </div>
                </div>
                <div className={`font-mono text-[14px] font-semibold text-right tabular-nums ${toneCls}`}>{dollars}</div>
              </Link>
              <Link href={`/inventory?highlight=${r.inventoryItemId}`}
                className="hidden md:grid grid-cols-[1.6fr_1fr_1fr_auto_auto] gap-3 px-[18px] py-3 items-center hover:bg-bg-2/40 transition-colors">
                <div className="min-w-0">
                  <div className="text-[13px] text-ink font-medium tracking-[-0.005em] truncate">{r.itemName}</div>
                  <div className="font-mono text-[10.5px] text-ink-3 mt-0.5">{r.category} · {r.baseUnit} · ${r.pricePerBaseUnit.toFixed(4)}/u</div>
                </div>
                <div className="font-mono text-[12px] text-ink-2 text-right tabular-nums">{r.theoreticalQty.toFixed(1)}</div>
                <div className="font-mono text-[12px] text-ink-2 text-right tabular-nums">{r.countedQty?.toFixed(1) ?? '—'}</div>
                <div className={`font-mono text-[12px] text-right tabular-nums ${toneCls}`}>
                  {r.varianceQty !== null ? (r.varianceQty > 0 ? '+' : '') + r.varianceQty.toFixed(1) : '—'}
                </div>
                <div className={`font-mono text-[13px] font-semibold text-right tabular-nums ${toneCls} min-w-[80px] inline-flex items-center justify-end gap-1`}>
                  {dollars}
                  <ArrowRight size={11} className="text-ink-4" />
                </div>
              </Link>
              </div>
            )
          })}
        </section>
      )}

      <div className="mt-5 font-mono text-[10.5px] text-ink-3 tracking-wide text-center">
        Variance = counted on-hand minus theoretical on-hand (last count + purchases − sales − waste), measured at each finalized count.
        Negative Δ$ means short (shrinkage — eats into margin); positive means over (uncounted receiving or light usage).
      </div>
    </div>
  )
}
