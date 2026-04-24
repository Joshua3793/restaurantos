'use client'
import { useState, useEffect } from 'react'
import { ShoppingCart } from 'lucide-react'
import {
  BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts'
import { formatCurrency } from '@/lib/utils'
import { KpiCard, SectionHeader, Card, EmptyState, CustomTooltip, LoadingState } from '../report-components'

export default function PurchasingTab({ period }: { period: number }) {
  const [data, setData] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/reports/analytics?section=purchasing&days=${period}`)
      .then(r => r.json()).then(setData).finally(() => setLoading(false))
  }, [period])

  if (loading) return <LoadingState />
  if (!data) return <EmptyState message="Failed to load purchasing data" />

  const summary = data.summary as { totalSpend: number; totalLines: number; supplierCount: number }
  const supplierSpend = (data.supplierSpend as { name: string; spend: number; lines: number }[]) ?? []
  const topItems = (data.topItems as { name: string; spend: number; qty: number; category: string }[]) ?? []
  const spendTrend = (data.spendTrend as { week: string; spend: number }[]) ?? []

  const maxSupplierSpend = supplierSpend[0]?.spend ?? 1

  return (
    <div className="space-y-6">
      {/* KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <KpiCard label="Total Spend" value={formatCurrency(summary.totalSpend)} accent="purple" icon={ShoppingCart} sub={`last ${period}d`} />
        <KpiCard label="Line Items" value={summary.totalLines.toLocaleString()} accent="blue" sub="invoice lines processed" />
        <KpiCard label="Suppliers" value={String(summary.supplierCount)} accent="gray" sub="with approved invoices" />
      </div>

      {/* Weekly Spend Chart */}
      <Card>
        <SectionHeader title="Weekly Purchase Spend" subtitle="Approved invoice totals by week" />
        {spendTrend.length > 0 ? (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={spendTrend}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="week" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `$${(v/1000).toFixed(0)}k`} width={40} />
              <Tooltip content={<CustomTooltip />} />
              <Bar dataKey="spend" name="Spend" fill="#8b5cf6" radius={[3,3,0,0]} />
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
                      <span className="font-medium text-gray-700 truncate">{s.name}</span>
                      <div className="flex items-center gap-2 shrink-0 ml-2">
                        <span className="text-gray-400">{s.lines} lines</span>
                        <span className="font-semibold text-gray-800">{formatCurrency(s.spend)}</span>
                      </div>
                    </div>
                    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-purple-500" style={{ width: `${pctVal}%` }} />
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
                <div key={item.name} className="flex items-center gap-3 py-2 border-b border-gray-50 last:border-0">
                  <span className="text-xs text-gray-400 w-5 text-right shrink-0">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-800 truncate">{item.name}</div>
                    <div className="text-xs text-gray-400">{item.category}</div>
                  </div>
                  <span className="font-semibold text-gray-800 shrink-0">{formatCurrency(item.spend)}</span>
                </div>
              ))}
            </div>
          ) : <EmptyState message="No purchase data" />}
        </Card>
      </div>
    </div>
  )
}
