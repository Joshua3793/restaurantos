'use client'
import { useEffect, useState, useCallback } from 'react'
import dynamic from 'next/dynamic'
import { formatCurrency, formatDate, WASTAGE_REASONS } from '@/lib/utils'
import { CategoryBadge } from '@/components/CategoryBadge'
import { useRc } from '@/contexts/RevenueCenterContext'
import { Plus, X, AlertTriangle } from 'lucide-react'

// Lazy-load recharts — only renders when there are logs to display
const WastageCharts = dynamic(() => import('@/components/wastage/WastageCharts'), { ssr: false, loading: () => null })

interface WastageLog {
  id: string
  date: string
  inventoryItemId: string
  inventoryItem: { itemName: string; category: string; baseUnit: string }
  qtyWasted: number
  unit: string
  reason: string
  costImpact: number
  loggedBy: string
  notes: string | null
}

interface InventoryItem {
  id: string
  itemName: string
  baseUnit: string
  pricePerBaseUnit: number
}

const REASON_COLORS: Record<string, string> = {
  SPOILAGE:       'bg-red-100 text-red-700',
  OVERPRODUCTION: 'bg-orange-100 text-orange-700',
  PREP_TRIM:      'bg-yellow-100 text-yellow-700',
  BURNT:          'bg-gray-100 text-gray-700',
  DROPPED:        'bg-blue-100 text-blue-700',
  EXPIRED:        'bg-purple-100 text-purple-700',
  STAFF_MEAL:     'bg-green-100 text-green-700',
  UNKNOWN:        'bg-gray-100 text-gray-600',
}


