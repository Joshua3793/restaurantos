'use client'
import { useEffect, useState, useCallback } from 'react'
import { formatCurrency, formatUnitPrice } from '@/lib/utils'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, PieChart, Pie, Cell, AreaChart, Area,
} from 'recharts'
import {
  TrendingUp, TrendingDown, Minus, AlertTriangle, Package, ShoppingCart,
  DollarSign, BarChart2, ChevronUp, ChevronDown, Clock, ArrowRight,
  Layers, RefreshCw,
} from 'lucide-react'

// ── Constants ─────────────────────────────────────────────────────────────────
const PERIOD_OPTIONS = [
  { label: '30 days', value: 30 },
  { label: '90 days', value: 90 },
  { label: '6 months', value: 180 },
]

const CAT_COLORS: Record<string, string> = {
  MEAT: '#ef4444', FISH: '#06b6d4', DAIRY: '#3b82f6', PROD: '#22c55e',
  DRY: '#eab308', BREAD: '#f97316', PREPD: '#8b5cf6', CHM: '#94a3b8',
}
const CHART_COLORS = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#f97316','#ec4899']

const TABS = [
  { id: 'overview',   label: 'Overview',   icon: BarChart2 },
  { id: 'sales',      label: 'Sales',      icon: TrendingUp },
  { id: 'inventory',  label: 'Inventory',  icon: Package },
  { id: 'purchasing', label: 'Purchasing', icon: ShoppingCart },
  { id: 'cogs',       label: 'Cost & COGS',icon: DollarSign },
]

// ── Helpers ───────────────────────────────────────────────────────────────────
function pct(n: number | null | undefined, decimals = 1) {
  if (n == null) return '—'
  return `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`
}

