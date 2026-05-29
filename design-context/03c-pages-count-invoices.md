# Fergie's OS — Pages — count, invoices, sales, wastage, variance, signals, pass

Stock count, invoices, sales, wastage, variance, signals, pass pages.


---

## `src/app/count/page.tsx`

```tsx
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
import { rcHex } from '@/lib/rc-colors'
import {
  enqueueCountMutation, flushCountQueue, loadCountQueue,
  saveCountSessionCache, pendingCountForSession,
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
  if (a <= 5)  return 'text-green-600'
  if (a <= 15) return 'text-amber-600'
  return 'text-red-600'
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
  const [catFilter,     setCatFilter]     = useState<string | null>(null)
  const [locFilter,     setLocFilter]     = useState<string | null>(null)
  const [statusFilter,  setStatusFilter]  = useState<'all' | 'uncounted' | 'counted' | 'skipped'>('all')
  const [showCountFilterSheet, setShowCountFilterSheet] = useState(false)
  const [searchQuery,   setSearchQuery]   = useState('')
  const [editingItemId, setEditingItemId] = useState<string | null>(null)

  // ── Storage areas (for partial count picker) ─────────────────────────────
  const [storageAreas, setStorageAreas] = useState<StorageArea[]>([])

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
    return fetch(`/api/count/sessions/${id}`).then(r => r.json()).catch(() => null)
  }, [])

  useEffect(() => { loadSessions() }, [loadSessions])
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
      // Refresh active session after sync so variances update
      if (active) {
        const refreshed = await loadSession(active.id)
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
    }
  }, [openId, active?.lines])

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
      if (q && !l.inventoryItem.itemName.toLowerCase().includes(q)) return false
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
    saveCountSessionCache(s.id, full)
    setPendingCount(pendingCountForSession(s.id))
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
        revenueCenterId: selectedRcId || undefined,
      }),
    })
    const session = await res.json()
    setForm({ label: '', countedBy: '', type: 'FULL', sessionDate: new Date().toISOString().slice(0, 10), areas: [] })
    setShowModal(false)
    await loadSessions()
    const full = await loadSession(session.id)
    if (full) {
      saveCountSessionCache(session.id, full)
      setPendingCount(0)
      setActive(full); setCatFilter(null); setLocFilter(null); setStatusFilter('all'); setOpenId(null); setView('count')
    }
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
      await fetch(`/api/count/sessions/${active!.id}/lines/${line.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectedUom: newUom }),
      })
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
      return
    }
    await fetch(`/api/count/sessions/${active!.id}/lines/${line.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skipped: true }),
    })
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

        {/* ── Header ── */}
        <div className="flex items-start justify-between mb-7 gap-6">
          <div>
            <p className="font-mono text-[10.5px] text-ink-3 tracking-wide mb-2">TODAY / COUNT</p>
            <h1 className="text-[36px] font-semibold tracking-[-0.04em] leading-none text-ink mb-1.5">Stock count</h1>
            <p className="text-[13.5px] text-ink-3 tracking-[-0.005em]">Track inventory accuracy and COGS by counting your stock regularly.</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-[9px] border border-line bg-paper text-ink-2 text-[13px] font-medium hover:border-ink-3 transition-colors whitespace-nowrap">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-ink-3"><path d="M3 5h18M3 12h18M3 19h12"/></svg>
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
            {/* ── KPI context strip ── */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
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

            {/* ── Filter chips ── */}
            <div className="flex flex-wrap gap-1.5 mb-3">
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

            {/* ── Search + filters ── */}
            <div className="flex gap-2 mb-3">
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

            <p className="font-mono text-[11px] text-ink-3 mb-3 tracking-wide">
              SHOWING {filteredSessions.length} OF {sessions.length} COUNT{sessions.length !== 1 ? 'S' : ''} · NEWEST FIRST
            </p>

            {/* ── Mobile list ── */}
            <div className="flex sm:hidden flex-col gap-2 mb-4">
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

            {/* ── Desktop table ── */}
            <div className="hidden sm:block bg-paper border border-line rounded-xl overflow-hidden mb-5">
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

            {/* ── Overdue callout ── */}
            {isOverdue && (
              <div className="flex items-center gap-5 bg-[#fffbeb] border border-[#fcd34d] rounded-xl px-[22px] py-[18px] mb-5">
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

            {/* ── Footer note ── */}
            <div className="flex justify-between font-mono text-[10.5px] text-ink-3 tracking-wide">
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
            className={`mx-4 mb-2 rounded-xl bg-green-50 border border-green-200 cursor-pointer ${large ? 'border-l-[3px] border-l-gold' : ''}`}
          >
            <div className="flex items-center gap-3 px-4 py-3">
              <CheckCircle2 size={18} className="text-green-600 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[13.5px] font-medium text-ink">{line.inventoryItem.itemName}</div>
                <div className="font-mono text-[11px] text-ink-3 mt-0.5 flex items-center gap-1.5">
                  <span>{Number(line.countedQty).toFixed(2)} {line.selectedUom}</span>
                  {vPct !== null && (
                    <span className={varColor(vPct)}>· {vPct >= 0 ? '+' : ''}{vPct.toFixed(1)}%</span>
                  )}
                </div>
              </div>
              <CategoryBadge category={line.inventoryItem.category} />
              {locLabel && <span className="font-mono text-[11px] text-ink-3 ml-1 hidden sm:block">{locLabel}</span>}
              <button
                onClick={e => { e.stopPropagation(); setEditingItemId(line.inventoryItemId) }}
                className="p-1.5 rounded-lg text-ink-4 hover:text-ink-2 hover:bg-green-100 ml-1"
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
            <span className="flex-1 text-[13.5px] font-medium text-ink">{line.inventoryItem.itemName}</span>
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
                            <option key={opt.label} value={opt.label}>{uomOptionLabel(opt, line.inventoryItem.baseUnit)}</option>
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
      const isOpen    = openId === line.id
      const isCounted = line.countedQty !== null && !line.skipped
      const isSkipped = line.skipped
      const locLabel  = line.inventoryItem.storageArea?.name ?? line.inventoryItem.location
      const subtitle  = [line.inventoryItem.category, locLabel].filter(Boolean).join(' · ')

      const inputBase2 = convertCountQtyToBase(inputQty, line.selectedUom, line.inventoryItem)
      const liveVar = isOpen && Number(line.expectedQty) > 0
        ? ((inputBase2 - Number(line.expectedQty)) / Number(line.expectedQty)) * 100
        : null

      const dotColor = isSkipped
        ? 'bg-ink-4'
        : isCounted
          ? (line.variancePct !== null && Math.abs(Number(line.variancePct)) > LARGE_VARIANCE_PCT ? 'bg-gold' : 'bg-green-500')
          : 'bg-ink-4'

      const rowBg = isSkipped
        ? 'bg-bg-2 border-line opacity-60'
        : isCounted
          ? (line.variancePct !== null && Math.abs(Number(line.variancePct)) > LARGE_VARIANCE_PCT
              ? 'bg-amber-50/60 border-amber-200'
              : 'bg-green-50/60 border-green-200')
          : isOpen
            ? 'border-2 border-gold bg-paper'
            : 'bg-paper border-line'

      return (
        <div key={`m-${line.id}`}
          ref={el => { cardRefs.current[`m-${line.id}`] = el }}
          className={`rounded-xl border ${rowBg} overflow-hidden`}
        >
          <div
            className="flex items-center gap-3 px-3 py-2.5 cursor-pointer"
            onClick={() => setOpenId(isOpen ? null : line.id)}
          >
            <div className={`w-2 h-2 rounded-full shrink-0 ${dotColor}`} />
            <div className="flex-1 min-w-0">
              <div className={`text-sm font-medium truncate ${isSkipped ? 'line-through text-ink-4' : 'text-ink'}`}>
                {line.inventoryItem.itemName}
              </div>
              {subtitle && <div className="font-mono text-[10.5px] text-ink-4 mt-0.5">{subtitle}</div>}
            </div>
            <button
              onClick={e => { e.stopPropagation(); setEditingItemId(line.inventoryItemId) }}
              className="p-1.5 rounded-[8px] text-ink-4 hover:text-ink-2 hover:bg-bg-2 shrink-0"
              title="Edit item"
            >
              <Pencil size={13} />
            </button>
            <div className="text-right shrink-0">
              {isSkipped ? (
                <button
                  onClick={e => { e.stopPropagation(); unskipLine(line) }}
                  className="font-mono text-[11px] text-gold font-medium px-2 py-1 rounded-[6px] hover:bg-gold-soft"
                >
                  Count it
                </button>
              ) : isCounted ? (
                <>
                  <div className="text-sm font-semibold text-ink">
                    {Number(line.countedQty).toFixed(1)} {line.selectedUom}
                  </div>
                  {line.variancePct !== null && (
                    <div className={`text-xs ${varColor(line.variancePct)}`}>
                      {Number(line.variancePct) >= 0 ? '+' : ''}{Number(line.variancePct).toFixed(1)}%
                    </div>
                  )}
                </>
              ) : (
                <span className="font-mono text-[11px] text-ink-4">— —</span>
              )}
            </div>
          </div>

          {isOpen && (
            <div className="px-3 pb-3 pt-1 border-t border-line">
              {/* UOM selector + expected */}
              {(() => {
                const uoms = getCountableUoms(line.inventoryItem)
                const expectedDisplay = convertBaseToCountUom(Number(line.expectedQty), line.selectedUom, line.inventoryItem)
                return (
                  <>
                    {uoms.length > 1 && (
                      <div className="mb-2">
                        <select
                          value={line.selectedUom}
                          onChange={e => changeUom(line, e.target.value)}
                          className="w-full border border-line rounded-[9px] px-3 py-2 text-[13px] font-medium text-ink bg-paper focus:outline-none focus:border-gold"
                        >
                          {uoms.map(opt => (
                            <option key={opt.label} value={opt.label}>{uomOptionLabel(opt, line.inventoryItem.baseUnit)}</option>
                          ))}
                        </select>
                      </div>
                    )}
                    <div className="font-mono text-[10.5px] text-ink-3 mb-1.5 flex items-center gap-1.5">
                      <span>Expected: {expectedDisplay.toFixed(2)} {line.selectedUom}</span>
                      {liveVar !== null && (
                        <span className={`font-medium ${varColor(liveVar)}`}>
                          · {liveVar > 0 ? '+' : ''}{liveVar.toFixed(1)}%
                        </span>
                      )}
                    </div>
                    {(line.inventoryItem.parLevel != null || line.inventoryItem.lastCountQty != null) && (
                      <div className="font-mono text-[10.5px] text-ink-4 mb-2 flex flex-wrap items-center gap-x-3">
                        {line.inventoryItem.parLevel != null && (
                          <span>Par: <span className="font-medium text-ink-2">{Number(line.inventoryItem.parLevel).toFixed(2)} {line.selectedUom}</span></span>
                        )}
                        {line.inventoryItem.lastCountQty != null && (
                          <span>Last: <span className="font-medium text-ink-2">{convertBaseToCountUom(Number(line.inventoryItem.lastCountQty), line.selectedUom, line.inventoryItem).toFixed(2)} {line.selectedUom}</span></span>
                        )}
                      </div>
                    )}
                  </>
                )
              })()}
              <div className="flex items-center gap-2 mb-2">
                <button
                  onClick={() => setInputQty(v => Math.max(0, Math.round((v - 1) * 100) / 100))}
                  className="w-12 h-12 rounded-[10px] bg-bg-2 border border-line flex items-center justify-center shrink-0"
                >
                  <Minus size={18} className="text-ink-2" />
                </button>
                <input
                  type="number"
                  value={inputQty}
                  onChange={e => setInputQty(parseFloat(e.target.value) || 0)}
                  className="flex-1 min-w-0 h-12 text-center text-2xl font-bold border-2 border-gold rounded-[10px] focus:outline-none text-ink"
                  min={0} step={0.1}
                />
                <button
                  onClick={() => setInputQty(v => Math.round((v + 1) * 100) / 100)}
                  className="w-12 h-12 rounded-[10px] bg-bg-2 border border-line flex items-center justify-center shrink-0"
                >
                  <Plus size={18} className="text-ink-2" />
                </button>
              </div>
              <div className="text-center font-mono text-[11px] text-ink-3 mb-3">{line.selectedUom}</div>
              <div className="flex gap-2">
                <button
                  onClick={() => confirmLine(line, inputQty)}
                  className="flex-1 h-11 bg-ink text-paper rounded-[10px] font-semibold text-sm flex items-center justify-center gap-1.5"
                >
                  <Check size={15} className="text-gold" /> Confirm
                </button>
                <button
                  onClick={() => confirmLine(line, 0)}
                  className="px-3 h-11 border border-amber-200 bg-amber-50 text-amber-700 rounded-[10px] text-xs font-semibold"
                  title="Mark out of stock"
                >
                  Out of stock
                </button>
                <button
                  onClick={() => skipLine(line)}
                  className="px-4 h-11 border border-line rounded-[10px] text-sm text-ink-3 flex items-center gap-1.5"
                >
                  <SkipForward size={13} /> Skip
                </button>
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

        {/* ── Sticky top bar ─────────────────────────────────────────────────── */}
        <div className="sticky top-0 z-20 bg-paper border-b border-line px-4 py-3 flex items-center gap-3 -mx-4 sm:-mx-6 md:-mx-8 px-4 sm:px-6 md:px-8">
          <button onClick={backFromCount} className="-ml-1 p-1 text-ink-3 hover:text-ink transition-colors">
            <ArrowLeft size={20} />
          </button>
          <div className="flex-1 min-w-0">
            <span className="text-[13.5px] font-medium text-ink tracking-[-0.01em] truncate block">{active.label}</span>
            <span className="font-mono text-[10.5px] text-ink-3 hidden md:block">{active.countedBy} · {fmtDate(active.sessionDate)}</span>
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
            <span className="hidden sm:inline">Sync</span>
          </button>
          <button
            onClick={openAddItem}
            className="shrink-0 flex items-center gap-1.5 border border-line text-ink-2 font-mono text-[11px] px-3 py-1.5 rounded-[8px] hover:border-ink-3 whitespace-nowrap transition-colors"
          >
            <Plus size={13} />
            <span className="hidden sm:inline">Add item</span>
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

        {/* ── Progress bar ───────────────────────────────────────────────────── */}
        <div className="h-1 bg-line -mx-4 sm:-mx-6 md:-mx-8">
          <div
            className="h-1 bg-gold transition-all duration-300"
            style={{ width: `${total > 0 ? (counted / total) * 100 : 0}%` }}
          />
        </div>

        {/* ── Offline banner ─────────────────────────────────────────────────── */}
        {(isOffline || offlineSyncing) && (
          <div className={`flex items-center gap-2 px-4 py-2 font-mono text-[11px] font-medium ${
            offlineSyncing ? 'bg-gold-soft text-gold-2' : 'bg-[#fffbeb] text-[#78350f]'
          }`}>
            <WifiOff size={13} className="shrink-0" />
            {offlineSyncing
              ? 'Syncing offline changes…'
              : `Offline — counts are saved locally${pendingCount > 0 ? ` (${pendingCount} pending)` : ''}`}
          </div>
        )}

        {/* ── Search bar ─────────────────────────────────────────────────────── */}
        <div className="sticky top-[57px] z-10 bg-paper border-b border-line px-4 py-2 -mx-4 sm:-mx-6 md:-mx-8 px-4 sm:px-6 md:px-8">
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
        {/* ── Mobile filter row ──────────────────────────────────────────────── */}
        <div className="flex md:hidden items-center gap-2 px-3 pt-2 pb-1.5">
          {(['all', 'uncounted', 'counted', 'skipped'] as const).map(f => (
            <Pill key={f} active={statusFilter === f} onClick={() => setStatusFilter(f)}>
              {f === 'all' ? 'All' : f === 'uncounted' ? 'Uncounted' : f === 'counted' ? 'Counted' : 'Skipped'}
            </Pill>
          ))}
          <div className="flex-1" />
          <button
            onClick={() => setShowCountFilterSheet(true)}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
              catFilter || locFilter
                ? 'bg-gold/10 text-gold border-gold/30'
                : 'bg-paper text-ink-2 border-line'
            }`}
          >
            Filter{(catFilter ? 1 : 0) + (locFilter ? 1 : 0) > 0 && ` · ${(catFilter ? 1 : 0) + (locFilter ? 1 : 0)}`}
          </button>
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
                    {categories.map(([cat]) => (
                      <button key={cat} onClick={() => setCatFilter(cat)}
                        className={`px-3 py-1.5 rounded-full text-[13px] border transition-colors ${catFilter === cat ? 'bg-ink text-paper border-ink' : 'bg-paper text-ink-2 border-line'}`}
                      >{cat}</button>
                    ))}
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
          {(catFilter || !grouped) ? (
            filteredLines.length === 0 ? <Empty /> : filteredLines.map(renderMobileLine)
          ) : (
            Object.keys(grouped).length === 0 ? <Empty /> :
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
            <button onClick={() => setView('count')} className="font-mono text-[11px] text-ink-3 hover:text-ink shrink-0">
              ← Back to counting
            </button>
          )}
        </div>

        {/* Stats — mobile compact strip */}
        <div className="flex sm:hidden gap-2 mb-4">
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
          <div className="block sm:hidden space-y-2 mb-24">
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
          <div className="hidden sm:block bg-paper rounded-xl border border-line overflow-hidden mb-6">
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
          <div className="fixed sm:hidden bottom-20 inset-x-0 bg-paper border-t border-line px-4 py-3 z-30">
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
          <div className="hidden sm:flex gap-3">
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

