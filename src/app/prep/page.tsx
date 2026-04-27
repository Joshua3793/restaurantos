'use client'
import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useDrawer } from '@/contexts/DrawerContext'
import dynamic from 'next/dynamic'
import { ChefHat, Plus, RefreshCw, Search, Settings, BookOpen, SlidersHorizontal, WifiOff, RefreshCcw } from 'lucide-react'
import { savePrepCache, loadPrepCache, loadQueue, enqueueMutation, flushQueue } from '@/lib/prep-offline'
import { PrepKpiStrip }    from '@/components/prep/PrepKpiStrip'
import { PrepItemRow }     from '@/components/prep/PrepItemRow'
import type { PrepItemRich, PrepLogData } from '@/components/prep/types'

// Lazy-load conditional components — only mount when user opens them
const PrepDetailPanel  = dynamic(() => import('@/components/prep/PrepDetailPanel').then(m => ({ default: m.PrepDetailPanel })), { ssr: false, loading: () => null })
const PrepItemForm     = dynamic(() => import('@/components/prep/PrepItemForm').then(m => ({ default: m.PrepItemForm })), { ssr: false, loading: () => null })
const PrepSettingsModal = dynamic(() => import('@/components/prep/PrepSettingsModal').then(m => ({ default: m.PrepSettingsModal })), { ssr: false, loading: () => null })

