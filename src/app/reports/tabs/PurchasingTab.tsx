'use client'
import { useState, useEffect } from 'react'
import { ShoppingCart } from 'lucide-react'
import {
  BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts'
import { formatCurrency, formatPricePerBase } from '@/lib/utils'
import { KpiCard, SectionHeader, Card, EmptyState, CustomTooltip, LoadingState } from '../report-components'
import { useRc } from '@/contexts/RevenueCenterContext'
import { DateRangePicker, rangeForPreset, analyticsParams, type DateRange } from '@/components/reports/DateRangePicker'

export default function PurchasingTab() {
  const { activeRcId, activeRc } = useRc()
  const [range, setRange] = useState<DateRange>(() => rangeForPreset('last30'))
  const [data, setData] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const params = analyticsParams(range, activeRcId, activeRc); params.set('section', 'purchasing')
    fetch(`/api/reports/analytics?${params}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled) setData(d) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [range, activeRcId, activeRc])

  const picker = <DateRangePicker value={range} onChange={setRange} defaultPreset="last30" />

  if (loading && !data) return <div className="space-y-6">{picker}<LoadingState /></div>
  if (!data) return <div className="space-y-6">{picker}<EmptyState message="Failed to load purchasing data" /></div>

  const summary = data.summary as { totalSpend: number; totalLines: number; supplierCount: number }
  const supplierSpend = (data.supplierSpend as { name: string; spend: number; lines: number }[]) ?? []
  const topItems = (data.topItems as { name: string; spend: number; qty: number; category: string }[]) ?? []
  const spendTrend = (data.spendTrend as { week: string; spend: number }[]) ?? []

  const maxSupplierSpend = supplierSpend[0]?.spend ?? 1

  return (
    <div className="space-y-6">
      {picker}
      {/* KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <KpiCard label="Total Spend" value={formatCurrency(summary.totalSpend)} accent="purple" icon={ShoppingCart} sub={range.label} />
        <KpiCard label="Line Items" value={summary.totalLines.toLocaleString()} accent="blue" sub="invoice lines processed" />
        <KpiCard label="Suppliers" value={String(summary.supplierCount)} accent="gray" sub="with approved invoices" />
      </div>

      {/* Weekly Spend Chart */}
      <Card>
        <SectionHeader title="Weekly Purchase Spend" subtitle="Approved invoice totals by week" />
        {spendTrend.length > 0 ? (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={spendTrend}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
              <XAxis dataKey="week" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `$${(v/1000).toFixed(0)}k`} width={40} />
              <Tooltip content={<CustomTooltip />} />
              <Bar dataKey="spend" name="Spend" fill="#7c3aed" radius={[3,3,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : <EmptyState message="No approved invoices found for this period. Approve invoice sessions to see spend data." />}
      </Card>

      {/* Supplier Breakdown + Top Items */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <SectionHeader title="Spend by Supplier" subtitle="Top suppliers by total spend" />
          {supplierSpend.length > 0 ? (
            <div className="space-y-3">
              {supplierSpend.map(s => {
                const pctVal = (s.spend / maxSupplierSpend) * 100
                return (
                  <div key={s.name}>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="font-medium text-ink-2 truncate">{s.name}</span>
                      <div className="flex items-center gap-2 shrink-0 ml-2">
                        <span className="text-ink-4">{s.lines} lines</span>
                        <span className="font-semibold text-ink-2">{formatCurrency(s.spend)}</span>
                      </div>
                    </div>
                    <div className="h-2 bg-bg-2 rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-blue" style={{ width: `${pctVal}%` }} />
                    </div>
                  </div>
                )
              })}
            </div>
          ) : <EmptyState message="No supplier spend data" />}
        </Card>

        <Card>
          <SectionHeader title="Top Items by Spend" subtitle="Most expensive items purchased" />
          {topItems.length > 0 ? (
            <div className="overflow-y-auto max-h-80">
              {topItems.map((item, i) => (
                <div key={item.name} className="flex items-center gap-3 py-2 border-b border-line last:border-0">
                  <span className="text-xs text-ink-4 w-5 text-right shrink-0">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-ink-2 truncate">{item.name}</div>
                    <div className="text-xs text-ink-4">{item.category}</div>
                  </div>
                  <span className="font-semibold text-ink-2 shrink-0">{formatCurrency(item.spend)}</span>
                </div>
              ))}
            </div>
          ) : <EmptyState message="No purchase data" />}
        </Card>
      </div>

      {/* Multi-supplier comparison */}
      {(() => {
        const ms = data.multiSupplier as {
          items: { itemId: string; name: string; baseUnit: string | null; offers: { supplier: string; ppb: number; isPrimary: boolean }[]; spreadPct: number; potentialSaving: number }[]
          totalSaving: number
          volatile: { name: string; supplier: string; volatility: number | null; stability: string | null; purchases: number }[]
        } | undefined
        if (!ms || (ms.items.length === 0 && ms.volatile.length === 0)) return null
        const fmtPpb = formatPricePerBase
        return (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <SectionHeader
                title="Multi-Supplier Items"
                subtitle={`${ms.totalSaving > 0 ? `Buying each from its cheapest supplier would have saved ~${formatCurrency(ms.totalSaving)} over this period` : 'Price comparison across suppliers'}${activeRcId ? ' · global (offers aren’t RC-specific)' : ''}`}
              />
              {ms.items.length > 0 ? (
                <div className="space-y-3 overflow-y-auto max-h-96">
                  {ms.items.map(it => (
                    <div key={it.itemId} className="border-b border-line pb-2.5 last:border-0">
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="font-medium text-ink-2 truncate">{it.name}</span>
                        <span className="text-ink-4 shrink-0 ml-2">spread {it.spreadPct}%{it.potentialSaving > 0 ? ` · ${formatCurrency(it.potentialSaving)} potential` : ''}</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {it.offers.map((o, i) => (
                          <span key={o.supplier} className={`font-mono text-[10.5px] px-2 py-[3px] rounded-full ${i === 0 ? 'bg-green-soft text-green-text font-semibold' : 'bg-bg text-ink-3'}`}>
                            {o.supplier}: {fmtPpb(o.ppb, it.baseUnit)}{i === 0 ? ' ✓' : ''}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : <EmptyState message="No items bought from multiple suppliers yet" />}
            </Card>

            <Card>
              <SectionHeader title="Most Volatile Prices" subtitle="Price variation per item & supplier over the selected period" />
              {ms.volatile.length > 0 ? (
                <div className="space-y-2">
                  {ms.volatile.map((v, i) => (
                    <div key={`${v.name}-${v.supplier}`} className="flex items-center gap-3 py-1.5 border-b border-line last:border-0">
                      <span className="text-xs text-ink-4 w-5 text-right shrink-0">{i + 1}</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-ink-2 truncate">{v.name}</div>
                        <div className="text-xs text-ink-4">{v.supplier} · {v.purchases} purchases</div>
                      </div>
                      <span className={`font-mono text-[10.5px] font-semibold px-2 py-[3px] rounded-full shrink-0 ${
                        v.stability === 'volatile' ? 'bg-red-soft text-red-text' : v.stability === 'variable' ? 'bg-gold-soft text-gold-2' : 'bg-green-soft text-green-text'
                      }`}>±{Math.round((v.volatility ?? 0) * 100)}%</span>
                    </div>
                  ))}
                </div>
              ) : <EmptyState message="Not enough purchase history yet (3+ buys per supplier needed)" />}
            </Card>
          </div>
        )
      })()}
    </div>
  )
}
