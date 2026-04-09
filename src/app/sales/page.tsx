'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUpDown, BarChart2, Calendar, Check, ChevronDown, ChevronUp,
  Download, Pencil, Plus, Search, Trash2, TrendingUp, Upload, Users, X,
} from 'lucide-react'
import { formatCurrency } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

interface RecipeSummary {
  id: string
  name: string
  menuPrice: number | null
  portionSize: number | null
  portionUnit: string | null
  yieldUnit: string
  baseYieldQty: number
  category: { name: string; color: string | null } | null
}

interface SaleLineItem {
  id: string
  recipeId: string
  qtySold: number
  recipe: RecipeSummary
}

interface Sale {
  id: string
  date: string
  totalRevenue: number
  foodSalesPct: number
  covers: number | null
  notes: string | null
  createdAt: string
  lineItems: SaleLineItem[]
}

type RangeMode = 'week' | 'month' | 'lastMonth' | 'custom'
type SortCol = 'date' | 'revenue' | 'covers' | 'items'
type SortDir = 'asc' | 'desc'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function startOfWeek(d: Date) {
  const r = new Date(d)
  r.setDate(r.getDate() - r.getDay())
  r.setHours(0, 0, 0, 0)
  return r
}

function toISO(d: Date) { return d.toISOString().slice(0, 10) }

function fmtDate(s: string) {
  return new Date(s).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })
}

function fmtDay(s: string) {
  return new Date(s).toLocaleDateString('en-CA', { weekday: 'short' })
}

function weekRange(d: Date): [string, string] {
  const s = startOfWeek(d); const e = new Date(s); e.setDate(s.getDate() + 6)
  return [toISO(s), toISO(e)]
}

function monthRange(d: Date): [string, string] {
  const s = new Date(d.getFullYear(), d.getMonth(), 1)
  const e = new Date(d.getFullYear(), d.getMonth() + 1, 0)
  return [toISO(s), toISO(e)]
}

function lastMonthRange(d: Date): [string, string] {
  const s = new Date(d.getFullYear(), d.getMonth() - 1, 1)
  const e = new Date(d.getFullYear(), d.getMonth(), 0)
  return [toISO(s), toISO(e)]
}