export default function PrepPage() {
  const { setDrawerOpen } = useDrawer()
  const [items,      setItems]      = useState<PrepItemRich[]>([])
  const [loading,    setLoading]    = useState(true)
  const [generating, setGenerating] = useState(false)
  const [selected,   setSelected]   = useState<PrepItemRich | null>(null)
  const [editing,    setEditing]    = useState<PrepItemRich | null>(null)
  const [showAdd,    setShowAdd]    = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [syncing,    setSyncing]    = useState(false)
  const [syncResult, setSyncResult] = useState<{ created: number; updated: number; skipped: number } | null>(null)
  const [isOffline,      setIsOffline]      = useState(false)
  const [offlineSyncing, setOfflineSyncing] = useState(false)
  const [pendingCount,   setPendingCount]   = useState(0)
  const [cacheAge,       setCacheAge]       = useState<number | null>(null)
  const [planSort,   setPlanSort]   = useState<'az' | 'category'>('category')
  const [planView,   setPlanView]   = useState<'all' | 'need-attention' | 'pending'>('all')
  const [showMobileFilters, setShowMobileFilters] = useState(false)

  // Prevent duplicate concurrent status mutations per item
  const pendingItems = useRef<Set<string>>(new Set())
  // Prevent auto-generate from re-firing after the initial attempt
  const hasAttemptedGenerate = useRef(false)

  // Filters
  const [search,         setSearch]         = useState('')
  const [filterPriority, setFilterPriority] = useState('ALL')
  const [filterStatus,   setFilterStatus]   = useState('ALL')
  const [filterCategory, setFilterCategory] = useState('ALL')
  const [activeOnly,     setActiveOnly]     = useState(true)
  const [viewMode,       setViewMode]       = useState<'today' | 'plan'>('today')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      if (!navigator.onLine) throw new Error('offline')
      const res  = await fetch(`/api/prep/items?active=${activeOnly}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const items = Array.isArray(data) ? data : []
      setItems(items)
      savePrepCache(items)
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

  useEffect(() => {
    // Initialise offline state and any pending mutations left from a previous session
    setIsOffline(!navigator.onLine)
    setPendingCount(loadQueue().length)
    load()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  // Manual sync (visible when online with unsent mutations)
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

  // Auto-generate removed — chef now manually plans the prep list from "Plan Prep List" view

  // Auto-refresh every 60 seconds (paused while offline)
  useEffect(() => {
    if (isOffline) return
    const id = setInterval(load, 60_000)
    return () => clearInterval(id)
  }, [load, isOffline])

  const filtered = useMemo(() => items.filter(item => {
    if (search && !item.name.toLowerCase().includes(search.toLowerCase())) return false
    if (filterPriority !== 'ALL' && item.priority !== filterPriority)     return false
    if (filterCategory !== 'ALL' && item.category !== filterCategory)     return false

    if (viewMode === 'plan') {
      if (planView === 'need-attention') {
        return !item.manualPriorityOverride &&
          (item.priority === '911' || item.priority === 'NEEDED_TODAY' || item.priority === 'LOW_STOCK')
      }
      if (planView === 'pending') {
        // Items with no log, or log that is NOT_STARTED or IN_PROGRESS (i.e. not yet finished)
        const s = item.todayLog?.status
        return !s || s === 'NOT_STARTED' || s === 'IN_PROGRESS'
      }
      return true
    }

    // Today: only items the chef has added to today's list
    if (!item.todayLog) return false
    const s = item.todayLog.status
    if (filterStatus !== 'ALL' && s !== filterStatus) return false
    return true
  }), [items, search, filterPriority, filterCategory, filterStatus, viewMode, planView])

  const inProgress  = useMemo(() => items.filter(i => i.todayLog?.status === 'IN_PROGRESS'), [items])
  const todayItems  = useMemo(() => items.filter(i => i.todayLog != null), [items])

  const categories = useMemo(() => [...new Set(items.map(i => i.category))].sort(), [items])

  // For plan mode: sorted flat (A-Z) or grouped by category
  const planSorted = useMemo(() => [...filtered].sort((a, b) => a.name.localeCompare(b.name)), [filtered])

  const planGroups = useMemo(() => {
    if (viewMode !== 'plan' || planSort !== 'category') return null
    const map = new Map<string, typeof filtered>()
    for (const cat of [...new Set(planSorted.map(i => i.category))].sort()) map.set(cat, [])
    for (const item of planSorted) map.get(item.category)!.push(item)
    return Array.from(map.entries()).filter(([, rows]) => rows.length > 0)
  }, [filtered, planSorted, viewMode, planSort])

  // Keep detail panel in sync with live data — avoids stale snapshot after auto-refresh
  const selectedLive = useMemo(
    () => selected ? (items.find(i => i.id === selected.id) ?? selected) : null,
    [selected, items],
  )

  const handleRefresh = async () => {
    setGenerating(true)
    try {
      await load()
    } catch (e) {
      console.error('Failed to refresh prep data', e)
      setActionError('Refresh failed — check your connection and try again.')
    } finally {
      setGenerating(false)
    }
  }

  const handleSync = async () => {
    setSyncing(true)
    setSyncResult(null)
    try {
      const res  = await fetch('/api/prep/sync-from-recipes', { method: 'POST' })
      const data = await res.json()
      setSyncResult(data)
      if (data.created > 0) await load()
    } catch (e) {
      console.error('Sync failed', e)
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

    // Optimistic: update status + clear manual priority when marking done/partial
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

    // Queue for later sync when offline
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
        // Swap temp id with real one
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
      // No reload needed — state already reflects the change
    } catch (e) {
      console.error('Failed to update prep status', e)
      setActionError('Status update failed — try again.')
      load() // revert on error
    } finally {
      pendingItems.current.delete(itemId)
    }
  }

  async function handlePriorityChange(itemId: string, priority: string) {
    // Optimistic: update override + effective priority immediately
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
      // Only reload when going to Auto — server needs to recalculate effective priority
      if (!priority) load()
    } catch (e) {
      console.error('Failed to update priority', e)
      setActionError('Priority update failed — try again.')
      load() // revert on error
    }
  }

  async function handleDelete(itemId: string) {
    try {
      await fetch(`/api/prep/items/${itemId}`, { method: 'DELETE' })
      if (selected?.id === itemId) setSelected(null)  // close stale detail panel
      load()
    } catch (e) {
      console.error('Failed to delete prep item', e)
      setActionError('Delete failed — try again.')
    }
  }

  // Schedule toggle: logId=null → add to today; logId=string → remove from today
  async function handleScheduleToggle(itemId: string, logId: string | null) {
    // Optimistic: flip todayLog immediately so UI responds without waiting for the server
    const now = new Date().toISOString()
    setItems(prev => prev.map(item => {
      if (item.id !== itemId) return item
      if (logId) {
        return { ...item, todayLog: null }
      }
      return {
        ...item,
        todayLog: {
          id: `_opt_${itemId}`,
          prepItemId: itemId,
          logDate: now.split('T')[0],
          status: 'NOT_STARTED',
          requiredQty: null,
          actualPrepQty: null,
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
      if (logId) {
        enqueueMutation({ type: 'schedule_remove', itemId, logId })
      } else {
        enqueueMutation({ type: 'schedule_add', itemId })
      }
      setPendingCount(n => n + 1)
      return
    }

    try {
      if (logId) {
        // _opt_ prefix means the log was never persisted — nothing to delete on the server
        if (!logId.startsWith('_opt_')) {
          const res = await fetch(`/api/prep/logs/${logId}`, { method: 'DELETE' })
          if (!res.ok) throw new Error(`Delete failed: ${res.status}`)
        }
      } else {
        const log = await fetch('/api/prep/logs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prepItemId: itemId }),
        }).then(r => r.json())

        if (log.id) {
          // Check if the user already unmarked while the POST was in flight
          let userAlreadyUnmarked = false
          setItems(prev => prev.map(item => {
            if (item.id !== itemId) return item
            if (!item.todayLog) {
              // User unmarked — don't restore todayLog, but we need to clean up the DB record
              userAlreadyUnmarked = true
              return item
            }
            return { ...item, todayLog: { ...item.todayLog, id: log.id } }
          }))
          // If user toggled off while POST was in flight, delete the record we just created
          if (userAlreadyUnmarked) {
            fetch(`/api/prep/logs/${log.id}`, { method: 'DELETE' }).catch(() => {})
          }
        }
      }
    } catch (e) {
      console.error('Failed to toggle schedule', e)
      setActionError('Could not update today\'s list — try again.')
      load() // revert on error
    }
  }

  const selCls = 'border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500'

  const activeFilterCount = [filterPriority !== 'ALL', filterStatus !== 'ALL', filterCategory !== 'ALL'].filter(Boolean).length

  return (
    <div className="space-y-3 md:space-y-5">

      {/* ── Mobile Header ── */}
      <div className="md:hidden">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h1 className="text-xl font-bold text-gray-900 flex items-center gap-1.5">
              <ChefHat size={20} className="text-blue-600" /> Prep
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
              className="p-2 rounded-lg border border-blue-200 text-blue-600 bg-blue-50 hover:bg-blue-100 disabled:opacity-50"
              title="Sync from Recipes">
              <BookOpen size={16} className={syncing ? 'animate-pulse' : ''} />
            </button>
            <button onClick={() => setShowAdd(true)}
              className="p-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700">
              <Plus size={16} />
            </button>
          </div>
        </div>

        {/* View tabs */}
        <div className="flex bg-gray-100 rounded-xl p-1 mt-3">
          {(['today', 'plan'] as const).map(m => (
            <button key={m} onClick={() => setViewMode(m)}
              className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors ${viewMode === m ? 'bg-white shadow text-gray-900' : 'text-gray-500'}`}>
              {m === 'today' ? 'Today' : 'Plan Prep List'}
            </button>
          ))}
        </div>

        {/* KPI strip */}
        {viewMode !== 'plan' && (
          <div className="mt-2">
            <PrepKpiStrip items={todayItems} onFilterPriority={p => setFilterPriority(prev => prev === p ? 'ALL' : p)} />
          </div>
        )}

        {/* Search + filter toggle */}
        <div className="flex gap-2 mt-3">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Search prep items…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <button
            onClick={() => setShowMobileFilters(v => !v)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border text-sm font-medium transition-colors ${
              showMobileFilters || activeFilterCount > 0
                ? 'border-blue-300 bg-blue-50 text-blue-700'
                : 'border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}>
            <SlidersHorizontal size={15} />
            {activeFilterCount > 0 ? <span className="bg-blue-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">{activeFilterCount}</span> : 'Filter'}
          </button>
        </div>

        {/* Collapsible filters */}
        {showMobileFilters && (
          <div className="mt-2 bg-white border border-gray-100 rounded-xl p-3 space-y-2">
            <select className={selCls + ' w-full'} value={filterPriority} onChange={e => setFilterPriority(e.target.value)}>
              <option value="ALL">All Priorities</option>
              <option value="911">911</option>
              <option value="NEEDED_TODAY">Needed Today</option>
              <option value="LOW_STOCK">Low Stock</option>
              <option value="LATER">Later</option>
            </select>
            {viewMode === 'today' && (
              <select className={selCls + ' w-full'} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
                <option value="ALL">All Statuses</option>
                {['NOT_STARTED','IN_PROGRESS','DONE','PARTIAL','BLOCKED','SKIPPED'].map(s => (
                  <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
                ))}
              </select>
            )}
            <select className={selCls + ' w-full'} value={filterCategory} onChange={e => setFilterCategory(e.target.value)}>
              <option value="ALL">All Categories</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        )}
      </div>

      {/* ── Desktop Header ── */}
      <div className="hidden md:block space-y-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
              <ChefHat size={24} className="text-blue-600" /> Prep
            </h1>
            <p className="text-sm text-gray-500 mt-0.5">
              {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={() => setShowSettings(true)}
              className="flex items-center gap-2 px-4 py-2 text-sm border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50">
              <Settings size={14} /> Settings
            </button>
            <button onClick={handleRefresh} disabled={generating}
              className="flex items-center gap-2 px-4 py-2 text-sm border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50 disabled:opacity-50">
              <RefreshCw size={14} className={generating ? 'animate-spin' : ''} />
              {generating ? 'Refreshing…' : 'Refresh'}
            </button>
            <button onClick={handleSync} disabled={syncing}
              className="flex items-center gap-2 px-4 py-2 text-sm border border-blue-200 text-blue-700 bg-blue-50 rounded-lg hover:bg-blue-100 disabled:opacity-50">
              <BookOpen size={14} className={syncing ? 'animate-pulse' : ''} />
              {syncing ? 'Syncing…' : 'Sync from Recipes'}
            </button>
            <button onClick={() => setShowAdd(true)}
              className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
              <Plus size={14} /> Add Item
            </button>
          </div>
        </div>
      </div>

      {/* Action error banner */}
      {actionError && (
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          <span>{actionError}</span>
          <button onClick={() => setActionError(null)} className="shrink-0 text-red-400 hover:text-red-600">✕</button>
        </div>
      )}

      {/* Offline / pending-sync banner */}
      {(isOffline || pendingCount > 0) && (
        <div className={`flex items-center justify-between gap-3 px-4 py-2.5 rounded-xl text-sm border ${
          isOffline
            ? 'bg-amber-50 border-amber-200 text-amber-800'
            : 'bg-blue-50 border-blue-200 text-blue-800'
        }`}>
          <div className="flex items-center gap-2 min-w-0">
            <WifiOff size={14} className="shrink-0" />
            <span className="truncate">
              {offlineSyncing
                ? 'Syncing changes…'
                : isOffline
                  ? `Offline${cacheAge !== null ? ` — data from ${cacheAge < 1 ? 'just now' : `${cacheAge}m ago`}` : ''}`
                  : 'Back online'}
            </span>
            {pendingCount > 0 && !offlineSyncing && (
              <span className="font-semibold shrink-0">
                · {pendingCount} change{pendingCount !== 1 ? 's' : ''} pending
              </span>
            )}
          </div>
          {pendingCount > 0 && !isOffline && !offlineSyncing && (
            <button
              onClick={handleOfflineSync}
              className="shrink-0 flex items-center gap-1 text-xs font-medium text-blue-700 hover:text-blue-900"
            >
              <RefreshCcw size={12} /> Sync now
            </button>
          )}
        </div>
      )}

      {/* Sync result banner */}
      {syncResult && (
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 bg-green-50 border border-green-200 rounded-xl text-sm text-green-800">
          <span>
            {(syncResult.created > 0 || syncResult.updated > 0)
              ? <>
                  ✓{syncResult.created > 0 && <> Created <strong>{syncResult.created}</strong> new prep item{syncResult.created !== 1 ? 's' : ''}.</>}
                  {syncResult.updated > 0 && <> Updated categor{syncResult.updated !== 1 ? 'ies' : 'y'} on <strong>{syncResult.updated}</strong> existing item{syncResult.updated !== 1 ? 's' : ''}.</>}
                  {syncResult.created > 0 && <> Set par levels on new items to start tracking them.</>}
                </>
              : <>Everything is already in sync — {syncResult.skipped} prep item{syncResult.skipped !== 1 ? 's' : ''} matched.</>
            }
          </span>
          <button onClick={() => setSyncResult(null)} className="shrink-0 text-green-500 hover:text-green-700">✕</button>
        </div>
      )}

      {/* ── Desktop KPI strip + filters ── */}
      <div className="hidden md:block space-y-5">
        {viewMode !== 'plan' && (
          <PrepKpiStrip items={todayItems} onFilterPriority={p => setFilterPriority(prev => prev === p ? 'ALL' : p)} />
        )}
        <div className="bg-white border border-gray-100 rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-48">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                className="w-full pl-9 pr-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Search prep items…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <select className={selCls} value={filterPriority} onChange={e => setFilterPriority(e.target.value)}>
              <option value="ALL">All Priorities</option>
              <option value="911">911</option>
              <option value="NEEDED_TODAY">Needed Today</option>
              <option value="LOW_STOCK">Low Stock</option>
              <option value="LATER">Later</option>
            </select>
            <select className={selCls} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
              <option value="ALL">All Statuses</option>
              {['NOT_STARTED','IN_PROGRESS','DONE','PARTIAL','BLOCKED','SKIPPED'].map(s => (
                <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
              ))}
            </select>
            <select className={selCls} value={filterCategory} onChange={e => setFilterCategory(e.target.value)}>
              <option value="ALL">All Categories</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-4 text-sm flex-wrap">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={activeOnly}
                onChange={e => setActiveOnly(e.target.checked)}
                className="rounded text-blue-600" />
              <span className="text-gray-600">Active only</span>
            </label>
            <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-0.5">
              {(['today', 'plan'] as const).map(m => (
                <button key={m} onClick={() => setViewMode(m)}
                  className={`px-3 py-1 text-xs rounded-md transition-colors ${viewMode === m ? 'bg-white shadow text-gray-800' : 'text-gray-500 hover:text-gray-700'}`}>
                  {m === 'today' ? 'Today' : 'Plan Prep List'}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Currently Making — only in Today view */}
      {inProgress.length > 0 && viewMode === 'today' && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl overflow-hidden">
          <div className="px-4 py-2 flex items-center gap-2 border-b border-blue-100">
            <span className="text-xs font-semibold text-blue-700 uppercase tracking-wide">Currently Making</span>
            <span className="text-xs text-blue-500">{inProgress.length} in progress</span>
          </div>
          <div className="divide-y divide-blue-50">
            {inProgress.map(item => (
              <PrepItemRow key={item.id} item={item}
                onClick={() => setSelected(item)}
                onStatusChange={handleStatusChange}
                onPriorityChange={handlePriorityChange}
                onDelete={handleDelete}
                planMode={false} />
            ))}
          </div>
        </div>
      )}

      {/* Plan Prep List controls */}
      {viewMode === 'plan' && (
        <div className="bg-indigo-50 border border-indigo-200 rounded-xl px-4 py-3 space-y-2.5">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            {/* Sub-view toggle: All / Pending / Need Attention */}
            <div className="flex items-center gap-1 bg-indigo-100 rounded-lg p-0.5">
              <button
                onClick={() => setPlanView('all')}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${planView === 'all' ? 'bg-white text-indigo-800 shadow-sm' : 'text-indigo-500 hover:text-indigo-700'}`}
              >
                All Items
              </button>
              <button
                onClick={() => setPlanView('pending')}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 ${planView === 'pending' ? 'bg-white text-blue-700 shadow-sm' : 'text-indigo-500 hover:text-indigo-700'}`}
              >
                Pending
                {(() => {
                  const n = items.filter(i => { const s = i.todayLog?.status; return !s || s === 'NOT_STARTED' || s === 'IN_PROGRESS' }).length
                  return n > 0 ? (
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${planView === 'pending' ? 'bg-blue-100 text-blue-700' : 'bg-indigo-200 text-indigo-600'}`}>{n}</span>
                  ) : null
                })()}
              </button>
              <button
                onClick={() => setPlanView('need-attention')}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 ${planView === 'need-attention' ? 'bg-white text-orange-700 shadow-sm' : 'text-indigo-500 hover:text-indigo-700'}`}
              >
                Low Stock
                {items.filter(i => !i.manualPriorityOverride && (i.priority === '911' || i.priority === 'NEEDED_TODAY' || i.priority === 'LOW_STOCK')).length > 0 && (
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${planView === 'need-attention' ? 'bg-orange-100 text-orange-700' : 'bg-indigo-200 text-indigo-600'}`}>
                    {items.filter(i => !i.manualPriorityOverride && (i.priority === '911' || i.priority === 'NEEDED_TODAY' || i.priority === 'LOW_STOCK')).length}
                  </span>
                )}
              </button>
            </div>

            {/* Sort toggle: A–Z / By Category — only in All Items view */}
            {planView === 'all' && (
              <div className="flex items-center gap-1 bg-indigo-100 rounded-lg p-0.5">
                {([['az', 'A – Z'], ['category', 'By Category']] as const).map(([mode, label]) => (
                  <button
                    key={mode}
                    onClick={() => setPlanSort(mode)}
                    className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                      planSort === mode ? 'bg-white text-indigo-800 shadow-sm' : 'text-indigo-500 hover:text-indigo-700'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <p className="text-xs text-indigo-600">
            {planView === 'need-attention'
              ? 'Items the system flagged based on stock levels. Tap ○ to add to today\'s list.'
              : planView === 'pending'
              ? 'Items not yet done today — unscheduled or in progress. Add what\'s still needed.'
              : 'Tap ○ to add items to today\'s list. Use priority chips to flag urgency.'}
          </p>
        </div>
      )}

      {/* Main list */}
      {loading ? (
        <div className="flex justify-center py-16">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white border border-gray-100 rounded-xl py-16 text-center">
          <ChefHat size={32} className="mx-auto text-gray-300 mb-3" />
          <p className="text-gray-500 text-sm">
            {items.length === 0
              ? 'No prep items yet.'
              : viewMode === 'plan' && planView === 'need-attention'
              ? 'No items flagged by the system — stock levels look good.'
              : viewMode === 'plan' && planView === 'pending'
              ? 'All items are done or skipped for today. Great work!'
              : viewMode === 'plan'
              ? 'No items match your filters.'
              : 'Nothing on today\'s list yet.'}
          </p>
          {viewMode === 'today' && items.length > 0 && !items.some(i => i.todayLog) && (
            <p className="text-xs text-gray-400 mt-2">
              Go to <button onClick={() => setViewMode('plan')} className="text-blue-500 hover:underline">Plan Prep List</button> and tap ○ next to each item you want to prep today.
            </p>
          )}
          {items.length === 0 && (
            <button onClick={() => setShowAdd(true)} className="mt-3 text-sm text-blue-600 hover:text-blue-700">
              Add your first prep item →
            </button>
          )}
        </div>
      ) : viewMode === 'plan' && planGroups ? (
        /* ── Plan mode — By Category ── */
        <div className="space-y-4">
          {planGroups.map(([cat, rows]) => (
            <div key={cat} className="bg-white border border-gray-100 rounded-xl overflow-hidden">
              <div className="px-4 py-2 bg-gray-50 border-b border-gray-100 flex items-center gap-2">
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{cat}</span>
                <span className="text-xs text-gray-400">{rows.length}</span>
              </div>
              <div className="divide-y divide-gray-50">
                {rows.map(item => (
                  <PrepItemRow
                    key={item.id}
                    item={item}
                    onClick={() => setSelected(item)}
                    onStatusChange={handleStatusChange}
                    onPriorityChange={handlePriorityChange}
                    onDelete={handleDelete}
                    onScheduleToggle={handleScheduleToggle}
                    planMode
                    showReason={planView === 'need-attention'}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : viewMode === 'plan' ? (
        /* ── Plan mode — A-Z ── */
        <div className="bg-white border border-gray-100 rounded-xl overflow-hidden divide-y divide-gray-50">
          {planSorted.map(item => (
            <PrepItemRow
              key={item.id}
              item={item}
              onClick={() => setSelected(item)}
              onStatusChange={handleStatusChange}
              onPriorityChange={handlePriorityChange}
              onDelete={handleDelete}
              onScheduleToggle={handleScheduleToggle}
              planMode
              showReason={planView === 'need-attention'}
            />
          ))}
        </div>
      ) : (
        /* ── Today / Needs Action mode ── */
        <div className="bg-white border border-gray-100 rounded-xl overflow-hidden divide-y divide-gray-50">
          {filtered.map(item => (
            <PrepItemRow
              key={item.id}
              item={item}
              onClick={() => setSelected(item)}
              onStatusChange={handleStatusChange}
              onPriorityChange={handlePriorityChange}
              onDelete={handleDelete}
              planMode={false}
            />
          ))}
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

      {/* Add form */}
      {showAdd && (
        <PrepItemForm
          onClose={() => setShowAdd(false)}
          onSaved={load}
        />
      )}

      {/* Edit form */}
      {editing && (
        <PrepItemForm
          item={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { load(); setEditing(null) }}
        />
      )}

      {/* Settings modal */}
      {showSettings && (
        <PrepSettingsModal
          onClose={() => setShowSettings(false)}
          onSaved={() => setShowSettings(false)}
        />
      )}
    </div>
  )
}