```


---

## `src/app/invoices/page.tsx`

```tsx
'use client'
import { useState, useCallback, useEffect, useRef } from 'react'
import dynamic from 'next/dynamic'
import { Mail, Clock } from 'lucide-react'
import { InvoiceKpiStripV2 } from '@/components/invoices/InvoiceKpiStripV2'
import { InvoiceListV2 } from '@/components/invoices/InvoiceListV2'
import { InboxViewV2 } from '@/components/invoices/InboxViewV2'
import { InboxSubNav } from '@/components/invoices/InboxSubNav'
import { PageHead } from '@/components/layout/PageHead'
import { SessionSummary, SessionStatus } from '@/components/invoices/types'
import { useRc } from '@/contexts/RevenueCenterContext'
import { useDrawer } from '@/contexts/DrawerContext'
import { useNotifications } from '@/contexts/NotificationContext'
import { isNative } from '@/lib/capacitor'
import { useNativeScan } from '@/hooks/useNativeScan'

const InvoiceDrawer = dynamic<{
  sessionId: string | null
  onClose: () => void
  onApproveOrReject: () => void
  onNavigate?: (id: string) => void
  allSessions?: SessionSummary[]
}>(
  () => import('@/components/invoices/v2/InvoiceReviewDrawer').then(m => ({ default: m.InvoiceReviewDrawer })),
  { ssr: false, loading: () => null }
)

const InvoiceUploadModal = dynamic(
  () => import('@/components/invoices/InvoiceUploadModal').then(m => ({ default: m.InvoiceUploadModal })),
  { ssr: false, loading: () => null }
)

