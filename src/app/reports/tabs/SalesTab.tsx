'use client'
import { useState, useEffect } from 'react'
import { TrendingUp, AlertTriangle } from 'lucide-react'
import {
  BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts'
import { formatCurrency } from '@/lib/utils'
import { KpiCard, SectionHeader, Card, EmptyState, CustomTooltip, LoadingState } from '../report-components'
import { useRc } from '@/contexts/RevenueCenterContext'
import { DateRangePicker, rangeForPreset, analyticsParams, type DateRange } from '@/components/reports/DateRangePicker'

export default function SalesTab() {
  const { activeRcId, activeRc } = useRc()
  const [range, setRange] = useState<DateRange>(() => rangeForPreset('last30'))
  const [data, setData] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const params = analyticsParams(range, activeRcId, activeRc); params.set('section', 'sales')
    fetch(`/api/reports/analytics?${params}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled) setData(d) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [range, activeRcId, activeRc])

  const picker = <DateRangePicker value={range} onChange={setRange} defaultPreset="last30" />

  if (loading && !data) return <div className="space-y-6">{picker}<LoadingState /></div>
  if (!data) return <div className="space-y-6">{picker}<EmptyState message="Failed to load sales data" /></div>

  const summary = data.summary as { totalRevenue: number; totalFoodSales: number; totalOrders: number }
  const topMenuItems = (data.topMenuItems as {
    name: string; qty: number; revenue: number; cost: number; menuPrice: number | null; foodCostPct: number | null
  }[]) ?? []
  const weeklyRevenue = (data.weeklyRevenue as { week: string; revenue: number; foodSales: number }[]) ?? []
  const foodCostAlerts = (data.foodCostAlerts as { name: string; foodCostPct: number; qty: number }[]) ?? []

  return (
    <div className="space-y-6">
      {picker}
      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <KpiCard label="Total Revenue" value={formatCurrency(summary.totalRevenue)} accent="blue" icon={TrendingUp} sub={range.label} />
        <KpiCard label="Food Sales" value={formatCurrency(summary.totalFoodSales)} accent="green" sub="est. food portion" />
        <KpiCard label="Service Days" value={String(summary.totalOrders)} accent="gray" sub="entries logged" />
      </div>

      {/* Weekly Revenue Chart */}
      <Card>
        <SectionHeader title="Weekly Revenue" subtitle="Revenue and food sales by week" />
        {weeklyRevenue.length > 0 ? (
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={weeklyRevenue} barGap={2}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
              <XAxis dataKey="week" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `$${(v/1000).toFixed(0)}k`} width={40} />
              <Tooltip content={<CustomTooltip />} />
              <Bar dataKey="revenue"   name="Revenue"    fill="#2563eb" radius={[3,3,0,0]} />
              <Bar dataKey="foodSales" name="Food Sales" fill="#16a34a" radius={[3,3,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : <EmptyState message="No sales data for this period" />}
      </Card>

      {/* Top Menu Items */}
      <Card>
        <SectionHeader title="Top Menu Items" subtitle={`By quantity sold · ${range.label}`} />
        {topMenuItems.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b border-line">
                  <th className="py-2 pr-3 text-xs font-semibold text-ink-3 w-6">#</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-ink-3">Item</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-ink-3 text-right">Sold</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-ink-3 text-right">Revenue</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-ink-3 text-right">Menu Price</th>
                  <th className="py-2 text-xs font-semibold text-ink-3 text-right">Food Cost %</th>
                </tr>
              </thead>
              <tbody>
                {topMenuItems.map((item, i) => {
                  const fc = item.foodCostPct
                  const fcColor = fc == null ? 'text-ink-4' : fc > 35 ? 'text-red font-bold' : fc > 28 ? 'text-gold font-semibold' : 'text-green font-semibold'
                  return (
                    <tr key={item.name} className="border-b border-line hover:bg-bg/60">
                      <td className="py-2.5 pr-3 text-xs text-ink-4 font-medium">{i + 1}</td>
                      <td className="py-2.5 pr-3 font-medium text-ink-2">{item.name}</td>
                      <td className="py-2.5 pr-3 text-right text-ink-2">{item.qty.toLocaleString()}</td>
                      <td className="py-2.5 pr-3 text-right text-ink-2">{formatCurrency(item.revenue)}</td>
                      <td className="py-2.5 pr-3 text-right text-ink-3">{item.menuPrice ? formatCurrency(item.menuPrice) : '—'}</td>
                      <td className="py-2.5 text-right">
                        <span className={`text-sm ${fcColor}`}>{fc != null ? `${fc.toFixed(1)}%` : '—'}</span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : <EmptyState message="No menu item sales data. Import sales first." />}
      </Card>

      {/* Food Cost Alerts */}
      {foodCostAlerts.length > 0 && (
        <Card>
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle size={16} className="text-gold" />
            <SectionHeader title="Food Cost Alerts" subtitle="Items where food cost % exceeds 35% — review pricing or recipe costs" />
          </div>
          <div className="space-y-2">
            {foodCostAlerts.map(a => (
              <div key={a.name} className="flex items-center justify-between py-2 px-3 bg-gold-soft rounded-lg border border-gold-soft">
                <span className="text-sm font-medium text-ink-2">{a.name}</span>
                <div className="flex items-center gap-3 text-xs">
                  <span className="text-ink-3">{a.qty} sold</span>
                  <span className="font-bold text-red">{a.foodCostPct?.toFixed(1)}% food cost</span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}
