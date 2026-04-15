'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { formatCurrency } from '@/lib/utils'
import { CategoryBadge } from '@/components/CategoryBadge'
import {
  TrendingUp, Package, AlertTriangle, DollarSign,
  FileText, Trash2, ChefHat, ShoppingCart, ArrowRight,
  BarChart3,
} from 'lucide-react'

interface DashboardData {
  totalInventoryValue: number
  weeklyWastageCost: number
  monthlyWastageCost: number
  outOfStockCount: number
  outOfStockItems: Array<{ id: string; itemName: string; category: string }>
  topExpensiveItems: Array<{
    id: string
    itemName: string
    category: string
    pricePerBaseUnit: number
    purchasePrice: number
    baseUnit: string
    inventoryValue: number
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
  weeklyFoodSales: number
  weeklyPurchaseCost: number
  estimatedFoodCostPct: number
  foodCostLabel: string
  inventoryCount: number
}

interface HighCostRecipe {
  id: string
  name: string
  foodCostPct: number | null
  menuPrice: number | null
  totalCost: number
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [highCostRecipes, setHighCostRecipes] = useState<HighCostRecipe[]>([])

  useEffect(() => {
    fetch('/api/reports/dashboard').then(r => r.json()).then(setData)
    fetch('/api/recipes?type=MENU&isActive=true').then(r => r.json()).then((recipes: Array<{ id: string; name: string; menuPrice: number | null; totalCost: number; foodCostPct: number | null }>) => {
      if (!Array.isArray(recipes)) return
      const high = recipes
        .filter(r => r.menuPrice && r.foodCostPct !== null && r.foodCostPct > 35)
        .sort((a, b) => (b.foodCostPct ?? 0) - (a.foodCostPct ?? 0))
        .slice(0, 5)
      setHighCostRecipes(high)
    })
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

      {/* KPI Cards — every card is a link */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <Link href="/inventory"
          className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 col-span-2 md:col-span-1 hover:border-blue-200 hover:shadow-md transition-all group">
          <div className="flex items-center gap-2 text-blue-600 mb-2">
            <DollarSign size={18} />
            <span className="text-xs font-medium text-gray-500">Inventory Value</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">{formatCurrency(data.totalInventoryValue)}</div>
          <div className="text-xs text-gray-400 mt-1 flex items-center justify-between">
            <span>{data.inventoryCount} items tracked</span>
            <ArrowRight size={12} className="opacity-0 group-hover:opacity-100 text-blue-400 transition-opacity" />
          </div>
        </Link>

        <Link href="/sales"
          className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 hover:border-green-200 hover:shadow-md transition-all group">
          <div className="flex items-center gap-2 text-green-600 mb-2">
            <TrendingUp size={18} />
            <span className="text-xs font-medium text-gray-500">Weekly Revenue</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">{formatCurrency(data.weeklyRevenue)}</div>
          <div className="text-xs text-gray-400 mt-1 flex items-center justify-between">
            <span>Last 7 days</span>
            <ArrowRight size={12} className="opacity-0 group-hover:opacity-100 text-green-400 transition-opacity" />
          </div>
        </Link>

        <Link href="/wastage"
          className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 hover:border-red-200 hover:shadow-md transition-all group">
          <div className="flex items-center gap-2 text-red-500 mb-2">
            <Trash2 size={18} />
            <span className="text-xs font-medium text-gray-500">Wastage (Week)</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">{formatCurrency(data.weeklyWastageCost)}</div>
          <div className="text-xs text-gray-400 mt-1 flex items-center justify-between">
            <span>{formatCurrency(data.monthlyWastageCost)} this month</span>
            <ArrowRight size={12} className="opacity-0 group-hover:opacity-100 text-red-400 transition-opacity" />
          </div>
        </Link>

        <Link href="/reports/theoretical-usage"
          className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 hover:border-purple-200 hover:shadow-md transition-all group">
          <div className="flex items-center gap-2 text-purple-600 mb-2">
            <BarChart3 size={18} />
            <span className="text-xs font-medium text-gray-500">Food Cost %</span>
          </div>
          <div className={`text-2xl font-bold ${data.estimatedFoodCostPct > 35 ? 'text-red-500' : data.estimatedFoodCostPct > 28 ? 'text-amber-500' : 'text-gray-900'}`}>
            {data.estimatedFoodCostPct.toFixed(1)}%
          </div>
          <div className="text-xs text-gray-400 mt-1 flex items-center justify-between">
            <span>{data.foodCostLabel}</span>
            <ArrowRight size={12} className="opacity-0 group-hover:opacity-100 text-purple-400 transition-opacity" />
          </div>
        </Link>

        <Link href="/inventory?orderList=1"
          className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 hover:border-amber-200 hover:shadow-md transition-all group">
          <div className="flex items-center gap-2 text-amber-500 mb-2">
            <AlertTriangle size={18} />
            <span className="text-xs font-medium text-gray-500">Out of Stock</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">{data.outOfStockCount} items</div>
          <div className="text-xs text-gray-400 mt-1 flex items-center justify-between">
            <span>Tap to order</span>
            <ArrowRight size={12} className="opacity-0 group-hover:opacity-100 text-amber-400 transition-opacity" />
          </div>
        </Link>
      </div>

      {/* Alert sections */}
      {(data.outOfStockItems.length > 0 || highCostRecipes.length > 0) && (
        <div className="grid md:grid-cols-2 gap-4">
          {data.outOfStockItems.length > 0 && (
            <div className="bg-amber-50 border border-amber-100 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle size={16} className="text-amber-500" />
                <h3 className="font-semibold text-amber-800 text-sm">Out of Stock ({data.outOfStockCount})</h3>
                <Link href="/inventory?orderList=1" className="ml-auto text-xs text-amber-600 hover:underline flex items-center gap-0.5">
                  <ShoppingCart size={11} /> Order list →
                </Link>
              </div>
              <div className="space-y-1">
                {data.outOfStockItems.map(item => (
                  <Link
                    key={item.id}
                    href={`/inventory?item=${item.id}`}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-amber-100 transition-colors group"
                  >
                    <CategoryBadge category={item.category} />
                    <span className="text-sm text-amber-900 flex-1">{item.itemName}</span>
                    <ArrowRight size={12} className="opacity-0 group-hover:opacity-100 text-amber-500 transition-opacity" />
                  </Link>
                ))}
              </div>
            </div>
          )}

          {highCostRecipes.length > 0 && (
            <div className="bg-red-50 border border-red-100 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-3">
                <ChefHat size={16} className="text-red-500" />
                <h3 className="font-semibold text-red-800 text-sm">High Food Cost Recipes</h3>
                <Link href="/menu" className="ml-auto text-xs text-red-600 hover:underline">View menu →</Link>
              </div>
              <div className="space-y-1">
                {highCostRecipes.map(r => (
                  <Link
                    key={r.id}
                    href={`/menu?item=${r.id}`}
                    className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg hover:bg-red-100 transition-colors group"
                  >
                    <span className="text-sm text-red-900 truncate">{r.name}</span>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="text-sm font-semibold text-red-600">{r.foodCostPct?.toFixed(1)}%</span>
                      <ArrowRight size={12} className="opacity-0 group-hover:opacity-100 text-red-400 transition-opacity" />
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-6">
        {/* Top expensive items */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100">
          <div className="p-4 border-b border-gray-100 flex items-center gap-2">
            <Package size={18} className="text-gray-500" />
            <h2 className="font-semibold text-gray-900">Top 10 by Inventory Value</h2>
            <Link href="/inventory" className="ml-auto text-xs text-blue-600 hover:underline flex items-center gap-0.5">
              View all →
            </Link>
          </div>
          <div className="divide-y divide-gray-50">
            {data.topExpensiveItems.map((item, i) => (
              <Link
                key={item.id}
                href={`/inventory?item=${item.id}`}
                className="px-4 py-2.5 flex items-center justify-between gap-2 hover:bg-gray-50 transition-colors group"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs text-gray-400 w-4 shrink-0">{i + 1}</span>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-gray-800 truncate group-hover:text-blue-600 transition-colors">{item.itemName}</div>
                    <div className="flex items-center gap-1.5">
                      <CategoryBadge category={item.category} />
                      <span className="text-xs text-gray-400">{formatCurrency(parseFloat(String(item.pricePerBaseUnit)))}/{item.baseUnit}</span>
                    </div>
                  </div>
                </div>
                <div className="text-right shrink-0 flex items-center gap-2">
                  <div>
                    <div className="text-sm font-semibold text-gray-900">{formatCurrency(item.inventoryValue)}</div>
                    <div className="text-xs text-gray-400">total value</div>
                  </div>
                  <ArrowRight size={12} className="opacity-0 group-hover:opacity-100 text-blue-400 transition-opacity" />
                </div>
              </Link>
            ))}
          </div>
        </div>

        {/* Recent Invoices */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100">
          <div className="p-4 border-b border-gray-100 flex items-center gap-2">
            <FileText size={18} className="text-gray-500" />
            <h2 className="font-semibold text-gray-900">Recent Invoices</h2>
            <Link href="/invoices" className="ml-auto text-xs text-blue-600 hover:underline">
              View all →
            </Link>
          </div>
          <div className="divide-y divide-gray-50">
            {data.recentInvoices.map(inv => (
              <Link
                key={inv.id}
                href="/invoices"
                className="px-4 py-3 flex items-center justify-between gap-2 hover:bg-gray-50 transition-colors group"
              >
                <div>
                  <div className="text-sm font-medium text-gray-800 group-hover:text-blue-600 transition-colors">{inv.invoiceNumber}</div>
                  <div className="text-xs text-gray-500">
                    {inv.supplier.name} &middot; {new Date(inv.invoiceDate).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}
                  </div>
                </div>
                <div className="text-right flex items-center gap-2">
                  <div>
                    <div className="text-sm font-semibold">{formatCurrency(parseFloat(String(inv.totalAmount)))}</div>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      inv.status === 'COMPLETE'    ? 'bg-green-100 text-green-700' :
                      inv.status === 'PROCESSING'  ? 'bg-blue-100 text-blue-700' :
                                                     'bg-amber-100 text-amber-700'
                    }`}>
                      {inv.status}
                    </span>
                  </div>
                  <ArrowRight size={12} className="opacity-0 group-hover:opacity-100 text-blue-400 transition-opacity" />
                </div>
              </Link>
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