export default function InvoicesPage() {
  const { activeRcId, activeRc } = useRc()
  const { setDrawerOpen } = useDrawer()
  const { push } = useNotifications()
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [showUpload, setShowUpload] = useState(false)
  const [kpiRefreshKey, setKpiRefreshKey] = useState(0)
  const [view, setView] = useState<'inbox' | 'history'>('inbox')

  // Track previous statuses to detect PROCESSING → REVIEW / APPROVING → APPROVED transitions
  const prevStatusesRef = useRef<Map<string, SessionStatus>>(new Map())

  useEffect(() => {
    setDrawerOpen(selectedSessionId !== null)
    return () => setDrawerOpen(false)
  }, [selectedSessionId, setDrawerOpen])

  const fetchSessions = useCallback(async () => {
    try {
      const p = new URLSearchParams()
      if (activeRcId) {
        p.set('rcId', activeRcId)
        if (activeRc?.isDefault) p.set('isDefault', 'true')
      }
      const qs = p.toString()
      const data: SessionSummary[] = await fetch(`/api/invoices/sessions${qs ? `?${qs}` : ''}`).then(r => r.json())

      // Detect PROCESSING → REVIEW and APPROVING → APPROVED transitions
      const prev = prevStatusesRef.current
      for (const s of data) {
        if (prev.get(s.id) === 'PROCESSING' && s.status === 'REVIEW') {
          const sid = s.id
          push({
            type: 'invoice_ready',
            sessionId: sid,
            supplierName: s.supplierName,
            invoiceNumber: s.invoiceNumber,
            actionLabel: 'Review',
            onAction: () => setSelectedSessionId(sid),
          })
        }
        if (prev.get(s.id) === 'APPROVING' && s.status === 'APPROVED') {
          const sid = s.id
          push({
            type: 'invoice_applied',
            sessionId: sid,
            supplierName: s.supplierName,
            invoiceNumber: s.invoiceNumber,
            actionLabel: 'View',
            onAction: () => setSelectedSessionId(sid),
          })
        }
      }

      // Update previous statuses map
      const next = new Map<string, SessionStatus>()
      for (const s of data) next.set(s.id, s.status)
      prevStatusesRef.current = next

      setSessions(data)
      return data
    } catch {
      // silent — keeps existing sessions on screen, polling continues
    }
  }, [activeRcId, activeRc, push])

  const handleScanComplete = useCallback(() => {
    fetchSessions()
  }, [fetchSessions])

  const { triggerScan, isScanning, scanError, clearError } = useNativeScan({
    activeRcId,
    onComplete: handleScanComplete,
  })

  useEffect(() => { fetchSessions() }, [fetchSessions])

  // Sequential poll via refs so the timer never resets mid-wait.
  // Using refs instead of state deps prevents the interval from being
  // cancelled and restarted on every sessions update (which caused the
  // timer to keep resetting before it could fire on Capacitor WebView).
  const fetchRef    = useRef(fetchSessions)
  const sessionsRef = useRef(sessions)
  fetchRef.current    = fetchSessions
  sessionsRef.current = sessions

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const schedule = () => {
      const hasTransient = sessionsRef.current.some(s =>
        s.status === 'UPLOADING' || s.status === 'PROCESSING' || s.status === 'APPROVING'
      )
      timer = setTimeout(async () => {
        await fetchRef.current()
        schedule()
      }, hasTransient ? 3000 : 15000)
    }
    schedule()
    return () => clearTimeout(timer)
  }, []) // runs once; uses refs for always-fresh values

  // Refresh whenever the tab regains focus (covers status changes made elsewhere)
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') fetchSessions() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [fetchSessions])

  const handleApproveOrReject = useCallback(() => {
    fetchSessions()
    setKpiRefreshKey(k => k + 1)
  }, [fetchSessions])

  const handleDelete = useCallback(async (id: string, _status: SessionStatus): Promise<void> => {
    await fetch(`/api/invoices/sessions/${id}`, { method: 'DELETE' })
    fetchSessions()
    setKpiRefreshKey(k => k + 1)
    if (selectedSessionId === id) setSelectedSessionId(null)
  }, [selectedSessionId, fetchSessions])

  const handleBulkDelete = useCallback(async (ids: string[]): Promise<void> => {
    await fetch('/api/invoices/sessions', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    })
    fetchSessions()
    setKpiRefreshKey(k => k + 1)
    if (selectedSessionId && ids.includes(selectedSessionId)) setSelectedSessionId(null)
  }, [selectedSessionId, fetchSessions])

  const handleRetry = useCallback(async (id: string) => {
    fetch(`/api/invoices/sessions/${id}/process`, { method: 'POST' }).catch(() => {})
    await fetchSessions()
  }, [fetchSessions])

  const queueCount = sessions.filter(s =>
    s.status === 'REVIEW' || s.status === 'PROCESSING' || s.status === 'UPLOADING' ||
    s.status === 'APPROVING' || s.status === 'ERROR'
  ).length

  return (
    <>
    <InboxSubNav />
    <div className="p-4 md:p-6 md:px-8 max-w-7xl mx-auto w-full">

      <PageHead
        crumbs={<><Mail size={12} /> INBOX / INVOICES</>}
        title="Invoices"
        sub={
          view === 'inbox'
            ? <>OCR → review → approve. <b>{queueCount}</b> {queueCount === 1 ? 'session' : 'sessions'} in queue.</>
            : <>All invoice sessions — sortable, searchable, filterable by status.</>
        }
        actions={
          <div className="inline-flex bg-paper border border-line rounded-[9px] p-[3px]">
            <button
              onClick={() => setView('inbox')}
              className={`font-mono text-[11px] px-3 py-1.5 rounded-[6px] tracking-[0.02em] uppercase transition-colors inline-flex items-center gap-1.5 ${
                view === 'inbox' ? 'bg-ink text-paper' : 'text-ink-3 hover:text-ink-2'
              }`}
            >
              <Mail size={11} className={view === 'inbox' ? 'text-gold' : ''} /> Inbox
              {queueCount > 0 && (
                <span className={`font-mono text-[10px] px-1.5 rounded-full leading-tight ${view === 'inbox' ? 'bg-gold text-ink' : 'bg-gold-soft text-gold-2'}`}>{queueCount}</span>
              )}
            </button>
            <button
              onClick={() => setView('history')}
              className={`font-mono text-[11px] px-3 py-1.5 rounded-[6px] tracking-[0.02em] uppercase transition-colors inline-flex items-center gap-1.5 ${
                view === 'history' ? 'bg-ink text-paper' : 'text-ink-3 hover:text-ink-2'
              }`}
            >
              <Clock size={11} className={view === 'history' ? 'text-gold' : ''} /> History
            </button>
          </div>
        }
      />

      <InvoiceKpiStripV2
        refreshKey={kpiRefreshKey}
        activeRcId={activeRcId}
        isDefault={activeRc?.isDefault ?? false}
      />

      {view === 'inbox' ? (
        <InboxViewV2
          sessions={sessions}
          onSelectSession={setSelectedSessionId}
          onUploadClick={() => setShowUpload(true)}
          onScanClick={isNative() ? triggerScan : undefined}
        />
      ) : (
        <InvoiceListV2
          sessions={sessions}
          onSelect={setSelectedSessionId}
          onUploadClick={() => setShowUpload(true)}
          onScanClick={isNative() ? triggerScan : undefined}
          onDelete={handleDelete}
          onBulkDelete={handleBulkDelete}
          onRetry={handleRetry}
        />
      )}
      {scanError && (
        <button
          onClick={clearError}
          className="fixed bottom-20 left-4 right-4 z-50 bg-red-600 text-white text-sm font-medium rounded-xl px-4 py-3 shadow-lg sm:hidden text-left w-auto"
        >
          {scanError} — tap to dismiss
        </button>
      )}
      {isScanning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 sm:hidden">
          <div className="bg-white rounded-2xl px-8 py-6 flex flex-col items-center gap-3 shadow-xl">
            <div className="w-10 h-10 border-4 border-gold border-t-transparent rounded-full animate-spin" />
            <p className="text-sm font-semibold text-gray-700">Processing scan…</p>
          </div>
        </div>
      )}
      <InvoiceDrawer
        sessionId={selectedSessionId}
        onClose={() => setSelectedSessionId(null)}
        onApproveOrReject={handleApproveOrReject}
        onNavigate={(id) => setSelectedSessionId(id)}
        allSessions={sessions}
      />
      {showUpload && (
        <InvoiceUploadModal
          activeRcId={activeRcId}
          onClose={() => setShowUpload(false)}
          onComplete={() => {
            fetchSessions()
            setShowUpload(false)
          }}
        />
      )}
    </div>
    </>
  )
}

```


---

## `src/app/invoices/exceptions/page.tsx`

```tsx
'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertCircle, Copy, ExternalLink } from 'lucide-react'
import { InboxSubNav } from '@/components/invoices/InboxSubNav'
import { PageHead } from '@/components/layout/PageHead'
import { formatCurrency } from '@/lib/utils'

interface UnmatchedRow {
  id: string
  rawItemName: string | null
  rawSize: string | null
  rawLineTotal: number | null
  createdAt: string
  session: { id: string; supplierName: string | null; invoiceNumber: string | null; invoiceDate: string | null }
}

interface DuplicateGroup {
  supplierName: string | null
  invoiceNumber: string | null
  invoiceDate: string | null
  sessions: Array<{ id: string; status: string; total: number | null; createdAt: string }>
}

interface ExceptionsData {
  unmatched: UnmatchedRow[]
  duplicates: DuplicateGroup[]
  totalCount: number
}

