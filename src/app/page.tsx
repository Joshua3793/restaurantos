'use client'
import { useEffect, useState } from 'react'
import { formatCurrency } from '@/lib/utils'
import { CategoryBadge } from '@/components/CategoryBadge'
import { TrendingUp, Package, AlertTriangle, DollarSign, FileText, Trash2 } from 'lucide-react'

interface DashboardData {
  totalInventoryValue: number
  weeklyWastageCost: number
  monthlyWastageCost: number
  lowStockCount: number
  topExpensiveItems: Array<{
    id: string
    itemName: string
    category: string
    pricePerBaseUnit: number
    baseUnit: string
  }>
  recentInvoices: Array<{
    id: string
    invoiceNumber: string
    supplier: { name: string }
    invoiceDate: string
    totalAmount: number
    status: string
  }>
  weeklyRevenue: number
  estimatedFoodCostPct: number
  inventoryCount: number
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null)

  useEffect(() => {
    fetch('/api/reports/dashboard').then(r => r.json()).then(setData)
  }, [])

  if (!data) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-sm text-gray-500 mt-1">Fergie&apos;s Kitchen Overview</p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 col-span-2 md:col-span-1">
          <div className="flex items-center gap-2 text-blue-600 mb-2">
            <DollarSign size={18} />
            <span className="text-xs font-medium text-gray-500">Inventory Value</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">{formatCurrency(data.totalInventoryValue)}</div>
          <div className="text-xs text-gray-400 mt-1">{data.inventoryCount} items tracked</div>
        </div>

        <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
          <div className="flex items-center gap-2 text-green-600 mb-2">
            <TrendingUp size={18} />
            <span className="text-xs font-medium text-gray-500">Weekly Revenue</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">{formatCurrency(data.weeklyRevenue)}</div>
          <div className="text-xs text-gray-400 mt-1">Last 7 days</div>
        </div>

        <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
          <div className="flex items-center gap-2 text-red-500 mb-2">
            <Trash2 size={18} />
            <span className="text-xs font-medium text-gray-500">Wastage (Week)</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">{formatCurrency(data.weeklyWastageCost)}</div>
          <div className="text-xs text-gray-400 mt-1">{formatCurrency(data.monthlyWastageCost)} this month</div>
        </div>

        <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
          <div className="flex items-center gap-2 text-purple-600 mb-2">
            <TrendingUp size={18} />
            <span className="text-xs font-medium text-gray-500">Food Cost %</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">{data.estimatedFoodCostPct.toFixed(1)}%</div>
          <div className="text-xs text-gray-400 mt-1">Wastage / food sales</div>
        </div>

        <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
          <div className="flex items-center gap-2 text-amber-500 mb-2">
            <AlertTriangle size={18} />
            <span className="text-xs font-medium text-gray-500">Low Stock</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">{data.lowStockCount} items</div>
          <div className="text-xs text-gray-400 mt-1">Below threshold</div>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        {/* Top expensive items */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100">
          <div className="p-4 border-b border-gray-100 flex items-center gap-2">
            <Package size={18} className="text-gray-500" />
            <h2 className="font-semibold text-gray-900">Top 10 Most Expensive Ingredients</h2>
          </div>
          <div className="divide-y divide-gray-50">
            {data.topExpensiveItems.map((item, i) => (
              <div key={item.id} className="px-4 py-2.5 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs text-gray-400 w-4">{i + 1}</span>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-gray-800 truncate">{item.itemName}</div>
                    <CategoryBadge category={item.category} />
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-sm font-semibold text-gray-900">
                    {formatCurrency(parseFloat(String(item.pricePerBaseUnit)))}
                    <span className="text-xs text-gray-400"> /{item.baseUnit}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Recent Invoices */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100">
          <div className="p-4 border-b border-gray-100 flex items-center gap-2">
            <FileText size={18} className="text-gray-500" />
            <h2 className="font-semibold text-gray-900">Recent Invoices</h2>
          </div>
          <div className="divide-y divide-gray-50">
            {data.recentInvoices.map(inv => (
              <div key={inv.id} className="px-4 py-3 flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-medium text-gray-800">{inv.invoiceNumber}</div>
                  <div className="text-xs text-gray-500">
                    {inv.supplier.name} &middot; {new Date(inv.invoiceDate).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-semibold">{formatCurrency(parseFloat(String(inv.totalAmount)))}</div>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    inv.status === 'COMPLETE' ? 'bg-green-100 text-green-700' :
                    inv.status === 'PROCESSING' ? 'bg-blue-100 text-blue-700' :
                    'bg-amber-100 text-amber-700'
                  }`}>
                    {inv.status}
                  </span>
                </div>
              </div>
            ))}
            {data.recentInvoices.length === 0 && (
              <div className="px-4 py-8 text-center text-gray-400 text-sm">No invoices yet</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
