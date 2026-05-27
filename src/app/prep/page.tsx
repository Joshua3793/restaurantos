'use client'
import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useDrawer } from '@/contexts/DrawerContext'
import dynamic from 'next/dynamic'
import {
  ChefHat, Plus, RefreshCw, Search, Settings, BookOpen,
  SlidersHorizontal, WifiOff, RefreshCcw, History, AlertTriangle,
} from 'lucide-react'
import { savePrepCache, loadPrepCache, loadQueue, enqueueMutation, flushQueue } from '@/lib/prep-offline'
import { PrepKpiStrip }    from '@/components/prep/PrepKpiStrip'
import { PrepItemRow }     from '@/components/prep/PrepItemRow'
import type { PrepItemRich, PrepLogData } from '@/components/prep/types'

// Lazy-load conditional components — only mount when user opens them
const PrepDetailPanel   = dynamic(() => import('@/components/prep/PrepDetailPanel').then(m => ({ default: m.PrepDetailPanel })), { ssr: false, loading: () => null })
const PrepItemForm      = dynamic(() => import('@/components/prep/PrepItemForm').then(m => ({ default: m.PrepItemForm })), { ssr: false, loading: () => null })
const PrepSettingsModal = dynamic(() => import('@/components/prep/PrepSettingsModal').then(m => ({ default: m.PrepSettingsModal })), { ssr: false, loading: () => null })