function DeltaBadge({ change, inverse = false }: { change: number | null; inverse?: boolean }) {
  if (change === null) return <span className="text-xs text-gray-400">vs prev</span>
  const good = inverse ? change < 0 : change > 0
  const Icon = change > 0 ? ChevronUp : change < 0 ? ChevronDown : Minus
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${good ? 'text-green-600' : change === 0 ? 'text-gray-400' : 'text-red-500'}`}>
      <Icon size={11} />
      {Math.abs(change).toFixed(1)}%
    </span>
  )
}

function KpiCard({ label, value, sub, change, inverse = false, accent = 'blue', icon: Icon }:
  { label: string; value: string; sub?: string; change?: number | null; inverse?: boolean; accent?: string; icon?: React.ElementType }) {
  const accentMap: Record<string, string> = {
    blue: 'text-blue-600', green: 'text-green-600', amber: 'text-amber-500',
    red: 'text-red-500', purple: 'text-purple-600', gray: 'text-gray-600',
  }
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className="text-[11px] font-semibold text-gray-400 tracking-wide uppercase leading-tight">{label}</span>
        {Icon && <Icon size={16} className={accentMap[accent] ?? 'text-gray-400'} />}
      </div>
      <div className={`text-2xl font-bold ${accentMap[accent] ?? 'text-gray-800'}`}>{value}</div>
      <div className="flex items-center justify-between mt-1.5 gap-2">
        {sub && <span className="text-xs text-gray-400">{sub}</span>}
        {change !== undefined && <DeltaBadge change={change ?? null} inverse={inverse} />}
      </div>
    </div>
  )
}

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-base font-bold text-gray-900">{title}</h2>
      {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
    </div>
  )
}

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`bg-white rounded-xl border border-gray-100 shadow-sm p-4 ${className}`}>{children}</div>
}

function EmptyState({ message }: { message: string }) {
  return <div className="flex items-center justify-center py-12 text-gray-400 text-sm">{message}</div>
}

const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string }) => {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-lg px-3 py-2 text-xs">
      <div className="font-semibold text-gray-700 mb-1">{label}</div>
      {payload.map(p => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ background: p.color }} />
          <span className="text-gray-600">{p.name}:</span>
          <span className="font-semibold text-gray-800">{typeof p.value === 'number' ? formatCurrency(p.value) : p.value}</span>
        </div>
      ))}
    </div>
  )
}

// ── Overview Tab ──────────────────────────────────────────────────────────────
function OverviewTab({ period }: { period: number }) {
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

// ── Sales Tab ─────────────────────────────────────────────────────────────────
function SalesTab({ period }: { period: number }) {
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

// ── Inventory Tab ─────────────────────────────────────────────────────────────
function InventoryTab({ period }: { period: number }) {
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
        {/* Value Trend from Count Sessions */}
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

        {/* Category Breakdown */}
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

// ── Purchasing Tab ────────────────────────────────────────────────────────────
function PurchasingTab({ period }: { period: number }) {
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

// ── COGS Tab (preserved existing logic) ───────────────────────────────────────
interface CogsResult {
  startDate: string; endDate: string
  beginningInventory: { value: number; sessionDate: string | null; sessionId: string | null; fallback: boolean }
  purchases: { total: number; invoiceCount: number }
  endingInventory: { value: number; sessionDate: string | null; sessionId: string | null; fallback: boolean }
  cogs: number; foodSales: number; foodCostPct: number
  byCategory: Array<{ category: string; beginningValue: number; endingValue: number; purchases: number; cogs: number }>
}

function CogsTab() {
  const getWeekBounds = () => {
    const today = new Date(), dow = today.getDay()
    const mon = new Date(today); mon.setDate(today.getDate() - ((dow + 6) % 7))
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6)
    return { start: mon.toISOString().split('T')[0], end: sun.toISOString().split('T')[0] }
  }
  const { start: defaultStart, end: defaultEnd } = getWeekBounds()
  const [startDate, setStartDate] = useState(defaultStart)
  const [endDate, setEndDate]     = useState(defaultEnd)
  const [data, setData] = useState<CogsResult | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/reports/cogs?startDate=${startDate}&endDate=${endDate}`)
      setData(await res.json())
    } finally { setLoading(false) }
  }, [startDate, endDate])

  const fcColor = (pct: number) => pct < 28 ? 'text-green-600' : pct < 35 ? 'text-amber-500' : 'text-red-500'

  return (
    <div className="space-y-6">
      {/* Date selector */}
      <Card>
        <SectionHeader title="COGS Calculator" subtitle="Beginning Inventory + Purchases − Ending Inventory" />
        <div className="flex flex-col sm:flex-row items-start sm:items-end gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Start Date</label>
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">End Date</label>
            <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <button onClick={load} disabled={loading}
            className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Calculating…' : 'Calculate COGS'}
          </button>
        </div>
      </Card>

      {data && (
        <>
          {/* Formula Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-center">
            <Card className="text-center">
              <div className="text-xs font-medium text-gray-500 mb-1">Beginning Inventory</div>
              <div className="text-xl font-bold text-gray-800">{formatCurrency(data.beginningInventory.value)}</div>
              {data.beginningInventory.fallback && <div className="text-[10px] text-amber-500 mt-1">⚠ estimated</div>}
              {data.beginningInventory.sessionDate && <div className="text-[10px] text-gray-400 mt-1">{data.beginningInventory.sessionDate}</div>}
            </Card>
            <div className="flex items-center justify-center text-2xl font-light text-gray-400">+</div>
            <Card className="text-center">
              <div className="text-xs font-medium text-gray-500 mb-1">Purchases</div>
              <div className="text-xl font-bold text-gray-800">{formatCurrency(data.purchases.total)}</div>
              <div className="text-[10px] text-gray-400 mt-1">{data.purchases.invoiceCount} invoices</div>
            </Card>
            <div className="hidden sm:flex items-center justify-center text-2xl font-light text-gray-400">−</div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-center">
            <div className="hidden sm:block" />
            <div className="hidden sm:block" />
            <Card className="text-center">
              <div className="text-xs font-medium text-gray-500 mb-1">Ending Inventory</div>
              <div className="text-xl font-bold text-gray-800">{formatCurrency(data.endingInventory.value)}</div>
              {data.endingInventory.fallback && <div className="text-[10px] text-amber-500 mt-1">⚠ estimated</div>}
              {data.endingInventory.sessionDate && <div className="text-[10px] text-gray-400 mt-1">{data.endingInventory.sessionDate}</div>}
            </Card>
            <Card className="text-center border-blue-200 bg-blue-50">
              <div className="text-xs font-semibold text-blue-600 mb-1">= COGS</div>
              <div className="text-2xl font-bold text-blue-700">{formatCurrency(data.cogs)}</div>
              {data.foodSales > 0 && (
                <div className={`text-lg font-bold mt-1 ${fcColor(data.foodCostPct)}`}>{data.foodCostPct.toFixed(1)}% food cost</div>
              )}
            </Card>
          </div>

          {/* Category Breakdown */}
          {data.byCategory?.length > 0 && (
            <Card>
              <SectionHeader title="COGS by Category" />
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left border-b border-gray-100">
                      {['Category','Beginning','Purchases','Ending','COGS'].map(h => (
                        <th key={h} className={`py-2 pr-3 text-xs font-semibold text-gray-500 ${h !== 'Category' ? 'text-right' : ''}`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.byCategory.map(row => (
                      <tr key={row.category} className="border-b border-gray-50 hover:bg-gray-50/60">
                        <td className="py-2.5 pr-3 font-medium text-gray-800">{row.category}</td>
                        <td className="py-2.5 pr-3 text-right text-gray-600">{formatCurrency(row.beginningValue)}</td>
                        <td className="py-2.5 pr-3 text-right text-gray-600">{formatCurrency(row.purchases)}</td>
                        <td className="py-2.5 pr-3 text-right text-gray-600">{formatCurrency(row.endingValue)}</td>
                        <td className="py-2.5 text-right font-semibold text-gray-800">{formatCurrency(row.cogs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  )
}

// ── Loading state ─────────────────────────────────────────────────────────────
function LoadingState() {
  return (
    <div className="space-y-4">
      {[1,2,3].map(i => (
        <div key={i} className="bg-white rounded-xl border border-gray-100 p-4 h-32 animate-pulse">
          <div className="h-3 bg-gray-100 rounded w-1/4 mb-3" />
          <div className="h-6 bg-gray-100 rounded w-1/2 mb-2" />
          <div className="h-3 bg-gray-100 rounded w-1/3" />
        </div>
      ))}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function ReportsPage() {
  const [activeTab, setActiveTab] = useState('overview')
  const [period, setPeriod] = useState(30)

  const currentTab = TABS.find(t => t.id === activeTab)!

  return (
    <div className="space-y-0">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Analytics</h1>
          <p className="text-sm text-gray-500 mt-0.5">Restaurant performance · costs · inventory · purchasing</p>
        </div>

        {/* Period Selector */}
        <div className="flex items-center gap-0.5 border border-gray-200 rounded-lg p-0.5 bg-white shrink-0">
          {PERIOD_OPTIONS.map(opt => (
            <button key={opt.value} onClick={() => setPeriod(opt.value)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                period === opt.value ? 'bg-blue-600 text-white shadow-sm' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
              }`}>
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="flex items-center gap-1 border-b border-gray-200 mb-6 overflow-x-auto">
        {TABS.map(tab => {
          const Icon = tab.icon
          const active = activeTab === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
                active
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-800 hover:border-gray-300'
              }`}
            >
              <Icon size={14} />
              {tab.label}
            </button>
          )
        })}
      </div>

      {/* Tab Content */}
      <div>
        {activeTab === 'overview'   && <OverviewTab  period={period} />}
        {activeTab === 'sales'      && <SalesTab     period={period} />}
        {activeTab === 'inventory'  && <InventoryTab period={period} />}
        {activeTab === 'purchasing' && <PurchasingTab period={period} />}
        {activeTab === 'cogs'       && <CogsTab />}
      </div>
    </div>
  )
}