export default function WastagePage() {
  const { activeRcId, activeRc } = useRc()
  const [logs, setLogs] = useState<WastageLog[]>([])
  const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([])
  const [reasonFilter, setReasonFilter] = useState('')
  const [startDate, setStartDate] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 7); return d.toISOString().slice(0, 10) })
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState({
    inventoryItemId: '',
    qtyWasted: '',
    unit: 'g',
    reason: 'UNKNOWN',
    loggedBy: '',
    notes: '',
    date: new Date().toISOString().slice(0, 10),
  })

  const fetchLogs = useCallback(() => {
    const params = new URLSearchParams()
    if (reasonFilter) params.set('reason', reasonFilter)
    if (startDate) params.set('startDate', startDate)
    if (endDate) params.set('endDate', endDate)
    if (activeRcId) {
      params.set('rcId', activeRcId)
      if (activeRc?.isDefault) params.set('isDefault', 'true')
    }
    fetch(`/api/wastage?${params}`).then(r => r.json()).then(setLogs)
  }, [reasonFilter, startDate, endDate, activeRcId, activeRc])

  useEffect(() => { fetchLogs() }, [fetchLogs])
  useEffect(() => {
    fetch('/api/inventory').then(r => r.json()).then(setInventoryItems)
  }, [])

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    await fetch('/api/wastage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, revenueCenterId: activeRcId }),
    })
    setShowAdd(false)
    setForm({ inventoryItemId: '', qtyWasted: '', unit: 'g', reason: 'UNKNOWN', loggedBy: '', notes: '', date: new Date().toISOString().slice(0, 10) })
    fetchLogs()
  }

  const totalCost = logs.reduce((sum, l) => sum + parseFloat(String(l.costImpact)), 0)

  // Preview cost
  const selectedItem = inventoryItems.find(i => i.id === form.inventoryItemId)
  const previewCost = selectedItem && form.qtyWasted
    ? parseFloat(form.qtyWasted) * parseFloat(String(selectedItem.pricePerBaseUnit))
    : 0

  // ── Charts data ────────────────────────────────────────────────────────────

  // Pie: cost by reason
  const byReason = Object.entries(
    logs.reduce((acc, l) => {
      const r = l.reason
      acc[r] = (acc[r] ?? 0) + parseFloat(String(l.costImpact))
      return acc
    }, {} as Record<string, number>)
  )
    .map(([reason, cost]) => ({ reason, cost }))
    .sort((a, b) => b.cost - a.cost)

  // Bar: cost by week (group logs into 7-day buckets)
  const byWeek = (() => {
    const buckets: Record<string, number> = {}
    logs.forEach(l => {
      const d = new Date(l.date)
      // Snap to Monday of that week
      const day = d.getDay()
      const diff = (day === 0 ? -6 : 1 - day)
      d.setDate(d.getDate() + diff)
      const key = d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })
      buckets[key] = (buckets[key] ?? 0) + parseFloat(String(l.costImpact))
    })
    return Object.entries(buckets)
      .map(([week, cost]) => ({ week, cost: parseFloat(cost.toFixed(2)) }))
      .slice(-6)
  })()

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h1 className="text-2xl font-bold text-gray-900">Wastage Log</h1>
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-2 bg-blue-600 text-white px-3 py-2 rounded-lg text-sm hover:bg-blue-700 transition-colors"
        >
          <Plus size={16} /> Log Wastage
        </button>
      </div>

      {/* Summary */}
      <div className="bg-red-50 border border-red-100 rounded-xl p-4 flex items-center gap-3">
        <AlertTriangle size={20} className="text-red-500 shrink-0" />
        <div>
          <div className="font-semibold text-red-700">Total Wastage Cost (filtered)</div>
          <div className="text-2xl font-bold text-red-800">{formatCurrency(totalCost)}</div>
        </div>
        <div className="ml-auto text-right">
          <div className="text-xs text-red-500">{logs.length} entries</div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-2">
        <select
          value={reasonFilter}
          onChange={e => setReasonFilter(e.target.value)}
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All Reasons</option>
          {WASTAGE_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={startDate}
            onChange={e => setStartDate(e.target.value)}
            className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <span className="text-gray-400 text-sm">to</span>
          <input
            type="date"
            value={endDate}
            onChange={e => setEndDate(e.target.value)}
            className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        {(reasonFilter || startDate || endDate) && (
          <button
            onClick={() => { setReasonFilter(''); setStartDate(''); setEndDate('') }}
            className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1"
          >
            <X size={14} /> Clear
          </button>
        )}
      </div>

      {/* Charts — only show when there's data, recharts loads lazily */}
      {logs.length > 0 && (
        <WastageCharts byReason={byReason} byWeek={byWeek} />
      )}

      {/* Logs Table */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Date</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Item</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 hidden sm:table-cell">Category</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Qty Wasted</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 hidden md:table-cell">Reason</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Cost Impact</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 hidden lg:table-cell">Logged By</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {logs.map(log => (
                <tr key={log.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{formatDate(log.date)}</td>
                  <td className="px-4 py-3 font-medium text-gray-800">{log.inventoryItem.itemName}</td>
                  <td className="px-4 py-3 hidden sm:table-cell">
                    <CategoryBadge category={log.inventoryItem.category} />
                  </td>
                  <td className="px-4 py-3 text-right text-gray-700">
                    {parseFloat(String(log.qtyWasted)).toFixed(1)} {log.unit}
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${REASON_COLORS[log.reason] || 'bg-gray-100 text-gray-600'}`}>
                      {log.reason}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-semibold text-red-600">
                    {formatCurrency(parseFloat(String(log.costImpact)))}
                  </td>
                  <td className="px-4 py-3 text-gray-500 hidden lg:table-cell">{log.loggedBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {logs.length === 0 && (
            <div className="text-center py-12 text-gray-400">No wastage logs found</div>
          )}
        </div>
      </div>

      {/* Add Wastage Modal */}
      {showAdd && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          onClick={() => setShowAdd(false)}
        >
          <div className="absolute inset-0 bg-black/30" />
          <div
            className="relative bg-white rounded-xl p-6 w-full max-w-md shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="font-semibold mb-4 text-lg">Log Wastage</h3>
            <form onSubmit={handleAdd} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Item *</label>
                <select
                  required
                  value={form.inventoryItemId}
                  onChange={e => {
                    const item = inventoryItems.find(i => i.id === e.target.value)
                    setForm(f => ({ ...f, inventoryItemId: e.target.value, unit: item?.baseUnit || 'g' }))
                  }}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Select item...</option>
                  {inventoryItems.map(item => (
                    <option key={item.id} value={item.id}>{item.itemName} ({item.baseUnit})</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Qty Wasted *</label>
                  <input
                    type="number"
                    required
                    value={form.qtyWasted}
                    onChange={e => setForm(f => ({ ...f, qtyWasted: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    step="any"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Unit</label>
                  <input
                    value={form.unit}
                    onChange={e => setForm(f => ({ ...f, unit: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Reason</label>
                <select
                  value={form.reason}
                  onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {WASTAGE_REASONS.map(r => <option key={r}>{r}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Date</label>
                  <input
                    type="date"
                    value={form.date}
                    onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Logged By</label>
                  <input
                    value={form.loggedBy}
                    onChange={e => setForm(f => ({ ...f, loggedBy: e.target.value }))}
                    placeholder="Name"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Notes</label>
                <textarea
                  value={form.notes}
                  onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  rows={2}
                />
              </div>
              {previewCost > 0 && (
                <div className="bg-red-50 rounded-lg p-3 text-sm">
                  <span className="text-red-600 font-medium">Estimated cost impact: </span>
                  <span className="font-bold text-red-700">{formatCurrency(previewCost)}</span>
                </div>
              )}
              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAdd(false)}
                  className="flex-1 border border-gray-200 rounded-lg py-2 text-sm hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="flex-1 bg-red-600 text-white rounded-lg py-2 text-sm hover:bg-red-700"
                >
                  Log Wastage
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
