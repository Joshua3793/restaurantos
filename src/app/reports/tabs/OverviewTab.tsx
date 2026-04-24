'use client'
import { useState, useEffect } from 'react'
import { TrendingUp, ShoppingCart, AlertTriangle, Package } from 'lucide-react'
import {
  AreaChart, Area, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts'
import { formatCurrency } from '@/lib/utils'
import { KpiCard, SectionHeader, Card, EmptyState, CustomTooltip, LoadingState, CAT_COLORS } from '../report-components'

export default function OverviewTab({ period }: { period: number }) {
  const [data, setData] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/reports/analytics?section=overview&days=${period}`)
      .then(r => r.json()).then(setData).finally(() => setLoading(false))
  }, [period])

  if (loading) return <LoadingState />
  if (!data) return <EmptyState message="Failed to load overview" />

  const kpis = data.kpis as Record<string, { value: number; prev: number | null; change: number | null }>
  const revenueTrend = (data.revenueTrend as { date: string; revenue: number }[]) ?? []
  const byCategory = (data.inventoryByCategory as { cat: string; value: number }[]) ?? []
  const alerts = (data.recentAlerts as { id: string; inventoryItem: { itemName: string }; changePct: number; direction: string; session: { supplierName: string } | null }[]) ?? []
  const lastCount = data.lastCount as { label: string; totalCountedValue: number; finalizedAt: string } | null

  return (
    <div className="space-y-6">
      {/* KPI Row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <KpiCard label="Revenue" value={formatCurrency(kpis.revenue.value)} change={kpis.revenue.change} accent="blue" icon={TrendingUp} sub={`last ${period}d`} />
        <KpiCard label="Purchase Spend" value={formatCurrency(kpis.purchases.value)} change={kpis.purchases.change} inverse accent="purple" icon={ShoppingCart} sub={`last ${period}d`} />
        <KpiCard label="Wastage Cost" value={formatCurrency(kpis.wastage.value)} change={kpis.wastage.change} inverse accent="amber" icon={AlertTriangle} sub={`last ${period}d`} />
        <KpiCard label="Inventory Value" value={formatCurrency(kpis.inventoryValue.value)} accent="green" icon={Package} sub="current" />
        <KpiCard label="Price Alerts" value={String(kpis.priceAlerts.value)} accent={kpis.priceAlerts.value > 0 ? 'red' : 'gray'} icon={AlertTriangle} sub="unacknowledged" />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <SectionHeader title="Revenue Trend" subtitle={`Daily revenue over the last ${period} days`} />
          {revenueTrend.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={revenueTrend}>
                <defs>
                  <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.15} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={d => d.slice(5)} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `$${(v/1000).toFixed(0)}k`} width={40} />
                <Tooltip content={<CustomTooltip />} />
                <Area type="monotone" dataKey="revenue" name="Revenue" stroke="#3b82f6" fill="url(#revGrad)" strokeWidth={2} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          ) : <EmptyState message="No sales data for this period" />}
        </Card>

        <Card>
          <SectionHeader title="Inventory by Category" />
          {byCategory.length > 0 ? (
            <>
              <div className="space-y-2">
                {byCategory.slice(0, 6).map(item => {
                  const total = byCategory.reduce((s, i) => s + i.value, 0)
                  const pctVal = total > 0 ? (item.value / total) * 100 : 0
                  return (
                    <div key={item.cat}>
                      <div className="flex items-center justify-between text-xs mb-0.5">
                        <span className="font-medium text-gray-700">{item.cat}</span>
                        <span className="text-gray-500">{formatCurrency(item.value)}</span>
                      </div>
                      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div className="h-full rounded-full transition-all" style={{ width: `${pctVal}%`, background: CAT_COLORS[item.cat] ?? '#94a3b8' }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          ) : <EmptyState message="No inventory data" />}
        </Card>
      </div>

      {/* Alerts + Last Count */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <SectionHeader title="Recent Price Alerts" subtitle="Latest unacknowledged price changes" />
          {alerts.length > 0 ? (
            <div className="space-y-2">
              {alerts.map(a => (
                <div key={a.id} className="flex items-center justify-between py-1.5 border-b border-gray-50 last:border-0">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-gray-800 truncate">{a.inventoryItem.itemName}</div>
                    <div className="text-xs text-gray-400">{a.session?.supplierName ?? '—'}</div>
                  </div>
                  <span className={`text-sm font-bold shrink-0 ml-3 ${a.direction === 'UP' ? 'text-red-500' : 'text-green-600'}`}>
                    {a.direction === 'UP' ? '+' : ''}{Number(a.changePct).toFixed(1)}%
                  </span>
                </div>
              ))}
            </div>
          ) : <EmptyState message="No unacknowledged price alerts" />}
        </Card>

        <Card>
          <SectionHeader title="Last Inventory Count" />
          {lastCount ? (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-green-100 flex items-center justify-center shrink-0">
                  <Package size={18} className="text-green-600" />
                </div>
                <div>
                  <div className="font-semibold text-gray-900">{lastCount.label}</div>
                  <div className="text-xs text-gray-400">{new Date(lastCount.finalizedAt).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })}</div>
                </div>
              </div>
              <div className="bg-green-50 rounded-lg p-3">
                <div className="text-xs text-green-600 font-medium">Total Counted Value</div>
                <div className="text-2xl font-bold text-green-700">{formatCurrency(Number(lastCount.totalCountedValue))}</div>
              </div>
            </div>
          ) : <EmptyState message="No finalized counts yet" />}
        </Card>
      </div>
    </div>
  )
}
