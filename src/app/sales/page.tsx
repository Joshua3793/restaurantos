'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUpDown, BarChart2, Calendar, Check, ChevronDown, ChevronUp,
  Pencil, Plus, Search, Trash2, TrendingUp, Upload, Users, X,
} from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import { useRc } from '@/contexts/RevenueCenterContext'
import { rcHex } from '@/lib/rc-colors'

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
  revenueCenterId: string | null
  revenueCenter: { id: string; name: string; color: string } | null
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

interface RcOption { id: string; name: string; color: string }

interface SaleFormProps {
  initial?: Sale | null
  menuRecipes: RecipeSummary[]
  revenueCenters: RcOption[]
  defaultRcId: string | null
  onSave: (data: {
    date: string; totalRevenue: string; foodSalesPct: string
    covers: string; notes: string
    revenueCenterId: string | null
    lineItems: { recipeId: string; qtySold: number }[]
  }) => Promise<void>
  onCancel: () => void
}

function SaleForm({ initial, menuRecipes, revenueCenters, defaultRcId, onSave, onCancel }: SaleFormProps) {
  const [date,          setDate]          = useState(initial ? toISO(new Date(initial.date)) : toISO(new Date()))
  const [revenue,       setRevenue]       = useState(initial ? String(initial.totalRevenue) : '')
  const [foodPct,       setFoodPct]       = useState(initial ? String(Math.round(Number(initial.foodSalesPct) * 100)) : '70')
  const [covers,        setCovers]        = useState(initial ? String(initial.covers ?? '') : '')
  const [notes,         setNotes]         = useState(initial?.notes ?? '')
  const [rcId,          setRcId]          = useState<string | null>(initial ? initial.revenueCenterId : defaultRcId)
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
    await onSave({ date, totalRevenue: revenue, foodSalesPct: String(parseFloat(foodPct) / 100), covers, notes, revenueCenterId: rcId, lineItems })
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
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Covers (guests)</label>
                <input type="number" min="0" value={covers} onChange={e => setCovers(e.target.value)}
                  placeholder="0"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
              </div>
            </div>

            {/* Revenue center */}
            {revenueCenters.length > 0 && (
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Revenue Center</label>
                <div className="flex flex-wrap gap-1.5">
                  {revenueCenters.map(rc => {
                    const active = rcId === rc.id
                    return (
                      <button
                        key={rc.id}
                        type="button"
                        onClick={() => setRcId(rc.id)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                          active ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-700 border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: rcHex(rc.color) }} />
                        {rc.name}
                      </button>
                    )
                  })}
                  <button
                    type="button"
                    onClick={() => setRcId(null)}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                      rcId === null ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    Unassigned
                  </button>
                </div>
              </div>
            )}

            {/* Row 2: revenue + food % */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Total Revenue ($)</label>
                <input type="number" required min="0" step="0.01" value={revenue} onChange={e => setRevenue(e.target.value)}
                  placeholder="0.00"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Food Sales %</label>
                <div className="relative">
                  <input type="number" min="0" max="100" value={foodPct} onChange={e => setFoodPct(e.target.value)}
                    placeholder="70"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">%</span>
                </div>
              </div>
            </div>

            {/* Notes */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Notes</label>
              <input value={notes} onChange={e => setNotes(e.target.value)}
                placeholder="e.g. Busy Friday night, private event..."
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
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
                  className="w-full pl-8 pr-3 py-2 border border-gray-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-gold" />
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
                      className="w-20 border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-gold"
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
              className="flex-1 px-4 py-2.5 rounded-xl bg-gold text-white text-sm font-medium hover:bg-[#a88930] disabled:opacity-60">
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
            <div className="flex items-center gap-2">
              <div className="text-base font-semibold text-gray-900">{fmtDate(sale.date)}</div>
              {sale.revenueCenter && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-gray-100 text-gray-700">
                  <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: rcHex(sale.revenueCenter.color) }} />
                  {sale.revenueCenter.name}
                </span>
              )}
            </div>
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

// ─── Import Modal (Toast POS ProductMix) ─────────────────────────────────────

interface ParsedItem {
  rawName: string
  qtySold: number
  matchedRecipeId: string | null
  matchedRecipeName: string | null
  matchConfidence: 'exact' | 'fuzzy' | 'none'
}

interface ParseResult {
  date: string
  totalSales: number
  foodSales: number
  items: ParsedItem[]
}

