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
