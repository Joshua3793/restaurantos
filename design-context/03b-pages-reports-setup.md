# Fergie's OS — Pages — reports, setup, auth

Reports + tabs, setup/admin pages, login & auth.


---

## `src/app/reports/page.tsx`

```tsx
'use client'
import { useState } from 'react'
import dynamic from 'next/dynamic'
import {
  TrendingUp, Package, ShoppingCart, DollarSign, BarChart2, ChefHat,
} from 'lucide-react'
import { LoadingState } from './report-components'

// ── Lazy-loaded tab components (recharts only loads when tab is opened) ─────────
const OverviewTab   = dynamic(() => import('./tabs/OverviewTab'),   { ssr: false, loading: () => <LoadingState /> })
const SalesTab      = dynamic(() => import('./tabs/SalesTab'),      { ssr: false, loading: () => <LoadingState /> })
const InventoryTab  = dynamic(() => import('./tabs/InventoryTab'),  { ssr: false, loading: () => <LoadingState /> })
const PurchasingTab = dynamic(() => import('./tabs/PurchasingTab'), { ssr: false, loading: () => <LoadingState /> })
const CogsTab       = dynamic(() => import('./tabs/CogsTab'),       { ssr: false, loading: () => <LoadingState /> })
const PrepTab       = dynamic(() => import('./tabs/PrepTab'),       { ssr: false, loading: () => <LoadingState /> })

// ── Constants ─────────────────────────────────────────────────────────────────
const PERIOD_OPTIONS = [
  { label: '30 days', value: 30 },
  { label: '90 days', value: 90 },
  { label: '6 months', value: 180 },
]

const TABS = [
  { id: 'overview',   label: 'Overview',   icon: BarChart2 },
  { id: 'sales',      label: 'Sales',      icon: TrendingUp },
  { id: 'inventory',  label: 'Inventory',  icon: Package },
  { id: 'purchasing', label: 'Purchasing', icon: ShoppingCart },
  { id: 'cogs',       label: 'Cost & COGS',icon: DollarSign },
  { id: 'prep',       label: 'Prep',       icon: ChefHat },
]

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function ReportsPage() {
  const [activeTab, setActiveTab] = useState('overview')
  const [period, setPeriod] = useState(30)

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
                period === opt.value ? 'bg-gold text-white shadow-sm' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
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
                  ? 'border-gold text-gold'
                  : 'border-transparent text-gray-500 hover:text-gray-800 hover:border-gray-300'
              }`}
            >
              <Icon size={14} />
              {tab.label}
            </button>
          )
        })}
      </div>

      {/* Tab Content — each tab chunk loads lazily on first click */}
      <div>
        {activeTab === 'overview'   && <OverviewTab   period={period} />}
        {activeTab === 'sales'      && <SalesTab      period={period} />}
        {activeTab === 'inventory'  && <InventoryTab  period={period} />}
        {activeTab === 'purchasing' && <PurchasingTab period={period} />}
        {activeTab === 'cogs'       && <CogsTab />}
        {activeTab === 'prep'       && <PrepTab />}
      </div>
    </div>
  )
}

```


---

## `src/app/reports/report-components.tsx`

```tsx
'use client'
import { ChevronUp, ChevronDown, Minus } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'

export const CAT_COLORS: Record<string, string> = {
  MEAT: '#ef4444', FISH: '#06b6d4', DAIRY: '#3b82f6', PROD: '#22c55e',
  DRY: '#eab308', BREAD: '#f97316', PREPD: '#8b5cf6', CHM: '#94a3b8',
}

export const CHART_COLORS = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#f97316','#ec4899']

export function pct(n: number | null | undefined, decimals = 1) {
  if (n == null) return '—'
  return `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`
}

export function DeltaBadge({ change, inverse = false }: { change: number | null; inverse?: boolean }) {
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

export function KpiCard({ label, value, sub, change, inverse = false, accent = 'blue', icon: Icon }:
  { label: string; value: string; sub?: string; change?: number | null; inverse?: boolean; accent?: string; icon?: React.ElementType }) {
  const accentMap: Record<string, string> = {
    blue: 'text-gold', green: 'text-green-600', amber: 'text-amber-500',
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

export function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-base font-bold text-gray-900">{title}</h2>
      {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
    </div>
  )
}

export function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`bg-white rounded-xl border border-gray-100 shadow-sm p-4 ${className}`}>{children}</div>
}

export function EmptyState({ message }: { message: string }) {
  return <div className="flex items-center justify-center py-12 text-gray-400 text-sm">{message}</div>
}

export const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string }) => {
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

export function LoadingState() {
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

```


---

## `src/app/reports/tabs/OverviewTab.tsx`

```tsx
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

```


---

## `src/app/reports/tabs/SalesTab.tsx`

```tsx
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

```


---

## `src/app/reports/tabs/InventoryTab.tsx`

```tsx
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

```


---

## `src/app/reports/tabs/CogsTab.tsx`

```tsx
'use client'
import { useState, useCallback } from 'react'
import { RefreshCw } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import { SectionHeader, Card, LoadingState } from '../report-components'
import { useRc } from '@/contexts/RevenueCenterContext'
import { rcHex } from '@/lib/rc-colors'

interface CogsResult {
  startDate: string; endDate: string
  beginningInventory: { value: number; sessionDate: string | null; sessionId: string | null; fallback: boolean }
  purchases: { total: number; invoiceCount: number }
  endingInventory: { value: number; sessionDate: string | null; sessionId: string | null; fallback: boolean }
  cogs: number; foodSales: number; foodCostPct: number
  byCategory: Array<{ category: string; beginningValue: number; endingValue: number; purchases: number; cogs: number }>
}

export default function CogsTab() {
  const { activeRcId, activeRc } = useRc()
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
      const params = new URLSearchParams({ startDate, endDate })
      if (activeRcId) {
        params.set('rcId', activeRcId)
        if (activeRc?.isDefault) params.set('isDefault', 'true')
      }
      const res = await fetch(`/api/reports/cogs?${params}`)
      setData(await res.json())
    } finally { setLoading(false) }
  }, [startDate, endDate, activeRcId, activeRc])

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
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">End Date</label>
            <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
          </div>
          <button onClick={load} disabled={loading}
            className="flex items-center gap-2 bg-gold text-white px-4 py-2 rounded-lg text-sm hover:bg-[#a88930] disabled:opacity-50">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Calculating…' : 'Calculate COGS'}
          </button>
          {activeRc && (
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: rcHex(activeRc.color) }} />
              {activeRc.name}
            </div>
          )}
        </div>
      </Card>

      {loading && <LoadingState />}

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
            <Card className="text-center border-gold/30 bg-gold/10">
              <div className="text-xs font-semibold text-gold mb-1">= COGS</div>
              <div className="text-2xl font-bold text-gold">{formatCurrency(data.cogs)}</div>
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

```


---

## `src/app/reports/tabs/PurchasingTab.tsx`

```tsx
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

```


---

## `src/app/reports/tabs/PrepTab.tsx`

```tsx
'use client'
import { useState, useEffect } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { ChefHat, TrendingUp, AlertTriangle, CheckCircle2 } from 'lucide-react'

