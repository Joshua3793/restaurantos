'use client'
import { useState, useEffect } from 'react'
import { Package } from 'lucide-react'
import {
  AreaChart, Area, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts'
import { formatCurrency } from '@/lib/utils'
import { KpiCard, SectionHeader, Card, EmptyState, CustomTooltip, LoadingState, CAT_COLORS } from '../report-components'

export default function InventoryTab({ period }: { period: number }) {
  const [data, setData] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/reports/analytics?section=inventory&days=${period}`)
      .then(r => r.json()).then(setData).finally(() => setLoading(false))
  }, [period])

  if (loading) return <LoadingState />
  if (!data) return <EmptyState message="Failed to load inventory data" />

  const summary = data.summary as { totalValue: number; totalItems: number; notCounted30: number; priceChanges: number; priceIncreases: number; priceDecreases: number }
  const topPriceChanges = (data.topPriceChanges as { item: string; category: string; supplier: string; previousPrice: number; newPrice: number; changePct: number; direction: string }[]) ?? []
  const supplierVol = (data.supplierVolatility as { name: string; changes: number; ups: number; downs: number; avgChange: number }[]) ?? []
  const topValueItems = (data.topValueItems as { name: string; category: string; supplier: string; value: number; stock: number }[]) ?? []
  const valueTrend = (data.valueTrend as { label: string; date: string; value: number }[]) ?? []
  const byCategory = (data.byCategory as { cat: string; value: number; count: number }[]) ?? []

  return (
    <div className="space-y-6">
      {/* KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <KpiCard label="Inventory Value" value={formatCurrency(summary.totalValue)} accent="green" icon={Package} />
        <KpiCard label="Active Items" value={String(summary.totalItems)} accent="blue" sub="in inventory" />
        <KpiCard label="Not Counted 30d" value={String(summary.notCounted30)} accent={summary.notCounted30 > 20 ? 'red' : 'amber'} sub="needs attention" />
        <KpiCard label="Price Increases" value={String(summary.priceIncreases)} accent="red" sub={`last ${period}d`} />
        <KpiCard label="Price Decreases" value={String(summary.priceDecreases)} accent="green" sub={`last ${period}d`} />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <SectionHeader title="Inventory Value Trend" subtitle="From finalized count sessions" />
          {valueTrend.length >= 2 ? (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={valueTrend}>
                <defs>
                  <linearGradient id="invGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.15} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `$${(v/1000).toFixed(0)}k`} width={40} />
                <Tooltip content={<CustomTooltip />} />
                <Area type="monotone" dataKey="value" name="Inventory Value" stroke="#10b981" fill="url(#invGrad)" strokeWidth={2} dot={{ fill: '#10b981', r: 4 }} />
              </AreaChart>
            </ResponsiveContainer>
          ) : <EmptyState message="Need at least 2 finalized counts to show trend" />}
        </Card>

        <Card>
          <SectionHeader title="Value by Category" />
          {byCategory.length > 0 ? (
            <div className="space-y-2.5 mt-1">
              {byCategory.map(item => {
                const total = byCategory.reduce((s, i) => s + i.value, 0)
                const pctVal = total > 0 ? (item.value / total) * 100 : 0
                return (
                  <div key={item.cat}>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full" style={{ background: CAT_COLORS[item.cat] ?? '#94a3b8' }} />
                        <span className="font-medium text-gray-700">{item.cat}</span>
                        <span className="text-gray-400">({item.count} items)</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-gray-400">{pctVal.toFixed(1)}%</span>
                        <span className="font-semibold text-gray-700">{formatCurrency(item.value)}</span>
                      </div>
                    </div>
                    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${pctVal}%`, background: CAT_COLORS[item.cat] ?? '#94a3b8' }} />
                    </div>
                  </div>
                )
              })}
            </div>
          ) : <EmptyState message="No inventory data" />}
        </Card>
      </div>

      {/* Price Changes Table */}
      <Card>
        <SectionHeader title="Biggest Price Changes" subtitle={`Items with the largest price movements in the last ${period} days`} />
        {topPriceChanges.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b border-gray-100">
                  <th className="py-2 pr-3 text-xs font-semibold text-gray-500">Item</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-gray-500">Category</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-gray-500 hidden sm:table-cell">Supplier</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-gray-500 text-right">Previous</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-gray-500 text-right">New</th>
                  <th className="py-2 text-xs font-semibold text-gray-500 text-right">Change</th>
                </tr>
              </thead>
              <tbody>
                {topPriceChanges.map((r, i) => (
                  <tr key={i} className="border-b border-gray-50 hover:bg-gray-50/60">
                    <td className="py-2.5 pr-3 font-medium text-gray-800">{r.item}</td>
                    <td className="py-2.5 pr-3 text-gray-500 text-xs">{r.category}</td>
                    <td className="py-2.5 pr-3 text-gray-500 text-xs hidden sm:table-cell">{r.supplier}</td>
                    <td className="py-2.5 pr-3 text-right text-gray-500 text-xs">{formatCurrency(r.previousPrice)}</td>
                    <td className="py-2.5 pr-3 text-right text-gray-700 font-medium">{formatCurrency(r.newPrice)}</td>
                    <td className="py-2.5 text-right">
                      <span className={`font-bold text-sm ${r.direction === 'UP' ? 'text-red-500' : 'text-green-600'}`}>
                        {r.direction === 'UP' ? '+' : ''}{Number(r.changePct).toFixed(1)}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyState message={`No price changes recorded in the last ${period} days`} />}
      </Card>

      {/* Supplier Volatility + Top Value Items */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <SectionHeader title="Supplier Price Volatility" subtitle="Suppliers with the most price changes" />
          {supplierVol.length > 0 ? (
            <div className="space-y-3">
              {supplierVol.map(s => (
                <div key={s.name} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-gray-800 truncate">{s.name}</div>
                    <div className="flex items-center gap-2 mt-0.5 text-xs text-gray-400">
                      <span className="text-red-400">↑{s.ups} up</span>
                      <span className="text-green-500">↓{s.downs} down</span>
                    </div>
                  </div>
                  <div className="text-right shrink-0 ml-3">
                    <div className="font-bold text-gray-800">{s.changes} changes</div>
                    <div className="text-xs text-gray-400">avg {s.avgChange.toFixed(1)}% Δ</div>
                  </div>
                </div>
              ))}
            </div>
          ) : <EmptyState message="No supplier price data for this period" />}
        </Card>

        <Card>
          <SectionHeader title="Top Value Items" subtitle="Items representing most inventory value" />
          {topValueItems.length > 0 ? (
            <div className="space-y-2">
              {topValueItems.map((item, i) => (
                <div key={item.name} className="flex items-center gap-3 py-1.5 border-b border-gray-50 last:border-0">
                  <span className="text-xs text-gray-400 w-5 text-right shrink-0">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-800 truncate">{item.name}</div>
                    <div className="text-xs text-gray-400">{item.category} · {item.supplier}</div>
                  </div>
                  <span className="font-semibold text-gray-800 shrink-0">{formatCurrency(item.value)}</span>
                </div>
              ))}
            </div>
          ) : <EmptyState message="No inventory data" />}
        </Card>
      </div>
    </div>
  )
}
