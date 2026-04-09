'use client'

import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react'
import {
  AlertCircle, ArrowLeft, Check, CheckCircle2, ChevronDown,
  Circle, ClipboardList, Minus, Plus, SkipForward, X,
} from 'lucide-react'
import { CategoryBadge } from '@/components/CategoryBadge'
import { formatCurrency } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

interface InventoryItemRef {
  id: string
  itemName: string
  category: string
  purchaseUnit: string
  location: string | null
  storageArea: { name: string } | null
}

interface Line {
  id: string
  sessionId: string
  inventoryItemId: string
  inventoryItem: InventoryItemRef
  expectedQty: number
  countedQty: number | null
  selectedUom: string
  skipped: boolean
  variancePct: number | null
  varianceCost: number | null
  priceAtCount: number
  sortOrder: number
  notes: string | null
}

interface Session {
  id: string
  label: string
  sessionDate: string
  type: string
  areaFilter: string | null
  countedBy: string
  status: string
  startedAt: string
  finalizedAt: string | null
  totalCountedValue: number
  counts?: { total: number; counted: number; skipped: number }
  lines?: Line[]
}

// ─── Constants ────────────────────────────────────────────────────────────────

const AREA_OPTIONS = ['Walk-in & fridge', 'Freezer', 'Dry storage', 'Prep area', 'Catering']

// ─── Helpers ─────────────────────────────────────────────────────────────────

function varColor(pct: number | null) {
  if (pct === null) return ''
  const a = Math.abs(pct)
  if (a <= 5)  return 'text-green-600'
  if (a <= 15) return 'text-amber-600'
  return 'text-red-600'
}

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function Toast({ msg, onDone }: { msg: string; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, 4000); return () => clearTimeout(t) }, [onDone])
  return (
    <div className="fixed bottom-20 md:bottom-6 left-1/2 -translate-x-1/2 z-50 bg-green-700 text-white text-sm font-medium px-5 py-3 rounded-xl shadow-xl flex items-center gap-2 max-w-sm w-full mx-4">
      <Check size={15} className="shrink-0" />
      <span>{msg}</span>
    </div>
  )
}

