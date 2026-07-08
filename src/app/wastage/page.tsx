'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import dynamic from 'next/dynamic'
import { formatCurrency, formatDate, WASTAGE_REASONS, compatibleCountUnits } from '@/lib/utils'
import { CategoryBadge } from '@/components/CategoryBadge'
import { useRc } from '@/contexts/RevenueCenterContext'
import { setScopeParams } from '@/lib/scope-params'
import { Plus, X, AlertTriangle, Search, Check } from 'lucide-react'

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

// Fuzzy score mirroring the server-side matcher in /api/inventory/search — kept
// client-side here so the wastage picker can search the full loaded list
// (including PREP items, which that endpoint deliberately excludes).
function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase().trim()
  const t = target.toLowerCase().trim()
  if (!q) return 100
  if (t === q) return 100
  if (t.includes(q)) return 90
  const qWords = q.split(/\s+/).filter(Boolean)
  const tWords = t.split(/[\s\-/]+/).filter(Boolean)
  const allMatch = qWords.every(qw => tWords.some(tw => tw.startsWith(qw) || tw.includes(qw)))
  if (allMatch) return 80
  const matched = qWords.filter(qw => tWords.some(tw => tw.startsWith(qw) || tw.includes(qw)))
  const ratio = matched.length / qWords.length
  return ratio >= 0.5 ? Math.round(40 + ratio * 40) : 0
}

