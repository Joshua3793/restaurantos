'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import dynamic from 'next/dynamic'
import { useRouter } from 'next/navigation'
import type { Role } from '@prisma/client'
import { QUICKADD_WASTE } from '@/components/mobile/QuickAddSheet'
import { MScreen, MPageHead, MSectionLabel } from '@/components/mobile/kit'
import { formatCurrency } from '@/lib/utils'
import { prepDayKey, prepDaysAgo, displayDayKey } from '@/lib/prep-day'
import { atLeast } from '@/lib/roles'
import { CategoryBadge } from '@/components/CategoryBadge'
import { useRc } from '@/contexts/RevenueCenterContext'
import { useUser } from '@/contexts/UserContext'
import { setScopeParams } from '@/lib/scope-params'
import { ALL_REASONS, reasonLabel } from '@/components/wastage/reasons'
import { wasteUnits, wasteCost, fmtWasteQty, type WasteItem } from '@/components/wastage/units'
import { rankItems } from '@/components/wastage/search'
import { LogWasteSheet } from '@/components/wastage/LogWasteSheet'
import { useAppRefresh } from '@/lib/app-refresh'
import { WasteCard } from '@/components/wastage/WasteCard'
import { UndoToast, type WasteToast } from '@/components/wastage/UndoToast'
import type { WasteLogRow, WasteDraft, SaveResult } from '@/components/wastage/types'
import { Plus, X, AlertTriangle, Search, Check, Trash2 } from 'lucide-react'

// Lazy-load recharts — only renders when there are logs to display
const WastageCharts = dynamic(() => import('@/components/wastage/WastageCharts'), { ssr: false, loading: () => null })

