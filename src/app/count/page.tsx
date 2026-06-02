'use client'

import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react'
import {
  AlertCircle, ArrowLeft, Check, CheckCircle2, ChevronDown,
  Circle, ClipboardList, Minus, MoreHorizontal, Pencil, Plus, RefreshCw, Search, SkipForward, Trash2, WifiOff, X,
} from 'lucide-react'
import { CategoryBadge } from '@/components/CategoryBadge'
import { formatCurrency, formatUnitPrice, BASE_UNITS, PURCHASE_UNITS } from '@/lib/utils'
import { InventoryItemDrawer } from '@/components/inventory/InventoryItemDrawer'
import { useRc } from '@/contexts/RevenueCenterContext'
import { useDrawer } from '@/contexts/DrawerContext'
import { useUser } from '@/contexts/UserContext'
import { rcHex } from '@/lib/rc-colors'
import {
  enqueueCountMutation, flushCountQueue, loadCountQueue,
  saveCountSessionCache, loadCountSessionCache, pendingCountForSession,
} from '@/lib/count-offline'
import {
  getCountableUoms, convertCountQtyToBase, convertBaseToCountUom,
} from '@/lib/count-uom'
import { LARGE_VARIANCE_PCT } from '@/lib/count-constants'

// ─── Types ────────────────────────────────────────────────────────────────────

interface InventoryItemRef {
  id: string
  itemName: string
  category: string
  baseUnit: string
  purchaseUnit: string
  qtyPerPurchaseUnit: number
  qtyUOM?: string | null
  innerQty?: number | string | null
  packSize: number
  packUOM: string
  countUOM: string
  location: string | null
  storageArea: { id: string; name: string } | null
  parLevel?: number | null         // from StockAllocation for the session's RC
  lastCountQty?: number | null     // last verified count, in baseUnit
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
  updatedAt?: string               // for optimistic concurrency on PATCH
}