export default function ExceptionsPage() {
  const [data, setData] = useState<ExceptionsData | null>(null)

  useEffect(() => {
    fetch('/api/invoices/exceptions', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(json => json && setData(json))
  }, [])

  const unmatched = data?.unmatched ?? []
  const dupes = data?.duplicates ?? []

  return (
    <>
      <InboxSubNav />
      <div className="p-4 md:p-6 md:px-8 max-w-7xl mx-auto w-full">
        <PageHead
          crumbs={<span>INBOX / EXCEPTIONS</span>}
          title="Exceptions"
          sub={<>Invoice lines the matcher couldn&apos;t resolve, and duplicate invoices waiting for cleanup.</>}
        />

        {unmatched.length + dupes.length === 0 ? (
          <div className="bg-paper border border-line rounded-[12px] p-12 text-center">
            <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-green-text">All clean</p>
            <p className="text-[14px] text-ink-2 mt-2">No unmatched lines or duplicate sessions. Inbox is empty.</p>
          </div>
        ) : (
          <div className="space-y-5">
            {unmatched.length > 0 && (
              <section>
                <h2 className="font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3 mb-2">
                  Unmatched OCR lines · {unmatched.length}
                </h2>
                <div className="bg-paper border border-line rounded-[12px] overflow-hidden">
                  {unmatched.map(u => (
                    <Link
                      key={u.id}
                      href={`/invoices?session=${u.session.id}`}
                      className="grid grid-cols-[36px_1.4fr_1fr_auto_auto] items-center gap-3 px-[18px] py-3 border-b border-line last:border-0 hover:bg-bg-2/40 transition-colors"
                    >
                      <div className="w-9 h-9 rounded-[9px] bg-gold-soft text-gold-2 grid place-items-center shrink-0">
                        <AlertCircle size={15} />
                      </div>
                      <div className="min-w-0">
                        <div className="text-[14px] font-medium text-ink tracking-[-0.01em] truncate">{u.rawItemName ?? '—'}</div>
                        <div className="font-mono text-[10.5px] text-ink-3 mt-0.5">
                          {u.session.supplierName ?? '—'} · {u.session.invoiceNumber ?? '—'} · {fmtDate(u.session.invoiceDate ?? u.createdAt)}
                        </div>
                      </div>
                      <div className="font-mono text-[12px] text-ink-3">{u.rawSize ?? '—'}</div>
                      <div className="font-mono text-[13px] text-ink font-medium tabular-nums">
                        {u.rawLineTotal !== null ? formatCurrency(u.rawLineTotal) : '—'}
                      </div>
                      <div className="font-mono text-[11px] text-gold-2 inline-flex items-center gap-1">
                        Match <ExternalLink size={11} />
                      </div>
                    </Link>
                  ))}
                </div>
              </section>
            )}

            {dupes.length > 0 && (
              <section>
                <h2 className="font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3 mb-2">
                  Duplicate invoices · {dupes.length} {dupes.length === 1 ? 'group' : 'groups'}
                </h2>
                <div className="bg-paper border border-line rounded-[12px] overflow-hidden">
                  {dupes.map((g, idx) => (
                    <div key={idx} className="px-[18px] py-3.5 border-b border-line last:border-0">
                      <div className="flex items-start gap-3">
                        <div className="w-9 h-9 rounded-[9px] bg-red-soft text-red-text grid place-items-center shrink-0">
                          <Copy size={15} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-[14px] font-medium text-ink tracking-[-0.01em]">
                            {g.supplierName ?? '—'} · invoice <span className="font-mono">{g.invoiceNumber ?? '—'}</span>
                          </div>
                          <div className="font-mono text-[10.5px] text-ink-3 mt-0.5">
                            {fmtDate(g.invoiceDate ?? '')} · {g.sessions.length} sessions found
                          </div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {g.sessions.map(s => (
                              <Link key={s.id} href={`/invoices?session=${s.id}`}
                                className="inline-flex items-center gap-1.5 font-mono text-[11px] bg-bg-2 border border-line text-ink-2 px-2 py-1 rounded-[7px] hover:border-ink-3 transition-colors">
                                {s.status} · {s.total !== null ? formatCurrency(s.total) : '—'} <ExternalLink size={10} />
                              </Link>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </>
  )
}

function fmtDate(d: string): string {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

```


---

## `src/app/invoices/price-alerts/page.tsx`

```tsx
'use client'
import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { AlertTriangle, Check, ExternalLink } from 'lucide-react'
import { InboxSubNav } from '@/components/invoices/InboxSubNav'
import { PageHead } from '@/components/layout/PageHead'
import { formatCurrency } from '@/lib/utils'

interface PriceAlert {
  id: string
  inventoryItemId: string
  oldPrice: string | number | null
  newPrice: string | number | null
  changePct: string | number | null
  createdAt: string
  acknowledged: boolean
  inventoryItem: { id: string; itemName: string }
  session: { id: string; supplierName: string | null; invoiceDate: string | null }
}

interface RecipeAlert {
  id: string
  newFoodCostPct: string | number | null
  createdAt: string
  acknowledged: boolean
  recipe: { id: string; name: string; menuPrice: number | null }
  session: { id: string; supplierName: string | null }
}

interface AlertsData {
  priceAlerts: PriceAlert[]
  recipeAlerts: RecipeAlert[]
  totalUnread: number
}

export default function PriceAlertsPage() {
  const [data, setData] = useState<AlertsData | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const json: AlertsData = await fetch('/api/invoices/alerts', { cache: 'no-store' }).then(r => r.json())
      setData(json)
    } catch {}
  }, [])

  useEffect(() => { load() }, [load])

  const ackOne = async (kind: 'price' | 'recipe', id: string) => {
    setBusyId(id)
    try {
      await fetch('/api/invoices/alerts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(kind === 'price' ? { priceAlertIds: [id] } : { recipeAlertIds: [id] }),
      })
      await load()
    } finally { setBusyId(null) }
  }

  const ackAll = async () => {
    setBusyId('all')
    try {
      await fetch('/api/invoices/alerts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acknowledgeAll: true }),
      })
      await load()
    } finally { setBusyId(null) }
  }

  const priceAlerts  = data?.priceAlerts  ?? []
  const recipeAlerts = data?.recipeAlerts ?? []
  const total = priceAlerts.length + recipeAlerts.length

  return (
    <>
      <InboxSubNav />
      <div className="p-4 md:p-6 md:px-8 max-w-7xl mx-auto w-full">
        <PageHead
          crumbs={<span>INBOX / PRICE ALERTS</span>}
          title="Price alerts"
          sub={<>Items whose <b>pricePerBaseUnit</b> jumped after an invoice approval — and the recipes affected.</>}
          actions={
            total > 0 ? (
              <button onClick={ackAll} disabled={busyId === 'all'}
                className="inline-flex items-center gap-1.5 bg-ink text-paper px-4 py-[9px] rounded-[9px] text-[13px] font-medium hover:bg-[#18181b] disabled:opacity-50 transition-colors">
                <Check size={13} className="text-gold" /> Acknowledge all
              </button>
            ) : null
          }
        />

        {total === 0 ? (
          <div className="bg-paper border border-line rounded-[12px] p-12 text-center">
            <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-green-text">All clear</p>
            <p className="text-[14px] text-ink-2 mt-2">No active price alerts. Your spine is calm.</p>
          </div>
        ) : (
          <div className="space-y-5">
            {priceAlerts.length > 0 && (
              <section>
                <h2 className="font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3 mb-2">Ingredient price spikes · {priceAlerts.length}</h2>
                <div className="bg-paper border border-line rounded-[12px] overflow-hidden">
                  {priceAlerts.map(a => {
                    const old = a.oldPrice !== null ? Number(a.oldPrice) : null
                    const cur = a.newPrice !== null ? Number(a.newPrice) : null
                    const pct = a.changePct !== null ? Number(a.changePct) : null
                    return (
                      <div key={a.id} className="grid grid-cols-[36px_1.4fr_1fr_1fr_auto] items-center gap-3 px-[18px] py-3.5 border-b border-line last:border-0">
                        <div className="w-9 h-9 rounded-[9px] bg-red-soft text-red-text grid place-items-center shrink-0">
                          <AlertTriangle size={15} />
                        </div>
                        <div className="min-w-0">
                          <Link href={`/inventory?highlight=${a.inventoryItem.id}`}
                            className="text-[14px] font-medium text-ink tracking-[-0.01em] hover:text-gold-2 inline-flex items-center gap-1">
                            {a.inventoryItem.itemName} <ExternalLink size={11} className="text-ink-4" />
                          </Link>
                          <div className="font-mono text-[10.5px] text-ink-3 mt-0.5">
                            {a.session.supplierName ?? '—'} · {fmtDate(a.session.invoiceDate ?? a.createdAt)}
                          </div>
                        </div>
                        <div className="font-mono text-[12px] text-ink-3">
                          {old !== null ? formatCurrency(old) : '—'} <span className="text-ink-4">→</span>{' '}
                          <span className="text-ink font-medium">{cur !== null ? formatCurrency(cur) : '—'}</span>
                        </div>
                        <div className={`font-mono text-[13px] font-semibold tabular-nums ${pct !== null && pct > 0 ? 'text-red-text' : pct !== null && pct < 0 ? 'text-green-text' : 'text-ink-3'}`}>
                          {pct !== null ? (pct > 0 ? '+' : '') + pct.toFixed(1) + '%' : '—'}
                        </div>
                        <button onClick={() => ackOne('price', a.id)} disabled={busyId === a.id}
                          className="font-mono text-[11px] px-3 py-1.5 rounded-full bg-bg-2 text-ink-2 border border-line hover:border-ink-3 disabled:opacity-50 transition-colors">
                          {busyId === a.id ? '…' : 'Ack'}
                        </button>
                      </div>
                    )
                  })}
                </div>
              </section>
            )}

            {recipeAlerts.length > 0 && (
              <section>
                <h2 className="font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3 mb-2">Recipe drift · {recipeAlerts.length}</h2>
                <div className="bg-paper border border-line rounded-[12px] overflow-hidden">
                  {recipeAlerts.map(a => {
                    const fcPct = a.newFoodCostPct !== null ? Number(a.newFoodCostPct) : null
                    const overTarget = fcPct !== null && fcPct > 28
                    return (
                      <div key={a.id} className="grid grid-cols-[36px_1.4fr_1fr_auto] items-center gap-3 px-[18px] py-3.5 border-b border-line last:border-0">
                        <div className="w-9 h-9 rounded-[9px] bg-gold-soft text-gold-2 grid place-items-center shrink-0">
                          <AlertTriangle size={15} />
                        </div>
                        <div className="min-w-0">
                          <Link href={`/menu?highlight=${a.recipe.id}`}
                            className="text-[14px] font-medium text-ink tracking-[-0.01em] hover:text-gold-2 inline-flex items-center gap-1">
                            {a.recipe.name} <ExternalLink size={11} className="text-ink-4" />
                          </Link>
                          <div className="font-mono text-[10.5px] text-ink-3 mt-0.5">
                            triggered by {a.session.supplierName ?? '—'} · {fmtDate(a.createdAt)}
                          </div>
                        </div>
                        <div className={`font-mono text-[13px] font-semibold tabular-nums ${overTarget ? 'text-red-text' : 'text-ink-2'}`}>
                          {fcPct !== null ? fcPct.toFixed(1) + '%' : '—'} food cost
                        </div>
                        <button onClick={() => ackOne('recipe', a.id)} disabled={busyId === a.id}
                          className="font-mono text-[11px] px-3 py-1.5 rounded-full bg-bg-2 text-ink-2 border border-line hover:border-ink-3 disabled:opacity-50 transition-colors">
                          {busyId === a.id ? '…' : 'Ack'}
                        </button>
                      </div>
                    )
                  })}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </>
  )
}

function fmtDate(d: string): string {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

```


---

## `src/app/sales/page.tsx`

```tsx
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
  periodType: string
  endDate: string | null
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

// ─── KPI Card ─────────────────────────────────────────────────────────────────

function PeriodBadge({ badge, text }: { badge: PeriodRow['badge']; text: string }) {
  const cls = {
    'weekly-import':  'bg-blue-100 text-blue-700',
    'monthly-import': 'bg-purple-100 text-purple-700',
    'complete':       'bg-green-100 text-green-700',
    'partial':        'bg-amber-100 text-amber-700',
    'not-available':  'bg-gray-100 text-gray-400',
  }[badge]
  return <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${cls}`}>{text}</span>
}

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
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4">
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
          <div className="px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-3 border-t border-gray-100 shrink-0 flex gap-3">
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
  if (c === 'exact')  return <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-green-100 text-green-700">matched</span>
  if (c === 'fuzzy')  return <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">fuzzy</span>
  return <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">unmatched</span>
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
              {parsed.endDate ? (
                /* Period import */
                <div className="space-y-3">
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="text-xs font-medium text-gray-600 block mb-1">From</label>
                      <input type="date" value={date} onChange={e => setDate(e.target.value)}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-gray-600 block mb-1">To</label>
                      <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-gray-600 block mb-1">Period Type</label>
                      <select value={periodType} onChange={e => setPeriodType(e.target.value as 'week' | 'month' | 'custom')}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold">
                        <option value="week">Week</option>
                        <option value="month">Month</option>
                        <option value="custom">Custom</option>
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
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
                </div>
              ) : (
                /* Single-day import — existing layout */
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
              )}

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
            <div className="px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-3 border-t border-gray-100 shrink-0 flex gap-3">
              <button onClick={() => setStep('upload')} className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50">
                ← Back
              </button>
              <button onClick={handleSave} disabled={saving}
                className="flex-1 px-4 py-2.5 rounded-xl bg-gold text-white text-sm font-medium hover:bg-[#a88930] disabled:opacity-60">
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

  // ── Period rows (week/month aggregation) ──
  const periodRows = useMemo((): PeriodRow[] => {
    if (granularity === 'week')  return buildWeekRows(sales, startDate, endDate)
    if (granularity === 'month') return buildMonthRows(sales, startDate, endDate)
    return []
  }, [sales, granularity, startDate, endDate])

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
    if (selectedSale?.id === id) setSelectedSale(null)
    fetchSales()
  }

  const handleImport = async (row: Parameters<Parameters<typeof ImportModal>[0]['onImport']>[0]) => {
    await fetch('/api/sales', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...row, revenueCenterId: activeRcId }) })
    setShowImport(false)
    fetchSales()
  }

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
          {/* Granularity toggle + search */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden">
              {(['day', 'week', 'month'] as Granularity[]).map(g => (
                <button key={g}
                  onClick={() => { setGranularity(g); setSelectedSale(null); setSelectedPeriodKey(null) }}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors capitalize ${
                    granularity === g ? 'bg-gold text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
                  }`}>
                  {g}
                </button>
              ))}
            </div>
            {granularity === 'day' && (
              <div className="relative max-w-xs">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input value={search} onChange={e => setSearch(e.target.value)}
                  placeholder="Search days…"
                  className="w-full pl-8 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
              </div>
            )}
          </div>

          {/* Split panel */}
          <div className="flex gap-4 items-start">

            {/* Left panel */}
            <div className={`${(selectedSale || selectedPeriodKey) ? 'w-[360px] shrink-0' : 'w-full'}`}>

              {/* Day mode table */}
              {granularity === 'day' && (
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
                        <th className="px-3 py-3 w-16" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {loading && (
                        <tr><td colSpan={5} className="text-center py-12 text-gray-400">Loading…</td></tr>
                      )}
                      {!loading && displayed.length === 0 && (
                        <tr>
                          <td colSpan={5} className="text-center py-12">
                            <div className="text-gray-400 mb-3">No sales recorded for this period</div>
                            <button onClick={() => setShowAdd(true)}
                              className="inline-flex items-center gap-2 px-4 py-2 bg-gold text-white rounded-lg text-sm hover:bg-[#a88930]">
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
                            className={`cursor-pointer transition-colors ${isSelected ? 'bg-amber-50' : 'hover:bg-gray-50'}`}>
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
                            </td>
                            <td className="px-3 py-3 text-right hidden md:table-cell">
                              <div className="font-medium text-gray-700">{portions > 0 ? portions : '—'}</div>
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
              )}

              {/* Week / Month mode list */}
              {granularity !== 'day' && (
                <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
                  {loading && <div className="py-12 text-center text-gray-400">Loading…</div>}
                  {!loading && periodRows.length === 0 && (
                    <div className="py-12 text-center text-gray-400">No sales data for this period</div>
                  )}
                  {periodRows.map(period => {
                    const isSelected = selectedPeriodKey === period.key
                    return (
                      <div key={period.key}
                        onClick={() => setSelectedPeriodKey(isSelected ? null : period.key)}
                        className={`flex items-center gap-3 px-4 py-3.5 border-b border-gray-50 last:border-0 cursor-pointer transition-colors ${isSelected ? 'bg-amber-50' : 'hover:bg-gray-50'}`}>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className="text-sm font-medium text-gray-800">{period.label}</span>
                            <PeriodBadge badge={period.badge} text={period.badgeText} />
                          </div>
                          {period.totalRevenue > 0 && (
                            <div className="text-xs text-gray-400">
                              {formatCurrency(period.totalRevenue)} · {Math.round(period.foodSalesPct * 100)}% food
                            </div>
                          )}
                        </div>
                        {period.covers != null && period.covers > 0 && (
                          <div className="text-right shrink-0">
                            <div className="text-sm font-semibold text-gray-700">{period.covers}</div>
                            <div className="text-[10px] text-gray-400">covers</div>
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
                    <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
                      <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-gray-100">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-gray-900">{fmtDate(sale.date)}</span>
                            {sale.revenueCenter && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-gray-100 text-gray-700">
                                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: rcHex(sale.revenueCenter.color) }} />
                                {sale.revenueCenter.name}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-gray-400">{fmtDay(sale.date)}</div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <button onClick={() => { setEditSale(sale); setSelectedSale(null) }}
                            className="flex items-center gap-1 px-2.5 py-1.5 border border-gray-200 rounded-lg text-xs text-gray-600 hover:bg-gray-50">
                            <Pencil size={11} /> Edit
                          </button>
                          <button onClick={() => setSelectedSale(null)}
                            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400"><X size={16} /></button>
                        </div>
                      </div>
                      <div className="px-4 py-4 space-y-4">
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
                        <div className="text-xs text-gray-500">
                          Food sales: <span className="font-medium text-gray-700">{formatCurrency(foodSalesAmt)}</span>
                          <span className="mx-1">·</span>{Math.round(Number(sale.foodSalesPct) * 100)}%
                          <span className="mx-1">·</span>{totalSold} portions
                        </div>
                        {sale.notes && (
                          <div className="bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 text-sm text-amber-800">{sale.notes}</div>
                        )}
                        {sale.lineItems.length > 0 ? (
                          <div>
                            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Items sold</div>
                            <div className="divide-y divide-gray-50 border border-gray-100 rounded-xl overflow-hidden max-h-80 overflow-y-auto">
                              {sale.lineItems.map(li => {
                                const lineRevenue = li.recipe.menuPrice ? Number(li.recipe.menuPrice) * li.qtySold : null
                                return (
                                  <div key={li.id} className="flex items-center gap-3 px-3 py-2.5">
                                    <div className="flex-1 min-w-0">
                                      <div className="text-sm font-medium text-gray-800 truncate">{li.recipe.name}</div>
                                      {li.recipe.category && <div className="text-xs text-gray-400">{li.recipe.category.name}</div>}
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
                          <div className="text-center py-4 text-sm text-gray-400">No menu items recorded</div>
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
                    <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
                      <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-gray-100">
                        <div>
                          <div className="text-sm font-semibold text-gray-900">{period.label}</div>
                          <div className="mt-0.5">
                            <PeriodBadge badge={period.badge} text={period.badgeText} />
                          </div>
                        </div>
                        <button onClick={() => setSelectedPeriodKey(null)}
                          className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400"><X size={16} /></button>
                      </div>
                      <div className="px-4 py-4 space-y-4">
                        {period.totalRevenue > 0 && (
                          <div className="grid grid-cols-3 gap-3">
                            <div className="bg-gray-50 rounded-xl p-3 text-center">
                              <div className="text-lg font-bold text-gray-900">{formatCurrency(period.totalRevenue)}</div>
                              <div className="text-[10px] text-gray-500 mt-0.5 uppercase tracking-wide">Revenue</div>
                            </div>
                            <div className="bg-gray-50 rounded-xl p-3 text-center">
                              <div className="text-lg font-bold text-gray-900">{formatCurrency(foodSalesAmt)}</div>
                              <div className="text-[10px] text-gray-500 mt-0.5 uppercase tracking-wide">Food Sales</div>
                            </div>
                            <div className="bg-gray-50 rounded-xl p-3 text-center">
                              <div className="text-lg font-bold text-gray-900">{period.covers ?? '—'}</div>
                              <div className="text-[10px] text-gray-500 mt-0.5 uppercase tracking-wide">Covers</div>
                            </div>
                          </div>
                        )}
                        {period.badge === 'not-available' && (
                          <div className="text-center py-4 text-sm text-gray-400">No sales data for this period</div>
                        )}
                        {(period.badge === 'weekly-import' || period.badge === 'monthly-import') && (
                          <div className="bg-blue-50 border border-blue-100 rounded-lg px-3 py-2 text-xs text-blue-700">
                            Imported as {period.badge === 'weekly-import' ? 'Weekly' : 'Monthly'} — no per-day breakdown available.
                          </div>
                        )}
                        {period.badge !== 'weekly-import' && period.badge !== 'monthly-import' && period.dailySales.length > 0 && (
                          <div>
                            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Day breakdown</div>
                            <div className="divide-y divide-gray-50 border border-gray-100 rounded-xl overflow-hidden">
                              {(() => {
                                const days: string[] = []
                                const cur = new Date(period.startDate)
                                const pEnd = new Date(period.endDate)
                                while (cur <= pEnd) { days.push(toISO(cur)); cur.setDate(cur.getDate() + 1) }
                                return days.map(day => {
                                  const daySale = period.dailySales.find(s => s.date.slice(0, 10) === day)
                                  return (
                                    <div key={day} className="flex items-center justify-between px-3 py-2">
                                      <span className="text-sm text-gray-700">{fmtDate(day)}</span>
                                      {daySale
                                        ? <span className="text-sm font-medium text-gray-900">{formatCurrency(Number(daySale.totalRevenue))}</span>
                                        : <span className="text-sm text-gray-300">—</span>
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

```


---

## `src/app/wastage/page.tsx`

```tsx
'use client'
import { useEffect, useState, useCallback } from 'react'
import dynamic from 'next/dynamic'
import { formatCurrency, formatDate, WASTAGE_REASONS, compatibleCountUnits } from '@/lib/utils'
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
  DROPPED:        'bg-gold/15 text-gold',
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
          className="flex items-center gap-2 bg-gold text-white px-3 py-2 rounded-lg text-sm hover:bg-[#a88930] transition-colors"
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
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
        >
          <option value="">All Reasons</option>
          {WASTAGE_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={startDate}
            onChange={e => setStartDate(e.target.value)}
            className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
          />
          <span className="text-gray-400 text-sm">to</span>
          <input
            type="date"
            value={endDate}
            onChange={e => setEndDate(e.target.value)}
            className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
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
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
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
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                    step="any"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Unit</label>
                  <select
                    value={form.unit}
                    onChange={e => setForm(f => ({ ...f, unit: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold bg-white"
                  >
                    {(compatibleCountUnits(inventoryItems.find(i => i.id === form.inventoryItemId)?.baseUnit ?? 'each')).map(u => (
                      <option key={u}>{u}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Reason</label>
                <select
                  value={form.reason}
                  onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
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
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Logged By</label>
                  <input
                    value={form.loggedBy}
                    onChange={e => setForm(f => ({ ...f, loggedBy: e.target.value }))}
                    placeholder="Name"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Notes</label>
                <textarea
                  value={form.notes}
                  onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
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

```


---

## `src/app/variance/page.tsx`

```tsx
'use client'
import { useEffect, useState, useMemo } from 'react'
import Link from 'next/link'
import { Activity, ArrowRight } from 'lucide-react'
import { PageHead } from '@/components/layout/PageHead'
import { formatCurrency } from '@/lib/utils'

interface VarianceRow {
  inventoryItemId: string
  itemName: string
  category: string
  baseUnit: string
  theoreticalQty: number
  countedQty: number | null
  varianceQty: number | null
  varianceValue: number | null
  pricePerBaseUnit: number
}

interface VarianceResp {
  items: VarianceRow[]
  totalVarianceValue: number
  startDate?: string
  endDate?: string
}

export default function VariancePage() {
  const [data, setData] = useState<VarianceResp | null>(null)
  const [range, setRange] = useState<7 | 14 | 30>(7)

  useEffect(() => {
    const end = new Date()
    const start = new Date(); start.setDate(start.getDate() - range)
    const qs = `?startDate=${start.toISOString().slice(0,10)}&endDate=${end.toISOString().slice(0,10)}`
    fetch(`/api/reports/theoretical-usage${qs}`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(json => json && setData(json))
  }, [range])

  const top = useMemo(() => {
    const items = data?.items ?? []
    return [...items]
      .filter(i => i.varianceValue !== null && Math.abs(i.varianceValue) > 0.01)
      .sort((a, b) => Math.abs(b.varianceValue ?? 0) - Math.abs(a.varianceValue ?? 0))
      .slice(0, 15)
  }, [data])

  return (
    <div>
      <PageHead
        crumbs={<><Activity size={12} /> INSIGHTS / VARIANCE</>}
        title="Variance"
        sub={data ? <>Theoretical vs counted over the last <b>{range}d</b> · total drift <b className={data.totalVarianceValue < 0 ? 'text-red-text' : ''}>{formatCurrency(data.totalVarianceValue)}</b></> : <>Loading…</>}
        actions={
          <div className="inline-flex bg-paper border border-line rounded-[9px] p-[3px]">
            {([7, 14, 30] as const).map(n => (
              <button key={n} onClick={() => setRange(n)}
                className={`font-mono text-[11px] px-3 py-1.5 rounded-[6px] tracking-[0] transition-colors ${
                  range === n ? 'bg-ink text-paper' : 'text-ink-3 hover:text-ink-2'
                }`}>
                {n}d
              </button>
            ))}
          </div>
        }
      />

      {!data ? null : top.length === 0 ? (
        <div className="bg-paper border border-line rounded-[12px] p-12 text-center">
          <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-green-text">No variance</p>
          <p className="text-[14px] text-ink-2 mt-2 max-w-md mx-auto">
            Counts and theoretical depletion are in sync. Either your sales/recipe data is sparse, or you&apos;re running a tight kitchen.
          </p>
        </div>
      ) : (
        <section className="bg-paper border border-line rounded-[12px] overflow-hidden">
          <header className="flex items-center justify-between px-[18px] py-3 border-b border-line bg-bg-2">
            <h3 className="text-[13px] font-semibold tracking-[-0.01em]">
              Top variance lines <span className="font-mono text-[10.5px] text-ink-3 font-normal">· top {top.length}</span>
            </h3>
            <span className="font-mono text-[10.5px] text-ink-3">SORTED BY |Δ$|</span>
          </header>
          <div className="grid grid-cols-[1.6fr_1fr_1fr_auto_auto] gap-3 px-[18px] py-2.5 bg-bg-2 border-b border-line font-mono text-[10.5px] uppercase tracking-[0.02em] text-ink-3">
            <span>Item</span>
            <span className="text-right">Theoretical</span>
            <span className="text-right">Counted</span>
            <span className="text-right">Δ qty</span>
            <span className="text-right">Δ $</span>
          </div>
          {top.map(r => {
            const tone = (r.varianceValue ?? 0) < -5 ? 'bad' : (r.varianceValue ?? 0) > 5 ? 'warn' : 'neutral'
            const toneCls = tone === 'bad' ? 'text-red-text' : tone === 'warn' ? 'text-gold-2' : 'text-ink-3'
            return (
              <Link key={r.inventoryItemId} href={`/inventory?highlight=${r.inventoryItemId}`}
                className="grid grid-cols-[1.6fr_1fr_1fr_auto_auto] gap-3 px-[18px] py-3 border-b border-line last:border-0 items-center hover:bg-bg-2/40 transition-colors">
                <div className="min-w-0">
                  <div className="text-[13px] text-ink font-medium tracking-[-0.005em] truncate">{r.itemName}</div>
                  <div className="font-mono text-[10.5px] text-ink-3 mt-0.5">{r.category} · {r.baseUnit} · ${r.pricePerBaseUnit.toFixed(4)}/u</div>
                </div>
                <div className="font-mono text-[12px] text-ink-2 text-right tabular-nums">{r.theoreticalQty.toFixed(1)}</div>
                <div className="font-mono text-[12px] text-ink-2 text-right tabular-nums">{r.countedQty?.toFixed(1) ?? '—'}</div>
                <div className={`font-mono text-[12px] text-right tabular-nums ${toneCls}`}>
                  {r.varianceQty !== null ? (r.varianceQty > 0 ? '+' : '') + r.varianceQty.toFixed(1) : '—'}
                </div>
                <div className={`font-mono text-[13px] font-semibold text-right tabular-nums ${toneCls} min-w-[80px] inline-flex items-center justify-end gap-1`}>
                  {r.varianceValue !== null ? (r.varianceValue > 0 ? '+' : '−') + '$' + Math.abs(r.varianceValue).toFixed(0) : '—'}
                  <ArrowRight size={11} className="text-ink-4" />
                </div>
              </Link>
            )
          })}
        </section>
      )}

      <div className="mt-5 font-mono text-[10.5px] text-ink-3 tracking-wide text-center">
        Variance = theoretical depletion from sales (recipe × qty sold) minus counted on-hand.
        Negative Δ$ means short (eat into margin); positive means over (likely uncounted waste).
      </div>
    </div>
  )
}

```


---

## `src/app/signals/page.tsx`

```tsx
'use client'
import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { Zap, Check, Clock, X, RefreshCw, AlertTriangle, AlertCircle, Info } from 'lucide-react'
import { PageHead } from '@/components/layout/PageHead'
import { formatCurrency } from '@/lib/utils'

interface Signal {
  id: string
  fingerprint: string
  rule: string
  severity: 'critical' | 'warn' | 'info'
  title: string
  body: string
  verbLabel: string
  verbHref: string
  impactValue: number | null
  itemId: string | null
  recipeId: string | null
  status: 'OPEN' | 'APPLIED' | 'SNOOZED' | 'DISMISSED'
  createdAt: string
}

interface SignalsData {
  signals: Signal[]
  counts: { open: number; applied: number; critical: number }
}

export default function SignalsPage() {
  const [data, setData] = useState<SignalsData | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const json: SignalsData = await fetch('/api/signals', { cache: 'no-store' }).then(r => r.json())
      setData(json)
    } catch {}
  }, [])

  useEffect(() => { load() }, [load])

  const refresh = async () => {
    setRefreshing(true)
    try {
      await fetch('/api/signals/refresh', { method: 'POST' })
      await load()
    } finally { setRefreshing(false) }
  }

  const act = async (id: string, action: 'apply' | 'snooze' | 'dismiss') => {
    setBusyId(id)
    try {
      await fetch('/api/signals', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id], action }),
      })
      await load()
    } finally { setBusyId(null) }
  }

  const open    = data?.signals.filter(s => s.status === 'OPEN')    ?? []
  const applied = data?.signals.filter(s => s.status === 'APPLIED') ?? []

  return (
    <div>
      <PageHead
        crumbs={<span>INSIGHTS / SIGNALS</span>}
        title="Signals"
        sub={
          data
            ? <>
                <b>{data.counts.open}</b> open
                {data.counts.critical > 0 && <> · <b className="text-red-text">{data.counts.critical} critical</b></>}
                {data.counts.applied > 0 && <> · <b>{data.counts.applied}</b> applied</>}
              </>
            : <>Loading…</>
        }
        actions={
          <button
            onClick={refresh}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 bg-ink text-paper px-4 py-[9px] rounded-[9px] text-[13px] font-medium hover:bg-[#18181b] disabled:opacity-60 transition-colors"
          >
            <RefreshCw size={13} className={`text-gold ${refreshing ? 'animate-spin' : ''}`} /> {refreshing ? 'Refreshing…' : 'Refresh signals'}
          </button>
        }
      />

      {!data ? null : (open.length + applied.length === 0) ? (
        <div className="bg-paper border border-line rounded-[12px] p-12 text-center">
          <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-green-text">All quiet</p>
          <p className="text-[14px] text-ink-2 mt-2 max-w-md mx-auto">
            No active signals. Run <b>Refresh</b> to re-evaluate the rules
            (price spikes, recipe drift, count overdue, wastage, menu engineering).
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {open.length > 0 && (
            <section>
              <h2 className="font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3 mb-2">Open · {open.length}</h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {open.map(s => (
                  <SignalCard key={s.id} signal={s} busy={busyId === s.id} onAct={act} />
                ))}
              </div>
            </section>
          )}
          {applied.length > 0 && (
            <section>
              <h2 className="font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3 mb-2">Applied · {applied.length}</h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {applied.map(s => (
                  <SignalCard key={s.id} signal={s} busy={busyId === s.id} onAct={act} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      <div className="mt-5 font-mono text-[10.5px] text-ink-3 tracking-wide text-center">
        5 starter rules: price spikes · recipe drift · count overdue · wastage spikes · menu engineering
      </div>
    </div>
  )
}

function SignalCard({ signal, busy, onAct }: {
  signal: Signal; busy: boolean; onAct: (id: string, action: 'apply' | 'snooze' | 'dismiss') => void
}) {
  const sev = signal.severity
  const Icon = sev === 'critical' ? AlertTriangle : sev === 'warn' ? AlertCircle : Info
  const iconCls = sev === 'critical' ? 'bg-red-soft text-red-text'
    : sev === 'warn' ? 'bg-gold-soft text-gold-2'
    : 'bg-blue-soft text-blue-text'
  const isApplied = signal.status === 'APPLIED'

  return (
    <div className={`bg-paper border rounded-[12px] p-5 transition-opacity ${isApplied ? 'opacity-70 border-line' : 'border-line'}`}>
      <header className="flex items-start gap-3 mb-3">
        <div className={`w-9 h-9 rounded-[9px] grid place-items-center shrink-0 ${iconCls}`}>
          <Icon size={15} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold tracking-[-0.015em] text-ink leading-tight">{signal.title}</div>
          <div className="font-mono text-[10.5px] text-ink-3 mt-1 tracking-[0.02em] uppercase">
            {signal.rule.replaceAll('_', ' ')}
            {signal.impactValue !== null && signal.impactValue > 0 && (
              <> · <span className="text-gold-2 normal-case tracking-normal font-semibold">{formatCurrency(signal.impactValue)} est.</span></>
            )}
          </div>
        </div>
        {isApplied && (
          <span className="font-mono text-[10px] uppercase tracking-[0.04em] bg-green-soft text-green-text px-2 py-0.5 rounded-full font-semibold">
            Applied
          </span>
        )}
      </header>

      <p className="text-[13px] text-ink-2 leading-[1.5] tracking-[-0.005em] mb-4">
        {signal.body}
      </p>

      <div className="flex items-center justify-between gap-2">
        <Link href={signal.verbHref}
          className="inline-flex items-center gap-1.5 bg-ink text-paper px-3 py-1.5 rounded-[8px] text-[12px] font-medium hover:bg-[#18181b] transition-colors">
          {signal.verbLabel} →
        </Link>
        <div className="flex items-center gap-1">
          {!isApplied && (
            <button onClick={() => onAct(signal.id, 'apply')} disabled={busy}
              title="Mark applied"
              className="w-8 h-8 rounded-md grid place-items-center text-ink-3 hover:text-ink hover:bg-bg-2 disabled:opacity-50 transition-colors">
              <Check size={14} />
            </button>
          )}
          <button onClick={() => onAct(signal.id, 'snooze')} disabled={busy}
            title="Snooze 24h"
            className="w-8 h-8 rounded-md grid place-items-center text-ink-3 hover:text-ink hover:bg-bg-2 disabled:opacity-50 transition-colors">
            <Clock size={14} />
          </button>
          <button onClick={() => onAct(signal.id, 'dismiss')} disabled={busy}
            title="Dismiss"
            className="w-8 h-8 rounded-md grid place-items-center text-ink-3 hover:text-ink hover:bg-bg-2 disabled:opacity-50 transition-colors">
            <X size={14} />
          </button>
        </div>
      </div>
    </div>
  )
}

```


---

## `src/app/pass/page.tsx`

```tsx
'use client'
import { useEffect, useState, useMemo } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, Mail, Activity, Zap, Clock,
  ArrowRight, ClipboardList,
} from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { useUser } from '@/contexts/UserContext'
import { formatCurrency } from '@/lib/utils'
import { SubNav } from '@/components/layout/SubNav'
import { PageHead } from '@/components/layout/PageHead'

// ── Types ───────────────────────────────────────────────────────────────────

interface DashboardData {
  totalInventoryValue: number
  weeklyWastageCost: number
  outOfStockCount: number
  outOfStockItems: Array<{ id: string; itemName: string; category: string; lastValue: number }>
  estimatedFoodCostPct: number
  weeklyRevenue: number
  weeklyPurchaseCost: number
}

interface KPIs {
  awaitingApprovalCount: number
  priceAlertCount: number
  recentApprovalsCount: number
}

interface CostChromeData {
  foodCostPct: number | null
  targetPct: number
  variance7d: number | null
  onHand: number
}

interface PrepItem {
  id: string
  name: string
  category: string
  unit: string
  onHand: number
  parLevel: number
  priority: '911' | 'NEEDED_TODAY' | 'LATER'
  suggestedQty: number
}

interface CountSession {
  id: string
  label: string
  sessionDate: string
  startedAt: string
  finalizedAt: string | null
  countedBy: string
  status: string
}

interface AttnItem {
  id: string
  kind: 'price' | 'invoice' | 'variance' | 'count'
  icon: typeof AlertTriangle
  iconTint: 'red' | 'amber' | 'blue' | 'green'
  title: React.ReactNode
  meta: string
  cost: { value: string; sub: string; tint?: 'bad' | 'warn' | 'ok' }
  ctaHref: string
  ctaLabel: string
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function PassPage() {
  const { user } = useUser()
  const { activeRcId, activeRc } = useRc()
  const isDefaultActive = activeRc?.isDefault ?? false
  const [dashboard, setDashboard] = useState<DashboardData | null>(null)
  const [chrome, setChrome] = useState<CostChromeData | null>(null)
  const [inboxKpis, setInboxKpis] = useState<KPIs | null>(null)
  const [prepItems, setPrepItems] = useState<PrepItem[]>([])
  const [countSessions, setCountSessions] = useState<CountSession[]>([])
  const [priceAlertCount, setPriceAlertCount] = useState<number>(0)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const qs = activeRcId ? `?rcId=${activeRcId}&isDefault=${isDefaultActive}` : ''
        const [d, c, k, p, s, a] = await Promise.all([
          fetch(`/api/reports/dashboard${qs}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
          fetch(`/api/insights/cost-chrome${activeRcId ? `?rcId=${activeRcId}` : ''}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
          fetch(`/api/invoices/kpis${qs}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
          fetch('/api/prep/items', { cache: 'no-store' }).then(r => r.ok ? r.json() : []),
          fetch('/api/count/sessions', { cache: 'no-store' }).then(r => r.ok ? r.json() : []),
          fetch('/api/invoices/alerts', { cache: 'no-store' }).then(r => r.ok ? r.json() : { priceAlerts: [] }),
        ])
        if (cancelled) return
        if (d) setDashboard(d)
        if (c) setChrome(c)
        if (k) setInboxKpis(k)
        if (Array.isArray(p)) setPrepItems(p)
        if (Array.isArray(s)) setCountSessions(s)
        if (a?.priceAlerts) setPriceAlertCount(a.priceAlerts.length)
      } catch { /* swallow */ }
    }
    load()
    const t = setInterval(load, 60_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [activeRcId, isDefaultActive])

  // ── Attention queue (derived) ────────────────────────────────────────────
  const attn = useMemo<AttnItem[]>(() => {
    const items: AttnItem[] = []
    if (priceAlertCount > 0) {
      items.push({
        id: 'price-alerts',
        kind: 'price',
        icon: AlertTriangle,
        iconTint: 'red',
        title: <><b>{priceAlertCount}</b> active price {priceAlertCount === 1 ? 'alert' : 'alerts'} — review impact on recipes</>,
        meta: 'PRICE ALERTS · open Inbox to acknowledge',
        cost: { value: priceAlertCount.toString(), sub: priceAlertCount === 1 ? 'alert' : 'alerts', tint: 'bad' },
        ctaHref: '/invoices',
        ctaLabel: 'Review',
      })
    }
    if (inboxKpis && inboxKpis.awaitingApprovalCount > 0) {
      items.push({
        id: 'invoices-pending',
        kind: 'invoice',
        icon: Mail,
        iconTint: 'amber',
        title: <><b>{inboxKpis.awaitingApprovalCount}</b> {inboxKpis.awaitingApprovalCount === 1 ? 'invoice' : 'invoices'} awaiting approval</>,
        meta: 'OCR · ready for review',
        cost: { value: inboxKpis.awaitingApprovalCount.toString(), sub: 'to approve', tint: 'warn' },
        ctaHref: '/invoices',
        ctaLabel: 'Open',
      })
    }
    const criticalPrep = prepItems.filter(p => p.priority === '911').length
    if (criticalPrep > 0) {
      items.push({
        id: 'prep-critical',
        kind: 'count',
        icon: ClipboardList,
        iconTint: 'red',
        title: <><b>{criticalPrep}</b> critical prep {criticalPrep === 1 ? 'item' : 'items'} — depleted or empty</>,
        meta: 'PREP · build before service',
        cost: { value: criticalPrep.toString(), sub: 'critical', tint: 'bad' },
        ctaHref: '/prep',
        ctaLabel: 'Open prep',
      })
    }
    const latestCount = countSessions
      .filter(s => s.status === 'FINALIZED' && s.finalizedAt)
      .sort((a, b) => new Date(b.finalizedAt!).getTime() - new Date(a.finalizedAt!).getTime())[0]
    const daysSinceCount = latestCount
      ? Math.floor((Date.now() - new Date(latestCount.finalizedAt!).getTime()) / 86_400_000)
      : null
    if (daysSinceCount !== null && daysSinceCount > 4) {
      items.push({
        id: 'count-overdue',
        kind: 'variance',
        icon: Activity,
        iconTint: 'amber',
        title: <>Last count was <b>{daysSinceCount}d ago</b> — theoretical-vs-actual drift widens</>,
        meta: 'COUNT · schedule a partial before brunch',
        cost: { value: `${daysSinceCount}d`, sub: 'stale', tint: 'warn' },
        ctaHref: '/count',
        ctaLabel: 'Schedule',
      })
    }
    return items
  }, [priceAlertCount, inboxKpis, prepItems, countSessions])

  const prepSummary = useMemo(() => {
    const active = prepItems.filter(p => p.onHand >= 0 || p.priority !== 'LATER')
    const top = [...prepItems]
      .filter(p => p.priority !== 'LATER')
      .sort((a, b) => (a.priority === '911' ? -1 : 0) - (b.priority === '911' ? -1 : 0))
      .slice(0, 5)
    return { total: active.length, top }
  }, [prepItems])

  const greeting = greetingFor(new Date())
  const firstName = user?.name?.split(' ')[0] ?? user?.email?.split('@')[0] ?? 'there'

  const cutoff = nextServiceCutoff(new Date())
  const remainingMs = cutoff.getTime() - Date.now()
  const remainingH = Math.floor(remainingMs / 3_600_000)
  const remainingM = Math.floor((remainingMs % 3_600_000) / 60_000)

  return (
    <>
      <SubNav
        tabs={[
          { href: '/pass', label: 'Pass' },
          { href: '/prep', label: 'Briefing', icon: <Activity size={14} /> },
          { href: '/cost', label: 'End-of-day', icon: <Clock size={14} /> },
        ]}
      />
      <div className="p-4 md:p-6 md:px-8 max-w-7xl mx-auto w-full">

        <PageHead
          crumbs={<><Clock size={12} /> TODAY / PASS · {fmtCrumbDate(new Date())}</>}
          title={<>Good {greeting}, <em className="not-italic text-gold-2">{firstName}</em>.</>}
          sub={<>
            {greeting === 'morning' ? 'Dinner' : 'Tomorrow'} service in <b>{remainingH}h {remainingM}m</b>
            {dashboard && <> · weekly food sales <b>{formatCurrency(dashboard.weeklyRevenue)}</b></>}
            {attn.length > 0 && <> · <b className="text-red-text">{attn.length} {attn.length === 1 ? 'thing' : 'things'}</b> need you</>}
          </>}
          actions={
            <>
              <Link href="/cost" className="inline-flex items-center gap-1.5 border border-line bg-paper text-ink-2 px-3.5 py-[9px] rounded-[9px] text-[13px] font-medium hover:border-ink-3 transition-colors">
                <Clock size={13} className="text-ink-3" /> End-of-day
              </Link>
              <Link href="/prep" className="inline-flex items-center gap-1.5 bg-ink text-paper px-4 py-[9px] rounded-[9px] text-[13px] font-medium hover:bg-[#18181b] transition-colors">
                <ArrowRight size={13} className="text-gold" /> Start pre-shift
              </Link>
            </>
          }
        />

        <div className="grid gap-3 mb-6" style={{ gridTemplateColumns: '1.4fr 1fr 1fr 1fr' }}>
          <HeroKPI chrome={chrome} dashboard={dashboard} />
          <KPI label="ON HAND"
            value={dashboard ? formatCurrency(dashboard.totalInventoryValue) : '—'}
            delta={<><b>{dashboard?.outOfStockCount ?? 0}</b> out of stock</>}
          />
          <KPI label="PREP TO DO"
            value={prepSummary.total.toString()}
            delta={
              prepSummary.top.filter(p => p.priority === '911').length > 0
                ? <><b className="text-red-text">{prepSummary.top.filter(p => p.priority === '911').length} critical</b></>
                : <>all on par</>
            }
          />
          <KPI label="WASTAGE · 7D"
            value={dashboard ? formatCurrency(dashboard.weeklyWastageCost) : '—'}
            valueClass={dashboard && dashboard.weeklyWastageCost > 0 ? 'text-red-text' : ''}
            delta={<>tracked from <b>waste log</b></>}
          />
        </div>

        <div className="grid gap-5" style={{ gridTemplateColumns: '1fr 320px' }}>
          <div className="space-y-5 min-w-0">

            <section className="bg-paper border border-line rounded-[12px] overflow-hidden">
              <header className="flex items-center justify-between px-[18px] py-3 border-b border-line bg-bg-2">
                <h3 className="text-[13px] font-semibold tracking-[-0.01em] flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${attn.length > 0 ? 'bg-red' : 'bg-green'}`} />
                  Needs you <span className="font-mono text-[10.5px] text-ink-3 font-normal">· {attn.length} {attn.length === 1 ? 'item' : 'items'}</span>
                </h3>
                <span className="font-mono text-[10.5px] text-ink-3">SORTED BY $ IMPACT</span>
              </header>
              {attn.length === 0 ? (
                <div className="px-6 py-10 text-center">
                  <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-green-text">All clear</p>
                  <p className="text-[13px] text-ink-3 mt-1.5">Nothing needs you right now — go cook.</p>
                </div>
              ) : attn.map(a => (
                <AttnRow key={a.id} item={a} />
              ))}
            </section>

            <div className="grid grid-cols-2 gap-4">
              <PrepCard items={prepSummary.top} />
              <CountCard sessions={countSessions} />
            </div>

            <LoopStrip phase={loopPhase(new Date())} weeklyRevenue={dashboard?.weeklyRevenue} />
          </div>

          <aside className="space-y-3.5">
            <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">Right rail · context</div>

            <RailCard icon={<Zap size={11} />} iconTint="amber" title="Signal of the day">
              {priceAlertCount > 0 ? (
                <>You have <b>{priceAlertCount}</b> active price {priceAlertCount === 1 ? 'alert' : 'alerts'} — review whether to bump menu prices or switch suppliers before lunch service.</>
              ) : (
                <>No new signals. Your spine is clean — the live cost chrome above is up to date.</>
              )}
              <div className="flex gap-2 mt-3">
                <Link href="/signals" className="inline-flex items-center gap-1 border border-line bg-paper text-ink-2 px-3 py-1.5 rounded-[7px] text-[12px] font-medium hover:border-ink-3 transition-colors">
                  Open signals
                </Link>
              </div>
            </RailCard>

            <RailCard icon={<Activity size={11} />} iconTint="blue" title="Loop says…">
              {(() => {
                const latest = countSessions.filter(s => s.status === 'FINALIZED' && s.finalizedAt)[0]
                if (!latest) return <>No counts yet. Schedule your first count to start closing the loop.</>
                const days = Math.floor((Date.now() - new Date(latest.finalizedAt!).getTime()) / 86_400_000)
                return <>Counts are <b>{days}d old</b>. Theoretical-vs-actual drift widens until the next reconciliation. Schedule a partial count before service.</>
              })()}
              <div className="flex gap-2 mt-3">
                <Link href="/count" className="inline-flex items-center gap-1 bg-ink text-paper px-3 py-1.5 rounded-[7px] text-[12px] font-medium hover:bg-[#18181b] transition-colors">
                  Schedule count
                </Link>
              </div>
            </RailCard>
          </aside>
        </div>

        <div className="mt-4 flex justify-between font-mono text-[10.5px] text-ink-3 tracking-wide">
          <span>PASS REFRESHES EVERY 60S</span>
          <span><kbd className="font-mono text-[10px] bg-bg-2 border border-line rounded px-1 py-px text-ink-2">⌘R</kbd> REFRESH · <kbd className="font-mono text-[10px] bg-bg-2 border border-line rounded px-1 py-px text-ink-2">⌘/</kbd> SEARCH</span>
        </div>
      </div>
    </>
  )
}

// ── Sub-components ──────────────────────────────────────────────────────────

function HeroKPI({ chrome, dashboard }: { chrome: CostChromeData | null; dashboard: DashboardData | null }) {
  const pct = chrome?.foodCostPct ?? dashboard?.estimatedFoodCostPct ?? null
  const target = chrome?.targetPct ?? 27
  const intStr = pct !== null ? Math.floor(pct).toString() : '—'
  const decimal = pct !== null ? `.${(pct % 1).toFixed(1).slice(2)}%` : ''
  return (
    <div className="bg-ink text-paper rounded-[12px] border border-ink p-5 flex flex-col justify-between min-h-[128px] relative overflow-hidden">
      <div>
        <div className="font-mono text-[10.5px] text-zinc-500 tracking-[0.01em]">FOOD COST · WEEK TO DATE</div>
        <div className="text-[48px] font-semibold tracking-[-0.045em] leading-none mt-2">
          {intStr}<sub className="text-[22px] font-medium text-gold tracking-[-0.02em] align-baseline">{decimal}</sub>
        </div>
      </div>
      <div className="font-mono text-[11px] text-zinc-500 tracking-[0]">
        target <b className="text-paper">{target.toFixed(1)}</b>
        {pct !== null && (
          <> · <span className={pct > target ? 'text-red-300' : 'text-green-400'}>
            {pct > target ? '+' : ''}{(pct - target).toFixed(1)}
          </span> vs target</>
        )}
      </div>
    </div>
  )
}

function KPI({ label, value, delta, valueClass = '' }: { label: string; value: string; delta: React.ReactNode; valueClass?: string }) {
  return (
    <div className="bg-paper border border-line rounded-[12px] p-5 flex flex-col justify-between min-h-[128px] relative">
      <div className="absolute top-0 left-0 w-8 h-0.5 bg-gold" />
      <div>
        <div className="font-mono text-[10.5px] text-ink-3 tracking-[0.01em] uppercase">{label}</div>
        <div className={`text-[34px] font-semibold tracking-[-0.04em] leading-none mt-2 ${valueClass || 'text-ink'}`}>{value}</div>
      </div>
      <div className="font-mono text-[11px] text-ink-3 tracking-[0] [&_b]:text-ink [&_b]:font-medium">{delta}</div>
    </div>
  )
}

function AttnRow({ item }: { item: AttnItem }) {
  const tint = {
    red:   'bg-red-soft text-red-text',
    amber: 'bg-gold-soft text-gold-2',
    blue:  'bg-blue-soft text-blue-text',
    green: 'bg-green-soft text-green-text',
  }[item.iconTint]
  const costTint = item.cost.tint === 'bad' ? 'text-red-text'
    : item.cost.tint === 'warn' ? 'text-gold-2'
    : item.cost.tint === 'ok' ? 'text-green-text' : ''
  const Icon = item.icon
  return (
    <Link href={item.ctaHref} className="grid grid-cols-[48px_1fr_auto_auto] items-center gap-3.5 px-[18px] py-3.5 border-b border-line last:border-0 cursor-pointer hover:bg-bg-2/40 transition-colors">
      <div className={`w-9 h-9 rounded-[9px] grid place-items-center shrink-0 ${tint}`}>
        <Icon size={16} />
      </div>
      <div>
        <div className="text-[14px] font-medium tracking-[-0.01em] text-ink [&_b]:font-semibold [&_b]:text-red-text">{item.title}</div>
        <div className="font-mono text-[10.5px] text-ink-3 mt-1 tracking-[0]">{item.meta}</div>
      </div>
      <div className={`text-right font-mono text-[13.5px] font-semibold tracking-[-0.01em] ${costTint}`}>
        {item.cost.value}
        <small className="block font-normal text-ink-3 font-mono text-[10.5px] mt-0.5">{item.cost.sub}</small>
      </div>
      <button className="font-mono text-[11px] px-3 py-1.5 rounded-full bg-ink text-paper font-medium hover:bg-[#27272a] transition-colors">
        {item.ctaLabel}
      </button>
    </Link>
  )
}

function PrepCard({ items }: { items: PrepItem[] }) {
  return (
    <div className="bg-paper border border-line rounded-[12px] p-5">
      <header className="flex items-center justify-between mb-3">
        <h3 className="text-[15px] font-semibold tracking-[-0.015em]">
          Today&apos;s prep <span className="font-mono text-[10.5px] text-ink-3 font-normal">· {items.length} {items.length === 1 ? 'card' : 'cards'}</span>
        </h3>
        <Link href="/prep" className="font-mono text-[10.5px] text-gold-2 border-b border-dashed border-current">Open prep →</Link>
      </header>
      {items.length === 0 ? (
        <p className="text-[13px] text-ink-3 py-4 text-center">No prep needed today.</p>
      ) : items.map(it => {
        const pct = it.parLevel > 0 ? Math.min(100, (it.onHand / it.parLevel) * 100) : 100
        const tone = it.priority === '911' ? 'bad' : it.priority === 'NEEDED_TODAY' ? 'warn' : 'ok'
        return (
          <div key={it.id} className="grid grid-cols-[1fr_64px_auto] items-center gap-2.5 py-2 border-b border-dashed border-line last:border-0 text-[13px]">
            <div className="font-medium text-ink tracking-[-0.005em] truncate">{it.name}</div>
            <div className="h-[5px] rounded-full bg-bg-2 overflow-hidden">
              <div className={`h-full rounded-full ${tone === 'bad' ? 'bg-red' : tone === 'warn' ? 'bg-gold' : 'bg-green'}`} style={{ width: `${pct}%` }} />
            </div>
            <div className={`font-mono text-[11px] tracking-[0] tabular-nums whitespace-nowrap ${tone === 'bad' ? 'text-red-text' : tone === 'warn' ? 'text-gold-2' : 'text-ink-3'}`}>
              {it.onHand.toFixed(it.onHand % 1 === 0 ? 0 : 1)} / {it.parLevel.toFixed(it.parLevel % 1 === 0 ? 0 : 1)} {it.unit}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function CountCard({ sessions }: { sessions: CountSession[] }) {
  const recent = [...sessions]
    .filter(s => s.status === 'FINALIZED' || s.status === 'IN_PROGRESS')
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .slice(0, 4)
  return (
    <div className="bg-paper border border-line rounded-[12px] p-5">
      <header className="flex items-center justify-between mb-3">
        <h3 className="text-[15px] font-semibold tracking-[-0.015em]">
          Counts <span className="font-mono text-[10.5px] text-ink-3 font-normal">· recent activity</span>
        </h3>
        <Link href="/count" className="font-mono text-[10.5px] text-gold-2 border-b border-dashed border-current">Schedule count →</Link>
      </header>
      {recent.length === 0 ? (
        <p className="text-[13px] text-ink-3 py-4 text-center">No counts yet. Start one →</p>
      ) : recent.map(s => {
        const ref = new Date(s.finalizedAt ?? s.startedAt)
        const days = Math.floor((Date.now() - ref.getTime()) / 86_400_000)
        const tone = days > 4 ? 'bad' : days > 2 ? 'warn' : 'ok'
        return (
          <div key={s.id} className="grid grid-cols-[1fr_auto] items-center gap-2 py-2 border-b border-dashed border-line last:border-0 text-[13px]">
            <div className="min-w-0">
              <div className="font-medium text-ink tracking-[-0.005em] truncate">{s.label || 'Count'}</div>
              <div className="font-mono text-[10.5px] text-ink-3 mt-0.5">{s.countedBy} · {s.status === 'IN_PROGRESS' ? 'in progress' : days === 0 ? 'today' : `${days}d ago`}</div>
            </div>
            <div className={`font-mono text-[11px] tracking-[0] whitespace-nowrap ${tone === 'bad' ? 'text-red-text' : tone === 'warn' ? 'text-gold-2' : 'text-green-text'}`}>
              {s.status === 'IN_PROGRESS' ? 'active' : 'finalized'}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function LoopStrip({ phase, weeklyRevenue }: { phase: number; weeklyRevenue?: number }) {
  const labels = ['01 IN','02 HOLD','03 BUILD','04 PLAN','05 MOVE','06 TRUTH']
  return (
    <div className="bg-ink text-paper rounded-[12px] px-5 py-4 flex items-center gap-5 flex-wrap">
      <span className="font-mono text-[10.5px] text-gold uppercase tracking-[0.04em] font-semibold whitespace-nowrap">↻ THE LOOP</span>
      <div className="text-[12.5px] text-zinc-300 tracking-[-0.005em] flex-1 min-w-[300px] [&_b]:text-paper [&_b]:font-medium">
        You&apos;re at <b>{labels[phase]}</b> — overnight invoices write prices, prep starts, sales drain theoretical, counts close the loop weekly.
        {typeof weeklyRevenue === 'number' && weeklyRevenue > 0 && <> WTD revenue: <b>{formatCurrency(weeklyRevenue)}</b>.</>}
      </div>
      <div className="hidden xl:flex items-center gap-1.5 font-mono text-[11px] text-zinc-500">
        {labels.map((label, i) => (
          <span key={label} className="flex items-center gap-1.5">
            <span className={`px-2.5 py-1 border rounded-full ${i === phase ? 'bg-gold text-ink border-gold font-semibold' : 'border-zinc-800 text-zinc-500'}`}>{label}</span>
            {i < labels.length - 1 && <span className="text-zinc-700">→</span>}
          </span>
        ))}
      </div>
    </div>
  )
}

function RailCard({ icon, iconTint, title, children }: {
  icon: React.ReactNode; iconTint: 'amber' | 'blue' | 'neutral'; title: string; children: React.ReactNode
}) {
  const iconCls = iconTint === 'amber' ? 'bg-gold-soft text-gold-2'
    : iconTint === 'blue' ? 'bg-blue-soft text-blue-text'
    : 'bg-bg-2 text-ink-3'
  return (
    <div className="bg-paper border border-line rounded-[12px] p-4">
      <h4 className="text-[13px] font-semibold tracking-[-0.01em] flex items-center gap-2 mb-2">
        <span className={`w-5 h-5 rounded-md grid place-items-center ${iconCls}`}>{icon}</span>
        {title}
      </h4>
      <div className="text-[13px] leading-[1.5] text-ink-2 tracking-[-0.005em] [&_b]:text-ink [&_b]:font-semibold">
        {children}
      </div>
    </div>
  )
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function greetingFor(d: Date): 'morning' | 'afternoon' | 'evening' {
  const h = d.getHours()
  if (h < 12) return 'morning'
  if (h < 18) return 'afternoon'
  return 'evening'
}

function nextServiceCutoff(d: Date): Date {
  const cutoff = new Date(d)
  if (d.getHours() < 17) {
    cutoff.setHours(17, 0, 0, 0)
  } else {
    cutoff.setDate(d.getDate() + 1)
    cutoff.setHours(11, 0, 0, 0)
  }
  return cutoff
}

function fmtCrumbDate(d: Date): string {
  return d.toLocaleString('en-US', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).toUpperCase()
}

function loopPhase(d: Date): number {
  const h = d.getHours()
  if (h < 6) return 0   // IN — overnight
  if (h < 9) return 1   // HOLD
  if (h < 12) return 2  // BUILD
  if (h < 15) return 3  // PLAN
  if (h < 21) return 4  // MOVE
  return 5              // TRUTH
}

```
