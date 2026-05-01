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
          <ChefHat size={18} className="text-blue-600" />
          <h2 className="text-base font-semibold text-gray-800">Prep Performance</h2>
        </div>
        <div className="flex items-center gap-0.5 border border-gray-200 rounded-lg p-0.5 bg-white">
          {PERIOD_OPTIONS.map(opt => (
            <button key={opt.days} onClick={() => setPeriod(opt.days)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                period === opt.days ? 'bg-blue-600 text-white shadow-sm' : 'text-gray-600 hover:bg-gray-50'
              }`}>
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
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