export default function PrepPage() {
  const { setDrawerOpen } = useDrawer()
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

  // View state
  const [viewMode,          setViewMode]          = useState<'today' | 'smartprep' | 'history'>('today')
  const [smartPrepView,     setSmartPrepView]     = useState<'urgency' | 'category' | 'station'>('urgency')
  const [showMobileFilters, setShowMobileFilters] = useState(false)
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
    const barColor = isCritical ? 'bg-red-500' : isNeeded ? 'bg-gold' : 'bg-green-500'
    const suggestColor = isCritical ? 'text-red-700' : isNeeded ? 'text-gold-2' : 'text-green-700'
    const suggestAccent = isCritical ? 'text-red-500' : isNeeded ? 'text-gold' : 'text-green-500'
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
            className={`shrink-0 px-3 py-2 rounded-[8px] text-[12.5px] font-medium tracking-[-0.005em] inline-flex items-center gap-1 whitespace-nowrap transition-colors ${
              isAdded
                ? 'bg-green-600 text-paper hover:bg-green-700'
                : 'bg-ink text-paper hover:bg-ink-2'
            }`}
          >
            {isAdded ? <>✓ On list</> : <><span className="text-gold font-semibold">+</span> Add</>}
          </button>
        </div>

        {/* Progress */}
        <div className="flex flex-col gap-1.5">
          <div className="flex justify-between font-mono text-[11px] text-ink-3 gap-2 whitespace-nowrap">
            <span><b className="text-ink font-medium">{item.onHand % 1 === 0 ? item.onHand.toFixed(0) : item.onHand.toFixed(1)}</b> / {item.parLevel % 1 === 0 ? item.parLevel.toFixed(0) : item.parLevel.toFixed(1)} {item.unit} on hand</span>
            <span className={isCritical ? 'text-red-700' : isNeeded ? 'text-gold-2' : 'text-ink-3'}>{parPct}% of par</span>
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
          <div className="font-mono text-[11.5px] text-green-700 tracking-[0]">At or above par — looking good</div>
        )}

        {/* Override pills */}
        <div className="flex items-center gap-1.5 flex-wrap pt-2.5 border-t border-line">
          <span className="font-mono text-[10px] text-ink-3 tracking-[0.02em] mr-0.5">OVERRIDE</span>
          {(['911', 'NEEDED_TODAY', 'LATER'] as const).map(p => {
            const labels: Record<string, string> = { '911': 'Critical', 'NEEDED_TODAY': 'Needed today', 'LATER': 'Later' }
            const isActive = (item.manualPriorityOverride ?? item.priority) === p
            const activeCls = p === '911'
              ? 'bg-red-100 text-red-700 border-red-100'
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
    const dotColor = item.priority === '911' ? 'bg-red-500' : item.priority === 'NEEDED_TODAY' ? 'bg-orange-400' : 'bg-green-400'
    const borderColor = item.priority === '911' ? 'border-l-red-500' : item.priority === 'NEEDED_TODAY' ? 'border-l-orange-400' : 'border-l-green-400'
    const hoverBg = item.priority === '911' ? 'hover:bg-red-50/20' : item.priority === 'NEEDED_TODAY' ? 'hover:bg-orange-50/20' : 'hover:bg-green-50/10'
    const isAdded = item.isOnList

    const labels: Record<string, string>     = { '911': 'Critical', 'NEEDED_TODAY': 'Needed Today', 'LATER': 'Looking Good' }
    const badgeStyles: Record<string, string> = {
      '911': 'bg-red-100 text-red-700',
      'NEEDED_TODAY': 'bg-orange-100 text-orange-700',
      'LATER': 'bg-green-100 text-green-700',
    }

    return (
      <div className={`grid grid-cols-[16px_2fr_1fr_110px_1fr_220px_110px] gap-3 items-center px-5 py-3.5 border-b border-gray-50 border-l-4 ${borderColor} ${hoverBg} transition-colors`}>
        <span className={`w-2 h-2 rounded-full ${dotColor} inline-block shrink-0`} />
        <button onClick={() => setSelected(item)} className="text-left hover:opacity-80 transition-opacity min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm font-semibold text-gray-800">{item.name}</span>
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${badgeStyles[item.priority]}`}>{labels[item.priority]}</span>
            {item.station && <span className="text-[10px] bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded-full font-medium">{item.station}</span>}
            {item.manualPriorityOverride && <span className="text-[10px] text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded-full">✎ Override</span>}
            {isAdded && <span className="text-[10px] text-gray-400 italic">on list</span>}
          </div>
          <div className="text-xs text-gray-400 mt-0.5">
            {item.priority !== 'LATER' && !item.manualPriorityOverride
              ? `System suggests → ${item.suggestedQty > 0 ? `Make ${item.suggestedQty % 1 === 0 ? item.suggestedQty.toFixed(0) : item.suggestedQty.toFixed(1)} ${item.unit}` : 'review stock'}`
              : item.priority === 'LATER' ? 'At or above par' : 'Chef override active'
            }
          </div>
        </button>
        <div>
          <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div className={`h-full rounded-full ${dotColor}`} style={{ width: `${stockPct}%` }} />
          </div>
        </div>
        <div className="text-sm text-gray-600 font-medium">
          {item.onHand % 1 === 0 ? item.onHand.toFixed(0) : item.onHand.toFixed(1)} / {item.parLevel % 1 === 0 ? item.parLevel.toFixed(0) : item.parLevel.toFixed(1)} {item.unit}
        </div>
        <div className={`text-sm font-semibold ${item.priority === '911' ? 'text-red-600' : item.priority === 'NEEDED_TODAY' ? 'text-orange-600' : 'text-gray-400'}`}>
          {item.priority !== 'LATER' && item.suggestedQty > 0
            ? `${item.suggestedQty % 1 === 0 ? item.suggestedQty.toFixed(0) : item.suggestedQty.toFixed(1)} ${item.unit}`
            : '—'
          }
        </div>
        <div className="flex items-center gap-1">
          {(['911', 'NEEDED_TODAY', 'LATER'] as const).map(p => {
            const chipLabels: Record<string, string> = { '911': 'Critical', 'NEEDED_TODAY': 'Needed', 'LATER': 'Later' }
            const activeStyles: Record<string, string> = {
              '911': 'bg-red-100 text-red-700 border-red-300',
              'NEEDED_TODAY': 'bg-orange-100 text-orange-700 border-orange-300',
              'LATER': 'bg-gray-100 text-gray-600 border-gray-300',
            }
            const isActive = (item.manualPriorityOverride ?? item.priority) === p
            return (
              <button
                key={p}
                onClick={() => handlePriorityChange(item.id, isActive && item.manualPriorityOverride ? '' : p)}
                className={`pill text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                  isActive ? `${activeStyles[p]} font-semibold` : 'bg-white text-gray-400 border-gray-200'
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
            className={`btn-action px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
              isAdded
                ? 'bg-green-600 text-white hover:bg-green-700'
                : 'bg-gray-800 text-white hover:bg-gray-700'
            }`}
          >
            {isAdded ? '✓ On List' : '+ Add'}
          </button>
        </div>
      </div>
    )
  }

  // ── Page JSX ──────────────────────────────────────────────────────────────

  return (
    <div className="space-y-3 md:space-y-5">

      {/* ── Mobile Header ── */}
      <div className="md:hidden">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h1 className="text-xl font-bold text-gray-900 flex items-center gap-1.5">
              <ChefHat size={20} className="text-gold" /> Prep List
            </h1>
            <p className="text-xs text-gray-500">
              {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <button onClick={handleRefresh} disabled={generating}
              className="p-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              title="Refresh">
              <RefreshCw size={16} className={generating ? 'animate-spin' : ''} />
            </button>
            <button onClick={() => setShowSettings(true)}
              className="p-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
              title="Settings">
              <Settings size={16} />
            </button>
            <button onClick={handleSync} disabled={syncing}
              className="p-2 rounded-lg border border-gold/30 text-gold bg-gold/10 hover:bg-gold/15 disabled:opacity-50"
              title="Sync from Recipes">
              <BookOpen size={16} className={syncing ? 'animate-pulse' : ''} />
            </button>
            <button onClick={() => setShowAdd(true)}
              className="p-2 rounded-lg bg-gold text-white hover:bg-[#a88930]">
              <Plus size={16} />
            </button>
          </div>
        </div>

        {/* Mobile view tabs */}
        <div className="flex bg-gray-100 rounded-xl p-1 mt-3">
          {(['today', 'smartprep', 'history'] as const).map(m => (
            <button key={m} onClick={() => setViewMode(m)}
              className={`flex-1 py-2 text-xs font-medium rounded-lg transition-colors flex items-center justify-center gap-1 ${viewMode === m ? 'bg-white shadow text-gray-900' : 'text-gray-500'}`}>
              {m === 'today' ? <>To Do {todayItems.length > 0 && <span className="bg-amber-500 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full">{todayItems.length}</span>}</> : m === 'smartprep' ? <>Smart Prep {(spCritical.length + spNeeded.length) > 0 && <span className="bg-red-500 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full">{spCritical.length + spNeeded.length}</span>}</> : <><History size={12} /> History</>}
            </button>
          ))}
        </div>

        {/* Mobile KPI strip (Today only) */}
        {viewMode === 'today' && (
          <div className="mt-2">
            <PrepKpiStrip items={todayItems} />
          </div>
        )}

        {/* Search + filter toggle */}
        {viewMode !== 'history' && (
          <div className="flex gap-2 mt-3">
            <div className="relative flex-1">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-gold"
                placeholder="Search prep items…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <button
              onClick={() => setShowMobileFilters(v => !v)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border text-sm font-medium transition-colors ${
                showMobileFilters || activeFilterCount > 0
                  ? 'border-blue-300 bg-gold/10 text-gold'
                  : 'border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}>
              <SlidersHorizontal size={15} />
              {activeFilterCount > 0 ? <span className="bg-gold text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">{activeFilterCount}</span> : 'Filter'}
            </button>
          </div>
        )}

        {showMobileFilters && (
          <div className="mt-2 bg-white border border-gray-100 rounded-xl p-3 space-y-2">
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
              {todayItems.length > 0 && <span className="font-mono text-[10px] bg-red-500 text-white px-1.5 py-0.5 rounded-full font-semibold">{todayItems.length}</span>}
            </button>
            <button onClick={() => setViewMode('smartprep')} id="dtab-smartprep"
              className={`px-3.5 py-1.5 text-[13px] font-medium rounded-[7px] transition-colors flex items-center gap-1.5 tracking-[-0.005em] ${viewMode === 'smartprep' ? 'bg-paper text-ink shadow-[0_1px_2px_rgba(0,0,0,0.04)]' : 'text-ink-3 hover:text-ink-2'}`}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>
              Smart prep
              {(spCritical.length + spNeeded.length) > 0 && <span className="font-mono text-[10px] bg-red-500 text-white px-1.5 py-0.5 rounded-full font-semibold">{spCritical.length + spNeeded.length}</span>}
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

        {/* Desktop filter bar (Today + Smart Prep only) */}
        {viewMode !== 'history' && (
          <div className="bg-white border border-gray-100 rounded-xl px-4 py-3 flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 min-w-48">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                className="w-full pl-9 pr-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-gold"
                placeholder="Search prep items…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <select className={selCls} value={filterCategory} onChange={e => setFilterCategory(e.target.value)}>
              <option value="ALL">All Categories</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select className={selCls} value={filterStation} onChange={e => setFilterStation(e.target.value)}>
              <option value="ALL">All Stations</option>
              <option value="UNASSIGNED">Unassigned</option>
              {stations.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-600 ml-auto">
              <input type="checkbox" checked={activeOnly}
                onChange={e => setActiveOnly(e.target.checked)}
                className="rounded text-gold" />
              Active only
            </label>
          </div>
        )}
      </div>

      {/* ── System banners ── */}
      {actionError && (
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          <span>{actionError}</span>
          <button onClick={() => setActionError(null)} className="shrink-0 text-red-400 hover:text-red-600">✕</button>
        </div>
      )}

      {(isOffline || pendingCount > 0) && (
        <div className={`flex items-center justify-between gap-3 px-4 py-2.5 rounded-xl text-sm border ${
          isOffline ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-gold/10 border-gold/30 text-blue-800'
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
            <button onClick={handleOfflineSync} className="shrink-0 flex items-center gap-1 text-xs font-medium text-gold hover:text-blue-900">
              <RefreshCcw size={12} /> Sync now
            </button>
          )}
        </div>
      )}

      {syncResult && (
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 bg-green-50 border border-green-200 rounded-xl text-sm text-green-800">
          <span>
            {(syncResult.created > 0 || syncResult.updated > 0)
              ? <>{syncResult.created > 0 && <> Created <strong>{syncResult.created}</strong> new prep item{syncResult.created !== 1 ? 's' : ''}.</>}{syncResult.updated > 0 && <> Updated categor{syncResult.updated !== 1 ? 'ies' : 'y'} on <strong>{syncResult.updated}</strong> existing item{syncResult.updated !== 1 ? 's' : ''}.</>}</>
              : <>Everything is already in sync — {syncResult.skipped} prep item{syncResult.skipped !== 1 ? 's' : ''} matched.</>
            }
          </span>
          <button onClick={() => setSyncResult(null)} className="shrink-0 text-green-500 hover:text-green-700">✕</button>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          TODAY TAB
      ══════════════════════════════════════════════════════ */}
      {viewMode === 'today' && (
        <div className="space-y-4">

          {/* Desktop KPI strip */}
          <div className="hidden md:block">
            <PrepKpiStrip items={todayItems} />
          </div>

          {/* Priority-change alert */}
          {priorityAlerts.length > 0 && (
            <div className="bg-orange-50 border border-orange-200 rounded-xl px-4 py-3 flex items-start gap-3">
              <AlertTriangle size={16} className="text-orange-500 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-semibold text-orange-800">Stock changed since scheduling</p>
                <p className="text-sm text-orange-700 mt-0.5">
                  {priorityAlerts.length === 1
                    ? <><strong>{priorityAlerts[0].name}</strong> is now Critical — theoretical stock at or below 0.</>
                    : <><strong>{priorityAlerts.map(i => i.name).join(', ')}</strong> — now Critical, stock depleted.</>
                  }
                </p>
              </div>
            </div>
          )}

          {loading ? (
            <div className="flex justify-center py-16">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gold" />
            </div>
          ) : todayItems.length === 0 ? (
            <div className="bg-white border border-gray-100 rounded-xl py-16 text-center">
              <ChefHat size={32} className="mx-auto text-gray-300 mb-3" />
              <p className="text-gray-500 text-sm">Nothing on today&apos;s list yet.</p>
              <p className="text-xs text-gray-400 mt-2">
                Go to{' '}
                <button onClick={() => setViewMode('smartprep')} className="text-gold hover:underline">
                  Smart Prep
                </button>
                {' '}and add items to your list.
              </p>
            </div>
          ) : (
            <>
              {/* Today list */}
              <div className="bg-white border border-gray-100 rounded-xl overflow-hidden divide-y divide-gray-50">
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
              <p className="text-center text-xs text-gray-400">
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
                  {spCritical.length > 0 && <div className="absolute top-[18px] right-[18px] w-[7px] h-[7px] rounded-full bg-red-500" />}
                  <div>
                    <p className="font-mono text-[10.5px] tracking-[0.01em] text-red-700">CRITICAL</p>
                    <p className="text-[34px] font-semibold tracking-[-0.04em] leading-none mt-2 text-red-700">{spCritical.length}</p>
                  </div>
                  <p className="font-mono text-[11px] text-ink-3 mt-2">
                    {spCritical.length > 0
                      ? <><b className="text-red-700 font-medium">Stock depleted</b> · needs prep now</>
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
                    <p className="text-[34px] font-semibold tracking-[-0.04em] leading-none mt-2 text-green-700">{spLookingGood.length}</p>
                  </div>
                  <p className="font-mono text-[11px] text-ink-3 mt-2">
                    <b className="text-green-700 font-medium">on par or above</b>{stationsCount > 0 ? ` · across ${stationsCount} station${stationsCount !== 1 ? 's' : ''}` : ''}
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

          {/* Mobile info banner (original) */}
          <div className="md:hidden flex items-center gap-3 flex-wrap">
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 flex items-center gap-2 flex-1 min-w-0">
              <span className="text-amber-600 shrink-0">📊</span>
              <p className="text-sm text-amber-800">
                Suggestions based on <strong>theoretical stock</strong> from sales, wastage &amp; invoices. Resets at each stock count.
              </p>
            </div>
          </div>

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
          <div className="md:hidden flex bg-gray-100 rounded-xl p-1 gap-0.5">
            {(['urgency', 'category', 'station'] as const).map(v => (
              <button key={v} onClick={() => setSmartPrepView(v)}
                className={`flex-1 py-2 text-xs font-semibold rounded-lg transition-colors ${smartPrepView === v ? 'bg-white shadow text-gray-800' : 'text-gray-500'}`}>
                By {v === 'urgency' ? 'Urgency' : v === 'category' ? 'Category' : 'Station'}
              </button>
            ))}
          </div>

          {/* Mobile view toggle */}
          <div className="md:hidden flex bg-gray-100 rounded-xl p-1 gap-0.5">
            {(['urgency', 'category', 'station'] as const).map(v => (
              <button key={v} onClick={() => setSmartPrepView(v)}
                className={`flex-1 py-2 text-xs font-semibold rounded-lg transition-colors ${smartPrepView === v ? 'bg-white shadow text-gray-800' : 'text-gray-500'}`}>
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
                        <span className="w-2 h-2 rounded-full bg-red-500" />
                        <span className="font-mono text-[11.5px] tracking-[0.02em] font-semibold text-red-700">CRITICAL</span>
                        <span className="font-mono text-[11px] text-ink-3 font-normal">· {spCritical.length} item{spCritical.length !== 1 ? 's' : ''}</span>
                      </div>
                      {spCritical.some(i => !i.isOnList) && (
                        <button onClick={() => handleAddAll('911')}
                          className="font-mono text-[10.5px] px-2.5 py-1 rounded-full font-medium border border-red-500 bg-red-500 text-paper hover:bg-red-600 whitespace-nowrap">
                          + Add all
                        </button>
                      )}
                    </div>
                    <p className="font-mono text-[10.5px] text-red-700 px-4 pt-2 pb-1">Stock depleted — make now</p>
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
                        <span className="w-2 h-2 rounded-full bg-green-500" />
                        <span className="font-mono text-[11.5px] tracking-[0.02em] font-semibold text-green-700">LOOKING GOOD</span>
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
                            return (
                              <button key={item.id} onClick={() => setSelected(item)}
                                className="bg-bg border border-line rounded-lg px-3 py-2.5 flex items-center justify-between gap-2.5 hover:border-ink-3 transition-colors text-left">
                                <div className="flex flex-col gap-0.5 min-w-0">
                                  <span className="text-[13px] font-medium text-ink tracking-[-0.01em] truncate">{item.name}</span>
                                  <span className="font-mono text-[10.5px] text-ink-3 whitespace-nowrap">
                                    {item.category} · {item.onHand % 1 === 0 ? item.onHand.toFixed(0) : item.onHand.toFixed(1)} / {item.parLevel % 1 === 0 ? item.parLevel.toFixed(0) : item.parLevel.toFixed(1)} {item.unit}
                                  </span>
                                </div>
                                <span className="font-mono text-[11px] text-green-700 font-medium shrink-0">{label}</span>
                              </button>
                            )
                          })
                        )}
                      </div>
                    ) : (
                      <button onClick={() => setLookingGoodOpen(true)} className="flex-1 font-mono text-[11px] text-ink-3 hover:text-ink py-2.5 text-center transition-colors">
                        {spLookingGood.length > 0 ? `+ ${spLookingGood.length} ITEMS · EXPAND ALL` : 'No items'}
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* ── BY CATEGORY ── */}
              {smartPrepView === 'category' && (
                <div className="space-y-4">
                  {spCategoryGroups.map(([cat, rows]) => (
                    <div key={cat} className="bg-white border border-gray-100 rounded-xl overflow-hidden">
                      <div className="px-5 py-3 bg-gray-50 border-b border-gray-100 flex items-center gap-3">
                        <span className="text-xs font-bold text-gray-700 uppercase tracking-wide">{cat}</span>
                        <span className="text-[10px] bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded-full font-semibold">{rows.length} items</span>
                      </div>
                      {/* Desktop table header */}
                      <div className="hidden md:grid grid-cols-[16px_2fr_1fr_110px_1fr_220px_110px] gap-3 items-center px-5 py-2 bg-gray-50/50 border-b border-gray-100 text-[10px] font-semibold text-gray-400 uppercase tracking-wide">
                        <div /> <div>Item</div> <div>Stock vs Par</div> <div>Theoretical</div> <div>Make</div> <div>Override</div> <div className="text-right">Action</div>
                      </div>
                      {/* Desktop rows */}
                      <div className="hidden md:block">
                        {rows.map(item => <SmartPrepTableRow key={item.id} item={item} />)}
                      </div>
                      {/* Mobile cards */}
                      <div className="md:hidden">
                        {rows.map(item => <SmartPrepCard key={item.id} item={item} />)}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* ── BY STATION ── */}
              {smartPrepView === 'station' && (
                <div className="space-y-4">
                  {(spStationGroups ?? []).map(([station, rows]) => {
                    const emoji = STATION_EMOJI[station] ?? '🍽'
                    const criticalCount = rows.filter(i => i.priority === '911').length
                    const stationBg = station === 'Cold' ? 'bg-blue-50 border-blue-100' : station === 'Hot' ? 'bg-orange-50 border-orange-100' : station === 'Pastry' ? 'bg-amber-50 border-amber-100' : 'bg-gray-50 border-gray-100'
                    const stationText = station === 'Cold' ? 'text-blue-700' : station === 'Hot' ? 'text-orange-700' : station === 'Pastry' ? 'text-amber-700' : 'text-gray-700'
                    return (
                      <div key={station} className="bg-white border border-gray-100 rounded-xl overflow-hidden">
                        <div className={`px-5 py-3 border-b flex items-center gap-3 ${stationBg}`}>
                          <span className={`text-xs font-bold uppercase tracking-wide ${stationText}`}>{emoji} {station} Station</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${stationText} bg-white/60`}>{rows.length} items</span>
                          {criticalCount > 0 && <span className="ml-auto text-[10px] bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full font-semibold">{criticalCount} critical</span>}
                        </div>
                        {/* Desktop table header */}
                        <div className="hidden md:grid grid-cols-[16px_2fr_1fr_110px_1fr_220px_110px] gap-3 items-center px-5 py-2 bg-gray-50/50 border-b border-gray-100 text-[10px] font-semibold text-gray-400 uppercase tracking-wide">
                          <div /> <div>Item</div> <div>Stock vs Par</div> <div>Theoretical</div> <div>Make</div> <div>Override</div> <div className="text-right">Action</div>
                        </div>
                        <div className="hidden md:block">
                          {rows.map(item => <SmartPrepTableRow key={item.id} item={item} />)}
                        </div>
                        <div className="md:hidden">
                          {rows.map(item => <SmartPrepCard key={item.id} item={item} />)}
                        </div>
                      </div>
                    )
                  })}
                  {(!spStationGroups || spStationGroups.length === 0) && (
                    <div className="bg-white border border-gray-100 rounded-xl py-12 text-center">
                      <p className="text-gray-500 text-sm">No stations configured.</p>
                      <p className="text-xs text-gray-400 mt-1">Add stations in{' '}
                        <button onClick={() => setShowSettings(true)} className="text-gold hover:underline">Settings</button>.
                      </p>
                    </div>
                  )}
                </div>
              )}
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
              DONE:        { label: 'Done',        cls: 'bg-green-100 text-green-700' },
              PARTIAL:     { label: 'Partial',     cls: 'bg-amber-100 text-amber-700' },
              IN_PROGRESS: { label: 'In Progress', cls: 'bg-gold/15 text-gold' },
              BLOCKED:     { label: 'Blocked',     cls: 'bg-red-100 text-red-700' },
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
                    { label: 'Done', value: done, cls: 'text-green-700' },
                    { label: 'Partial', value: partial, cls: 'text-amber-700' },
                    { label: 'Completion', value: `${completionRate}%`, cls: completionRate >= 80 ? 'text-green-700' : completionRate >= 50 ? 'text-amber-700' : 'text-red-600' },
                  ].map(c => (
                    <div key={c.label} className="bg-white border border-gray-100 rounded-xl p-3 text-center">
                      <div className="text-xs text-gray-400 mb-1">{c.label}</div>
                      <div className={`text-lg font-bold ${c.cls}`}>{c.value}</div>
                    </div>
                  ))}
                </div>

                {blocked > 0 && (
                  <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-2.5 text-sm text-red-700">
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
    </div>
  )
}