function ConfidenceBadge({ c }: { c: ParsedItem['matchConfidence'] }) {
  if (c === 'exact')  return <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-green-100 text-green-700">matched</span>
  if (c === 'fuzzy')  return <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">fuzzy</span>
  return <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">unmatched</span>
}

function ImportModal({ menuRecipes, onImport, onClose }: {
  menuRecipes: RecipeSummary[]
  onImport: (row: { date: string; totalRevenue: string; covers: string; foodSalesPct: string; notes: string; lineItems: { recipeId: string; qtySold: number }[] }) => Promise<void>
  onClose: () => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [step,     setStep]     = useState<'upload' | 'review'>('upload')
  const [file,     setFile]     = useState<File | null>(null)
  const [parsing,  setParsing]  = useState(false)
  const [parseErr, setParseErr] = useState('')
  const [parsed,   setParsed]   = useState<ParseResult | null>(null)
  const [saving,   setSaving]   = useState(false)

  // Editable review fields
  const [date,       setDate]       = useState('')
  const [totalSales, setTotalSales] = useState('')
  const [foodSales,  setFoodSales]  = useState('')
  const [qtys,       setQtys]       = useState<Record<string, number>>({})
  // recipeId overrides for unmatched/fuzzy items
  const [overrides,  setOverrides]  = useState<Record<string, string>>({})

  const handleFile = async (f: File) => {
    setFile(f)
    setParseErr('')
    setParsing(true)
    try {
      const form = new FormData()
      form.append('file', f)
      const res = await fetch('/api/sales/import', { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Parse failed')
      const result = data as ParseResult
      setParsed(result)
      setDate(result.date)
      setTotalSales(String(result.totalSales))
      setFoodSales(String(result.foodSales))
      // Initialise qtys from parsed items (keyed by rawName, then recipeId when confirmed)
      const qMap: Record<string, number> = {}
      for (const item of result.items) {
        if (item.matchedRecipeId) qMap[item.matchedRecipeId] = item.qtySold
      }
      setQtys(qMap)
      setOverrides({})
      setStep('review')
    } catch (err: unknown) {
      setParseErr(err instanceof Error ? err.message : 'Failed to parse file')
    } finally {
      setParsing(false)
    }
  }

  const handleSave = async () => {
    if (!parsed) return
    setSaving(true)
    const total = parseFloat(totalSales) || 0
    const food  = parseFloat(foodSales)  || 0
    const foodSalesPct = total > 0 ? String((food / total).toFixed(4)) : '0.7'

    // Build lineItems from matched items (respecting overrides)
    const lineItems: { recipeId: string; qtySold: number }[] = []
    for (const item of parsed.items) {
      const recipeId = overrides[item.rawName] ?? item.matchedRecipeId
      if (!recipeId) continue
      const qty = qtys[recipeId] ?? item.qtySold
      if (qty > 0) lineItems.push({ recipeId, qtySold: qty })
    }

    await onImport({ date, totalRevenue: totalSales, covers: '', foodSalesPct, notes: '', lineItems })
    setSaving(false)
  }

  const foodPct = (() => {
    const t = parseFloat(totalSales) || 0
    const f = parseFloat(foodSales)  || 0
    return t > 0 ? Math.round((f / t) * 100) : 0
  })()

  const matched   = parsed?.items.filter(i => (overrides[i.rawName] ?? i.matchedRecipeId) !== null) ?? []
  const unmatched = parsed?.items.filter(i => (overrides[i.rawName] ?? i.matchedRecipeId) === null) ?? []

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4">
      <div className="bg-white w-full sm:max-w-2xl rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[92vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-gray-100 shrink-0">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Import from Toast POS</h2>
            {step === 'review' && <p className="text-xs text-gray-400 mt-0.5">Review and confirm before saving</p>}
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400"><X size={18} /></button>
        </div>

        {/* ── Upload step ── */}
        {step === 'upload' && (
          <div className="px-5 py-5 space-y-4">
            <div className="bg-gold/10 border border-blue-100 rounded-xl p-3 text-sm text-blue-800">
              Upload the <strong>ProductMix</strong> Excel exported from Toast POS. The system will extract food sales totals and BRUNCH item quantities automatically.
            </div>

            <div
              onClick={() => fileRef.current?.click()}
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f) }}
              className="border-2 border-dashed border-gray-200 rounded-xl p-10 text-center cursor-pointer hover:border-blue-400 transition-colors"
            >
              {parsing ? (
                <div className="text-sm text-gray-500">Parsing file…</div>
              ) : (
                <>
                  <Upload size={28} className="mx-auto text-gray-300 mb-2" />
                  <div className="text-sm font-medium text-gray-600">{file ? file.name : 'Click or drag your ProductMix file here'}</div>
                  <div className="text-xs text-gray-400 mt-1">Accepts .xlsx or .csv</div>
                </>
              )}
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />
            </div>

            {parseErr && (
              <div className="text-sm text-red-500 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{parseErr}</div>
            )}

            <div className="flex gap-3 pt-1">
              <button onClick={onClose} className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
            </div>
          </div>
        )}

        {/* ── Review step ── */}
        {step === 'review' && parsed && (
          <>
            <div className="px-5 py-4 overflow-y-auto flex-1 space-y-5">

              {/* Date + Totals */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">Date</label>
                  <input type="date" value={date} onChange={e => setDate(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">Total Net Sales</label>
                  <div className="relative">
                    <span className="absolute left-3 top-2 text-gray-400 text-sm">$</span>
                    <input type="number" min="0" step="0.01" value={totalSales} onChange={e => setTotalSales(e.target.value)}
                      className="w-full border border-gray-200 rounded-lg pl-7 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">
                    Food Sales <span className="text-gray-400 font-normal">({foodPct}%)</span>
                  </label>
                  <div className="relative">
                    <span className="absolute left-3 top-2 text-gray-400 text-sm">$</span>
                    <input type="number" min="0" step="0.01" value={foodSales} onChange={e => setFoodSales(e.target.value)}
                      className="w-full border border-gray-200 rounded-lg pl-7 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                  </div>
                </div>
              </div>

              {/* Matched items */}
              <div>
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                  BRUNCH items · {parsed.items.length} from Toast · {matched.length} matched
                </div>
                <div className="border border-gray-100 rounded-xl overflow-hidden divide-y divide-gray-50">
                  {parsed.items.map(item => {
                    const recipeId = overrides[item.rawName] ?? item.matchedRecipeId
                    const confidence = overrides[item.rawName] ? 'exact' : item.matchConfidence
                    const qty = recipeId ? (qtys[recipeId] ?? item.qtySold) : item.qtySold
                    return (
                      <div key={item.rawName} className="flex items-center gap-3 px-3 py-2.5">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-gray-800 truncate">{item.rawName}</span>
                            <ConfidenceBadge c={confidence} />
                          </div>
                          {/* Recipe selector */}
                          <select
                            value={recipeId ?? ''}
                            onChange={e => {
                              const val = e.target.value
                              setOverrides(o => ({ ...o, [item.rawName]: val }))
                              if (val && !qtys[val]) {
                                setQtys(q => ({ ...q, [val]: item.qtySold }))
                              }
                            }}
                            className="mt-1 w-full border border-gray-100 rounded-lg px-2 py-1 text-xs text-gray-600 focus:outline-none focus:ring-1 focus:ring-gold bg-gray-50"
                          >
                            <option value="">— not matched —</option>
                            {menuRecipes.map(r => (
                              <option key={r.id} value={r.id}>{r.name}</option>
                            ))}
                          </select>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <span className="text-xs text-gray-400">×</span>
                          <input
                            type="number" min="0" step="1"
                            value={recipeId ? qty : item.qtySold}
                            onChange={e => {
                              const rid = recipeId
                              if (rid) setQtys(q => ({ ...q, [rid]: parseInt(e.target.value) || 0 }))
                            }}
                            className="w-16 border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-gold"
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>

              {unmatched.length > 0 && (
                <div className="text-xs text-amber-600 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                  {unmatched.length} item{unmatched.length > 1 ? 's' : ''} not matched to a menu recipe — they won&apos;t be recorded. Use the dropdown above to assign them.
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-5 pb-5 pt-3 border-t border-gray-100 shrink-0 flex gap-3">
              <button onClick={() => setStep('upload')} className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50">
                ← Back
              </button>
              <button onClick={handleSave} disabled={saving}
                className="flex-1 px-4 py-2.5 rounded-xl bg-gold text-white text-sm font-medium hover:bg-[#a88930] disabled:opacity-60">
                {saving ? 'Saving…' : `Save sales for ${date}`}
              </button>
            </div>
          </>
        )}
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

  const { activeRcId, activeRc, revenueCenters } = useRc()

  const [startDate, endDate] = getRange(rangeMode, customStart, customEnd)

  const fetchSales = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams({ startDate, endDate })
    if (activeRcId) {
      params.set('rcId', activeRcId)
      if (activeRc?.isDefault) params.set('isDefault', 'true')
    }
    const data = await fetch(`/api/sales?${params}`).then(r => r.json())
    setSales(Array.isArray(data) ? data : [])
    setLoading(false)
  }, [startDate, endDate, activeRcId, activeRc])

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
      ? (sortDir === 'asc' ? <ChevronUp size={12} className="text-gold inline ml-1" /> : <ChevronDown size={12} className="text-gold inline ml-1" />)
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

  const handleImport = async (row: Parameters<Parameters<typeof ImportModal>[0]['onImport']>[0]) => {
    await fetch('/api/sales', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...row, revenueCenterId: activeRcId }) })
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
            <Upload size={15} /> Import
          </button>
          <button onClick={() => setShowAdd(true)}
            className="flex items-center gap-2 bg-gold text-white px-3 py-2 rounded-lg text-sm hover:bg-[#a88930] transition-colors">
            <Plus size={15} /> Add Sales Day
          </button>
        </div>
      </div>

      {/* Date range tabs */}
      <div className="flex items-center gap-2 flex-wrap">
        {(['week', 'month', 'lastMonth', 'custom'] as RangeMode[]).map(mode => (
          <button key={mode} onClick={() => setRangeMode(mode)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              rangeMode === mode ? 'bg-gold text-white' : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300'
            }`}>
            {{ week: 'This Week', month: 'This Month', lastMonth: 'Last Month', custom: 'Custom' }[mode]}
          </button>
        ))}
        {rangeMode === 'custom' && (
          <div className="flex items-center gap-2 ml-1">
            <input type="date" value={customStart} onChange={e => setCustomStart(e.target.value)}
              className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
            <span className="text-gray-400 text-sm">to</span>
            <input type="date" value={customEnd} onChange={e => setCustomEnd(e.target.value)}
              className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
          </div>
        )}
      </div>

      {/* Onboarding card — shown when no sales have ever been recorded */}
      {!loading && sales.length === 0 && rangeMode === 'week' && (
        <div className="bg-gold/10 border border-blue-100 rounded-xl p-5 flex gap-4 items-start">
          <div className="w-10 h-10 rounded-xl bg-gold/15 flex items-center justify-center shrink-0">
            <BarChart2 size={20} className="text-gold" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-blue-900 text-sm mb-1">Record your daily sales to unlock food cost tracking</h3>
            <p className="text-xs text-gold leading-relaxed mb-3">
              Add each service day — total revenue, covers, and which menu items sold. This powers the food cost % calculation in your dashboard and analytics.
              You can also <button onClick={() => setShowImport(true)} className="underline font-medium">import from Toast POS</button> if you have a ProductMix export.
            </p>
            <button onClick={() => setShowAdd(true)}
              className="inline-flex items-center gap-2 bg-gold text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#a88930] transition-colors">
              <Plus size={14} /> Add First Sales Day
            </button>
          </div>
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard label="Total Revenue" value={formatCurrency(kpis.totalRevenue)} sub={`${kpis.days} days`} accent="text-green-600" />
        <KpiCard label="Food Sales" value={formatCurrency(kpis.totalFoodSales)} sub="estimated" accent="text-gold" />
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
              activeTab === tab ? 'border-gold text-gold' : 'border-transparent text-gray-500 hover:text-gray-700'
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
              className="w-full pl-8 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
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
                        className="inline-flex items-center gap-2 px-4 py-2 bg-gold text-white rounded-lg text-sm hover:bg-[#a88930]">
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
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-gray-800">{fmtDate(sale.date)}</span>
                          {sale.revenueCenter && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-gray-100 text-gray-600">
                              <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: rcHex(sale.revenueCenter.color) }} />
                              {sale.revenueCenter.name}
                            </span>
                          )}
                        </div>
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
                          <button onClick={() => setEditSale(sale)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gold">
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
                          <div className="h-full bg-gold/100 rounded-full transition-all" style={{ width: `${pct}%` }} />
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
          revenueCenters={revenueCenters}
          defaultRcId={activeRcId}
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
