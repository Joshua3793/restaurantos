'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUpDown, BarChart2, Calendar, Check, ChevronDown, ChevronUp,
  Pencil, Plus, Search, Trash2, TrendingUp, Upload, Users, X, Zap, AlertTriangle,
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
  periodType: string
  endDate: string | null
  source: string // 'toast' (auto) | 'manual'
}

type RangeMode = 'week' | 'month' | 'lastMonth' | 'custom'
type SortCol = 'date' | 'revenue' | 'covers' | 'items'
type SortDir = 'asc' | 'desc'

type Granularity = 'day' | 'week' | 'month'

interface PeriodRow {
  key: string
  label: string
  startDate: string
  endDate: string
  totalRevenue: number
  foodSalesPct: number
  covers: number | null
  badge: 'weekly-import' | 'monthly-import' | 'complete' | 'partial' | 'not-available'
  badgeText: string
  directSale: Sale | null
  dailySales: Sale[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function startOfWeek(d: Date) {
  const r = new Date(d)
  r.setDate(r.getDate() - r.getDay())
  r.setHours(0, 0, 0, 0)
  return r
}

function toISO(d: Date) { return d.toISOString().slice(0, 10) }

// Dates are stored at UTC midnight; parse the date-portion as LOCAL so the
// calendar day doesn't shift back a day in negative-offset timezones (Pacific).
function fmtDate(s: string) {
  return new Date(s.slice(0, 10) + 'T00:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })
}

function fmtDay(s: string) {
  return new Date(s.slice(0, 10) + 'T00:00:00').toLocaleDateString('en-CA', { weekday: 'short' })
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

function isoWeekStart(d: Date): Date {
  const r = new Date(d)
  r.setHours(0, 0, 0, 0)
  const day = r.getDay()
  r.setDate(r.getDate() - ((day + 6) % 7))
  return r
}

function buildWeekRows(sales: Sale[], rangeStart: string, rangeEnd: string): PeriodRow[] {
  const rows: PeriodRow[] = []
  let cursor = isoWeekStart(new Date(rangeStart))
  const rangeEndDate = new Date(rangeEnd + 'T23:59:59')

  while (cursor <= rangeEndDate) {
    const weekEnd = new Date(cursor)
    weekEnd.setDate(cursor.getDate() + 6)
    const weekStartISO = toISO(cursor)
    const weekEndISO   = toISO(weekEnd)

    const directImport = sales.find(
      s => s.periodType === 'week' &&
        toISO(isoWeekStart(new Date(s.date))) === weekStartISO
    )
    const dailies = sales.filter(
      s => s.periodType === 'day' &&
        s.date.slice(0, 10) >= weekStartISO &&
        s.date.slice(0, 10) <= weekEndISO
    )

    let badge: PeriodRow['badge']
    let badgeText: string
    let totalRevenue: number
    let foodSalesPct: number
    let covers: number | null

    if (directImport) {
      badge = 'weekly-import'; badgeText = 'Weekly import'
      totalRevenue = Number(directImport.totalRevenue)
      foodSalesPct = Number(directImport.foodSalesPct)
      covers = directImport.covers
    } else if (dailies.length === 0) {
      badge = 'not-available'; badgeText = 'Not available'
      totalRevenue = 0; foodSalesPct = 0.7; covers = null
    } else {
      const totalRev       = dailies.reduce((s, d) => s + Number(d.totalRevenue), 0)
      const totalFoodSales = dailies.reduce((s, d) => s + Number(d.totalRevenue) * Number(d.foodSalesPct), 0)
      badge     = dailies.length >= 7 ? 'complete' : 'partial'
      badgeText = `${dailies.length}/7 days`
      totalRevenue = totalRev
      foodSalesPct = totalRev > 0 ? totalFoodSales / totalRev : 0.7
      covers       = dailies.reduce((s, d) => s + (d.covers ?? 0), 0) || null
    }

    const lStart = cursor.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })
    const lEnd   = weekEnd.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })

    rows.push({
      key: `w-${weekStartISO}`,
      label: `${lStart} – ${lEnd}`,
      startDate: weekStartISO,
      endDate: weekEndISO,
      totalRevenue,
      foodSalesPct,
      covers,
      badge,
      badgeText,
      directSale: directImport ?? null,
      dailySales: dailies,
    })

    cursor = new Date(cursor)
    cursor.setDate(cursor.getDate() + 7)
  }

  return rows.reverse()
}

function buildMonthRows(sales: Sale[], rangeStart: string, rangeEnd: string): PeriodRow[] {
  const rows: PeriodRow[] = []
  const rangeStartDate = new Date(rangeStart)
  const rangeEndDate   = new Date(rangeEnd + 'T23:59:59')

  let cursor = new Date(rangeStartDate.getFullYear(), rangeStartDate.getMonth(), 1)
  while (cursor <= rangeEndDate) {
    const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0)
    const monthStartISO = toISO(cursor)
    const monthEndISO   = toISO(monthEnd)

    const directImport = sales.find(
      s => s.periodType === 'month' &&
        new Date(s.date).getFullYear() === cursor.getFullYear() &&
        new Date(s.date).getMonth()    === cursor.getMonth()
    )

    const contributing = sales.filter(
      s => s.periodType !== 'month' &&
        s.date.slice(0, 10) >= monthStartISO &&
        s.date.slice(0, 10) <= monthEndISO
    )
    const dailies = contributing.filter(s => s.periodType === 'day')

    let badge: PeriodRow['badge']
    let badgeText: string
    let totalRevenue: number
    let foodSalesPct: number
    let covers: number | null

    if (directImport) {
      badge = 'monthly-import'; badgeText = 'Monthly import'
      totalRevenue = Number(directImport.totalRevenue)
      foodSalesPct = Number(directImport.foodSalesPct)
      covers = directImport.covers
    } else if (contributing.length === 0) {
      badge = 'not-available'; badgeText = 'Not available'
      totalRevenue = 0; foodSalesPct = 0.7; covers = null
    } else {
      const totalRev       = contributing.reduce((s, e) => s + Number(e.totalRevenue), 0)
      const totalFoodSales = contributing.reduce((s, e) => s + Number(e.totalRevenue) * Number(e.foodSalesPct), 0)
      const coveredDays    = new Set(dailies.map(d => d.date.slice(0, 10)))
      const daysInMonth    = monthEnd.getDate()
      badge     = coveredDays.size >= daysInMonth ? 'complete' : 'partial'
      badgeText = `${coveredDays.size}/${daysInMonth} days`
      totalRevenue = totalRev
      foodSalesPct = totalRev > 0 ? totalFoodSales / totalRev : 0.7
      covers       = contributing.reduce((s, e) => s + (e.covers ?? 0), 0) || null
    }

    rows.push({
      key: `m-${monthStartISO}`,
      label: cursor.toLocaleDateString('en-CA', { month: 'long', year: 'numeric' }),
      startDate: monthStartISO,
      endDate: monthEndISO,
      totalRevenue,
      foodSalesPct,
      covers,
      badge,
      badgeText,
      directSale: directImport ?? null,
      dailySales: dailies,
    })

    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
  }

  return rows.reverse()
}