function getRange(mode: RangeMode, customStart: string, customEnd: string): [string, string] {
  const now = new Date()
  if (mode === 'week')       return weekRange(now)
  if (mode === 'month')      return monthRange(now)
  if (mode === 'lastMonth')  return lastMonthRange(now)
  return [customStart || toISO(now), customEnd || toISO(now)]
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, accent = 'text-gray-900' }: {
  label: string; value: string; sub?: string; accent?: string
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
      <div className="text-[10px] font-semibold text-gray-400 tracking-wide uppercase">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${accent}`}>{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  )
}

// ─── Sale Form Modal ───────────────────────────────────────────────────────────

interface SaleFormProps {
  initial?: Sale | null
  menuRecipes: RecipeSummary[]
  onSave: (data: {
    date: string; totalRevenue: string; foodSalesPct: string
    covers: string; notes: string
    lineItems: { recipeId: string; qtySold: number }[]
  }) => Promise<void>
  onCancel: () => void
}

function SaleForm({ initial, menuRecipes, onSave, onCancel }: SaleFormProps) {
  const [date,          setDate]          = useState(initial ? toISO(new Date(initial.date)) : toISO(new Date()))
  const [revenue,       setRevenue]       = useState(initial ? String(initial.totalRevenue) : '')
  const [foodPct,       setFoodPct]       = useState(initial ? String(Math.round(Number(initial.foodSalesPct) * 100)) : '70')
  const [covers,        setCovers]        = useState(initial ? String(initial.covers ?? '') : '')
  const [notes,         setNotes]         = useState(initial?.notes ?? '')
  const [saving,        setSaving]        = useState(false)
  const [recipeSearch,  setRecipeSearch]  = useState('')

  // lineItems map: recipeId → qtySold
  const [qtys, setQtys] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {}
    initial?.lineItems.forEach(li => { m[li.recipeId] = String(li.qtySold) })
    return m
  })

  const filteredRecipes = menuRecipes.filter(r =>
    r.name.toLowerCase().includes(recipeSearch.toLowerCase())
  )

  const totalSold = Object.values(qtys).reduce((s, v) => s + (parseInt(v) || 0), 0)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    const lineItems = Object.entries(qtys)
      .map(([recipeId, q]) => ({ recipeId, qtySold: parseInt(q) || 0 }))
      .filter(li => li.qtySold > 0)
    await onSave({ date, totalRevenue: revenue, foodSalesPct: String(parseFloat(foodPct) / 100), covers, notes, lineItems })
    setSaving(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4">
      <div className="bg-white w-full sm:max-w-2xl rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-gray-100 shrink-0">
          <h2 className="text-base font-semibold text-gray-900">{initial ? 'Edit Sales Day' : 'Record Sales Day'}</h2>
          <button onClick={onCancel} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400"><X size={18} /></button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
          <div className="px-5 py-4 space-y-4 overflow-y-auto flex-1">
            {/* Row 1: date + covers */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Date</label>
                <input type="date" required value={date} onChange={e => setDate(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Covers (guests)</label>
                <input type="number" min="0" value={covers} onChange={e => setCovers(e.target.value)}
                  placeholder="0"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>

            {/* Row 2: revenue + food % */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Total Revenue ($)</label>
                <input type="number" required min="0" step="0.01" value={revenue} onChange={e => setRevenue(e.target.value)}
                  placeholder="0.00"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Food Sales %</label>
                <div className="relative">
                  <input type="number" min="0" max="100" value={foodPct} onChange={e => setFoodPct(e.target.value)}
                    placeholder="70"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">%</span>
                </div>
              </div>
            </div>

            {/* Notes */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Notes</label>
              <input value={notes} onChange={e => setNotes(e.target.value)}
                placeholder="e.g. Busy Friday night, private event..."
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>

            {/* Menu items */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-medium text-gray-600">Menu items sold <span className="text-gray-400 font-normal">({totalSold} total portions)</span></label>
              </div>
              <div className="relative mb-2">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input value={recipeSearch} onChange={e => setRecipeSearch(e.target.value)}
                  placeholder="Search menu items..."
                  className="w-full pl-8 pr-3 py-2 border border-gray-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div className="border border-gray-100 rounded-xl overflow-hidden divide-y divide-gray-50 max-h-64 overflow-y-auto">
                {filteredRecipes.length === 0 && (
                  <div className="px-3 py-4 text-center text-sm text-gray-400">No menu items found</div>
                )}
                {filteredRecipes.map(r => (
                  <div key={r.id} className="flex items-center gap-3 px-3 py-2 hover:bg-gray-50">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-800 truncate">{r.name}</div>
                      {r.menuPrice && (
                        <div className="text-xs text-gray-400">{formatCurrency(Number(r.menuPrice))}</div>
                      )}
                    </div>
                    <input
                      type="number" min="0" step="1"
                      value={qtys[r.id] ?? ''}
                      onChange={e => setQtys(q => ({ ...q, [r.id]: e.target.value }))}
                      placeholder="0"
                      className="w-20 border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="px-5 pb-5 pt-3 border-t border-gray-100 shrink-0 flex gap-3">
            <button type="button" onClick={onCancel}
              className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50">
              Cancel
            </button>
            <button type="submit" disabled={saving}
              className="flex-1 px-4 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-60">
              {saving ? 'Saving…' : (initial ? 'Save changes' : 'Record sales')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Day Detail Panel ─────────────────────────────────────────────────────────

function DayDetail({ sale, onEdit, onClose }: { sale: Sale; onEdit: () => void; onClose: () => void }) {
  const foodSales = Number(sale.totalRevenue) * Number(sale.foodSalesPct)
  const totalSold = sale.lineItems.reduce((s, li) => s + li.qtySold, 0)
  const revenue = Number(sale.totalRevenue)
  const avgPerCover = sale.covers && sale.covers > 0 ? revenue / sale.covers : null

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4">
      <div className="bg-white w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-gray-100 shrink-0">
          <div>
            <div className="text-base font-semibold text-gray-900">{fmtDate(sale.date)}</div>
            <div className="text-xs text-gray-400">{fmtDay(sale.date)}</div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onEdit} className="flex items-center gap-1.5 px-3 py-1.5 border border-gray-200 rounded-lg text-xs text-gray-600 hover:bg-gray-50">
              <Pencil size={12} /> Edit
            </button>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400"><X size={18} /></button>
          </div>
        </div>

        <div className="px-5 py-4 overflow-y-auto flex-1 space-y-4">
          {/* Stats row */}
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-gray-50 rounded-xl p-3 text-center">
              <div className="text-lg font-bold text-gray-900">{formatCurrency(revenue)}</div>
              <div className="text-[10px] text-gray-500 mt-0.5 uppercase tracking-wide">Revenue</div>
            </div>
            <div className="bg-gray-50 rounded-xl p-3 text-center">
              <div className="text-lg font-bold text-gray-900">{sale.covers ?? '—'}</div>
              <div className="text-[10px] text-gray-500 mt-0.5 uppercase tracking-wide">Covers</div>
            </div>
            <div className="bg-gray-50 rounded-xl p-3 text-center">
              <div className="text-lg font-bold text-gray-900">{avgPerCover ? formatCurrency(avgPerCover) : '—'}</div>
              <div className="text-[10px] text-gray-500 mt-0.5 uppercase tracking-wide">Avg/Cover</div>
            </div>
          </div>

          <div className="flex gap-3 text-xs text-gray-500">
            <span>Food sales: <span className="font-medium text-gray-700">{formatCurrency(foodSales)}</span></span>
            <span>({Math.round(Number(sale.foodSalesPct) * 100)}%)</span>
            <span>·</span>
            <span>{totalSold} portions sold</span>
          </div>

          {sale.notes && (
            <div className="bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 text-sm text-amber-800">{sale.notes}</div>
          )}

          {/* Line items */}
          {sale.lineItems.length > 0 ? (
            <div>
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Items sold</div>
              <div className="divide-y divide-gray-50 border border-gray-100 rounded-xl overflow-hidden">
                {sale.lineItems.map(li => {
                  const lineRevenue = li.recipe.menuPrice ? Number(li.recipe.menuPrice) * li.qtySold : null
                  return (
                    <div key={li.id} className="flex items-center gap-3 px-3 py-2.5">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-gray-800 truncate">{li.recipe.name}</div>
                        {li.recipe.category && (
                          <div className="text-xs text-gray-400">{li.recipe.category.name}</div>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-sm font-semibold text-gray-800">×{li.qtySold}</div>
                        {lineRevenue && <div className="text-xs text-gray-400">{formatCurrency(lineRevenue)}</div>}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ) : (
            <div className="text-center py-6 text-sm text-gray-400">No menu items recorded for this day</div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Import Modal ─────────────────────────────────────────────────────────────

function ImportModal({ menuRecipes, onImport, onClose }: {
  menuRecipes: RecipeSummary[]
  onImport: (rows: { date: string; totalRevenue: string; covers: string; foodSalesPct: string; notes: string; lineItems: { recipeId: string; qtySold: number }[] }[]) => Promise<void>
  onClose: () => void
}) {
  const [file,       setFile]       = useState<File | null>(null)
  const [preview,    setPreview]    = useState<string[][]>([])
  const [error,      setError]      = useState('')
  const [importing,  setImporting]  = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const TEMPLATE_ROWS = [
    ['date', 'total_revenue', 'covers', 'food_sales_pct', 'notes'],
    ['2026-04-01', '5000', '120', '0.70', 'Friday night'],
    ['2026-04-02', '3200', '80', '0.75', ''],
  ]
  const downloadTemplate = () => {
    const csv = TEMPLATE_ROWS.map(r => r.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'sales_template.csv'; a.click()
  }

  const parseFile = (f: File) => {
    setError('')
    const reader = new FileReader()
    reader.onload = e => {
      const text = e.target?.result as string
      const rows = text.trim().split('\n').map(r => r.split(',').map(c => c.trim().replace(/^"|"$/g, '')))
      if (rows.length < 2) { setError('File must have at least a header row and one data row'); return }
      setPreview(rows.slice(0, 6))
    }
    reader.readAsText(f)
  }

  const handleFile = (f: File) => { setFile(f); parseFile(f) }

  const handleImport = async () => {
    if (!file) return
    setImporting(true)
    const reader = new FileReader()
    reader.onload = async e => {
      const text = e.target?.result as string
      const rows = text.trim().split('\n').map(r => r.split(',').map(c => c.trim().replace(/^"|"$/g, '')))
      const headers = rows[0].map(h => h.toLowerCase().replace(/\s+/g, '_'))
      const data = rows.slice(1).filter(r => r[0]).map(r => {
        const row: Record<string, string> = {}
        headers.forEach((h, i) => { row[h] = r[i] ?? '' })
        return {
          date: row['date'],
          totalRevenue: row['total_revenue'] || '0',
          covers: row['covers'] || '',
          foodSalesPct: row['food_sales_pct'] || '0.7',
          notes: row['notes'] || '',
          lineItems: [] as { recipeId: string; qtySold: number }[],
        }
      })
      await onImport(data)
      setImporting(false)
    }
    reader.readAsText(file)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4">
      <div className="bg-white w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl shadow-2xl">
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">Import Sales from CSV</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400"><X size={18} /></button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-sm text-blue-800">
            Upload a CSV with columns: <code className="bg-blue-100 px-1 rounded text-xs">date, total_revenue, covers, food_sales_pct, notes</code>.
            Dates must be in YYYY-MM-DD format. Export from Excel as &ldquo;CSV UTF-8&rdquo;.
          </div>

          <button onClick={downloadTemplate} className="flex items-center gap-2 text-sm text-blue-600 hover:underline">
            <Download size={14} /> Download template CSV
          </button>

          {/* Drop zone */}
          <div
            onClick={() => fileRef.current?.click()}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f) }}
            className="border-2 border-dashed border-gray-200 rounded-xl p-8 text-center cursor-pointer hover:border-blue-400 transition-colors"
          >
            <Upload size={24} className="mx-auto text-gray-300 mb-2" />
            <div className="text-sm text-gray-500">{file ? file.name : 'Click or drag a CSV file here'}</div>
            <input ref={fileRef} type="file" accept=".csv" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />
          </div>

          {error && <div className="text-sm text-red-500">{error}</div>}

          {/* Preview */}
          {preview.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-gray-100">
              <table className="w-full text-xs">
                <thead className="bg-gray-50">
                  <tr>{preview[0].map((h, i) => <th key={i} className="px-2 py-1.5 text-left font-medium text-gray-500">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {preview.slice(1).map((row, ri) => (
                    <tr key={ri} className="border-t border-gray-50">
                      {row.map((cell, ci) => <td key={ci} className="px-2 py-1.5 text-gray-700">{cell}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.length >= 6 && <div className="px-3 py-1.5 text-xs text-gray-400 bg-gray-50 border-t border-gray-100">Showing first 5 rows…</div>}
            </div>
          )}
        </div>
        <div className="px-5 pb-5 flex gap-3">
          <button onClick={onClose} className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
          <button onClick={handleImport} disabled={!file || importing}
            className="flex-1 px-4 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
            {importing ? 'Importing…' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SalesPage() {
  const [sales,         setSales]         = useState<Sale[]>([])
  const [menuRecipes,   setMenuRecipes]   = useState<RecipeSummary[]>([])
  const [loading,       setLoading]       = useState(true)
  const [rangeMode,     setRangeMode]     = useState<RangeMode>('week')
  const [customStart,   setCustomStart]   = useState('')
  const [customEnd,     setCustomEnd]     = useState('')
  const [sortCol,       setSortCol]       = useState<SortCol>('date')
  const [sortDir,       setSortDir]       = useState<SortDir>('desc')
  const [search,        setSearch]        = useState('')
  const [showAdd,       setShowAdd]       = useState(false)
  const [editSale,      setEditSale]      = useState<Sale | null>(null)
  const [viewSale,      setViewSale]      = useState<Sale | null>(null)
  const [showImport,    setShowImport]    = useState(false)
  const [deleteId,      setDeleteId]      = useState<string | null>(null)
  const [activeTab,     setActiveTab]     = useState<'list' | 'analytics'>('list')

  const [startDate, endDate] = getRange(rangeMode, customStart, customEnd)

  const fetchSales = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams({ startDate, endDate })
    const data = await fetch(`/api/sales?${params}`).then(r => r.json())
    setSales(Array.isArray(data) ? data : [])
    setLoading(false)
  }, [startDate, endDate])

  useEffect(() => { fetchSales() }, [fetchSales])

  useEffect(() => {
    fetch('/api/recipes?type=MENU').then(r => r.json()).then(d => {
      if (Array.isArray(d)) setMenuRecipes(d)
    })
  }, [])

  // ── KPIs ──
  const kpis = useMemo(() => {
    const totalRevenue  = sales.reduce((s, e) => s + Number(e.totalRevenue), 0)
    const totalFoodSales = sales.reduce((s, e) => s + Number(e.totalRevenue) * Number(e.foodSalesPct), 0)
    const totalCovers   = sales.reduce((s, e) => s + (e.covers ?? 0), 0)
    const days          = sales.length
    const avgDaily      = days > 0 ? totalRevenue / days : 0
    const avgPerCover   = totalCovers > 0 ? totalRevenue / totalCovers : 0
    const totalPortions = sales.reduce((s, e) => s + e.lineItems.reduce((ss, li) => ss + li.qtySold, 0), 0)
    return { totalRevenue, totalFoodSales, totalCovers, days, avgDaily, avgPerCover, totalPortions }
  }, [sales])

  // ── Top items ──
  const topItems = useMemo(() => {
    const map = new Map<string, { name: string; qty: number; revenue: number }>()
    for (const sale of sales) {
      for (const li of sale.lineItems) {
        const prev = map.get(li.recipeId) ?? { name: li.recipe.name, qty: 0, revenue: 0 }
        map.set(li.recipeId, {
          name: li.recipe.name,
          qty: prev.qty + li.qtySold,
          revenue: prev.revenue + (li.recipe.menuPrice ? Number(li.recipe.menuPrice) * li.qtySold : 0),
        })
      }
    }
    return Array.from(map.values()).sort((a, b) => b.qty - a.qty).slice(0, 15)
  }, [sales])

  // ── Sorted + filtered list ──
  const displayed = useMemo(() => {
    let list = [...sales]
    if (search) list = list.filter(s =>
      new Date(s.date).toLocaleDateString().includes(search) || (s.notes ?? '').toLowerCase().includes(search.toLowerCase())
    )
    list.sort((a, b) => {
      let diff = 0
      if (sortCol === 'date')    diff = new Date(a.date).getTime() - new Date(b.date).getTime()
      if (sortCol === 'revenue') diff = Number(a.totalRevenue) - Number(b.totalRevenue)
      if (sortCol === 'covers')  diff = (a.covers ?? 0) - (b.covers ?? 0)
      if (sortCol === 'items')   diff = a.lineItems.reduce((s,l)=>s+l.qtySold,0) - b.lineItems.reduce((s,l)=>s+l.qtySold,0)
      return sortDir === 'asc' ? diff : -diff
    })
    return list
  }, [sales, search, sortCol, sortDir])

  const toggleSort = (col: SortCol) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('desc') }
  }

  const SortIcon = ({ col }: { col: SortCol }) =>
    sortCol === col
      ? (sortDir === 'asc' ? <ChevronUp size={12} className="text-blue-600 inline ml-1" /> : <ChevronDown size={12} className="text-blue-600 inline ml-1" />)
      : <ArrowUpDown size={12} className="text-gray-300 inline ml-1" />

  // ── CRUD handlers ──
  const handleSave = async (data: Parameters<SaleFormProps['onSave']>[0]) => {
    if (editSale) {
      await fetch(`/api/sales/${editSale.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      setEditSale(null)
    } else {
      await fetch('/api/sales', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      setShowAdd(false)
    }
    fetchSales()
  }

  const handleDelete = async (id: string) => {
    await fetch(`/api/sales/${id}`, { method: 'DELETE' })
    setDeleteId(null)
    if (viewSale?.id === id) setViewSale(null)
    fetchSales()
  }

  const handleImport = async (rows: Parameters<Parameters<typeof ImportModal>[0]['onImport']>[0]) => {
    for (const row of rows) {
      await fetch('/api/sales', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(row) })
    }
    setShowImport(false)
    fetchSales()
  }

  const maxRevenue = Math.max(...displayed.map(s => Number(s.totalRevenue)), 1)

  return (
    <div className="space-y-4 pb-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Sales</h1>
          <p className="text-sm text-gray-500 mt-0.5">Daily sales records · inventory consumption tracking</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowImport(true)}
            className="flex items-center gap-2 border border-gray-200 bg-white text-gray-700 px-3 py-2 rounded-lg text-sm hover:bg-gray-50 transition-colors">
            <Upload size={15} /> Import CSV
          </button>
          <button onClick={() => setShowAdd(true)}
            className="flex items-center gap-2 bg-blue-600 text-white px-3 py-2 rounded-lg text-sm hover:bg-blue-700 transition-colors">
            <Plus size={15} /> Add Sales Day
          </button>
        </div>
      </div>

      {/* Date range tabs */}
      <div className="flex items-center gap-2 flex-wrap">
        {(['week', 'month', 'lastMonth', 'custom'] as RangeMode[]).map(mode => (
          <button key={mode} onClick={() => setRangeMode(mode)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              rangeMode === mode ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300'
            }`}>
            {{ week: 'This Week', month: 'This Month', lastMonth: 'Last Month', custom: 'Custom' }[mode]}
          </button>
        ))}
        {rangeMode === 'custom' && (
          <div className="flex items-center gap-2 ml-1">
            <input type="date" value={customStart} onChange={e => setCustomStart(e.target.value)}
              className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            <span className="text-gray-400 text-sm">to</span>
            <input type="date" value={customEnd} onChange={e => setCustomEnd(e.target.value)}
              className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
        )}
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard label="Total Revenue" value={formatCurrency(kpis.totalRevenue)} sub={`${kpis.days} days`} accent="text-green-600" />
        <KpiCard label="Food Sales" value={formatCurrency(kpis.totalFoodSales)} sub="estimated" accent="text-blue-600" />
        <KpiCard label="Total Covers" value={kpis.totalCovers.toLocaleString()} sub="guests" accent="text-gray-900" />
        <KpiCard label="Avg per Cover" value={kpis.avgPerCover > 0 ? formatCurrency(kpis.avgPerCover) : '—'} />
        <KpiCard label="Avg Daily" value={kpis.avgDaily > 0 ? formatCurrency(kpis.avgDaily) : '—'} />
        <KpiCard label="Portions Sold" value={kpis.totalPortions.toLocaleString()} sub="menu items" accent="text-purple-600" />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-100">
        {([['list', 'Sales Log'], ['analytics', 'Top Items']] as const).map(([tab, label]) => (
          <button key={tab} onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}>
            {label}
          </button>
        ))}
      </div>

      {/* Sales Log Tab */}
      {activeTab === 'list' && (
        <>
          <div className="relative max-w-xs">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search days…"
              className="w-full pl-8 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>

          <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-500 cursor-pointer" onClick={() => toggleSort('date')}>
                    Date <SortIcon col="date" />
                  </th>
                  <th className="px-3 py-3 text-right font-medium text-gray-500 cursor-pointer" onClick={() => toggleSort('revenue')}>
                    Revenue <SortIcon col="revenue" />
                  </th>
                  <th className="px-3 py-3 text-right font-medium text-gray-500 hidden sm:table-cell cursor-pointer" onClick={() => toggleSort('covers')}>
                    Covers <SortIcon col="covers" />
                  </th>
                  <th className="px-3 py-3 text-right font-medium text-gray-500 hidden md:table-cell cursor-pointer" onClick={() => toggleSort('items')}>
                    Portions <SortIcon col="items" />
                  </th>
                  <th className="px-3 py-3 text-left font-medium text-gray-500 hidden lg:table-cell">Bar</th>
                  <th className="px-3 py-3 w-16" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {loading && (
                  <tr><td colSpan={6} className="text-center py-12 text-gray-400">Loading…</td></tr>
                )}
                {!loading && displayed.length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-center py-12">
                      <div className="text-gray-400 mb-3">No sales recorded for this period</div>
                      <button onClick={() => setShowAdd(true)}
                        className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">
                        <Plus size={14} /> Add Sales Day
                      </button>
                    </td>
                  </tr>
                )}
                {displayed.map(sale => {
                  const rev = Number(sale.totalRevenue)
                  const portions = sale.lineItems.reduce((s, l) => s + l.qtySold, 0)
                  const pct = (rev / maxRevenue) * 100
                  return (
                    <tr key={sale.id}
                      onClick={() => setViewSale(sale)}
                      className="hover:bg-gray-50 cursor-pointer">
                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-800">{fmtDate(sale.date)}</div>
                        <div className="text-xs text-gray-400">{fmtDay(sale.date)}{sale.notes ? ` · ${sale.notes}` : ''}</div>
                      </td>
                      <td className="px-3 py-3 text-right">
                        <div className="font-semibold text-gray-900">{formatCurrency(rev)}</div>
                        <div className="text-xs text-gray-400">{Math.round(Number(sale.foodSalesPct) * 100)}% food</div>
                      </td>
                      <td className="px-3 py-3 text-right hidden sm:table-cell">
                        <div className="font-medium text-gray-700">{sale.covers ?? '—'}</div>
                        {sale.covers && rev > 0 && (
                          <div className="text-xs text-gray-400">{formatCurrency(rev / sale.covers)}/cover</div>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right hidden md:table-cell">
                        <div className="font-medium text-gray-700">{portions > 0 ? portions : '—'}</div>
                        {portions > 0 && <div className="text-xs text-gray-400">{sale.lineItems.length} items</div>}
                      </td>
                      <td className="px-3 py-3 hidden lg:table-cell">
                        <div className="h-2 bg-gray-100 rounded-full w-32">
                          <div className="h-full bg-blue-400 rounded-full" style={{ width: `${pct}%` }} />
                        </div>
                      </td>
                      <td className="px-3 py-3" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center gap-1 justify-end">
                          <button onClick={() => setEditSale(sale)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-blue-600">
                            <Pencil size={13} />
                          </button>
                          <button onClick={() => setDeleteId(sale.id)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-red-500">
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Top Items Tab */}
      {activeTab === 'analytics' && (
        <div className="space-y-4">
          {topItems.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-100 p-12 text-center text-gray-400">
              No sales data for this period — add sales days with menu item quantities to see analytics.
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
                <TrendingUp size={15} className="text-gray-400" />
                <span className="text-sm font-semibold text-gray-700">Top selling items</span>
                <span className="text-xs text-gray-400 ml-auto">{startDate} — {endDate}</span>
              </div>
              <div className="divide-y divide-gray-50">
                {topItems.map((item, i) => {
                  const maxQty = topItems[0]?.qty ?? 1
                  const pct = (item.qty / maxQty) * 100
                  return (
                    <div key={item.name} className="px-4 py-3 flex items-center gap-3">
                      <div className="w-6 text-xs font-bold text-gray-400 shrink-0">{i + 1}</div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-gray-800 truncate">{item.name}</div>
                        <div className="h-1.5 bg-gray-100 rounded-full mt-1.5 overflow-hidden">
                          <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-sm font-semibold text-gray-900">{item.qty.toLocaleString()} sold</div>
                        {item.revenue > 0 && <div className="text-xs text-gray-400">{formatCurrency(item.revenue)}</div>}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Modals */}
      {(showAdd || editSale) && (
        <SaleForm
          initial={editSale}
          menuRecipes={menuRecipes}
          onSave={handleSave}
          onCancel={() => { setShowAdd(false); setEditSale(null) }}
        />
      )}

      {viewSale && (
        <DayDetail
          sale={viewSale}
          onEdit={() => { setEditSale(viewSale); setViewSale(null) }}
          onClose={() => setViewSale(null)}
        />
      )}

      {showImport && (
        <ImportModal menuRecipes={menuRecipes} onImport={handleImport} onClose={() => setShowImport(false)} />
      )}

      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center shrink-0">
                <Trash2 size={18} className="text-red-600" />
              </div>
              <div>
                <h3 className="font-semibold text-gray-900">Delete sales entry?</h3>
                <p className="text-xs text-gray-500 mt-0.5">This cannot be undone.</p>
              </div>
            </div>
            <div className="flex gap-3 mt-4">
              <button onClick={() => setDeleteId(null)}
                className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50">
                Cancel
              </button>
              <button onClick={() => handleDelete(deleteId)}
                className="flex-1 px-4 py-2.5 rounded-xl bg-red-600 text-white text-sm font-medium hover:bg-red-700">
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