// ─── StatusBadge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    IN_PROGRESS:    'bg-blue-100 text-blue-700',
    PENDING_REVIEW: 'bg-amber-100 text-amber-700',
    FINALIZED:      'bg-green-100 text-green-700',
    CANCELLED:      'bg-gray-100 text-gray-500',
  }
  const labels: Record<string, string> = {
    IN_PROGRESS: 'In progress', PENDING_REVIEW: 'Pending review',
    FINALIZED: 'Finalized', CANCELLED: 'Cancelled',
  }
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${map[status] ?? 'bg-gray-100 text-gray-500'}`}>
      {labels[status] ?? status}
    </span>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

type View = 'list' | 'count' | 'review'

export default function CountPage() {
  // ── Global state ──────────────────────────────────────────────────────────
  const [view,          setView]          = useState<View>('list')
  const [sessions,      setSessions]      = useState<Session[]>([])
  const [active,        setActive]        = useState<Session | null>(null)
  const [toast,         setToast]         = useState<string | null>(null)
  const [showModal,     setShowModal]     = useState(false)
  const [finalizing,    setFinalizing]    = useState(false)

  // ── Count-mode state ──────────────────────────────────────────────────────
  const [openId,        setOpenId]        = useState<string | null>(null)
  const [inputQty,      setInputQty]      = useState(0)
  const [catFilter,     setCatFilter]     = useState<string | null>(null)
  const [locFilter,     setLocFilter]     = useState<string | null>(null)
  const [statusFilter,  setStatusFilter]  = useState<'all' | 'uncounted' | 'counted'>('all')

  // ── New-session form ──────────────────────────────────────────────────────
  const [form, setForm] = useState({
    label: '', countedBy: '',
    type: 'FULL' as 'FULL' | 'PARTIAL',
    sessionDate: new Date().toISOString().slice(0, 10),
    areas: [] as string[],
  })

  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({})

  // ── Loaders ───────────────────────────────────────────────────────────────
  const loadSessions = useCallback(async () => {
    const data = await fetch('/api/count/sessions').then(r => r.json()).catch(() => [])
    setSessions(Array.isArray(data) ? data : [])
  }, [])

  const loadSession = useCallback(async (id: string): Promise<Session | null> => {
    return fetch(`/api/count/sessions/${id}`).then(r => r.json()).catch(() => null)
  }, [])

  useEffect(() => { loadSessions() }, [loadSessions])

  // Reset qty input when card opens
  useEffect(() => {
    if (!openId || !active?.lines) return
    const line = active.lines.find(l => l.id === openId)
    if (line) setInputQty(line.countedQty ?? Number(line.expectedQty))
  }, [openId, active?.lines])

  // ── Computed ──────────────────────────────────────────────────────────────
  const { total, counted } = useMemo(() => {
    const lines = active?.lines ?? []
    return {
      total:   lines.length,
      counted: lines.filter(l => l.countedQty !== null || l.skipped).length,
    }
  }, [active?.lines])

  const locations = useMemo(() => {
    const lines = active?.lines ?? []
    const set = new Set<string>()
    for (const l of lines) {
      const loc = l.inventoryItem.location ?? l.inventoryItem.storageArea?.name
      if (loc) set.add(loc)
    }
    return Array.from(set).sort()
  }, [active?.lines])

  const categories = useMemo(() => {
    const lines = active?.lines ?? []
    const map: Record<string, number> = {}
    for (const l of lines) { map[l.inventoryItem.category] = (map[l.inventoryItem.category] || 0) + 1 }
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b))
  }, [active?.lines])

  const filteredLines = useMemo(() => {
    const lines = active?.lines ?? []
    return lines.filter(l => {
      if (catFilter && l.inventoryItem.category !== catFilter) return false
      if (locFilter) {
        const loc = l.inventoryItem.location ?? l.inventoryItem.storageArea?.name ?? ''
        if (!loc.toLowerCase().includes(locFilter.toLowerCase())) return false
      }
      if (statusFilter === 'uncounted') return l.countedQty === null && !l.skipped
      if (statusFilter === 'counted')   return l.countedQty !== null || l.skipped
      return true
    }).sort((a, b) => a.sortOrder - b.sortOrder)
  }, [active?.lines, catFilter, locFilter, statusFilter])

  const grouped = useMemo(() => {
    if (catFilter) return null
    return filteredLines.reduce((acc, l) => {
      const cat = l.inventoryItem.category
      if (!acc[cat]) acc[cat] = []
      acc[cat].push(l)
      return acc
    }, {} as Record<string, Line[]>)
  }, [filteredLines, catFilter])

  // ── Actions ───────────────────────────────────────────────────────────────
  const openSession = async (s: Session, target: View) => {
    const full = await loadSession(s.id)
    if (!full) return
    setActive(full)
    setCatFilter(null); setLocFilter(null); setStatusFilter('all'); setOpenId(null)
    setView(target)
  }

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.countedBy.trim()) return
    const res = await fetch('/api/count/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label:       form.label.trim() || undefined,
        type:        form.type,
        countedBy:   form.countedBy.trim(),
        sessionDate: form.sessionDate,
        areaFilter:  form.areas.length ? form.areas.join(',') : undefined,
      }),
    })
    const session = await res.json()
    setShowModal(false)
    setForm({ label: '', countedBy: '', type: 'FULL', sessionDate: new Date().toISOString().slice(0, 10), areas: [] })
    await loadSessions()
    const full = await loadSession(session.id)
    if (full) { setActive(full); setCatFilter(null); setLocFilter(null); setStatusFilter('all'); setOpenId(null); setView('count') }
  }

  const confirmLine = async (line: Line, qty: number) => {
    // Optimistic update
    const vPct  = Number(line.expectedQty) > 0 ? ((qty - Number(line.expectedQty)) / Number(line.expectedQty)) * 100 : 0
    const vCost = (qty - Number(line.expectedQty)) * Number(line.priceAtCount)
    setActive(prev => ({
      ...prev!,
      lines: prev!.lines!.map(l =>
        l.id === line.id ? { ...l, countedQty: qty, skipped: false, variancePct: vPct, varianceCost: vCost } : l
      ),
    }))
    setOpenId(null)
    // Auto-advance to next uncounted
    const next = filteredLines.find(l => l.id !== line.id && l.countedQty === null && !l.skipped)
    if (next) {
      setTimeout(() => {
        setOpenId(next.id)
        cardRefs.current[next.id]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }, 120)
    }
    // Persist
    await fetch(`/api/count/sessions/${active!.id}/lines/${line.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ countedQty: qty }),
    })
  }

  const skipLine = async (line: Line) => {
    setActive(prev => ({
      ...prev!, lines: prev!.lines!.map(l => l.id === line.id ? { ...l, skipped: true } : l),
    }))
    setOpenId(null)
    await fetch(`/api/count/sessions/${active!.id}/lines/${line.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skipped: true }),
    })
  }

  const handleFinalize = async () => {
    if (!active || finalizing) return
    setFinalizing(true)
    await fetch(`/api/count/sessions/${active.id}/finalize`, { method: 'POST' })
    setToast('Inventory updated · Snapshot saved · COGS report now available for this period.')
    await loadSessions()
    setTimeout(() => { setView('list'); setActive(null); setFinalizing(false) }, 2000)
  }

  const backFromCount = () => {
    if (counted > 0 && !confirm('Leave count session? All confirmed items are saved.')) return
    setView('list'); setActive(null); setOpenId(null)
  }

  // ════════════════════════════════════════════════════════════════════════════
  // VIEW A — SESSION LIST
  // ════════════════════════════════════════════════════════════════════════════
  if (view === 'list') return (
    <div className="max-w-2xl">
      {toast && <Toast msg={toast} onDone={() => setToast(null)} />}

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Stock Count</h1>
        <button
          onClick={() => setShowModal(true)}
          className="flex items-center gap-2 bg-green-600 text-white px-4 py-2 rounded-xl text-sm font-semibold hover:bg-green-700 transition-colors"
        >
          <Plus size={16} /> Start Count
        </button>
      </div>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 z-40 bg-black/40 flex items-end sm:items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-gray-100">
              <h2 className="text-lg font-bold text-gray-900">Start count session</h2>
              <button onClick={() => setShowModal(false)}><X size={20} className="text-gray-400" /></button>
            </div>
            <form onSubmit={handleCreate} className="p-5 space-y-4">
              {/* Label */}
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">Label</label>
                <input
                  value={form.label}
                  onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
                  placeholder={`e.g. Full count ${fmtDate(new Date().toISOString())}`}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
              {/* Who's counting */}
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">
                  Who&apos;s counting <span className="text-red-500">*</span>
                </label>
                <input
                  required
                  value={form.countedBy}
                  onChange={e => setForm(f => ({ ...f, countedBy: e.target.value }))}
                  placeholder="Name"
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
              {/* Count type */}
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">Count type</label>
                <div className="flex gap-2">
                  {(['FULL', 'PARTIAL'] as const).map(t => (
                    <button key={t} type="button"
                      onClick={() => setForm(f => ({ ...f, type: t }))}
                      className={`flex-1 py-2 rounded-xl text-sm font-medium border transition-colors ${
                        form.type === t ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                      }`}
                    >
                      {t === 'FULL' ? 'Full count' : 'Partial count'}
                    </button>
                  ))}
                </div>
              </div>
              {/* Area filter — Partial only */}
              {form.type === 'PARTIAL' && (
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1.5">Areas to count</label>
                  <div className="flex flex-wrap gap-2">
                    {AREA_OPTIONS.map(a => {
                      const on = form.areas.includes(a)
                      return (
                        <button key={a} type="button"
                          onClick={() => setForm(f => ({
                            ...f,
                            areas: on ? f.areas.filter(x => x !== a) : [...f.areas, a],
                          }))}
                          className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                            on ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                          }`}
                        >
                          {a}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
              {/* Date */}
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">Date</label>
                <input
                  type="date"
                  value={form.sessionDate}
                  onChange={e => setForm(f => ({ ...f, sessionDate: e.target.value }))}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
              {/* Buttons */}
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={() => setShowModal(false)}
                  className="flex-1 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-600 hover:bg-gray-50 font-medium"
                >
                  Cancel
                </button>
                <button id="count-submit" type="submit"
                  className="flex-1 py-2.5 bg-green-600 text-white rounded-xl text-sm font-semibold hover:bg-green-700"
                >
                  Start →
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Session list */}
      {sessions.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <ClipboardList size={44} className="mx-auto mb-4 opacity-30" />
          <p className="font-medium text-gray-500">No count sessions yet.</p>
          <p className="text-sm mt-1">Start your first count to track inventory accurately.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {sessions.map(s => {
            const counts = s.counts ?? { total: 0, counted: 0, skipped: 0 }
            return (
              <div key={s.id} className="bg-white border border-gray-100 rounded-2xl shadow-sm px-4 py-3 flex items-center gap-4">
                <div className="text-xs text-gray-400 font-medium min-w-[44px] text-center">
                  {fmtDate(s.sessionDate)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-sm text-gray-900 truncate">
                    {s.label || (s.type === 'FULL' ? 'Full count' : 'Partial count')}
                  </div>
                  <div className="text-xs text-gray-400 mt-0.5">
                    {s.countedBy}
                    {s.status === 'FINALIZED'
                      ? ` · ${counts.total} items · ${formatCurrency(Number(s.totalCountedValue))}`
                      : ` · ${counts.counted}/${counts.total} items`}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <StatusBadge status={s.status} />
                  {s.status === 'IN_PROGRESS' && (
                    <button onClick={() => openSession(s, 'count')}
                      className="text-xs font-semibold text-blue-600 hover:text-blue-700 ml-1">
                      Continue →
                    </button>
                  )}
                  {s.status === 'PENDING_REVIEW' && (
                    <button onClick={() => openSession(s, 'count')}
                      className="text-xs font-semibold text-amber-600 hover:text-amber-700 ml-1">
                      Review →
                    </button>
                  )}
                  {s.status === 'FINALIZED' && (
                    <button onClick={() => openSession(s, 'review')}
                      className="text-xs font-semibold text-green-700 hover:text-green-800 ml-1">
                      View report
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )

  // ════════════════════════════════════════════════════════════════════════════
  // VIEW B — COUNT MODE
  // ════════════════════════════════════════════════════════════════════════════
  if (view === 'count' && active) {
    const renderLine = (line: Line) => {
      const isOpen    = openId === line.id
      const isCounted = line.countedQty !== null && !line.skipped
      const isSkipped = line.skipped
      const locLabel  = line.inventoryItem.location ?? line.inventoryItem.storageArea?.name

      const liveVar = isOpen && Number(line.expectedQty) > 0
        ? ((inputQty - Number(line.expectedQty)) / Number(line.expectedQty)) * 100
        : null

      if (isSkipped) return (
        <div key={line.id} id={`ln-${line.id}`}
          ref={el => { cardRefs.current[line.id] = el }}
          onClick={() => setOpenId(isOpen ? null : line.id)}
          className="mx-4 mb-2 border border-gray-100 bg-gray-50 rounded-xl opacity-60 cursor-pointer"
        >
          <div className="flex items-center gap-3 px-4 py-3">
            <SkipForward size={16} className="text-gray-400 shrink-0" />
            <span className="flex-1 text-sm text-gray-500 line-through">{line.inventoryItem.itemName}</span>
            <span className="text-xs text-gray-400">Skipped</span>
          </div>
        </div>
      )

      if (isCounted && !isOpen) {
        const vPct = line.variancePct
        const large = vPct !== null && Math.abs(vPct) > 15
        return (
          <div key={line.id} id={`ln-${line.id}`}
            ref={el => { cardRefs.current[line.id] = el }}
            onClick={() => setOpenId(line.id)}
            className={`mx-4 mb-2 rounded-xl bg-green-50 border border-green-200 cursor-pointer ${large ? 'border-l-4 border-l-amber-400' : ''}`}
          >
            <div className="flex items-center gap-3 px-4 py-3">
              <CheckCircle2 size={20} className="text-green-500 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-gray-900">{line.inventoryItem.itemName}</div>
                <div className="text-xs text-gray-500 mt-0.5 flex items-center gap-1.5">
                  <span>{Number(line.countedQty).toFixed(2)} {line.selectedUom}</span>
                  {vPct !== null && (
                    <span className={varColor(vPct)}>· {vPct >= 0 ? '+' : ''}{vPct.toFixed(1)}%</span>
                  )}
                </div>
              </div>
              <CategoryBadge category={line.inventoryItem.category} />
              {locLabel && <span className="text-xs text-gray-400 ml-1 hidden sm:block">{locLabel}</span>}
              <span className="text-xs text-blue-500 font-medium ml-1">Edit</span>
            </div>
          </div>
        )
      }

      // Uncounted / open
      const largeOpen = liveVar !== null && Math.abs(liveVar) > 15
      return (
        <div key={line.id} id={`ln-${line.id}`}
          ref={el => { cardRefs.current[line.id] = el }}
          className={`mx-4 mb-2 rounded-xl bg-white transition-all ${
            isOpen
              ? `border-2 border-green-400${largeOpen ? ' border-l-4 border-l-amber-400' : ''}`
              : 'border border-gray-200'
          }`}
        >
          {/* Header row */}
          <div className="flex items-center gap-3 px-4 py-3 cursor-pointer"
            onClick={() => setOpenId(isOpen ? null : line.id)}
          >
            <Circle size={18} className="text-gray-300 shrink-0" />
            <span className="flex-1 text-sm font-medium text-gray-900">{line.inventoryItem.itemName}</span>
            <CategoryBadge category={line.inventoryItem.category} />
            {locLabel && <span className="text-xs text-gray-400 ml-1">{locLabel}</span>}
            <ChevronDown size={16} className={`text-gray-400 ml-1 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
          </div>

          {/* Expanded body */}
          {isOpen && (
            <div className="px-4 pb-4 pt-1 border-t border-gray-100">
              {/* Expected + live variance */}
              <div className="text-xs text-gray-500 mb-3 flex items-center gap-1.5">
                <span>Expected: {Number(line.expectedQty).toFixed(2)} {line.selectedUom}</span>
                {liveVar !== null && (
                  <span className={`font-medium ${varColor(liveVar)}`}>
                    · {liveVar > 0 ? '+' : ''}{liveVar.toFixed(1)}%
                  </span>
                )}
              </div>

              {/* ± stepper — 66px tall */}
              <div className="flex items-center gap-2 mb-3">
                <button
                  onClick={() => setInputQty(v => Math.max(0, Math.round((v - 1) * 100) / 100))}
                  className="w-14 h-[66px] rounded-xl bg-gray-100 flex items-center justify-center hover:bg-gray-200 transition-colors shrink-0"
                >
                  <Minus size={20} className="text-gray-700" />
                </button>
                <input
                  type="number"
                  value={inputQty}
                  onChange={e => setInputQty(parseFloat(e.target.value) || 0)}
                  className="flex-1 h-[66px] text-center text-2xl font-bold border-2 border-gray-200 rounded-xl focus:border-green-400 focus:outline-none"
                  min={0} step={0.1}
                />
                <button
                  onClick={() => setInputQty(v => Math.round((v + 1) * 100) / 100)}
                  className="w-14 h-[66px] rounded-xl bg-gray-100 flex items-center justify-center hover:bg-gray-200 transition-colors shrink-0"
                >
                  <Plus size={20} className="text-gray-700" />
                </button>
              </div>

              {/* UOM */}
              <div className="text-center text-sm font-medium text-gray-500 mb-4">{line.selectedUom}</div>

              {/* Action buttons */}
              <div className="flex gap-2">
                <button
                  onClick={() => confirmLine(line, inputQty)}
                  className="flex-1 h-12 bg-green-500 text-white rounded-xl font-semibold text-sm hover:bg-green-600 transition-colors flex items-center justify-center gap-1.5"
                >
                  <Check size={16} /> Confirm count
                </button>
                <button
                  onClick={() => skipLine(line)}
                  className="px-5 h-12 border border-gray-200 rounded-xl text-sm text-gray-500 hover:bg-gray-50 transition-colors flex items-center gap-1.5"
                >
                  <SkipForward size={14} /> Skip
                </button>
              </div>
            </div>
          )}
        </div>
      )
    }

    return (
      <div className="max-w-2xl pb-28">
        {toast && <Toast msg={toast} onDone={() => setToast(null)} />}

        {/* ── Sticky top bar ─────────────────────────────────────────────────── */}
        <div className="sticky top-0 z-20 bg-white border-b border-gray-100 shadow-sm px-4 py-3 flex items-center gap-3">
          <button onClick={backFromCount} className="-ml-1 p-1 text-gray-500 hover:text-gray-800">
            <ArrowLeft size={20} />
          </button>
          <div className="flex-1 min-w-0 text-center">
            <span className="text-sm font-semibold text-gray-900 truncate block">{active.label}</span>
          </div>
          <span className="shrink-0 bg-gray-100 text-gray-700 rounded-full px-3 py-1 text-xs font-medium whitespace-nowrap">
            {counted} / {total} done
          </span>
          <button
            onClick={() => setView('review')}
            className="shrink-0 bg-blue-600 text-white text-xs font-semibold px-3 py-1.5 rounded-lg hover:bg-blue-700 whitespace-nowrap"
          >
            Review &amp; finish
          </button>
        </div>

        {/* ── Progress bar ───────────────────────────────────────────────────── */}
        <div className="h-1.5 bg-gray-200">
          <div
            className="h-1.5 bg-green-500 transition-all duration-300"
            style={{ width: `${total > 0 ? (counted / total) * 100 : 0}%` }}
          />
        </div>

        {/* ── Filter pills ───────────────────────────────────────────────────── */}
        <div className="px-4 pt-3 pb-2 space-y-2">
          {/* Row 1 — Category */}
          <div className="flex gap-1.5 overflow-x-auto scrollbar-none pb-0.5">
            <Pill active={catFilter === null} onClick={() => setCatFilter(null)}>
              All items <span className="opacity-60">{active.lines?.length ?? 0}</span>
            </Pill>
            {categories.map(([cat, n]) => (
              <Pill key={cat} active={catFilter === cat} onClick={() => setCatFilter(cat)}>
                {cat} <span className="opacity-60">{n}</span>
              </Pill>
            ))}
          </div>

          {/* Row 2 — Location (only when items have locations) */}
          {locations.length > 0 && (
            <div className="flex gap-1.5 overflow-x-auto scrollbar-none pb-0.5">
              <Pill active={locFilter === null} onClick={() => setLocFilter(null)}>All locations</Pill>
              {locations.map(loc => (
                <Pill key={loc} active={locFilter === loc} onClick={() => setLocFilter(loc)}>{loc}</Pill>
              ))}
            </div>
          )}

          {/* Row 3 — Status */}
          <div className="flex gap-1.5">
            {(['all', 'uncounted', 'counted'] as const).map(f => (
              <Pill key={f} active={statusFilter === f} onClick={() => setStatusFilter(f)}>
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </Pill>
            ))}
          </div>
        </div>

        {/* ── Items ──────────────────────────────────────────────────────────── */}
        <div className="pt-1">
          {catFilter ? (
            filteredLines.length === 0
              ? <Empty />
              : filteredLines.map(renderLine)
          ) : (
            !grouped || Object.keys(grouped).length === 0
              ? <Empty />
              : Object.entries(grouped)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([cat, lines]) => {
                    const catDone = lines.filter(l => l.countedQty !== null || l.skipped).length
                    return (
                      <div key={cat} className="mb-2">
                        <div className="flex items-center gap-2 px-4 py-2">
                          <span className="text-xs font-semibold uppercase tracking-wide text-gray-600">{cat}</span>
                          <span className="text-xs text-gray-400">{catDone}/{lines.length}</span>
                          <div className="flex-1 max-w-[80px] h-1 bg-gray-100 rounded-full ml-1">
                            <div className="h-1 bg-green-400 rounded-full"
                              style={{ width: `${lines.length > 0 ? (catDone / lines.length) * 100 : 0}%` }} />
                          </div>
                        </div>
                        {lines.map(renderLine)}
                      </div>
                    )
                  })
          )}
        </div>
      </div>
    )
  }

  // ════════════════════════════════════════════════════════════════════════════
  // VIEW C — REVIEW & FINALIZE
  // ════════════════════════════════════════════════════════════════════════════
  if (view === 'review' && active) {
    const lines        = active.lines ?? []
    const countedLines = lines.filter(l => l.countedQty !== null && !l.skipped)
    const flagged      = lines.filter(l => l.variancePct !== null && Math.abs(Number(l.variancePct)) > 15)
    const totalValue   = countedLines.reduce((s, l) => s + Number(l.countedQty) * Number(l.priceAtCount), 0)
    const isFinalized  = active.status === 'FINALIZED'
    const sorted       = [...countedLines].sort(
      (a, b) => Math.abs(Number(b.varianceCost ?? 0)) - Math.abs(Number(a.varianceCost ?? 0))
    )

    return (
      <div className="max-w-2xl">
        {toast && <Toast msg={toast} onDone={() => setToast(null)} />}

        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={() => { if (isFinalized) { setView('list'); setActive(null) } else setView('count') }}
            className="-ml-1 p-1 text-gray-500 hover:text-gray-800"
          >
            <ArrowLeft size={20} />
          </button>
          <div className="flex-1">
            <h1 className="text-xl font-bold text-gray-900">Review Count</h1>
            <p className="text-xs text-gray-400 mt-0.5">{active.label} · {active.countedBy}</p>
          </div>
          {!isFinalized && (
            <button onClick={() => setView('count')} className="text-sm text-blue-600 hover:text-blue-700 font-medium shrink-0">
              ← Back to counting
            </button>
          )}
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-3 mb-6">
          {[
            { val: countedLines.length.toString(), label: 'Items counted' },
            { val: flagged.length.toString(), label: 'Flagged (>15%)', red: flagged.length > 0 },
            { val: formatCurrency(totalValue), label: 'Total value' },
          ].map(s => (
            <div key={s.label} className="bg-white border border-gray-100 rounded-2xl shadow-sm p-4 text-center">
              <div className={`text-2xl font-bold ${s.red ? 'text-amber-600' : 'text-gray-900'}`}>{s.val}</div>
              <div className="text-xs text-gray-500 mt-0.5">{s.label}</div>
            </div>
          ))}
        </div>

        {/* Variance table */}
        {sorted.length > 0 && (
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden mb-6">
            <div className="px-4 py-3 border-b border-gray-50">
              <h2 className="text-sm font-semibold text-gray-800">Variance breakdown</h2>
            </div>
            <div className="divide-y divide-gray-50">
              <div className="px-4 py-2 grid grid-cols-[1fr_80px_80px_70px_90px] gap-2 text-xs font-semibold text-gray-400">
                <span>Item</span>
                <span className="text-right">Expected</span>
                <span className="text-right">Counted</span>
                <span className="text-right">Var %</span>
                <span className="text-right">Cost impact</span>
              </div>
              {sorted.map(l => {
                const vPct  = Number(l.variancePct ?? 0)
                const vCost = Number(l.varianceCost ?? 0)
                const large = Math.abs(vPct) > 15
                return (
                  <div key={l.id}
                    className={`px-4 py-2.5 grid grid-cols-[1fr_80px_80px_70px_90px] gap-2 items-center ${large ? 'bg-amber-50' : ''}`}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1">
                        {large && <AlertCircle size={12} className="text-amber-500 shrink-0" />}
                        <span className="text-sm text-gray-900 truncate">{l.inventoryItem.itemName}</span>
                      </div>
                      <span className="text-xs text-gray-400">{l.inventoryItem.category}</span>
                    </div>
                    <span className="text-right text-sm text-gray-600">{Number(l.expectedQty).toFixed(1)} {l.selectedUom}</span>
                    <span className="text-right text-sm font-medium text-gray-900">{Number(l.countedQty).toFixed(1)} {l.selectedUom}</span>
                    <span className={`text-right text-sm font-semibold ${varColor(vPct)}`}>
                      {vPct >= 0 ? '+' : ''}{vPct.toFixed(1)}%
                    </span>
                    <span className={`text-right text-sm font-semibold ${vCost >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {vCost >= 0 ? '+' : ''}{formatCurrency(vCost)}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Footer */}
        {!isFinalized ? (
          <div className="flex gap-3">
            <button onClick={() => setView('count')}
              className="flex-1 py-3 border border-gray-200 rounded-xl text-sm text-gray-600 hover:bg-gray-50 font-medium flex items-center justify-center gap-1.5"
            >
              <ArrowLeft size={16} /> Back to counting
            </button>
            <button onClick={handleFinalize} disabled={finalizing}
              className="flex-1 py-3 bg-green-600 text-white rounded-xl text-sm font-semibold hover:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-1.5 transition-colors"
            >
              <Check size={16} />
              {finalizing ? 'Updating…' : 'Approve & update inventory'}
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-xl px-4 py-3">
            <CheckCircle2 size={16} className="text-green-600 shrink-0" />
            <span className="text-sm text-green-800 font-medium">
              Finalized {active.finalizedAt ? new Date(active.finalizedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}
            </span>
          </div>
        )}
      </div>
    )
  }

  return null
}

// ── Small reusable components ─────────────────────────────────────────────────

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
        active ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
      }`}
    >
      {children}
    </button>
  )
}

function Empty() {
  return <div className="text-center py-12 text-sm text-gray-400">No items match this filter</div>
}
