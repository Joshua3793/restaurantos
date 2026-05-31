'use client'
import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useDrawer } from '@/contexts/DrawerContext'
import dynamic from 'next/dynamic'
import {
  ChefHat, Plus, RefreshCw, Search, Settings, BookOpen,
  SlidersHorizontal, WifiOff, RefreshCcw, History, AlertTriangle, Check, Clock,
  Flame, Zap, Play, RotateCcw, Minus, X,
} from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { prepDeadline, fmtDuration } from '@/lib/service-hours'
import { savePrepCache, loadPrepCache, loadQueue, enqueueMutation, flushQueue } from '@/lib/prep-offline'
import { PrepKpiStrip }    from '@/components/prep/PrepKpiStrip'
import { PrepItemRow }     from '@/components/prep/PrepItemRow'
import { RecipeViewModal } from '@/components/prep/RecipeViewModal'
import type { PrepItemRich, PrepLogData } from '@/components/prep/types'

// Lazy-load conditional components — only mount when user opens them
const PrepDetailPanel   = dynamic(() => import('@/components/prep/PrepDetailPanel').then(m => ({ default: m.PrepDetailPanel })), { ssr: false, loading: () => null })
const PrepItemForm      = dynamic(() => import('@/components/prep/PrepItemForm').then(m => ({ default: m.PrepItemForm })), { ssr: false, loading: () => null })
const PrepSettingsModal = dynamic(() => import('@/components/prep/PrepSettingsModal').then(m => ({ default: m.PrepSettingsModal })), { ssr: false, loading: () => null })

function PrepDeadlineBanner({ rc }: { rc: import('@/contexts/RevenueCenterContext').RevenueCenter | null }) {
  if (!rc) return null
  const now = new Date()
  const onDemand = rc.schedulingMode === 'ON_DEMAND'
  const leadLabel = rc.prepLeadMinutes != null ? fmtDuration(rc.prepLeadMinutes * 60_000) : null
  const deadline = onDemand ? null : prepDeadline(rc, now)
  const countdown = deadline ? fmtDuration(deadline.getTime() - now.getTime()) : null
  const deadlineTime = deadline
    ? deadline.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : null

  return (
    <div className="flex items-center gap-2 bg-gold/10 border border-gold/30 rounded-xl px-3 py-2 text-xs">
      <Clock size={14} className="text-gold shrink-0" />
      {onDemand ? (
        <span className="text-gray-600">
          On-demand · {leadLabel ? <>prep lead <b className="text-gray-800">{leadLabel}</b></> : 'no prep lead set'}
        </span>
      ) : deadline ? (
        <span className="text-gray-600">
          Prep by <b className="text-gray-900">{deadlineTime}</b>
          <span className="text-gray-400"> · {countdown} left</span>
        </span>
      ) : (
        <span className="text-gray-400">No fixed service window today</span>
      )}
    </div>
  )
}

// ── Mobile To-Do helpers (match the prep To-Do mockup) ──────────────────────
function elapsedStr(ms: number) {
  const m = Math.max(0, Math.floor(ms / 60000))
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}
function fq(n: number) { return n % 1 === 0 ? n.toFixed(0) : n.toFixed(1) }

// Section header: coloured dot + title + count, with a caption line under it.
function GroupHead({ dot, title, count, sub }: { dot: string; title: string; count: string; sub: string }) {
  return (
    <div className="mt-3 mb-1">
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: dot }} />
        <span className="text-[13px] font-semibold text-ink tracking-[-0.01em]">{title}</span>
        <span className="font-mono text-[11px] text-ink-3">{count}</span>
      </div>
      <p className="font-mono text-[10.5px] text-ink-4 mt-0.5 pl-4">{sub}</p>
    </div>
  )
}