// Searchable item selector (desktop) — type to fuzzy-match against the loaded
// inventory list; ↑↓ to move, ⏎ to pick. Prices only when the viewer sees money.
function ItemPicker({
  items,
  value,
  onSelect,
  showPrice,
}: {
  items: WasteItem[]
  value: string
  onSelect: (item: WasteItem | null) => void
  showPrice: boolean
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

  const results = rankItems(items, query, 8)

  const pick = (item: WasteItem) => {
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
            onClick={() => { onSelect(null); setQuery(''); setOpen(true) }}
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
                  {/* Staff used to see "$0.00/g" here (their prices are nulled) — now nothing. */}
                  {showPrice && item.pricePerBaseUnit != null && (
                    <div className="text-xs text-ink-3 tabular-nums">{formatCurrency(Number(item.pricePerBaseUnit))}/{item.baseUnit}</div>
                  )}
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

// Desktop row delete: inline confirm, no window.confirm.
function DeleteCell({ log, onDelete }: { log: WasteLogRow; onDelete: (id: string) => Promise<boolean> }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!log.canDelete) return null
  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        aria-label={`Delete ${log.inventoryItem.itemName}`}
        className="p-1.5 rounded text-ink-4 hover:text-red hover:bg-red-soft"
      >
        <Trash2 size={14} />
      </button>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <button type="button" disabled={busy} onClick={() => setConfirming(false)} className="px-2 py-1 rounded border border-line text-xs text-ink-2">Keep</button>
      <button
        type="button"
        disabled={busy}
        onClick={async () => { setBusy(true); const ok = await onDelete(log.id); setBusy(false); if (!ok) setConfirming(false) }}
        className="px-2 py-1 rounded bg-red text-white text-xs font-semibold disabled:opacity-60"
      >
        {busy ? '…' : 'Delete'}
      </button>
    </span>
  )
}

// Wastage is dated by the restaurant's (Pacific) day, stored as a UTC-midnight
// marker (src/lib/prep-day.ts). Defaults come from the Pacific clock — the old
// `toISOString()` default was the UTC day, so after ~4–5pm waste was dated tomorrow.
const todayKey = () => prepDayKey()
const weekAgoKey = () => prepDaysAgo(7).toISOString().slice(0, 10)

// A marker read through the browser's clock walks back a day (Nov 27 → "Nov 26"),
// so resolve the day first, then format it as that calendar day.
function dayOf(date: string): Date {
  return new Date(`${displayDayKey(new Date(date))}T12:00:00.000Z`)
}
function formatDay(date: string): string {
  return dayOf(date).toLocaleDateString('en-CA', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' })
}
function formatWeekday(date: string): string {
  return dayOf(date).toLocaleDateString('en-CA', { timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric' })
}

const REASON_COLORS: Record<string, string> = {
  SPOILAGE:       'bg-red-soft text-red-text',
  OVERPRODUCTION: 'bg-gold-soft text-gold-2',
  PREP_TRIM:      'bg-yellow-100 text-yellow-700',
  BURNT:          'bg-bg-2 text-ink-2',
  DROPPED:        'bg-gold/15 text-gold',
  COMP:           'bg-blue-soft text-blue-text',
  EXPIRED:        'bg-blue-soft text-blue-text',
  STAFF_MEAL:     'bg-green-soft text-green-text',
  UNKNOWN:        'bg-bg-2 text-ink-3',
}

const RC_MISSING = 'Pick one kitchen (not "All") at the top to log waste.'
const EMPTY_FORM = { inventoryItemId: '', qtyWasted: '', unit: 'g', reason: '', notes: '', date: todayKey() }
const sumCost = (rows: WasteLogRow[]) => rows.reduce((s, l) => s + Number(l.costImpact ?? 0), 0)

export default function WastagePage() {
  const { activeRcId, activeRc, activeKind, activeLocationId, ready: scopeReady } = useRc()
  const { role } = useUser()
  // Waste dollars are MANAGER+ (the API nulls them below that, too).
  const seesMoney = role ? atLeast(role as Role, 'MANAGER') : false
  const [logs, setLogs] = useState<WasteLogRow[]>([])
  const [inventoryItems, setInventoryItems] = useState<WasteItem[]>([])
  const [reasonFilter, setReasonFilter] = useState('')
  const [startDate, setStartDate] = useState(weekAgoKey)
  const [endDate, setEndDate] = useState(todayKey)
  const [showAdd, setShowAdd] = useState(false)
  const [phoneView, setPhoneView] = useState<'today' | 'week'>('today')
  const [toast, setToast] = useState<WasteToast | null>(null)
  const router = useRouter()
  // ＋ "Log waste" from another page lands here with ?new=1: drop the param
  // first (replace, so the ?new=1 history entry is gone and Back / refresh
  // can't reopen it), then open the Log form. (window, not useSearchParams, so
  // the page needs no Suspense boundary.) Already on this page, the ＋ sheet
  // doesn't navigate — it fires QUICKADD_WASTE instead.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('new') !== '1') return
    params.delete('new')
    const qs = params.toString()
    router.replace(qs ? `/wastage?${qs}` : '/wastage', { scroll: false })
    setShowAdd(true)
  }, [router])
  useEffect(() => {
    const open = () => setShowAdd(true)
    window.addEventListener(QUICKADD_WASTE, open)
    return () => window.removeEventListener(QUICKADD_WASTE, open)
  }, [])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState(() => ({ ...EMPTY_FORM, date: todayKey() }))

  const fetchLogs = useCallback(() => {
    if (!scopeReady) return Promise.resolve()   // wait for the scope, or this fires an unscoped load first
    const params = new URLSearchParams()
    if (reasonFilter) params.set('reason', reasonFilter)
    if (startDate) params.set('startDate', startDate)
    if (endDate) params.set('endDate', endDate)
    setScopeParams(params, { activeKind, activeRcId, activeRc, activeLocationId })
    // No signal or a bad answer keeps the list already on screen.
    return fetch(`/api/wastage?${params}`)
      .then(r => (r.ok ? r.json() : null))
      .then(rows => { if (Array.isArray(rows)) setLogs(rows) })
      .catch(() => {})
  }, [reasonFilter, startDate, endDate, activeRcId, activeRc, activeKind, activeLocationId, scopeReady])

  useEffect(() => { fetchLogs() }, [fetchLogs])
  useAppRefresh(() => { void fetchLogs() })
  useEffect(() => {
    fetch('/api/inventory').then(r => (r.ok ? r.json() : [])).then(rows => setInventoryItems(Array.isArray(rows) ? rows : []))
  }, [])

  const closeAdd = useCallback(() => setShowAdd(false), [])
  const dismissToast = useCallback(() => setToast(null), [])

  // ONE save for both forms. Returns the saved row so the phone sheet can reset
  // for the next entry; the toast carries its Undo.
  const saveWaste = useCallback(async (draft: WasteDraft): Promise<SaveResult> => {
    if (!activeRcId) return { ok: false, error: RC_MISSING }
    try {
      const res = await fetch('/api/wastage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...draft, revenueCenterId: activeRcId }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) return { ok: false, error: body?.error ?? 'That didn’t save. Try again.' }
      const log = body as WasteLogRow
      setLogs(prev => [log, ...prev.filter(l => l.id !== log.id)])
      setToast({ id: Date.now(), text: `Logged ${fmtWasteQty(log.qtyWasted, log.unit)} ${log.inventoryItem.itemName}`, undoId: log.id })
      fetchLogs()
      return { ok: true, log }
    } catch {
      return { ok: false, error: 'No connection — that didn’t save. Try again.' }
    }
  }, [activeRcId, fetchLogs])

  const deleteWaste = useCallback(async (id: string): Promise<boolean> => {
    try {
      const res = await fetch(`/api/wastage/${id}`, { method: 'DELETE' })
      // 404 = already gone (an Undo racing a delete) — same outcome for the list.
      if (!res.ok && res.status !== 404) {
        const body = await res.json().catch(() => null)
        setToast({ id: Date.now(), text: body?.error ?? 'That didn’t delete. Try again.' })
        return false
      }
      setLogs(prev => prev.filter(l => l.id !== id))
      fetchLogs()
      return true
    } catch {
      setToast({ id: Date.now(), text: 'No connection — that didn’t delete. Try again.' })
      return false
    }
  }, [fetchLogs])

  const undo = useCallback(async (id: string) => {
    setToast(null)
    if (await deleteWaste(id)) setToast({ id: Date.now(), text: 'Undone — that entry is gone.' })
  }, [deleteWaste])

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!activeRcId) { setError(RC_MISSING); return }
    if (!form.inventoryItemId) { setError('Pick an item.'); return }
    if (!form.reason) { setError('Pick a reason.'); return }
    setError(null)
    setSaving(true)
    try {
      const res = await saveWaste(form)
      if (!res.ok) { setError(res.error); return }
      setShowAdd(false)
      setForm({ ...EMPTY_FORM, date: todayKey() })
    } finally {
      setSaving(false)
    }
  }

  const totalCost = sumCost(logs)

  // Preview cost — through the item's units (2 kg = 2,000 g), not qty × $/g.
  const selectedItem = inventoryItems.find(i => i.id === form.inventoryItemId) ?? null
  const previewCost = seesMoney ? wasteCost(selectedItem, parseFloat(form.qtyWasted), form.unit) ?? 0 : 0

  // ── Phone lists ────────────────────────────────────────────────────────────
  const today = todayKey()
  const todayLogs = logs.filter(l => displayDayKey(new Date(l.date)) === today)
  const weekDays = (() => {
    const by = new Map<string, WasteLogRow[]>()
    for (const l of logs) {
      const k = displayDayKey(new Date(l.date))
      by.set(k, [...(by.get(k) ?? []), l])
    }
    return [...by.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))
  })()

  // ── Charts data ────────────────────────────────────────────────────────────

  // Pie: cost by reason
  const byReason = Object.entries(
    logs.reduce((acc, l) => {
      const r = reasonLabel(l.reason)
      acc[r] = (acc[r] ?? 0) + Number(l.costImpact ?? 0)
      return acc
    }, {} as Record<string, number>)
  )
    .map(([reason, cost]) => ({ reason, cost }))
    .sort((a, b) => b.cost - a.cost)

  // Bar: cost by week (group logs into 7-day buckets)
  const byWeek = (() => {
    const buckets: Record<string, number> = {}
    logs.forEach(l => {
      const d = dayOf(l.date)
      // Snap to Monday of that week (UTC maths on the resolved calendar day)
      const day = d.getUTCDay()
      const diff = (day === 0 ? -6 : 1 - day)
      d.setUTCDate(d.getUTCDate() + diff)
      const key = d.toLocaleDateString('en-CA', { timeZone: 'UTC', month: 'short', day: 'numeric' })
      buckets[key] = (buckets[key] ?? 0) + Number(l.costImpact ?? 0)
    })
    return Object.entries(buckets)
      .map(([week, cost]) => ({ week, cost: parseFloat(cost.toFixed(2)) }))
      .slice(-6)
  })()

  return (
    <>
      {/* ── Phone ─────────────────────────────────────────────────────────── */}
      <MScreen>
        <MPageHead
          title="Waste"
          eyebrow={phoneView === 'today' ? 'Today' : 'Last 7 days'}
          right={
            <button
              type="button"
              onClick={() => setPhoneView(v => (v === 'today' ? 'week' : 'today'))}
              className="min-h-[44px] px-2 text-[14px] font-medium text-gold-2"
            >
              {phoneView === 'today' ? 'Week view' : 'Back to today'}
            </button>
          }
        />

        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="w-full min-h-[60px] rounded-2xl bg-red text-white text-[18px] font-semibold flex items-center justify-center gap-2 active:opacity-90"
        >
          <Plus size={22} /> Log waste
        </button>

        {phoneView === 'today' ? (
          <>
            <MSectionLabel right={seesMoney && todayLogs.length > 0 ? formatCurrency(sumCost(todayLogs)) : undefined}>
              {`Today · ${todayLogs.length} ${todayLogs.length === 1 ? 'entry' : 'entries'}`}
            </MSectionLabel>
            {todayLogs.length === 0 ? (
              <div className="text-center text-[15px] text-ink-4 py-10">Nothing logged today.</div>
            ) : (
              <div className="space-y-2">
                {todayLogs.map(l => <WasteCard key={l.id} log={l} showMoney={seesMoney} onDelete={deleteWaste} />)}
              </div>
            )}
          </>
        ) : weekDays.length === 0 ? (
          <div className="text-center text-[15px] text-ink-4 py-10">Nothing logged this week.</div>
        ) : (
          weekDays.map(([key, rows]) => (
            <div key={key}>
              <MSectionLabel right={seesMoney ? formatCurrency(sumCost(rows)) : undefined}>
                {key === today ? 'Today' : formatWeekday(rows[0].date)}
              </MSectionLabel>
              <div className="space-y-2">
                {rows.map(l => <WasteCard key={l.id} log={l} showMoney={seesMoney} onDelete={deleteWaste} />)}
              </div>
            </div>
          ))
        )}
      </MScreen>

      <LogWasteSheet
        open={showAdd}
        onClose={closeAdd}
        items={inventoryItems}
        showMoney={seesMoney}
        rcError={activeRcId ? null : RC_MISSING}
        onSave={saveWaste}
      />

      <UndoToast toast={toast} onUndo={undo} onDismiss={dismissToast} />

      {/* ── Desktop ───────────────────────────────────────────────────────── */}
      <div className="hidden md:block space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h1 className="text-2xl font-bold text-ink">Wastage Log</h1>
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-2 bg-ink text-paper [&_svg]:text-gold px-3 py-2 rounded-lg text-sm hover:bg-ink-2 transition-colors"
        >
          <Plus size={16} /> Log Wastage
        </button>
      </div>

      {/* Summary — the dollars are MANAGER+ */}
      <div className="bg-red-soft border border-red-soft rounded-xl p-4 flex items-center gap-3">
        <AlertTriangle size={20} className="text-red shrink-0" />
        {seesMoney ? (
          <div>
            <div className="font-semibold text-red-text">Total Wastage Cost (filtered)</div>
            <div className="text-2xl font-bold text-red-text">{formatCurrency(totalCost)}</div>
          </div>
        ) : (
          <div className="font-semibold text-red-text">Waste logged (filtered)</div>
        )}
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
          {ALL_REASONS.map(r => <option key={r.code} value={r.code}>{r.label}</option>)}
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

      {/* Charts — cost charts, so MANAGER+ only; recharts loads lazily */}
      {seesMoney && logs.length > 0 && (
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
                {seesMoney && <th className="text-right px-4 py-3 font-medium text-ink-3">Cost Impact</th>}
                <th className="text-left px-4 py-3 font-medium text-ink-3 hidden lg:table-cell">Logged By</th>
                <th className="w-px px-2 py-3"><span className="sr-only">Delete</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {logs.map(log => (
                <tr key={log.id} className="hover:bg-bg">
                  <td className="px-4 py-3 text-ink-3 whitespace-nowrap">{formatDay(log.date)}</td>
                  <td className="px-4 py-3 font-medium text-ink-2">{log.inventoryItem.itemName}</td>
                  <td className="px-4 py-3 hidden sm:table-cell">
                    <CategoryBadge category={log.inventoryItem.category} />
                  </td>
                  <td className="px-4 py-3 text-right text-ink-2 whitespace-nowrap">
                    {fmtWasteQty(log.qtyWasted, log.unit)}
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${REASON_COLORS[log.reason] || 'bg-bg-2 text-ink-3'}`}>
                      {reasonLabel(log.reason)}
                    </span>
                  </td>
                  {seesMoney && (
                    <td className="px-4 py-3 text-right font-semibold text-red">
                      {formatCurrency(Number(log.costImpact ?? 0))}
                    </td>
                  )}
                  <td className="px-4 py-3 text-ink-3 hidden lg:table-cell">{log.loggedBy}</td>
                  <td className="px-2 py-3 text-right"><DeleteCell log={log} onDelete={deleteWaste} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {logs.length === 0 && (
            <div className="text-center py-12 text-ink-4">No wastage logs found</div>
          )}
        </div>
      </div>
      </div>

      {/* Add Wastage Modal — desktop only; the phone gets the bottom sheet above. */}
      {showAdd && (
        <div
          className="hidden md:flex fixed inset-0 z-50 items-center justify-center p-4"
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
                  showPrice={seesMoney}
                  onSelect={item => setForm(f => ({ ...f, inventoryItemId: item?.id ?? '', unit: item?.baseUnit || 'g' }))}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-ink-3 mb-1">Qty Wasted *</label>
                  <input
                    type="number"
                    required
                    min="0"
                    value={form.qtyWasted}
                    onChange={e => setForm(f => ({ ...f, qtyWasted: e.target.value }))}
                    onFocus={e => e.currentTarget.select()}
                    inputMode="decimal"
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
                    {/* Only units this item can be booked in (no 'batch' on Butter, no 'case' on Buns). */}
                    {wasteUnits(selectedItem).map(u => (
                      <option key={u}>{u}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-3 mb-1">Reason *</label>
                <select
                  required
                  value={form.reason}
                  onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
                  className="w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                >
                  <option value="" disabled>Pick a reason…</option>
                  {ALL_REASONS.map(r => <option key={r.code} value={r.code}>{r.label}</option>)}
                </select>
              </div>
              {/* No "Logged by" box — the server records whoever is signed in. */}
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
                  <span>{error ?? RC_MISSING}</span>
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
    </>
  )
}