interface DailySummary {
  date: string
  total: number
  done: number
  partial: number
  blocked: number
  skipped: number
  notStarted: number
  completionRate: number
}
interface TopItem {
  name: string
  category: string
  unit: string
  doneCount: number
  totalQty: number
  avgQty: number
}
interface TopBlocked {
  name: string
  blockedCount: number
  reasons: string[]
}
interface CategoryBreakdown {
  category: string
  total: number
  done: number
  partial: number
  completionRate: number
}
interface PrepReport {
  dailySummaries: DailySummary[]
  topItems: TopItem[]
  topBlocked: TopBlocked[]
  categoryBreakdown: CategoryBreakdown[]
  totals: { total: number; done: number; partial: number; blocked: number; skipped: number; notStarted: number; completionRate: number }
}

const PERIOD_OPTIONS = [
  { label: '7 days',  days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
]

function fmtDate(iso: string) {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function completionColor(rate: number) {
  if (rate >= 80) return '#16a34a'
  if (rate >= 50) return '#d97706'
  return '#dc2626'
}

export default function PrepTab() {
  const [period,  setPeriod]  = useState(30)
  const [report,  setReport]  = useState<PrepReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    const end   = new Date()
    const start = new Date()
    start.setDate(start.getDate() - period + 1)
    const fmt = (d: Date) => d.toISOString().slice(0, 10)
    fetch(`/api/reports/prep?startDate=${fmt(start)}&endDate=${fmt(end)}`)
      .then(r => r.json())
      .then(data => { setReport(data); setLoading(false) })
      .catch(() => { setError('Failed to load prep report'); setLoading(false) })
  }, [period])

  return (
    <div className="space-y-6">
      {/* Header + period selector */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <ChefHat size={18} className="text-gold" />
          <h2 className="text-base font-semibold text-gray-800">Prep Performance</h2>
        </div>
        <div className="flex items-center gap-0.5 border border-gray-200 rounded-lg p-0.5 bg-white">
          {PERIOD_OPTIONS.map(opt => (
            <button key={opt.days} onClick={() => setPeriod(opt.days)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                period === opt.days ? 'bg-gold text-white shadow-sm' : 'text-gray-600 hover:bg-gray-50'
              }`}>
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gold" />
        </div>
      ) : error ? (
        <div className="text-sm text-red-600 text-center py-12">{error}</div>
      ) : !report || report.totals.total === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <ChefHat size={36} className="mx-auto mb-3 opacity-40" />
          <p className="text-sm">No prep data found for this period.</p>
          <p className="text-xs mt-1">Start logging prep in the Today tab to see reports here.</p>
        </div>
      ) : (
        <>
          {/* Overall KPI cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'Total Logged',   value: report.totals.total,          icon: ChefHat,      cls: 'text-gray-800' },
              { label: 'Completed',      value: report.totals.done + report.totals.partial, icon: CheckCircle2, cls: 'text-green-700' },
              { label: 'Blocked',        value: report.totals.blocked,         icon: AlertTriangle,cls: 'text-red-600' },
              { label: 'Completion Rate',value: `${report.totals.completionRate}%`, icon: TrendingUp, cls: report.totals.completionRate >= 80 ? 'text-green-700' : report.totals.completionRate >= 50 ? 'text-amber-700' : 'text-red-600' },
            ].map(({ label, value, icon: Icon, cls }) => (
              <div key={label} className="bg-white border border-gray-100 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-1">
                  <Icon size={14} className="text-gray-400" />
                  <span className="text-xs text-gray-400">{label}</span>
                </div>
                <div className={`text-2xl font-bold ${cls}`}>{value}</div>
              </div>
            ))}
          </div>

          {/* Daily completion rate chart */}
          {report.dailySummaries.length > 1 && (
            <div className="bg-white border border-gray-100 rounded-xl p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-4">Daily Completion Rate</h3>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={report.dailySummaries} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="date" tickFormatter={fmtDate} tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                  <YAxis domain={[0, 100]} tickFormatter={v => `${v}%`} tick={{ fontSize: 11 }} />
                  <Tooltip
                    formatter={(v) => [`${v}%`, 'Completion']}
                    labelFormatter={(l) => fmtDate(String(l))}
                  />
                  <Bar dataKey="completionRate" radius={[3, 3, 0, 0]}>
                    {report.dailySummaries.map((entry, i) => (
                      <Cell key={i} fill={completionColor(entry.completionRate)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Daily volume chart */}
          {report.dailySummaries.length > 1 && (
            <div className="bg-white border border-gray-100 rounded-xl p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-4">Daily Items Logged</h3>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={report.dailySummaries} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="date" tickFormatter={fmtDate} tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip labelFormatter={(l) => fmtDate(String(l))} />
                  <Bar dataKey="done"    name="Done"    stackId="a" fill="#16a34a" radius={[0,0,0,0]} />
                  <Bar dataKey="partial" name="Partial" stackId="a" fill="#d97706" />
                  <Bar dataKey="blocked" name="Blocked" stackId="a" fill="#dc2626" />
                  <Bar dataKey="skipped" name="Skipped" stackId="a" fill="#9ca3af" radius={[3,3,0,0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Top prep items */}
            <div className="bg-white border border-gray-100 rounded-xl p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Most Prepped Items</h3>
              <div className="space-y-2">
                {report.topItems.slice(0, 10).map(item => (
                  <div key={item.name} className="flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-gray-700 truncate">{item.name}</div>
                      <div className="text-xs text-gray-400">{item.category} · avg {item.avgQty.toFixed(1)} {item.unit}</div>
                    </div>
                    <span className="text-sm font-semibold text-gray-600 shrink-0">{item.doneCount}×</span>
                  </div>
                ))}
                {report.topItems.length === 0 && <p className="text-xs text-gray-400">No completed items.</p>}
              </div>
            </div>

            {/* Category breakdown */}
            <div className="bg-white border border-gray-100 rounded-xl p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">By Category</h3>
              <div className="space-y-2">
                {report.categoryBreakdown.map(cat => (
                  <div key={cat.category}>
                    <div className="flex items-center justify-between text-sm mb-0.5">
                      <span className="text-gray-700 truncate">{cat.category}</span>
                      <span className="text-xs font-medium shrink-0 ml-2" style={{ color: completionColor(cat.completionRate) }}>
                        {cat.completionRate}%
                      </span>
                    </div>
                    <div className="w-full bg-gray-100 rounded-full h-1.5">
                      <div
                        className="h-1.5 rounded-full transition-all"
                        style={{ width: `${cat.completionRate}%`, backgroundColor: completionColor(cat.completionRate) }}
                      />
                    </div>
                    <div className="text-xs text-gray-400 mt-0.5">{cat.done + cat.partial}/{cat.total} completed</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Blocked items */}
          {report.topBlocked.length > 0 && (
            <div className="bg-white border border-gray-100 rounded-xl p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                <AlertTriangle size={14} className="text-red-500" /> Frequently Blocked
              </h3>
              <div className="space-y-2">
                {report.topBlocked.map(item => (
                  <div key={item.name} className="flex items-start gap-3 py-2 border-b border-gray-50 last:border-0">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-gray-700">{item.name}</div>
                      {item.reasons.length > 0 && (
                        <div className="text-xs text-gray-400 mt-0.5 truncate">
                          {[...new Set(item.reasons)].slice(0, 2).join(' · ')}
                        </div>
                      )}
                    </div>
                    <span className="text-sm font-semibold text-red-600 shrink-0">{item.blockedCount}×</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

```


---

## `src/app/setup/page.tsx`

```tsx
'use client'
import Link from 'next/link'
import {
  Truck, Building2, MapPin, Tag, Ruler, Users, Bell,
} from 'lucide-react'
import { PageHead } from '@/components/layout/PageHead'

interface Card {
  href: string
  label: string
  icon: React.ComponentType<{ size?: number | string }>
  description: string
  built: boolean
}

const cards: Card[] = [
  { href: '/setup/suppliers',       label: 'Suppliers',        icon: Truck,    description: 'Vendor directory, price history, contact info.',                  built: true },
  { href: '/setup/revenue-centers', label: 'Revenue centers',  icon: Building2,description: 'Profit centers, allocations, food-cost targets.',                 built: true },
  { href: '/setup/storage-areas',   label: 'Storage areas',    icon: MapPin,   description: 'Walk-ins, dry storage, bar. Drives count routing.',               built: true },
  { href: '/setup/categories',      label: 'Categories',       icon: Tag,      description: 'Inventory and recipe categories, accent colors.',                 built: true },
  { href: '/setup/users',           label: 'Users & roles',    icon: Users,    description: 'Invite teammates; ADMIN / MANAGER / STAFF.',                      built: true },
  { href: '/setup/uom',             label: 'UOM & conversions',icon: Ruler,    description: 'Unit-of-measure groups, custom conversions, inspector.',          built: true },
  { href: '/setup/general',         label: 'General',          icon: Bell,     description: 'Email digest schedule, notifications, brand.',                    built: true },
]

export default function SetupPage() {
  return (
    <div>
      <PageHead
        crumbs={<><span>SETUP</span></>}
        title="Setup"
        sub={<>Configure suppliers, storage, categories, and team access — demoted from the daily nav.</>}
      />

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {cards.map(card => (
          <SetupCard key={card.href} {...card} />
        ))}
      </div>
    </div>
  )
}

function SetupCard({ href, label, icon: Icon, description, built }: Card) {
  const inner = (
    <div className="h-full bg-paper border border-line rounded-[12px] p-5 hover:border-ink-3 transition-colors">
      <div className="flex items-center justify-between mb-3">
        <div className="w-9 h-9 rounded-[9px] bg-bg-2 flex items-center justify-center text-ink-2">
          <Icon size={16} />
        </div>
        {!built && (
          <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.04em] bg-bg-2 text-ink-3 px-2 py-0.5 rounded-full">
            Soon
          </span>
        )}
      </div>
      <h3 className="text-[15px] font-semibold tracking-[-0.015em] text-ink mb-1">{label}</h3>
      <p className="text-[12.5px] text-ink-3 leading-snug">{description}</p>
    </div>
  )
  return built
    ? <Link href={href} className="block">{inner}</Link>
    : <div className="block opacity-60 cursor-not-allowed">{inner}</div>
}

```


---

## `src/app/setup/general/page.tsx`

```tsx
'use client'
import { Bell } from 'lucide-react'
import { PageHead } from '@/components/layout/PageHead'

export default function GeneralSettingsPage() {
  return (
    <div>
      <PageHead
        crumbs={<><Bell size={12} /> SETUP / GENERAL</>}
        title="General"
        sub={<>App-wide settings — email digest schedule, notifications, brand.</>}
      />
      <div className="bg-paper border border-line rounded-[12px] p-12 text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3">Coming soon</p>
        <p className="text-[14px] text-ink-2 mt-2 max-w-md mx-auto">
          Email digest configuration, notification preferences, and tenant-level brand
          settings live here. The digest endpoint is already wired
          at <span className="font-mono text-gold-2">/api/digest</span>.
        </p>
      </div>
    </div>
  )
}

```


---

## `src/app/setup/suppliers/page.tsx`

```tsx
'use client'
import { useState, useCallback, useEffect } from 'react'
import dynamic from 'next/dynamic'
import { SupplierList } from '@/components/suppliers/SupplierList'
import { SupplierDetail } from '@/components/suppliers/SupplierDetail'
import { SupplierSummary } from '@/components/suppliers/types'
import { formatCurrency } from '@/lib/utils'
import Link from 'next/link'

// Lazy-load the form modal — only needed when user clicks Add or Edit
const SupplierFormModal = dynamic(
  () => import('@/components/suppliers/SupplierFormModal').then(m => ({ default: m.SupplierFormModal })),
  { ssr: false, loading: () => null }
)

export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<SupplierSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editSupplier, setEditSupplier] = useState<SupplierSummary | null>(null)
  const [showAdd, setShowAdd] = useState(false)

  const fetchSuppliers = useCallback(() => {
    fetch('/api/suppliers').then(r => r.json()).then((data: SupplierSummary[]) => {
      setSuppliers(data)
      // Auto-select first supplier if none selected
      setSelectedId(prev => prev ?? (data[0]?.id ?? null))
    })
  }, [])

  useEffect(() => { fetchSuppliers() }, [fetchSuppliers])

  const selectedSupplier = suppliers.find(s => s.id === selectedId) ?? null

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this supplier? Inventory items will be unlinked.')) return
    await fetch(`/api/suppliers/${id}`, { method: 'DELETE' })
    setSelectedId(prev => (prev === id ? null : prev))
    fetchSuppliers()
  }

  return (
    <>
      {/* Desktop: split panel */}
      <div className="hidden sm:flex h-[calc(100vh-64px)] overflow-hidden">
        <SupplierList
          suppliers={suppliers}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onAdd={() => setShowAdd(true)}
        />
        {selectedId ? (
          <SupplierDetail
            key={selectedId}
            supplierId={selectedId}
            supplier={selectedSupplier}
            onEdit={setEditSupplier}
            onDelete={handleDelete}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-gray-400">
            Select a supplier to view details
          </div>
        )}
      </div>

      {/* Mobile: full-width list only (detail navigates to /suppliers/[id]) */}
      <div className="sm:hidden flex flex-col h-[calc(100vh-64px)]">
        <div className="px-4 pt-3 pb-2 shrink-0 flex items-center justify-between">
          <h1 className="text-xl font-bold text-gray-900">Suppliers</h1>
          <button
            onClick={() => setShowAdd(true)}
            className="bg-gold text-white rounded-lg px-3 py-1.5 text-sm font-semibold hover:bg-[#a88930]"
          >
            + Add
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {[...suppliers]
            .sort((a, b) => b.monthSpend - a.monthSpend)
            .map(s => {
              const pct = s.prevMonthSpend === 0 ? null
                : Math.round(((s.monthSpend - s.prevMonthSpend) / s.prevMonthSpend) * 100)
              const pctColor = pct === null ? 'text-gray-400'
                : pct >= 15 ? 'text-red-500' : pct > 0 ? 'text-green-600' : 'text-gray-500'
              return (
                <Link
                  key={s.id}
                  href={`/suppliers/${s.id}`}
                  className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 bg-white hover:bg-gray-50"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">{s.name}</p>
                    <p className={`text-xs mt-0.5 ${pctColor}`}>
                      {s.monthSpend === 0 ? '$0 this month'
                        : `${formatCurrency(s.monthSpend)} this month${pct !== null ? ` · ${pct >= 0 ? '↑' : '↓'}${Math.abs(pct)}%` : ''}`}
                    </p>
                    <p className="text-xs text-gray-400">{s._count.inventory} items · {s.invoiceCount} invoices</p>
                  </div>
                  <span className="text-gray-300 text-lg">›</span>
                </Link>
              )
            })}
        </div>
      </div>

      {/* Add modal */}
      {showAdd && (
        <SupplierFormModal supplier={null} onClose={() => setShowAdd(false)} onSaved={fetchSuppliers} />
      )}

      {/* Edit modal */}
      {editSupplier && (
        <SupplierFormModal supplier={editSupplier} onClose={() => setEditSupplier(null)} onSaved={fetchSuppliers} />
      )}
    </>
  )
}

```


---

## `src/app/setup/categories/page.tsx`

```tsx
'use client'
import { useEffect, useState } from 'react'
import { Plus, Pencil, Trash2, Check, X, Tag } from 'lucide-react'
import { CATEGORY_COLORS } from '@/lib/utils'

interface Category {
  id: string
  name: string
}

interface CategoryStat extends Category {
  count: number
  totalValue: number
}

export default function CategoriesPage() {
  const [cats, setCats] = useState<CategoryStat[]>([])
  const [newName, setNewName] = useState('')
  const [editId, setEditId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [error, setError] = useState('')

  const fetchCats = async () => {
    const [catsRes, itemsRes] = await Promise.all([
      fetch('/api/categories').then(r => r.json()),
      fetch('/api/inventory').then(r => r.json()),
    ])
    const items: any[] = Array.isArray(itemsRes) ? itemsRes : []
    const statsMap = new Map<string, { count: number; totalValue: number }>()
    for (const item of items) {
      const prev = statsMap.get(item.category) ?? { count: 0, totalValue: 0 }
      statsMap.set(item.category, {
        count: prev.count + 1,
        totalValue: prev.totalValue + parseFloat(item.stockOnHand) * parseFloat(item.pricePerBaseUnit),
      })
    }
    setCats(catsRes.map((c: Category) => ({
      ...c,
      ...(statsMap.get(c.name) ?? { count: 0, totalValue: 0 }),
    })))
  }

  useEffect(() => { fetchCats() }, [])

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!newName.trim()) return
    const res = await fetch('/api/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim() }),
    })
    if (!res.ok) {
      const data = await res.json()
      setError(data.error || 'Failed to add')
      return
    }
    setNewName('')
    fetchCats()
  }

  const handleEdit = async (id: string) => {
    if (!editName.trim()) return
    await fetch(`/api/categories/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: editName.trim() }),
    })
    setEditId(null)
    fetchCats()
  }

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete category "${name}"? Items using it will keep their current category string but it won't appear in this list.`)) return
    await fetch(`/api/categories/${id}`, { method: 'DELETE' })
    fetchCats()
  }

  const totalValue = cats.reduce((s, c) => s + c.totalValue, 0)

  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <h2 className="text-xl font-bold text-gray-900">Categories</h2>
        <p className="text-sm text-gray-500 mt-0.5">Manage inventory categories — these are assigned to items in your inventory</p>
      </div>

      {/* Add form */}
      <form onSubmit={handleAdd} className="flex gap-2">
        <div className="flex-1">
          <input
            value={newName}
            onChange={e => { setNewName(e.target.value); setError('') }}
            placeholder="New category name (e.g. BAKERY)..."
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
          />
          {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
        </div>
        <button type="submit" className="flex items-center gap-2 bg-gold text-white px-3 py-2 rounded-lg text-sm hover:bg-[#a88930] whitespace-nowrap">
          <Plus size={15} /> Add
        </button>
      </form>

      {/* List */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm divide-y divide-gray-50">
        {cats.length === 0 && <div className="text-center py-12 text-gray-400">No categories yet</div>}
        {cats.map(cat => {
          const pct = totalValue > 0 ? (cat.totalValue / totalValue) * 100 : 0
          const colors = CATEGORY_COLORS[cat.name] || 'bg-gray-100 text-gray-700'
          return (
            <div key={cat.id} className="px-4 py-3 flex items-center gap-3">
              <Tag size={14} className="text-gray-300 shrink-0" />

              {editId === cat.id ? (
                <>
                  <input
                    autoFocus
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleEdit(cat.id); if (e.key === 'Escape') setEditId(null) }}
                    className="flex-1 border border-blue-300 rounded px-2 py-1 text-sm focus:outline-none"
                  />
                  <button onClick={() => handleEdit(cat.id)} className="text-green-600 hover:text-green-700 p-1"><Check size={15} /></button>
                  <button onClick={() => setEditId(null)} className="text-gray-400 hover:text-gray-600 p-1"><X size={15} /></button>
                </>
              ) : (
                <>
                  <span className={`inline-flex items-center px-2.5 py-1 rounded text-xs font-semibold w-16 justify-center shrink-0 ${colors}`}>
                    {cat.name}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs text-gray-500">{cat.count} item{cat.count !== 1 ? 's' : ''}</span>
                      <span className="text-xs font-semibold text-gray-700">${cat.totalValue.toFixed(2)}</span>
                    </div>
                    <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full bg-gold/100 rounded-full transition-all" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                  <span className="text-xs text-gray-400 w-9 text-right shrink-0">{pct.toFixed(1)}%</span>
                  <button onClick={() => { setEditId(cat.id); setEditName(cat.name) }} className="text-gray-400 hover:text-gold p-1"><Pencil size={13} /></button>
                  <button onClick={() => handleDelete(cat.id, cat.name)} className="text-gray-400 hover:text-red-500 p-1"><Trash2 size={13} /></button>
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

```


---

## `src/app/setup/storage-areas/page.tsx`

```tsx
'use client'
import { useEffect, useState } from 'react'
import { Plus, Pencil, Trash2, Check, X, MapPin } from 'lucide-react'

interface StorageArea {
  id: string
  name: string
  _count?: { items: number }
}

export default function StorageAreasPage() {
  const [areas, setAreas] = useState<StorageArea[]>([])
  const [newName, setNewName] = useState('')
  const [editId, setEditId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')

  const fetchAreas = () => fetch('/api/storage-areas').then(r => r.json()).then(setAreas)
  useEffect(() => { fetchAreas() }, [])

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newName.trim()) return
    await fetch('/api/storage-areas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newName.trim() }) })
    setNewName('')
    fetchAreas()
  }

  const handleEdit = async (id: string) => {
    if (!editName.trim()) return
    await fetch(`/api/storage-areas/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: editName.trim() }) })
    setEditId(null)
    fetchAreas()
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this storage area? Items will be unlinked.')) return
    await fetch(`/api/storage-areas/${id}`, { method: 'DELETE' })
    fetchAreas()
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <h2 className="text-xl font-bold text-gray-900">Storage Areas</h2>
        <p className="text-sm text-gray-500 mt-0.5">Define where inventory items are physically stored</p>
      </div>

      {/* Add form */}
      <form onSubmit={handleAdd} className="flex gap-2">
        <input
          value={newName}
          onChange={e => setNewName(e.target.value)}
          placeholder="New storage area name..."
          className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
        />
        <button type="submit" className="flex items-center gap-2 bg-gold text-white px-3 py-2 rounded-lg text-sm hover:bg-[#a88930]">
          <Plus size={15} /> Add
        </button>
      </form>

      {/* List */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm divide-y divide-gray-50">
        {areas.length === 0 && <div className="text-center py-12 text-gray-400">No storage areas yet</div>}
        {areas.map(area => (
          <div key={area.id} className="flex items-center gap-3 px-4 py-3">
            <MapPin size={16} className="text-gray-400 shrink-0" />
            {editId === area.id ? (
              <>
                <input
                  autoFocus
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleEdit(area.id); if (e.key === 'Escape') setEditId(null) }}
                  className="flex-1 border border-blue-300 rounded px-2 py-1 text-sm focus:outline-none"
                />
                <button onClick={() => handleEdit(area.id)} className="text-green-600 hover:text-green-700"><Check size={16} /></button>
                <button onClick={() => setEditId(null)} className="text-gray-400 hover:text-gray-600"><X size={16} /></button>
              </>
            ) : (
              <>
                <div className="flex-1">
                  <div className="text-sm font-medium text-gray-800">{area.name}</div>
                  <div className="text-xs text-gray-400">{area._count?.items ?? 0} items</div>
                </div>
                <button onClick={() => { setEditId(area.id); setEditName(area.name) }} className="text-gray-400 hover:text-gold p-1"><Pencil size={14} /></button>
                <button onClick={() => handleDelete(area.id)} className="text-gray-400 hover:text-red-500 p-1"><Trash2 size={14} /></button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

```


---

## `src/app/setup/revenue-centers/page.tsx`

```tsx
'use client'
import { useState } from 'react'
import { Plus, Pencil, Trash2, Star, User, Target, ChevronDown, ChevronUp } from 'lucide-react'
import { RC_COLORS, rcHex } from '@/lib/rc-colors'
import { useRc, RevenueCenter } from '@/contexts/RevenueCenterContext'

const RC_TYPES = [
  { value: 'restaurant', label: 'Restaurant Service' },
  { value: 'catering',   label: 'Catering' },
  { value: 'events',     label: 'Events' },
  { value: 'retail',     label: 'Retail' },
  { value: 'other',      label: 'Other' },
] as const

interface RcFormData {
  name: string
  color: string
  isDefault: boolean
  isActive: boolean
  type: string
  description: string
  managerName: string
  targetFoodCostPct: string
  notes: string
}

const EMPTY_FORM: RcFormData = {
  name: '', color: 'blue', isDefault: false, isActive: true,
  type: 'other', description: '', managerName: '', targetFoodCostPct: '', notes: '',
}

function RcFormModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: RevenueCenter | null
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<RcFormData>(
    initial
      ? {
          name:              initial.name,
          color:             initial.color,
          isDefault:         initial.isDefault,
          isActive:          initial.isActive,
          type:              initial.type || 'other',
          description:       initial.description       ?? '',
          managerName:       initial.managerName       ?? '',
          targetFoodCostPct: initial.targetFoodCostPct != null ? String(parseFloat(initial.targetFoodCostPct)) : '',
          notes:             initial.notes             ?? '',
        }
      : EMPTY_FORM
  )
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim()) { setError('Name is required'); return }
    setSaving(true)
    const payload = {
      ...form,
      targetFoodCostPct: form.targetFoodCostPct !== '' ? parseFloat(form.targetFoodCostPct) : null,
      description:  form.description  || null,
      managerName:  form.managerName  || null,
      notes:        form.notes        || null,
    }
    const res = await fetch(
      initial ? `/api/revenue-centers/${initial.id}` : '/api/revenue-centers',
      { method: initial ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
    )
    setSaving(false)
    if (!res.ok) { const d = await res.json(); setError(d.error || 'Failed'); return }
    onSaved()
    onClose()
  }

  const f = (key: keyof RcFormData, val: string | boolean) =>
    setForm(prev => ({ ...prev, [key]: val }))

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-50" onClick={onClose} />
      <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4">
        <div className="bg-white w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl shadow-xl max-h-[90vh] overflow-y-auto">
          <div className="sticky top-0 bg-white px-5 pt-5 pb-3 border-b border-gray-100">
            <h3 className="font-semibold text-gray-900">
              {initial ? 'Edit Revenue Center' : 'New Revenue Center'}
            </h3>
          </div>

          <form onSubmit={handleSubmit} className="p-5 space-y-4">
            {/* Name */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Name *</label>
              <input
                autoFocus
                value={form.name}
                onChange={e => f('name', e.target.value)}
                placeholder="e.g. Catering, Events..."
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
              />
            </div>

            {/* Type */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Type</label>
              <select
                value={form.type}
                onChange={e => f('type', e.target.value)}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gold"
              >
                {RC_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>

            {/* Color */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-2">Color</label>
              <div className="grid grid-cols-8 gap-2">
                {RC_COLORS.map(c => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => f('color', c)}
                    className={`w-7 h-7 rounded-full transition-transform ${form.color === c ? 'ring-2 ring-offset-2 ring-gray-400 scale-110' : ''}`}
                    style={{ backgroundColor: rcHex(c) }}
                  />
                ))}
              </div>
            </div>

            {/* Description */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Description</label>
              <input
                value={form.description}
                onChange={e => f('description', e.target.value)}
                placeholder="What does this revenue center handle?"
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
              />
            </div>

            {/* Manager + Target food cost */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Manager</label>
                <input
                  value={form.managerName}
                  onChange={e => f('managerName', e.target.value)}
                  placeholder="Name"
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Target Food Cost %</label>
                <div className="relative">
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.1"
                    value={form.targetFoodCostPct}
                    onChange={e => f('targetFoodCostPct', e.target.value)}
                    placeholder="e.g. 28"
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 pr-7 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">%</span>
                </div>
              </div>
            </div>

            {/* Notes */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Notes</label>
              <textarea
                value={form.notes}
                onChange={e => f('notes', e.target.value)}
                placeholder="Any internal notes..."
                rows={2}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold resize-none"
              />
            </div>

            {/* Toggles */}
            <div className="flex flex-col gap-2 pt-1">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.isDefault}
                  onChange={e => f('isDefault', e.target.checked)}
                  className="rounded border-gray-300"
                />
                <span className="text-sm text-gray-700">Set as default revenue center</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={e => f('isActive', e.target.checked)}
                  className="rounded border-gray-300"
                />
                <span className="text-sm text-gray-700">Active</span>
              </label>
            </div>

            {error && <p className="text-xs text-red-500">{error}</p>}

            <div className="flex gap-2 pt-1 pb-[env(safe-area-inset-bottom)]">
              <button
                type="submit"
                disabled={saving}
                className="flex-1 py-2.5 bg-gray-900 text-white text-sm font-medium rounded-xl hover:bg-gray-800 disabled:opacity-50"
              >
                {saving ? 'Saving…' : initial ? 'Save Changes' : 'Create'}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 border border-gray-200 rounded-xl text-sm text-gray-600 hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  )
}

function RcCard({ rc, onEdit, onDelete }: { rc: RevenueCenter; onEdit: () => void; onDelete: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const typeLabel = RC_TYPES.find(t => t.value === rc.type)?.label ?? rc.type
  const hasDetails = rc.description || rc.managerName || rc.targetFoodCostPct || rc.notes

  return (
    <div className={`bg-white border rounded-2xl overflow-hidden transition-all ${rc.isActive ? 'border-gray-100' : 'border-gray-200 opacity-60'}`}>
      {/* Color accent bar */}
      <div className="h-1.5" style={{ backgroundColor: rcHex(rc.color) }} />

      <div className="p-4">
        <div className="flex items-start gap-3">
          <span className="w-10 h-10 rounded-xl shrink-0 flex items-center justify-center text-white font-bold text-lg"
            style={{ backgroundColor: rcHex(rc.color) }}>
            {rc.name[0].toUpperCase()}
          </span>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold text-gray-900">{rc.name}</h3>
              {rc.isDefault && (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded-full">
                  <Star size={9} /> Default
                </span>
              )}
              {!rc.isActive && (
                <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded-full">
                  Inactive
                </span>
              )}
              <span className="text-[10px] font-medium text-gray-400 bg-gray-50 px-1.5 py-0.5 rounded-full border border-gray-100">
                {typeLabel}
              </span>
            </div>

            {rc.description && (
              <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{rc.description}</p>
            )}

            {/* Key info row */}
            <div className="flex flex-wrap gap-3 mt-2">
              {rc.managerName && (
                <span className="flex items-center gap-1 text-xs text-gray-500">
                  <User size={11} /> {rc.managerName}
                </span>
              )}
              {rc.targetFoodCostPct != null && (
                <span className="flex items-center gap-1 text-xs text-gray-500">
                  <Target size={11} /> {parseFloat(rc.targetFoodCostPct)}% food cost target
                </span>
              )}
            </div>

            {rc.notes && (
              <div className="mt-2">
                {expanded ? (
                  <p className="text-xs text-gray-400 leading-relaxed">{rc.notes}</p>
                ) : null}
                <button
                  onClick={() => setExpanded(e => !e)}
                  className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-600 mt-1"
                >
                  {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                  {expanded ? 'Hide notes' : 'Show notes'}
                </button>
              </div>
            )}
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={onEdit}
              className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
              title="Edit"
            >
              <Pencil size={14} />
            </button>
            <button
              onClick={onDelete}
              className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
              title="Delete"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function RevenueCentersPage() {
  const { revenueCenters, reload } = useRc()
  const [editTarget, setEditTarget] = useState<RevenueCenter | null>(null)
  const [showForm, setShowForm]     = useState(false)
  const [deleteError, setDeleteError] = useState('')

  const handleDelete = async (rc: RevenueCenter) => {
    if (!confirm(`Delete "${rc.name}"?`)) return
    const res = await fetch(`/api/revenue-centers/${rc.id}`, { method: 'DELETE' })
    if (!res.ok) { const d = await res.json(); setDeleteError(d.error || 'Failed to delete'); return }
    setDeleteError('')
    reload()
  }

  const openAdd  = () => { setEditTarget(null); setShowForm(true) }
  const openEdit = (rc: RevenueCenter) => { setEditTarget(rc); setShowForm(true) }

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Revenue Centers</h1>
          <p className="text-sm text-gray-500 mt-0.5">{revenueCenters.length} center{revenueCenters.length !== 1 ? 's' : ''}</p>
        </div>
        <button
          onClick={openAdd}
          className="flex items-center gap-1.5 bg-gold text-white px-3 py-2 rounded-xl text-sm font-semibold hover:bg-[#a88930]"
        >
          <Plus size={16} /> Add
        </button>
      </div>

      {deleteError && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          {deleteError}
        </div>
      )}

      <div className="space-y-3">
        {revenueCenters.map(rc => (
          <RcCard
            key={rc.id}
            rc={rc}
            onEdit={() => openEdit(rc)}
            onDelete={() => handleDelete(rc)}
          />
        ))}
      </div>

      {showForm && (
        <RcFormModal
          initial={editTarget}
          onClose={() => setShowForm(false)}
          onSaved={reload}
        />
      )}
    </div>
  )
}

```


---

## `src/app/setup/users/page.tsx`

```tsx
'use client'
import { useState, useEffect, useCallback } from 'react'
import { Users, Send, AlertCircle, CheckCircle, Trash2 } from 'lucide-react'
import { useUser } from '@/contexts/UserContext'

type UserRole = 'ADMIN' | 'MANAGER' | 'STAFF'

interface TeamUser {
  id: string
  email: string
  name: string | null
  role: UserRole
  isActive: boolean
  createdAt: string
}

const ROLE_LABELS: Record<UserRole, string> = {
  ADMIN: 'Admin',
  MANAGER: 'Manager',
  STAFF: 'Staff',
}

const ROLE_COLORS: Record<UserRole, string> = {
  ADMIN: 'bg-purple-100 text-purple-700',
  MANAGER: 'bg-gold/15 text-gold',
  STAFF: 'bg-gray-100 text-gray-600',
}

export default function UsersSettingsPage() {
  const { user: currentUser } = useUser()
  const [users, setUsers] = useState<TeamUser[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Invite form state
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<UserRole>('STAFF')
  const [inviteName, setInviteName] = useState('')
  const [inviting, setInviting] = useState(false)
  const [inviteResult, setInviteResult] = useState<{ ok: boolean; message: string } | null>(null)

  const loadUsers = useCallback(async () => {
    setLoadError(null)
    try {
      const res = await fetch('/api/settings/users')
      if (!res.ok) throw new Error(`Failed to load users (${res.status})`)
      setUsers(await res.json())
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load users')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadUsers() }, [loadUsers])

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault()
    setInviting(true)
    setInviteResult(null)
    try {
      const res = await fetch('/api/settings/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail, role: inviteRole, name: inviteName || undefined }),
      })
      const data = await res.json()
      if (res.ok) {
        setInviteResult({ ok: true, message: `Invite sent to ${inviteEmail}` })
        setInviteEmail('')
        setInviteName('')
        setInviteRole('STAFF')
        await loadUsers()
      } else {
        setInviteResult({ ok: false, message: data.error ?? 'Failed to send invite' })
      }
    } catch {
      setInviteResult({ ok: false, message: 'Network error' })
    } finally {
      setInviting(false)
    }
  }

  const handleRoleChange = async (userId: string, newRole: UserRole) => {
    const res = await fetch(`/api/settings/users/${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: newRole }),
    })
    if (res.ok) {
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, role: newRole } : u))
    } else {
      // Reload to get accurate state from server
      loadUsers()
    }
  }

  const handleDeactivate = async (userId: string) => {
    if (!confirm('Deactivate this user? They will be signed out immediately.')) return
    const res = await fetch(`/api/settings/users/${userId}`, { method: 'DELETE' })
    if (res.ok) {
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, isActive: false } : u))
    } else {
      loadUsers()
    }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Page header — desktop only */}
      <div className="hidden md:block border-b border-gray-100 pb-4">
        <h2 className="text-lg font-semibold text-gray-900">Team</h2>
        <p className="text-sm text-gray-500 mt-0.5">Manage users and invite new team members</p>
      </div>

      {/* Invite card */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-50">
          <div className="w-8 h-8 bg-gold/15 rounded-lg flex items-center justify-center shrink-0">
            <Send size={15} className="text-gold" />
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-900">Invite a Team Member</p>
            <p className="text-xs text-gray-400">They'll receive an email to set up their account</p>
          </div>
        </div>

        <form onSubmit={handleInvite} className="px-5 py-4 space-y-3">
          <div className="flex gap-2">
            <label htmlFor="invite-name" className="sr-only">Name (optional)</label>
            <input
              id="invite-name"
              type="text"
              value={inviteName}
              onChange={e => setInviteName(e.target.value)}
              placeholder="Name (optional)"
              className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
            />
          </div>
          <div className="flex gap-2">
            <label htmlFor="invite-email" className="sr-only">Email address</label>
            <input
              id="invite-email"
              type="email"
              value={inviteEmail}
              onChange={e => setInviteEmail(e.target.value)}
              placeholder="Email address"
              required
              className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
            />
            <label htmlFor="invite-role" className="sr-only">Role</label>
            <select
              id="invite-role"
              value={inviteRole}
              onChange={e => setInviteRole(e.target.value as UserRole)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold bg-white"
            >
              <option value="STAFF">Staff</option>
              <option value="MANAGER">Manager</option>
              <option value="ADMIN">Admin</option>
            </select>
            <button
              type="submit"
              disabled={inviting}
              className="flex items-center gap-2 bg-gold text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#a88930] disabled:opacity-50 whitespace-nowrap transition-colors"
            >
              <Send size={13} />
              {inviting ? 'Sending…' : 'Send Invite'}
            </button>
          </div>
          {inviteResult && (
            <div className={`flex items-center gap-2 p-2.5 rounded-lg text-xs ${inviteResult.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
              {inviteResult.ok ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
              {inviteResult.message}
            </div>
          )}
        </form>
      </div>

      {/* Team list */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-50">
          <div className="w-8 h-8 bg-gray-100 rounded-lg flex items-center justify-center shrink-0">
            <Users size={15} className="text-gray-600" />
          </div>
          <p className="text-sm font-semibold text-gray-900">Team Members</p>
        </div>

        {loading ? (
          <div className="px-5 py-8 text-sm text-gray-400 text-center">Loading…</div>
        ) : loadError ? (
          <div className="px-5 py-8 text-sm text-red-500 text-center">{loadError}</div>
        ) : users.length === 0 ? (
          <div className="px-5 py-8 text-sm text-gray-400 text-center">No team members yet</div>
        ) : (
          <div className="divide-y divide-gray-50">
            {users.map(u => {
              const isMe = u.id === currentUser?.id
              return (
                <div key={u.id} className={`flex items-center gap-3 px-5 py-3.5 ${!u.isActive ? 'opacity-50' : ''}`}>
                  {/* Avatar */}
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center shrink-0">
                    <span className="text-white text-xs font-semibold">
                      {(u.name ?? u.email)[0].toUpperCase()}
                    </span>
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p className="text-sm font-medium text-gray-900 truncate">
                        {u.name ?? u.email}
                      </p>
                      {isMe && (
                        <span className="text-[10px] font-semibold bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded-full">
                          You
                        </span>
                      )}
                      {!u.isActive && (
                        <span className="text-[10px] font-semibold bg-red-100 text-red-500 px-1.5 py-0.5 rounded-full">
                          Inactive
                        </span>
                      )}
                      {/* Pending: isActive but no name — user invited but hasn't set a display name yet.
                          Note: this heuristic cannot distinguish "never accepted invite" from
                          "accepted but skipped name". A dedicated status field would be more precise. */}
                      {u.isActive && !u.name && (
                        <span className="text-[10px] font-semibold bg-amber-100 text-amber-600 px-1.5 py-0.5 rounded-full">
                          Pending
                        </span>
                      )}
                    </div>
                    {u.name && (
                      <p className="text-xs text-gray-400 truncate">{u.email}</p>
                    )}
                  </div>

                  {/* Role badge / selector */}
                  {isMe ? (
                    <span className={`text-xs font-medium px-2 py-1 rounded-full ${ROLE_COLORS[u.role]}`}>
                      {ROLE_LABELS[u.role]}
                    </span>
                  ) : (
                    <select
                      value={u.role}
                      onChange={e => handleRoleChange(u.id, e.target.value as UserRole)}
                      disabled={!u.isActive}
                      className={`text-xs font-medium px-2 py-1 rounded-full border-0 cursor-pointer focus:outline-none focus:ring-2 focus:ring-gold ${ROLE_COLORS[u.role]} disabled:cursor-default`}
                    >
                      <option value="STAFF">Staff</option>
                      <option value="MANAGER">Manager</option>
                      <option value="ADMIN">Admin</option>
                    </select>
                  )}

                  {/* Deactivate button */}
                  {!isMe && u.isActive && (
                    <button
                      onClick={() => handleDeactivate(u.id)}
                      title="Deactivate user"
                      className="p-1.5 rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50 transition-all"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

```


---

## `src/app/setup/uom/page.tsx`

```tsx
'use client'
import { Ruler, ArrowRight } from 'lucide-react'
import { PageHead } from '@/components/layout/PageHead'
import { UOM_GROUPS } from '@/lib/uom'

export default function UomPage() {
  return (
    <div>
      <PageHead
        crumbs={<><Ruler size={12} /> SETUP / UOM &amp; CONVERSIONS</>}
        title="UOM & conversions"
        sub={<>Unit-of-measure groups the app uses to convert between purchase, recipe, and count units.</>}
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {UOM_GROUPS.map(group => (
          <section key={group.label} className="bg-paper border border-line rounded-[12px] overflow-hidden">
            <header className="px-[18px] py-3 border-b border-line bg-bg-2">
              <h2 className="text-[15px] font-semibold tracking-[-0.015em]">{group.label}</h2>
              <p className="font-mono text-[10.5px] text-ink-3 mt-0.5">{group.units.length} units</p>
            </header>
            <div className="divide-y divide-line">
              {group.units.map(u => {
                const isBase = u.toBase === 1
                return (
                  <div key={u.label} className="grid grid-cols-[1fr_auto_auto] gap-3 items-center px-[18px] py-2.5">
                    <div>
                      <div className="text-[13px] text-ink font-medium tracking-[-0.005em]">{u.label}</div>
                      {isBase && <div className="font-mono text-[10px] uppercase tracking-[0.04em] text-gold-2 mt-0.5">Base unit</div>}
                    </div>
                    <div className="font-mono text-[11px] text-ink-3 inline-flex items-center gap-1">
                      <span>1 {u.label}</span>
                      <ArrowRight size={10} />
                    </div>
                    <div className="font-mono text-[12px] text-ink font-medium tabular-nums">{u.toBase.toLocaleString(undefined, { maximumFractionDigits: 4 })} {group.units[0].label}</div>
                  </div>
                )
              })}
            </div>
          </section>
        ))}
      </div>

      <div className="mt-5 bg-paper border border-line rounded-[12px] p-5">
        <h3 className="text-[13px] font-semibold tracking-[-0.01em] mb-2">Conversion inspector</h3>
        <p className="text-[13px] text-ink-2 leading-[1.5] tracking-[-0.005em]">
          The conversion factor is always relative to the group&apos;s base unit (gram, milliliter, or each).
          Recipe costing reads <span className="font-mono text-gold-2">pricePerBaseUnit</span> from the inventory ledger,
          then multiplies by the unit&apos;s factor — so a recipe calling for 250 ml of olive oil at
          $0.012/ml costs $3.00, while the same oil bought by the case (4 × 3 L) was stored once at the base price.
          Adding a unit needs a code change today; a UI for custom conversions is on the roadmap.
        </p>
      </div>
    </div>
  )
}

```


---

## `src/app/login/page.tsx`

```tsx
'use client'
import { useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Image from 'next/image'
import { createClient } from '@/lib/supabase/client'

function LoginPageInner() {
  const [mode, setMode] = useState<'login' | 'forgot'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()
  const searchParams = useSearchParams()
  const urlError = searchParams.get('error')

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    const supabase = createClient()
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      setError(error.message)
      setLoading(false)
    } else {
      router.push('/')
    }
  }

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    const supabase = createClient()
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/auth/set-password`,
    })
    setLoading(false)
    if (error) {
      setError(error.message)
    } else {
      setMessage('Check your email for a password reset link.')
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4"
      style={{ background: '#0a0a0a' }}>

      {/* Subtle radial glow behind card */}
      <div className="absolute inset-0 pointer-events-none"
        style={{ background: 'radial-gradient(ellipse 60% 50% at 50% 40%, rgba(201,168,76,0.07) 0%, transparent 70%)' }} />

      <div className="relative w-full max-w-sm">
        {/* Logo mark */}
        <div className="flex flex-col items-center mb-8">
          <Image src="/logo-icon.png" alt="Controla OS" width={56} height={56}
            className="rounded-2xl mb-4" />
          <h1 className="text-xl font-bold tracking-wide" style={{ color: '#c9a84c' }}>
            Controla OS
          </h1>
          <p className="text-xs mt-1" style={{ color: 'rgba(255,255,255,0.3)' }}>
            Fergie&apos;s Kitchen
          </p>
        </div>

        {/* Card */}
        <div className="rounded-2xl p-7"
          style={{ background: '#161616', border: '1px solid rgba(255,255,255,0.08)' }}>

          {mode === 'login' ? (
            <form onSubmit={handleLogin} className="space-y-4">
              {urlError === 'invalid_link' && (
                <div className="rounded-lg px-3 py-2 text-xs"
                  style={{ background: 'rgba(217,119,6,0.12)', border: '1px solid rgba(217,119,6,0.25)', color: '#fbbf24' }}>
                  This link has expired or is invalid. Please request a new invite.
                </div>
              )}
              {urlError === 'deactivated' && (
                <div className="rounded-lg px-3 py-2 text-xs"
                  style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.25)', color: '#f87171' }}>
                  Your account has been deactivated. Please contact your admin.
                </div>
              )}
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-widest mb-1.5"
                  style={{ color: 'rgba(255,255,255,0.35)' }}>
                  Email
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  className="w-full px-3 py-2.5 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-gold transition-colors"
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-widest mb-1.5"
                  style={{ color: 'rgba(255,255,255,0.35)' }}>
                  Password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  className="w-full px-3 py-2.5 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-gold transition-colors"
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                />
              </div>
              {error && <p className="text-xs" style={{ color: '#f87171' }}>{error}</p>}
              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 rounded-lg text-sm font-semibold disabled:opacity-50 transition-all mt-2"
                style={{ background: '#c9a84c', color: '#0a0a0a' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#a88930')}
                onMouseLeave={e => (e.currentTarget.style.background = '#c9a84c')}
              >
                {loading ? 'Signing in…' : 'Sign in'}
              </button>
              <button
                type="button"
                onClick={() => { setMode('forgot'); setError('') }}
                className="w-full text-xs text-center pt-1 transition-colors"
                style={{ color: 'rgba(255,255,255,0.3)' }}
                onMouseEnter={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.6)')}
                onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.3)')}
              >
                Forgot password?
              </button>
            </form>
          ) : (
            <form onSubmit={handleForgot} className="space-y-4">
              <p className="text-sm" style={{ color: 'rgba(255,255,255,0.5)' }}>
                Enter your email and we&apos;ll send a password reset link.
              </p>
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-widest mb-1.5"
                  style={{ color: 'rgba(255,255,255,0.35)' }}>
                  Email
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="w-full px-3 py-2.5 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-gold transition-colors"
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                />
              </div>
              {error && <p className="text-xs" style={{ color: '#f87171' }}>{error}</p>}
              {message && <p className="text-xs" style={{ color: '#4ade80' }}>{message}</p>}
              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 rounded-lg text-sm font-semibold disabled:opacity-50 transition-all mt-2"
                style={{ background: '#c9a84c', color: '#0a0a0a' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#a88930')}
                onMouseLeave={e => (e.currentTarget.style.background = '#c9a84c')}
              >
                {loading ? 'Sending…' : 'Send reset link'}
              </button>
              <button
                type="button"
                onClick={() => { setMode('login'); setError(''); setMessage('') }}
                className="w-full text-xs text-center pt-1 transition-colors"
                style={{ color: 'rgba(255,255,255,0.3)' }}
                onMouseEnter={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.6)')}
                onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.3)')}
              >
                Back to sign in
              </button>
            </form>
          )}
        </div>

        <p className="text-xs text-center mt-5" style={{ color: 'rgba(255,255,255,0.2)' }}>
          Don&apos;t have an account? Ask your admin for an invite.
        </p>
      </div>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginPageInner />
    </Suspense>
  )
}

```


---

## `src/app/auth/set-password/page.tsx`

```tsx
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { ChefHat, CheckCircle } from 'lucide-react'

export default function SetPasswordPage() {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }
    setLoading(true)
    setError('')
    const supabase = createClient()
    const { error } = await supabase.auth.updateUser({ password })
    setLoading(false)
    if (error) {
      setError(error.message)
    } else {
      setDone(true)
      setTimeout(() => router.push('/'), 1500)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 w-full max-w-sm">
        <div className="flex items-center gap-2 mb-8">
          <div className="w-9 h-9 bg-gold rounded-xl flex items-center justify-center">
            <ChefHat size={18} className="text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-gray-900 leading-tight">Set your password</h1>
            <p className="text-xs text-gray-400">Choose a password to secure your account</p>
          </div>
        </div>

        {done ? (
          <div className="flex items-center gap-2 text-green-600 text-sm">
            <CheckCircle size={16} />
            Password set! Redirecting\u2026
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
                New Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
                Confirm Password
              </label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                autoComplete="new-password"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
              />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-gold text-white py-2 rounded-lg text-sm font-medium hover:bg-[#a88930] disabled:opacity-50 transition-colors"
            >
              {loading ? 'Saving\u2026' : 'Set password'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

```