export default function PrepPage() {
  const { setDrawerOpen } = useDrawer()
  const { activeRc } = useRc()
  const [items,        setItems]        = useState<PrepItemRich[]>([])
  const [loading,      setLoading]      = useState(true)
  const [generating,   setGenerating]   = useState(false)
  const [selected,     setSelected]     = useState<PrepItemRich | null>(null)
  const [editing,      setEditing]      = useState<PrepItemRich | null>(null)
  const [showAdd,      setShowAdd]      = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [actionError,  setActionError]  = useState<string | null>(null)
  const [syncing,      setSyncing]      = useState(false)
  const [syncResult,   setSyncResult]   = useState<{ created: number; updated: number; skipped: number } | null>(null)
  const [isOffline,      setIsOffline]      = useState(false)
  const [offlineSyncing, setOfflineSyncing] = useState(false)
  const [pendingCount,   setPendingCount]   = useState(0)
  const [cacheAge,       setCacheAge]       = useState<number | null>(null)

  // Mobile To-Do: live clock for elapsed timers + log-yield sheet + recipe view
  const [nowTs, setNowTs] = useState(() => Date.now())
  const [mobileLog, setMobileLog] = useState<{ item: PrepItemRich; qty: number } | null>(null)
  const [recipeItem, setRecipeItem] = useState<PrepItemRich | null>(null)
  // Per-item checked-ingredient sets (persist while the recipe is being worked through)
  const [checkedIng, setCheckedIng] = useState<Record<string, Set<string>>>({})
  const toggleIngredient = (itemId: string, ingId: string) => setCheckedIng(prev => {
    const next = new Set(prev[itemId] ?? [])
    next.has(ingId) ? next.delete(ingId) : next.add(ingId)
    return { ...prev, [itemId]: next }
  })
  useEffect(() => {
    const t = setInterval(() => setNowTs(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  // View state
  const [viewMode,          setViewMode]          = useState<'today' | 'smartprep' | 'history'>('today')
  const [smartPrepView,     setSmartPrepView]     = useState<'urgency' | 'category' | 'station'>('urgency')
  const [showMobileFilters, setShowMobileFilters] = useState(false)
  const [mSearchOpen, setMSearchOpen] = useState(false)
  const [lookingGoodOpen,   setLookingGoodOpen]   = useState(false)

  // Filters (used in Smart Prep and Today)
  const [search,         setSearch]         = useState('')
  const [filterCategory, setFilterCategory] = useState('ALL')
  const [filterStation,  setFilterStation]  = useState<'ALL' | 'UNASSIGNED' | (string & {})>('ALL')
  const [activeOnly,     setActiveOnly]     = useState(true)

  // Settings — station list for Smart Prep grouping and filter dropdown
  const [stations, setStations] = useState<string[]>([])

  // History tab state
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1)
  const [historyDate,    setHistoryDate]    = useState(yesterday.toISOString().slice(0, 10))
  const [historyLogs,    setHistoryLogs]    = useState<Array<{
    id: string; status: string; actualPrepQty: number | null
    note: string | null; assignedTo: string | null; logDate: string
    prepItem: { id: string; name: string; unit: string }
  }>>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  // Prevent duplicate concurrent status mutations per item
  const pendingItems = useRef<Set<string>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    try {
      if (!navigator.onLine) throw new Error('offline')
      const res  = await fetch(`/api/prep/items?active=${activeOnly}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const fetched = Array.isArray(data) ? data : []
      setItems(fetched)
      savePrepCache(fetched)
      setIsOffline(false)
      setCacheAge(null)
    } catch (e) {
      if (!navigator.onLine) {
        const cached = loadPrepCache()
        if (cached) {
          setItems(cached.items)
          setCacheAge(Math.round((Date.now() - cached.ts) / 60000))
          setIsOffline(true)
          return
        }
        setIsOffline(true)
      }
      console.error('Failed to load prep items', e)
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [activeOnly])

  const loadSettings = useCallback(async () => {
    try {
      const res = await fetch('/api/prep/settings')
      if (res.ok) {
        const data = await res.json()
        setStations((data.stations ?? []).filter(Boolean))
      }
    } catch { /* silent degradation */ }
  }, [])

  // Reset station filter if the selected station no longer exists in settings
  useEffect(() => {
    if (
      filterStation !== 'ALL' &&
      filterStation !== 'UNASSIGNED' &&
      !stations.includes(filterStation as string)
    ) {
      setFilterStation('ALL')
    }
  }, [stations, filterStation])

  useEffect(() => {
    setIsOffline(!navigator.onLine)
    setPendingCount(loadQueue().length)
    load()
    loadSettings()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadSettings])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    setDrawerOpen(selected !== null)
    return () => setDrawerOpen(false)
  }, [selected, setDrawerOpen])

  // Online/offline events — auto-sync queue on reconnect
  useEffect(() => {
    const handleOnline = async () => {
      setIsOffline(false)
      const queue = loadQueue()
      if (queue.length > 0) {
        setOfflineSyncing(true)
        const result = await flushQueue()
        setPendingCount(0)
        setOfflineSyncing(false)
        if (result.failed > 0) {
          setActionError(`Synced ${result.synced} change${result.synced !== 1 ? 's' : ''}, but ${result.failed} failed — please refresh.`)
        }
      }
      load()
    }
    const handleOffline = () => setIsOffline(true)
    window.addEventListener('online',  handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online',  handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [load])

  const handleOfflineSync = useCallback(async () => {
    if (isOffline || offlineSyncing) return
    setOfflineSyncing(true)
    const result = await flushQueue()
    setPendingCount(0)
    setOfflineSyncing(false)
    if (result.failed > 0) {
      setActionError(`Synced ${result.synced}, but ${result.failed} change${result.failed !== 1 ? 's' : ''} failed — please refresh.`)
    }
    load()
  }, [isOffline, offlineSyncing, load])

  // Fetch history logs when History tab is active or date changes
  useEffect(() => {
    if (viewMode !== 'history') return
    setHistoryLoading(true)
    fetch(`/api/prep/logs?date=${historyDate}`)
      .then(r => r.json())
      .then(data => { setHistoryLogs(Array.isArray(data) ? data : []); setHistoryLoading(false) })
      .catch(() => setHistoryLoading(false))
  }, [viewMode, historyDate])

  // Auto-refresh every 60 seconds (paused while offline)
  useEffect(() => {
    if (isOffline) return
    const id = setInterval(load, 60_000)
    return () => clearInterval(id)
  }, [load, isOffline])

  // ── Derived data ──────────────────────────────────────────────────────────

  const categories = useMemo(() => [...new Set(items.map(i => i.category))].sort(), [items])

  // Today tab: persistent list items, sorted by priority then name
  const todayItems = useMemo(() =>
    items.filter(i => i.isOnList),
  [items])

  // Priority-change alerts: on-list items that have escalated to Critical but not started
  const priorityAlerts = useMemo(() =>
    items.filter(i =>
      i.isOnList &&
      i.priority === '911' &&
      (!i.todayLog || i.todayLog.status === 'NOT_STARTED')
    ),
  [items])

  // Smart Prep urgency buckets (all active items)
  const spCritical    = useMemo(() => items.filter(i => i.priority === '911'),          [items])
  const spNeeded      = useMemo(() => items.filter(i => i.priority === 'NEEDED_TODAY'), [items])
  const spLookingGood = useMemo(() => items.filter(i => i.priority === 'LATER'),        [items])

  // Smart Prep — by-category groups (sorted by urgency within each group)
  const PRIORITY_RANK: Record<string, number> = { '911': 0, 'NEEDED_TODAY': 1, 'LATER': 2 }
  const spCategoryGroups = useMemo(() => {
    const sorted = [...items].sort((a, b) => {
      const pd = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
      return pd !== 0 ? pd : a.name.localeCompare(b.name)
    })
    const map = new Map<string, PrepItemRich[]>()
    for (const cat of [...new Set(sorted.map(i => i.category))].sort()) map.set(cat, [])
    for (const item of sorted) map.get(item.category)!.push(item)
    return Array.from(map.entries()).filter(([, rows]) => rows.length > 0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items])

  // Smart Prep — by-station groups
  const spStationGroups = useMemo(() => {
    const sorted = [...items].sort((a, b) => {
      const pd = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
      return pd !== 0 ? pd : a.name.localeCompare(b.name)
    })
    const groups: [string, PrepItemRich[]][] = []
    for (const station of stations) {
      const rows = sorted.filter(i => i.station === station)
      if (rows.length > 0) groups.push([station, rows])
    }
    const unassigned = sorted.filter(i => !i.station || i.station.trim() === '')
    if (unassigned.length > 0) groups.push(['Unassigned', unassigned])
    const other = sorted.filter(i => i.station && i.station.trim() !== '' && !stations.includes(i.station))
    if (other.length > 0) groups.push(['Other', other])
    return groups.length > 0 ? groups : null
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, stations])

  // Today filter (search + optional category/station filters)
  const filteredToday = useMemo(() => {
    return todayItems.filter(item => {
      if (search && !item.name.toLowerCase().includes(search.toLowerCase())) return false
      if (filterCategory !== 'ALL' && item.category !== filterCategory) return false
      if (filterStation === 'UNASSIGNED') {
        if (item.station && item.station.trim() !== '') return false
      } else if (filterStation !== 'ALL') {
        if (item.station !== filterStation) return false
      }
      return true
    })
  }, [todayItems, search, filterCategory, filterStation])

  // Keep detail panel in sync with live data
  const selectedLive = useMemo(
    () => selected ? (items.find(i => i.id === selected.id) ?? selected) : null,
    [selected, items],
  )

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleRefresh = async () => {
    setGenerating(true)
    try { await load() }
    catch { setActionError('Refresh failed — check your connection and try again.') }
    finally { setGenerating(false) }
  }

  const handleSync = async () => {
    setSyncing(true)
    setSyncResult(null)
    try {
      const res  = await fetch('/api/prep/sync-from-recipes', { method: 'POST' })
      const data = await res.json()
      setSyncResult(data)
      if (data.created > 0) await load()
    } catch {
      setActionError('Sync failed — check your connection and try again.')
    } finally {
      setSyncing(false)
    }
  }

  async function handleStatusChange(itemId: string, newStatus: string, actualQty?: number) {
    if (pendingItems.current.has(itemId)) return
    const item = items.find(i => i.id === itemId)
    if (!item) return
    pendingItems.current.add(itemId)

    const now = new Date().toISOString()
    const completingNow = newStatus === 'DONE' || newStatus === 'PARTIAL'
    setItems(prev => prev.map(i => {
      if (i.id !== itemId) return i
      const existingLog = i.todayLog
      return {
        ...i,
        ...(completingNow && { manualPriorityOverride: null }),
        todayLog: existingLog
          ? { ...existingLog, status: newStatus as PrepLogData['status'], ...(actualQty !== undefined ? { actualPrepQty: actualQty } : {}) }
          : {
              id: `_opt_${itemId}`,
              prepItemId: itemId,
              logDate: now.split('T')[0],
              status: newStatus as PrepLogData['status'],
              requiredQty: null,
              actualPrepQty: actualQty ?? null,
              assignedTo: null,
              dueTime: null,
              note: null,
              blockedReason: null,
              inventoryAdjusted: false,
              createdAt: now,
              updatedAt: now,
            },
      }
    }))

    if (!navigator.onLine) {
      enqueueMutation({ type: 'status', itemId, logId: item.todayLog?.id ?? null, status: newStatus, actualQty })
      setPendingCount(n => n + 1)
      pendingItems.current.delete(itemId)
      return
    }

    try {
      let logId = item.todayLog?.id
      if (!logId || logId.startsWith('_opt_')) {
        const log = await fetch('/api/prep/logs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prepItemId: itemId }),
        }).then(r => r.json())
        logId = log.id
        setItems(prev => prev.map(i => {
          if (i.id !== itemId || !i.todayLog) return i
          return { ...i, todayLog: { ...i.todayLog, id: log.id } }
        }))
      }
      await fetch(`/api/prep/logs/${logId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: newStatus,
          ...(actualQty !== undefined ? { actualPrepQty: actualQty } : {}),
        }),
      })
    } catch {
      setActionError('Status update failed — try again.')
      load()
    } finally {
      pendingItems.current.delete(itemId)
    }
  }

  async function handlePriorityChange(itemId: string, priority: string) {
    setItems(prev => prev.map(item => {
      if (item.id !== itemId) return item
      return {
        ...item,
        manualPriorityOverride: priority || null,
        priority: (priority as PrepItemRich['priority']) || item.priority,
      }
    }))

    if (!navigator.onLine) {
      enqueueMutation({ type: 'priority', itemId, priority })
      setPendingCount(n => n + 1)
      return
    }

    try {
      await fetch(`/api/prep/items/${itemId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manualPriorityOverride: priority }),
      })
      if (!priority) load()
    } catch {
      setActionError('Priority update failed — try again.')
      load()
    }
  }

  async function handleDelete(itemId: string) {
    try {
      await fetch(`/api/prep/items/${itemId}`, { method: 'DELETE' })
      if (selected?.id === itemId) setSelected(null)
      load()
    } catch {
      setActionError('Delete failed — try again.')
    }
  }

  // Toggle isOnList: add to list (true) or remove from list (false)
  async function handleToggleOnList(itemId: string, newValue: boolean) {
    // Optimistic update
    setItems(prev => prev.map(i =>
      i.id === itemId ? { ...i, isOnList: newValue } : i
    ))

    if (!navigator.onLine) {
      enqueueMutation({ type: 'isOnList_toggle', itemId, isOnList: newValue })
      setPendingCount(n => n + 1)
      return
    }

    try {
      await fetch(`/api/prep/items/${itemId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isOnList: newValue }),
      })
      // When removing from list, log SKIPPED for today so it shows in History
      if (!newValue) {
        const existingLog = items.find(i => i.id === itemId)?.todayLog
        if (!existingLog || existingLog.status === 'NOT_STARTED') {
          await fetch('/api/prep/logs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prepItemId: itemId, status: 'SKIPPED' }),
          }).catch(() => {}) // non-critical — don't fail the whole operation
        }
      }
    } catch {
      setActionError('Could not update list — try again.')
      load()
    }
  }

  // Bulk add all items of a given priority to the list
  async function handleAddAll(priority: '911' | 'NEEDED_TODAY') {
    const targets = items.filter(i => i.priority === priority && !i.isOnList)
    if (targets.length === 0) return
    // Optimistic: flip all at once
    setItems(prev => prev.map(i =>
      targets.some(t => t.id === i.id) ? { ...i, isOnList: true } : i
    ))
    await Promise.all(targets.map(i =>
      fetch(`/api/prep/items/${i.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isOnList: true }),
      })
    ))
  }

  // ── Render helpers ────────────────────────────────────────────────────────

  const selCls = 'border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gold'
  const activeFilterCount = [filterCategory !== 'ALL', filterStation !== 'ALL'].filter(Boolean).length

  const STATION_EMOJI: Record<string, string> = {
    'Cold': '❄',
    'Hot': '🔥',
    'Pastry': '🥐',
    'Butchery': '🔪',
    'Garde Manger': '🥗',
  }

  // ── Smart Prep item card (shared across urgency/category/station views) ──
  function SmartPrepCard({ item }: { item: PrepItemRich }) {
    const stockPct = item.parLevel > 0 ? Math.min(100, (item.onHand / item.parLevel) * 100) : 100
    const parPct = item.parLevel > 0 ? Math.round((item.onHand / item.parLevel) * 100) : 100
    const isCritical = item.priority === '911'
    const isNeeded = item.priority === 'NEEDED_TODAY'
    const barColor = isCritical ? 'bg-red' : isNeeded ? 'bg-gold' : 'bg-green'
    const suggestColor = isCritical ? 'text-red-text' : isNeeded ? 'text-gold-2' : 'text-green-text'
    const suggestAccent = isCritical ? 'text-red' : isNeeded ? 'text-gold' : 'text-green'
    const isAdded = item.isOnList
    const cardBorder = isCritical ? 'border-[#fca5a5]' : 'border-line'

    return (
      <div className={`bg-paper border ${cardBorder} rounded-[10px] p-3.5 flex flex-col gap-2.5`}>
        {/* Top: name + meta + Add button */}
        <div className="flex items-start justify-between gap-2.5">
          <button onClick={() => setSelected(item)} className="text-left min-w-0 flex-1 hover:opacity-80 transition-opacity">
            <div className="text-[14.5px] font-semibold tracking-[-0.015em] text-ink leading-[1.2]">{item.name}</div>
            <div className="flex items-center gap-1.5 mt-1 flex-wrap whitespace-nowrap">
              <span className="font-mono text-[10.5px] text-ink-3">{item.category}</span>
              {item.station && (
                <span className="font-mono text-[9.5px] px-1.5 py-0.5 rounded-[4px] bg-bg-2 text-ink-2 font-medium tracking-[0.02em] uppercase">{item.station}</span>
              )}
              {item.manualPriorityOverride && (
                <span className="font-mono text-[9.5px] text-gold-2 bg-gold-soft px-1.5 py-0.5 rounded-[4px] font-medium">✎ OVERRIDE</span>
              )}
            </div>
          </button>
          <button
            onClick={() => handleToggleOnList(item.id, !isAdded)}
            title={isAdded ? "Remove from today's list" : "Add to today's list"}
            className={`shrink-0 px-3 py-2 rounded-[8px] text-[12.5px] font-medium tracking-[-0.005em] inline-flex items-center gap-1.5 whitespace-nowrap transition-colors group ${
              isAdded
                ? 'bg-bg-2 text-ink-2 border border-line hover:border-red-soft hover:bg-red-soft hover:text-red'
                : 'bg-ink text-paper hover:bg-ink-2'
            }`}
          >
            {isAdded
              ? <><Check size={13} className="text-green group-hover:text-red" /> On list <span className="opacity-50 ml-0.5">✕</span></>
              : <><span className="text-gold font-semibold">+</span> Add</>}
          </button>
        </div>

        {/* Progress */}
        <div className="flex flex-col gap-1.5">
          <div className="flex justify-between font-mono text-[11px] text-ink-3 gap-2 whitespace-nowrap">
            <span><b className="text-ink font-medium">{item.onHand % 1 === 0 ? item.onHand.toFixed(0) : item.onHand.toFixed(1)}</b> / {item.parLevel % 1 === 0 ? item.parLevel.toFixed(0) : item.parLevel.toFixed(1)} {item.unit} on hand</span>
            <span className={isCritical ? 'text-red-text' : isNeeded ? 'text-gold-2' : 'text-ink-3'}>{parPct}% of par</span>
          </div>
          <div className="h-1.5 bg-bg-2 rounded-full overflow-hidden">
            <div className={`h-full ${barColor} rounded-full transition-all`} style={{ width: `${Math.max(stockPct, isCritical && stockPct < 1 ? 1 : 0)}%` }} />
          </div>
        </div>

        {/* Suggestion */}
        {item.priority !== 'LATER' ? (
          item.manualPriorityOverride ? (
            <div className="font-mono text-[11.5px] text-ink-3 line-through tracking-[0]">
              System suggests → {item.suggestedQty > 0 ? `make ${item.suggestedQty % 1 === 0 ? item.suggestedQty.toFixed(0) : item.suggestedQty.toFixed(1)} ${item.unit}` : 'review stock'}
            </div>
          ) : (
            <div className={`font-mono text-[11.5px] tracking-[0] flex items-center gap-1.5 whitespace-nowrap ${suggestColor}`}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={suggestAccent}><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>
              System suggests <b className={`${suggestAccent} font-semibold`}>→ make {item.suggestedQty > 0 ? `${item.suggestedQty % 1 === 0 ? item.suggestedQty.toFixed(0) : item.suggestedQty.toFixed(1)} ${item.unit}` : 'TBD'}</b>
              {item.estimatedPrepTime ? <> · ~{item.estimatedPrepTime} min</> : null}
            </div>
          )
        ) : (
          <div className="font-mono text-[11.5px] text-green-text tracking-[0]">At or above par — looking good</div>
        )}

        {/* Override pills */}
        <div className="flex items-center gap-1.5 flex-wrap pt-2.5 border-t border-line">
          <span className="font-mono text-[10px] text-ink-3 tracking-[0.02em] mr-0.5">OVERRIDE</span>
          {(['911', 'NEEDED_TODAY', 'LATER'] as const).map(p => {
            const labels: Record<string, string> = { '911': 'Critical', 'NEEDED_TODAY': 'Needed today', 'LATER': 'Later' }
            const isActive = (item.manualPriorityOverride ?? item.priority) === p
            const activeCls = p === '911'
              ? 'bg-red-soft text-red-text border-red-soft'
              : p === 'NEEDED_TODAY'
                ? 'bg-gold-soft text-gold-2 border-gold-soft'
                : 'bg-bg-2 text-ink-2 border-bg-2'
            return (
              <button
                key={p}
                onClick={() => handlePriorityChange(item.id, isActive && item.manualPriorityOverride ? '' : p)}
                className={`font-mono text-[10px] px-2 py-1 rounded-full border font-medium tracking-[0] transition-colors ${
                  isActive ? activeCls : 'bg-paper text-ink-2 border-line hover:border-ink-3'
                }`}
              >
                {labels[p]}
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  // ── Smart Prep grouped table row (category / station views) ───────────────
  function SmartPrepTableRow({ item }: { item: PrepItemRich }) {
    const stockPct = item.parLevel > 0 ? Math.min(100, (item.onHand / item.parLevel) * 100) : 100
    const isCritical = item.priority === '911'
    const isNeeded = item.priority === 'NEEDED_TODAY'
    const dotColor = isCritical ? 'bg-red' : isNeeded ? 'bg-gold' : 'bg-green'
    const barColor = isCritical ? 'bg-red' : isNeeded ? 'bg-gold' : 'bg-green'
    const suggestColor = isCritical ? 'text-red-text' : isNeeded ? 'text-gold-2' : 'text-ink-3'
    const isAdded = item.isOnList

    const labels: Record<string, string>     = { '911': 'CRITICAL', 'NEEDED_TODAY': 'NEEDED', 'LATER': 'ON PAR' }
    const badgeStyles: Record<string, string> = {
      '911': 'bg-red-soft text-red-text',
      'NEEDED_TODAY': 'bg-gold-soft text-gold-2',
      'LATER': 'bg-green-soft text-green-text',
    }

    return (
      <div className="grid grid-cols-[16px_2fr_1fr_110px_1fr_220px_110px] gap-3 items-center px-[18px] py-3 border-b border-line last:border-0 hover:bg-bg/60 transition-colors text-[13.5px]">
        <span className={`w-2 h-2 rounded-full ${dotColor} inline-block shrink-0`} />
        <button onClick={() => setSelected(item)} className="text-left hover:opacity-80 transition-opacity min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[13.5px] font-medium text-ink tracking-[-0.01em]">{item.name}</span>
            <span className={`font-mono text-[9.5px] px-1.5 py-0.5 rounded-[4px] font-semibold tracking-[0.02em] ${badgeStyles[item.priority]}`}>{labels[item.priority]}</span>
            {item.station && <span className="font-mono text-[9.5px] bg-bg-2 text-ink-2 px-1.5 py-0.5 rounded-[4px] font-medium tracking-[0.02em] uppercase">{item.station}</span>}
            {item.manualPriorityOverride && <span className="font-mono text-[9.5px] text-gold-2 bg-gold-soft px-1.5 py-0.5 rounded-[4px] font-medium">✎ OVERRIDE</span>}
            {isAdded && <span className="font-mono text-[10px] text-ink-4 italic">on list</span>}
          </div>
          <div className={`font-mono text-[10.5px] mt-1 tracking-[0] whitespace-nowrap ${suggestColor}`}>
            {item.priority !== 'LATER' && !item.manualPriorityOverride
              ? `System suggests → ${item.suggestedQty > 0 ? `make ${item.suggestedQty % 1 === 0 ? item.suggestedQty.toFixed(0) : item.suggestedQty.toFixed(1)} ${item.unit}` : 'review stock'}`
              : item.priority === 'LATER' ? 'At or above par' : 'Chef override active'
            }
          </div>
        </button>
        <div>
          <div className="h-1.5 bg-bg-2 rounded-full overflow-hidden">
            <div className={`h-full rounded-full ${barColor}`} style={{ width: `${Math.max(stockPct, isCritical && stockPct < 1 ? 1 : 0)}%` }} />
          </div>
        </div>
        <div className="font-mono text-[12.5px] text-ink-2 tracking-[-0.01em] whitespace-nowrap">
          {item.onHand % 1 === 0 ? item.onHand.toFixed(0) : item.onHand.toFixed(1)} / {item.parLevel % 1 === 0 ? item.parLevel.toFixed(0) : item.parLevel.toFixed(1)} {item.unit}
        </div>
        <div className={`font-mono text-[12.5px] font-medium tracking-[-0.01em] ${isCritical ? 'text-red-text' : isNeeded ? 'text-gold-2' : 'text-ink-4'}`}>
          {item.priority !== 'LATER' && item.suggestedQty > 0
            ? `${item.suggestedQty % 1 === 0 ? item.suggestedQty.toFixed(0) : item.suggestedQty.toFixed(1)} ${item.unit}`
            : '—'
          }
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {(['911', 'NEEDED_TODAY', 'LATER'] as const).map(p => {
            const chipLabels: Record<string, string> = { '911': 'Critical', 'NEEDED_TODAY': 'Needed', 'LATER': 'Later' }
            const isActive = (item.manualPriorityOverride ?? item.priority) === p
            const activeCls = p === '911'
              ? 'bg-red-soft text-red-text border-red-soft'
              : p === 'NEEDED_TODAY'
                ? 'bg-gold-soft text-gold-2 border-gold-soft'
                : 'bg-bg-2 text-ink-2 border-bg-2'
            return (
              <button
                key={p}
                onClick={() => handlePriorityChange(item.id, isActive && item.manualPriorityOverride ? '' : p)}
                className={`font-mono text-[10px] px-2 py-0.5 rounded-full border font-medium tracking-[0] transition-colors ${
                  isActive ? activeCls : 'bg-paper text-ink-2 border-line hover:border-ink-3'
                }`}
              >
                {chipLabels[p]}
              </button>
            )
          })}
        </div>
        <div className="flex justify-end">
          <button
            onClick={() => handleToggleOnList(item.id, !isAdded)}
            title={isAdded ? "Remove from today's list" : "Add to today's list"}
            className={`px-3 py-1.5 rounded-[8px] text-[12px] font-medium tracking-[-0.005em] inline-flex items-center gap-1 whitespace-nowrap transition-colors group ${
              isAdded
                ? 'bg-bg-2 text-ink-2 border border-line hover:border-red-soft hover:bg-red-soft hover:text-red'
                : 'bg-ink text-paper hover:bg-ink-2'
            }`}
          >
            {isAdded
              ? <><Check size={12} className="text-green group-hover:text-red" /> On list <span className="opacity-50 ml-0.5">✕</span></>
              : <><span className="text-gold font-semibold">+</span> Add</>}
          </button>
        </div>
      </div>
    )
  }

  // ── Page JSX ──────────────────────────────────────────────────────────────

  return (
    <div className="space-y-3 md:space-y-5">

      <div className="hidden md:block">
        <PrepDeadlineBanner rc={activeRc} />
      </div>

      {/* ── Mobile Header ── */}
      <div className="md:hidden">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-[19px] font-semibold tracking-[-0.02em] text-ink flex items-center gap-1.5">
              <ChefHat size={18} className="text-gold shrink-0" /> Prep List
            </h1>
            <p className="font-mono text-[10.5px] text-ink-3 mt-0.5 truncate">
              {new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
              {(() => {
                if (!activeRc || activeRc.schedulingMode === 'ON_DEMAND') return ''
                const dl = prepDeadline(activeRc, new Date())
                return dl ? ` · prep by ${dl.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} · ${fmtDuration(dl.getTime() - Date.now())} left` : ''
              })()}
            </p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button onClick={() => setMSearchOpen(o => !o)}
              className={`p-1.5 rounded-lg border transition-colors ${mSearchOpen || search ? 'border-gold/40 bg-gold-soft text-gold-2' : 'border-line text-ink-3 hover:bg-bg-2'}`}
              title="Search">
              <Search size={15} />
            </button>
            <button onClick={handleRefresh} disabled={generating}
              className="p-1.5 rounded-lg border border-line text-ink-3 hover:bg-bg-2 disabled:opacity-50"
              title="Refresh">
              <RefreshCw size={15} className={generating ? 'animate-spin' : ''} />
            </button>
            <button onClick={() => setShowSettings(true)}
              className="p-1.5 rounded-lg border border-line text-ink-3 hover:bg-bg-2"
              title="Settings">
              <Settings size={15} />
            </button>
            <button onClick={handleSync} disabled={syncing}
              className="p-1.5 rounded-lg border border-gold/30 text-gold bg-gold-soft hover:bg-gold/15 disabled:opacity-50"
              title="Sync from Recipes">
              <BookOpen size={15} className={syncing ? 'animate-pulse' : ''} />
            </button>
            <button onClick={() => setShowAdd(true)}
              className="p-1.5 rounded-lg bg-gold text-white hover:bg-gold-2"
              title="Add prep item">
              <Plus size={16} />
            </button>
          </div>
        </div>

        {/* Mobile view tabs */}
        <div className="flex bg-bg-2 rounded-xl p-1 mt-3">
          {(['today', 'smartprep', 'history'] as const).map(m => (
            <button key={m} onClick={() => setViewMode(m)}
              className={`flex-1 py-2 text-xs font-medium rounded-lg transition-colors flex items-center justify-center gap-1 ${viewMode === m ? 'bg-paper shadow text-ink' : 'text-ink-3'}`}>
              {m === 'today' ? <>To Do {todayItems.length > 0 && <span className="bg-gold text-ink text-[9px] font-bold px-1.5 py-0.5 rounded-full">{todayItems.length}</span>}</> : m === 'smartprep' ? <>Smart Prep {(spCritical.length + spNeeded.length) > 0 && <span className="bg-red text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full">{spCritical.length + spNeeded.length}</span>}</> : <><History size={12} /> History</>}
            </button>
          ))}
        </div>

        {/* Search + filter — collapsed by default; opens from the search icon above */}
        {viewMode !== 'history' && (mSearchOpen || search) && (
          <div className="flex gap-2 mt-2.5">
            <div className="relative flex-1">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-4" />
              <input
                autoFocus
                className="w-full pl-9 pr-9 py-2 text-sm border border-line rounded-xl focus:outline-none focus:ring-2 focus:ring-gold"
                placeholder="Search prep items…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
              <button
                onClick={() => { setSearch(''); setMSearchOpen(false) }}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-4 hover:text-ink-2"
                title="Close search">
                <X size={15} />
              </button>
            </div>
            <button
              onClick={() => setShowMobileFilters(v => !v)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border text-sm font-medium transition-colors ${
                showMobileFilters || activeFilterCount > 0
                  ? 'border-gold/40 bg-gold-soft text-gold-2'
                  : 'border-line text-ink-2 hover:bg-bg-2'
              }`}>
              <SlidersHorizontal size={15} />
              {activeFilterCount > 0 ? <span className="bg-gold text-ink text-[10px] font-bold px-1.5 py-0.5 rounded-full">{activeFilterCount}</span> : 'Filter'}
            </button>
          </div>
        )}

        {showMobileFilters && (
          <div className="mt-2 bg-paper border border-line rounded-xl p-3 space-y-2">
            <select className={selCls + ' w-full'} value={filterCategory} onChange={e => setFilterCategory(e.target.value)}>
              <option value="ALL">All Categories</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select className={selCls + ' w-full'} value={filterStation} onChange={e => setFilterStation(e.target.value)}>
              <option value="ALL">All Stations</option>
              <option value="UNASSIGNED">Unassigned</option>
              {stations.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        )}
      </div>

      {/* ── Desktop Header ── */}
      <div className="hidden md:block space-y-4">
        {/* Top bar */}
        <div className="flex items-center justify-between gap-6">
          <div>
            <p className="font-mono text-[10.5px] text-ink-3 tracking-wide mb-2 flex items-center gap-2">
              <ChefHat size={13} className="text-ink-3" />
              TODAY / PREP
            </p>
            <h1 className="text-[36px] font-semibold tracking-[-0.04em] leading-none text-ink mb-1.5">Prep list</h1>
            <p className="text-[13.5px] text-ink-3 tracking-[-0.005em]">
              {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
            </p>
          </div>

          {/* Desktop tabs — centered, branded pill */}
          <div className="inline-flex bg-bg-2 border border-line rounded-[10px] p-[3px] gap-0.5">
            <button onClick={() => setViewMode('today')} id="dtab-today"
              className={`px-3.5 py-1.5 text-[13px] font-medium rounded-[7px] transition-colors flex items-center gap-1.5 tracking-[-0.005em] ${viewMode === 'today' ? 'bg-paper text-ink shadow-[0_1px_2px_rgba(0,0,0,0.04)]' : 'text-ink-3 hover:text-ink-2'}`}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18M7 13h4M7 16h6"/></svg>
              To do
              {todayItems.length > 0 && <span className="font-mono text-[10px] bg-red text-white px-1.5 py-0.5 rounded-full font-semibold">{todayItems.length}</span>}
            </button>
            <button onClick={() => setViewMode('smartprep')} id="dtab-smartprep"
              className={`px-3.5 py-1.5 text-[13px] font-medium rounded-[7px] transition-colors flex items-center gap-1.5 tracking-[-0.005em] ${viewMode === 'smartprep' ? 'bg-paper text-ink shadow-[0_1px_2px_rgba(0,0,0,0.04)]' : 'text-ink-3 hover:text-ink-2'}`}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>
              Smart prep
              {(spCritical.length + spNeeded.length) > 0 && <span className="font-mono text-[10px] bg-red text-white px-1.5 py-0.5 rounded-full font-semibold">{spCritical.length + spNeeded.length}</span>}
            </button>
            <button onClick={() => setViewMode('history')} id="dtab-history"
              className={`px-3.5 py-1.5 text-[13px] font-medium rounded-[7px] transition-colors flex items-center gap-1.5 tracking-[-0.005em] ${viewMode === 'history' ? 'bg-paper text-ink shadow-[0_1px_2px_rgba(0,0,0,0.04)]' : 'text-ink-3 hover:text-ink-2'}`}>
              <History size={13} />
              History
            </button>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button onClick={handleRefresh} disabled={generating}
              className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-[9px] border border-line bg-paper text-ink-2 text-[13px] font-medium hover:border-ink-3 transition-colors disabled:opacity-50 whitespace-nowrap">
              <RefreshCw size={13} className={`text-ink-3 ${generating ? 'animate-spin' : ''}`} />
              {generating ? 'Refreshing…' : 'Refresh'}
            </button>
            <button onClick={handleSync} disabled={syncing}
              className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-[9px] border border-line bg-paper text-ink-2 text-[13px] font-medium hover:border-ink-3 transition-colors disabled:opacity-50 whitespace-nowrap">
              <BookOpen size={13} className={`text-ink-3 ${syncing ? 'animate-pulse' : ''}`} />
              {syncing ? 'Syncing…' : 'Sync from recipes'}
            </button>
            <button onClick={() => setShowSettings(true)}
              className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-[9px] border border-line bg-paper text-ink-2 text-[13px] font-medium hover:border-ink-3 transition-colors whitespace-nowrap">
              <Settings size={13} className="text-ink-3" />
              Settings
            </button>
            <button onClick={() => setShowAdd(true)}
              className="flex items-center gap-1.5 px-4 py-2.5 rounded-[9px] bg-ink text-paper text-[13px] font-medium hover:bg-ink-2 transition-colors whitespace-nowrap">
              <span className="text-gold font-semibold text-base leading-none">+</span>
              Add item
            </button>
          </div>
        </div>

        {/* Desktop filter bar (Today only — Smart Prep has its own branded tools row) */}
        {viewMode === 'today' && (
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2 items-center">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" />
              <input
                className="w-full bg-paper border border-line rounded-[9px] pl-9 pr-3 py-2.5 text-[13px] text-ink placeholder:text-ink-3 focus:outline-none focus:border-ink-3 transition-colors tracking-[-0.005em]"
                placeholder="Search prep items…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <select
              value={filterCategory}
              onChange={e => setFilterCategory(e.target.value)}
              className="bg-paper border border-line rounded-[9px] px-3 py-2.5 text-[13px] text-ink-2 hover:border-ink-3 focus:outline-none focus:border-ink-3 transition-colors min-w-[140px] tracking-[-0.005em]"
            >
              <option value="ALL">All categories</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select
              value={filterStation}
              onChange={e => setFilterStation(e.target.value)}
              className="bg-paper border border-line rounded-[9px] px-3 py-2.5 text-[13px] text-ink-2 hover:border-ink-3 focus:outline-none focus:border-ink-3 transition-colors min-w-[140px] tracking-[-0.005em]"
            >
              <option value="ALL">All stations</option>
              <option value="UNASSIGNED">Unassigned</option>
              {stations.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <label className="bg-paper border border-line rounded-[9px] px-3 py-2.5 text-[13px] text-ink-2 hover:border-ink-3 transition-colors flex items-center gap-2 cursor-pointer tracking-[-0.005em]">
              <span className={`w-[14px] h-[14px] border-[1.5px] rounded-[3px] grid place-items-center text-[9px] ${activeOnly ? 'bg-ink border-ink text-paper' : 'border-line-2 bg-paper'}`}>
                {activeOnly && '✓'}
              </span>
              <input type="checkbox" checked={activeOnly} onChange={e => setActiveOnly(e.target.checked)} className="hidden" />
              Active only
            </label>
          </div>
        )}
      </div>

      {/* ── System banners ── */}
      {actionError && (
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 bg-red-soft border border-red-soft rounded-xl text-sm text-red-text">
          <span>{actionError}</span>
          <button onClick={() => setActionError(null)} className="shrink-0 text-red hover:text-red">✕</button>
        </div>
      )}

      {(isOffline || pendingCount > 0) && (
        <div className={`flex items-center justify-between gap-3 px-4 py-2.5 rounded-xl text-sm border ${
          isOffline ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-gold/10 border-gold/30 text-blue-text'
        }`}>
          <div className="flex items-center gap-2 min-w-0">
            <WifiOff size={14} className="shrink-0" />
            <span className="truncate">
              {offlineSyncing ? 'Syncing changes…' : isOffline ? `Offline${cacheAge !== null ? ` — data from ${cacheAge < 1 ? 'just now' : `${cacheAge}m ago`}` : ''}` : 'Back online'}
            </span>
            {pendingCount > 0 && !offlineSyncing && (
              <span className="font-semibold shrink-0">· {pendingCount} change{pendingCount !== 1 ? 's' : ''} pending</span>
            )}
          </div>
          {pendingCount > 0 && !isOffline && !offlineSyncing && (
            <button onClick={handleOfflineSync} className="shrink-0 flex items-center gap-1 text-xs font-medium text-gold hover:text-blue-text">
              <RefreshCcw size={12} /> Sync now
            </button>
          )}
        </div>
      )}

      {syncResult && (
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 bg-green-soft border border-green-soft rounded-xl text-sm text-green-text">
          <span>
            {(syncResult.created > 0 || syncResult.updated > 0)
              ? <>{syncResult.created > 0 && <> Created <strong>{syncResult.created}</strong> new prep item{syncResult.created !== 1 ? 's' : ''}.</>}{syncResult.updated > 0 && <> Updated categor{syncResult.updated !== 1 ? 'ies' : 'y'} on <strong>{syncResult.updated}</strong> existing item{syncResult.updated !== 1 ? 's' : ''}.</>}</>
              : <>Everything is already in sync — {syncResult.skipped} prep item{syncResult.skipped !== 1 ? 's' : ''} matched.</>
            }
          </span>
          <button onClick={() => setSyncResult(null)} className="shrink-0 text-green hover:text-green-text">✕</button>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          TODAY TAB
      ══════════════════════════════════════════════════════ */}
      {viewMode === 'today' && (
        <div className="space-y-2.5 md:space-y-4">

          {/* Desktop KPI strip */}
          <div className="hidden md:block">
            <PrepKpiStrip items={todayItems} />
          </div>

          {/* Priority-change alert — full on desktop, one compact line on mobile */}
          {priorityAlerts.length > 0 && (
            <>
              <div className="hidden md:flex bg-gold-soft border border-[#fcd34d] rounded-xl px-4 py-3 items-start gap-3">
                <AlertTriangle size={16} className="text-gold-2 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm font-semibold text-[#78350f]">Stock changed since scheduling</p>
                  <p className="text-sm text-gold-2 mt-0.5">
                    {priorityAlerts.length === 1
                      ? <><strong>{priorityAlerts[0].name}</strong> is now Critical — theoretical stock at or below 0.</>
                      : <><strong>{priorityAlerts.map(i => i.name).join(', ')}</strong> — now Critical, stock depleted.</>
                    }
                  </p>
                </div>
              </div>
              <div className="md:hidden flex items-center gap-2 bg-gold-soft border border-[#fcd34d] rounded-[10px] px-3 py-2">
                <AlertTriangle size={14} className="text-gold-2 shrink-0" />
                <span className="text-[12.5px] text-[#78350f] font-medium truncate">
                  {priorityAlerts.length} item{priorityAlerts.length > 1 ? 's' : ''} now critical — stock depleted
                </span>
              </div>
            </>
          )}

          {loading ? (
            <div className="flex justify-center py-16">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gold" />
            </div>
          ) : todayItems.length === 0 ? (
            <div className="bg-paper border border-line rounded-xl py-16 text-center">
              <ChefHat size={32} className="mx-auto text-ink-4 mb-3" />
              <p className="text-ink-2 text-sm font-medium">Nothing on today&apos;s list yet.</p>
              <p className="font-mono text-[11px] text-ink-3 mt-2">
                Go to{' '}
                <button onClick={() => setViewMode('smartprep')} className="text-gold-2 hover:underline">
                  Smart Prep
                </button>
                {' '}and add items to your list.
              </p>
            </div>
          ) : (
            <>
              {/* Desktop: flat card list */}
              <div className="hidden md:flex flex-col gap-2">
                {filteredToday.map(item => (
                  <PrepItemRow
                    key={item.id}
                    item={item}
                    onClick={() => setSelected(item)}
                    onStatusChange={handleStatusChange}
                    onPriorityChange={handlePriorityChange}
                    onDelete={handleDelete}
                    onToggleOnList={handleToggleOnList}
                  />
                ))}
              </div>

              {/* Mobile: status-grouped To-Do (matches mockup) */}
              <div className="md:hidden">
                {(() => {
                  const doing = filteredToday.filter(i => i.todayLog?.status === 'IN_PROGRESS')
                  const done  = filteredToday.filter(i => i.todayLog?.status === 'DONE' || i.todayLog?.status === 'PARTIAL')
                  const todo  = filteredToday.filter(i => {
                    const s = i.todayLog?.status ?? 'NOT_STARTED'
                    return s !== 'IN_PROGRESS' && s !== 'DONE' && s !== 'PARTIAL' && s !== 'SKIPPED'
                  })
                  const total = doing.length + done.length + todo.length
                  const seg = (n: number) => total ? (n / total) * 100 : 0
                  return (
                    <>
                      {/* progress overview — slim strip */}
                      <div className="pt-0.5">
                        <div className="flex items-center justify-between gap-2 mb-1.5 font-mono text-[10.5px] whitespace-nowrap">
                          <span className="text-ink-2"><b className="text-ink font-semibold">{done.length}/{total}</b> done</span>
                          <span className="text-ink-3">{doing.length ? <span className="text-blue-text">{doing.length} in progress</span> : '0 in progress'} · {todo.length} to do</span>
                        </div>
                        <div className="flex h-1.5 rounded-full overflow-hidden bg-bg-2 gap-[2px]">
                          {done.length > 0 && <div className="bg-green" style={{ width: `${seg(done.length)}%` }} />}
                          {doing.length > 0 && <div className="bg-blue" style={{ width: `${seg(doing.length)}%` }} />}
                        </div>
                      </div>

                      {/* In progress */}
                      {doing.length > 0 && (
                        <>
                          <GroupHead dot="#2563eb" title="In progress" count={`${doing.length}`} sub="Cooking now — log the yield when finished" />
                          <div className="flex flex-col gap-2 mt-2.5">
                            {doing.map(p => (
                              <div key={p.id} onClick={() => p.linkedRecipeId ? setRecipeItem(p) : setSelected(p)} className="bg-blue-soft border border-[#93c5fd] rounded-xl px-3.5 py-3 cursor-pointer">
                                <div className="flex items-center gap-3">
                                  <span className="w-[30px] h-[30px] rounded-[9px] shrink-0 bg-blue grid place-items-center"><Flame size={16} className="text-white" /></span>
                                  <div className="flex-1 min-w-0">
                                    <div className="text-[14.5px] font-semibold tracking-[-0.01em] text-ink truncate">{p.name} <span className="font-mono text-[11px] font-normal text-blue-text ml-0.5">{fq(p.suggestedQty)} {p.unit}</span></div>
                                    <div className="font-mono text-[10.5px] text-blue-text mt-1 flex items-center gap-1.5 whitespace-nowrap">
                                      <span className="w-[7px] h-[7px] rounded-full bg-blue shrink-0 animate-pulse" />
                                      {p.todayLog?.updatedAt ? `${elapsedStr(nowTs - new Date(p.todayLog.updatedAt).getTime())} elapsed` : 'in progress'}{p.station ? ` · ${p.station}` : ''}
                                    </div>
                                  </div>
                                  {p.linkedRecipeId && (
                                    <button onClick={e => { e.stopPropagation(); setRecipeItem(p) }} title="View recipe" className="shrink-0 w-9 h-9 grid place-items-center rounded-[9px] bg-paper border border-[#93c5fd] text-blue-text">
                                      <BookOpen size={16} />
                                    </button>
                                  )}
                                  <button onClick={e => { e.stopPropagation(); setMobileLog({ item: p, qty: p.suggestedQty > 0 ? p.suggestedQty : 0 }) }} className="shrink-0 inline-flex items-center gap-1.5 bg-ink text-paper rounded-[9px] px-3 py-2 text-[12.5px] font-semibold">
                                    <Check size={14} className="text-gold" strokeWidth={2.8} /> Done
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </>
                      )}

                      {/* To do */}
                      {todo.length > 0 && (
                        <>
                          <GroupHead dot="#09090b" title="To do" count={`${todo.length}`} sub="Tap for recipe · start when you begin" />
                          <div className="flex flex-col gap-2 mt-2.5">
                            {todo.map(p => {
                              const isCrit = p.priority === '911'
                              const isNeeded = p.priority === 'NEEDED_TODAY'
                              const edge = isCrit ? '#dc2626' : isNeeded ? '#d97706' : null
                              const cardCls = isCrit
                                ? 'bg-[#fef2f2] border-[#fca5a5]'
                                : isNeeded
                                  ? 'bg-gold-soft/40 border-[#fcd34d]'
                                  : 'bg-paper border-line'
                              const tileCls = isCrit
                                ? 'bg-red-soft border-red-soft text-red'
                                : isNeeded
                                  ? 'bg-gold-soft border-[#fcd34d] text-gold-2'
                                  : 'bg-bg-2 border-line text-ink-3'
                              return (
                                <div key={p.id} onClick={() => p.linkedRecipeId ? setRecipeItem(p) : setSelected(p)} className={`${cardCls} border rounded-xl px-3.5 py-3 cursor-pointer`} style={edge ? { borderLeftWidth: 4, borderLeftColor: edge } : undefined}>
                                  <div className="flex items-center gap-3">
                                    <span className={`w-[30px] h-[30px] rounded-[9px] shrink-0 border grid place-items-center ${tileCls}`}><ChefHat size={16} /></span>
                                    <div className="flex-1 min-w-0">
                                      <div className="text-[14.5px] font-semibold tracking-[-0.01em] text-ink truncate">{p.name} <span className="font-mono text-[11px] font-normal text-ink-3 ml-0.5">{fq(p.suggestedQty)} {p.unit}</span></div>
                                      <div className="mt-1 flex items-center gap-1.5">
                                        {isCrit && <span className="font-mono text-[8.5px] font-bold px-2 py-0.5 rounded-full bg-red text-white uppercase tracking-[0.04em]">Critical</span>}
                                        {isNeeded && <span className="font-mono text-[8.5px] font-bold px-2 py-0.5 rounded-full bg-gold text-ink uppercase tracking-[0.04em]">Low stock</span>}
                                        <span className="whitespace-nowrap font-mono text-[10.5px] text-ink-3">{p.station || 'Prep'}{p.linkedRecipeId ? ' · recipe' : ''}</span>
                                      </div>
                                    </div>
                                    {p.linkedRecipeId && (
                                      <button onClick={e => { e.stopPropagation(); setRecipeItem(p) }} title="View recipe" className="shrink-0 w-9 h-9 grid place-items-center rounded-[9px] bg-paper border border-line text-ink-2">
                                        <BookOpen size={16} />
                                      </button>
                                    )}
                                    <button onClick={e => { e.stopPropagation(); handleStatusChange(p.id, 'IN_PROGRESS') }} className="shrink-0 inline-flex items-center gap-1.5 bg-ink text-paper rounded-[9px] px-3 py-2 text-[12.5px] font-semibold">
                                      <Zap size={13} className="text-gold" /> Start
                                    </button>
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        </>
                      )}

                      {/* Done */}
                      {done.length > 0 && (
                        <>
                          <GroupHead dot="#16a34a" title="Done" count={`${done.length}`} sub="Logged → feeds history & yield insights" />
                          <div className="flex flex-col gap-1.5 mt-2.5">
                            {done.map(p => (
                              <div key={p.id} className="flex items-center gap-3 bg-paper border border-line rounded-[10px] px-3.5 py-2.5">
                                <span className="w-6 h-6 rounded-[7px] bg-green grid place-items-center shrink-0"><Check size={14} className="text-white" strokeWidth={3} /></span>
                                <div className="flex-1 min-w-0">
                                  <div className="text-[13.5px] font-medium text-ink-3 line-through truncate">{p.name}</div>
                                  <div className="font-mono text-[10px] text-ink-4 mt-0.5">{p.station || 'Prep'} · done</div>
                                </div>
                                <span className="font-mono text-[11.5px] font-semibold text-green-text shrink-0">{fq(p.todayLog?.actualPrepQty ?? p.suggestedQty)} {p.unit}</span>
                                <button onClick={() => handleStatusChange(p.id, 'NOT_STARTED')} title="Reopen" className="w-7 h-7 rounded-[8px] border border-line grid place-items-center shrink-0 text-ink-3">
                                  <RotateCcw size={13} />
                                </button>
                              </div>
                            ))}
                          </div>
                        </>
                      )}
                    </>
                  )
                })()}
              </div>

              <p className="text-center font-mono text-[10.5px] text-ink-3 mt-3">
                This list carries over each day — items stay until marked done or removed.
              </p>
            </>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          SMART PREP TAB
      ══════════════════════════════════════════════════════ */}
      {viewMode === 'smartprep' && (
        <div className="space-y-4">
          {/* ── Desktop KPI strip (Smart Prep context cards) ── */}
          {(() => {
            const actionItems = [...spCritical, ...spNeeded]
            const topAction = actionItems[0]
            const totalPrepMinutes = actionItems.reduce((sum, i) => sum + (i.estimatedPrepTime ?? 0), 0)
            const stationsCount = new Set(items.filter(i => i.station).map(i => i.station)).size
            return (
              <div className="hidden md:grid grid-cols-[1.35fr_1.1fr_1fr_1.1fr] gap-3">
                {/* Hero — today's suggested prep */}
                <div className="bg-ink text-paper rounded-xl border border-ink p-[18px] flex flex-col justify-between min-h-[128px] relative">
                  <div className="absolute top-[18px] right-4 flex items-end gap-[2px] h-[18px]">
                    {[11,14,8,16,10,13,17,12].map((h, i) => (
                      <span key={i} className="w-[3px] rounded-[1px]" style={{ height: h, background: '#3f3f46' }} />
                    ))}
                  </div>
                  <div>
                    <p className="font-mono text-[10.5px] text-[#a1a1aa] tracking-[0.01em]">TODAY&apos;S SUGGESTED PREP</p>
                    <p className="text-[42px] font-semibold tracking-[-0.045em] leading-none mt-2">
                      {actionItems.length}
                      <sub className="text-[20px] font-medium text-gold align-baseline ml-1 tracking-[-0.02em]">
                        item{actionItems.length !== 1 ? 's' : ''}
                      </sub>
                    </p>
                  </div>
                  <p className="font-mono text-[11px] text-[#a1a1aa] mt-2">
                    {topAction
                      ? <>{topAction.suggestedQty % 1 === 0 ? topAction.suggestedQty.toFixed(0) : topAction.suggestedQty.toFixed(1)} {topAction.unit} {topAction.name.toLowerCase()}{totalPrepMinutes > 0 ? <> · <b className="text-paper font-medium">~{totalPrepMinutes} min</b></> : null}</>
                      : 'nothing to prep right now'}
                  </p>
                </div>

                {/* Critical */}
                <div className="rounded-xl p-[18px] flex flex-col justify-between min-h-[128px] relative bg-[#fef2f2] border border-[#fca5a5]">
                  {spCritical.length > 0 && <div className="absolute top-[18px] right-[18px] w-[7px] h-[7px] rounded-full bg-red" />}
                  <div>
                    <p className="font-mono text-[10.5px] tracking-[0.01em] text-red-text">CRITICAL</p>
                    <p className="text-[34px] font-semibold tracking-[-0.04em] leading-none mt-2 text-red-text">{spCritical.length}</p>
                  </div>
                  <p className="font-mono text-[11px] text-ink-3 mt-2">
                    {spCritical.length > 0
                      ? <><b className="text-red-text font-medium">Stock depleted</b> · needs prep now</>
                      : <>no critical items</>}
                  </p>
                </div>

                {/* Needed today */}
                <div className="bg-paper border border-line rounded-xl p-[18px] flex flex-col justify-between min-h-[128px]">
                  <div>
                    <p className="font-mono text-[10.5px] text-ink-3 tracking-[0.01em]">NEEDED TODAY</p>
                    <p className={`text-[34px] font-semibold tracking-[-0.04em] leading-none mt-2 ${spNeeded.length > 0 ? 'text-ink' : 'text-ink-3'}`}>{spNeeded.length}</p>
                  </div>
                  <p className="font-mono text-[11px] text-ink-3 mt-2">
                    {spNeeded.length > 0 ? 'below par — prep today' : 'no items below par right now'}
                  </p>
                </div>

                {/* Looking good */}
                <div className="bg-paper border border-line rounded-xl p-[18px] flex flex-col justify-between min-h-[128px]">
                  <div>
                    <p className="font-mono text-[10.5px] text-ink-3 tracking-[0.01em]">LOOKING GOOD</p>
                    <p className="text-[34px] font-semibold tracking-[-0.04em] leading-none mt-2 text-green-text">{spLookingGood.length}</p>
                  </div>
                  <p className="font-mono text-[11px] text-ink-3 mt-2">
                    <b className="text-green-text font-medium">on par or above</b>{stationsCount > 0 ? ` · across ${stationsCount} station${stationsCount !== 1 ? 's' : ''}` : ''}
                  </p>
                </div>
              </div>
            )
          })()}

          {/* Info banner (branded) */}
          <div className="hidden md:flex items-center gap-3 px-4 py-3 bg-gold-soft border border-[#fcd34d] rounded-[10px]">
            <div className="w-7 h-7 rounded-[7px] bg-paper border border-[#fcd34d] grid place-items-center text-gold-2 shrink-0">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/></svg>
            </div>
            <p className="text-[13px] text-[#78350f] tracking-[-0.005em] leading-[1.4] flex-1">
              Suggestions are computed live from <b className="font-semibold text-ink">theoretical stock</b> — sales, wastage &amp; invoices since the last count. Resets at each stock count.
            </p>
          </div>

          {/* Mobile Smart Prep summary — compact context strip (mirrors desktop cards) */}
          {(() => {
            const actionItems = [...spCritical, ...spNeeded]
            const totalPrepMinutes = actionItems.reduce((sum, i) => sum + (i.estimatedPrepTime ?? 0), 0)
            return (
              <div className="md:hidden bg-ink text-paper rounded-xl px-3.5 py-2.5 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-mono text-[9px] text-ink-4 uppercase tracking-[0.05em]">To prep</div>
                  <div className="text-[18px] font-semibold tracking-[-0.03em] leading-none mt-1 whitespace-nowrap">
                    {actionItems.length}
                    <span className="text-[11px] font-normal text-ink-4 ml-1">item{actionItems.length !== 1 ? 's' : ''}{totalPrepMinutes > 0 ? ` · ~${totalPrepMinutes >= 90 ? `${Math.round(totalPrepMinutes / 60)}h` : `${totalPrepMinutes}m`}` : ''}</span>
                  </div>
                </div>
                <div className="flex items-stretch gap-0 shrink-0 font-mono text-center divide-x divide-zinc-700">
                  <div className="px-3">
                    <div className="text-[16px] font-semibold leading-none text-[#fca5a5]">{spCritical.length}</div>
                    <div className="text-[8px] text-ink-4 uppercase tracking-[0.04em] mt-1">Crit</div>
                  </div>
                  <div className="px-3">
                    <div className="text-[16px] font-semibold leading-none text-gold">{spNeeded.length}</div>
                    <div className="text-[8px] text-ink-4 uppercase tracking-[0.04em] mt-1">Need</div>
                  </div>
                  <div className="px-3">
                    <div className="text-[16px] font-semibold leading-none text-[#86efac]">{spLookingGood.length}</div>
                    <div className="text-[8px] text-ink-4 uppercase tracking-[0.04em] mt-1">Par</div>
                  </div>
                </div>
              </div>
            )
          })()}

          {/* Desktop tools row: search + dropdowns + segmented control */}
          <div className="hidden md:grid grid-cols-[1fr_auto_auto_auto_auto] gap-2 items-center">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" />
              <input
                className="w-full bg-paper border border-line rounded-[9px] pl-9 pr-3 py-2.5 text-[13px] text-ink placeholder:text-ink-3 focus:outline-none focus:border-ink-3 transition-colors tracking-[-0.005em]"
                placeholder="Search prep items, recipes, stations…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <select
              value={filterCategory}
              onChange={e => setFilterCategory(e.target.value)}
              className="bg-paper border border-line rounded-[9px] px-3 py-2.5 text-[13px] text-ink-2 hover:border-ink-3 focus:outline-none focus:border-ink-3 transition-colors min-w-[140px] tracking-[-0.005em]"
            >
              <option value="ALL">All categories</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select
              value={filterStation}
              onChange={e => setFilterStation(e.target.value)}
              className="bg-paper border border-line rounded-[9px] px-3 py-2.5 text-[13px] text-ink-2 hover:border-ink-3 focus:outline-none focus:border-ink-3 transition-colors min-w-[140px] tracking-[-0.005em]"
            >
              <option value="ALL">All stations</option>
              <option value="UNASSIGNED">Unassigned</option>
              {stations.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <label className="bg-paper border border-line rounded-[9px] px-3 py-2.5 text-[13px] text-ink-2 hover:border-ink-3 transition-colors flex items-center gap-2 cursor-pointer tracking-[-0.005em]">
              <span className={`w-[14px] h-[14px] border-[1.5px] rounded-[3px] grid place-items-center text-[9px] ${activeOnly ? 'bg-ink border-ink text-paper' : 'border-line-2 bg-paper'}`}>
                {activeOnly && '✓'}
              </span>
              <input type="checkbox" checked={activeOnly} onChange={e => setActiveOnly(e.target.checked)} className="hidden" />
              Active only
            </label>
            <div className="flex bg-paper border border-line rounded-[9px] p-[3px]">
              {(['urgency', 'category', 'station'] as const).map(v => (
                <button key={v} onClick={() => setSmartPrepView(v)}
                  className={`px-3 py-1.5 font-mono text-[11px] rounded-[6px] transition-colors whitespace-nowrap ${smartPrepView === v ? 'bg-ink text-paper' : 'text-ink-3 hover:text-ink-2'}`}>
                  By {v}
                </button>
              ))}
            </div>
          </div>

          {/* Desktop "showing N items" mono label */}
          <p className="hidden md:block font-mono text-[11px] text-ink-3 tracking-[0.01em]">
            SHOWING {items.length} ITEMS · GROUPED BY {smartPrepView.toUpperCase()} · RESETS WITH NEXT COUNT
          </p>

          {/* Mobile view toggle */}
          <div className="md:hidden flex bg-bg-2 rounded-[10px] p-1 gap-0.5 border border-line">
            {(['urgency', 'category', 'station'] as const).map(v => (
              <button key={v} onClick={() => setSmartPrepView(v)}
                className={`flex-1 py-2 font-mono text-[11px] uppercase tracking-[0.04em] rounded-[7px] transition-colors ${smartPrepView === v ? 'bg-paper shadow-sm text-ink' : 'text-ink-3'}`}>
                By {v === 'urgency' ? 'Urgency' : v === 'category' ? 'Category' : 'Station'}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="flex justify-center py-16">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gold" />
            </div>
          ) : (
            <>
              {/* ── BY URGENCY ── */}
              {smartPrepView === 'urgency' && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5 items-start">

                  {/* Critical column */}
                  <div className="bg-[#fffafa] md:bg-[#fffafa] border md:border-[#fca5a5] border-gray-100 rounded-xl flex flex-col min-h-[480px]">
                    <div className="px-4 py-3.5 border-b border-[#fca5a5] flex items-center justify-between gap-2.5">
                      <div className="flex items-center gap-2 min-w-0 flex-1 whitespace-nowrap">
                        <span className="w-2 h-2 rounded-full bg-red" />
                        <span className="font-mono text-[11.5px] tracking-[0.02em] font-semibold text-red-text">CRITICAL</span>
                        <span className="font-mono text-[11px] text-ink-3 font-normal">· {spCritical.length} item{spCritical.length !== 1 ? 's' : ''}</span>
                      </div>
                      {spCritical.some(i => !i.isOnList) && (
                        <button onClick={() => handleAddAll('911')}
                          className="font-mono text-[10.5px] px-2.5 py-1 rounded-full font-medium border border-red bg-red text-paper hover:bg-red whitespace-nowrap">
                          + Add all
                        </button>
                      )}
                    </div>
                    <p className="font-mono text-[10.5px] text-red-text px-4 pt-2 pb-1">Stock depleted — make now</p>
                    <div className="flex-1 px-3 pb-3 pt-2 flex flex-col gap-2 overflow-auto">
                      {spCritical.length === 0 ? (
                        <div className="flex-1 flex flex-col items-center justify-center py-10 text-center">
                          <div className="w-9 h-9 rounded-full bg-bg-2 grid place-items-center text-ink-4 mb-2.5">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
                          </div>
                          <p className="text-[13px] text-ink-3 tracking-[-0.005em]">No critical items</p>
                        </div>
                      ) : (
                        spCritical.map(item => <SmartPrepCard key={item.id} item={item} />)
                      )}
                    </div>
                  </div>

                  {/* Needed Today column */}
                  <div className="bg-paper border border-line rounded-xl flex flex-col min-h-[480px]">
                    <div className="px-4 py-3.5 border-b border-line flex items-center justify-between gap-2.5">
                      <div className="flex items-center gap-2 min-w-0 flex-1 whitespace-nowrap">
                        <span className="w-2 h-2 rounded-full bg-gold" />
                        <span className="font-mono text-[11.5px] tracking-[0.02em] font-semibold text-gold-2">NEEDED TODAY</span>
                        <span className="font-mono text-[11px] text-ink-3 font-normal">· {spNeeded.length} item{spNeeded.length !== 1 ? 's' : ''}</span>
                      </div>
                      {spNeeded.some(i => !i.isOnList) && (
                        <button onClick={() => handleAddAll('NEEDED_TODAY')}
                          className="font-mono text-[10.5px] px-2.5 py-1 rounded-full font-medium border border-ink bg-ink text-paper hover:bg-ink-2 whitespace-nowrap">
                          + Add all
                        </button>
                      )}
                    </div>
                    <p className="font-mono text-[10.5px] text-ink-3 px-4 pt-2 pb-1">Below par — should be prepped today</p>
                    <div className="flex-1 px-3 pb-3 pt-2 flex flex-col gap-2 overflow-auto">
                      {spNeeded.length === 0 ? (
                        <div className="flex-1 flex flex-col items-center justify-center py-10 text-center">
                          <div className="w-9 h-9 rounded-full bg-bg-2 grid place-items-center text-ink-4 mb-2.5">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
                          </div>
                          <p className="text-[13px] text-ink-3 tracking-[-0.005em]">All par levels met<br/>
                            <span className="text-ink-4 text-[12px]">Nothing else needs prepping today.</span>
                          </p>
                        </div>
                      ) : (
                        spNeeded.map(item => <SmartPrepCard key={item.id} item={item} />)
                      )}
                    </div>
                  </div>

                  {/* Looking Good column */}
                  <div className="bg-paper border border-line rounded-xl flex flex-col min-h-[480px]">
                    <button
                      onClick={() => setLookingGoodOpen(v => !v)}
                      className="px-4 py-3.5 border-b border-line flex items-center justify-between gap-2.5 hover:bg-bg-2/40 transition-colors"
                    >
                      <div className="flex items-center gap-2 min-w-0 flex-1 whitespace-nowrap">
                        <span className="w-2 h-2 rounded-full bg-green" />
                        <span className="font-mono text-[11.5px] tracking-[0.02em] font-semibold text-green-text">LOOKING GOOD</span>
                        <span className="font-mono text-[11px] text-ink-3 font-normal">· {spLookingGood.length} item{spLookingGood.length !== 1 ? 's' : ''}</span>
                      </div>
                      <span className="font-mono text-[11px] text-ink-3">{lookingGoodOpen ? '▾' : '→'}</span>
                    </button>
                    <p className="font-mono text-[10.5px] text-ink-3 px-4 pt-2 pb-1">On par or above — no action needed</p>
                    {lookingGoodOpen ? (
                      <div className="flex-1 px-3 pb-3 pt-2 flex flex-col gap-1.5 overflow-auto">
                        {spLookingGood.length === 0 ? (
                          <div className="flex-1 flex items-center justify-center text-[13px] text-ink-3">No items</div>
                        ) : (
                          spLookingGood.map(item => {
                            const pct = item.parLevel > 0 ? Math.round(((item.onHand - item.parLevel) / item.parLevel) * 100) : 0
                            const label = pct === 0 ? 'on par' : (pct > 0 ? `+${pct}%` : `${pct}%`)
                            const isAdded = item.isOnList
                            return (
                              <div key={item.id}
                                className="bg-bg border border-line rounded-lg px-3 py-2.5 flex items-center justify-between gap-2.5 hover:border-ink-3 transition-colors">
                                <button onClick={() => setSelected(item)} className="flex flex-col gap-0.5 min-w-0 text-left hover:opacity-80 transition-opacity">
                                  <span className="text-[13px] font-medium text-ink tracking-[-0.01em] truncate">{item.name}</span>
                                  <span className="font-mono text-[10.5px] text-ink-3 whitespace-nowrap">
                                    {item.category} · {item.onHand % 1 === 0 ? item.onHand.toFixed(0) : item.onHand.toFixed(1)} / {item.parLevel % 1 === 0 ? item.parLevel.toFixed(0) : item.parLevel.toFixed(1)} {item.unit}
                                  </span>
                                </button>
                                <div className="flex items-center gap-2.5 shrink-0">
                                  <span className="font-mono text-[11px] text-green-text font-medium">{label}</span>
                                  <button
                                    onClick={() => handleToggleOnList(item.id, !isAdded)}
                                    title={isAdded ? "Remove from today's list" : "Add to today's list"}
                                    className={`px-2.5 py-1 rounded-[7px] text-[11px] font-medium inline-flex items-center gap-1 whitespace-nowrap transition-colors group ${
                                      isAdded
                                        ? 'bg-bg-2 text-ink-2 border border-line hover:border-red-soft hover:bg-red-soft hover:text-red'
                                        : 'bg-ink text-paper hover:bg-ink-2'
                                    }`}
                                  >
                                    {isAdded
                                      ? <><Check size={11} className="text-green group-hover:text-red" /> On list <span className="opacity-50">✕</span></>
                                      : <><span className="text-gold font-semibold">+</span> Add</>}
                                  </button>
                                </div>
                              </div>
                            )
                          })
                        )}
                      </div>
                    ) : (
                      <div className="flex-1 px-3 pb-3 pt-2 flex flex-col gap-1.5 overflow-hidden">
                        {spLookingGood.slice(0, 6).map(item => {
                          const pct = item.parLevel > 0 ? Math.round(((item.onHand - item.parLevel) / item.parLevel) * 100) : 0
                          const label = pct === 0 ? 'on par' : (pct > 0 ? `+${pct}%` : `${pct}%`)
                          const isAdded = item.isOnList
                          return (
                            <div key={item.id}
                              className="bg-bg border border-line rounded-lg px-3 py-2 flex items-center justify-between gap-2.5 hover:border-ink-3 transition-colors">
                              <button onClick={() => setSelected(item)} className="text-[12.5px] font-medium text-ink tracking-[-0.01em] truncate min-w-0 text-left hover:opacity-80 transition-opacity">{item.name}</button>
                              <div className="flex items-center gap-2 shrink-0">
                                <span className="font-mono text-[10.5px] text-green-text font-medium">{label}</span>
                                <button
                                  onClick={() => handleToggleOnList(item.id, !isAdded)}
                                  title={isAdded ? "Remove from today's list" : "Add to today's list"}
                                  className={`w-6 h-6 grid place-items-center rounded-[6px] text-[12px] font-medium transition-colors group ${
                                    isAdded
                                      ? 'bg-bg-2 text-ink-2 border border-line hover:border-red-soft hover:bg-red-soft hover:text-red'
                                      : 'bg-ink text-paper hover:bg-ink-2'
                                  }`}
                                >
                                  {isAdded
                                    ? <Check size={12} className="text-green group-hover:text-red" />
                                    : <span className="text-gold font-semibold leading-none">+</span>}
                                </button>
                              </div>
                            </div>
                          )
                        })}
                        {spLookingGood.length > 6 && (
                          <button onClick={() => setLookingGoodOpen(true)} className="font-mono text-[10.5px] uppercase tracking-[0.04em] text-ink-3 hover:text-ink py-2 text-center border-t border-line mt-1 pt-2.5 transition-colors">
                            + {spLookingGood.length - 6} more · expand all
                          </button>
                        )}
                        {spLookingGood.length === 0 && (
                          <div className="flex-1 flex items-center justify-center text-[12.5px] text-ink-3">No items</div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* ── BY CATEGORY ── */}
              {smartPrepView === 'category' && (
                <div className="space-y-3">
                  {spCategoryGroups.map(([cat, rows]) => {
                    const criticalCount = rows.filter(i => i.priority === '911').length
                    const neededCount = rows.filter(i => i.priority === 'NEEDED_TODAY').length
                    return (
                      <div key={cat} className="bg-paper border border-line rounded-xl overflow-hidden">
                        {/* Group header — branded "grow" style (gold-soft for active categories, neutral otherwise) */}
                        <div className={`grid grid-cols-[1fr_auto] items-center px-[18px] py-2.5 border-b ${criticalCount > 0 || neededCount > 0 ? 'bg-gold-soft border-[#fcd34d]' : 'bg-bg-2 border-line'}`}>
                          <div className="flex items-center gap-2 min-w-0 whitespace-nowrap">
                            <span className={`font-mono text-[11.5px] tracking-[0.02em] font-semibold ${criticalCount > 0 || neededCount > 0 ? 'text-gold-2' : 'text-ink-2'}`}>{cat.toUpperCase()}</span>
                            <span className={`font-mono text-[11px] font-normal ${criticalCount > 0 || neededCount > 0 ? 'text-gold-2/80' : 'text-ink-3'}`}>· {rows.length} item{rows.length !== 1 ? 's' : ''}</span>
                          </div>
                          {(criticalCount > 0 || neededCount > 0) && (
                            <div className="flex items-center gap-1.5">
                              {criticalCount > 0 && <span className="font-mono text-[10px] bg-red-soft text-red-text px-1.5 py-0.5 rounded-full font-semibold tracking-[0]">{criticalCount} critical</span>}
                              {neededCount > 0 && <span className="font-mono text-[10px] bg-paper text-gold-2 border border-[#fcd34d] px-1.5 py-0.5 rounded-full font-semibold tracking-[0]">{neededCount} needed</span>}
                            </div>
                          )}
                        </div>
                        {/* Desktop table header */}
                        <div className="hidden md:grid grid-cols-[16px_2fr_1fr_110px_1fr_220px_110px] gap-3 items-center px-[18px] py-2.5 bg-bg-2 border-b border-line font-mono text-[10.5px] text-ink-3 tracking-[0.01em]">
                          <div /> <div>ITEM</div> <div>STOCK VS PAR</div> <div>ON HAND</div> <div>MAKE</div> <div>OVERRIDE</div> <div className="text-right">ACTION</div>
                        </div>
                        {/* Desktop rows */}
                        <div className="hidden md:block">
                          {rows.map(item => <SmartPrepTableRow key={item.id} item={item} />)}
                        </div>
                        {/* Mobile cards */}
                        <div className="md:hidden p-3 flex flex-col gap-2">
                          {rows.map(item => <SmartPrepCard key={item.id} item={item} />)}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              {/* ── BY STATION ── */}
              {smartPrepView === 'station' && (
                <div className="space-y-3">
                  {(spStationGroups ?? []).map(([station, rows]) => {
                    const emoji = STATION_EMOJI[station] ?? '🍽'
                    const criticalCount = rows.filter(i => i.priority === '911').length
                    const neededCount = rows.filter(i => i.priority === 'NEEDED_TODAY').length
                    const hasUrgent = criticalCount > 0 || neededCount > 0
                    return (
                      <div key={station} className="bg-paper border border-line rounded-xl overflow-hidden">
                        {/* Group header */}
                        <div className={`grid grid-cols-[1fr_auto] items-center px-[18px] py-2.5 border-b ${hasUrgent ? 'bg-gold-soft border-[#fcd34d]' : 'bg-bg-2 border-line'}`}>
                          <div className="flex items-center gap-2 min-w-0 whitespace-nowrap">
                            <span className="text-[13px]">{emoji}</span>
                            <span className={`font-mono text-[11.5px] tracking-[0.02em] font-semibold ${hasUrgent ? 'text-gold-2' : 'text-ink-2'}`}>{station.toUpperCase()} STATION</span>
                            <span className={`font-mono text-[11px] font-normal ${hasUrgent ? 'text-gold-2/80' : 'text-ink-3'}`}>· {rows.length} item{rows.length !== 1 ? 's' : ''}</span>
                          </div>
                          {hasUrgent && (
                            <div className="flex items-center gap-1.5">
                              {criticalCount > 0 && <span className="font-mono text-[10px] bg-red-soft text-red-text px-1.5 py-0.5 rounded-full font-semibold tracking-[0]">{criticalCount} critical</span>}
                              {neededCount > 0 && <span className="font-mono text-[10px] bg-paper text-gold-2 border border-[#fcd34d] px-1.5 py-0.5 rounded-full font-semibold tracking-[0]">{neededCount} needed</span>}
                            </div>
                          )}
                        </div>
                        {/* Desktop table header */}
                        <div className="hidden md:grid grid-cols-[16px_2fr_1fr_110px_1fr_220px_110px] gap-3 items-center px-[18px] py-2.5 bg-bg-2 border-b border-line font-mono text-[10.5px] text-ink-3 tracking-[0.01em]">
                          <div /> <div>ITEM</div> <div>STOCK VS PAR</div> <div>ON HAND</div> <div>MAKE</div> <div>OVERRIDE</div> <div className="text-right">ACTION</div>
                        </div>
                        <div className="hidden md:block">
                          {rows.map(item => <SmartPrepTableRow key={item.id} item={item} />)}
                        </div>
                        <div className="md:hidden p-3 flex flex-col gap-2">
                          {rows.map(item => <SmartPrepCard key={item.id} item={item} />)}
                        </div>
                      </div>
                    )
                  })}
                  {(!spStationGroups || spStationGroups.length === 0) && (
                    <div className="bg-paper border border-line rounded-xl py-14 text-center">
                      <p className="text-[13.5px] text-ink-2 font-medium">No stations configured.</p>
                      <p className="font-mono text-[11px] text-ink-3 mt-1.5 tracking-[0]">
                        Add stations in{' '}
                        <button onClick={() => setShowSettings(true)} className="text-gold-2 hover:underline font-medium">Settings</button>.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* Footer hints */}
              <div className="hidden md:flex justify-between font-mono text-[10.5px] text-ink-3 tracking-[0.02em] pt-2">
                <span>
                  SUGGESTIONS REFRESH WITH EACH COUNT · {spCritical.length} CRITICAL · {spNeeded.length} NEEDED · {spLookingGood.length} ON PAR
                </span>
                <span>
                  <kbd className="font-mono text-[10px] bg-bg-2 border border-line rounded px-1 py-px text-ink-2">⌘R</kbd> REFRESH ·{' '}
                  <kbd className="font-mono text-[10px] bg-bg-2 border border-line rounded px-1 py-px text-ink-2">⌘N</kbd> NEW PREP ITEM
                </span>
              </div>
            </>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          HISTORY TAB
      ══════════════════════════════════════════════════════ */}
      {viewMode === 'history' && (
        <div className="space-y-4">
          <div className="bg-white border border-gray-100 rounded-xl p-4 flex items-center gap-3 flex-wrap">
            <History size={16} className="text-gray-400 shrink-0" />
            <span className="text-sm font-medium text-gray-700">View date:</span>
            <input
              type="date"
              max={new Date().toISOString().slice(0, 10)}
              value={historyDate}
              onChange={e => setHistoryDate(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
            />
            <span className="text-xs text-gray-400 ml-auto">
              {new Date(historyDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
            </span>
          </div>

          {historyLoading ? (
            <div className="flex justify-center py-12">
              <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-gold" />
            </div>
          ) : historyLogs.length === 0 ? (
            <div className="bg-white border border-gray-100 rounded-xl py-14 text-center">
              <History size={28} className="mx-auto text-gray-300 mb-3" />
              <p className="text-gray-500 text-sm">No prep was logged on this date.</p>
              <p className="text-xs text-gray-400 mt-1">Try a different date.</p>
            </div>
          ) : (() => {
            const STATUS_HIST: Record<string, { label: string; cls: string }> = {
              DONE:        { label: 'Done',        cls: 'bg-green-soft text-green-text' },
              PARTIAL:     { label: 'Partial',     cls: 'bg-amber-100 text-amber-700' },
              IN_PROGRESS: { label: 'In Progress', cls: 'bg-gold/15 text-gold' },
              BLOCKED:     { label: 'Blocked',     cls: 'bg-red-soft text-red-text' },
              SKIPPED:     { label: 'Skipped',     cls: 'bg-gray-100 text-gray-400' },
              NOT_STARTED: { label: 'Not Started', cls: 'bg-gray-100 text-gray-400' },
            }
            const done    = historyLogs.filter(l => l.status === 'DONE').length
            const partial = historyLogs.filter(l => l.status === 'PARTIAL').length
            const blocked = historyLogs.filter(l => l.status === 'BLOCKED').length
            const total   = historyLogs.length
            const completionRate = total > 0 ? Math.round(((done + partial) / total) * 100) : 0
            return (
              <>
                <div className="grid grid-cols-4 gap-3">
                  {[
                    { label: 'Total', value: total, cls: 'text-gray-800' },
                    { label: 'Done', value: done, cls: 'text-green-text' },
                    { label: 'Partial', value: partial, cls: 'text-amber-700' },
                    { label: 'Completion', value: `${completionRate}%`, cls: completionRate >= 80 ? 'text-green-text' : completionRate >= 50 ? 'text-amber-700' : 'text-red' },
                  ].map(c => (
                    <div key={c.label} className="bg-white border border-gray-100 rounded-xl p-3 text-center">
                      <div className="text-xs text-gray-400 mb-1">{c.label}</div>
                      <div className={`text-lg font-bold ${c.cls}`}>{c.value}</div>
                    </div>
                  ))}
                </div>

                {blocked > 0 && (
                  <div className="bg-red-soft border border-red-soft rounded-xl px-4 py-2.5 text-sm text-red-text">
                    {blocked} item{blocked !== 1 ? 's were' : ' was'} blocked — see notes below.
                  </div>
                )}

                <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
                  <div className="px-4 py-2 bg-gray-50 border-b border-gray-100 flex items-center gap-2">
                    <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Items Logged</span>
                    <span className="text-xs text-gray-400">{total}</span>
                  </div>
                  <div className="divide-y divide-gray-50">
                    {historyLogs.map(log => {
                      const meta = STATUS_HIST[log.status] ?? STATUS_HIST.NOT_STARTED
                      return (
                        <div key={log.id} className="px-4 py-3 flex items-center gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-gray-800 truncate">{log.prepItem.name}</div>
                            {log.note && <div className="text-xs text-gray-400 mt-0.5 truncate">{log.note}</div>}
                            {log.assignedTo && <div className="text-xs text-gray-400">by {log.assignedTo}</div>}
                          </div>
                          <div className="flex items-center gap-3 shrink-0">
                            {log.actualPrepQty != null && (
                              <span className="text-sm text-gray-600 font-medium">
                                {Number(log.actualPrepQty).toFixed(1)} {log.prepItem.unit}
                              </span>
                            )}
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${meta.cls}`}>{meta.label}</span>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </>
            )
          })()}
        </div>
      )}

      {/* Detail panel */}
      {selectedLive && (
        <PrepDetailPanel
          item={selectedLive}
          onClose={() => setSelected(null)}
          onRefresh={() => { load(); setSelected(null) }}
          onEdit={() => { setEditing(selectedLive); setSelected(null) }}
        />
      )}

      {showAdd && (
        <PrepItemForm onClose={() => setShowAdd(false)} onSaved={load} />
      )}

      {editing && (
        <PrepItemForm
          item={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { load(); setEditing(null) }}
        />
      )}

      {showSettings && (
        <PrepSettingsModal
          onClose={() => setShowSettings(false)}
          onSaved={() => { load(); loadSettings(); setShowSettings(false) }}
        />
      )}

      {/* Recipe view (from a To-Do card) — scaled ingredients with check-off + flow to start/log */}
      {recipeItem && recipeItem.linkedRecipeId && (
        <RecipeViewModal
          recipeId={recipeItem.linkedRecipeId}
          recipeName={recipeItem.name}
          suggestedQty={recipeItem.suggestedQty > 0 ? recipeItem.suggestedQty : undefined}
          yieldUnit={recipeItem.unit}
          baseYieldQty={recipeItem.linkedRecipe?.baseYieldQty}
          checkedIngredients={checkedIng[recipeItem.id] ?? new Set()}
          onToggleIngredient={(ingId) => toggleIngredient(recipeItem.id, ingId)}
          onClose={() => setRecipeItem(null)}
          footerAction={
            recipeItem.todayLog?.status === 'IN_PROGRESS'
              ? { label: 'Log yield made', onClick: () => { const it = recipeItem; setRecipeItem(null); setMobileLog({ item: it, qty: it.suggestedQty > 0 ? it.suggestedQty : 0 }) } }
              : { label: 'Start prep', onClick: () => { handleStatusChange(recipeItem.id, 'IN_PROGRESS'); setRecipeItem(null) } }
          }
        />
      )}

      {/* Mobile log-yield sheet (from an in-progress To-Do card) */}
      {mobileLog && (() => {
        const { item, qty } = mobileLog
        const isFine = item.unit === 'kg' || item.unit === 'L'
        const step = isFine ? 0.1 : 1
        const setQty = (q: number) => setMobileLog(m => m ? { ...m, qty: Math.max(0, +q.toFixed(1)) } : m)
        const meetsPar = qty >= item.parLevel
        return (
          <div className="md:hidden fixed inset-0 z-[80] flex items-end">
            <div className="absolute inset-0 bg-black/40" onClick={() => setMobileLog(null)} />
            <div className="relative w-full bg-paper rounded-t-2xl shadow-xl pb-8 animate-[slide-up_.25s_ease]">
              <div className="flex justify-center pt-2.5"><div className="w-9 h-[5px] rounded-full bg-line-2" /></div>
              <div className="flex items-center justify-between px-5 pt-3 pb-1">
                <div className="text-[18px] font-semibold tracking-[-0.02em]">Log · {item.name}</div>
                <button onClick={() => setMobileLog(null)} className="w-8 h-8 rounded-full bg-bg-2 grid place-items-center text-ink-3"><X size={16} /></button>
              </div>
              <div className="px-5 pt-2">
                <div className="font-mono text-[11px] text-ink-3 mb-3">
                  {(item.station || 'PREP').toUpperCase()} · PLANNED {fq(item.suggestedQty)} {item.unit} · PAR {fq(item.parLevel)} {item.unit}
                </div>
                <div className="font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em] text-center mb-3">Yield made · {item.unit}</div>
                <div className="flex items-center gap-3">
                  <button onClick={() => setQty(qty - step)} className="w-[60px] h-[60px] rounded-2xl bg-bg-2 border border-line grid place-items-center shrink-0"><Minus size={26} className="text-ink-2" /></button>
                  <div className="flex-1 text-center">
                    <div className="text-[44px] font-semibold tracking-[-0.04em] leading-none">{isFine ? qty.toFixed(1) : qty.toFixed(0)}</div>
                  </div>
                  <button onClick={() => setQty(qty + step)} className="w-[60px] h-[60px] rounded-2xl bg-ink grid place-items-center shrink-0"><Plus size={26} className="text-gold" /></button>
                </div>
                <div className="font-mono text-[11px] text-center mt-3 mb-4" style={{ color: meetsPar ? '#15803d' : '#b45309' }}>
                  par {fq(item.parLevel)} {item.unit} · {meetsPar ? 'meets par ✓' : `short ${fq(Math.max(0, item.parLevel - qty))}${item.unit}`}
                </div>
                <div className="flex gap-2">
                  <button onClick={() => setMobileLog(null)} className="flex-1 h-12 rounded-xl border border-line text-ink-2 text-[14px] font-medium">Cancel</button>
                  <button onClick={() => { handleStatusChange(item.id, 'DONE', qty > 0 ? qty : undefined); setMobileLog(null) }} className="flex-1 h-12 rounded-xl bg-ink text-paper text-[14px] font-semibold inline-flex items-center justify-center gap-2">
                    <Check size={16} className="text-gold" strokeWidth={2.6} /> Mark done
                  </button>
                </div>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