interface CountAreaRow {
  id: string
  name: string
  itemCount: number
  onHandValue: number
  drift: number
  lastCountDate: string | null
  activeSessionId: string | null
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

// ─── Types (storage areas) ────────────────────────────────────────────────────

interface StorageArea { id: string; name: string }

// ─── Helpers ─────────────────────────────────────────────────────────────────

function uomOptionLabel(opt: { label: string; hint?: string }, baseUnit: string): string {
  if (opt.label.toLowerCase() === baseUnit.toLowerCase()) return opt.label
  if (!opt.hint) return opt.label
  return `${opt.label} — ${opt.hint}`
}

function varColor(pct: number | null) {
  if (pct === null) return ''
  const a = Math.abs(pct)
  if (a <= 5)  return 'text-green-text'
  if (a <= 15) return 'text-amber-600'
  return 'text-red-text'
}

// Returns false when expectedQty is so small in display units that the % is meaningless
function hasReliableVariance(expectedQty: number, selectedUom: string, item: InventoryItemRef): boolean {
  return convertBaseToCountUom(expectedQty, selectedUom, item) >= 0.05
}

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function fmtClock(d?: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function relTime(sessionDate: string, startedAt?: string | null) {
  const ref = new Date(sessionDate)
  const now = new Date()
  const days = Math.floor((now.getTime() - ref.getTime()) / 86_400_000)
  if (days <= 0) return `Today${startedAt ? ` · ${fmtClock(startedAt)}` : ''}`
  if (days === 1) return 'Yesterday'
  return `${days}d ago`
}

function durationMin(start: string, end: string) {
  const ms = new Date(end).getTime() - new Date(start).getTime()
  return Math.max(0, Math.round(ms / 60_000))
}

const SESSION_ACCENT: Record<string, string> = {
  IN_PROGRESS:    '#3b82f6',
  PENDING_REVIEW: '#f59e0b',
  UPDATING:       '#8b5cf6',
  FINALIZED:      '#22c55e',
  CANCELLED:      '#d1d5db',
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
    IN_PROGRESS:    'bg-gold-soft text-gold-2',
    PENDING_REVIEW: 'bg-gold-soft text-gold-2',
    UPDATING:       'bg-violet-100 text-violet-700',
    FINALIZED:      'bg-green-soft text-green-text',
    CANCELLED:      'bg-bg-2 text-ink-3',
  }
  const labels: Record<string, string> = {
    IN_PROGRESS: 'In progress', PENDING_REVIEW: 'Pending review',
    UPDATING: 'Updating changes', FINALIZED: 'Finalized', CANCELLED: 'Cancelled',
  }
  return (
    <span className={`inline-flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.04em] font-medium px-2 py-0.5 rounded-full ${map[status] ?? 'bg-bg-2 text-ink-3'}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current opacity-80" />
      {labels[status] ?? status}
    </span>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

type View = 'list' | 'new' | 'count' | 'review'

export default function CountPage() {
  // ── Global state ──────────────────────────────────────────────────────────
  const [view,          setView]          = useState<View>('list')
  const [sessions,      setSessions]      = useState<Session[]>([])
  const [active,        setActive]        = useState<Session | null>(null)
  // Mirror of `active` for use inside event listeners registered once (avoids a stale closure).
  const activeRef = useRef<Session | null>(null)
  useEffect(() => { activeRef.current = active }, [active])
  const [toast,         setToast]         = useState<string | null>(null)
  const [showModal,     setShowModal]     = useState(false)
  const [finalizing,    setFinalizing]    = useState(false)
  const [deleteTarget,  setDeleteTarget]  = useState<Session | null>(null)
  const [deleting,      setDeleting]      = useState(false)
  const [editTarget,    setEditTarget]    = useState<Session | null>(null)
  const [editLabel,     setEditLabel]     = useState('')
  const [editCountedBy, setEditCountedBy] = useState('')
  const [editDate,      setEditDate]      = useState('')
  const [sessionMenuId, setSessionMenuId] = useState<string | null>(null)
  const [showCountMenu, setShowCountMenu] = useState(false)
  const [sessionFilter, setSessionFilter] = useState<'all' | 'in_progress' | 'finalized' | 'full' | 'spot'>('all')
  const [sessionSearch, setSessionSearch] = useState('')

  // ── Offline state ─────────────────────────────────────────────────────────
  const [isOffline,      setIsOffline]      = useState(false)
  const [pendingCount,   setPendingCount]   = useState(0)
  const [offlineSyncing, setOfflineSyncing] = useState(false)

  // ── Sync state ───────────────────────────────────────────────────────────
  const [syncing, setSyncing] = useState(false)

  // ── Count-mode state ──────────────────────────────────────────────────────
  const [openId,        setOpenId]        = useState<string | null>(null)
  const [inputQty,      setInputQty]      = useState(0)
  const [caseQty,       setCaseQty]       = useState(0)  // unopened full cases, added to loose count
  const [catFilter,     setCatFilter]     = useState<string | null>(null)
  const [locFilter,     setLocFilter]     = useState<string | null>(null)
  const [statusFilter,  setStatusFilter]  = useState<'all' | 'uncounted' | 'counted' | 'skipped'>('all')
  const [showCountFilterSheet, setShowCountFilterSheet] = useState(false)
  const [searchQuery,   setSearchQuery]   = useState('')
  const [editingItemId, setEditingItemId] = useState<string | null>(null)

  // ── Storage areas (for partial count picker) ─────────────────────────────
  const [storageAreas, setStorageAreas] = useState<StorageArea[]>([])
  const [countAreas, setCountAreas] = useState<CountAreaRow[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [startingArea, setStartingArea] = useState<string | null>(null)

  // ── Add-item modal ────────────────────────────────────────────────────────
  const [showAddItem,    setShowAddItem]    = useState(false)
  const [addItemSaving,  setAddItemSaving]  = useState(false)
  const [addItemForm,    setAddItemForm]    = useState({
    itemName: '', category: '', supplierId: '', storageAreaId: '',
    purchaseUnit: '', qtyPerPurchaseUnit: '1', purchasePrice: '0',
    baseUnit: 'g', conversionFactor: '1', stockOnHand: '0', location: '',
  })
  const [addItemCategories, setAddItemCategories] = useState<{ id: string; name: string }[]>([])
  const [addItemSuppliers,  setAddItemSuppliers]  = useState<{ id: string; name: string }[]>([])
  const [addItemAreas,      setAddItemAreas]      = useState<{ id: string; name: string }[]>([])

  // ── New-session form ──────────────────────────────────────────────────────
  const [form, setForm] = useState({
    label: '', countedBy: '',
    type: 'FULL' as 'FULL' | 'PARTIAL',
    sessionDate: new Date().toISOString().slice(0, 10),
    areas: [] as string[], // stores storageArea IDs
  })

  const { revenueCenters, activeRcId, activeRc } = useRc()
  const { setDrawerOpen } = useDrawer()
  const { user } = useUser()
  const counterName = user?.name || user?.email?.split('@')[0] || 'You'
  const [selectedRcId, setSelectedRcId] = useState<string>('')

  useEffect(() => {
    if (activeRcId) setSelectedRcId(activeRcId)
  }, [activeRcId])

  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({})

  // ── Loaders ───────────────────────────────────────────────────────────────
  const loadSessions = useCallback(async () => {
    const params = new URLSearchParams()
    if (activeRcId) {
      params.set('rcId', activeRcId)
      if (activeRc?.isDefault) params.set('isDefault', 'true')
    }
    const data = await fetch(`/api/count/sessions?${params}`).then(r => r.json()).catch(() => [])
    setSessions(Array.isArray(data) ? data : [])
  }, [activeRcId, activeRc])

  const loadSession = useCallback(async (id: string): Promise<Session | null> => {
    try {
      const res = await fetch(`/api/count/sessions/${id}`)
      if (!res.ok) throw new Error(String(res.status))
      const data = (await res.json()) as Session
      saveCountSessionCache(id, data)            // keep a fresh offline copy on every successful load
      return data
    } catch {
      // Offline / fetch failed — fall back to the last cached copy so a count
      // survives a page reload and can be reopened without a connection.
      return loadCountSessionCache<Session>(id)
    }
  }, [])

  const loadCountAreas = useCallback(async () => {
    const params = new URLSearchParams()
    if (activeRcId) {
      params.set('rcId', activeRcId)
      if (activeRc?.isDefault) params.set('isDefault', 'true')
    }
    const data = await fetch(`/api/count/areas?${params}`).then(r => r.json()).catch(() => [])
    setCountAreas(Array.isArray(data) ? data : [])
  }, [activeRcId, activeRc])

  useEffect(() => { loadSessions(); loadCountAreas() }, [loadSessions, loadCountAreas])
  useEffect(() => {
    fetch('/api/storage-areas').then(r => r.json()).then(d => {
      if (Array.isArray(d)) setStorageAreas(d)
    })
  }, [])

  // Offline detection + auto-sync on reconnect
  useEffect(() => {
    setIsOffline(!navigator.onLine)
    setPendingCount(loadCountQueue().length)
    const goOnline = async () => {
      setIsOffline(false)
      const q = loadCountQueue()
      if (q.length === 0) return
      setOfflineSyncing(true)
      const { synced } = await flushCountQueue()
      setOfflineSyncing(false)
      setPendingCount(0)
      if (synced > 0) setToast(`Synced ${synced} offline update${synced !== 1 ? 's' : ''}.`)
      // Refresh active session after sync so variances update (use the ref — the
      // listener is registered once, so `active` in this closure would be stale).
      const cur = activeRef.current
      if (cur) {
        const refreshed = await loadSession(cur.id)
        if (refreshed) setActive(refreshed)
      }
    }
    const goOffline = () => setIsOffline(true)
    window.addEventListener('online',  goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online',  goOnline)
      window.removeEventListener('offline', goOffline)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Poll while any session is UPDATING so the list flips to FINALIZED automatically
  useEffect(() => {
    const hasUpdating = sessions.some(s => s.status === 'UPDATING')
    if (!hasUpdating) return
    const timer = setInterval(() => { loadSessions() }, 3000)
    return () => clearInterval(timer)
  }, [sessions, loadSessions])

  // No body-scroll lock needed — new session form is its own view on mobile
  // and a small centered modal on desktop (sm+).

  // Reset qty input when card opens
  useEffect(() => {
    if (!openId || !active?.lines) return
    const line = active.lines.find(l => l.id === openId)
    if (line) {
      // Blind-count: only show prior counted value when re-editing. Don't pre-fill
      // with expected qty — that biases the user toward confirming theoretical stock
      // rather than counting what's actually on the shelf.
      setInputQty(line.countedQty !== null ? Number(line.countedQty) : 0)
      setCaseQty(0)
    }
  }, [openId, active?.lines])

  // Count mode + review are immersive full-screen task flows with their own bottom
  // action bars — hide the global chat FAB (reusing the drawer-open mechanism) so it
  // doesn't overlap the finalize bar or clutter the counting flow.
  useEffect(() => {
    if (view !== 'count' && view !== 'review') return
    setDrawerOpen(true)
    return () => setDrawerOpen(false)
  }, [view, setDrawerOpen])

  // ── Computed ──────────────────────────────────────────────────────────────
  const { total, counted } = useMemo(() => {
    const lines = active?.lines ?? []
    return {
      total:   lines.length,
      counted: lines.filter(l => l.countedQty !== null || l.skipped).length,
    }
  }, [active?.lines])

  // Locations: derived exclusively from the structured StorageArea relation
  // (same source as Inventory) — free-text `location` field is not used for filtering.
  const locations = useMemo(() => {
    const lines = active?.lines ?? []
    const map = new Map<string, string>() // id → name
    for (const l of lines) {
      const sa = l.inventoryItem.storageArea
      if (sa) map.set(sa.id, sa.name)
    }
    return Array.from(map.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [active?.lines])

  const categories = useMemo(() => {
    const lines = active?.lines ?? []
    const map: Record<string, number> = {}
    for (const l of lines) { map[l.inventoryItem.category] = (map[l.inventoryItem.category] || 0) + 1 }
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b))
  }, [active?.lines])

  const filteredLines = useMemo(() => {
    const lines = active?.lines ?? []
    const q = searchQuery.trim().toLowerCase()
    return lines.filter(l => {
      if (catFilter && l.inventoryItem.category !== catFilter) return false
      if (locFilter && l.inventoryItem.storageArea?.id !== locFilter) return false
      if (statusFilter === 'uncounted') { if (l.countedQty !== null || l.skipped) return false }
      if (statusFilter === 'counted')   { if (l.countedQty === null || l.skipped) return false }
      if (statusFilter === 'skipped')   { if (!l.skipped) return false }
      if (q && !l.inventoryItem.itemName.toLowerCase().includes(q) && !l.inventoryItem.category.toLowerCase().includes(q)) return false
      return true
    }).sort((a, b) => a.sortOrder - b.sortOrder)
  }, [active?.lines, catFilter, locFilter, statusFilter, searchQuery])

  const grouped = useMemo(() => {
    // Flatten when searching so all matches appear together
    if (catFilter || searchQuery.trim()) return null
    return filteredLines.reduce((acc, l) => {
      const cat = l.inventoryItem.category
      if (!acc[cat]) acc[cat] = []
      acc[cat].push(l)
      return acc
    }, {} as Record<string, Line[]>)
  }, [filteredLines, catFilter, searchQuery])

  const filteredSessions = useMemo(() => {
    return sessions.filter(s => {
      if (sessionFilter === 'in_progress') return s.status === 'IN_PROGRESS' || s.status === 'PENDING_REVIEW'
      if (sessionFilter === 'finalized')   return s.status === 'FINALIZED'
      if (sessionFilter === 'full')        return s.type === 'FULL'
      if (sessionFilter === 'spot')        return s.type === 'PARTIAL'
      return true
    }).filter(s => {
      if (!sessionSearch.trim()) return true
      const q = sessionSearch.toLowerCase()
      return (s.label ?? '').toLowerCase().includes(q) || s.countedBy.toLowerCase().includes(q)
    })
  }, [sessions, sessionFilter, sessionSearch])

  // ── Actions ───────────────────────────────────────────────────────────────
  const openSession = async (s: Session, target: View) => {
    const full = await loadSession(s.id)
    if (!full) return
    setPendingCount(pendingCountForSession(s.id))
    setActive(full)
    setCatFilter(null); setLocFilter(null); setStatusFilter('all'); setOpenId(null)
    setView(target)
  }

  // Create a count session scoped to the given area (or full when areaId is null),
  // then open count mode. Used by the area-based landing.
  const createAndOpenCount = async (label: string | undefined, areaId: string | null) => {
    const res = await fetch('/api/count/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label,
        type: 'FULL',
        countedBy: counterName,
        sessionDate: new Date().toISOString().slice(0, 10),
        areaFilter: areaId || undefined,
        revenueCenterId: activeRcId || undefined,
      }),
    })
    const session = await res.json()
    await loadSessions(); loadCountAreas()
    const full = await loadSession(session.id)
    if (full) {
      setPendingCount(0)
      setActive(full); setCatFilter(null); setLocFilter(null); setStatusFilter('all'); setOpenId(null); setView('count')
    }
  }

  // Tap a storage area → resume its active session, else start a fresh one scoped to it.
  const startAreaCount = async (area: CountAreaRow) => {
    if (startingArea) return
    setStartingArea(area.id)
    try {
      if (area.activeSessionId) {
        const existing = sessions.find(s => s.id === area.activeSessionId)
        await openSession(existing ?? ({ id: area.activeSessionId } as Session), existing?.status === 'PENDING_REVIEW' ? 'review' : 'count')
      } else {
        await createAndOpenCount(area.name, area.id)
      }
    } finally { setStartingArea(null) }
  }

  // "Full count" — resume an active all-areas session if one exists, else create one.
  const startFullCount = async () => {
    if (startingArea) return
    setStartingArea('__full__')
    try {
      const activeFull = sessions.find(s => !s.areaFilter && (s.status === 'IN_PROGRESS' || s.status === 'PENDING_REVIEW'))
      if (activeFull) await openSession(activeFull, activeFull.status === 'PENDING_REVIEW' ? 'review' : 'count')
      else await createAndOpenCount(undefined, null)
    } finally { setStartingArea(null) }
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
        revenueCenterId: selectedRcId || undefined,
      }),
    })
    const session = await res.json()
    setForm({ label: '', countedBy: '', type: 'FULL', sessionDate: new Date().toISOString().slice(0, 10), areas: [] })
    setShowModal(false)
    await loadSessions()
    const full = await loadSession(session.id)
    if (full) {
      setPendingCount(0)
      setActive(full); setCatFilter(null); setLocFilter(null); setStatusFilter('all'); setOpenId(null); setView('count')
    }
  }

  // After a successful line PATCH, sync the local line's updatedAt so the next
  // save's optimistic-concurrency check matches the server. Without this, changing
  // the UOM (or any prior edit) left a stale updatedAt → the next save 409'd and
  // the count reset to uncounted. Also keeps the offline cache current.
  const syncLineFromResponse = (lineId: string, updated: { updatedAt?: string } | null) => {
    if (!updated?.updatedAt) return
    setActive(prev => {
      if (!prev) return prev
      const next = { ...prev, lines: prev.lines!.map(l => l.id === lineId ? { ...l, updatedAt: updated.updatedAt! } : l) }
      saveCountSessionCache(prev.id, next)
      return next
    })
  }

  const confirmLine = async (line: Line, qty: number) => {
    // qty is in line.selectedUom — convert to baseUnit for variance (expectedQty is in baseUnit)
    const qtyBase = convertCountQtyToBase(qty, line.selectedUom, line.inventoryItem)
    const vPct  = Number(line.expectedQty) > 0 ? ((qtyBase - Number(line.expectedQty)) / Number(line.expectedQty)) * 100 : 0
    const vCost = (qtyBase - Number(line.expectedQty)) * Number(line.priceAtCount)
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
        const prefix = typeof window !== 'undefined' && window.innerWidth < 640 ? 'm-' : 'd-'
        cardRefs.current[`${prefix}${next.id}`]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }, 120)
    }
    if (isOffline) {
      enqueueCountMutation({ sessionId: active!.id, lineId: line.id, type: 'count', qty })
      setPendingCount(c => c + 1)
      // Persist the optimistic state so the count survives a reload while offline.
      if (active) saveCountSessionCache(active.id, {
        ...active,
        lines: active.lines!.map(l => l.id === line.id ? { ...l, countedQty: qty, skipped: false, variancePct: vPct, varianceCost: vCost } : l),
      })
      return
    }
    const res = await fetch(`/api/count/sessions/${active!.id}/lines/${line.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ countedQty: qty, expectedUpdatedAt: line.updatedAt }),
    })
    if (res.status === 409) {
      // Someone else edited this line — refresh the session to pick up their changes
      setToast('This item was just counted on another device. Refreshing…')
      const fresh = await loadSession(active!.id)
      if (fresh) setActive(fresh)
    } else if (res.ok) {
      syncLineFromResponse(line.id, await res.json().catch(() => null))
    }
  }

  const changeUom = async (line: Line, newUom: string) => {
    // When the open card's UOM changes, convert the current inputQty to the new unit
    if (openId === line.id) {
      const inBase = convertCountQtyToBase(inputQty, line.selectedUom, line.inventoryItem)
      setInputQty(Math.round(convertBaseToCountUom(inBase, newUom, line.inventoryItem) * 1000) / 1000)
    }
    setActive(prev => ({
      ...prev!, lines: prev!.lines!.map(l => l.id === line.id ? { ...l, selectedUom: newUom } : l),
    }))
    if (!isOffline) {
      const res = await fetch(`/api/count/sessions/${active!.id}/lines/${line.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectedUom: newUom }),
      })
      if (res.ok) syncLineFromResponse(line.id, await res.json().catch(() => null))
    }
  }

  const skipLine = async (line: Line) => {
    setActive(prev => ({
      ...prev!, lines: prev!.lines!.map(l => l.id === line.id ? { ...l, skipped: true } : l),
    }))
    setOpenId(null)
    if (isOffline) {
      enqueueCountMutation({ sessionId: active!.id, lineId: line.id, type: 'skip' })
      setPendingCount(c => c + 1)
      // Persist the optimistic state so the skip survives a reload while offline.
      if (active) saveCountSessionCache(active.id, {
        ...active,
        lines: active.lines!.map(l => l.id === line.id ? { ...l, skipped: true } : l),
      })
      return
    }
    const res = await fetch(`/api/count/sessions/${active!.id}/lines/${line.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skipped: true }),
    })
    if (res.ok) syncLineFromResponse(line.id, await res.json().catch(() => null))
  }

  const unskipLine = async (line: Line) => {
    setActive(prev => ({
      ...prev!, lines: prev!.lines!.map(l =>
        l.id === line.id ? { ...l, skipped: false, countedQty: null, variancePct: null, varianceCost: null } : l
      ),
    }))
    setOpenId(line.id)
    setInputQty(0)
    await fetch(`/api/count/sessions/${active!.id}/lines/${line.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skipped: false }),
    })
  }

  // Clear a recorded count back to uncounted (PATCH skipped:false resets countedQty server-side).
  const clearLine = async (line: Line) => {
    setActive(prev => ({
      ...prev!, lines: prev!.lines!.map(l =>
        l.id === line.id ? { ...l, skipped: false, countedQty: null, variancePct: null, varianceCost: null } : l
      ),
    }))
    setOpenId(null)
    setToast(`${line.inventoryItem.itemName} cleared`)
    await fetch(`/api/count/sessions/${active!.id}/lines/${line.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skipped: false }),
    })
  }

  const handleScan = useCallback(async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    const res = await fetch(`/api/inventory/search?barcode=${encodeURIComponent(trimmed)}`)
    const results: { id: string }[] = await res.json()
    if (results.length === 1) {
      const line = (active?.lines ?? []).find(l => l.inventoryItemId === results[0].id)
      if (line) {
        setSearchQuery('')
        const prefix = typeof window !== 'undefined' && window.innerWidth < 640 ? 'm-' : 'd-'
        setTimeout(() => {
          cardRefs.current[`${prefix}${line.id}`]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }, 50)
      }
    }
  }, [active?.lines, setSearchQuery])

  const openAddItem = async () => {
    const [cats, sups, areas] = await Promise.all([
      fetch('/api/categories').then(r => r.json()),
      fetch('/api/suppliers').then(r => r.json()),
      fetch('/api/storage-areas').then(r => r.json()),
    ])
    setAddItemCategories(cats)
    setAddItemSuppliers(sups)
    setAddItemAreas(areas)
    setAddItemForm({
      itemName: '', category: cats[0]?.name ?? '', supplierId: '', storageAreaId: '',
      purchaseUnit: '', qtyPerPurchaseUnit: '1', purchasePrice: '0',
      baseUnit: 'g', conversionFactor: '1', stockOnHand: '0', location: '',
    })
    setShowAddItem(true)
  }

  const handleAddItem = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!active) return
    setAddItemSaving(true)
    const res = await fetch('/api/inventory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(addItemForm),
    })
    const newItem = await res.json()
    // Add the new item as a count line in the active session
    const lineRes = await fetch(`/api/count/sessions/${active.id}/lines`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inventoryItemId: newItem.id }),
    })
    if (lineRes.ok) {
      const newLine = await lineRes.json()
      setActive(prev => prev ? { ...prev, lines: [...(prev.lines ?? []), newLine] } : prev)
    }
    setAddItemSaving(false)
    setShowAddItem(false)
    setToast(`"${addItemForm.itemName}" added to inventory and count session.`)
  }

  const addItemPricePreview =
    parseFloat(addItemForm.purchasePrice) /
    (parseFloat(addItemForm.qtyPerPurchaseUnit) * parseFloat(addItemForm.conversionFactor)) || 0

  const handleFinalize = async () => {
    if (!active || finalizing) return
    setFinalizing(true)
    // Sync any offline mutations before finalizing
    if (loadCountQueue().length > 0) {
      setOfflineSyncing(true)
      await flushCountQueue()
      setOfflineSyncing(false)
      setPendingCount(0)
    }
    // Mark as UPDATING immediately so the list reflects processing state
    await fetch(`/api/count/sessions/${active.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'UPDATING' }),
    })
    const sessionId = active.id
    // Navigate back to list right away — don't wait for heavy processing
    await loadSessions()
    setView('list'); setActive(null); setFinalizing(false)
    // Fire finalize and recover from failures so a session never sits stuck in UPDATING
    try {
      const res = await fetch(`/api/count/sessions/${sessionId}/finalize`, { method: 'POST' })
      if (!res.ok) {
        // Revert status so the user can retry from the review screen
        await fetch(`/api/count/sessions/${sessionId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'PENDING_REVIEW' }),
        })
        const data = await res.json().catch(() => null)
        setToast(`Couldn't finalize: ${data?.error ?? `HTTP ${res.status}`}. Reopen the session to retry.`)
        await loadSessions()
      }
    } catch (err) {
      // Network error — revert so it's not stuck in UPDATING
      await fetch(`/api/count/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'PENDING_REVIEW' }),
      }).catch(() => {})
      setToast(`Couldn't finalize: ${(err as Error).message}. Reopen the session to retry.`)
      await loadSessions()
    }
  }

  const handleDeleteSession = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    await fetch(`/api/count/sessions/${deleteTarget.id}`, { method: 'DELETE' })
    setDeleteTarget(null)
    setDeleting(false)
    await loadSessions()
    setToast('Count session deleted.')
  }

  const openEditModal = (s: Session) => {
    setEditTarget(s)
    setEditLabel(s.label)
    setEditCountedBy(s.countedBy)
    setEditDate(s.sessionDate.slice(0, 10))
  }

  const handleEditSession = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!editTarget) return
    await fetch(`/api/count/sessions/${editTarget.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: editLabel.trim(), countedBy: editCountedBy.trim(), sessionDate: editDate }),
    })
    setEditTarget(null)
    await loadSessions()
  }

  const handleReopenAndEdit = async (s: Session) => {
    if (s.status === 'FINALIZED') {
      await fetch(`/api/count/sessions/${s.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'IN_PROGRESS' }),
      })
      await loadSessions()
    }
    const full = await loadSession(s.id)
    if (full) { setActive(full); setCatFilter(null); setLocFilter(null); setStatusFilter('all'); setOpenId(null); setView('count') }
  }

  const backFromCount = () => {
    if (counted > 0 && !confirm('Leave count session? All confirmed items are saved.')) return
    setView('list'); setActive(null); setOpenId(null)
  }

  const handleSync = async () => {
    if (!active || syncing) return
    setSyncing(true)
    try {
      const res  = await fetch(`/api/count/sessions/${active.id}/sync`, { method: 'POST' })
      const data = await res.json()
      if (res.ok) {
        const { added = 0, removed = 0, updated = 0 } = data
        const changed = added + removed + updated
        if (changed > 0) {
          // Reload the full session so lines reflect all changes
          const refreshed = await loadSession(active.id)
          if (refreshed) setActive(refreshed)
          const parts: string[] = []
          if (added   > 0) parts.push(`${added} added`)
          if (removed > 0) parts.push(`${removed} removed`)
          if (updated > 0) parts.push(`${updated} updated`)
          setToast(parts.join(' · '))
        } else {
          setToast('Already up to date')
        }
      }
    } finally {
      setSyncing(false)
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // VIEW NEW — NEW SESSION FORM (full-page on mobile, modal on desktop)
  // ════════════════════════════════════════════════════════════════════════════

  // Shared form fields rendered identically in both mobile page + desktop modal
  const NewSessionFields = (
    <div className="space-y-5">
      <div>
        <label className="block font-mono text-[10.5px] text-ink-3 uppercase tracking-wide mb-2">Label</label>
        <input
          value={form.label}
          onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
          placeholder={`e.g. Full count ${fmtDate(new Date().toISOString())}`}
          className="w-full border border-line rounded-[9px] px-4 py-3 text-[13.5px] text-ink placeholder:text-ink-4 focus:outline-none focus:border-ink-3 transition-colors"
        />
      </div>
      <div>
        <label className="block font-mono text-[10.5px] text-ink-3 uppercase tracking-wide mb-2">
          Who&apos;s counting <span className="text-red-500">*</span>
        </label>
        <input
          required
          autoFocus
          value={form.countedBy}
          onChange={e => setForm(f => ({ ...f, countedBy: e.target.value }))}
          placeholder="Name"
          className="w-full border border-line rounded-[9px] px-4 py-3 text-[13.5px] text-ink placeholder:text-ink-4 focus:outline-none focus:border-ink-3 transition-colors"
        />
      </div>
      <div>
        <label className="block font-mono text-[10.5px] text-ink-3 uppercase tracking-wide mb-2">Count type</label>
        <div className="grid grid-cols-2 gap-2">
          {(['FULL', 'PARTIAL'] as const).map(t => (
            <button key={t} type="button"
              onClick={() => {
                setForm(f => ({ ...f, type: t }))
                if (t === 'PARTIAL' && !selectedRcId) setSelectedRcId(activeRcId ?? '')
              }}
              className={`py-3 rounded-[9px] text-[13.5px] font-medium border transition-colors ${
                form.type === t ? 'bg-ink text-paper border-ink' : 'bg-paper text-ink-2 border-line hover:border-ink-3'
              }`}
            >
              {t === 'FULL' ? 'Full count' : 'Partial count'}
            </button>
          ))}
        </div>
      </div>
      {form.type === 'PARTIAL' && (
        <div>
          <label className="block font-mono text-[10.5px] text-ink-3 uppercase tracking-wide mb-2">Areas to count</label>
          {storageAreas.length === 0 ? (
            <p className="font-mono text-[11px] text-ink-4">No storage areas configured yet.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {storageAreas.map(area => {
                const on = form.areas.includes(area.id)
                return (
                  <button key={area.id} type="button"
                    onClick={() => setForm(f => ({
                      ...f, areas: on ? f.areas.filter(x => x !== area.id) : [...f.areas, area.id],
                    }))}
                    className={`px-3 py-2 rounded-[9px] text-[13px] font-medium border transition-colors ${
                      on ? 'bg-ink text-paper border-ink' : 'bg-paper text-ink-2 border-line hover:border-ink-3'
                    }`}
                  >
                    {area.name}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}
      <div>
        <label className="block font-mono text-[10.5px] text-ink-3 uppercase tracking-wide mb-2">Date</label>
        <input
          type="date"
          value={form.sessionDate}
          onChange={e => setForm(f => ({ ...f, sessionDate: e.target.value }))}
          className="w-full border border-line rounded-[9px] px-4 py-3 text-[13.5px] text-ink focus:outline-none focus:border-ink-3 transition-colors"
        />
      </div>
      {revenueCenters.length > 1 && (
        <div>
          <label className="block font-mono text-[10.5px] text-ink-3 uppercase tracking-wide mb-2">Revenue Center</label>
          <select
            value={selectedRcId}
            onChange={e => setSelectedRcId(e.target.value)}
            className="w-full border border-line rounded-[9px] px-4 py-3 text-[13.5px] text-ink focus:outline-none focus:border-ink-3 transition-colors bg-paper"
          >
            {form.type === 'FULL' && (
              <option value="">All revenue centers</option>
            )}
            {revenueCenters.map(rc => (
              <option key={rc.id} value={rc.id}>{rc.name}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  )

  // ── New session form — full-page on mobile, centered card on desktop ──────
  if (view === 'new') {
    const cancelNew = () => { setView('list'); setForm({ label: '', countedBy: '', type: 'FULL', sessionDate: new Date().toISOString().slice(0, 10), areas: [] }) }
    return (
      <>
        {/* ── Mobile: full-page ── */}
        <form id="new-session-form" onSubmit={handleCreate} className="md:hidden flex flex-col min-h-screen bg-bg-2">
          <div className="sticky top-0 z-10 bg-paper border-b border-line px-4 py-4 flex items-center gap-3">
            <button type="button" onClick={cancelNew} className="p-1 -ml-1 text-ink-3 hover:text-ink">
              <ArrowLeft size={20} />
            </button>
            <h1 className="text-[17px] font-semibold text-ink tracking-[-0.02em] flex-1">New count session</h1>
          </div>
          <div className="flex-1 px-4 pt-6 pb-48">
            {NewSessionFields}
          </div>
          <div className="fixed bottom-[calc(4rem+env(safe-area-inset-bottom))] inset-x-0 bg-paper border-t border-line px-4 py-4 flex gap-3 z-[60]">
            <button type="button" onClick={cancelNew}
              className="flex-1 py-3.5 border border-line rounded-[12px] text-[13.5px] font-medium text-ink-2 hover:border-ink-3 transition-colors">
              Cancel
            </button>
            <button type="submit"
              className="flex-[2] py-3.5 bg-ink text-paper rounded-[12px] text-[13.5px] font-medium hover:bg-ink-2 transition-colors">
              Start count →
            </button>
          </div>
        </form>

        {/* ── Desktop: centered card ── */}
        <div className="hidden md:flex flex-col gap-6 max-w-xl">
          <div className="flex items-center gap-3">
            <button type="button" onClick={cancelNew} className="p-1.5 rounded-lg hover:bg-bg-2 text-ink-3 transition-colors">
              <ArrowLeft size={18} />
            </button>
            <div>
              <p className="font-mono text-[10.5px] text-ink-3 tracking-wide mb-0.5">TODAY / COUNT</p>
              <h1 className="text-[22px] font-semibold text-ink tracking-[-0.03em]">New count session</h1>
            </div>
          </div>
          <form onSubmit={handleCreate} className="bg-paper rounded-xl border border-line p-6 space-y-6">
            {NewSessionFields}
            <div className="flex gap-3 pt-1">
              <button type="button" onClick={cancelNew}
                className="flex-1 py-2.5 border border-line rounded-[9px] text-[13px] font-medium text-ink-2 hover:border-ink-3 transition-colors">
                Cancel
              </button>
              <button type="submit"
                className="flex-[2] py-2.5 bg-ink text-paper rounded-[9px] text-[13px] font-medium hover:bg-ink-2 transition-colors">
                Start count →
              </button>
            </div>
          </form>
        </div>
      </>
    )
  }

  // ════════════════════════════════════════════════════════════════════════════
  // VIEW A — SESSION LIST
  // ════════════════════════════════════════════════════════════════════════════
  if (view === 'list') {
    const lastFinalized  = sessions.find(s => s.status === 'FINALIZED')
    const inProgressSess = sessions.find(s => s.status === 'IN_PROGRESS' || s.status === 'PENDING_REVIEW')
    const nextCountDate  = (() => {
      const d = new Date()
      if (lastFinalized) {
        const last = new Date(lastFinalized.sessionDate)
        d.setTime(last.getTime())
        d.setDate(d.getDate() + 7)
      }
      return d
    })()
    const isOverdue    = nextCountDate <= new Date()
    const nextDateStr  = nextCountDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase()
    const overdueDays  = isOverdue ? Math.floor((Date.now() - nextCountDate.getTime()) / 86_400_000) : 0
    const inProgCounts = inProgressSess?.counts ?? { total: 0, counted: 0, skipped: 0 }
    const inProgPct    = inProgCounts.total > 0 ? (inProgCounts.counted / inProgCounts.total) * 100 : 0

    const sessionFilterChips: { key: typeof sessionFilter; label: string }[] = [
      { key: 'all',         label: `All · ${sessions.length}` },
      { key: 'in_progress', label: `In progress · ${sessions.filter(s => s.status === 'IN_PROGRESS' || s.status === 'PENDING_REVIEW').length}` },
      { key: 'finalized',   label: `Finalized · ${sessions.filter(s => s.status === 'FINALIZED').length}` },
      { key: 'full',        label: `Full counts · ${sessions.filter(s => s.type === 'FULL').length}` },
      { key: 'spot',        label: `Spot counts · ${sessions.filter(s => s.type === 'PARTIAL').length}` },
    ]

    return (
      <div>
        {toast && <Toast msg={toast} onDone={() => setToast(null)} />}

        {/* ── Mobile header ── */}
        <div className="md:hidden flex items-center justify-between gap-2 mb-4">
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-ink flex items-center gap-1.5">
              <ClipboardList size={19} className="text-gold" /> Stock count
            </h1>
            <p className="text-[11.5px] text-ink-3 mt-0.5">Track inventory accuracy &amp; COGS</p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <div className="relative">
              <button onClick={() => setShowCountMenu(v => !v)}
                className="p-2 rounded-lg border border-line text-ink-2 active:bg-bg-2" title="More actions" aria-haspopup="menu" aria-expanded={showCountMenu}>
                <MoreHorizontal size={16} />
              </button>
              {showCountMenu && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowCountMenu(false)} />
                  <div className="absolute right-0 top-[calc(100%+6px)] z-50 w-44 bg-paper border border-line rounded-xl shadow-lg overflow-hidden py-1" role="menu">
                    <button onClick={() => { setShowHistory(v => !v); setShowCountMenu(false) }}
                      aria-pressed={showHistory}
                      className={`w-full flex items-center gap-2.5 px-3.5 py-2.5 text-[13px] active:bg-bg-2 ${showHistory ? 'text-ink font-medium' : 'text-ink-2'}`} role="menuitem">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={showHistory ? 'text-gold' : 'text-ink-3'}><path d="M3 5h18M3 12h18M3 19h12"/></svg>
                      History
                    </button>
                    <button onClick={() => setShowCountMenu(false)}
                      className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-[13px] text-ink-2 active:bg-bg-2" role="menuitem">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-ink-3"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>
                      Export reports
                    </button>
                  </div>
                </>
              )}
            </div>
            <button onClick={() => setView('new')}
              className="p-2 rounded-lg bg-gold text-white active:bg-[#a88930]" title="Start count">
              <Plus size={16} />
            </button>
          </div>
        </div>

        {/* ── Desktop header ── */}
        <div className="hidden md:flex items-start justify-between mb-7 gap-6">
          <div>
            <p className="font-mono text-[10.5px] text-ink-3 tracking-wide mb-2">TODAY / COUNT</p>
            <h1 className="text-[36px] font-semibold tracking-[-0.04em] leading-none text-ink mb-1.5">Stock count</h1>
            <p className="text-[13.5px] text-ink-3 tracking-[-0.005em]">Track inventory accuracy and COGS by counting your stock regularly.</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setShowHistory(v => !v)}
              aria-pressed={showHistory}
              className={`flex items-center gap-1.5 px-3.5 py-2.5 rounded-[9px] border text-[13px] font-medium transition-colors whitespace-nowrap ${
                showHistory ? 'bg-ink text-paper border-ink' : 'border-line bg-paper text-ink-2 hover:border-ink-3'
              }`}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={showHistory ? 'text-gold' : 'text-ink-3'}><path d="M3 5h18M3 12h18M3 19h12"/></svg>
              History
            </button>
            <button className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-[9px] border border-line bg-paper text-ink-2 text-[13px] font-medium hover:border-ink-3 transition-colors whitespace-nowrap">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-ink-3"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>
              Export reports
            </button>
            <button
              onClick={() => setView('new')}
              className="flex items-center gap-1.5 px-4 py-2.5 rounded-[9px] bg-ink text-paper text-[13px] font-medium hover:bg-ink-2 transition-colors whitespace-nowrap"
            >
              <span className="text-gold font-semibold text-base leading-none">+</span>
              Start count
            </button>
          </div>
        </div>

        {sessions.length === 0 ? (
          <div className="text-center py-20 text-ink-3">
            <ClipboardList size={40} className="mx-auto mb-4 opacity-20" />
            <p className="font-semibold text-ink text-base mb-1">No count sessions yet</p>
            <p className="text-[13.5px] text-ink-3 mb-6">Regular stock counts keep your inventory accurate and food costs on target.</p>
            <button
              onClick={() => setView('new')}
              className="inline-flex items-center gap-2 bg-ink text-paper px-5 py-2.5 rounded-[9px] text-[13px] font-medium hover:bg-ink-2 transition-colors"
            >
              <span className="text-gold font-semibold">+</span> Start First Count
            </button>
          </div>
        ) : (
          <>
            {/* ── Mobile hero — resume/start + slim stats (hidden in History view) ── */}
            <div className={`md:hidden space-y-2.5 mb-4 ${showHistory ? 'hidden' : ''}`}>
              {inProgressSess ? (
                <button
                  onClick={() => openSession(inProgressSess, inProgressSess.status === 'PENDING_REVIEW' ? 'review' : 'count')}
                  className="w-full text-left bg-ink text-paper rounded-xl p-4 active:opacity-90"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[10.5px] text-gold tracking-[0.04em]">RESUME COUNT</span>
                    <span className="font-mono text-[11px] text-[#a1a1aa]">{Math.round(inProgPct)}%</span>
                  </div>
                  <div className="flex items-baseline gap-2 mt-1.5">
                    <span className="text-[26px] font-semibold tracking-[-0.03em] leading-none">
                      {inProgCounts.counted}<small className="text-[15px] text-[#a1a1aa] font-medium">/{inProgCounts.total}</small>
                    </span>
                    <span className="text-[13px] text-[#d4d4d8]">counted</span>
                    <span className="ml-auto font-mono text-[12px] text-gold font-medium">Continue →</span>
                  </div>
                  <div className="h-1.5 bg-[#3f3f46] rounded-full mt-2.5 overflow-hidden">
                    <div className="h-full bg-gold rounded-full" style={{ width: `${Math.max(inProgPct, inProgCounts.counted > 0 ? 2 : 0)}%` }} />
                  </div>
                  <div className="font-mono text-[10.5px] text-[#a1a1aa] mt-2">{inProgressSess.countedBy} · {fmtDate(inProgressSess.sessionDate)}</div>
                </button>
              ) : (
                <button onClick={() => setView('new')} className="w-full text-left bg-ink text-paper rounded-xl p-4 active:opacity-90 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <span className="font-mono text-[10.5px] text-gold tracking-[0.04em]">START A COUNT</span>
                    <p className="text-[17px] font-semibold tracking-[-0.02em] mt-1">Count your stock</p>
                  </div>
                  <span className="w-10 h-10 rounded-full bg-gold text-white grid place-items-center shrink-0"><Plus size={20} /></span>
                </button>
              )}
              <div className="grid grid-cols-2 gap-2.5">
                <div className="bg-paper border border-line rounded-xl px-3.5 py-2.5">
                  <p className="font-mono text-[9.5px] text-ink-3 tracking-[0.04em] uppercase">Last count</p>
                  <p className="text-[17px] font-semibold tracking-[-0.02em] text-ink mt-0.5 truncate">{lastFinalized ? formatCurrency(Number(lastFinalized.totalCountedValue)) : '—'}</p>
                  <p className="font-mono text-[10px] text-ink-3 mt-0.5 truncate">{lastFinalized ? fmtDate(lastFinalized.sessionDate) : 'no counts yet'}</p>
                </div>
                <div className={`rounded-xl px-3.5 py-2.5 border ${isOverdue ? 'bg-[#fffbeb] border-[#fcd34d]' : 'bg-paper border-line'}`}>
                  <p className={`font-mono text-[9.5px] tracking-[0.04em] uppercase ${isOverdue ? 'text-gold-2' : 'text-ink-3'}`}>Next due</p>
                  <p className={`text-[17px] font-semibold tracking-[-0.02em] mt-0.5 ${isOverdue ? 'text-gold' : 'text-ink'}`}>{nextCountDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</p>
                  <p className={`font-mono text-[10px] mt-0.5 truncate ${isOverdue ? 'text-gold-2' : 'text-ink-3'}`}>{isOverdue ? `overdue ${overdueDays}d` : 'weekly'}</p>
                </div>
              </div>
            </div>

            {/* ── KPI context strip (desktop) ── */}
            <div className="hidden md:grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
              {/* Hero: last finalized */}
              <div className="bg-ink text-paper rounded-xl border border-ink p-[18px] flex flex-col justify-between min-h-[120px] relative">
                <div className="absolute top-[18px] right-4 flex items-end gap-[3px] h-[18px]">
                  {[14,11,17,9,13,8,15,18].map((h, i) => (
                    <span key={i} className="w-[3px] rounded-[1px]" style={{ height: h, background: '#3f3f46' }} />
                  ))}
                </div>
                <div>
                  <p className="font-mono text-[10.5px] text-[#a1a1aa] tracking-[0.01em]">LAST FINALIZED COUNT</p>
                  {lastFinalized ? (
                    <p className="text-[42px] font-semibold tracking-[-0.045em] leading-none mt-2">
                      {formatCurrency(Number(lastFinalized.totalCountedValue)).replace(/(\.\d+)$/, '')}
                      <sub className="text-[20px] font-medium text-gold align-baseline ml-0.5 tracking-[-0.02em]">
                        {formatCurrency(Number(lastFinalized.totalCountedValue)).match(/\.\d+$/)?.[0] ?? '.00'}
                      </sub>
                    </p>
                  ) : (
                    <p className="text-[42px] font-semibold tracking-[-0.045em] leading-none mt-2 text-[#52525b]">—</p>
                  )}
                </div>
                <p className="font-mono text-[11px] text-[#a1a1aa] mt-2">
                  {lastFinalized
                    ? `${fmtDate(lastFinalized.sessionDate)} · ${lastFinalized.countedBy} · ${lastFinalized.counts?.total ?? 0} items`
                    : 'No finalized count yet'}
                </p>
              </div>

              {/* In progress */}
              <div className="bg-paper border border-ink-2 rounded-xl p-[18px] flex flex-col justify-between min-h-[120px] relative overflow-hidden">
                <div className="absolute top-0 left-0 w-8 h-0.5 bg-gold" />
                <div>
                  <p className="font-mono text-[10.5px] text-gold-2 tracking-[0.01em]">IN PROGRESS</p>
                  {inProgressSess ? (
                    <>
                      <div className="flex items-baseline gap-2.5 mt-2">
                        <span className="text-[28px] font-semibold tracking-[-0.035em] leading-none text-ink">
                          {inProgCounts.counted}
                          <small className="text-[16px] font-medium text-ink-3 tracking-[-0.02em]">/{inProgCounts.total}</small>
                        </span>
                        <span className="font-mono text-[11px] text-ink-3">{Math.round(inProgPct)}% counted</span>
                      </div>
                      <div className="h-1.5 bg-bg-2 rounded-full mt-2.5 overflow-hidden">
                        <div className="h-1.5 bg-gold rounded-full" style={{ width: `${Math.max(inProgPct, inProgCounts.counted > 0 ? 1.5 : 0)}%` }} />
                      </div>
                    </>
                  ) : (
                    <p className="text-[28px] font-semibold tracking-[-0.035em] leading-none mt-2 text-ink-4">—</p>
                  )}
                </div>
                <p className="font-mono text-[11px] text-ink-3 mt-2">
                  {inProgressSess
                    ? `${inProgressSess.countedBy} · ${fmtDate(inProgressSess.sessionDate)}`
                    : 'No active session'}
                </p>
              </div>

              {/* Next count due */}
              <div className={`rounded-xl p-[18px] flex flex-col justify-between min-h-[120px] relative ${isOverdue ? 'bg-[#fffbeb] border border-[#fcd34d]' : 'bg-paper border border-line'}`}>
                {isOverdue && <div className="absolute top-[18px] right-[18px] w-[7px] h-[7px] rounded-full bg-gold" />}
                <div>
                  <p className={`font-mono text-[10.5px] tracking-[0.01em] ${isOverdue ? 'text-gold-2' : 'text-ink-3'}`}>NEXT COUNT DUE</p>
                  <p className={`text-[28px] font-semibold tracking-[-0.035em] leading-none mt-2 ${isOverdue ? 'text-gold' : 'text-ink'}`}>
                    {nextCountDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </p>
                </div>
                <p className="font-mono text-[11px] mt-2">
                  {isOverdue
                    ? <span className="text-gold-2 font-medium">Overdue {overdueDays} day{overdueDays !== 1 ? 's' : ''} · weekly cadence</span>
                    : <span className="text-ink-3">Weekly cadence</span>}
                </p>
              </div>

              {/* Session summary */}
              <div className="bg-paper border border-line rounded-xl p-[18px] flex flex-col justify-between min-h-[120px]">
                <div>
                  <p className="font-mono text-[10.5px] text-ink-3 tracking-[0.01em]">TOTAL SESSIONS</p>
                  <p className="text-[42px] font-semibold tracking-[-0.045em] leading-none mt-2 text-ink">{sessions.length}</p>
                </div>
                <p className="font-mono text-[11px] text-ink-3 mt-2">
                  {sessions.filter(s => s.status === 'FINALIZED').length} finalized · {sessions.filter(s => s.status === 'IN_PROGRESS').length} active
                </p>
              </div>
            </div>

            {/* ── Desktop areas overview (primary landing; hidden when History is on) ── */}
            {!showHistory && (
              <div className="hidden md:block mb-6">
                <div className="flex items-center justify-between mb-3">
                  <span className="font-mono text-[11px] uppercase tracking-[0.05em] text-ink-3">Storage areas · count by area</span>
                  <span className="font-mono text-[11px] text-ink-4">{countAreas.length} area{countAreas.length !== 1 ? 's' : ''}</span>
                </div>
                <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                  {countAreas.map(a => {
                    const days = a.lastCountDate ? Math.floor((Date.now() - new Date(a.lastCountDate).getTime()) / 86_400_000) : null
                    const stale = days === null || days >= 7
                    const active = !!a.activeSessionId
                    const lastLabel = days === 0 ? 'today' : days === 1 ? '1d ago' : `${days}d ago`
                    return (
                      <button key={a.id} disabled={!!startingArea} onClick={() => startAreaCount(a)}
                        className="text-left bg-paper border border-line rounded-xl p-4 hover:border-ink-3 transition-colors disabled:opacity-60 flex flex-col gap-2.5">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className={`w-2 h-2 rounded-full shrink-0 ${active ? 'bg-blue' : stale ? 'bg-red' : 'bg-green-500'}`} />
                            <span className="text-[15px] font-semibold text-ink truncate tracking-[-0.01em]">{a.name}</span>
                          </div>
                          <span className="font-mono text-[12.5px] text-ink-2 shrink-0">{formatCurrency(a.onHandValue)}</span>
                        </div>
                        <div className="font-mono text-[11px] text-ink-3 leading-relaxed">
                          {a.itemCount} items · {active
                            ? <span className="text-gold-2 font-medium">in progress</span>
                            : days === null ? 'never counted' : <>last {lastLabel}{stale ? ' · stale' : ''}</>}
                          {!active && a.drift >= 1 && <span className="text-red-text"> · drift ~${Math.round(a.drift).toLocaleString()}</span>}
                        </div>
                        <span className={`font-mono text-[11px] font-medium mt-auto pt-1 ${active ? 'text-gold-2' : 'text-ink-2'}`}>
                          {active ? 'Resume →' : startingArea === a.id ? 'Starting…' : 'Count ›'}
                        </span>
                      </button>
                    )
                  })}
                  {countAreas.length === 0 && (
                    <div className="col-span-full bg-paper border border-line rounded-xl px-4 py-12 text-center font-mono text-[12px] text-ink-4">No storage areas with items</div>
                  )}
                </div>
                <button disabled={!!startingArea} onClick={startFullCount}
                  className="mt-3 inline-flex items-center gap-2 px-4 py-2.5 rounded-[9px] border border-dashed border-line-2 text-ink-2 text-[13px] font-medium hover:border-ink-3 transition-colors disabled:opacity-60">
                  <Plus size={15} className="text-ink-3" /> {startingArea === '__full__' ? 'Starting…' : 'Full count · all areas'}
                </button>
              </div>
            )}

            {/* ── Filter chips (desktop; History view only) ── */}
            <div className={`${showHistory ? 'md:flex' : ''} hidden flex-wrap gap-1.5 mb-3`}>
              {sessionFilterChips.map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => setSessionFilter(key)}
                  className={`font-mono text-[11px] px-3 py-1.5 rounded-full border transition-colors whitespace-nowrap ${
                    sessionFilter === key
                      ? 'bg-ink text-paper border-ink'
                      : 'bg-paper text-ink-2 border-line hover:border-ink-3'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* ── Search + filters (desktop; History view only) ── */}
            <div className={`${showHistory ? 'md:flex' : ''} hidden gap-2 mb-3`}>
              <div className="relative flex-1">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" />
                <input
                  type="text"
                  placeholder="Search by counter, date, session…"
                  value={sessionSearch}
                  onChange={e => setSessionSearch(e.target.value)}
                  className="w-full pl-8 pr-3 py-2.5 text-[13px] bg-paper border border-line rounded-[9px] text-ink placeholder:text-ink-3 focus:outline-none focus:border-ink-3 transition-colors"
                />
              </div>
            </div>

            <p className={`${showHistory ? 'md:block' : ''} hidden font-mono text-[11px] text-ink-3 mb-3 tracking-wide`}>
              SHOWING {filteredSessions.length} OF {sessions.length} COUNT{sessions.length !== 1 ? 'S' : ''} · NEWEST FIRST
            </p>

            {/* ── Mobile areas overview (taps start/resume an area-scoped count; hidden in History view) ── */}
            <div className={`md:hidden space-y-2.5 mb-4 ${showHistory ? 'hidden' : ''}`}>
              <div className="flex items-center justify-between px-0.5">
                <span className="font-mono text-[10.5px] uppercase tracking-[0.05em] text-ink-3">Storage areas</span>
                <span className="font-mono text-[10.5px] text-ink-4">{countAreas.length} area{countAreas.length !== 1 ? 's' : ''}</span>
              </div>
              <div className="bg-paper border border-line rounded-xl overflow-hidden divide-y divide-line">
                {countAreas.map(a => {
                  const days = a.lastCountDate ? Math.floor((Date.now() - new Date(a.lastCountDate).getTime()) / 86_400_000) : null
                  const stale = days === null || days >= 7
                  const active = !!a.activeSessionId
                  const lastLabel = days === 0 ? 'today' : days === 1 ? '1d ago' : `${days}d ago`
                  return (
                    <button key={a.id} disabled={!!startingArea} onClick={() => startAreaCount(a)}
                      className="w-full text-left flex items-center gap-3 px-3.5 py-3 active:bg-bg-2 disabled:opacity-60">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${active ? 'bg-blue' : stale ? 'bg-red' : 'bg-green-500'}`} />
                      <div className="flex-1 min-w-0">
                        <div className="text-[14px] font-semibold text-ink truncate">{a.name}</div>
                        <div className="font-mono text-[10.5px] text-ink-3 truncate mt-0.5">
                          {a.itemCount} items · {active
                            ? <span className="text-gold-2 font-medium">in progress</span>
                            : days === null ? 'never counted' : <>last {lastLabel}{stale ? ' · stale' : ''}</>}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-mono text-[12px] text-ink-2">{formatCurrency(a.onHandValue)}</div>
                        {!active && a.drift >= 1 && (
                          <div className="font-mono text-[10px] text-red-text mt-0.5">drift ~${Math.round(a.drift).toLocaleString()}</div>
                        )}
                        {active
                          ? <div className="font-mono text-[10px] text-gold-2 font-medium mt-0.5">Resume →</div>
                          : <div className="font-mono text-[10px] text-ink-4 mt-0.5">{startingArea === a.id ? 'starting…' : 'Count ›'}</div>}
                      </div>
                    </button>
                  )
                })}
                {countAreas.length === 0 && <div className="px-3.5 py-8 text-center font-mono text-[11px] text-ink-4">No storage areas with items</div>}
              </div>
              <button disabled={!!startingArea} onClick={startFullCount}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border border-dashed border-line-2 text-ink-2 text-[13px] font-medium active:bg-bg-2 disabled:opacity-60">
                <Plus size={15} className="text-ink-3" /> {startingArea === '__full__' ? 'Starting…' : 'Full count · all areas'}
              </button>
              <button onClick={() => setShowHistory(v => !v)} className="w-full flex items-center justify-between py-1.5 px-0.5 font-mono text-[11px] text-ink-3">
                <span>Recent counts</span>
                <ChevronDown size={14} className={`transition-transform ${showHistory ? 'rotate-180' : ''}`} />
              </button>
            </div>

            {/* ── Mobile list (session history; desktop always; mobile behind "Recent counts") ── */}
            <div className={`md:hidden flex-col gap-2 mb-4 ${showHistory ? 'flex' : 'hidden'}`}>
              <button onClick={() => setShowHistory(false)}
                className="flex items-center gap-1.5 text-[13px] font-medium text-ink-2 active:text-ink mb-1 -ml-0.5">
                <ArrowLeft size={16} className="text-ink-3" /> Back to count
              </button>
              <span className="font-mono text-[10.5px] uppercase tracking-[0.05em] text-ink-3 px-0.5 mb-0.5">Recent counts · {filteredSessions.length}</span>
              {filteredSessions.map(s => {
                const counts = s.counts ?? { total: 0, counted: 0, skipped: 0 }
                const isUpdating = s.status === 'UPDATING'
                const handleCardTap = () => {
                  setSessionMenuId(null)
                  if (s.status === 'IN_PROGRESS' || s.status === 'PENDING_REVIEW') openSession(s, 'count')
                  else if (s.status === 'FINALIZED') openSession(s, 'review')
                }
                return (
                  <div key={s.id} className="bg-paper rounded-xl border border-line border-l-[3px] flex items-stretch"
                    style={{ borderLeftColor: SESSION_ACCENT[s.status] ?? '#d4d4d8' }}>
                    <div
                      className={`flex-1 min-w-0 px-4 py-3 ${!isUpdating && s.status !== 'CANCELLED' ? 'cursor-pointer' : 'cursor-default'}`}
                      onClick={!isUpdating && s.status !== 'CANCELLED' ? handleCardTap : undefined}
                    >
                      <div className="flex items-center gap-2">
                        <span className="flex-1 text-[13.5px] font-medium text-ink truncate tracking-[-0.01em]">
                          {s.label || (s.type === 'FULL' ? 'Full count' : 'Partial count')}
                        </span>
                        <StatusBadge status={s.status} />
                      </div>
                      <div className="flex items-center justify-between mt-1 gap-2">
                        <span className="font-mono text-[11px] text-ink-3 truncate">
                          {fmtDate(s.sessionDate)} · {s.countedBy}
                        </span>
                        {s.status === 'IN_PROGRESS'    && <span className="font-mono text-[11px] font-medium text-gold shrink-0">Continue →</span>}
                        {s.status === 'PENDING_REVIEW' && <span className="font-mono text-[11px] font-medium text-gold-2 shrink-0">Review →</span>}
                        {s.status === 'FINALIZED'      && <span className="font-mono text-[11px] font-medium text-green-700 shrink-0">Report</span>}
                        {isUpdating && (
                          <span className="flex items-center gap-1 font-mono text-[11px] text-violet-600 shrink-0">
                            <span className="inline-block w-2.5 h-2.5 rounded-full border-2 border-violet-400 border-t-transparent animate-spin" />
                            Processing…
                          </span>
                        )}
                      </div>
                      {s.status === 'FINALIZED' && Number(s.totalCountedValue) > 0 && (
                        <div className="mt-1 font-mono text-[13px] font-semibold text-ink">
                          {formatCurrency(Number(s.totalCountedValue))}
                          <span className="font-mono text-[11px] font-normal text-ink-3 ml-1">total value</span>
                        </div>
                      )}
                    </div>
                    <div className="relative flex items-center pr-2">
                      <button
                        onClick={e => { e.stopPropagation(); setSessionMenuId(sessionMenuId === s.id ? null : s.id) }}
                        className="w-8 h-8 flex items-center justify-center rounded-lg text-ink-4 hover:bg-bg-2"
                      >
                        <MoreHorizontal size={15} />
                      </button>
                      {sessionMenuId === s.id && (
                        <>
                          <div className="fixed inset-0 z-40" onClick={() => setSessionMenuId(null)} />
                          <div className="absolute right-0 top-full mt-1 w-48 bg-paper border border-line rounded-xl shadow-lg z-50 overflow-hidden">
                            <button onClick={e => { e.stopPropagation(); setSessionMenuId(null); openEditModal(s) }}
                              className="flex items-center gap-2 w-full px-4 py-3 text-[13px] text-ink-2 hover:bg-bg-2 border-b border-line">
                              <Pencil size={13} /> Edit metadata
                            </button>
                            <button onClick={e => { e.stopPropagation(); setSessionMenuId(null); handleReopenAndEdit(s) }}
                              className="flex items-center gap-2 w-full px-4 py-3 text-[13px] text-ink-2 hover:bg-bg-2 border-b border-line">
                              <ClipboardList size={13} /> {s.status === 'FINALIZED' ? 'Reopen & edit' : 'Edit counts'}
                            </button>
                            <button onClick={e => { e.stopPropagation(); setSessionMenuId(null); setDeleteTarget(s) }}
                              className="flex items-center gap-2 w-full px-4 py-3 text-[13px] text-red-500 hover:bg-red-50">
                              <Trash2 size={13} /> Delete
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            {/* ── Desktop table (session history; History view only) ── */}
            <div className={`${showHistory ? 'md:block' : ''} hidden bg-paper border border-line rounded-xl overflow-hidden mb-5`}>
              <div className="grid grid-cols-[100px_1.6fr_0.7fr_1.4fr_1fr_220px] px-[18px] py-2.5 bg-bg-2 border-b border-line font-mono text-[10.5px] text-ink-3 tracking-[0.01em]">
                <span>DATE</span>
                <span>SESSION</span>
                <span>TYPE</span>
                <span>PROGRESS</span>
                <span className="text-right">VALUE</span>
                <span className="text-right">ACTIONS</span>
              </div>
              <div>
                {filteredSessions.length === 0 ? (
                  <div className="px-[18px] py-10 text-center font-mono text-[11px] text-ink-4">NO SESSIONS MATCH THIS FILTER</div>
                ) : filteredSessions.map((s, idx) => {
                  const counts  = s.counts ?? { total: 0, counted: 0, skipped: 0 }
                  const pct     = counts.total > 0 ? Math.round((counts.counted / counts.total) * 100) : 0
                  const isLast  = idx === filteredSessions.length - 1
                  return (
                    <div key={s.id}
                      className={`grid grid-cols-[100px_1.6fr_0.7fr_1.4fr_1fr_220px] px-[18px] py-4 items-center hover:bg-bg-2/60 transition-colors ${isLast ? '' : 'border-b border-line'}`}
                    >
                      {/* Date */}
                      <div>
                        <div className="font-mono text-[13px] text-ink tracking-[-0.01em]">{fmtDate(s.sessionDate)}</div>
                        <div className="font-mono text-[10.5px] text-ink-3 mt-0.5">{relTime(s.sessionDate, s.startedAt)}</div>
                      </div>
                      {/* Session label + status */}
                      <div className="min-w-0 pr-3">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[13.5px] font-medium text-ink tracking-[-0.01em] truncate">
                            {s.label || (s.type === 'FULL' ? 'Full count' : 'Partial count')}
                          </span>
                          <StatusBadge status={s.status} />
                        </div>
                        <div className="font-mono text-[11px] text-ink-3 mt-0.5">
                          <b className="font-medium text-ink-2">{s.countedBy}</b>
                          {s.status === 'FINALIZED' && s.finalizedAt && s.startedAt
                            ? ` · ${durationMin(s.startedAt, s.finalizedAt)} min duration`
                            : s.status === 'IN_PROGRESS' || s.status === 'PENDING_REVIEW'
                              ? ` · started ${fmtClock(s.startedAt)}`
                              : ` · ${counts.total} items`}
                        </div>
                      </div>
                      {/* Type */}
                      <div className="font-mono text-[13px] text-ink-2 tracking-[-0.01em]">{s.type === 'FULL' ? 'Full' : 'Partial'}</div>
                      {/* Progress */}
                      <div>
                        {s.status === 'FINALIZED' ? (
                          <>
                            <div className="flex items-baseline gap-2">
                              <span className="font-mono text-[13px] font-medium text-ink tracking-[-0.01em]">{counts.total} / {counts.total}</span>
                              <span className="font-mono text-[11px] text-green-700">complete</span>
                            </div>
                            <div className="h-[5px] bg-bg-2 rounded-full mt-1.5 w-4/5 overflow-hidden">
                              <div className="h-[5px] bg-green-500 rounded-full" style={{ width: '100%' }} />
                            </div>
                          </>
                        ) : s.status === 'UPDATING' ? (
                          <span className="font-mono text-[11px] text-violet-600">Processing…</span>
                        ) : (
                          <>
                            <div className="flex items-baseline gap-2">
                              <span className="font-mono text-[13px] font-medium text-ink tracking-[-0.01em]">{counts.counted} / {counts.total}</span>
                              <span className="font-mono text-[11px] text-gold">{pct}%</span>
                            </div>
                            <div className="h-[5px] bg-bg-2 rounded-full mt-1.5 w-4/5 overflow-hidden">
                              <div className="h-[5px] bg-gold rounded-full" style={{ width: `${Math.max(pct, counts.counted > 0 ? 1.5 : 0)}%` }} />
                            </div>
                          </>
                        )}
                      </div>
                      {/* Value */}
                      <div className="text-right">
                        {s.status === 'FINALIZED' && Number(s.totalCountedValue) > 0 ? (
                          <>
                            <div className="font-mono text-[14px] font-semibold text-ink tracking-[-0.015em]">
                              {formatCurrency(Number(s.totalCountedValue))}
                            </div>
                            <div className="font-mono text-[10.5px] text-ink-3 mt-0.5">{counts.total} lines</div>
                          </>
                        ) : (
                          <span className="font-mono text-[13px] text-ink-4">—</span>
                        )}
                      </div>
                      {/* Actions */}
                      <div className="flex items-center gap-1.5 justify-end">
                        {(s.status === 'IN_PROGRESS' || s.status === 'PENDING_REVIEW') && (
                          <button
                            onClick={() => openSession(s, 'count')}
                            className="flex items-center gap-1 px-3 py-1.5 rounded-[8px] bg-ink text-paper text-[12.5px] font-medium hover:bg-ink-2 transition-colors whitespace-nowrap"
                          >
                            Continue <span className="text-gold">→</span>
                          </button>
                        )}
                        {s.status === 'UPDATING' && (
                          <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] font-mono text-[11px] text-violet-600 bg-violet-50 border border-violet-200">
                            <span className="w-3 h-3 rounded-full border-2 border-violet-400 border-t-transparent animate-spin" />
                            Updating…
                          </span>
                        )}
                        {s.status === 'FINALIZED' && (
                          <button
                            onClick={() => openSession(s, 'review')}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] border border-line bg-paper text-[12.5px] font-medium text-ink-2 hover:border-ink-3 transition-colors whitespace-nowrap"
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
                            Report
                          </button>
                        )}
                        <button onClick={e => { e.stopPropagation(); openEditModal(s) }} title="Edit"
                          className="p-1.5 rounded-lg text-ink-4 hover:text-ink-2 hover:bg-bg-2 transition-colors">
                          <Pencil size={13} />
                        </button>
                        <button onClick={e => { e.stopPropagation(); handleReopenAndEdit(s) }}
                          title={s.status === 'FINALIZED' ? 'Reopen & edit' : 'Edit counts'}
                          className="p-1.5 rounded-lg text-ink-4 hover:text-ink-2 hover:bg-bg-2 transition-colors">
                          <ClipboardList size={13} />
                        </button>
                        <button onClick={e => { e.stopPropagation(); setDeleteTarget(s) }} title="Delete"
                          className="p-1.5 rounded-lg text-ink-4 hover:text-red-500 hover:bg-red-50 transition-colors">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* ── Overdue callout (desktop; mobile shows it in the hero stat strip) ── */}
            {isOverdue && (
              <div className="hidden md:flex items-center gap-5 bg-[#fffbeb] border border-[#fcd34d] rounded-xl px-[22px] py-[18px] mb-5">
                <div className="w-9 h-9 rounded-[10px] bg-gold-soft border border-[#fcd34d] flex items-center justify-center shrink-0">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#b45309" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-mono text-[10.5px] text-gold-2 tracking-[0.02em] font-semibold">COUNT OVERDUE · {nextDateStr}</p>
                  <p className="text-[14px] text-amber-900 mt-1 tracking-[-0.01em]">
                    Weekly count is <strong>{overdueDays} day{overdueDays !== 1 ? 's' : ''} late</strong>. COGS calculations are drifting from actuals — start a new count to re-anchor.
                  </p>
                </div>
                <button
                  onClick={() => setView('new')}
                  className="flex items-center gap-1.5 px-4 py-2.5 rounded-[9px] bg-gold text-white text-[13px] font-medium hover:bg-gold-2 transition-colors shrink-0 whitespace-nowrap"
                >
                  <span className="text-[#fef3c7] font-semibold">+</span>
                  Start count now
                </button>
              </div>
            )}

            {/* ── Footer note (desktop) ── */}
            <div className="hidden md:flex justify-between font-mono text-[10.5px] text-ink-3 tracking-wide">
              <span>
                SHOWING {filteredSessions.length} SESSION{filteredSessions.length !== 1 ? 'S' : ''} · {sessions.filter(s => s.status === 'IN_PROGRESS').length} IN PROGRESS · {sessions.filter(s => s.status === 'FINALIZED').length} FINALIZED
              </span>
              <span>WEEKLY CADENCE · <kbd className="font-mono text-[10px] bg-bg-2 border border-line rounded px-1 py-px text-ink-2">⌘N</kbd> FOR NEW COUNT</span>
            </div>
          </>
        )}

        {/* ── Delete confirmation modal ── */}
        {deleteTarget && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
            <div className="bg-paper rounded-2xl shadow-xl w-full max-w-sm p-6">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center shrink-0">
                  <Trash2 size={18} className="text-red-600" />
                </div>
                <div>
                  <h3 className="font-semibold text-ink">Delete count session?</h3>
                  <p className="text-xs text-ink-3 mt-0.5">&ldquo;{deleteTarget.label || 'Untitled'}&rdquo; — {fmtDate(deleteTarget.sessionDate)}</p>
                </div>
              </div>
              {deleteTarget.status === 'FINALIZED' && (
                <div className="bg-[#fffbeb] border border-[#fcd34d] rounded-lg px-3 py-2 text-xs text-gold-2 mb-3">
                  This session is finalized. Deleting it won&apos;t revert inventory stock levels.
                </div>
              )}
              <div className="flex gap-3 mt-4">
                <button onClick={() => setDeleteTarget(null)}
                  className="flex-1 px-4 py-2.5 rounded-[9px] border border-line text-[13px] font-medium text-ink-2 hover:border-ink-3 transition-colors">
                  Cancel
                </button>
                <button onClick={handleDeleteSession} disabled={deleting}
                  className="flex-1 px-4 py-2.5 rounded-[9px] bg-red-600 text-white text-[13px] font-medium hover:bg-red-700 disabled:opacity-60 transition-colors">
                  {deleting ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Edit session metadata modal ── */}
        {editTarget && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
            <div className="bg-paper rounded-2xl shadow-xl w-full max-w-sm p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-ink">Edit session details</h3>
                <button onClick={() => setEditTarget(null)} className="p-1 rounded-lg hover:bg-bg-2 text-ink-3">
                  <X size={16} />
                </button>
              </div>
              <form onSubmit={handleEditSession} className="space-y-3">
                <div>
                  <label className="text-[11px] font-medium text-ink-3 block mb-1 uppercase tracking-wide">Label</label>
                  <input value={editLabel} onChange={e => setEditLabel(e.target.value)}
                    placeholder="e.g. Full count Apr 12"
                    className="w-full border border-line rounded-[9px] px-3 py-2.5 text-[13px] text-ink focus:outline-none focus:border-ink-3 transition-colors" />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-ink-3 block mb-1 uppercase tracking-wide">Counted by</label>
                  <input value={editCountedBy} onChange={e => setEditCountedBy(e.target.value)} required
                    className="w-full border border-line rounded-[9px] px-3 py-2.5 text-[13px] text-ink focus:outline-none focus:border-ink-3 transition-colors" />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-ink-3 block mb-1 uppercase tracking-wide">Date</label>
                  <input type="date" value={editDate} onChange={e => setEditDate(e.target.value)}
                    className="w-full border border-line rounded-[9px] px-3 py-2.5 text-[13px] text-ink focus:outline-none focus:border-ink-3 transition-colors" />
                </div>
                <div className="flex gap-3 pt-1">
                  <button type="button" onClick={() => setEditTarget(null)}
                    className="flex-1 px-4 py-2.5 rounded-[9px] border border-line text-[13px] font-medium text-ink-2 hover:border-ink-3 transition-colors">
                    Cancel
                  </button>
                  <button type="submit"
                    className="flex-1 px-4 py-2.5 rounded-[9px] bg-ink text-paper text-[13px] font-medium hover:bg-ink-2 transition-colors">
                    Save
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ════════════════════════════════════════════════════════════════════════════
  // VIEW B — COUNT MODE
  // ════════════════════════════════════════════════════════════════════════════
  if (view === 'count' && active) {
    const renderLine = (line: Line) => {
      const isOpen    = openId === line.id
      const isCounted = line.countedQty !== null && !line.skipped
      const isSkipped = line.skipped
      const locLabel  = line.inventoryItem.storageArea?.name ?? line.inventoryItem.location
      // Last counted amount (previous session) shown on the card for reference.
      const lastQty   = line.inventoryItem.lastCountQty != null
        ? convertBaseToCountUom(Number(line.inventoryItem.lastCountQty), line.selectedUom, line.inventoryItem)
        : null

      // inputQty is in line.selectedUom; expectedQty is in baseUnit — convert before comparing
      const inputBase = convertCountQtyToBase(inputQty, line.selectedUom, line.inventoryItem)
      const liveVar = isOpen && Number(line.expectedQty) > 0
        ? ((inputBase - Number(line.expectedQty)) / Number(line.expectedQty)) * 100
        : null

      if (isSkipped) return (
        <div key={line.id} id={`ln-${line.id}`}
          ref={el => { cardRefs.current[`d-${line.id}`] = el }}
          className="mx-4 mb-2 border border-line bg-bg-2 rounded-xl opacity-60"
        >
          <div className="flex items-center gap-3 px-4 py-3">
            <SkipForward size={15} className="text-ink-4 shrink-0" />
            <span className="flex-1 text-[13.5px] text-ink-3 line-through">{line.inventoryItem.itemName}</span>
            <button
              onClick={() => setEditingItemId(line.inventoryItemId)}
              className="p-1.5 rounded-lg text-ink-4 hover:text-ink-2 hover:bg-line"
              title="Edit item"
            >
              <Pencil size={13} />
            </button>
            <button
              onClick={() => unskipLine(line)}
              className="font-mono text-[11px] text-gold font-medium hover:text-gold-2 px-2 py-1 rounded-[6px] hover:bg-gold-soft transition-colors"
            >
              Count it
            </button>
          </div>
        </div>
      )

      if (isCounted && !isOpen) {
        const vPct = line.variancePct !== null ? Number(line.variancePct) : null
        const large = vPct !== null && Math.abs(vPct) > LARGE_VARIANCE_PCT
        return (
          <div key={line.id} id={`ln-${line.id}`}
            ref={el => { cardRefs.current[`d-${line.id}`] = el }}
            onClick={() => setOpenId(line.id)}
            className={`mx-4 mb-2 rounded-xl bg-green-soft border border-[#86efac] cursor-pointer ${large ? 'border-l-[3px] border-l-gold' : ''}`}
          >
            <div className="flex items-center gap-3 px-4 py-3">
              <CheckCircle2 size={18} className="text-green-text shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[13.5px] font-medium text-ink">{line.inventoryItem.itemName}</div>
                <div className="font-mono text-[11px] text-ink-3 mt-0.5 flex items-center gap-1.5">
                  <span>{Number(line.countedQty).toFixed(2)} {line.selectedUom}</span>
                  {vPct !== null && (
                    <span className={varColor(vPct)}>· {vPct >= 0 ? '+' : ''}{vPct.toFixed(1)}%</span>
                  )}
                  {lastQty != null && <span className="text-ink-4">· last {lastQty.toFixed(2)}</span>}
                </div>
              </div>
              <CategoryBadge category={line.inventoryItem.category} />
              {locLabel && <span className="font-mono text-[11px] text-ink-3 ml-1 hidden sm:block">{locLabel}</span>}
              <button
                onClick={e => { e.stopPropagation(); setEditingItemId(line.inventoryItemId) }}
                className="p-1.5 rounded-lg text-ink-4 hover:text-ink-2 hover:bg-green-soft ml-1"
                title="Edit item"
              >
                <Pencil size={13} />
              </button>
            </div>
          </div>
        )
      }

      // Uncounted / open
      const largeOpen = liveVar !== null && Math.abs(liveVar) > LARGE_VARIANCE_PCT
      return (
        <div key={line.id} id={`ln-${line.id}`}
          ref={el => { cardRefs.current[`d-${line.id}`] = el }}
          className={`mx-4 mb-2 rounded-xl bg-paper transition-all ${
            isOpen
              ? `border-2 border-gold${largeOpen ? ' border-l-[3px] border-l-gold' : ''}`
              : 'border border-line hover:border-line-2'
          }`}
        >
          {/* Header row */}
          <div className="flex items-center gap-3 px-4 py-3 cursor-pointer"
            onClick={() => setOpenId(isOpen ? null : line.id)}
          >
            <Circle size={16} className="text-line-2 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[13.5px] font-medium text-ink truncate">{line.inventoryItem.itemName}</div>
              {lastQty != null && <div className="font-mono text-[11px] text-ink-4 mt-0.5">last count {lastQty.toFixed(2)} {line.selectedUom}</div>}
            </div>
            <CategoryBadge category={line.inventoryItem.category} />
            {locLabel && <span className="font-mono text-[11px] text-ink-3 ml-1">{locLabel}</span>}
            <button
              onClick={e => { e.stopPropagation(); setEditingItemId(line.inventoryItemId) }}
              className="p-1.5 rounded-lg text-ink-4 hover:text-ink-2 hover:bg-bg-2"
              title="Edit item"
            >
              <Pencil size={13} />
            </button>
            <ChevronDown size={15} className={`text-ink-3 ml-1 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
          </div>

          {/* Expanded body */}
          {isOpen && (
            <div className="px-4 pb-4 pt-1 border-t border-line">
              {(() => {
                const uoms = getCountableUoms(line.inventoryItem)
                const expectedDisplay = convertBaseToCountUom(Number(line.expectedQty), line.selectedUom, line.inventoryItem)
                return (
                  <>
                    {uoms.length > 1 && (
                      <div className="mb-3">
                        <select
                          value={line.selectedUom}
                          onChange={e => changeUom(line, e.target.value)}
                          className="w-full border border-line rounded-[9px] px-3 py-2 text-[13px] font-medium text-ink-2 bg-paper focus:outline-none focus:border-ink-3 transition-colors"
                        >
                          {uoms.map(opt => (
                            <option key={opt.label} value={opt.label}>{opt.display ?? uomOptionLabel(opt, line.inventoryItem.baseUnit)}</option>
                          ))}
                        </select>
                      </div>
                    )}

                    {/* Expected + live variance */}
                    <div className="font-mono text-[11px] text-ink-3 mb-1.5 flex items-center gap-1.5">
                      <span>Expected: {expectedDisplay.toFixed(2)} {line.selectedUom}</span>
                      {liveVar !== null && (
                        <span className={`font-medium ${varColor(liveVar)}`}>
                          · {liveVar > 0 ? '+' : ''}{liveVar.toFixed(1)}%
                        </span>
                      )}
                    </div>

                    {(line.inventoryItem.parLevel != null || line.inventoryItem.lastCountQty != null) && (
                      <div className="font-mono text-[11px] text-ink-3 mb-3 flex items-center gap-3">
                        {line.inventoryItem.parLevel != null && (
                          <span>Par: <span className="font-medium text-ink-2">{Number(line.inventoryItem.parLevel).toFixed(2)} {line.selectedUom}</span></span>
                        )}
                        {line.inventoryItem.lastCountQty != null && (
                          <span>Last count: <span className="font-medium text-ink-2">{convertBaseToCountUom(Number(line.inventoryItem.lastCountQty), line.selectedUom, line.inventoryItem).toFixed(2)} {line.selectedUom}</span></span>
                        )}
                      </div>
                    )}
                  </>
                )
              })()}

              {/* ± stepper */}
              <div className="flex items-center gap-2 mb-3">
                <button
                  onClick={() => setInputQty(v => Math.max(0, Math.round((v - 1) * 100) / 100))}
                  className="w-14 h-[66px] rounded-[9px] bg-bg-2 border border-line flex items-center justify-center hover:bg-line transition-colors shrink-0"
                >
                  <Minus size={20} className="text-ink-2" />
                </button>
                <input
                  type="number"
                  value={inputQty}
                  onChange={e => setInputQty(parseFloat(e.target.value) || 0)}
                  className="flex-1 min-w-0 h-[66px] text-center text-[28px] font-semibold tracking-[-0.03em] border-2 border-gold rounded-[9px] focus:outline-none text-ink"
                  min={0} step={0.1}
                />
                <button
                  onClick={() => setInputQty(v => Math.round((v + 1) * 100) / 100)}
                  className="w-14 h-[66px] rounded-[9px] bg-bg-2 border border-line flex items-center justify-center hover:bg-line transition-colors shrink-0"
                >
                  <Plus size={20} className="text-ink-2" />
                </button>
              </div>

              <div className="text-center font-mono text-[11px] text-ink-3 mb-4">{line.selectedUom}</div>

              <div className="flex gap-2">
                <button
                  onClick={() => confirmLine(line, inputQty)}
                  className="flex-1 h-11 bg-ink text-paper rounded-[9px] font-medium text-[13px] hover:bg-ink-2 transition-colors flex items-center justify-center gap-1.5"
                >
                  <Check size={15} className="text-gold" /> Confirm count
                </button>
                <button
                  onClick={() => confirmLine(line, 0)}
                  className="px-3 h-11 border border-[#fcd34d] bg-gold-soft text-gold-2 rounded-[9px] font-mono text-[11px] font-medium hover:bg-[#fde68a] transition-colors"
                  title="Mark out of stock"
                >
                  Out of stock
                </button>
                <button
                  onClick={() => skipLine(line)}
                  className="px-4 h-11 border border-line rounded-[9px] text-[13px] text-ink-3 hover:bg-bg-2 transition-colors flex items-center gap-1.5"
                >
                  <SkipForward size={13} /> Skip
                </button>
              </div>
            </div>
          )}
        </div>
      )
    }

    const renderMobileLine = (line: Line) => {
      const item      = line.inventoryItem
      const isOpen    = openId === line.id
      const isCounted = line.countedQty !== null && !line.skipped
      const isSkipped = line.skipped
      const locLabel  = item.storageArea?.name ?? item.location
      const f = (n: number) => (Number(n) % 1 === 0 ? Number(n).toFixed(0) : Number(n).toFixed(1))

      const uoms        = getCountableUoms(item)
      const unitLabels  = Array.from(new Set([...uoms.map(u => u.label), line.selectedUom]))   // size order (case→pkg→each→units); selectedUom only appended if it's a legacy unit not in the list
      const uomDisplay  = (lbl: string) => uoms.find(u => u.label === lbl)?.display ?? lbl   // chip text ("case (25kg)") vs stored token
      const stepBy      = /^(kg|l|lb|gal|qt)$/i.test(line.selectedUom) ? 0.1 : 1   // fine step for bulk weight/volume units
      const showCases   = Number(item.packSize) > 1 && /case|cs|box|ctn|pack|flat|tray|crate/i.test(item.packUOM || '')
      const effectiveQty = inputQty + (showCases ? caseQty * Number(item.packSize) : 0)
      const effBase     = convertCountQtyToBase(effectiveQty, line.selectedUom, item)
      const liveVar = isOpen && Number(line.expectedQty) > 0
        ? ((effBase - Number(line.expectedQty)) / Number(line.expectedQty)) * 100
        : null
      const expectedDisplay = convertBaseToCountUom(Number(line.expectedQty), line.selectedUom, item)
      const lastDisplay = item.lastCountQty != null ? convertBaseToCountUom(Number(item.lastCountQty), line.selectedUom, item) : null
      const bigVar = isCounted && line.variancePct !== null && Math.abs(Number(line.variancePct)) > LARGE_VARIANCE_PCT
      const dotColor = isSkipped ? 'bg-ink-4' : isCounted ? (bigVar ? 'bg-gold' : 'bg-green') : 'bg-ink-4'
      const rowBg = isSkipped ? 'bg-bg-2 border-line opacity-60'
        : isCounted ? (bigVar ? 'bg-amber-50 border-amber-200' : 'bg-green-soft border-[#86efac]')
        : isOpen ? 'border-gold bg-paper' : 'bg-paper border-line'
      const sub = [item.category, lastDisplay != null ? `last ${f(lastDisplay)} ${line.selectedUom}` : locLabel].filter(Boolean).join(' · ')

      return (
        <div key={`m-${line.id}`}
          ref={el => { cardRefs.current[`m-${line.id}`] = el }}
          className={`rounded-xl border ${rowBg} overflow-hidden`}
        >
          <div
            className="flex items-center gap-3 px-3 py-2.5 cursor-pointer"
            onClick={() => setOpenId(isOpen ? null : line.id)}
          >
            <span className={`w-2 h-2 rounded-full shrink-0 ${dotColor}`} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className={`text-[14px] font-semibold truncate ${isSkipped ? 'line-through text-ink-4' : 'text-ink'}`}>{item.itemName}</span>
                {bigVar && (
                  <span className="font-mono text-[8.5px] font-bold uppercase tracking-[0.02em] px-1 py-0.5 rounded bg-red-soft text-red-text shrink-0">
                    VAR {Number(line.variancePct) >= 0 ? '+' : ''}{Number(line.variancePct).toFixed(0)}%
                  </span>
                )}
              </div>
              <div className="font-mono text-[10.5px] text-ink-3 truncate mt-0.5">{sub}</div>
            </div>
            {isSkipped ? (
              <span role="button" tabIndex={0}
                onClick={e => { e.stopPropagation(); unskipLine(line) }}
                className="font-mono text-[11px] text-gold font-medium px-2 py-1 rounded-[6px] active:bg-gold-soft shrink-0">Count it</span>
            ) : isCounted ? (
              <div className="text-right shrink-0">
                <div className="text-sm font-semibold text-ink tabular-nums leading-tight">
                  {f(Number(line.countedQty))}<span className="font-mono text-[10.5px] font-normal text-ink-3 ml-0.5">{line.selectedUom}</span>
                </div>
                {line.variancePct !== null && (
                  <div className={`font-mono text-[11px] mt-0.5 ${varColor(line.variancePct)}`}>
                    {Number(line.variancePct) >= 0 ? '+' : ''}{Number(line.variancePct).toFixed(1)}%
                  </div>
                )}
              </div>
            ) : (
              <span className="shrink-0 inline-flex items-center gap-1 font-mono text-[11px] font-semibold text-ink-2 border border-line rounded-full px-2.5 py-1">
                COUNT <span className="text-ink-4">›</span>
              </span>
            )}
          </div>

          {isOpen && (
            <div className="fixed inset-0 z-[60] flex items-end md:hidden" onClick={() => setOpenId(null)}>
              <div className="absolute inset-0 bg-black/40" />
              <div className="relative w-full bg-paper rounded-t-2xl px-4 pb-8 pt-2 shadow-xl animate-[slide-up_.25s_ease] max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
                <div className="w-9 h-1 bg-line rounded-full mx-auto mb-3" />
                <div className="flex items-start gap-3 mb-1">
                  <div className="flex-1 min-w-0">
                    <div className="text-[17px] font-semibold text-ink truncate tracking-[-0.02em]">{item.itemName}</div>
                    <div className="font-mono text-[11px] text-ink-3 mt-0.5 truncate">{[item.category, locLabel].filter(Boolean).join(' · ')}</div>
                  </div>
                  <button onClick={() => setOpenId(null)} className="p-1 -mr-1 text-ink-4 shrink-0"><X size={18} /></button>
                </div>

                {/* Unit tabs */}
                {unitLabels.length > 1 && (
                  <div className="flex bg-bg-2 border border-line rounded-[10px] p-1 gap-0.5 mt-3 overflow-x-auto [&::-webkit-scrollbar]:hidden">
                    {unitLabels.map(label => (
                      <button key={label} onClick={() => { if (label !== line.selectedUom) { changeUom(line, label); setInputQty(0); setCaseQty(0) } }}
                        className={`flex-1 min-w-[56px] py-1.5 text-[13px] font-medium rounded-[7px] transition-colors whitespace-nowrap ${line.selectedUom === label ? 'bg-paper shadow-[0_1px_2px_rgba(0,0,0,0.04)] text-ink' : 'text-ink-3'}`}>
                        {uomDisplay(label)}
                      </button>
                    ))}
                  </div>
                )}

                {/* Big stepper */}
                <div className="text-center font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em] mt-4 mb-2">{line.selectedUom} on hand</div>
                <div className="flex items-center gap-3">
                  <button onClick={() => setInputQty(v => Math.max(0, Math.round((v - stepBy) * 100) / 100))}
                    className="w-[60px] h-[60px] rounded-2xl bg-bg-2 border border-line grid place-items-center shrink-0 active:bg-line"><Minus size={26} className="text-ink-2" /></button>
                  <input type="number" value={inputQty} onChange={e => setInputQty(parseFloat(e.target.value) || 0)}
                    className="flex-1 min-w-0 h-[60px] text-center text-[40px] font-semibold tracking-[-0.03em] border-2 border-gold rounded-2xl focus:outline-none text-ink" min={0} step={stepBy} />
                  <button onClick={() => setInputQty(v => Math.round((v + stepBy) * 100) / 100)}
                    className="w-[60px] h-[60px] rounded-2xl bg-ink grid place-items-center shrink-0 active:bg-ink-2"><Plus size={26} className="text-gold" /></button>
                </div>
                <div className="text-center font-mono text-[10.5px] text-ink-4 mt-2">tap to type</div>

                {/* Unopened cases */}
                {showCases && (
                  <div className="flex items-center justify-between gap-3 border-t border-line mt-3 pt-3">
                    <span className="font-mono text-[11px] text-ink-2 uppercase tracking-[0.03em]">+ unopened cases <span className="text-ink-4">({f(Number(item.packSize))}/{item.packUOM || 'CS'})</span></span>
                    <div className="flex items-center gap-2 shrink-0">
                      <button onClick={() => setCaseQty(v => Math.max(0, v - 1))} className="w-9 h-9 rounded-[9px] bg-bg-2 border border-line grid place-items-center active:bg-line"><Minus size={16} className="text-ink-2" /></button>
                      <span className="w-6 text-center text-[16px] font-semibold tabular-nums">{caseQty}</span>
                      <button onClick={() => setCaseQty(v => v + 1)} className="w-9 h-9 rounded-[9px] bg-ink grid place-items-center active:bg-ink-2"><Plus size={16} className="text-gold" /></button>
                    </div>
                  </div>
                )}

                {/* Variance vs theoretical + last count — neutral "on track" near zero, else signed unit delta */}
                {Number(line.expectedQty) > 0 && (() => {
                  const onTrack = liveVar !== null && Math.abs(liveVar) < 2
                  const short   = liveVar !== null && liveVar < 0
                  const bg = onTrack ? 'bg-bg-2' : short ? 'bg-red-soft' : 'bg-gold-soft'
                  const fg = onTrack ? 'text-ink-3' : short ? 'text-red-text' : 'text-gold-2'
                  const delta = effectiveQty - expectedDisplay
                  return (
                    <div className={`flex items-center justify-between gap-2 mt-4 px-3 py-2.5 rounded-[10px] font-mono text-[11px] ${bg}`}>
                      <span className="text-ink-3">
                        Expected <b className="text-ink-2 font-medium">{expectedDisplay.toFixed(1)} {line.selectedUom}</b>
                        {lastDisplay != null && <> · last {f(lastDisplay)} {line.selectedUom}</>}
                      </span>
                      <span className={`font-semibold whitespace-nowrap ${fg}`}>
                        {onTrack ? 'on track' : `${delta > 0 ? '+' : ''}${f(delta)} ${line.selectedUom}`}
                      </span>
                    </div>
                  )
                })()}

                {isOffline && (
                  <div className="font-mono text-[10px] text-gold-2 mt-3 flex items-center gap-1.5">
                    <WifiOff size={12} /> Saved on device · syncs when back online
                  </div>
                )}

                <button onClick={() => confirmLine(line, effectiveQty)}
                  className="w-full h-12 bg-ink text-paper rounded-[12px] font-semibold text-[15px] flex items-center justify-center gap-2 mt-4">
                  <Check size={17} className="text-gold" /> Save count
                </button>
                <div className="flex gap-2 mt-2">
                  {isCounted ? (
                    <button onClick={() => clearLine(line)} className="flex-1 h-10 border border-line rounded-[10px] text-[12.5px] text-ink-2 font-medium">Clear count</button>
                  ) : (
                    <button onClick={() => confirmLine(line, 0)} className="flex-1 h-10 border border-amber-200 bg-amber-50 text-amber-700 rounded-[10px] text-[12.5px] font-semibold">Out of stock</button>
                  )}
                  <button onClick={() => skipLine(line)} className="flex-1 h-10 border border-line rounded-[10px] text-[12.5px] text-ink-3 font-medium inline-flex items-center justify-center gap-1.5"><SkipForward size={13} /> Skip</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )
    }

    const DesktopItems = () => (
      <>
        {(catFilter || !grouped) ? (
          filteredLines.length === 0 ? <Empty /> : filteredLines.map(renderLine)
        ) : (
          Object.keys(grouped).length === 0 ? <Empty /> :
          Object.entries(grouped)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([cat, lines]) => {
              const catDone = lines.filter(l => l.countedQty !== null || l.skipped).length
              return (
                <div key={cat} className="mb-2">
                  <div className="flex items-center gap-2 px-4 py-2">
                    <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-3">{cat}</span>
                    <span className="font-mono text-[10.5px] text-ink-4">{catDone}/{lines.length}</span>
                    <div className="flex-1 max-w-[80px] h-1 bg-bg-2 rounded-full ml-1">
                      <div className="h-1 bg-gold rounded-full"
                        style={{ width: `${lines.length > 0 ? (catDone / lines.length) * 100 : 0}%` }} />
                    </div>
                  </div>
                  {lines.map(renderLine)}
                </div>
              )
            })
        )}
      </>
    )

    const sidebarNavBtn = (active: boolean, onClick: () => void, label: React.ReactNode) => (
      <button onClick={onClick}
        className={`w-full text-left px-3 py-2 rounded-[8px] text-[13px] transition-colors ${active ? 'bg-ink text-paper font-medium' : 'text-ink-2 hover:bg-bg-2'}`}>
        {label}
      </button>
    )

    return (
      <div>
        {toast && <Toast msg={toast} onDone={() => setToast(null)} />}

        {editingItemId && (
          <InventoryItemDrawer
            itemId={editingItemId}
            onClose={() => setEditingItemId(null)}
            onUpdated={async () => {
              if (active) {
                const refreshed = await loadSession(active.id)
                if (refreshed) setActive(refreshed)
              }
            }}
          />
        )}

        {/* ── Mobile header — area · category + live progress ────────────────── */}
        <div className="md:hidden sticky top-0 z-20 bg-paper border-b border-line -mx-4 px-4 pt-2.5 pb-2">
          <div className="flex items-center gap-1.5">
            <button onClick={backFromCount} className="-ml-1 p-1 text-ink-3 active:text-ink"><ArrowLeft size={20} /></button>
            <div className="flex-1 min-w-0">
              <span className="text-[14px] font-semibold text-ink tracking-[-0.01em] truncate block">
                {active.label}{catFilter && <span className="text-ink-3 font-normal"> · {catFilter}</span>}
              </span>
            </div>
            {isOffline ? (
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-gold-soft text-gold-2 font-mono text-[10px] font-semibold shrink-0" title={`${pendingCount} change${pendingCount !== 1 ? 's' : ''} pending`}>
                <WifiOff size={11} /> {pendingCount}
              </span>
            ) : offlineSyncing ? (
              <RefreshCw size={14} className="text-gold-2 animate-spin shrink-0" />
            ) : null}
            <button onClick={handleSync} disabled={syncing} title="Sync" className="p-1.5 text-ink-3 active:text-ink shrink-0 disabled:opacity-50">
              <RefreshCw size={16} className={syncing ? 'animate-spin' : ''} />
            </button>
            <button onClick={openAddItem} title="Add item" className="p-1.5 text-ink-3 active:text-ink shrink-0">
              <Plus size={16} />
            </button>
          </div>
          <div className="flex items-center justify-between mt-1 font-mono text-[10.5px]">
            <span className="text-ink-3"><b className="text-ink font-semibold">{counted}</b> of {total} counted · {total > 0 ? Math.round((counted / total) * 100) : 0}%</span>
            <span className="text-gold-2 font-medium">{Math.max(0, total - counted)} left</span>
          </div>
          <div className="h-1 bg-bg-2 rounded-full mt-1.5 overflow-hidden">
            <div className="h-full bg-gold rounded-full transition-all duration-300" style={{ width: `${total > 0 ? (counted / total) * 100 : 0}%` }} />
          </div>
        </div>

        {/* ── Sticky top bar (desktop) ───────────────────────────────────────── */}
        <div className="hidden md:flex sticky top-0 z-20 bg-paper border-b border-line py-3 items-center gap-3 -mx-8 px-8">
          <button onClick={backFromCount} className="-ml-1 p-1 text-ink-3 hover:text-ink transition-colors">
            <ArrowLeft size={20} />
          </button>
          <div className="flex-1 min-w-0">
            <span className="text-[13.5px] font-medium text-ink tracking-[-0.01em] truncate block">{active.label}</span>
            <span className="font-mono text-[10.5px] text-ink-3">{active.countedBy} · {fmtDate(active.sessionDate)}</span>
          </div>
          <span className="shrink-0 bg-bg-2 text-ink-2 border border-line rounded-full px-3 py-1 font-mono text-[11px] whitespace-nowrap">
            {counted} / {total}
          </span>
          <button
            onClick={handleSync}
            disabled={syncing}
            title="Sync with inventory — adds items created after this session started"
            className="shrink-0 flex items-center gap-1.5 border border-line text-ink-2 font-mono text-[11px] px-3 py-1.5 rounded-[8px] hover:border-ink-3 whitespace-nowrap disabled:opacity-50 transition-colors"
          >
            <RefreshCw size={13} className={syncing ? 'animate-spin' : ''} />
            Sync
          </button>
          <button
            onClick={openAddItem}
            className="shrink-0 flex items-center gap-1.5 border border-line text-ink-2 font-mono text-[11px] px-3 py-1.5 rounded-[8px] hover:border-ink-3 whitespace-nowrap transition-colors"
          >
            <Plus size={13} />
            Add item
          </button>
          <button
            onClick={() => setView('review')}
            className="shrink-0 bg-ink text-paper text-[12.5px] font-medium px-3 py-1.5 rounded-[8px] hover:bg-ink-2 whitespace-nowrap transition-colors"
          >
            Review &amp; finish
          </button>
        </div>

        {/* ── Add Item Modal ─────────────────────────────────────────────────── */}
        {showAddItem && (
          <div
            className="fixed inset-0 z-50 flex items-start justify-center p-4 overflow-y-auto"
            onMouseDown={(e) => { (e.currentTarget as HTMLElement).dataset.mdown = String(e.target === e.currentTarget) }}
            onClick={(e) => { if (e.target === e.currentTarget && (e.currentTarget as HTMLElement).dataset.mdown === 'true') setShowAddItem(false) }}
          >
            <div className="absolute inset-0 bg-black/30" />
            <div className="relative bg-white rounded-xl p-6 w-full max-w-lg shadow-xl my-8" onClick={e => e.stopPropagation()}>
              <h3 className="font-semibold mb-4 text-lg">Add Inventory Item</h3>
              <form onSubmit={handleAddItem} className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2">
                    <label className="block text-xs font-medium text-gray-600 mb-1">Item Name *</label>
                    <input required value={addItemForm.itemName} onChange={e => setAddItemForm(f => ({ ...f, itemName: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Category</label>
                    <select value={addItemForm.category} onChange={e => setAddItemForm(f => ({ ...f, category: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold">
                      {addItemCategories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Supplier</label>
                    <select value={addItemForm.supplierId} onChange={e => setAddItemForm(f => ({ ...f, supplierId: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold">
                      <option value="">None</option>
                      {addItemSuppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Storage Area</label>
                    <select value={addItemForm.storageAreaId} onChange={e => setAddItemForm(f => ({ ...f, storageAreaId: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold">
                      <option value="">None</option>
                      {addItemAreas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Purchase Unit</label>
                    <select required value={addItemForm.purchaseUnit} onChange={e => setAddItemForm(f => ({ ...f, purchaseUnit: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold bg-white">
                      {PURCHASE_UNITS.map(u => <option key={u}>{u}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Qty per Purchase Unit</label>
                    <input type="number" required value={addItemForm.qtyPerPurchaseUnit} onChange={e => setAddItemForm(f => ({ ...f, qtyPerPurchaseUnit: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" step="any" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Purchase Price ($)</label>
                    <input type="number" required value={addItemForm.purchasePrice} onChange={e => setAddItemForm(f => ({ ...f, purchasePrice: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" step="any" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Base Unit</label>
                    <select value={addItemForm.baseUnit} onChange={e => setAddItemForm(f => ({ ...f, baseUnit: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold">
                      {BASE_UNITS.map(u => <option key={u}>{u}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Conversion Factor</label>
                    <input type="number" required value={addItemForm.conversionFactor} onChange={e => setAddItemForm(f => ({ ...f, conversionFactor: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" step="any" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Stock On Hand</label>
                    <input type="number" value={addItemForm.stockOnHand} onChange={e => setAddItemForm(f => ({ ...f, stockOnHand: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" step="any" />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs font-medium text-gray-600 mb-1">Location</label>
                    <input value={addItemForm.location} onChange={e => setAddItemForm(f => ({ ...f, location: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                  </div>
                </div>
                <div className="bg-gold/10 rounded-lg p-3 text-sm">
                  <span className="text-gold font-medium">Price per base unit preview: </span>
                  <span className="font-bold text-gold">{formatUnitPrice(addItemPricePreview)} / {addItemForm.baseUnit}</span>
                </div>
                <div className="flex gap-2 pt-2">
                  <button type="button" onClick={() => setShowAddItem(false)} className="flex-1 border border-gray-200 rounded-lg py-2 text-sm hover:bg-gray-50">Cancel</button>
                  <button type="submit" disabled={addItemSaving} className="flex-1 bg-gold text-white rounded-lg py-2 text-sm hover:bg-[#a88930] disabled:opacity-60">
                    {addItemSaving ? 'Adding…' : 'Add Item'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* ── Progress bar (desktop; mobile has it in the header) ────────────── */}
        <div className="hidden md:block h-1 bg-line -mx-4 sm:-mx-6 md:-mx-8">
          <div
            className="h-1 bg-gold transition-all duration-300"
            style={{ width: `${total > 0 ? (counted / total) * 100 : 0}%` }}
          />
        </div>

        {/* ── Offline banner (desktop; mobile shows it compactly in the header) ── */}
        {(isOffline || offlineSyncing) && (
          <div className={`hidden md:flex items-center gap-2 px-4 py-2 font-mono text-[11px] font-medium ${
            offlineSyncing ? 'bg-gold-soft text-gold-2' : 'bg-[#fffbeb] text-[#78350f]'
          }`}>
            <WifiOff size={13} className="shrink-0" />
            {offlineSyncing
              ? 'Syncing offline changes…'
              : `Offline — counts are saved locally${pendingCount > 0 ? ` (${pendingCount} pending)` : ''}`}
          </div>
        )}

        {/* ── Search bar ─────────────────────────────────────────────────────── */}
        <div className="md:sticky md:top-[57px] z-10 bg-paper border-b border-line py-2 -mx-4 sm:-mx-6 md:-mx-8 px-4 sm:px-6 md:px-8">
          <div className="relative max-w-lg">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" />
            <input
              type="text"
              placeholder="Search items…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleScan(searchQuery) }}
              className="w-full pl-8 pr-8 py-2 text-[13px] text-ink bg-bg-2 border border-line rounded-[9px] placeholder:text-ink-4 focus:outline-none focus:border-ink-3 focus:bg-paper transition-colors"
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-4 hover:text-ink-2">
                <X size={14} />
              </button>
            )}
          </div>
        </div>

        {/* ════════════════════════════════════════
            DESKTOP LAYOUT — sidebar + items
        ════════════════════════════════════════ */}
        <div className="hidden md:grid grid-cols-[220px_1fr] gap-6 pt-4 pb-8">
          {/* ── Left sidebar ─────────────────────────────────────────── */}
          <div className="sticky top-[57px] self-start space-y-5 max-h-[calc(100vh-80px)] overflow-y-auto pb-4 pr-1">

            {/* Progress summary */}
            <div className="bg-paper rounded-xl border border-line p-3 space-y-2">
              <div className="flex justify-between items-center">
                <span className="font-mono text-[10.5px] text-ink-3 tracking-wide">PROGRESS</span>
                <span className="font-mono text-[11px] text-ink-2">{counted}/{total} · {total > 0 ? Math.round((counted/total)*100) : 0}%</span>
              </div>
              <div className="h-1.5 bg-bg-2 rounded-full">
                <div className="h-1.5 bg-gold rounded-full transition-all duration-300"
                  style={{ width: `${total > 0 ? (counted/total)*100 : 0}%` }} />
              </div>
              <div className="grid grid-cols-2 gap-1 pt-1 font-mono text-[10.5px] text-ink-3">
                <span>{active.lines?.filter(l => l.countedQty !== null && !l.skipped).length ?? 0} counted</span>
                <span>{active.lines?.filter(l => l.skipped).length ?? 0} skipped</span>
              </div>
            </div>

            {/* Category filter */}
            <div>
              <p className="font-mono text-[10px] text-ink-4 uppercase tracking-[0.06em] mb-1.5 px-1">Category</p>
              <div className="space-y-0.5">
                {sidebarNavBtn(catFilter === null, () => setCatFilter(null),
                  <span className="flex items-center justify-between">All items <span className="font-mono text-[11px] opacity-50">{active.lines?.length ?? 0}</span></span>
                )}
                {categories.map(([cat, n]) =>
                  sidebarNavBtn(catFilter === cat, () => setCatFilter(catFilter === cat ? null : cat),
                    <span className="flex items-center justify-between">{cat} <span className="font-mono text-[11px] opacity-50">{n}</span></span>
                  )
                )}
              </div>
            </div>

            {/* Location filter */}
            {locations.length > 0 && (
              <div>
                <p className="font-mono text-[10px] text-ink-4 uppercase tracking-[0.06em] mb-1.5 px-1">Location</p>
                <div className="space-y-0.5">
                  {sidebarNavBtn(locFilter === null, () => setLocFilter(null), 'All locations')}
                  {locations.map(loc => sidebarNavBtn(locFilter === loc.id, () => setLocFilter(locFilter === loc.id ? null : loc.id), loc.name))}
                </div>
              </div>
            )}

            {/* Status filter */}
            <div>
              <p className="font-mono text-[10px] text-ink-4 uppercase tracking-[0.06em] mb-1.5 px-1">Status</p>
              <div className="space-y-0.5">
                {(['all', 'uncounted', 'counted', 'skipped'] as const).map(f =>
                  sidebarNavBtn(statusFilter === f, () => setStatusFilter(f),
                    f === 'all' ? 'All' : f === 'uncounted' ? 'Uncounted' : f === 'counted' ? 'Counted' : 'Skipped'
                  )
                )}
              </div>
            </div>

            {/* Clear filters */}
            {(catFilter || locFilter || statusFilter !== 'all') && (
              <button
                onClick={() => { setCatFilter(null); setLocFilter(null); setStatusFilter('all') }}
                className="w-full font-mono text-[11px] text-ink-3 hover:text-ink-2 py-1.5 border border-line rounded-[8px] transition-colors"
              >
                Clear filters
              </button>
            )}
          </div>

          {/* ── Right: item list ─────────────────────────────────────── */}
          <div className="pt-1">
            {DesktopItems()}
          </div>
        </div>

        {/* ════════════════════════════════════════
            MOBILE LAYOUT
        ════════════════════════════════════════ */}
        {/* ── Mobile: category chips + uncounted toggle ──────────────────────── */}
        <div className="md:hidden">
          <div className="flex gap-1.5 overflow-x-auto pt-2 pb-1 -mx-4 px-4 [&::-webkit-scrollbar]:hidden">
            {(() => {
              const allDone = (active.lines ?? []).filter(l => l.countedQty !== null || l.skipped).length
              return (
                <button onClick={() => setCatFilter(null)}
                  className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12.5px] font-medium border whitespace-nowrap transition-colors ${catFilter === null ? 'bg-ink text-paper border-ink' : 'bg-paper text-ink-2 border-line'}`}>
                  All <span className={`font-mono text-[10.5px] ${catFilter === null ? 'text-paper/60' : 'text-ink-4'}`}>{allDone}/{(active.lines ?? []).length}</span>
                </button>
              )
            })()}
            {categories.map(([cat, total]) => {
              const done = (active.lines ?? []).filter(l => l.inventoryItem.category === cat && (l.countedQty !== null || l.skipped)).length
              return (
                <button key={cat} onClick={() => setCatFilter(catFilter === cat ? null : cat)}
                  className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12.5px] font-medium border whitespace-nowrap transition-colors ${catFilter === cat ? 'bg-ink text-paper border-ink' : 'bg-paper text-ink-2 border-line'}`}>
                  {cat} <span className={`font-mono text-[10.5px] ${catFilter === cat ? 'text-paper/60' : 'text-ink-4'}`}>{done}/{total}</span>
                </button>
              )
            })}
          </div>
          <div className="flex items-center justify-between py-1.5">
            <span className="font-mono text-[10.5px] text-ink-3 uppercase tracking-[0.04em]">
              {filteredLines.length} items{catFilter ? ` · ${catFilter}` : ''}
            </span>
            <button onClick={() => setStatusFilter(statusFilter === 'uncounted' ? 'all' : 'uncounted')}
              className="inline-flex items-center gap-1.5 font-mono text-[11px] text-ink-2 active:opacity-70">
              <span className={`w-3.5 h-3.5 rounded-full border grid place-items-center transition-colors ${statusFilter === 'uncounted' ? 'bg-gold border-gold' : 'border-line bg-paper'}`}>
                {statusFilter === 'uncounted' && <Check size={9} className="text-white" />}
              </span>
              Uncounted only
            </button>
          </div>
        </div>

        {/* ── Mobile filter bottom sheet ──────────────────────────────────────── */}
        {showCountFilterSheet && (
          <div
            className="fixed inset-0 z-50 flex items-end md:hidden"
            onMouseDown={(e) => { (e.currentTarget as HTMLElement).dataset.mdown = String(e.target === e.currentTarget) }}
            onClick={(e) => { if (e.target === e.currentTarget && (e.currentTarget as HTMLElement).dataset.mdown === 'true') setShowCountFilterSheet(false) }}
          >
            <div className="absolute inset-0 bg-black/40" />
            <div className="relative bg-paper w-full rounded-t-2xl p-5 pb-8" onClick={e => e.stopPropagation()}>
              <div className="w-9 h-1 bg-line rounded-full mx-auto mb-4" />
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-[15px] text-ink tracking-[-0.02em]">Filter</h3>
                <button onClick={() => setShowCountFilterSheet(false)}><X size={18} className="text-ink-4" /></button>
              </div>
              <div className="space-y-4">
                <div>
                  <div className="font-mono text-[10px] text-ink-4 uppercase tracking-[0.06em] mb-2">Category</div>
                  <div className="flex flex-wrap gap-2">
                    <button onClick={() => setCatFilter(null)}
                      className={`px-3 py-1.5 rounded-full text-[13px] border transition-colors ${catFilter === null ? 'bg-ink text-paper border-ink' : 'bg-paper text-ink-2 border-line'}`}
                    >All</button>
                    {categories.map(([cat, total]) => {
                      const done = (active.lines ?? []).filter(l => l.inventoryItem.category === cat && (l.countedQty !== null || l.skipped)).length
                      return (
                        <button key={cat} onClick={() => setCatFilter(cat)}
                          className={`px-3 py-1.5 rounded-full text-[13px] border transition-colors ${catFilter === cat ? 'bg-ink text-paper border-ink' : 'bg-paper text-ink-2 border-line'}`}
                        >{cat} <span className={`font-mono text-[11px] ${catFilter === cat ? 'text-paper/60' : 'text-ink-4'}`}>{done}/{total}</span></button>
                      )
                    })}
                  </div>
                </div>
                {locations.length > 0 && (
                  <div>
                    <div className="font-mono text-[10px] text-ink-4 uppercase tracking-[0.06em] mb-2">Location</div>
                    <div className="flex flex-wrap gap-2">
                      <button onClick={() => setLocFilter(null)}
                        className={`px-3 py-1.5 rounded-full text-[13px] border transition-colors ${locFilter === null ? 'bg-ink text-paper border-ink' : 'bg-paper text-ink-2 border-line'}`}
                      >All</button>
                      {locations.map(loc => (
                        <button key={loc.id} onClick={() => setLocFilter(locFilter === loc.id ? null : loc.id)}
                          className={`px-3 py-1.5 rounded-full text-[13px] border transition-colors ${locFilter === loc.id ? 'bg-ink text-paper border-ink' : 'bg-paper text-ink-2 border-line'}`}
                        >{loc.name}</button>
                      ))}
                    </div>
                  </div>
                )}
                <button
                  onClick={() => { setCatFilter(null); setLocFilter(null); setShowCountFilterSheet(false) }}
                  className="w-full py-2.5 border border-line rounded-[10px] text-sm text-ink-2 font-medium"
                >Clear filters</button>
              </div>
            </div>
          </div>
        )}

        {/* ── Mobile items list ──────────────────────────────────────────────── */}
        <div className="md:hidden px-3 pt-1 pb-28 space-y-1.5">
          {(() => {
            const emptyMsg = searchQuery.trim()
              ? `NO MATCHES FOR “${searchQuery.trim()}”`
              : statusFilter === 'uncounted' ? 'ALL ITEMS COUNTED ✓' : 'NOTHING HERE'
            const MobileEmpty = () => <div className="font-mono text-[11px] text-ink-4 text-center py-16 tracking-[0.02em]">{emptyMsg}</div>
            return (catFilter || !grouped) ? (
            filteredLines.length === 0 ? <MobileEmpty /> : filteredLines.map(renderMobileLine)
          ) : (
            Object.keys(grouped).length === 0 ? <MobileEmpty /> :
            Object.entries(grouped)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([cat, lines]) => {
                const catDone = lines.filter(l => l.countedQty !== null || l.skipped).length
                return (
                  <div key={`mc-${cat}`}>
                    <div className="flex items-center gap-2 py-2 px-1">
                      <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-3">{cat}</span>
                      <span className="font-mono text-[10.5px] text-ink-4">{catDone}/{lines.length}</span>
                      <div className="flex-1 max-w-[60px] h-1 bg-bg-2 rounded-full">
                        <div className="h-1 bg-gold rounded-full"
                          style={{ width: `${lines.length > 0 ? (catDone / lines.length) * 100 : 0}%` }} />
                      </div>
                    </div>
                    {lines.map(renderMobileLine)}
                  </div>
                )
              })
          )
          })()}
        </div>

        {/* ── Mobile finalize bar — adaptive: jump-to-uncounted while counting, finalize when done ─ */}
        <div className="md:hidden fixed bottom-20 inset-x-3 z-30">
          {counted < total ? (
            <div className="flex items-center gap-2.5">
              <button
                onClick={() => { setStatusFilter('uncounted'); setCatFilter(null); setSearchQuery(''); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
                className="flex-1 h-12 rounded-[14px] bg-paper border border-line shadow-lg flex items-center justify-center gap-2 font-medium text-[13px] text-ink-2 active:bg-bg-2">
                <span className="w-1.5 h-1.5 rounded-full bg-gold" /> {total - counted} left to count
              </button>
              <button onClick={() => setView('review')} title="Review &amp; finish"
                className="w-12 h-12 rounded-[14px] bg-ink grid place-items-center shadow-lg shrink-0 active:scale-95 transition-transform">
                <Check size={20} className="text-gold" />
              </button>
            </div>
          ) : (
            <button onClick={() => setView('review')}
              className="w-full h-12 bg-ink text-paper rounded-[14px] shadow-lg flex items-center justify-center gap-2 font-semibold text-[14px] active:scale-[0.99] transition-transform">
              <Check size={16} className="text-gold" /> Finalize count · {total} items
            </button>
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
    const flagged      = lines.filter(l =>
      l.variancePct !== null &&
      hasReliableVariance(Number(l.expectedQty), l.selectedUom, l.inventoryItem) &&
      Math.abs(Number(l.variancePct)) > LARGE_VARIANCE_PCT
    )
    const totalValue   = countedLines.reduce((s, l) => {
      const base = convertCountQtyToBase(Number(l.countedQty), l.selectedUom, l.inventoryItem)
      return s + base * Number(l.priceAtCount)
    }, 0)
    const isFinalized  = active.status === 'FINALIZED'
    const sorted       = [...countedLines].sort(
      (a, b) => Math.abs(Number(b.varianceCost ?? 0)) - Math.abs(Number(a.varianceCost ?? 0))
    )

    return (
      <div className="max-w-4xl">
        {toast && <Toast msg={toast} onDone={() => setToast(null)} />}

        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={() => { if (isFinalized) { setView('list'); setActive(null) } else setView('count') }}
            className="-ml-1 p-1 text-ink-3 hover:text-ink transition-colors"
          >
            <ArrowLeft size={20} />
          </button>
          <div className="flex-1">
            <h1 className="text-[18px] font-semibold text-ink tracking-[-0.03em]">Review count</h1>
            <p className="font-mono text-[10.5px] text-ink-3 mt-0.5">{active.label} · {active.countedBy}</p>
          </div>
          {!isFinalized && (
            <button onClick={() => setView('count')} className="hidden md:block font-mono text-[11px] text-ink-3 hover:text-ink shrink-0">
              ← Back to counting
            </button>
          )}
        </div>

        {/* Stats — mobile compact strip */}
        <div className="flex md:hidden gap-2 mb-4">
          {[
            { val: countedLines.length.toString(),   label: 'Counted',  cls: 'bg-bg-2 text-ink'   },
            { val: flagged.length.toString(),         label: 'Flagged',  cls: flagged.length > 0 ? 'bg-amber-50 text-amber-700' : 'bg-bg-2 text-ink-3' },
            { val: formatCurrency(totalValue),        label: 'Value',    cls: 'bg-gold-soft text-gold-2' },
          ].map(s => (
            <div key={s.label} className={`flex-1 rounded-xl py-2 px-3 text-center ${s.cls}`}>
              <div className="text-base font-semibold leading-tight">{s.val}</div>
              <div className="font-mono text-[10px] mt-0.5 opacity-70">{s.label}</div>
            </div>
          ))}
        </div>

        {/* Stats — desktop */}
        <div className="hidden sm:grid grid-cols-3 gap-3 mb-6">
          {[
            { val: countedLines.length.toString(), label: 'Items counted' },
            { val: flagged.length.toString(), label: `Flagged (>${LARGE_VARIANCE_PCT}%)`, warn: flagged.length > 0 },
            { val: formatCurrency(totalValue), label: 'Total value' },
          ].map(s => (
            <div key={s.label} className="bg-paper border border-line rounded-xl p-4 text-center">
              <div className={`text-2xl font-semibold tracking-[-0.03em] ${(s as {warn?: boolean}).warn ? 'text-amber-600' : 'text-ink'}`}>{s.val}</div>
              <div className="font-mono text-[10.5px] text-ink-3 mt-1">{s.label}</div>
            </div>
          ))}
        </div>

        {/* Variance cards — mobile */}
        {sorted.length > 0 && (
          <div className="block md:hidden space-y-2 mb-24">
            {sorted.map(l => {
              const vPct     = Number(l.variancePct ?? 0)
              const vCost    = Number(l.varianceCost ?? 0)
              const reliable = hasReliableVariance(Number(l.expectedQty), l.selectedUom, l.inventoryItem)
              const large    = reliable && Math.abs(vPct) > LARGE_VARIANCE_PCT
              return (
                <div key={l.id} className="bg-paper rounded-xl border border-line overflow-hidden flex">
                  {large && <div className="w-1 shrink-0 bg-gold" />}
                  <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 px-3 py-2.5 border-b border-line">
                    {large && <AlertCircle size={13} className="text-gold shrink-0" />}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-ink truncate">{l.inventoryItem.itemName}</div>
                      <div className="font-mono text-[10.5px] text-ink-4">{l.inventoryItem.category}</div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 divide-x divide-line">
                    <div className="px-3 py-2">
                      <div className="font-mono text-[9.5px] text-ink-4 uppercase tracking-[0.06em] mb-0.5">Expected</div>
                      <div className="text-sm text-ink-2">{convertBaseToCountUom(Number(l.expectedQty), l.selectedUom, l.inventoryItem).toFixed(1)} {l.selectedUom}</div>
                    </div>
                    <div className="px-3 py-2">
                      <div className="font-mono text-[9.5px] text-ink-4 uppercase tracking-[0.06em] mb-0.5">Counted</div>
                      <div className="text-sm font-semibold text-ink">{Number(l.countedQty).toFixed(1)} {l.selectedUom}</div>
                    </div>
                    <div className="px-3 py-2 border-t border-line">
                      <div className="font-mono text-[9.5px] text-ink-4 uppercase tracking-[0.06em] mb-0.5">Variance</div>
                      <div className={`text-sm font-semibold ${reliable ? varColor(vPct) : 'text-ink-4'}`}>
                        {reliable ? `${vPct >= 0 ? '+' : ''}${vPct.toFixed(1)}%` : '—'}
                      </div>
                    </div>
                    <div className="px-3 py-2 border-t border-line">
                      <div className="font-mono text-[9.5px] text-ink-4 uppercase tracking-[0.06em] mb-0.5">Cost impact</div>
                      <div className={`text-sm font-semibold ${vCost >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {vCost >= 0 ? '+' : ''}{formatCurrency(vCost)}
                      </div>
                    </div>
                  </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Variance table — desktop */}
        {sorted.length > 0 && (
          <div className="hidden md:block bg-paper rounded-xl border border-line overflow-hidden mb-6">
            <div className="px-4 py-3 border-b border-line">
              <h2 className="font-mono text-[11px] text-ink-3 uppercase tracking-[0.06em]">Variance breakdown</h2>
            </div>
            <div className="divide-y divide-line">
              <div className="px-4 py-2 grid grid-cols-[1fr_80px_80px_70px_90px] gap-2 font-mono text-[10px] text-ink-4 uppercase tracking-[0.05em]">
                <span>Item</span>
                <span className="text-right">Expected</span>
                <span className="text-right">Counted</span>
                <span className="text-right">Var %</span>
                <span className="text-right">Cost impact</span>
              </div>
              {sorted.map(l => {
                const vPct     = Number(l.variancePct ?? 0)
                const vCost    = Number(l.varianceCost ?? 0)
                const reliable = hasReliableVariance(Number(l.expectedQty), l.selectedUom, l.inventoryItem)
                const large    = reliable && Math.abs(vPct) > LARGE_VARIANCE_PCT
                return (
                  <div key={l.id}
                    className={`px-4 py-2.5 grid grid-cols-[1fr_80px_80px_70px_90px] gap-2 items-center ${large ? 'bg-gold-soft/40' : ''}`}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        {large && <AlertCircle size={12} className="text-gold shrink-0" />}
                        <span className="text-[13px] text-ink truncate">{l.inventoryItem.itemName}</span>
                      </div>
                      <span className="font-mono text-[10.5px] text-ink-4">{l.inventoryItem.category}</span>
                    </div>
                    <span className="text-right text-[13px] text-ink-2">{convertBaseToCountUom(Number(l.expectedQty), l.selectedUom, l.inventoryItem).toFixed(1)} {l.selectedUom}</span>
                    <span className="text-right text-[13px] font-medium text-ink">{Number(l.countedQty).toFixed(1)} {l.selectedUom}</span>
                    <span className={`text-right text-[13px] font-semibold ${reliable ? varColor(vPct) : 'text-ink-4'}`}>
                      {reliable ? `${vPct >= 0 ? '+' : ''}${vPct.toFixed(1)}%` : '—'}
                    </span>
                    <span className={`text-right text-[13px] font-semibold ${vCost >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {vCost >= 0 ? '+' : ''}{formatCurrency(vCost)}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Footer — mobile fixed bar */}
        {!isFinalized && (
          <div className="fixed md:hidden bottom-20 inset-x-0 bg-paper border-t border-line px-4 py-3 z-30">
            <div className="flex gap-3">
              <button onClick={() => setView('count')}
                className="flex-1 py-3 border border-line rounded-[10px] text-[13px] font-medium text-ink-2"
              >
                ← Back
              </button>
              <button onClick={handleFinalize} disabled={finalizing}
                className="flex-[2] py-3 bg-ink text-paper rounded-[10px] text-[13px] font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50"
              >
                <Check size={15} className="text-gold" /> {finalizing ? 'Updating…' : 'Approve & update'}
              </button>
            </div>
          </div>
        )}

        {/* Footer — desktop */}
        {!isFinalized ? (
          <div className="hidden md:flex gap-3">
            <button onClick={() => setView('count')}
              className="flex-1 py-3 border border-line rounded-[10px] text-[13px] text-ink-2 hover:bg-bg-2 font-medium flex items-center justify-center gap-1.5 transition-colors"
            >
              <ArrowLeft size={16} /> Back to counting
            </button>
            <button onClick={handleFinalize} disabled={finalizing}
              className="flex-1 py-3 bg-ink text-paper rounded-[10px] text-[13px] font-semibold hover:bg-ink-2 disabled:opacity-50 flex items-center justify-center gap-1.5 transition-colors"
            >
              <Check size={16} className="text-gold" />
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
      className={`shrink-0 rounded-full px-3 py-1 font-mono text-[11px] font-medium transition-colors ${
        active ? 'bg-ink text-paper' : 'bg-bg-2 text-ink-2 hover:bg-line'
      }`}
    >
      {children}
    </button>
  )
}

function Empty() {
  return <div className="text-center py-12 font-mono text-[12px] text-ink-4">No items match this filter</div>
}
