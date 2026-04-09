'use client'
import { useEffect, useState } from 'react'
import { formatCurrency } from '@/lib/utils'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, PieChart, Pie, Cell, Legend
} from 'recharts'

// ── COGS Section ─────────────────────────────────────────────────────────────
interface CogsResult {
  startDate: string
  endDate: string
  beginningInventory: { value: number; sessionDate: string | null; sessionId: string | null; fallback: boolean }
  purchases: { total: number; invoiceCount: number }
  endingInventory: { value: number; sessionDate: string | null; sessionId: string | null; fallback: boolean }
  cogs: number
  foodSales: number
  foodCostPct: number
  byCategory: Array<{ category: string; beginningValue: number; endingValue: number; purchases: number; cogs: number }>
}

function CogsSection() {
  // Default to current week Mon–Sun
  const getWeekBounds = () => {
    const today = new Date()
    const dow = today.getDay() // 0=Sun
    const mon = new Date(today)
    mon.setDate(today.getDate() - ((dow + 6) % 7))
    const sun = new Date(mon)
    sun.setDate(mon.getDate() + 6)
    return {
      start: mon.toISOString().split('T')[0],
      end: sun.toISOString().split('T')[0],
    }
  }

  const { start: defaultStart, end: defaultEnd } = getWeekBounds()
  const [startDate, setStartDate] = useState(defaultStart)
  const [endDate, setEndDate] = useState(defaultEnd)
  const [data, setData] = useState<CogsResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/reports/cogs?startDate=${startDate}&endDate=${endDate}`)
      const d = await res.json()
      setData(d)
    } finally {
      setLoading(false)
      setLoaded(true)
    }
  }

  const fmtDate = (d: string | null) => d
    ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : null

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100">
      <div className="p-4 border-b border-gray-100 flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
        <h3 className="font-semibold text-gray-800">COGS — Cost of Goods Sold</h3>
        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="date"
            value={startDate}
            onChange={e => setStartDate(e.target.value)}
            className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs text-gray-900 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <span className="text-xs text-gray-400">to</span>
          <input
            type="date"
            value={endDate}
            onChange={e => setEndDate(e.target.value)}
            className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs text-gray-900 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <button
            onClick={load}
            disabled={loading}
            className="bg-blue-600 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? 'Loading…' : 'Calculate'}
          </button>
        </div>
      </div>

      <div className="p-4 space-y-4">
        {!loaded ? (
          <div className="text-center py-8 text-gray-400 text-sm">
            Select a date range and click Calculate to see COGS
          </div>
        ) : !data ? (
          <div className="text-center py-8 text-gray-400 text-sm">Failed to load data</div>
        ) : (
          <>
            {/* Main formula display */}
            <div className="border border-gray-100 rounded-xl overflow-hidden">
              {/* Beginning inventory */}
              <div className="flex items-center justify-between px-4 py-3 bg-gray-50">
                <span className="text-sm text-gray-600">Beginning inventory</span>
                <div className="text-right">
                  <span className="text-sm font-semibold text-gray-900">{formatCurrency(data.beginningInventory.value)}</span>
                  {data.beginningInventory.sessionDate && (
                    <span className="text-xs text-gray-400 ml-2">(Count from {fmtDate(data.beginningInventory.sessionDate)})</span>
                  )}
                  {data.beginningInventory.fallback && !data.beginningInventory.sessionDate && (
                    <span className="text-xs text-amber-500 ml-2">(estimated from current stock)</span>
                  )}
                </div>
              </div>

              {/* + Purchases */}
              <div className="flex items-center justify-between px-4 py-3">
                <span className="text-sm text-gray-600">
                  <span className="text-gray-400 mr-2">+</span>Purchases
                </span>
                <div className="text-right">
                  <span className="text-sm font-semibold text-gray-900">{formatCurrency(data.purchases.total)}</span>
                  <span className="text-xs text-gray-400 ml-2">
                    ({data.purchases.invoiceCount} invoice{data.purchases.invoiceCount !== 1 ? 's' : ''})
                  </span>
                </div>
              </div>

              {/* − Ending inventory */}
              <div className="flex items-center justify-between px-4 py-3 bg-gray-50">
                <span className="text-sm text-gray-600">
                  <span className="text-gray-400 mr-2">−</span>Ending inventory
                </span>
                <div className="text-right">
                  <span className="text-sm font-semibold text-gray-900">{formatCurrency(data.endingInventory.value)}</span>
                  {data.endingInventory.sessionDate && (
                    <span className="text-xs text-gray-400 ml-2">(Count from {fmtDate(data.endingInventory.sessionDate)})</span>
                  )}
                  {data.endingInventory.fallback && !data.endingInventory.sessionDate && (
                    <span className="text-xs text-amber-500 ml-2">(no count found)</span>
                  )}
                </div>
              </div>

              {/* Divider */}
              <div className="h-px bg-gray-200 mx-4" />

              {/* = COGS */}
              <div className="flex items-center justify-between px-4 py-3 bg-blue-50">
                <span className="text-sm font-bold text-gray-900">
                  <span className="text-gray-400 mr-2">=</span>COGS
                </span>
                <span className="text-lg font-bold text-blue-700">{formatCurrency(data.cogs)}</span>
              </div>

              {/* Food cost % */}
              {data.foodSales > 0 && (
                <div className="flex items-center justify-between px-4 py-2.5 border-t border-gray-100">
                  <span className="text-xs text-gray-500 pl-5">Food cost %</span>
                  <div className="text-right">
                    <span className={`text-sm font-semibold ${data.foodCostPct > 35 ? 'text-red-600' : data.foodCostPct > 28 ? 'text-amber-600' : 'text-green-600'}`}>
                      {data.foodCostPct.toFixed(1)}%
                    </span>
                    <span className="text-xs text-gray-400 ml-2">(vs {formatCurrency(data.foodSales)} food sales)</span>
                  </div>
                </div>
              )}
            </div>

            {/* Warnings */}
            {data.beginningInventory.fallback && (
              <div className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg p-3 flex items-start gap-2">
                <span className="shrink-0">⚠</span>
                <span>
                  Beginning inventory estimated from current stock levels — complete a stock count before {fmtDate(data.startDate)} for accuracy.
                </span>
              </div>
            )}
            {data.endingInventory.fallback && (
              <div className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg p-3 flex items-start gap-2">
                <span className="shrink-0">⚠</span>
                <span>
                  No closing stock count found for this period. Complete a count on or before {fmtDate(data.endDate)} for accurate COGS.
                </span>
              </div>
            )}
            {data.beginningInventory.value === 0 && data.endingInventory.value === 0 && data.purchases.invoiceCount === 0 && (
              <div className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-lg p-3">
                No count sessions found for this period. Complete a stock count to enable accurate COGS calculation.
              </div>
            )}

            {/* By category table */}
            {data.byCategory.length > 0 && (
              <div>
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Breakdown by Category</div>
                <div className="border border-gray-100 rounded-xl overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="text-left px-4 py-2.5 font-semibold text-gray-600">Category</th>
                        <th className="text-right px-3 py-2.5 font-semibold text-gray-600">Begin</th>
                        <th className="text-right px-3 py-2.5 font-semibold text-gray-600">Purchases</th>
                        <th className="text-right px-3 py-2.5 font-semibold text-gray-600">End</th>
                        <th className="text-right px-4 py-2.5 font-semibold text-gray-600">COGS</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {data.byCategory.map(row => (
                        <tr key={row.category} className="hover:bg-gray-50">
                          <td className="px-4 py-2.5 font-medium text-gray-800">{row.category}</td>
                          <td className="px-3 py-2.5 text-right text-gray-600">{formatCurrency(row.beginningValue)}</td>
                          <td className="px-3 py-2.5 text-right text-gray-600">{formatCurrency(row.purchases)}</td>
                          <td className="px-3 py-2.5 text-right text-gray-600">{formatCurrency(row.endingValue)}</td>
                          <td className={`px-4 py-2.5 text-right font-semibold ${row.cogs > 0 ? 'text-blue-700' : 'text-gray-500'}`}>
                            {formatCurrency(row.cogs)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

interface WeeklyData {
  week: string
  revenue: number
  wastage: number
  foodCostPct: number
}

interface CogsData {
  weeklyData: WeeklyData[]
  wastageByCategory: Record<string, number>
  inventoryByCategory: Record<string, number>
  topWasted: Array<{ name: string; cost: number }>
}

const PIE_COLORS = ['#3b82f6', '#ef4444', '#f59e0b', '#10b981', '#8b5cf6', '#06b6d4', '#84cc16', '#f97316']

const formatWeek = (week: string) => {
  const d = new Date(week)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export default function ReportsPage() {
  const [data, setData] = useState<CogsData | null>(null)
  const [activeTab, setActiveTab] = useState<'weekly' | 'wastage' | 'inventory' | 'top'>('weekly')

  useEffect(() => {
    fetch('/api/reports/cogs').then(r => r.json()).then(setData)
  }, [])

  if (!data) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    )
  }

  const wastageCategories = Object.entries(data.wastageByCategory).map(([name, value]) => ({ name, value }))
  const inventoryCategories = Object.entries(data.inventoryByCategory).map(([name, value]) => ({ name, value }))

  const tabs = [
    { id: 'weekly', label: 'Weekly Trends' },
    { id: 'wastage', label: 'Wastage by Category' },
    { id: 'inventory', label: 'Inventory by Category' },
    { id: 'top', label: 'Top Wasted Items' },
  ] as const

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Reports & Analytics</h1>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 text-center">
          <div className="text-xs text-gray-500 mb-1">Total Revenue (8 weeks)</div>
          <div className="text-xl font-bold text-gray-900">
            {formatCurrency(data.weeklyData.reduce((s, w) => s + w.revenue, 0))}
          </div>
        </div>
        <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 text-center">
          <div className="text-xs text-gray-500 mb-1">Total Wastage (8 weeks)</div>
          <div className="text-xl font-bold text-red-600">
            {formatCurrency(data.weeklyData.reduce((s, w) => s + w.wastage, 0))}
          </div>
        </div>
        <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 text-center">
          <div className="text-xs text-gray-500 mb-1">Avg Food Cost %</div>
          <div className="text-xl font-bold text-purple-600">
            {data.weeklyData.length > 0
              ? `${(data.weeklyData.reduce((s, w) => s + w.foodCostPct, 0) / data.weeklyData.length).toFixed(1)}%`
              : 'N/A'
            }
          </div>
        </div>
        <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 text-center">
          <div className="text-xs text-gray-500 mb-1">Total Inventory Value</div>
          <div className="text-xl font-bold text-blue-600">
            {formatCurrency(Object.values(data.inventoryByCategory).reduce((s, v) => s + v, 0))}
          </div>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100">
        <div className="flex border-b border-gray-100 overflow-x-auto">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-3 text-sm font-medium whitespace-nowrap transition-colors ${
                activeTab === tab.id
                  ? 'text-blue-600 border-b-2 border-blue-600'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="p-4 md:p-6">
          {activeTab === 'weekly' && (
            <div className="space-y-6">
              <div>
                <h3 className="font-semibold text-gray-800 mb-4">Revenue vs Wastage (Weekly)</h3>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data.weeklyData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis dataKey="week" tickFormatter={formatWeek} tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `$${(v / 1000).toFixed(0)}k`} />
                      <Tooltip
                        formatter={(value: number, name: string) => [formatCurrency(value), name === 'revenue' ? 'Revenue' : 'Wastage']}
                        labelFormatter={formatWeek}
                      />
                      <Legend formatter={v => v === 'revenue' ? 'Revenue' : 'Wastage Cost'} />
                      <Bar dataKey="revenue" fill="#3b82f6" radius={[4, 4, 0, 0]} name="revenue" />
                      <Bar dataKey="wastage" fill="#ef4444" radius={[4, 4, 0, 0]} name="wastage" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div>
                <h3 className="font-semibold text-gray-800 mb-4">Food Cost % Trend</h3>
                <div className="h-48">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={data.weeklyData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis dataKey="week" tickFormatter={formatWeek} tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `${v.toFixed(0)}%`} />
                      <Tooltip
                        formatter={(value: number) => [`${value.toFixed(1)}%`, 'Food Cost %']}
                        labelFormatter={formatWeek}
                      />
                      <Line
                        type="monotone"
                        dataKey="foodCostPct"
                        stroke="#8b5cf6"
                        strokeWidth={2}
                        dot={{ fill: '#8b5cf6', r: 4 }}
                        name="foodCostPct"
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'wastage' && (
            <div>
              <h3 className="font-semibold text-gray-800 mb-4">Wastage Cost by Category</h3>
              {wastageCategories.length > 0 ? (
                <div className="flex flex-col md:flex-row items-center gap-6">
                  <div className="h-64 w-full md:w-1/2">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={wastageCategories}
                          cx="50%"
                          cy="50%"
                          outerRadius={90}
                          dataKey="value"
                          label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                          labelLine={false}
                        >
                          {wastageCategories.map((_, index) => (
                            <Cell key={index} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip formatter={(value: number) => formatCurrency(value)} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="w-full md:w-1/2 space-y-2">
                    {wastageCategories.sort((a, b) => b.value - a.value).map((cat, i) => (
                      <div key={cat.name} className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <div className="w-3 h-3 rounded-full" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                          <span className="text-sm text-gray-700">{cat.name}</span>
                        </div>
                        <span className="font-semibold text-sm text-red-600">{formatCurrency(cat.value)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="text-center py-12 text-gray-400">No wastage data available</div>
              )}
            </div>
          )}

          {activeTab === 'inventory' && (
            <div>
              <h3 className="font-semibold text-gray-800 mb-4">Inventory Value by Category</h3>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={inventoryCategories.sort((a, b) => b.value - a.value)}
                    margin={{ top: 5, right: 20, left: 0, bottom: 5 }}
                    layout="vertical"
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={v => `$${v.toFixed(0)}`} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={50} />
                    <Tooltip formatter={(value: number) => [formatCurrency(value), 'Inventory Value']} />
                    <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                      {inventoryCategories.map((cat, i) => (
                        <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {activeTab === 'top' && (
            <div>
              <h3 className="font-semibold text-gray-800 mb-4">Top Wasted Items by Cost</h3>
              {data.topWasted.length > 0 ? (
                <div className="space-y-2">
                  {data.topWasted.map((item, i) => (
                    <div key={item.name} className="flex items-center gap-3">
                      <span className="text-xs text-gray-400 w-5 text-right">{i + 1}</span>
                      <div className="flex-1">
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <span className="text-sm font-medium text-gray-800">{item.name}</span>
                          <span className="text-sm font-semibold text-red-600">{formatCurrency(item.cost)}</span>
                        </div>
                        <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-red-400 rounded-full"
                            style={{ width: `${(item.cost / data.topWasted[0].cost) * 100}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-12 text-gray-400">No wastage data available</div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* COGS from Count Sessions */}
      <CogsSection />

      {/* Weekly Data Table */}
      {data.weeklyData.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100">
          <div className="p-4 border-b border-gray-100">
            <h3 className="font-semibold text-gray-800">Weekly Breakdown</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Week of</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Revenue</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Wastage</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Food Cost %</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {data.weeklyData.map(row => (
                  <tr key={row.week} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-600">{formatWeek(row.week)}</td>
                    <td className="px-4 py-3 text-right font-medium text-gray-800">{formatCurrency(row.revenue)}</td>
                    <td className="px-4 py-3 text-right text-red-600">{formatCurrency(row.wastage)}</td>
                    <td className={`px-4 py-3 text-right font-semibold ${row.foodCostPct > 35 ? 'text-red-600' : 'text-green-600'}`}>
                      {row.foodCostPct.toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
