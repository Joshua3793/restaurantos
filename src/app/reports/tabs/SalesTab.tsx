'use client'
import { useState, useEffect } from 'react'
import { TrendingUp, AlertTriangle } from 'lucide-react'
import {
  BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts'
import { formatCurrency } from '@/lib/utils'
import { KpiCard, SectionHeader, Card, EmptyState, CustomTooltip, LoadingState } from '../report-components'

export default function SalesTab({ period }: { period: number }) {
  const [data, setData] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/reports/analytics?section=sales&days=${period}`)
      .then(r => r.json()).then(setData).finally(() => setLoading(false))
  }, [period])

  if (loading) return <LoadingState />
  if (!data) return <EmptyState message="Failed to load sales data" />

  const summary = data.summary as { totalRevenue: number; totalFoodSales: number; totalOrders: number }
  const topMenuItems = (data.topMenuItems as {
    name: string; qty: number; revenue: number; cost: number; menuPrice: number | null; foodCostPct: number | null
  }[]) ?? []
  const weeklyRevenue = (data.weeklyRevenue as { week: string; revenue: number; foodSales: number }[]) ?? []
  const foodCostAlerts = (data.foodCostAlerts as { name: string; foodCostPct: number; qty: number }[]) ?? []

  return (
    <div className="space-y-6">
      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <KpiCard label="Total Revenue" value={formatCurrency(summary.totalRevenue)} accent="blue" icon={TrendingUp} sub={`last ${period}d`} />
        <KpiCard label="Food Sales" value={formatCurrency(summary.totalFoodSales)} accent="green" sub="est. food portion" />
        <KpiCard label="Service Days" value={String(summary.totalOrders)} accent="gray" sub="entries logged" />
      </div>

      {/* Weekly Revenue Chart */}
      <Card>
        <SectionHeader title="Weekly Revenue" subtitle="Revenue and food sales by week" />
        {weeklyRevenue.length > 0 ? (
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={weeklyRevenue} barGap={2}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="week" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `$${(v/1000).toFixed(0)}k`} width={40} />
              <Tooltip content={<CustomTooltip />} />
              <Bar dataKey="revenue"   name="Revenue"    fill="#3b82f6" radius={[3,3,0,0]} />
              <Bar dataKey="foodSales" name="Food Sales" fill="#10b981" radius={[3,3,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : <EmptyState message="No sales data for this period" />}
      </Card>

      {/* Top Menu Items */}
      <Card>
        <SectionHeader title="Top Menu Items" subtitle={`By quantity sold · last ${period} days`} />
        {topMenuItems.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b border-gray-100">
                  <th className="py-2 pr-3 text-xs font-semibold text-gray-500 w-6">#</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-gray-500">Item</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-gray-500 text-right">Sold</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-gray-500 text-right">Revenue</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-gray-500 text-right">Menu Price</th>
                  <th className="py-2 text-xs font-semibold text-gray-500 text-right">Food Cost %</th>
                </tr>
              </thead>
              <tbody>
                {topMenuItems.map((item, i) => {
                  const fc = item.foodCostPct
                  const fcColor = fc == null ? 'text-gray-400' : fc > 35 ? 'text-red-500 font-bold' : fc > 28 ? 'text-amber-500 font-semibold' : 'text-green-600 font-semibold'
                  return (
                    <tr key={item.name} className="border-b border-gray-50 hover:bg-gray-50/60">
                      <td className="py-2.5 pr-3 text-xs text-gray-400 font-medium">{i + 1}</td>
                      <td className="py-2.5 pr-3 font-medium text-gray-800">{item.name}</td>
                      <td className="py-2.5 pr-3 text-right text-gray-700">{item.qty.toLocaleString()}</td>
                      <td className="py-2.5 pr-3 text-right text-gray-700">{formatCurrency(item.revenue)}</td>
                      <td className="py-2.5 pr-3 text-right text-gray-600">{item.menuPrice ? formatCurrency(item.menuPrice) : '—'}</td>
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
            <AlertTriangle size={16} className="text-amber-500" />
            <SectionHeader title="Food Cost Alerts" subtitle="Items where food cost % exceeds 35% — review pricing or recipe costs" />
          </div>
          <div className="space-y-2">
            {foodCostAlerts.map(a => (
              <div key={a.name} className="flex items-center justify-between py-2 px-3 bg-amber-50 rounded-lg border border-amber-100">
                <span className="text-sm font-medium text-gray-800">{a.name}</span>
                <div className="flex items-center gap-3 text-xs">
                  <span className="text-gray-500">{a.qty} sold</span>
                  <span className="font-bold text-red-500">{a.foodCostPct?.toFixed(1)}% food cost</span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}
