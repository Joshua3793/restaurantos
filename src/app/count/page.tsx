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
import { useRc } from '@/contexts/RevenueCenterContext'
import { rcHex } from '@/lib/rc-colors'
import {
  enqueueCountMutation, flushCountQueue, loadCountQueue,
  saveCountSessionCache, pendingCountForSession,
} from '@/lib/count-offline'
import {
  getCountableUoms, convertCountQtyToBase, convertBaseToCountUom,
} from '@/lib/count-uom'

// ─── Types ────────────────────────────────────────────────────────────────────

interface InventoryItemRef {
  id: string
  itemName: string
  category: string
  baseUnit: string
  purchaseUnit: string
  qtyPerPurchaseUnit: number
  packSize: number
  packUOM: string
  countUOM: string
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
    IN_PROGRESS:    'bg-gold/15 text-gold',
    PENDING_REVIEW: 'bg-amber-100 text-amber-700',
    UPDATING:       'bg-violet-100 text-violet-700',
    FINALIZED:      'bg-green-100 text-green-700',
    CANCELLED:      'bg-gray-100 text-gray-500',
  }
  const labels: Record<string, string> = {
    IN_PROGRESS: 'In progress', PENDING_REVIEW: 'Pending review',
    UPDATING: 'Updating changes', FINALIZED: 'Finalized', CANCELLED: 'Cancelled',
  }
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${map[status] ?? 'bg-gray-100 text-gray-500'}`}>
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
    const q = searchQuery.trim().toLowerCase()
    return lines.filter(l => {
      if (catFilter && l.inventoryItem.category !== catFilter) return false
      if (locFilter) {
        const loc = l.inventoryItem.location ?? l.inventoryItem.storageArea?.name ?? ''
        if (!loc.toLowerCase().includes(locFilter.toLowerCase())) return false
      }
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
    await fetch(`/api/count/sessions/${active!.id}/lines/${line.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ countedQty: qty }),
    })
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
    // Navigate back to list right away — don't wait for heavy processing
    await loadSessions()
    setView('list'); setActive(null); setFinalizing(false)
    // Fire finalize in background — polling will detect when it flips to FINALIZED
    fetch(`/api/count/sessions/${active.id}/finalize`, { method: 'POST' })
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
      if (res.ok && data.added > 0) {
        // Merge new lines into active session
        setActive(prev => prev ? { ...prev, lines: [...(prev.lines ?? []), ...data.lines] } : prev)
        setToast(`${data.added} new item${data.added === 1 ? '' : 's'} added`)
      } else {
        setToast('Already up to date')
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
        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Label</label>
        <input
          value={form.label}
          onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
          placeholder={`e.g. Full count ${fmtDate(new Date().toISOString())}`}
          className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
        />
      </div>
      <div>
        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
          Who&apos;s counting <span className="text-red-500">*</span>
        </label>
        <input
          required
          autoFocus
          value={form.countedBy}
          onChange={e => setForm(f => ({ ...f, countedBy: e.target.value }))}
          placeholder="Name"
          className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
        />
      </div>
      <div>
        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Count type</label>
        <div className="grid grid-cols-2 gap-2">
          {(['FULL', 'PARTIAL'] as const).map(t => (
            <button key={t} type="button"
              onClick={() => {
                setForm(f => ({ ...f, type: t }))
                // Reset to active RC when switching to PARTIAL (no "All" option there)
                if (t === 'PARTIAL' && !selectedRcId) setSelectedRcId(activeRcId ?? '')
              }}
              className={`py-3 rounded-xl text-sm font-medium border transition-colors ${
                form.type === t ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
              }`}
            >
              {t === 'FULL' ? 'Full count' : 'Partial count'}
            </button>
          ))}
        </div>
      </div>
      {form.type === 'PARTIAL' && (
        <div>
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Areas to count</label>
          {storageAreas.length === 0 ? (
            <p className="text-xs text-gray-400">No storage areas configured yet.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {storageAreas.map(area => {
                const on = form.areas.includes(area.id)
                return (
                  <button key={area.id} type="button"
                    onClick={() => setForm(f => ({
                      ...f, areas: on ? f.areas.filter(x => x !== area.id) : [...f.areas, area.id],
                    }))}
                    className={`px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                      on ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
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
        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Date</label>
        <input
          type="date"
          value={form.sessionDate}
          onChange={e => setForm(f => ({ ...f, sessionDate: e.target.value }))}
          className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
        />
      </div>
      {revenueCenters.length > 1 && (
        <div>
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Revenue Center</label>
          <select
            value={selectedRcId}
            onChange={e => setSelectedRcId(e.target.value)}
            className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
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
        <form id="new-session-form" onSubmit={handleCreate} className="md:hidden flex flex-col min-h-screen bg-gray-50">
          <div className="sticky top-0 z-10 bg-white border-b border-gray-100 shadow-sm px-4 py-4 flex items-center gap-3">
            <button type="button" onClick={cancelNew} className="p-1 -ml-1 text-gray-500 hover:text-gray-800">
              <ArrowLeft size={20} />
            </button>
            <h1 className="text-lg font-bold text-gray-900 flex-1">New count session</h1>
          </div>
          <div className="flex-1 px-4 pt-6 pb-48">
            {NewSessionFields}
          </div>
          <div className="fixed bottom-20 inset-x-0 bg-white border-t border-gray-100 px-4 py-4 flex gap-3 z-40">
            <button type="button" onClick={cancelNew}
              className="flex-1 py-3.5 border border-gray-200 rounded-2xl text-sm font-medium text-gray-700 hover:bg-gray-50">
              Cancel
            </button>
            <button type="submit"
              className="flex-[2] py-3.5 bg-green-600 text-white rounded-2xl text-sm font-semibold hover:bg-green-700 transition-colors">
              Start count →
            </button>
          </div>
        </form>

        {/* ── Desktop: centered card ── */}
        <div className="hidden md:flex flex-col gap-6 max-w-xl">
          <div className="flex items-center gap-3">
            <button type="button" onClick={cancelNew} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500">
              <ArrowLeft size={18} />
            </button>
            <h1 className="text-xl font-bold text-gray-900">New count session</h1>
          </div>
          <form onSubmit={handleCreate} className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-6">
            {NewSessionFields}
            <div className="flex gap-3 pt-1">
              <button type="button" onClick={cancelNew}
                className="flex-1 py-2.5 border border-gray-200 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50">
                Cancel
              </button>
              <button type="submit"
                className="flex-[2] py-2.5 bg-green-600 text-white rounded-xl text-sm font-semibold hover:bg-green-700 transition-colors">
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
  if (view === 'list') return (
    <div className="max-w-4xl">
      {toast && <Toast msg={toast} onDone={() => setToast(null)} />}

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Stock Count</h1>
          <p className="text-sm text-gray-400 mt-0.5">Track inventory accuracy and COGS by counting your stock regularly.</p>
        </div>
        <button
          onClick={() => setView('new')}
          className="flex items-center gap-2 bg-green-600 text-white px-4 py-2.5 rounded-xl text-sm font-semibold hover:bg-green-700 transition-colors"
        >
          <Plus size={16} /> Start Count
        </button>
      </div>

      {/* Session list */}
      {sessions.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <ClipboardList size={44} className="mx-auto mb-4 opacity-30" />
          <p className="font-semibold text-gray-700 text-base">No count sessions yet</p>
          <p className="text-sm mt-1 mb-5">Regular stock counts keep your inventory accurate and food costs on target.</p>
          <button
            onClick={() => setView('new')}
            className="inline-flex items-center gap-2 bg-gold text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:bg-[#a88930] transition-colors"
          >
            <Plus size={16} /> Start First Count
          </button>
        </div>
      ) : (
        <>
        {/* Mobile session list */}
        <div className="flex sm:hidden flex-col gap-2">
          {sessions.map(s => {
            const counts = s.counts ?? { total: 0, counted: 0, skipped: 0 }
            const isUpdating = s.status === 'UPDATING'
            const handleCardTap = () => {
              setSessionMenuId(null)
              if (s.status === 'IN_PROGRESS' || s.status === 'PENDING_REVIEW') openSession(s, 'count')
              else if (s.status === 'FINALIZED') openSession(s, 'review')
            }
            return (
              <div key={s.id} className="bg-white rounded-2xl shadow-sm border border-gray-100 border-l-4 flex items-stretch"
                style={{ borderLeftColor: SESSION_ACCENT[s.status] ?? '#d1d5db' }}>
                {/* Card body — tappable to navigate */}
                <div
                  className={`flex-1 min-w-0 px-4 py-3 ${!isUpdating && s.status !== 'CANCELLED' ? 'cursor-pointer' : 'cursor-default'}`}
                  onClick={!isUpdating && s.status !== 'CANCELLED' ? handleCardTap : undefined}
                >
                  <div className="flex items-center gap-2 pr-1">
                    <span className="flex-1 text-sm font-semibold text-gray-900 truncate">
                      {s.label || (s.type === 'FULL' ? 'Full count' : 'Partial count')}
                    </span>
                    <StatusBadge status={s.status} />
                  </div>
                  <div className="flex items-center justify-between mt-1 gap-2">
                    <span className="text-xs text-gray-400 truncate">
                      {fmtDate(s.sessionDate)} · {s.countedBy} · {s.status === 'FINALIZED' ? `${counts.total} items` : `${counts.counted}/${counts.total} items`}
                    </span>
                    {s.status === 'IN_PROGRESS'    && <span className="text-xs font-bold text-gold shrink-0">Continue →</span>}
                    {s.status === 'PENDING_REVIEW' && <span className="text-xs font-bold text-amber-600 shrink-0">Review →</span>}
                    {s.status === 'FINALIZED'      && <span className="text-xs font-bold text-green-700 shrink-0">Report</span>}
                    {isUpdating && (
                      <span className="flex items-center gap-1 text-xs text-violet-600 shrink-0">
                        <span className="inline-block w-2.5 h-2.5 rounded-full border-2 border-violet-400 border-t-transparent animate-spin" />
                        Processing…
                      </span>
                    )}
                  </div>
                  {s.status === 'FINALIZED' && Number(s.totalCountedValue) > 0 && (
                    <div className="mt-1">
                      <span className="text-sm font-semibold text-gray-800">
                        {formatCurrency(Number(s.totalCountedValue))}
                      </span>
                      <span className="text-xs text-gray-400 ml-1">total value</span>
                    </div>
                  )}
                </div>
                {/* ⋯ menu trigger — separate flex column so it never overlaps card text */}
                <div className="relative flex items-center pr-2">
                  <button
                    onClick={e => { e.stopPropagation(); setSessionMenuId(sessionMenuId === s.id ? null : s.id) }}
                    className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100"
                  >
                    <MoreHorizontal size={16} />
                  </button>
                  {sessionMenuId === s.id && (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setSessionMenuId(null)} />
                      <div className="absolute right-0 top-full mt-1 w-48 bg-white border border-gray-200 rounded-xl shadow-lg z-50 overflow-hidden">
                        <button
                          onClick={e => { e.stopPropagation(); setSessionMenuId(null); openEditModal(s) }}
                          className="flex items-center gap-2 w-full px-4 py-3 text-sm text-gray-700 hover:bg-gray-50 border-b border-gray-100"
                        >
                          <Pencil size={13} /> Edit metadata
                        </button>
                        <button
                          onClick={e => { e.stopPropagation(); setSessionMenuId(null); handleReopenAndEdit(s) }}
                          className="flex items-center gap-2 w-full px-4 py-3 text-sm text-gray-700 hover:bg-gray-50 border-b border-gray-100"
                        >
                          <ClipboardList size={13} /> {s.status === 'FINALIZED' ? 'Reopen & edit' : 'Edit counts'}
                        </button>
                        <button
                          onClick={e => { e.stopPropagation(); setSessionMenuId(null); setDeleteTarget(s) }}
                          className="flex items-center gap-2 w-full px-4 py-3 text-sm text-red-500 hover:bg-red-50"
                        >
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
        <div className="hidden sm:block bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
          {/* Table header */}
          <div className="grid grid-cols-[120px_1fr_80px_110px_110px_160px] gap-3 px-5 py-2.5 bg-gray-50 border-b border-gray-100 text-xs font-semibold text-gray-400 uppercase tracking-wide">
            <span>Date</span>
            <span>Session</span>
            <span>Type</span>
            <span>Progress</span>
            <span className="text-right">Value</span>
            <span className="text-right">Actions</span>
          </div>
          <div className="divide-y divide-gray-50">
          {sessions.map(s => {
            const counts = s.counts ?? { total: 0, counted: 0, skipped: 0 }
            const pct = counts.total > 0 ? Math.round((counts.counted / counts.total) * 100) : 0
            return (
              <div key={s.id} className="grid grid-cols-[120px_1fr_80px_110px_110px_160px] gap-3 px-5 py-3.5 items-center hover:bg-gray-50/60 transition-colors">
                {/* Date */}
                <div>
                  <div className="text-sm font-medium text-gray-700">{fmtDate(s.sessionDate)}</div>
                  <div className="text-xs text-gray-400 mt-0.5">{s.countedBy}</div>
                </div>
                {/* Label + status */}
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-gray-900 truncate">
                      {s.label || (s.type === 'FULL' ? 'Full count' : 'Partial count')}
                    </span>
                    <StatusBadge status={s.status} />
                  </div>
                  {s.status === 'FINALIZED' && (
                    <div className="text-xs text-gray-400 mt-0.5">{counts.total} items counted</div>
                  )}
                </div>
                {/* Type */}
                <div className="text-xs text-gray-500">{s.type === 'FULL' ? 'Full' : 'Partial'}</div>
                {/* Progress */}
                <div>
                  {s.status === 'FINALIZED' ? (
                    <span className="text-xs text-green-600 font-medium">Complete</span>
                  ) : (
                    <>
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="text-xs text-gray-500">{counts.counted}/{counts.total}</span>
                        <span className="text-xs text-gray-400">{pct}%</span>
                      </div>
                      <div className="h-1.5 bg-gray-100 rounded-full w-full">
                        <div className="h-1.5 bg-green-400 rounded-full transition-all" style={{ width: `${pct}%` }} />
                      </div>
                    </>
                  )}
                </div>
                {/* Value */}
                <div className="text-right">
                  {s.status === 'FINALIZED' && Number(s.totalCountedValue) > 0 ? (
                    <span className="text-sm font-semibold text-gray-800">
                      {formatCurrency(Number(s.totalCountedValue))}
                    </span>
                  ) : (
                    <span className="text-xs text-gray-300">—</span>
                  )}
                </div>
                {/* Actions */}
                <div className="flex items-center justify-end gap-1">
                  {s.status === 'IN_PROGRESS' && (
                    <button onClick={() => openSession(s, 'count')}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-gold hover:bg-[#a88930] transition-colors">
                      Continue →
                    </button>
                  )}
                  {s.status === 'PENDING_REVIEW' && (
                    <button onClick={() => openSession(s, 'count')}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-amber-500 hover:bg-amber-600 transition-colors">
                      Review →
                    </button>
                  )}
                  {s.status === 'UPDATING' && (
                    <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-violet-600 bg-violet-50 border border-violet-200">
                      <span className="w-3 h-3 rounded-full border-2 border-violet-400 border-t-transparent animate-spin" />
                      Updating…
                    </span>
                  )}
                  {s.status === 'FINALIZED' && (
                    <button onClick={() => openSession(s, 'review')}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold text-green-700 bg-green-50 hover:bg-green-100 border border-green-200 transition-colors">
                      Report
                    </button>
                  )}
                  <button onClick={e => { e.stopPropagation(); openEditModal(s) }} title="Edit"
                    className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-300 hover:text-blue-500 transition-colors">
                    <Pencil size={13} />
                  </button>
                  <button onClick={e => { e.stopPropagation(); handleReopenAndEdit(s) }}
                    title={s.status === 'FINALIZED' ? 'Reopen & edit' : 'Edit counts'}
                    className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-300 hover:text-amber-500 transition-colors">
                    <ClipboardList size={13} />
                  </button>
                  <button onClick={e => { e.stopPropagation(); setDeleteTarget(s) }} title="Delete"
                    className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-300 hover:text-red-500 transition-colors">
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            )
          })}
          </div>
        </div>
        </>
      )}

      {/* Count cadence reminder — shown below session list when sessions exist */}
      {sessions.length > 0 && (() => {
        const lastFinalized = sessions.find(s => s.status === 'FINALIZED')
        const nextCountDate = new Date()
        if (lastFinalized) {
          const last = new Date(lastFinalized.sessionDate)
          nextCountDate.setTime(last.getTime())
          nextCountDate.setDate(nextCountDate.getDate() + 7)
        }
        const isOverdue = nextCountDate <= new Date()
        const dateStr = nextCountDate.toLocaleDateString('en-CA', { weekday: 'long', month: 'short', day: 'numeric' })
        return (
          <div className={`rounded-xl border px-4 py-3 flex items-center justify-between gap-3 ${isOverdue ? 'bg-amber-50 border-amber-100' : 'bg-gray-50 border-gray-100'}`}>
            <div>
              <p className={`text-xs font-medium ${isOverdue ? 'text-amber-700' : 'text-gray-600'}`}>
                {isOverdue ? 'Count overdue' : 'Next count recommended'}
              </p>
              <p className={`text-sm font-semibold ${isOverdue ? 'text-amber-900' : 'text-gray-700'}`}>{dateStr}</p>
              <p className="text-xs text-gray-400 mt-0.5">Count weekly for accurate COGS and inventory tracking</p>
            </div>
            <button
              onClick={() => setView('new')}
              className={`shrink-0 flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition-colors ${isOverdue ? 'bg-amber-600 text-white hover:bg-amber-700' : 'bg-gold text-white hover:bg-[#a88930]'}`}
            >
              <Plus size={14} /> Start Count
            </button>
          </div>
        )
      })()}

      {/* ── Delete confirmation modal ───────────────────────────────────────── */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center shrink-0">
                <Trash2 size={18} className="text-red-600" />
              </div>
              <div>
                <h3 className="font-semibold text-gray-900">Delete count session?</h3>
                <p className="text-xs text-gray-500 mt-0.5">&ldquo;{deleteTarget.label || 'Untitled'}&rdquo; — {fmtDate(deleteTarget.sessionDate)}</p>
              </div>
            </div>
            {deleteTarget.status === 'FINALIZED' && (
              <div className="bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 text-xs text-amber-700 mb-3">
                This session is finalized. Deleting it won&apos;t revert inventory stock levels.
              </div>
            )}
            <div className="flex gap-3 mt-4">
              <button onClick={() => setDeleteTarget(null)}
                className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50">
                Cancel
              </button>
              <button onClick={handleDeleteSession} disabled={deleting}
                className="flex-1 px-4 py-2.5 rounded-xl bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-60">
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Edit session metadata modal ────────────────────────────────────── */}
      {editTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-gray-900">Edit session details</h3>
              <button onClick={() => setEditTarget(null)} className="p-1 rounded-lg hover:bg-gray-100 text-gray-400">
                <X size={16} />
              </button>
            </div>
            <form onSubmit={handleEditSession} className="space-y-3">
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">Label</label>
                <input value={editLabel} onChange={e => setEditLabel(e.target.value)}
                  placeholder="e.g. Full count Apr 12"
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500" />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">Counted by</label>
                <input value={editCountedBy} onChange={e => setEditCountedBy(e.target.value)} required
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500" />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">Date</label>
                <input type="date" value={editDate} onChange={e => setEditDate(e.target.value)}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500" />
              </div>
              <div className="flex gap-3 pt-1">
                <button type="button" onClick={() => setEditTarget(null)}
                  className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50">
                  Cancel
                </button>
                <button type="submit"
                  className="flex-1 px-4 py-2.5 rounded-xl bg-green-600 text-white text-sm font-medium hover:bg-green-700">
                  Save
                </button>
              </div>
            </form>
          </div>
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

      // inputQty is in line.selectedUom; expectedQty is in baseUnit — convert before comparing
      const inputBase = convertCountQtyToBase(inputQty, line.selectedUom, line.inventoryItem)
      const liveVar = isOpen && Number(line.expectedQty) > 0
        ? ((inputBase - Number(line.expectedQty)) / Number(line.expectedQty)) * 100
        : null

      if (isSkipped) return (
        <div key={line.id} id={`ln-${line.id}`}
          ref={el => { cardRefs.current[`d-${line.id}`] = el }}
          className="mx-4 mb-2 border border-gray-100 bg-gray-50 rounded-xl"
        >
          <div className="flex items-center gap-3 px-4 py-3">
            <SkipForward size={16} className="text-gray-400 shrink-0" />
            <span className="flex-1 text-sm text-gray-400 line-through">{line.inventoryItem.itemName}</span>
            <button
              onClick={() => unskipLine(line)}
              className="text-xs text-blue-500 font-medium hover:text-blue-700 px-2 py-1 rounded hover:bg-blue-50"
            >
              Count it
            </button>
          </div>
        </div>
      )

      if (isCounted && !isOpen) {
        const vPct = line.variancePct !== null ? Number(line.variancePct) : null
        const large = vPct !== null && Math.abs(vPct) > 15
        return (
          <div key={line.id} id={`ln-${line.id}`}
            ref={el => { cardRefs.current[`d-${line.id}`] = el }}
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
          ref={el => { cardRefs.current[`d-${line.id}`] = el }}
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
              {/* UOM selector */}
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
                          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-medium text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-green-400"
                        >
                          {uoms.map(opt => (
                            <option key={opt.label} value={opt.label}>{uomOptionLabel(opt, line.inventoryItem.baseUnit)}</option>
                          ))}
                        </select>
                      </div>
                    )}

                    {/* Expected + live variance */}
                    <div className="text-xs text-gray-500 mb-3 flex items-center gap-1.5">
                      <span>Expected: {expectedDisplay.toFixed(2)} {line.selectedUom}</span>
                      {liveVar !== null && (
                        <span className={`font-medium ${varColor(liveVar)}`}>
                          · {liveVar > 0 ? '+' : ''}{liveVar.toFixed(1)}%
                        </span>
                      )}
                    </div>
                  </>
                )
              })()}

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

              {/* UOM label below stepper */}
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

    const renderMobileLine = (line: Line) => {
      const isOpen    = openId === line.id
      const isCounted = line.countedQty !== null && !line.skipped
      const isSkipped = line.skipped
      const locLabel  = line.inventoryItem.location ?? line.inventoryItem.storageArea?.name
      const subtitle  = [line.inventoryItem.category, locLabel].filter(Boolean).join(' · ')

      const inputBase2 = convertCountQtyToBase(inputQty, line.selectedUom, line.inventoryItem)
      const liveVar = isOpen && Number(line.expectedQty) > 0
        ? ((inputBase2 - Number(line.expectedQty)) / Number(line.expectedQty)) * 100
        : null

      const dotColor = isSkipped
        ? 'bg-gray-300'
        : isCounted
          ? (line.variancePct !== null && Math.abs(Number(line.variancePct)) > 15 ? 'bg-amber-400' : 'bg-green-500')
          : 'bg-gray-300'

      const rowBg = isSkipped
        ? 'bg-gray-50 border-gray-100 opacity-60'
        : isCounted
          ? (line.variancePct !== null && Math.abs(Number(line.variancePct)) > 15
              ? 'bg-amber-50/60 border-amber-200'
              : 'bg-green-50/60 border-green-200')
          : isOpen
            ? 'border-green-400 border-2 bg-white'
            : 'bg-white border-gray-200'

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
              <div className={`text-sm font-medium truncate ${isSkipped ? 'line-through text-gray-400' : 'text-gray-900'}`}>
                {line.inventoryItem.itemName}
              </div>
              {subtitle && <div className="text-xs text-gray-400 mt-0.5">{subtitle}</div>}
            </div>
            <div className="text-right shrink-0">
              {isSkipped ? (
                <button
                  onClick={e => { e.stopPropagation(); unskipLine(line) }}
                  className="text-xs text-blue-500 font-medium px-2 py-1 rounded hover:bg-blue-50"
                >
                  Count it
                </button>
              ) : isCounted ? (
                <>
                  <div className="text-sm font-semibold text-gray-900">
                    {Number(line.countedQty).toFixed(1)} {line.selectedUom}
                  </div>
                  {line.variancePct !== null && (
                    <div className={`text-xs ${varColor(line.variancePct)}`}>
                      {Number(line.variancePct) >= 0 ? '+' : ''}{Number(line.variancePct).toFixed(1)}%
                    </div>
                  )}
                </>
              ) : (
                <span className="text-xs text-gray-300">— —</span>
              )}
            </div>
          </div>

          {isOpen && (
            <div className="px-3 pb-3 pt-1 border-t border-gray-100">
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
                          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-medium text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-green-400"
                        >
                          {uoms.map(opt => (
                            <option key={opt.label} value={opt.label}>{uomOptionLabel(opt, line.inventoryItem.baseUnit)}</option>
                          ))}
                        </select>
                      </div>
                    )}
                    <div className="text-xs text-gray-500 mb-2 flex items-center gap-1.5">
                      <span>Expected: {expectedDisplay.toFixed(2)} {line.selectedUom}</span>
                      {liveVar !== null && (
                        <span className={`font-medium ${varColor(liveVar)}`}>
                          · {liveVar > 0 ? '+' : ''}{liveVar.toFixed(1)}%
                        </span>
                      )}
                    </div>
                  </>
                )
              })()}
              <div className="flex items-center gap-2 mb-2">
                <button
                  onClick={() => setInputQty(v => Math.max(0, Math.round((v - 1) * 100) / 100))}
                  className="w-12 h-12 rounded-xl bg-gray-100 flex items-center justify-center shrink-0"
                >
                  <Minus size={18} className="text-gray-700" />
                </button>
                <input
                  type="number"
                  value={inputQty}
                  onChange={e => setInputQty(parseFloat(e.target.value) || 0)}
                  className="flex-1 min-w-0 h-12 text-center text-2xl font-bold border-2 border-green-400 rounded-xl focus:outline-none"
                  min={0} step={0.1}
                />
                <button
                  onClick={() => setInputQty(v => Math.round((v + 1) * 100) / 100)}
                  className="w-12 h-12 rounded-xl bg-gray-100 flex items-center justify-center shrink-0"
                >
                  <Plus size={18} className="text-gray-700" />
                </button>
              </div>
              <div className="text-center text-xs text-gray-500 mb-3">{line.selectedUom}</div>
              <div className="flex gap-2">
                <button
                  onClick={() => confirmLine(line, inputQty)}
                  className="flex-1 h-11 bg-green-500 text-white rounded-xl font-semibold text-sm flex items-center justify-center gap-1.5"
                >
                  <Check size={15} /> Confirm
                </button>
                <button
                  onClick={() => skipLine(line)}
                  className="px-4 h-11 border border-gray-200 rounded-xl text-sm text-gray-500 flex items-center gap-1.5"
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
      </>
    )

    const sidebarNavBtn = (active: boolean, onClick: () => void, label: React.ReactNode) => (
      <button onClick={onClick}
        className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${active ? 'bg-gray-900 text-white font-medium' : 'text-gray-600 hover:bg-gray-100'}`}>
        {label}
      </button>
    )

    return (
      <div>
        {toast && <Toast msg={toast} onDone={() => setToast(null)} />}

        {/* ── Sticky top bar ─────────────────────────────────────────────────── */}
        <div className="sticky top-0 z-20 bg-white border-b border-gray-100 shadow-sm px-4 py-3 flex items-center gap-3 -mx-4 sm:-mx-6 md:-mx-8 px-4 sm:px-6 md:px-8">
          <button onClick={backFromCount} className="-ml-1 p-1 text-gray-500 hover:text-gray-800">
            <ArrowLeft size={20} />
          </button>
          <div className="flex-1 min-w-0">
            <span className="text-sm font-semibold text-gray-900 truncate block">{active.label}</span>
            <span className="text-xs text-gray-400 hidden md:block">{active.countedBy} · {fmtDate(active.sessionDate)}</span>
          </div>
          <span className="shrink-0 bg-gray-100 text-gray-700 rounded-full px-3 py-1 text-xs font-medium whitespace-nowrap">
            {counted} / {total} done
          </span>
          <button
            onClick={handleSync}
            disabled={syncing}
            title="Sync with inventory — adds items created after this session started"
            className="shrink-0 flex items-center gap-1.5 border border-gray-200 text-gray-700 text-xs font-semibold px-3 py-1.5 rounded-lg hover:bg-gray-50 whitespace-nowrap disabled:opacity-50"
          >
            <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
            <span className="hidden sm:inline">Sync</span>
          </button>
          <button
            onClick={openAddItem}
            className="shrink-0 flex items-center gap-1.5 border border-gray-200 text-gray-700 text-xs font-semibold px-3 py-1.5 rounded-lg hover:bg-gray-50 whitespace-nowrap"
          >
            <Plus size={14} />
            <span className="hidden sm:inline">Add item</span>
          </button>
          <button
            onClick={() => setView('review')}
            className="shrink-0 bg-gold text-white text-xs font-semibold px-3 py-1.5 rounded-lg hover:bg-[#a88930] whitespace-nowrap"
          >
            Review &amp; finish
          </button>
        </div>

        {/* ── Add Item Modal ─────────────────────────────────────────────────── */}
        {showAddItem && (
          <div className="fixed inset-0 z-50 flex items-start justify-center p-4 overflow-y-auto" onClick={() => setShowAddItem(false)}>
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
        <div className="h-1.5 bg-gray-200 -mx-4 sm:-mx-6 md:-mx-8">
          <div
            className="h-1.5 bg-green-500 transition-all duration-300"
            style={{ width: `${total > 0 ? (counted / total) * 100 : 0}%` }}
          />
        </div>

        {/* ── Offline banner ─────────────────────────────────────────────────── */}
        {(isOffline || offlineSyncing) && (
          <div className={`flex items-center gap-2 px-4 py-2 text-sm font-medium ${
            offlineSyncing ? 'bg-gold/10 text-gold' : 'bg-amber-50 text-amber-800'
          }`}>
            <WifiOff size={14} className="shrink-0" />
            {offlineSyncing
              ? 'Syncing offline changes…'
              : `Offline — counts are saved locally${pendingCount > 0 ? ` (${pendingCount} pending)` : ''}`}
          </div>
        )}

        {/* ── Search bar ─────────────────────────────────────────────────────── */}
        <div className="sticky top-[57px] z-10 bg-white border-b border-gray-100 px-4 py-2 -mx-4 sm:-mx-6 md:-mx-8 px-4 sm:px-6 md:px-8">
          <div className="relative max-w-lg">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            <input
              type="text"
              placeholder="Search items…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-8 py-2 text-sm bg-gray-50 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-gold focus:bg-white transition-colors"
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
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
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-3 space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-xs font-semibold text-gray-500">Progress</span>
                <span className="text-xs text-gray-500">{counted}/{total} · {total > 0 ? Math.round((counted/total)*100) : 0}%</span>
              </div>
              <div className="h-2 bg-gray-100 rounded-full">
                <div className="h-2 bg-green-500 rounded-full transition-all duration-300"
                  style={{ width: `${total > 0 ? (counted/total)*100 : 0}%` }} />
              </div>
              <div className="grid grid-cols-2 gap-1 pt-1 text-xs text-gray-400">
                <span>{active.lines?.filter(l => l.countedQty !== null && !l.skipped).length ?? 0} counted</span>
                <span>{active.lines?.filter(l => l.skipped).length ?? 0} skipped</span>
              </div>
            </div>

            {/* Category filter */}
            <div>
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5 px-1">Category</p>
              <div className="space-y-0.5">
                {sidebarNavBtn(catFilter === null, () => setCatFilter(null),
                  <span className="flex items-center justify-between">All items <span className="text-xs opacity-50">{active.lines?.length ?? 0}</span></span>
                )}
                {categories.map(([cat, n]) =>
                  sidebarNavBtn(catFilter === cat, () => setCatFilter(catFilter === cat ? null : cat),
                    <span className="flex items-center justify-between">{cat} <span className="text-xs opacity-50">{n}</span></span>
                  )
                )}
              </div>
            </div>

            {/* Location filter */}
            {locations.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5 px-1">Location</p>
                <div className="space-y-0.5">
                  {sidebarNavBtn(locFilter === null, () => setLocFilter(null), 'All locations')}
                  {locations.map(loc => sidebarNavBtn(locFilter === loc, () => setLocFilter(locFilter === loc ? null : loc), loc))}
                </div>
              </div>
            )}

            {/* Status filter */}
            <div>
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5 px-1">Status</p>
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
                className="w-full text-xs text-gray-400 hover:text-gray-600 py-1.5 border border-gray-200 rounded-lg transition-colors"
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
                : 'bg-white text-gray-600 border-gray-200'
            }`}
          >
            Filter{(catFilter ? 1 : 0) + (locFilter ? 1 : 0) > 0 && ` · ${(catFilter ? 1 : 0) + (locFilter ? 1 : 0)}`}
          </button>
        </div>

        {/* ── Mobile filter bottom sheet ──────────────────────────────────────── */}
        {showCountFilterSheet && (
          <div className="fixed inset-0 z-50 flex items-end md:hidden" onClick={() => setShowCountFilterSheet(false)}>
            <div className="absolute inset-0 bg-black/40" />
            <div className="relative bg-white w-full rounded-t-2xl p-5 pb-8" onClick={e => e.stopPropagation()}>
              <div className="w-9 h-1 bg-gray-200 rounded-full mx-auto mb-4" />
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-bold text-gray-900">Filter</h3>
                <button onClick={() => setShowCountFilterSheet(false)}><X size={18} className="text-gray-400" /></button>
              </div>
              <div className="space-y-4">
                <div>
                  <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Category</div>
                  <div className="flex flex-wrap gap-2">
                    <button onClick={() => setCatFilter(null)}
                      className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${catFilter === null ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200'}`}
                    >All</button>
                    {categories.map(([cat]) => (
                      <button key={cat} onClick={() => setCatFilter(cat)}
                        className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${catFilter === cat ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200'}`}
                      >{cat}</button>
                    ))}
                  </div>
                </div>
                {locations.length > 0 && (
                  <div>
                    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Location</div>
                    <div className="flex flex-wrap gap-2">
                      <button onClick={() => setLocFilter(null)}
                        className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${locFilter === null ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200'}`}
                      >All</button>
                      {locations.map(loc => (
                        <button key={loc} onClick={() => setLocFilter(loc)}
                          className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${locFilter === loc ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200'}`}
                        >{loc}</button>
                      ))}
                    </div>
                  </div>
                )}
                <button
                  onClick={() => { setCatFilter(null); setLocFilter(null); setShowCountFilterSheet(false) }}
                  className="w-full py-2.5 border border-gray-200 rounded-xl text-sm text-gray-600 font-medium"
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
                      <span className="text-xs font-bold uppercase tracking-wider text-gray-500">{cat}</span>
                      <span className="text-xs text-gray-400">{catDone}/{lines.length}</span>
                      <div className="flex-1 max-w-[60px] h-1 bg-gray-100 rounded-full">
                        <div className="h-1 bg-green-400 rounded-full"
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
      Math.abs(Number(l.variancePct)) > 15
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
            className="-ml-1 p-1 text-gray-500 hover:text-gray-800"
          >
            <ArrowLeft size={20} />
          </button>
          <div className="flex-1">
            <h1 className="text-xl font-bold text-gray-900">Review Count</h1>
            <p className="text-xs text-gray-400 mt-0.5">{active.label} · {active.countedBy}</p>
          </div>
          {!isFinalized && (
            <button onClick={() => setView('count')} className="text-sm text-gold hover:text-gold font-medium shrink-0">
              ← Back to counting
            </button>
          )}
        </div>

        {/* Stats — mobile compact strip */}
        <div className="flex sm:hidden gap-2 mb-4">
          {[
            { val: countedLines.length.toString(),   label: 'Counted',  cls: 'bg-gold/10 text-gold'   },
            { val: flagged.length.toString(),         label: 'Flagged',  cls: flagged.length > 0 ? 'bg-amber-50 text-amber-700' : 'bg-gray-50 text-gray-500' },
            { val: formatCurrency(totalValue),        label: 'Value',    cls: 'bg-green-50 text-green-700' },
          ].map(s => (
            <div key={s.label} className={`flex-1 rounded-xl py-2 px-3 text-center ${s.cls}`}>
              <div className="text-base font-bold leading-tight">{s.val}</div>
              <div className="text-[10px] font-medium mt-0.5 opacity-80">{s.label}</div>
            </div>
          ))}
        </div>

        {/* Stats — desktop */}
        <div className="hidden sm:grid grid-cols-3 gap-3 mb-6">
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

        {/* Variance cards — mobile */}
        {sorted.length > 0 && (
          <div className="block sm:hidden space-y-2 mb-24">
            {sorted.map(l => {
              const vPct     = Number(l.variancePct ?? 0)
              const vCost    = Number(l.varianceCost ?? 0)
              const reliable = hasReliableVariance(Number(l.expectedQty), l.selectedUom, l.inventoryItem)
              const large    = reliable && Math.abs(vPct) > 15
              return (
                <div key={l.id} className="bg-white rounded-xl border border-gray-100 overflow-hidden flex">
                  {large && <div className="w-1 shrink-0 bg-amber-400" />}
                  <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 px-3 py-2.5 border-b border-gray-50">
                    {large && <AlertCircle size={13} className="text-amber-500 shrink-0" />}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold text-gray-900 truncate">{l.inventoryItem.itemName}</div>
                      <div className="text-xs text-gray-400">{l.inventoryItem.category}</div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 divide-x divide-gray-50">
                    <div className="px-3 py-2">
                      <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-0.5">Expected</div>
                      <div className="text-sm text-gray-700">{convertBaseToCountUom(Number(l.expectedQty), l.selectedUom, l.inventoryItem).toFixed(1)} {l.selectedUom}</div>
                    </div>
                    <div className="px-3 py-2">
                      <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-0.5">Counted</div>
                      <div className="text-sm font-semibold text-gray-900">{Number(l.countedQty).toFixed(1)} {l.selectedUom}</div>
                    </div>
                    <div className="px-3 py-2 border-t border-gray-50">
                      <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-0.5">Variance</div>
                      <div className={`text-sm font-semibold ${reliable ? varColor(vPct) : 'text-gray-400'}`}>
                        {reliable ? `${vPct >= 0 ? '+' : ''}${vPct.toFixed(1)}%` : '—'}
                      </div>
                    </div>
                    <div className="px-3 py-2 border-t border-gray-50">
                      <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-0.5">Cost impact</div>
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
          <div className="hidden sm:block bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden mb-6">
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
                const vPct     = Number(l.variancePct ?? 0)
                const vCost    = Number(l.varianceCost ?? 0)
                const reliable = hasReliableVariance(Number(l.expectedQty), l.selectedUom, l.inventoryItem)
                const large    = reliable && Math.abs(vPct) > 15
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
                    <span className="text-right text-sm text-gray-600">{convertBaseToCountUom(Number(l.expectedQty), l.selectedUom, l.inventoryItem).toFixed(1)} {l.selectedUom}</span>
                    <span className="text-right text-sm font-medium text-gray-900">{Number(l.countedQty).toFixed(1)} {l.selectedUom}</span>
                    <span className={`text-right text-sm font-semibold ${reliable ? varColor(vPct) : 'text-gray-400'}`}>
                      {reliable ? `${vPct >= 0 ? '+' : ''}${vPct.toFixed(1)}%` : '—'}
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

        {/* Footer — mobile fixed bar */}
        {!isFinalized && (
          <div className="fixed sm:hidden bottom-20 inset-x-0 bg-white border-t border-gray-100 px-4 py-3 z-30">
            <div className="flex gap-3">
              <button onClick={() => setView('count')}
                className="flex-1 py-3 border border-gray-200 rounded-2xl text-sm font-medium text-gray-600"
              >
                ← Back
              </button>
              <button onClick={handleFinalize} disabled={finalizing}
                className="flex-[2] py-3 bg-green-600 text-white rounded-2xl text-sm font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50"
              >
                <Check size={15} /> {finalizing ? 'Updating…' : 'Approve & update'}
              </button>
            </div>
          </div>
        )}

        {/* Footer — desktop */}
        {!isFinalized ? (
          <div className="hidden sm:flex gap-3">
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