// Searchable item selector — replaces the plain <select>. Type to fuzzy-match
// against the loaded inventory list; ↑↓ to move, ⏎ to pick.
function ItemPicker({
  items,
  value,
  onSelect,
}: {
  items: InventoryItem[]
  value: string
  onSelect: (item: InventoryItem) => void
}) {
  const selected = items.find(i => i.id === value) ?? null
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)

  // Close when clicking outside
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const results = (() => {
    const q = query.trim()
    if (!q) return items.slice(0, 8)
    return items
      .map(item => ({ item, score: fuzzyScore(q, item.itemName) }))
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map(r => r.item)
  })()

  const pick = (item: InventoryItem) => {
    onSelect(item)
    setQuery('')
    setOpen(false)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) { setOpen(true); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (results[active]) pick(results[active]) }
    else if (e.key === 'Escape') { setOpen(false) }
  }

  return (
    <div ref={boxRef} className="relative">
      <div className="flex items-center gap-2 border border-line rounded-lg px-3 py-2 focus-within:ring-2 focus-within:ring-gold">
        <Search size={14} className="text-ink-4 shrink-0" />
        <input
          value={open ? query : (selected ? `${selected.itemName} (${selected.baseUnit})` : query)}
          onChange={e => { setQuery(e.target.value); setActive(0); if (!open) setOpen(true) }}
          onFocus={() => { setOpen(true); setQuery('') }}
          onKeyDown={onKeyDown}
          placeholder="Search item…"
          className="flex-1 text-sm bg-transparent border-none outline-none placeholder:text-ink-4"
        />
        {selected && !open && (
          <button
            type="button"
            onClick={() => { onSelect({ id: '', itemName: '', baseUnit: 'g', pricePerBaseUnit: 0 }); setQuery(''); setOpen(true) }}
            className="text-ink-4 hover:text-ink-2 shrink-0"
            aria-label="Clear selected item"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {open && (
        <div className="absolute z-10 mt-1 w-full bg-white border border-line rounded-lg shadow-lg overflow-hidden max-h-64 overflow-y-auto">
          {results.length === 0 ? (
            <div className="px-3 py-3 text-sm text-ink-4">No matching items</div>
          ) : (
            results.map((item, i) => (
              <button
                key={item.id}
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(item)}
                className={`w-full flex items-center gap-2 px-3 py-2 text-left ${i === active ? 'bg-bg' : ''} ${i < results.length - 1 ? 'border-b border-bg-2' : ''}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-ink truncate">{item.itemName}</div>
                  <div className="text-xs text-ink-3 tabular-nums">{formatCurrency(parseFloat(String(item.pricePerBaseUnit)))}/{item.baseUnit}</div>
                </div>
                {item.id === value && <Check size={14} className="text-gold shrink-0" />}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

const REASON_COLORS: Record<string, string> = {
  SPOILAGE:       'bg-red-soft text-red-text',
  OVERPRODUCTION: 'bg-gold-soft text-gold-2',
  PREP_TRIM:      'bg-yellow-100 text-yellow-700',
  BURNT:          'bg-bg-2 text-ink-2',
  DROPPED:        'bg-gold/15 text-gold',
  EXPIRED:        'bg-blue-soft text-blue-text',
  STAFF_MEAL:     'bg-green-soft text-green-text',
  UNKNOWN:        'bg-bg-2 text-ink-3',
}


export default function WastagePage() {
  const { activeRcId, activeRc, activeKind, activeLocationId } = useRc()
  const [logs, setLogs] = useState<WastageLog[]>([])
  const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([])
  const [reasonFilter, setReasonFilter] = useState('')
  const [startDate, setStartDate] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 7); return d.toISOString().slice(0, 10) })
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [showAdd, setShowAdd] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
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
    setScopeParams(params, { activeKind, activeRcId, activeRc, activeLocationId })
    return fetch(`/api/wastage?${params}`).then(r => r.json()).then(setLogs)
  }, [reasonFilter, startDate, endDate, activeRcId, activeRc, activeKind, activeLocationId])

  useEffect(() => { fetchLogs() }, [fetchLogs])
  useEffect(() => {
    fetch('/api/inventory').then(r => r.json()).then(setInventoryItems)
  }, [])

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!activeRcId) {
      setError('Select a revenue center (not "All") to log wastage.')
      return
    }
    if (!form.inventoryItemId) {
      setError('Select an item to log wastage.')
      return
    }
    setError(null)
    setSaving(true)
    try {
      const res = await fetch('/api/wastage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, revenueCenterId: activeRcId }),
      })
      if (!res.ok) {
        setError('Failed to log wastage. Please try again.')
        return
      }
      await fetchLogs()
      setShowAdd(false)
      setForm({ inventoryItemId: '', qtyWasted: '', unit: 'g', reason: 'UNKNOWN', loggedBy: '', notes: '', date: new Date().toISOString().slice(0, 10) })
    } finally {
      setSaving(false)
    }
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
        <h1 className="text-2xl font-bold text-ink">Wastage Log</h1>
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-2 bg-ink text-paper [&_svg]:text-gold px-3 py-2 rounded-lg text-sm hover:bg-ink-2 transition-colors"
        >
          <Plus size={16} /> Log Wastage
        </button>
      </div>

      {/* Summary */}
      <div className="bg-red-soft border border-red-soft rounded-xl p-4 flex items-center gap-3">
        <AlertTriangle size={20} className="text-red shrink-0" />
        <div>
          <div className="font-semibold text-red-text">Total Wastage Cost (filtered)</div>
          <div className="text-2xl font-bold text-red-text">{formatCurrency(totalCost)}</div>
        </div>
        <div className="ml-auto text-right">
          <div className="text-xs text-red">{logs.length} entries</div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-2">
        <select
          value={reasonFilter}
          onChange={e => setReasonFilter(e.target.value)}
          className="border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
        >
          <option value="">All Reasons</option>
          {WASTAGE_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={startDate}
            onChange={e => setStartDate(e.target.value)}
            className="border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
          />
          <span className="text-ink-4 text-sm">to</span>
          <input
            type="date"
            value={endDate}
            onChange={e => setEndDate(e.target.value)}
            className="border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
          />
        </div>
        {(reasonFilter || startDate || endDate) && (
          <button
            onClick={() => { setReasonFilter(''); setStartDate(''); setEndDate('') }}
            className="text-sm text-ink-3 hover:text-ink-2 flex items-center gap-1"
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
      <div className="bg-white rounded-xl shadow-sm border border-line overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-bg border-b border-line">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-ink-3">Date</th>
                <th className="text-left px-4 py-3 font-medium text-ink-3">Item</th>
                <th className="text-left px-4 py-3 font-medium text-ink-3 hidden sm:table-cell">Category</th>
                <th className="text-right px-4 py-3 font-medium text-ink-3">Qty Wasted</th>
                <th className="text-left px-4 py-3 font-medium text-ink-3 hidden md:table-cell">Reason</th>
                <th className="text-right px-4 py-3 font-medium text-ink-3">Cost Impact</th>
                <th className="text-left px-4 py-3 font-medium text-ink-3 hidden lg:table-cell">Logged By</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {logs.map(log => (
                <tr key={log.id} className="hover:bg-bg">
                  <td className="px-4 py-3 text-ink-3 whitespace-nowrap">{formatDate(log.date)}</td>
                  <td className="px-4 py-3 font-medium text-ink-2">{log.inventoryItem.itemName}</td>
                  <td className="px-4 py-3 hidden sm:table-cell">
                    <CategoryBadge category={log.inventoryItem.category} />
                  </td>
                  <td className="px-4 py-3 text-right text-ink-2">
                    {parseFloat(String(log.qtyWasted)).toFixed(1)} {log.unit}
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${REASON_COLORS[log.reason] || 'bg-bg-2 text-ink-3'}`}>
                      {log.reason}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-semibold text-red">
                    {formatCurrency(parseFloat(String(log.costImpact)))}
                  </td>
                  <td className="px-4 py-3 text-ink-3 hidden lg:table-cell">{log.loggedBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {logs.length === 0 && (
            <div className="text-center py-12 text-ink-4">No wastage logs found</div>
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
                <label className="block text-xs font-medium text-ink-3 mb-1">Item *</label>
                <ItemPicker
                  items={inventoryItems}
                  value={form.inventoryItemId}
                  onSelect={item => setForm(f => ({ ...f, inventoryItemId: item.id, unit: item.baseUnit || 'g' }))}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-ink-3 mb-1">Qty Wasted *</label>
                  <input
                    type="number"
                    required
                    value={form.qtyWasted}
                    onChange={e => setForm(f => ({ ...f, qtyWasted: e.target.value }))}
                    className="w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                    step="any"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-ink-3 mb-1">Unit</label>
                  <select
                    value={form.unit}
                    onChange={e => setForm(f => ({ ...f, unit: e.target.value }))}
                    className="w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold bg-white"
                  >
                    {(compatibleCountUnits(inventoryItems.find(i => i.id === form.inventoryItemId)?.baseUnit ?? 'each')).map(u => (
                      <option key={u}>{u}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-3 mb-1">Reason</label>
                <select
                  value={form.reason}
                  onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
                  className="w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                >
                  {WASTAGE_REASONS.map(r => <option key={r}>{r}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-ink-3 mb-1">Date</label>
                  <input
                    type="date"
                    value={form.date}
                    onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
                    className="w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-ink-3 mb-1">Logged By</label>
                  <input
                    value={form.loggedBy}
                    onChange={e => setForm(f => ({ ...f, loggedBy: e.target.value }))}
                    placeholder="Name"
                    className="w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-3 mb-1">Notes</label>
                <textarea
                  value={form.notes}
                  onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  className="w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                  rows={2}
                />
              </div>
              {previewCost > 0 && (
                <div className="bg-red-soft rounded-lg p-3 text-sm">
                  <span className="text-red font-medium">Estimated cost impact: </span>
                  <span className="font-bold text-red-text">{formatCurrency(previewCost)}</span>
                </div>
              )}
              {(!activeRcId || error) && (
                <div className="bg-red-soft text-red-text rounded-lg p-3 text-sm flex items-start gap-2">
                  <AlertTriangle size={15} className="shrink-0 mt-0.5" />
                  <span>{error ?? 'Select a revenue center (not "All") to log wastage.'}</span>
                </div>
              )}
              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAdd(false)}
                  className="flex-1 border border-line rounded-lg py-2 text-sm hover:bg-bg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!activeRcId || saving}
                  className="flex-1 bg-red text-white rounded-lg py-2 text-sm hover:bg-red disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {saving ? 'Saving…' : 'Log Wastage'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