// ─── Source dedupe (prefer Toast over a manual duplicate for the same day+RC) ──

// A single-day entry: a Toast day, or a manual day/single-day custom. Multi-day
// period imports (week/month/spanning custom) are NOT deduped against Toast days.
function isSingleDay(s: Sale): boolean {
  if (s.periodType === 'day') return true
  if (!s.endDate) return true
  return s.endDate.slice(0, 10) === s.date.slice(0, 10)
}
function dayKey(s: Sale): string {
  return `${s.date.slice(0, 10)}|${s.revenueCenterId ?? ''}`
}

/** Collapse single-day collisions, keeping the Toast row when present. Multi-day
 *  entries pass through untouched. Used for KPIs / rollups / Top Items so a Toast
 *  + manual duplicate doesn't double-count. */
function dedupeSales(sales: Sale[]): Sale[] {
  const winner = new Map<string, Sale>()
  const passthrough: Sale[] = []
  for (const s of sales) {
    if (!isSingleDay(s)) { passthrough.push(s); continue }
    const k = dayKey(s)
    const cur = winner.get(k)
    if (!cur) winner.set(k, s)
    else if (cur.source !== 'toast' && s.source === 'toast') winner.set(k, s)
  }
  return [...winner.values(), ...passthrough]
}

/** IDs of manual single-day entries shadowed by a Toast entry on the same day+RC. */
function duplicateManualIds(sales: Sale[]): Set<string> {
  const hasToast = new Set<string>()
  for (const s of sales) if (s.source === 'toast' && isSingleDay(s)) hasToast.add(dayKey(s))
  const dups = new Set<string>()
  for (const s of sales) if (s.source !== 'toast' && isSingleDay(s) && hasToast.has(dayKey(s))) dups.add(s.id)
  return dups
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────

function PeriodBadge({ badge, text }: { badge: PeriodRow['badge']; text: string }) {
  const cls = {
    'weekly-import':  'bg-blue-soft text-blue-text',
    'monthly-import': 'bg-blue-soft text-blue-text',
    'complete':       'bg-green-soft text-green-text',
    'partial':        'bg-gold-soft text-gold-2',
    'not-available':  'bg-bg-2 text-ink-4',
  }[badge]
  return <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${cls}`}>{text}</span>
}

function SourceBadge({ source }: { source: string }) {
  if (source === 'toast') return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-gold-soft text-gold-2" title="Synced automatically from Toast">
      <Zap size={9} /> Toast
    </span>
  )
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-bg-2 text-ink-3" title="Entered manually">
      <Pencil size={9} /> Manual
    </span>
  )
}

function SyncHealthStrip({ sales }: { sales: Sale[] }) {
  const toastSales = sales.filter(s => s.source === 'toast')
  if (toastSales.length === 0) return null // RC with no Toast data (e.g. CATERING) — strip is irrelevant
  const lastSync = toastSales.map(s => s.date).sort().at(-1)!
  const days = new Set(toastSales.map(s => s.date.slice(0, 10))).size
  return (
    <div className="flex items-center gap-2 flex-wrap bg-white border border-line rounded-xl px-3 py-2 text-xs shadow-sm">
      <Zap size={13} className="text-gold" />
      <span className="font-medium text-ink-2">Toast auto-sync</span>
      <span className="text-ink-4">· last synced {fmtDate(lastSync)} · {days} day{days === 1 ? '' : 's'} in this range</span>
      <a href="/setup/toast" className="ml-auto text-gold hover:text-gold-2 font-medium">Manage in Setup →</a>
    </div>
  )
}

function KpiCard({ label, value, sub, accent = 'text-ink' }: {
  label: string; value: string; sub?: string; accent?: string
}) {
  return (
    <div className="bg-white rounded-xl border border-line p-4 shadow-sm">
      <div className="text-[10px] font-semibold text-ink-4 tracking-wide uppercase">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${accent}`}>{value}</div>
      {sub && <div className="text-xs text-ink-4 mt-0.5">{sub}</div>}
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
  const [rcId,          setRcId]          = useState<string | null>(initial ? initial.revenueCenterId : (defaultRcId ?? revenueCenters[0]?.id ?? null))
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
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4">
      <div className="bg-white w-full sm:max-w-2xl rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-line shrink-0">
          <h2 className="text-base font-semibold text-ink">{initial ? 'Edit Sales Day' : 'Record Sales Day'}</h2>
          <button onClick={onCancel} className="p-1.5 rounded-lg hover:bg-bg-2 text-ink-4"><X size={18} /></button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
          <div className="px-5 py-4 space-y-4 overflow-y-auto flex-1">
            {/* Row 1: date + covers */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-ink-3 mb-1">Date</label>
                <input type="date" required value={date} onChange={e => setDate(e.target.value)}
                  className="w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-3 mb-1">Covers (guests)</label>
                <input type="number" min="0" value={covers} onChange={e => setCovers(e.target.value)}
                  placeholder="0"
                  className="w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
              </div>
            </div>

            {/* Revenue center */}
            {revenueCenters.length > 0 && (
              <div>
                <label className="block text-xs font-medium text-ink-3 mb-1">Revenue Center</label>
                <div className="flex flex-wrap gap-1.5">
                  {revenueCenters.map(rc => {
                    const active = rcId === rc.id
                    return (
                      <button
                        key={rc.id}
                        type="button"
                        onClick={() => setRcId(rc.id)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                          active ? 'bg-ink text-white border-ink' : 'bg-white text-ink-2 border-line hover:border-line-2'
                        }`}
                      >
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: rcHex(rc.color) }} />
                        {rc.name}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Row 2: revenue + food % */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-ink-3 mb-1">Total Revenue ($)</label>
                <input type="number" required min="0" step="0.01" value={revenue} onChange={e => setRevenue(e.target.value)}
                  placeholder="0.00"
                  className="w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-3 mb-1">Food Sales %</label>
                <div className="relative">
                  <input type="number" min="0" max="100" value={foodPct} onChange={e => setFoodPct(e.target.value)}
                    placeholder="70"
                    className="w-full border border-line rounded-lg px-3 py-2 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-4 text-sm">%</span>
                </div>
              </div>
            </div>

            {/* Notes */}
            <div>
              <label className="block text-xs font-medium text-ink-3 mb-1">Notes</label>
              <input value={notes} onChange={e => setNotes(e.target.value)}
                placeholder="e.g. Busy Friday night, private event..."
                className="w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
            </div>

            {/* Menu items */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-medium text-ink-3">Menu items sold <span className="text-ink-4 font-normal">({totalSold} total portions)</span></label>
              </div>
              <div className="relative mb-2">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-4" />
                <input value={recipeSearch} onChange={e => setRecipeSearch(e.target.value)}
                  placeholder="Search menu items..."
                  className="w-full pl-8 pr-3 py-2 border border-line rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-gold" />
              </div>
              <div className="border border-line rounded-xl overflow-hidden divide-y divide-line max-h-64 overflow-y-auto">
                {filteredRecipes.length === 0 && (
                  <div className="px-3 py-4 text-center text-sm text-ink-4">No menu items found</div>
                )}
                {filteredRecipes.map(r => (
                  <div key={r.id} className="flex items-center gap-3 px-3 py-2 hover:bg-bg">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-ink-2 truncate">{r.name}</div>
                      {r.menuPrice && (
                        <div className="text-xs text-ink-4">{formatCurrency(Number(r.menuPrice))}</div>
                      )}
                    </div>
                    <input
                      type="number" min="0" step="1"
                      value={qtys[r.id] ?? ''}
                      onChange={e => setQtys(q => ({ ...q, [r.id]: e.target.value }))}
                      placeholder="0"
                      className="w-20 border border-line rounded-lg px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-gold"
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-3 border-t border-line shrink-0 flex gap-3">
            <button type="button" onClick={onCancel}
              className="flex-1 px-4 py-2.5 rounded-xl border border-line text-sm font-medium text-ink-2 hover:bg-bg">
              Cancel
            </button>
            <button type="submit" disabled={saving || !rcId}
              className="flex-1 px-4 py-2.5 rounded-xl bg-ink text-paper [&_svg]:text-gold text-sm font-medium hover:bg-ink-2 disabled:opacity-60">
              {saving ? 'Saving…' : (initial ? 'Save changes' : 'Record sales')}
            </button>
          </div>
        </form>
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
  endDate: string | null
  periodType: string
  totalSales: number
  foodSales: number
  items: ParsedItem[]
}

function ConfidenceBadge({ c }: { c: ParsedItem['matchConfidence'] }) {
  if (c === 'exact')  return <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-green-soft text-green-text">matched</span>
  if (c === 'fuzzy')  return <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-gold-soft text-gold-2">fuzzy</span>
  return <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-bg-2 text-ink-3">unmatched</span>
}

function ImportModal({ menuRecipes, onImport, onClose }: {
  menuRecipes: RecipeSummary[]
  onImport: (row: { date: string; endDate: string | null; periodType: string; totalRevenue: string; covers: string; foodSalesPct: string; notes: string; lineItems: { recipeId: string; qtySold: number }[] }) => Promise<void>
  onClose: () => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [step,     setStep]     = useState<'upload' | 'review'>('upload')
  const [file,     setFile]     = useState<File | null>(null)
  const [parsing,  setParsing]  = useState(false)
  const [parseErr, setParseErr] = useState('')
  const [parsed,   setParsed]   = useState<ParseResult | null>(null)
  const [saving,   setSaving]   = useState(false)
  const [endDate,    setEndDate]    = useState('')
  const [periodType, setPeriodType] = useState<'day' | 'week' | 'month' | 'custom'>('day')

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
      setEndDate(result.endDate ?? '')
      setPeriodType((result.periodType ?? 'day') as 'day' | 'week' | 'month' | 'custom')
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

    await onImport({ date, endDate: endDate || null, periodType, totalRevenue: totalSales, covers: '', foodSalesPct, notes: '', lineItems })
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
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4">
      <div className="bg-white w-full sm:max-w-2xl rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[92vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-line shrink-0">
          <div>
            <h2 className="text-base font-semibold text-ink">Import from Toast POS</h2>
            {step === 'review' && <p className="text-xs text-ink-4 mt-0.5">Review and confirm before saving</p>}
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-bg-2 text-ink-4"><X size={18} /></button>
        </div>

        {/* ── Upload step ── */}
        {step === 'upload' && (
          <div className="px-5 py-5 space-y-4">
            <div className="bg-gold/10 border border-blue-soft rounded-xl p-3 text-sm text-blue-text">
              Upload the <strong>ProductMix</strong> Excel exported from Toast POS. The system will extract food sales totals and BRUNCH item quantities automatically.
            </div>

            <div
              onClick={() => fileRef.current?.click()}
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f) }}
              className="border-2 border-dashed border-line rounded-xl p-10 text-center cursor-pointer hover:border-blue transition-colors"
            >
              {parsing ? (
                <div className="text-sm text-ink-3">Parsing file…</div>
              ) : (
                <>
                  <Upload size={28} className="mx-auto text-ink-4 mb-2" />
                  <div className="text-sm font-medium text-ink-3">{file ? file.name : 'Click or drag your ProductMix file here'}</div>
                  <div className="text-xs text-ink-4 mt-1">Accepts .xlsx or .csv</div>
                </>
              )}
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />
            </div>

            {parseErr && (
              <div className="text-sm text-red bg-red-soft border border-red-soft rounded-lg px-3 py-2">{parseErr}</div>
            )}

            <div className="flex gap-3 pt-1">
              <button onClick={onClose} className="flex-1 px-4 py-2.5 rounded-xl border border-line text-sm font-medium text-ink-2 hover:bg-bg">Cancel</button>
            </div>
          </div>
        )}

        {/* ── Review step ── */}
        {step === 'review' && parsed && (
          <>
            <div className="px-5 py-4 overflow-y-auto flex-1 space-y-5">

              {/* Date + Totals */}
              {parsed.endDate ? (
                /* Period import */
                <div className="space-y-3">
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="text-xs font-medium text-ink-3 block mb-1">From</label>
                      <input type="date" value={date} onChange={e => setDate(e.target.value)}
                        className="w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-ink-3 block mb-1">To</label>
                      <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
                        className="w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-ink-3 block mb-1">Period Type</label>
                      <select value={periodType} onChange={e => setPeriodType(e.target.value as 'week' | 'month' | 'custom')}
                        className="w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold">
                        <option value="week">Week</option>
                        <option value="month">Month</option>
                        <option value="custom">Custom</option>
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium text-ink-3 block mb-1">Total Net Sales</label>
                      <div className="relative">
                        <span className="absolute left-3 top-2 text-ink-4 text-sm">$</span>
                        <input type="number" min="0" step="0.01" value={totalSales} onChange={e => setTotalSales(e.target.value)}
                          className="w-full border border-line rounded-lg pl-7 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                      </div>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-ink-3 block mb-1">
                        Food Sales <span className="text-ink-4 font-normal">({foodPct}%)</span>
                      </label>
                      <div className="relative">
                        <span className="absolute left-3 top-2 text-ink-4 text-sm">$</span>
                        <input type="number" min="0" step="0.01" value={foodSales} onChange={e => setFoodSales(e.target.value)}
                          className="w-full border border-line rounded-lg pl-7 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                /* Single-day import — existing layout */
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="text-xs font-medium text-ink-3 block mb-1">Date</label>
                    <input type="date" value={date} onChange={e => setDate(e.target.value)}
                      className="w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-ink-3 block mb-1">Total Net Sales</label>
                    <div className="relative">
                      <span className="absolute left-3 top-2 text-ink-4 text-sm">$</span>
                      <input type="number" min="0" step="0.01" value={totalSales} onChange={e => setTotalSales(e.target.value)}
                        className="w-full border border-line rounded-lg pl-7 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-ink-3 block mb-1">
                      Food Sales <span className="text-ink-4 font-normal">({foodPct}%)</span>
                    </label>
                    <div className="relative">
                      <span className="absolute left-3 top-2 text-ink-4 text-sm">$</span>
                      <input type="number" min="0" step="0.01" value={foodSales} onChange={e => setFoodSales(e.target.value)}
                        className="w-full border border-line rounded-lg pl-7 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                    </div>
                  </div>
                </div>
              )}

              {/* Matched items */}
              <div>
                <div className="text-xs font-semibold text-ink-3 uppercase tracking-wide mb-2">
                  BRUNCH items · {parsed.items.length} from Toast · {matched.length} matched
                </div>
                <div className="border border-line rounded-xl overflow-hidden divide-y divide-line">
                  {parsed.items.map(item => {
                    const recipeId = overrides[item.rawName] ?? item.matchedRecipeId
                    const confidence = overrides[item.rawName] ? 'exact' : item.matchConfidence
                    const qty = recipeId ? (qtys[recipeId] ?? item.qtySold) : item.qtySold
                    return (
                      <div key={item.rawName} className="flex items-center gap-3 px-3 py-2.5">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-ink-2 truncate">{item.rawName}</span>
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
                            className="mt-1 w-full border border-line rounded-lg px-2 py-1 text-xs text-ink-3 focus:outline-none focus:ring-1 focus:ring-gold bg-bg"
                          >
                            <option value="">— not matched —</option>
                            {menuRecipes.map(r => (
                              <option key={r.id} value={r.id}>{r.name}</option>
                            ))}
                          </select>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <span className="text-xs text-ink-4">×</span>
                          <input
                            type="number" min="0" step="1"
                            value={recipeId ? qty : item.qtySold}
                            onChange={e => {
                              const rid = recipeId
                              if (rid) setQtys(q => ({ ...q, [rid]: parseInt(e.target.value) || 0 }))
                            }}
                            className="w-16 border border-line rounded-lg px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-gold"
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>

              {unmatched.length > 0 && (
                <div className="text-xs text-gold bg-gold-soft border border-gold-soft rounded-lg px-3 py-2">
                  {unmatched.length} item{unmatched.length > 1 ? 's' : ''} not matched to a menu recipe — they won&apos;t be recorded. Use the dropdown above to assign them.
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-3 border-t border-line shrink-0 flex gap-3">
              <button onClick={() => setStep('upload')} className="px-4 py-2.5 rounded-xl border border-line text-sm font-medium text-ink-2 hover:bg-bg">
                ← Back
              </button>
              <button onClick={handleSave} disabled={saving}
                className="flex-1 px-4 py-2.5 rounded-xl bg-ink text-paper [&_svg]:text-gold text-sm font-medium hover:bg-ink-2 disabled:opacity-60">
                {saving ? 'Saving…' :
                  periodType === 'week'   ? 'Save weekly sales' :
                  periodType === 'month'  ? 'Save monthly sales' :
                  periodType === 'custom' ? 'Save period sales' :
                  `Save sales for ${date}`
                }
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
  const [loadError,     setLoadError]     = useState<string | null>(null)
  const [rangeMode,     setRangeMode]     = useState<RangeMode>('week')
  const [customStart,   setCustomStart]   = useState('')
  const [customEnd,     setCustomEnd]     = useState('')
  const [sortCol,       setSortCol]       = useState<SortCol>('date')
  const [sortDir,       setSortDir]       = useState<SortDir>('desc')
  const [search,        setSearch]        = useState('')
  const [showAdd,       setShowAdd]       = useState(false)
  const [editSale,      setEditSale]      = useState<Sale | null>(null)
  const [selectedSale,  setSelectedSale]  = useState<Sale | null>(null)
  const [selectedPeriodKey, setSelectedPeriodKey] = useState<string | null>(null)
  const [granularity,       setGranularity]       = useState<Granularity>('day')
  const [showImport,    setShowImport]    = useState(false)
  const [importError,   setImportError]   = useState<string | null>(null)
  const [deleteId,      setDeleteId]      = useState<string | null>(null)
  const [activeTab,     setActiveTab]     = useState<'list' | 'analytics'>('list')

  const { activeRcId, activeRc, revenueCenters, isReadOnly } = useRc()

  const [startDate, endDate] = getRange(rangeMode, customStart, customEnd)

  const fetchSales = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    const params = new URLSearchParams({ startDate, endDate })
    if (activeRcId) {
      params.set('rcId', activeRcId)
      if (activeRc?.isDefault) params.set('isDefault', 'true')
    }
    // A request that throws OR stalls used to leave the page stuck on "Loading…"
    // forever (setLoading(false) was never reached). Abort after 20s and always
    // clear loading in finally, surfacing a retryable error instead of hanging.
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 20_000)
    try {
      const res = await fetch(`/api/sales?${params}`, { signal: ctrl.signal })
      if (!res.ok) throw new Error(`status ${res.status}`)
      const data = await res.json()
      setSales(Array.isArray(data) ? data : [])
    } catch (err) {
      setSales([])
      setLoadError(
        err instanceof DOMException && err.name === 'AbortError'
          ? 'Sales took too long to load — check your connection and try again.'
          : 'Couldn’t load sales. Please try again.'
      )
    } finally {
      clearTimeout(timer)
      setLoading(false)
    }
  }, [startDate, endDate, activeRcId, activeRc])

  useEffect(() => { fetchSales() }, [fetchSales])

  useEffect(() => {
    fetch('/api/recipes?type=MENU').then(r => r.json()).then(d => {
      if (Array.isArray(d)) setMenuRecipes(d)
    })
  }, [])

  // ── Source dedupe (Toast wins over a manual duplicate on the same day+RC) ──
  const dedupedSales = useMemo(() => dedupeSales(sales), [sales])
  const dupManualIds = useMemo(() => duplicateManualIds(sales), [sales])

  // ── KPIs (deduped so a Toast+manual duplicate doesn't double-count) ──
  const kpis = useMemo(() => {
    const totalRevenue  = dedupedSales.reduce((s, e) => s + Number(e.totalRevenue), 0)
    const totalFoodSales = dedupedSales.reduce((s, e) => s + Number(e.totalRevenue) * Number(e.foodSalesPct), 0)
    const totalCovers   = dedupedSales.reduce((s, e) => s + (e.covers ?? 0), 0)
    const days          = dedupedSales.length
    const avgDaily      = days > 0 ? totalRevenue / days : 0
    const avgPerCover   = totalCovers > 0 ? totalRevenue / totalCovers : 0
    const totalPortions = dedupedSales.reduce((s, e) => s + e.lineItems.reduce((ss, li) => ss + li.qtySold, 0), 0)
    return { totalRevenue, totalFoodSales, totalCovers, days, avgDaily, avgPerCover, totalPortions }
  }, [dedupedSales])

  // ── Top items ──
  const topItems = useMemo(() => {
    const map = new Map<string, { name: string; qty: number; revenue: number }>()
    for (const sale of dedupedSales) {
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
  }, [dedupedSales])

  // ── Period rows (week/month aggregation; deduped to avoid double-count) ──
  const periodRows = useMemo((): PeriodRow[] => {
    if (granularity === 'week')  return buildWeekRows(dedupedSales, startDate, endDate)
    if (granularity === 'month') return buildMonthRows(dedupedSales, startDate, endDate)
    return []
  }, [dedupedSales, granularity, startDate, endDate])

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
      : <ArrowUpDown size={12} className="text-ink-4 inline ml-1" />

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
    if (selectedSale?.id === id) setSelectedSale(null)
    fetchSales()
  }

  const handleImport = async (row: Parameters<Parameters<typeof ImportModal>[0]['onImport']>[0]) => {
    if (!activeRcId) { setImportError('Select a revenue center (not "All") to import sales.'); return }
    await fetch('/api/sales', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...row, revenueCenterId: activeRcId }) })
    setShowImport(false)
    fetchSales()
  }

  return (
    <div className="space-y-4 pb-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-ink">Sales</h1>
          <p className="text-sm text-ink-3 mt-0.5">Daily sales records · inventory consumption tracking</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => { setImportError(null); setShowImport(true) }} disabled={isReadOnly}
            title={isReadOnly ? 'Select a revenue center to make changes' : undefined}
            className="flex items-center gap-2 border border-line bg-white text-ink-2 px-3 py-2 rounded-lg text-sm hover:bg-bg transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-white">
            <Upload size={15} /> Import
          </button>
          <button onClick={() => setShowAdd(true)}
            className="flex items-center gap-2 bg-ink text-paper [&_svg]:text-gold px-3 py-2 rounded-lg text-sm hover:bg-ink-2 transition-colors">
            <Plus size={15} /> Add Sales Day
          </button>
        </div>
      </div>

      {/* RC gate hint — import requires a concrete revenue center */}
      {!activeRcId && (
        <div className="bg-red-soft text-red-text rounded-lg px-3 py-2 text-sm">
          {importError ?? 'You’re viewing all revenue centers. Select a specific revenue center (not "All") to import sales. You can still add a sales day and assign its revenue center in the form.'}
        </div>
      )}

      {/* Date range tabs */}
      <div className="flex items-center gap-2 flex-wrap">
        {(['week', 'month', 'lastMonth', 'custom'] as RangeMode[]).map(mode => (
          <button key={mode} onClick={() => setRangeMode(mode)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              rangeMode === mode ? 'bg-ink text-paper [&_svg]:text-gold' : 'bg-white border border-line text-ink-3 hover:border-line-2'
            }`}>
            {{ week: 'This Week', month: 'This Month', lastMonth: 'Last Month', custom: 'Custom' }[mode]}
          </button>
        ))}
        {rangeMode === 'custom' && (
          <div className="flex items-center gap-2 ml-1">
            <input type="date" value={customStart} onChange={e => setCustomStart(e.target.value)}
              className="border border-line rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
            <span className="text-ink-4 text-sm">to</span>
            <input type="date" value={customEnd} onChange={e => setCustomEnd(e.target.value)}
              className="border border-line rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
          </div>
        )}
      </div>

      {/* Load error — a failed/stalled fetch no longer bricks the page on "Loading…" */}
      {!loading && loadError && (
        <div className="flex items-center gap-2 bg-red-soft border border-red-soft rounded-xl px-3 py-2 text-sm text-red-text">
          <AlertTriangle size={15} className="shrink-0" />
          <span className="flex-1">{loadError}</span>
          <button onClick={() => fetchSales()}
            className="px-3 py-1 rounded-lg bg-ink text-paper [&_svg]:text-gold text-xs font-medium hover:bg-ink-2">
            Retry
          </button>
        </div>
      )}

      {/* Onboarding card — shown when no sales have ever been recorded */}
      {!loading && !loadError && sales.length === 0 && rangeMode === 'week' && (
        <div className="bg-gold/10 border border-blue-soft rounded-xl p-5 flex gap-4 items-start">
          <div className="w-10 h-10 rounded-xl bg-gold/15 flex items-center justify-center shrink-0">
            <BarChart2 size={20} className="text-gold" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-blue-text text-sm mb-1">Record your daily sales to unlock food cost tracking</h3>
            <p className="text-xs text-gold leading-relaxed mb-3">
              Add each service day — total revenue, covers, and which menu items sold. This powers the food cost % calculation in your dashboard and analytics.
              You can also <button onClick={() => setShowImport(true)} disabled={isReadOnly} title={isReadOnly ? 'Select a revenue center to make changes' : undefined} className="underline font-medium disabled:no-underline disabled:opacity-60 disabled:cursor-not-allowed">import from Toast POS</button> if you have a ProductMix export.
            </p>
            <button onClick={() => setShowAdd(true)}
              className="inline-flex items-center gap-2 bg-ink text-paper [&_svg]:text-gold px-4 py-2 rounded-lg text-sm font-medium hover:bg-ink-2 transition-colors">
              <Plus size={14} /> Add First Sales Day
            </button>
          </div>
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard label="Total Revenue" value={formatCurrency(kpis.totalRevenue)} sub={`${kpis.days} days`} accent="text-green" />
        <KpiCard label="Food Sales" value={formatCurrency(kpis.totalFoodSales)} sub="estimated" accent="text-gold" />
        <KpiCard label="Total Covers" value={kpis.totalCovers.toLocaleString()} sub="guests" accent="text-ink" />
        <KpiCard label="Avg per Cover" value={kpis.avgPerCover > 0 ? formatCurrency(kpis.avgPerCover) : '—'} />
        <KpiCard label="Avg Daily" value={kpis.avgDaily > 0 ? formatCurrency(kpis.avgDaily) : '—'} />
        <KpiCard label="Portions Sold" value={kpis.totalPortions.toLocaleString()} sub="menu items" accent="text-blue" />
      </div>

      {/* Toast sync health */}
      <SyncHealthStrip sales={sales} />

      {/* Duplicate warning — manual entries shadowed by a Toast day */}
      {dupManualIds.size > 0 && (
        <div className="flex items-center gap-2 bg-gold-soft border border-gold-soft rounded-xl px-3 py-2 text-sm text-gold-2">
          <AlertTriangle size={15} className="shrink-0" />
          <span>
            {dupManualIds.size} manual {dupManualIds.size === 1 ? 'entry duplicates' : 'entries duplicate'} a Toast-synced day —
            Toast is authoritative (totals already ignore the manual copy). Remove the flagged {dupManualIds.size === 1 ? 'row' : 'rows'} below to tidy up.
          </span>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-line">
        {([['list', 'Sales Log'], ['analytics', 'Top Items']] as const).map(([tab, label]) => (
          <button key={tab} onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab ? 'border-gold text-gold' : 'border-transparent text-ink-3 hover:text-ink-2'
            }`}>
            {label}
          </button>
        ))}
      </div>

      {/* Sales Log Tab */}
      {activeTab === 'list' && (
        <>
          {/* Granularity toggle + search */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center border border-line rounded-lg overflow-hidden">
              {(['day', 'week', 'month'] as Granularity[]).map(g => (
                <button key={g}
                  onClick={() => { setGranularity(g); setSelectedSale(null); setSelectedPeriodKey(null) }}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors capitalize ${
                    granularity === g ? 'bg-ink text-paper [&_svg]:text-gold' : 'bg-white text-ink-3 hover:bg-bg'
                  }`}>
                  {g}
                </button>
              ))}
            </div>
            {granularity === 'day' && (
              <div className="relative max-w-xs">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-4" />
                <input value={search} onChange={e => setSearch(e.target.value)}
                  placeholder="Search days…"
                  className="w-full pl-8 pr-3 py-2 border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
              </div>
            )}
          </div>

          {/* Split panel */}
          <div className="flex gap-4 items-start">

            {/* Left panel */}
            <div className={`${(selectedSale || selectedPeriodKey) ? 'w-[360px] shrink-0' : 'w-full'}`}>

              {/* Day mode table */}
              {granularity === 'day' && (
                <div className="bg-white rounded-xl border border-line shadow-sm overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-bg border-b border-line">
                      <tr>
                        <th className="px-4 py-3 text-left font-medium text-ink-3 cursor-pointer" onClick={() => toggleSort('date')}>
                          Date <SortIcon col="date" />
                        </th>
                        <th className="px-3 py-3 text-right font-medium text-ink-3 cursor-pointer" onClick={() => toggleSort('revenue')}>
                          Revenue <SortIcon col="revenue" />
                        </th>
                        <th className="px-3 py-3 text-right font-medium text-ink-3 hidden sm:table-cell cursor-pointer" onClick={() => toggleSort('covers')}>
                          Covers <SortIcon col="covers" />
                        </th>
                        <th className="px-3 py-3 text-right font-medium text-ink-3 hidden md:table-cell cursor-pointer" onClick={() => toggleSort('items')}>
                          Portions <SortIcon col="items" />
                        </th>
                        <th className="px-3 py-3 w-16" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {loading && (
                        <tr><td colSpan={5} className="text-center py-12 text-ink-4">Loading…</td></tr>
                      )}
                      {!loading && loadError && (
                        <tr><td colSpan={5} className="text-center py-12 text-ink-4">Couldn’t load sales — use Retry above.</td></tr>
                      )}
                      {!loading && !loadError && displayed.length === 0 && (
                        <tr>
                          <td colSpan={5} className="text-center py-12">
                            <div className="text-ink-4 mb-3">No sales recorded for this period</div>
                            <button onClick={() => setShowAdd(true)}
                              className="inline-flex items-center gap-2 px-4 py-2 bg-ink text-paper [&_svg]:text-gold rounded-lg text-sm hover:bg-ink-2">
                              <Plus size={14} /> Add Sales Day
                            </button>
                          </td>
                        </tr>
                      )}
                      {displayed.map(sale => {
                        const rev      = Number(sale.totalRevenue)
                        const portions = sale.lineItems.reduce((s, l) => s + l.qtySold, 0)
                        const isSelected = selectedSale?.id === sale.id
                        return (
                          <tr key={sale.id}
                            onClick={() => setSelectedSale(isSelected ? null : sale)}
                            className={`cursor-pointer transition-colors ${isSelected ? 'bg-gold-soft' : 'hover:bg-bg'}`}>
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-medium text-ink-2">{fmtDate(sale.date)}</span>
                                <SourceBadge source={sale.source} />
                                {dupManualIds.has(sale.id) && (
                                  <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-red-soft text-red-text">
                                    <AlertTriangle size={9} /> Duplicate
                                  </span>
                                )}
                                {sale.revenueCenter && (
                                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-bg-2 text-ink-3">
                                    <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: rcHex(sale.revenueCenter.color) }} />
                                    {sale.revenueCenter.name}
                                  </span>
                                )}
                              </div>
                              <div className="text-xs text-ink-4">{fmtDay(sale.date)}{sale.notes ? ` · ${sale.notes}` : ''}</div>
                            </td>
                            <td className="px-3 py-3 text-right">
                              <div className="font-semibold text-ink">{formatCurrency(rev)}</div>
                              <div className="text-xs text-ink-4">{Math.round(Number(sale.foodSalesPct) * 100)}% food</div>
                            </td>
                            <td className="px-3 py-3 text-right hidden sm:table-cell">
                              <div className="font-medium text-ink-2">{sale.covers ?? '—'}</div>
                            </td>
                            <td className="px-3 py-3 text-right hidden md:table-cell">
                              <div className="font-medium text-ink-2">{portions > 0 ? portions : '—'}</div>
                            </td>
                            <td className="px-3 py-3" onClick={e => e.stopPropagation()}>
                              <div className="flex items-center gap-1 justify-end">
                                <button onClick={() => setEditSale(sale)} className="p-1.5 rounded-lg hover:bg-bg-2 text-ink-4 hover:text-gold">
                                  <Pencil size={13} />
                                </button>
                                <button onClick={() => setDeleteId(sale.id)} className="p-1.5 rounded-lg hover:bg-bg-2 text-ink-4 hover:text-red">
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
              )}

              {/* Week / Month mode list */}
              {granularity !== 'day' && (
                <div className="bg-white rounded-xl border border-line shadow-sm overflow-hidden">
                  {loading && <div className="py-12 text-center text-ink-4">Loading…</div>}
                  {!loading && loadError && (
                    <div className="py-12 text-center text-ink-4">Couldn’t load sales — use Retry above.</div>
                  )}
                  {!loading && !loadError && periodRows.length === 0 && (
                    <div className="py-12 text-center text-ink-4">No sales data for this period</div>
                  )}
                  {periodRows.map(period => {
                    const isSelected = selectedPeriodKey === period.key
                    return (
                      <div key={period.key}
                        onClick={() => setSelectedPeriodKey(isSelected ? null : period.key)}
                        className={`flex items-center gap-3 px-4 py-3.5 border-b border-line last:border-0 cursor-pointer transition-colors ${isSelected ? 'bg-gold-soft' : 'hover:bg-bg'}`}>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className="text-sm font-medium text-ink-2">{period.label}</span>
                            <PeriodBadge badge={period.badge} text={period.badgeText} />
                          </div>
                          {period.totalRevenue > 0 && (
                            <div className="text-xs text-ink-4">
                              {formatCurrency(period.totalRevenue)} · {Math.round(period.foodSalesPct * 100)}% food
                            </div>
                          )}
                        </div>
                        {period.covers != null && period.covers > 0 && (
                          <div className="text-right shrink-0">
                            <div className="text-sm font-semibold text-ink-2">{period.covers}</div>
                            <div className="text-[10px] text-ink-4">covers</div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Right panel */}
            {(selectedSale || selectedPeriodKey) && (
              <div className="flex-1 min-w-0">

                {/* Day detail */}
                {selectedSale && (() => {
                  const sale = selectedSale
                  const revenue     = Number(sale.totalRevenue)
                  const foodSalesAmt = revenue * Number(sale.foodSalesPct)
                  const totalSold   = sale.lineItems.reduce((s, li) => s + li.qtySold, 0)
                  const avgPerCover = sale.covers && sale.covers > 0 ? revenue / sale.covers : null
                  return (
                    <div className="bg-white rounded-xl border border-line shadow-sm">
                      <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-line">
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-semibold text-ink">{fmtDate(sale.date)}</span>
                            <SourceBadge source={sale.source} />
                            {sale.revenueCenter && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-bg-2 text-ink-2">
                                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: rcHex(sale.revenueCenter.color) }} />
                                {sale.revenueCenter.name}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-ink-4">{fmtDay(sale.date)}</div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <button onClick={() => { setEditSale(sale); setSelectedSale(null) }}
                            className="flex items-center gap-1 px-2.5 py-1.5 border border-line rounded-lg text-xs text-ink-3 hover:bg-bg">
                            <Pencil size={11} /> Edit
                          </button>
                          <button onClick={() => setSelectedSale(null)}
                            className="p-1.5 rounded-lg hover:bg-bg-2 text-ink-4"><X size={16} /></button>
                        </div>
                      </div>
                      <div className="px-4 py-4 space-y-4">
                        <div className="grid grid-cols-3 gap-3">
                          <div className="bg-bg rounded-xl p-3 text-center">
                            <div className="text-lg font-bold text-ink">{formatCurrency(revenue)}</div>
                            <div className="text-[10px] text-ink-3 mt-0.5 uppercase tracking-wide">Revenue</div>
                          </div>
                          <div className="bg-bg rounded-xl p-3 text-center">
                            <div className="text-lg font-bold text-ink">{sale.covers ?? '—'}</div>
                            <div className="text-[10px] text-ink-3 mt-0.5 uppercase tracking-wide">Covers</div>
                          </div>
                          <div className="bg-bg rounded-xl p-3 text-center">
                            <div className="text-lg font-bold text-ink">{avgPerCover ? formatCurrency(avgPerCover) : '—'}</div>
                            <div className="text-[10px] text-ink-3 mt-0.5 uppercase tracking-wide">Avg/Cover</div>
                          </div>
                        </div>
                        <div className="text-xs text-ink-3">
                          Food sales: <span className="font-medium text-ink-2">{formatCurrency(foodSalesAmt)}</span>
                          <span className="mx-1">·</span>{Math.round(Number(sale.foodSalesPct) * 100)}%
                          <span className="mx-1">·</span>{totalSold} portions
                        </div>
                        {sale.notes && (
                          <div className="bg-gold-soft border border-gold-soft rounded-lg px-3 py-2 text-sm text-gold-2">{sale.notes}</div>
                        )}
                        {sale.lineItems.length > 0 ? (
                          <div>
                            <div className="text-xs font-semibold text-ink-3 uppercase tracking-wide mb-2">Items sold</div>
                            <div className="divide-y divide-line border border-line rounded-xl overflow-hidden max-h-80 overflow-y-auto">
                              {sale.lineItems.map(li => {
                                const lineRevenue = li.recipe.menuPrice ? Number(li.recipe.menuPrice) * li.qtySold : null
                                return (
                                  <div key={li.id} className="flex items-center gap-3 px-3 py-2.5">
                                    <div className="flex-1 min-w-0">
                                      <div className="text-sm font-medium text-ink-2 truncate">{li.recipe.name}</div>
                                      {li.recipe.category && <div className="text-xs text-ink-4">{li.recipe.category.name}</div>}
                                    </div>
                                    <div className="text-right shrink-0">
                                      <div className="text-sm font-semibold text-ink-2">×{li.qtySold}</div>
                                      {lineRevenue && <div className="text-xs text-ink-4">{formatCurrency(lineRevenue)}</div>}
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        ) : (
                          <div className="text-center py-4 text-sm text-ink-4">No menu items recorded</div>
                        )}
                      </div>
                    </div>
                  )
                })()}

                {/* Period detail */}
                {selectedPeriodKey && (() => {
                  const period = periodRows.find(p => p.key === selectedPeriodKey)
                  if (!period) return null
                  const foodSalesAmt = period.totalRevenue * period.foodSalesPct
                  return (
                    <div className="bg-white rounded-xl border border-line shadow-sm">
                      <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-line">
                        <div>
                          <div className="text-sm font-semibold text-ink">{period.label}</div>
                          <div className="mt-0.5">
                            <PeriodBadge badge={period.badge} text={period.badgeText} />
                          </div>
                        </div>
                        <button onClick={() => setSelectedPeriodKey(null)}
                          className="p-1.5 rounded-lg hover:bg-bg-2 text-ink-4"><X size={16} /></button>
                      </div>
                      <div className="px-4 py-4 space-y-4">
                        {period.totalRevenue > 0 && (
                          <div className="grid grid-cols-3 gap-3">
                            <div className="bg-bg rounded-xl p-3 text-center">
                              <div className="text-lg font-bold text-ink">{formatCurrency(period.totalRevenue)}</div>
                              <div className="text-[10px] text-ink-3 mt-0.5 uppercase tracking-wide">Revenue</div>
                            </div>
                            <div className="bg-bg rounded-xl p-3 text-center">
                              <div className="text-lg font-bold text-ink">{formatCurrency(foodSalesAmt)}</div>
                              <div className="text-[10px] text-ink-3 mt-0.5 uppercase tracking-wide">Food Sales</div>
                            </div>
                            <div className="bg-bg rounded-xl p-3 text-center">
                              <div className="text-lg font-bold text-ink">{period.covers ?? '—'}</div>
                              <div className="text-[10px] text-ink-3 mt-0.5 uppercase tracking-wide">Covers</div>
                            </div>
                          </div>
                        )}
                        {period.badge === 'not-available' && (
                          <div className="text-center py-4 text-sm text-ink-4">No sales data for this period</div>
                        )}
                        {(period.badge === 'weekly-import' || period.badge === 'monthly-import') && (
                          <div className="bg-blue-soft border border-blue-soft rounded-lg px-3 py-2 text-xs text-blue-text">
                            Imported as {period.badge === 'weekly-import' ? 'Weekly' : 'Monthly'} — no per-day breakdown available.
                          </div>
                        )}
                        {period.badge !== 'weekly-import' && period.badge !== 'monthly-import' && period.dailySales.length > 0 && (
                          <div>
                            <div className="text-xs font-semibold text-ink-3 uppercase tracking-wide mb-2">Day breakdown</div>
                            <div className="divide-y divide-line border border-line rounded-xl overflow-hidden">
                              {(() => {
                                const days: string[] = []
                                const cur = new Date(period.startDate)
                                const pEnd = new Date(period.endDate)
                                while (cur <= pEnd) { days.push(toISO(cur)); cur.setDate(cur.getDate() + 1) }
                                return days.map(day => {
                                  const daySale = period.dailySales.find(s => s.date.slice(0, 10) === day)
                                  return (
                                    <div key={day} className="flex items-center justify-between px-3 py-2">
                                      <span className="text-sm text-ink-2">{fmtDate(day)}</span>
                                      {daySale
                                        ? <span className="text-sm font-medium text-ink">{formatCurrency(Number(daySale.totalRevenue))}</span>
                                        : <span className="text-sm text-ink-4">—</span>
                                      }
                                    </div>
                                  )
                                })
                              })()}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })()}

              </div>
            )}
          </div>
        </>
      )}

      {/* Top Items Tab */}
      {activeTab === 'analytics' && (
        <div className="space-y-4">
          {topItems.length === 0 ? (
            <div className="bg-white rounded-xl border border-line p-12 text-center text-ink-4">
              No sales data for this period — add sales days with menu item quantities to see analytics.
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-line shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b border-line flex items-center gap-2">
                <TrendingUp size={15} className="text-ink-4" />
                <span className="text-sm font-semibold text-ink-2">Top selling items</span>
                <span className="text-xs text-ink-4 ml-auto">{startDate} — {endDate}</span>
              </div>
              <div className="divide-y divide-line">
                {topItems.map((item, i) => {
                  const maxQty = topItems[0]?.qty ?? 1
                  const pct = (item.qty / maxQty) * 100
                  return (
                    <div key={item.name} className="px-4 py-3 flex items-center gap-3">
                      <div className="w-6 text-xs font-bold text-ink-4 shrink-0">{i + 1}</div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-ink-2 truncate">{item.name}</div>
                        <div className="h-1.5 bg-bg-2 rounded-full mt-1.5 overflow-hidden">
                          <div className="h-full bg-gold/100 rounded-full transition-all" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-sm font-semibold text-ink">{item.qty.toLocaleString()} sold</div>
                        {item.revenue > 0 && <div className="text-xs text-ink-4">{formatCurrency(item.revenue)}</div>}
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

      {showImport && (
        <ImportModal menuRecipes={menuRecipes} onImport={handleImport} onClose={() => setShowImport(false)} />
      )}

      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-soft flex items-center justify-center shrink-0">
                <Trash2 size={18} className="text-red" />
              </div>
              <div>
                <h3 className="font-semibold text-ink">Delete sales entry?</h3>
                <p className="text-xs text-ink-3 mt-0.5">This cannot be undone.</p>
              </div>
            </div>
            <div className="flex gap-3 mt-4">
              <button onClick={() => setDeleteId(null)}
                className="flex-1 px-4 py-2.5 rounded-xl border border-line text-sm font-medium text-ink-2 hover:bg-bg">
                Cancel
              </button>
              <button onClick={() => handleDelete(deleteId)}
                className="flex-1 px-4 py-2.5 rounded-xl bg-red text-white text-sm font-medium hover:bg-red">
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
