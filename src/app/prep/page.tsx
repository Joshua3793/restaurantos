'use client'
import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useDrawer } from '@/contexts/DrawerContext'
import dynamic from 'next/dynamic'
import {
  ChefHat, Plus, RefreshCw, Search, Settings,
  SlidersHorizontal, WifiOff, RefreshCcw, History, AlertTriangle, Check, Clock, MoreHorizontal,
} from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { setScopeParams } from '@/lib/scope-params'
import { prepDeadline, fmtDuration } from '@/lib/service-hours'
import { savePrepCache, loadPrepCache, loadQueue, enqueueMutation, flushQueue } from '@/lib/prep-offline'
import type { PrepItemRich, PrepLogData } from '@/components/prep/types'
import PrepShiftBand from '@/components/prep/PrepShiftBand'
import PrepAlertBanner from '@/components/prep/PrepAlertBanner'
import './prep-board.css'
import { PrepBoard } from '@/components/prep/board/PrepBoard'
import { PrepSummaryLine } from '@/components/prep/board/PrepSummaryLine'
import { PrepBoardDrawer } from '@/components/prep/board/PrepBoardDrawer'
import PrepTaskRowCompact from '@/components/prep/PrepTaskRowCompact'
import PrepDoneSheet from '@/components/prep/PrepDoneSheet'
import PrepTaskLibrary from '@/components/prep/PrepTaskLibrary'
import PrepTaskList from '@/components/prep/PrepTaskList'
import type { PrepTask, PrepTaskTodayLog, PrepTaskRow, LinkedItemSummary } from '@/components/prep/types'
import PrepGetAhead from '@/components/prep/PrepGetAhead'
import PrepRestState from '@/components/prep/PrepRestState'
import PrepDrawer from '@/components/prep/PrepDrawer'
import RecipeCookAlongModal from '@/components/prep/RecipeCookAlongModal'
import { RecipeViewModal } from '@/components/prep/RecipeViewModal'
import { usePrepToast } from '@/components/prep/PrepToast'
import { computeShiftSummary, groupPrepItems, computeWorkloadMinutes, formatMinutes, buildPrepCountdown } from '@/lib/prep-utils'
import type { PrepItemDetail, IngredientAvailability, RecipeStepsData } from '@/components/prep/types'

// Lazy-load conditional components — only mount when user opens them
const PrepDetailPanel   = dynamic(() => import('@/components/prep/PrepDetailPanel').then(m => ({ default: m.PrepDetailPanel })), { ssr: false, loading: () => null })
const PrepItemForm      = dynamic(() => import('@/components/prep/PrepItemForm').then(m => ({ default: m.PrepItemForm })), { ssr: false, loading: () => null })
const PrepSettingsModal = dynamic(() => import('@/components/prep/PrepSettingsModal').then(m => ({ default: m.PrepSettingsModal })), { ssr: false, loading: () => null })

export default function PrepPage() {
  const { setDrawerOpen } = useDrawer()
  const { activeRc, activeRcId, activeKind, activeLocationId, isReadOnly } = useRc()
  const [items,        setItems]        = useState<PrepItemRich[]>([])
  const [loading,      setLoading]      = useState(true)
  const [generating,   setGenerating]   = useState(false)
  const [selected,     setSelected]     = useState<PrepItemRich | null>(null)
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set())
  const markSaving = (id: string, on: boolean) =>
    setSavingIds(prev => {
      const next = new Set(prev)
      if (on) next.add(id); else next.delete(id)
      return next
    })
  const [editing,      setEditing]      = useState<PrepItemRich | null>(null)
  const [showAdd,      setShowAdd]      = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showHeaderMenu, setShowHeaderMenu] = useState(false)
  const [actionError,  setActionError]  = useState<string | null>(null)
  const [isOffline,      setIsOffline]      = useState(false)
  const [offlineSyncing, setOfflineSyncing] = useState(false)
  const [pendingCount,   setPendingCount]   = useState(0)
  const [cacheAge,       setCacheAge]       = useState<number | null>(null)

  // Redesigned To-do tab — drawer, cook-along modal, toast, alert dismissal
  const { toast, toastNode } = usePrepToast()
  const [drawerItem, setDrawerItem] = useState<PrepItemRich | null>(null)
  // Quick yield prompt from the compact row's "Mark done" (no full drawer).
  const [doneSheetItem, setDoneSheetItem] = useState<PrepItemRich | null>(null)
  const [drawerDetail, setDrawerDetail] = useState<PrepItemDetail | null>(null)
  const [recipeModal, setRecipeModal] = useState<{ sourceItemId: string; recipe: RecipeStepsData; ings: IngredientAvailability[]; makeQty: number; unit: string; loading: boolean } | null>(null)
  // Cache fetched cook-along data per prep item so reopening a recipe is instant.
  const recipeCache = useRef<Map<string, { recipe: RecipeStepsData; ings: IngredientAvailability[] }>>(new Map())
  // Sub-recipe peek (e.g. opening "Custard" linked inside French Toast)
  const [subRecipeView, setSubRecipeView] = useState<{ recipeId: string; name: string } | null>(null)
  const [subRecipeChecked, setSubRecipeChecked] = useState<Set<string>>(new Set())
  const [alertDismissed, setAlertDismissed] = useState(false)

  // View state
  const [viewMode,          setViewMode]          = useState<'today' | 'smartprep' | 'history'>('today')
  const [smartPrepView,     setSmartPrepView]     = useState<'urgency' | 'category' | 'station'>('urgency')
  const [showMobileFilters, setShowMobileFilters] = useState(false)
  const [showMobileSearch, setShowMobileSearch] = useState(false)
  const [priorityMenuFor, setPriorityMenuFor] = useState<string | null>(null)
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

  // ── Prep tasks (checklist) ─────────────────────────────────────────────────
  const [taskLibrary, setTaskLibrary] = useState<PrepTask[]>([])
  const [taskTodayIds, setTaskTodayIds] = useState<Set<string>>(new Set())
  const [inventoryForTasks, setInventoryForTasks] = useState<LinkedItemSummary[]>([])

  const todayDateStr = useMemo(() => {
    const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString()
  }, [])

  const loadTasks = useCallback(async () => {
    if (!activeRcId && !activeLocationId) { setTaskLibrary([]); setTaskTodayIds(new Set()); return }
    const params = new URLSearchParams({ date: todayDateStr })
    setScopeParams(params, { activeKind, activeRcId, activeRc, activeLocationId })
    const res = await fetch(`/api/prep/tasks?${params}`)
    if (!res.ok) return
    const data: { library: PrepTask[]; today: PrepTaskTodayLog[] } = await res.json()
    setTaskLibrary(data.library)
    setTaskTodayIds(new Set(data.today.map(t => t.prepTaskId)))
  }, [activeRcId, activeLocationId, activeKind, activeRc, todayDateStr])

  useEffect(() => { loadTasks() }, [loadTasks])

  useEffect(() => {
    fetch('/api/inventory')
      .then(r => r.ok ? r.json() : [])
      .then((items: { id: string; itemName: string }[]) =>
        setInventoryForTasks(items.map(i => ({ id: i.id, itemName: i.itemName }))))
      .catch(() => {})
  }, [])

  const taskRows: PrepTaskRow[] = useMemo(
    () => taskLibrary.map(t => ({ ...t, activeToday: taskTodayIds.has(t.id) })),
    [taskLibrary, taskTodayIds],
  )
  const activeTaskRows = useMemo(() => taskRows.filter(r => r.activeToday), [taskRows])
  const tasksDisabled = !activeRcId

  const createTask = useCallback(async (name: string, linkedInventoryItemId: string | null) => {
    if (!activeRcId) return
    const res = await fetch('/api/prep/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, revenueCenterId: activeRcId, linkedInventoryItemId }),
    })
    if (res.ok) { const t: PrepTask = await res.json(); setTaskLibrary(prev => [...prev, t]) }
  }, [activeRcId])

  const editTask = useCallback(async (taskId: string, name: string, linkedInventoryItemId: string | null) => {
    const res = await fetch(`/api/prep/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, linkedInventoryItemId }),
    })
    if (res.ok) { const t: PrepTask = await res.json(); setTaskLibrary(prev => prev.map(x => x.id === taskId ? t : x)) }
  }, [])

  const deleteTask = useCallback(async (taskId: string) => {
    setTaskLibrary(prev => prev.filter(t => t.id !== taskId))
    await fetch(`/api/prep/tasks/${taskId}`, { method: 'DELETE' })
  }, [])

  const reorderTasks = useCallback(async (ids: string[]) => {
    setTaskLibrary(prev => [...prev].sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
      .map((t, i) => ({ ...t, sortOrder: i })))
    await fetch('/api/prep/tasks/reorder', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
    })
  }, [])

  const setTaskActive = useCallback(async (taskId: string, next: boolean) => {
    setTaskTodayIds(prev => { const s = new Set(prev); if (next) s.add(taskId); else s.delete(taskId); return s })
    await fetch(`/api/prep/tasks/${taskId}/today${next ? '' : `?date=${encodeURIComponent(todayDateStr)}`}`, {
      method: next ? 'POST' : 'DELETE',
      headers: next ? { 'Content-Type': 'application/json' } : undefined,
      body: next ? JSON.stringify({ date: todayDateStr }) : undefined,
    })
  }, [todayDateStr])

  const clearTaskToday = useCallback((taskId: string) => setTaskActive(taskId, false), [setTaskActive])

  // `silent` = background refresh (auto-poll): update data in place without the
  // full-screen loading state or wiping the list on a transient failure.
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      if (!navigator.onLine) throw new Error('offline')
      const res  = await fetch(`/api/prep/items?active=${activeOnly}`, { cache: 'no-store' })
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
      if (!silent) setItems([])
    } finally {
      if (!silent) setLoading(false)
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
    const id = setInterval(() => load(true), 60_000)
    return () => clearInterval(id)
  }, [load, isOffline])

  // ── Derived data ──────────────────────────────────────────────────────────

  const categories = useMemo(() => [...new Set(items.map(i => i.category))].sort(), [items])

  // Today tab: on-list items (still to do) PLUS anything completed today. Completing
  // an item clears `isOnList` (so Smart Prep frees up + it's re-addable next session),
  // but it stays visible in the "Done today" section for the rest of the shift.
  const todayItems = useMemo(() =>
    items.filter(i =>
      i.isOnList || i.todayLog?.status === 'DONE' || i.todayLog?.status === 'PARTIAL'
    ),
  [items])

  // Priority-change alerts: on-list items that have escalated to Critical but not started
  const priorityAlerts = useMemo(() =>
    items.filter(i =>
      i.isOnList &&
      i.priority === '911' &&
      (!i.todayLog || i.todayLog.status === 'NOT_STARTED')
    ),
  [items])

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

  // Smart-prep filter (all active items respecting search + category/station).
  // Defined here (above the buckets/groups below) because every Smart Prep derivation
  // feeds off it — that's how the mobile search bar actually filters the list.
  const filteredSmart = useMemo(() => {
    return items.filter(item => {
      if (search && !item.name.toLowerCase().includes(search.toLowerCase())) return false
      if (filterCategory !== 'ALL' && item.category !== filterCategory) return false
      if (filterStation === 'UNASSIGNED') {
        if (item.station && item.station.trim() !== '') return false
      } else if (filterStation !== 'ALL') {
        if (item.station !== filterStation) return false
      }
      return true
    })
  }, [items, search, filterCategory, filterStation])

  // Smart Prep urgency buckets — driven by filteredSmart so search/category/station apply
  const spCritical    = useMemo(() => filteredSmart.filter(i => i.priority === '911'),          [filteredSmart])
  const spNeeded      = useMemo(() => filteredSmart.filter(i => i.priority === 'NEEDED_TODAY'), [filteredSmart])
  const spLookingGood = useMemo(() => filteredSmart.filter(i => i.priority === 'LATER'),        [filteredSmart])

  // Smart Prep — by-category groups (sorted by urgency within each group)
  const PRIORITY_RANK: Record<string, number> = { '911': 0, 'NEEDED_TODAY': 1, 'LATER': 2 }
  const spCategoryGroups = useMemo(() => {
    const sorted = [...filteredSmart].sort((a, b) => {
      const pd = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
      return pd !== 0 ? pd : a.name.localeCompare(b.name)
    })
    const map = new Map<string, PrepItemRich[]>()
    for (const cat of [...new Set(sorted.map(i => i.category))].sort()) map.set(cat, [])
    for (const item of sorted) map.get(item.category)!.push(item)
    return Array.from(map.entries()).filter(([, rows]) => rows.length > 0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredSmart])

  // Smart Prep — by-station groups
  const spStationGroups = useMemo(() => {
    const sorted = [...filteredSmart].sort((a, b) => {
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
  }, [filteredSmart, stations])

  // Redesigned To-do tab — derived
  const shiftSummary = useMemo(() => computeShiftSummary(todayItems), [todayItems])
  const todayGroups = useMemo(() => groupPrepItems(filteredToday), [filteredToday])
  const countdown = useMemo(() => buildPrepCountdown(activeRc, new Date()), [activeRc])
  // Compact prep-deadline label for the mobile header subtitle (replaces the old full-width banner).
  const prepBy = useMemo(() => {
    if (!activeRc) return null
    const now = new Date()
    if (activeRc.schedulingMode === 'ON_DEMAND') {
      const lead = activeRc.prepLeadMinutes != null ? fmtDuration(activeRc.prepLeadMinutes * 60_000) : null
      return { onDemand: true as const, time: null, left: null, lead }
    }
    const dl = prepDeadline(activeRc, now)
    if (!dl) return null
    return {
      onDemand: false as const,
      time: dl.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
      left: fmtDuration(dl.getTime() - now.getTime()),
      lead: null,
    }
  }, [activeRc])
  const workloadLabel = useMemo(() => '~' + formatMinutes(computeWorkloadMinutes(todayItems)), [todayItems])

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


  async function handleStatusChange(itemId: string, newStatus: string, actualQty?: number) {
    if (pendingItems.current.has(itemId)) return
    const item = items.find(i => i.id === itemId)
    if (!item) return
    // Recording a prep log is a stock movement — it needs a concrete revenue center.
    // The API resolves prepItem.revenueCenterId ?? body.revenueCenterId, so only block
    // when the item carries no RC of its own AND no concrete RC is active ("All" view).
    if (!item.revenueCenterId && !activeRcId) {
      setActionError('Select a revenue center (not "All") to record prep.')
      return
    }
    pendingItems.current.add(itemId)

    const now = new Date().toISOString()
    const completingNow = newStatus === 'DONE' || newStatus === 'PARTIAL'
    // Mirror the server's status→isOnList rule optimistically: completing/removing
    // clears the item from the list, starting/resetting re-arms it.
    const nextOnList = newStatus === 'NOT_STARTED' || newStatus === 'IN_PROGRESS'
    setItems(prev => prev.map(i => {
      if (i.id !== itemId) return i
      const existingLog = i.todayLog
      return {
        ...i,
        isOnList: nextOnList,
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
    markSaving(itemId, true)

    if (!navigator.onLine) {
      enqueueMutation({ type: 'status', itemId, logId: item.todayLog?.id ?? null, status: newStatus, actualQty, revenueCenterId: item.revenueCenterId ?? activeRcId })
      setPendingCount(n => n + 1)
      pendingItems.current.delete(itemId)
      markSaving(itemId, false)
      return
    }

    try {
      let logId = item.todayLog?.id
      if (!logId || logId.startsWith('_opt_')) {
        const log = await fetch('/api/prep/logs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prepItemId: itemId, revenueCenterId: activeRcId }),
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
      markSaving(itemId, false)
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
    markSaving(itemId, true)

    if (!navigator.onLine) {
      enqueueMutation({ type: 'priority', itemId, priority })
      setPendingCount(n => n + 1)
      markSaving(itemId, false)
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
    } finally {
      markSaving(itemId, false)
    }
  }

  async function handleDelete(itemId: string) {
    try {
      setItems(prev => prev.filter(i => i.id !== itemId))
      await fetch(`/api/prep/items/${itemId}`, { method: 'DELETE' })
      if (selected?.id === itemId) setSelected(null)
      load()
    } catch {
      setActionError('Delete failed — try again.')
      load()
    }
  }

  // Toggle isOnList: add to list (true) or remove from list (false)
  async function handleToggleOnList(itemId: string, newValue: boolean) {
    // Optimistic update
    setItems(prev => prev.map(i =>
      i.id === itemId ? { ...i, isOnList: newValue } : i
    ))
    markSaving(itemId, true)

    if (!navigator.onLine) {
      enqueueMutation({ type: 'isOnList_toggle', itemId, isOnList: newValue })
      setPendingCount(n => n + 1)
      markSaving(itemId, false)
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
            body: JSON.stringify({ prepItemId: itemId, status: 'SKIPPED', revenueCenterId: activeRcId }),
          }).catch(() => {}) // non-critical — don't fail the whole operation
        }
      }
    } catch {
      setActionError('Could not update list — try again.')
      load()
    } finally {
      markSaving(itemId, false)
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

  // Add an explicit set of items to today's list (used by the board's per-block
  // "Add all" — adds every not-on-list row in the block regardless of priority,
  // and only what's actually visible after filters).
  async function handleAddIds(ids: string[]) {
    const targets = items.filter(i => ids.includes(i.id) && !i.isOnList)
    if (targets.length === 0) return
    setItems(prev => prev.map(i => targets.some(t => t.id === i.id) ? { ...i, isOnList: true } : i))
    await Promise.all(targets.map(i =>
      fetch(`/api/prep/items/${i.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isOnList: true }),
      })
    ))
  }

  // ── Redesigned To-do tab — drawer / cook-along / adapter handlers ──────────

  // Drawer open: set item, fetch its detail (ingredients + counts)
  const openDrawer = useCallback(async (item: PrepItemRich) => {
    setDrawerItem(item)
    setDrawerDetail(null)
    try {
      const res = await fetch(`/api/prep/items/${item.id}`)
      if (res.ok) setDrawerDetail(await res.json())
    } catch { /* leave detail null → drawer shows loading */ }
  }, [])

  const closeDrawer = useCallback(() => { setDrawerItem(null); setDrawerDetail(null) }, [])

  // Recipe cook-along: needs steps+cost (from recipe) and ingredient availability (from prep detail)
  const openRecipeModal = useCallback(async (item: PrepItemRich) => {
    if (!item.linkedRecipeId) return
    // 1) Paint the modal instantly. Use cached data if we have it; otherwise build a
    //    partial header from the prep item itself (name + base yield are already loaded)
    //    and show a loading skeleton for ingredients/steps/cost.
    const cached = recipeCache.current.get(item.id)
    const partial: RecipeStepsData = {
      id: item.linkedRecipeId,
      name: item.linkedRecipe?.name ?? item.name,
      steps: [],
      baseYieldQty: Number(item.linkedRecipe?.baseYieldQty) || 0,
      yieldUnit: item.linkedRecipe?.yieldUnit ?? item.unit,
      totalCost: 0,
    }
    setRecipeModal({
      sourceItemId: item.id,
      recipe: cached?.recipe ?? partial,
      ings: cached?.ings ?? [],
      makeQty: item.suggestedQty,
      unit: item.unit,
      loading: !cached,
    })
    // 2) Fetch fresh data in the background (even on a cache hit — availability/cost drift).
    try {
      const [rRes, dRes] = await Promise.all([
        fetch(`/api/recipes/${item.linkedRecipeId}`),
        fetch(`/api/prep/items/${item.id}`),
      ])
      const r = rRes.ok ? await rRes.json() : null
      const d: PrepItemDetail | null = dRes.ok ? await dRes.json() : null
      if (!r) {
        setRecipeModal(prev => prev && prev.sourceItemId === item.id ? { ...prev, loading: false } : prev)
        return
      }
      // Steps may be a structured array; otherwise fall back to parsing the recipe's
      // free-text notes (e.g. "Instructions: 1. … 2. …") so the method is always shown.
      const parsedSteps: string[] = (() => {
        if (Array.isArray(r.steps) && r.steps.length > 0) return r.steps.map(String)
        const notes: string = typeof r.notes === 'string' ? r.notes : ''
        if (!notes.trim()) return []
        const body = notes.replace(/^\s*(?:instructions?|method|steps)\s*:?\s*/i, '')
        let parts = body.split(/(?=\d+[.)]\s)/).map(s => s.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean)
        if (parts.length <= 1) parts = body.split(/\n+/).map(s => s.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean)
        return parts
      })()
      const recipe: RecipeStepsData = {
        id: r.id, name: r.name, steps: parsedSteps,
        baseYieldQty: Number(r.baseYieldQty) || 0, yieldUnit: r.yieldUnit ?? item.unit,
        totalCost: Number(r.totalCost) || 0,
      }
      const ings = d?.ingredients ?? []
      recipeCache.current.set(item.id, { recipe, ings })
      // Only patch if this modal is still the one open (user may have closed/switched).
      setRecipeModal(prev => prev && prev.sourceItemId === item.id ? { ...prev, recipe, ings, loading: false } : prev)
    } catch {
      setRecipeModal(prev => prev && prev.sourceItemId === item.id ? { ...prev, loading: false } : prev)
    }
  }, [])

  // Adapter: new components call onStatusChange(item, status, qty); existing handler takes (itemId, status, qty)
  // NOT memoized: must use the current handleStatusChange closure (which reads
  // current `items`). useCallback([]) here froze the first-render closure where
  // items was [], so every status action early-returned on `items.find` → no-op.
  const onRowStatusChange = (item: PrepItemRich, status: string, qty?: number) => {
    handleStatusChange(item.id, status, qty)
  }

  // Complete from the cook-along modal: marks the prep DONE with the made (yield)
  // qty, which credits the output inventory item and deducts ingredients.
  const onRecipeComplete = useCallback((qty: number) => {
    const target = recipeModal?.sourceItemId ? items.find(i => i.id === recipeModal.sourceItemId) : null
    if (!target) { toast(`Made ${qty}`); return }
    handleStatusChange(target.id, 'DONE', qty)
    toast(`Done · added ${qty} ${target.unit}`)
  }, [recipeModal, items, toast])

  // Stop from the cook-along modal: abandon the in-progress prep (no qty logged),
  // returning it to the to-do list. No inventory effect (only DONE/PARTIAL credit).
  const onRecipeStop = useCallback(() => {
    const target = recipeModal?.sourceItemId ? items.find(i => i.id === recipeModal.sourceItemId) : null
    if (!target) return
    handleStatusChange(target.id, 'NOT_STARTED')
    toast(`Stopped · ${target.name} back on the list`)
  }, [recipeModal, items, toast])

  // Keep the open drawer's item in sync across the auto-refresh poll
  useEffect(() => {
    if (!drawerItem) return
    const fresh = items.find(i => i.id === drawerItem.id)
    if (fresh && fresh !== drawerItem) setDrawerItem(fresh)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items])

  // ── Render helpers ────────────────────────────────────────────────────────

  const selCls = 'border border-line rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gold'
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
    const edgeColor = isCritical ? '#dc2626' : isNeeded ? '#d97706' : '#16a34a'
    const fmtN = (n: number) => (Number(n) % 1 === 0 ? Number(n).toFixed(0) : Number(n).toFixed(1))
    const makeLabel = item.suggestedQty > 0 ? `make ${fmtN(item.suggestedQty)} ${item.unit}` : 'review stock'

    return (
      <>
      {/* Mobile — compact row; tap opens the detail drawer (priority override lives there) */}
      <button
        type="button"
        onClick={() => setSelected(item)}
        className="md:hidden w-full text-left flex items-center gap-2.5 bg-paper border border-line rounded-xl pl-2.5 pr-2 py-2 active:bg-bg-2 transition-colors"
        style={{ borderLeftWidth: 4, borderLeftColor: edgeColor }}
      >
        <div className="flex-1 min-w-0">
          <div className="text-[14px] font-semibold tracking-[-0.01em] text-ink truncate leading-tight">{item.name}</div>
          <div className="font-mono text-[10.5px] text-ink-3 truncate mt-0.5">
            {item.category} · <b className="text-ink font-medium">{fmtN(item.onHand)}/{fmtN(item.parLevel)}</b>
            {item.priority !== 'LATER'
              ? <span className={suggestColor}> · {makeLabel}{item.estimatedPrepTime ? ` · ~${item.estimatedPrepTime}m` : ''}</span>
              : <span className="text-green-text"> · on par</span>}
          </div>
        </div>

        {/* Priority chip — shows current priority, tap to override (no full-drawer trip) */}
        {(() => {
          const eff = item.manualPriorityOverride ?? item.priority
          const chip = eff === '911'
            ? { label: 'Critical', cls: 'bg-red-soft text-red-text' }
            : eff === 'NEEDED_TODAY'
              ? { label: 'Needed', cls: 'bg-gold-soft text-gold-2' }
              : { label: 'On par', cls: 'bg-green-soft text-green-text' }
          const open = priorityMenuFor === item.id
          return (
            <span className="relative shrink-0">
              <span
                role="button"
                tabIndex={0}
                title="Change priority"
                onClick={(e) => { e.stopPropagation(); setPriorityMenuFor(open ? null : item.id) }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setPriorityMenuFor(open ? null : item.id) } }}
                className={`inline-flex items-center gap-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.02em] px-1.5 py-1 rounded-full active:scale-95 ${chip.cls}`}
              >
                {item.manualPriorityOverride && <span className="opacity-70">✎</span>}{chip.label}
              </span>
              {open && (
                <>
                  <span className="fixed inset-0 z-40" onClick={(e) => { e.stopPropagation(); setPriorityMenuFor(null) }} />
                  <span className="absolute right-0 top-[calc(100%+4px)] z-50 w-36 bg-paper border border-line rounded-xl shadow-lg overflow-hidden py-1 flex flex-col" role="menu">
                    {([['911', 'Critical'], ['NEEDED_TODAY', 'Needed today'], ['LATER', 'Later']] as const).map(([p, label]) => (
                      <span key={p} role="menuitem" tabIndex={0}
                        onClick={(e) => { e.stopPropagation(); setPriorityMenuFor(null); handlePriorityChange(item.id, p) }}
                        className={`px-3 py-2 text-[12.5px] active:bg-bg-2 ${eff === p ? 'text-ink font-semibold' : 'text-ink-2'}`}>
                        {eff === p ? '✓ ' : ''}{label}
                      </span>
                    ))}
                    {item.manualPriorityOverride && (
                      <span role="menuitem" tabIndex={0}
                        onClick={(e) => { e.stopPropagation(); setPriorityMenuFor(null); handlePriorityChange(item.id, '') }}
                        className="px-3 py-2 text-[12.5px] text-ink-3 border-t border-line active:bg-bg-2">
                        Reset to auto
                      </span>
                    )}
                  </span>
                </>
              )}
            </span>
          )
        })()}

        <span
          role="button"
          tabIndex={0}
          title={isAdded ? "Remove from today's list" : "Add to today's list"}
          onClick={(e) => { e.stopPropagation(); handleToggleOnList(item.id, !isAdded) }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); handleToggleOnList(item.id, !isAdded) } }}
          className={`w-9 h-9 rounded-[10px] grid place-items-center shrink-0 active:scale-95 ${isAdded ? 'bg-green-soft text-green-text' : 'bg-ink text-gold'}`}
        >
          {isAdded ? <Check size={16} /> : <Plus size={16} />}
        </span>
      </button>

      {/* Desktop — full card (urgency columns) */}
      <div className={`hidden md:flex bg-paper border ${cardBorder} rounded-[10px] p-3 sm:p-3.5 flex-col gap-2 sm:gap-2.5`}>
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
                ? 'bg-green-soft text-green-text border border-green-soft hover:border-red hover:bg-red-soft hover:text-red'
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
          <div className="flex justify-between font-mono text-[11px] text-ink-3 gap-2 flex-wrap">
            <span className="whitespace-nowrap"><b className="text-ink font-medium">{item.onHand % 1 === 0 ? item.onHand.toFixed(0) : item.onHand.toFixed(1)}</b> / {item.parLevel % 1 === 0 ? item.parLevel.toFixed(0) : item.parLevel.toFixed(1)} {item.unit} on hand</span>
            <span className={`whitespace-nowrap ${isCritical ? 'text-red-text' : isNeeded ? 'text-gold-2' : 'text-ink-3'}`}>{parPct}% of par</span>
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
            <div className={`font-mono text-[11.5px] tracking-[0] flex items-start gap-1.5 ${suggestColor}`}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`${suggestAccent} shrink-0 mt-[1px]`}><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>
              <span className="min-w-0">
                System suggests <b className={`${suggestAccent} font-semibold`}>→ make {item.suggestedQty > 0 ? `${item.suggestedQty % 1 === 0 ? item.suggestedQty.toFixed(0) : item.suggestedQty.toFixed(1)} ${item.unit}` : 'TBD'}</b>
                {item.estimatedPrepTime ? <> · ~{item.estimatedPrepTime} min</> : null}
              </span>
            </div>
          )
        ) : (
          <div className="font-mono text-[11.5px] text-green-text tracking-[0]">At or above par — looking good</div>
        )}

        {/* Override pills */}
        <div className="flex items-center gap-1.5 flex-wrap pt-2 border-t border-line">
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
      </>
    )
  }

  // ── Page JSX ──────────────────────────────────────────────────────────────

  return (
    <div className="space-y-3 md:space-y-5">

      {/* ── Mobile Header ── */}
      <div className="md:hidden">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-ink flex items-center gap-1.5">
              <ChefHat size={20} className="text-gold" /> Prep List
            </h1>
            <p className="text-[11.5px] text-ink-3 mt-0.5 flex items-center gap-1.5 flex-wrap">
              <span>{new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span>
              {prepBy && (
                <>
                  <span className="text-ink-4">·</span>
                  {prepBy.onDemand ? (
                    <span className="text-ink-3">on-demand{prepBy.lead ? ` · lead ${prepBy.lead}` : ''}</span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-gold-2 font-medium">
                      <Clock size={11} /> prep by {prepBy.time}
                      <span className="text-ink-4 font-normal">· {prepBy.left} left</span>
                    </span>
                  )}
                </>
              )}
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {/* Refresh / Sync / Settings collapse into a ⋯ menu; gold + stays primary */}
            <div className="relative">
              <button onClick={() => setShowHeaderMenu(v => !v)}
                className="p-2 rounded-lg border border-line text-ink-2 active:bg-bg-2"
                title="More actions" aria-haspopup="menu" aria-expanded={showHeaderMenu}>
                <MoreHorizontal size={16} className={generating ? 'text-gold' : ''} />
              </button>
              {showHeaderMenu && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowHeaderMenu(false)} />
                  <div className="absolute right-0 top-[calc(100%+6px)] z-50 w-52 bg-paper border border-line rounded-xl shadow-lg overflow-hidden py-1" role="menu">
                    <button onClick={() => { setShowHeaderMenu(false); handleRefresh() }} disabled={generating}
                      className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-[13px] text-ink-2 active:bg-bg-2 disabled:opacity-50" role="menuitem">
                      <RefreshCw size={15} className={`text-ink-3 ${generating ? 'animate-spin' : ''}`} />
                      {generating ? 'Refreshing…' : 'Refresh'}
                    </button>
                    <button onClick={() => { setShowHeaderMenu(false); setShowSettings(true) }}
                      className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-[13px] text-ink-2 active:bg-bg-2" role="menuitem">
                      <Settings size={15} className="text-ink-3" /> Settings
                    </button>
                  </div>
                </>
              )}
            </div>
            <button onClick={() => setShowAdd(true)}
              disabled={isReadOnly}
              title={isReadOnly ? 'Select a revenue center to make changes' : 'Add item'}
              className="p-2 rounded-lg bg-ink text-paper [&_svg]:text-gold active:bg-ink-2 disabled:opacity-50 disabled:cursor-not-allowed">
              <Plus size={16} />
            </button>
          </div>
        </div>

        {/* Mobile view tabs */}
        <div className="flex bg-bg-2 border border-line rounded-xl p-1 mt-2.5 gap-0.5">
          {(['today', 'smartprep', 'history'] as const).map(m => (
            <button key={m} onClick={() => setViewMode(m)}
              className={`flex-1 py-1.5 text-xs font-medium rounded-lg transition-colors flex items-center justify-center gap-1 ${viewMode === m ? 'bg-paper shadow-[0_1px_2px_rgba(0,0,0,0.04)] text-ink' : 'text-ink-3'}`}>
              {m === 'today' ? <>To Do {(shiftSummary.total - shiftSummary.resolved) > 0 && <span className="font-mono bg-gold text-ink text-[9px] font-bold px-1.5 py-0.5 rounded-full">{shiftSummary.total - shiftSummary.resolved}</span>}</> : m === 'smartprep' ? <>Smart Prep {(spCritical.length + spNeeded.length) > 0 && <span className="font-mono bg-red text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full">{spCritical.length + spNeeded.length}</span>}</> : <><History size={12} /> History</>}
            </button>
          ))}
        </div>

        {/* Shift info on Today is rendered once by <PrepShiftBand> in the shared content block (all breakpoints). */}

        {/* Smart Prep toolbar — view switcher + collapsible search/filter (mobile only) */}
        {viewMode === 'smartprep' && (
          <div className="mt-3 space-y-2">
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0 flex bg-bg-2 border border-line rounded-[10px] p-1 gap-0.5">
                {(['urgency', 'category', 'station'] as const).map(v => (
                  <button key={v} onClick={() => setSmartPrepView(v)}
                    className={`flex-1 py-1.5 font-mono text-[11px] uppercase tracking-[0.03em] rounded-[7px] transition-colors ${smartPrepView === v ? 'bg-paper shadow-[0_1px_2px_rgba(0,0,0,0.04)] text-ink' : 'text-ink-3'}`}>
                    {v}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setShowMobileSearch(v => { if (v) setSearch(''); return !v })}
                title="Search"
                className={`shrink-0 p-2 rounded-[9px] border transition-colors ${showMobileSearch || search ? 'border-ink bg-ink text-paper' : 'border-line text-ink-2 active:bg-bg-2'}`}>
                <Search size={15} />
              </button>
              <button
                onClick={() => setShowMobileFilters(v => !v)}
                title="Filter"
                className={`shrink-0 p-2 rounded-[9px] border inline-flex items-center gap-1 transition-colors ${showMobileFilters || activeFilterCount > 0 ? 'border-gold bg-gold-soft text-gold-2' : 'border-line text-ink-2 active:bg-bg-2'}`}>
                <SlidersHorizontal size={15} />
                {activeFilterCount > 0 && <span className="font-mono text-[10px] font-bold">{activeFilterCount}</span>}
              </button>
            </div>

            {showMobileSearch && (
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" />
                <input
                  autoFocus
                  className="w-full bg-paper border border-line rounded-[9px] pl-9 pr-3 py-2 text-[13px] text-ink placeholder:text-ink-3 focus:outline-none focus:border-ink-3 transition-colors"
                  placeholder="Search prep items…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
            )}

            {showMobileFilters && (
              <div className="bg-paper border border-line rounded-[9px] p-2.5 space-y-2">
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
        )}
      </div>

      {/* ── Desktop Header ── */}
      <div className="hidden md:block space-y-4">
        {/* Top bar */}
        <div className="flex items-center justify-between gap-6">
          <div>
            <p className="font-mono text-[10.5px] uppercase tracking-[0.02em] text-ink-3 mb-2.5 flex items-center gap-1.5">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 10h18M8 2v4M16 2v4"/></svg>
              Today / Prep
            </p>
            <h1 className="text-[34px] font-semibold tracking-[-0.04em] leading-none text-ink mb-1.5">Prep list</h1>
            <p className="text-[13.5px] text-ink-3 tracking-[-0.005em]">
              {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
              {countdown && <> · dinner service in <b className="text-ink font-medium">{countdown.serviceLabel}</b></>}
            </p>
          </div>

          {/* Desktop tabs — centered, branded pill */}
          <div className="inline-flex bg-bg-2 border border-line rounded-[11px] p-[3px] gap-[2px]">
            <button onClick={() => setViewMode('today')} id="dtab-today"
              className={`px-3.5 py-2 text-[13px] font-medium rounded-lg transition-colors inline-flex items-center gap-1.5 tracking-[-0.005em] ${viewMode === 'today' ? 'bg-paper text-ink shadow-[0_1px_2px_rgba(0,0,0,0.04)]' : 'text-ink-3 hover:text-ink-2'}`}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18M7 13h4M7 16h6"/></svg>
              To do
              {(shiftSummary.total - shiftSummary.resolved) > 0 && <span className={`font-mono text-[10px] text-white px-1.5 rounded-full font-semibold ${viewMode === 'today' ? 'bg-red' : 'bg-ink-4'}`}>{shiftSummary.total - shiftSummary.resolved}</span>}
            </button>
            <button onClick={() => setViewMode('smartprep')} id="dtab-smartprep"
              className={`px-3.5 py-2 text-[13px] font-medium rounded-lg transition-colors inline-flex items-center gap-1.5 tracking-[-0.005em] ${viewMode === 'smartprep' ? 'bg-paper text-ink shadow-[0_1px_2px_rgba(0,0,0,0.04)]' : 'text-ink-3 hover:text-ink-2'}`}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>
              Smart prep
              {(shiftSummary.critical + spNeeded.length) > 0 && <span className={`font-mono text-[10px] text-white px-1.5 rounded-full font-semibold ${viewMode === 'smartprep' ? 'bg-red' : 'bg-ink-4'}`}>{shiftSummary.critical + spNeeded.length}</span>}
            </button>
            <button onClick={() => setViewMode('history')} id="dtab-history"
              className={`px-3.5 py-2 text-[13px] font-medium rounded-lg transition-colors inline-flex items-center gap-1.5 tracking-[-0.005em] ${viewMode === 'history' ? 'bg-paper text-ink shadow-[0_1px_2px_rgba(0,0,0,0.04)]' : 'text-ink-3 hover:text-ink-2'}`}>
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
            <button onClick={() => setShowSettings(true)} title="Settings"
              className="inline-flex items-center justify-center p-2.5 rounded-[9px] border border-line bg-paper text-ink-2 hover:border-ink-3 transition-colors">
              <Settings size={15} className="text-ink-3" />
            </button>
            <button onClick={() => setShowAdd(true)}
              disabled={isReadOnly}
              title={isReadOnly ? 'Select a revenue center to make changes' : undefined}
              className="inline-flex items-center gap-[7px] px-4 py-2.5 rounded-[9px] border border-ink bg-ink text-paper text-[13px] font-medium hover:bg-[#18181b] transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-ink">
              <span className="text-gold font-semibold text-base leading-none">+</span>
              Add item
            </button>
          </div>
        </div>
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
          isOffline ? 'bg-gold-soft border-gold-soft text-gold-2' : 'bg-gold/10 border-gold/30 text-blue-text'
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


      {/* ══════════════════════════════════════════════════════
          TODAY TAB
      ══════════════════════════════════════════════════════ */}
      {/* ══════════════════════════════════════════════════════
          DESKTOP BOARD — dense redesign (To Do + Smart Prep)
          Replaces the old desktop renderers below (now md:hidden).
      ══════════════════════════════════════════════════════ */}
      {viewMode !== 'history' && (
        <div className="pb hidden md:block" style={{ containerType: 'inline-size' }}>
          {viewMode === 'today' && priorityAlerts.length > 0 && !alertDismissed && (
            <div className="mb-2.5">
              <PrepAlertBanner
                onDismiss={() => setAlertDismissed(true)}
                compact={<><b className="font-semibold">Stock changed.</b> {priorityAlerts.length} item{priorityAlerts.length !== 1 ? 's' : ''} now Critical.</>}
                message={priorityAlerts.length === 1
                  ? <><b>Stock changed since this list was scheduled.</b> {priorityAlerts[0].name} dropped to Critical — theoretical stock at or below 0.</>
                  : <><b>Stock changed since this list was scheduled.</b> {priorityAlerts.map(i => i.name).join(', ')} — now Critical, stock depleted.</>}
              />
            </div>
          )}
          <div className="toolbar">
            <div className="search">
              <span className="icn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg></span>
              <input placeholder="Search prep items, recipes, stations…" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <select className="ddown" value={filterCategory} onChange={e => setFilterCategory(e.target.value)}>
              <option value="ALL">All categories</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select className="ddown" value={filterStation} onChange={e => setFilterStation(e.target.value)}>
              <option value="ALL">All stations</option>
              {stations.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <button className="ddown" onClick={() => setActiveOnly(a => !a)}><span className="cb">{activeOnly ? '✓' : ''}</span> Active only</button>
            {viewMode === 'smartprep' && (
              <div className="seg" style={{ marginLeft: 'auto' }}>
                {(['urgency', 'category', 'station'] as const).map(g => (
                  <div key={g} className={`s${smartPrepView === g ? ' active' : ''}`} onClick={() => setSmartPrepView(g)}>{g[0].toUpperCase() + g.slice(1)}</div>
                ))}
              </div>
            )}
          </div>
          <PrepSummaryLine items={viewMode === 'today' ? filteredToday : filteredSmart} view={viewMode === 'today' ? 'todo' : 'smart'} />
          {loading ? (
            <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gold" /></div>
          ) : (
            <PrepBoard
              view={viewMode === 'today' ? 'todo' : 'smart'}
              groupBy={smartPrepView}
              items={filteredSmart}
              todayItems={filteredToday}
              handlers={{ onOpen: openDrawer, onOpenRecipe: openRecipeModal, onToggleOnList: handleToggleOnList, onStatusChange: onRowStatusChange, onQuickDone: setDoneSheetItem, onPriorityChange: handlePriorityChange, savingIds }}
              onAddAll={handleAddIds}
              tasksSlot={viewMode === 'smartprep'
                ? <PrepTaskLibrary
                    asBlock
                    rows={taskRows}
                    inventory={inventoryForTasks}
                    disabled={tasksDisabled}
                    onCreate={createTask}
                    onEdit={editTask}
                    onToggleActive={setTaskActive}
                    onDelete={deleteTask}
                    onReorder={reorderTasks}
                  />
                : activeTaskRows.length > 0
                  ? <PrepTaskList asBlock rows={activeTaskRows} onDone={clearTaskToday} onRemove={clearTaskToday} />
                  : undefined}
            />
          )}
        </div>
      )}

      {viewMode === 'today' && (
        <div className="space-y-0 md:hidden">
          <PrepShiftBand summary={shiftSummary} countdown={countdown} workloadLabel={workloadLabel} />
          {priorityAlerts.length > 0 && !alertDismissed && (
            <PrepAlertBanner
              onDismiss={() => setAlertDismissed(true)}
              compact={
                <><b className="font-semibold">Stock changed.</b> {priorityAlerts.length} item{priorityAlerts.length !== 1 ? 's' : ''} now Critical.</>
              }
              message={
                priorityAlerts.length === 1
                  ? <><b>Stock changed since this list was scheduled.</b> {priorityAlerts[0].name} dropped to Critical — theoretical stock at or below 0.</>
                  : <><b>Stock changed since this list was scheduled.</b> {priorityAlerts.map(i => i.name).join(', ')} — now Critical, stock depleted.</>
              }
            />
          )}
          {/* Prep tasks (checklist) — mobile To Do */}
          {activeTaskRows.length > 0 && (
            <div className="mb-3">
              <PrepTaskList rows={activeTaskRows} onDone={clearTaskToday} onRemove={clearTaskToday} />
            </div>
          )}
          {loading ? (
            <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gold" /></div>
          ) : todayItems.length === 0 ? (
            <div className="bg-white border border-line rounded-xl py-16 text-center">
              <ChefHat size={32} className="mx-auto text-ink-4 mb-3" />
              <p className="text-ink-3 text-sm">Nothing on today&apos;s list yet.</p>
              <p className="text-xs text-ink-4 mt-2">Go to{' '}<button onClick={() => setViewMode('smartprep')} className="text-gold hover:underline">Smart Prep</button>{' '}and add items.</p>
            </div>
          ) : shiftSummary.resolved === shiftSummary.total ? (
            <PrepRestState total={shiftSummary.total} />
          ) : (
            <>
              {todayGroups.critical.length > 0 && (
                <div className="font-mono text-[10.5px] uppercase tracking-[0.05em] text-ink-3 mb-2.5 mt-1 flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-red" />Critical · <span className="text-ink font-semibold">make now</span></div>
              )}
              {todayGroups.critical.map(item => (
                <PrepTaskRowCompact key={item.id} item={item} kind="critical" onOpen={openDrawer} onOpenRecipe={openRecipeModal} onStatusChange={onRowStatusChange} onQuickDone={setDoneSheetItem} />
              ))}
              {todayGroups.needed.length > 0 && (
                <div className="font-mono text-[10.5px] uppercase tracking-[0.05em] text-ink-3 mb-2.5 mt-4 flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-gold" />Needed today</div>
              )}
              {todayGroups.needed.map(item => (
                <PrepTaskRowCompact key={item.id} item={item} kind="needed" onOpen={openDrawer} onOpenRecipe={openRecipeModal} onStatusChange={onRowStatusChange} onQuickDone={setDoneSheetItem} />
              ))}
              <PrepGetAhead items={todayGroups.later} onAdd={(it) => handleToggleOnList(it.id, true)} />
              {todayGroups.done.length > 0 && (
                <div className="mt-5">
                  <div className="font-mono text-[10.5px] uppercase tracking-[0.05em] text-ink-3 mb-2.5 flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-green" />Done today · <span className="text-ink font-semibold">{todayGroups.done.length} prepped</span></div>
                  {todayGroups.done.map(item => (
                    <PrepTaskRowCompact key={item.id} item={item} onOpen={openDrawer} onOpenRecipe={openRecipeModal} onStatusChange={onRowStatusChange} onQuickDone={setDoneSheetItem} />
                  ))}
                </div>
              )}
              <p className="text-center text-xs text-ink-4 mt-4 pb-24 sm:pb-0">This list carries over each day — items stay until marked done or removed.</p>
            </>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          SMART PREP TAB
      ══════════════════════════════════════════════════════ */}
      {viewMode === 'smartprep' && (
        <div className="space-y-4 md:hidden">
          {loading ? (
            <div className="flex justify-center py-16">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gold" />
            </div>
          ) : (
            <>
              {/* Prep tasks (checklist) — mobile Smart Prep */}
              <PrepTaskLibrary
                rows={taskRows}
                inventory={inventoryForTasks}
                disabled={tasksDisabled}
                onCreate={createTask}
                onEdit={editTask}
                onToggleActive={setTaskActive}
                onDelete={deleteTask}
                onReorder={reorderTasks}
              />
              {/* ── BY URGENCY ── */}
              {smartPrepView === 'urgency' && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5 items-start">

                  {/* Critical column */}
                  <div className="md:bg-[#fffafa] md:border md:border-[#fca5a5] flex flex-col md:rounded-xl md:min-h-[480px]">
                    <div className="px-0.5 md:px-4 py-2 md:py-3.5 border-b border-line md:border-[#fca5a5] flex items-center justify-between gap-2.5">
                      <div className="flex items-center gap-2 min-w-0 flex-1 whitespace-nowrap">
                        <span className="w-2 h-2 rounded-full bg-red" />
                        <span className="font-mono text-[11.5px] tracking-[0.02em] font-semibold text-red-text">CRITICAL</span>
                        <span className="font-mono text-[11px] text-ink-3 font-normal">· {spCritical.length} item{spCritical.length !== 1 ? 's' : ''}</span>
                      </div>
                      {spCritical.some(i => !i.isOnList) && (
                        <button onClick={() => handleAddAll('911')}
                          className="font-mono text-[10.5px] px-2.5 py-1 rounded-full font-medium border border-red bg-red text-paper hover:bg-red-text whitespace-nowrap">
                          + Add all
                        </button>
                      )}
                    </div>
                    <p className="font-mono text-[10.5px] text-red-text px-0.5 md:px-4 pt-2 pb-1">Stock depleted — make now</p>
                    <div className="flex-1 px-0 md:px-3 pb-2 md:pb-3 pt-2 flex flex-col gap-2 overflow-visible md:overflow-auto">
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
                  <div className="md:bg-paper md:border md:border-line flex flex-col md:rounded-xl md:min-h-[480px]">
                    <div className="px-0.5 md:px-4 py-2 md:py-3.5 border-b border-line flex items-center justify-between gap-2.5">
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
                    <p className="font-mono text-[10.5px] text-ink-3 px-0.5 md:px-4 pt-2 pb-1">Below par — should be prepped today</p>
                    <div className="flex-1 px-0 md:px-3 pb-2 md:pb-3 pt-2 flex flex-col gap-2 overflow-visible md:overflow-auto">
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
                  <div className="md:bg-paper md:border md:border-line flex flex-col md:rounded-xl md:min-h-[480px]">
                    <button
                      onClick={() => setLookingGoodOpen(v => !v)}
                      className="px-0.5 md:px-4 py-2 md:py-3.5 border-b border-line flex items-center justify-between gap-2.5 hover:bg-bg-2/40 transition-colors"
                    >
                      <div className="flex items-center gap-2 min-w-0 flex-1 whitespace-nowrap">
                        <span className="w-2 h-2 rounded-full bg-green" />
                        <span className="font-mono text-[11.5px] tracking-[0.02em] font-semibold text-green-text">LOOKING GOOD</span>
                        <span className="font-mono text-[11px] text-ink-3 font-normal">· {spLookingGood.length} item{spLookingGood.length !== 1 ? 's' : ''}</span>
                      </div>
                      <span className="font-mono text-[11px] text-ink-3">{lookingGoodOpen ? '▾' : '→'}</span>
                    </button>
                    <p className="font-mono text-[10.5px] text-ink-3 px-0.5 md:px-4 pt-2 pb-1">On par or above — no action needed</p>
                    {lookingGoodOpen ? (
                      <div className="flex-1 px-0 md:px-3 pb-2 md:pb-3 pt-2 flex flex-col gap-1.5 overflow-visible md:overflow-auto">
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
                                        ? 'bg-bg-2 text-ink-2 border border-line hover:border-red hover:bg-red-soft hover:text-red'
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
                      <div className="flex-1 px-0 md:px-3 pb-2 md:pb-3 pt-2 flex flex-col gap-1.5 overflow-hidden">
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
                                      ? 'bg-bg-2 text-ink-2 border border-line hover:border-red hover:bg-red-soft hover:text-red'
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
                      <div key={cat} className="md:overflow-hidden md:bg-paper md:border md:border-line md:rounded-xl">
                        {/* Group header — branded "grow" style (gold-soft for active categories, neutral otherwise) */}
                        <div className={`grid grid-cols-[1fr_auto] items-center px-0.5 md:px-[18px] py-2 md:py-2.5 border-b border-line ${criticalCount > 0 || neededCount > 0 ? 'md:bg-gold-soft md:border-[#fcd34d]' : 'md:bg-bg-2 md:border-line'}`}>
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
                        <div className="pt-2 pb-1 flex flex-col gap-2">
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
                      <div key={station} className="md:overflow-hidden md:bg-paper md:border md:border-line md:rounded-xl">
                        {/* Group header */}
                        <div className={`grid grid-cols-[1fr_auto] items-center px-0.5 md:px-[18px] py-2 md:py-2.5 border-b border-line ${hasUrgent ? 'md:bg-gold-soft md:border-[#fcd34d]' : 'md:bg-bg-2 md:border-line'}`}>
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
                        <div className="pt-2 pb-1 flex flex-col gap-2">
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

            </>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          HISTORY TAB
      ══════════════════════════════════════════════════════ */}
      {viewMode === 'history' && (
        <div className="space-y-4">
          <div className="bg-paper border border-line rounded-xl p-4 flex items-center gap-3 flex-wrap">
            <History size={16} className="text-ink-4 shrink-0" />
            <span className="text-sm font-medium text-ink-2">View date:</span>
            <input
              type="date"
              max={new Date().toISOString().slice(0, 10)}
              value={historyDate}
              onChange={e => setHistoryDate(e.target.value)}
              className="bg-paper border border-line rounded-[10px] px-3 py-2 text-[13px] text-ink-2 font-mono focus:outline-none focus:ring-2 focus:ring-gold"
            />
            <span className="text-[11px] text-ink-3 font-mono ml-auto">
              {new Date(historyDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
            </span>
          </div>

          {historyLoading ? (
            <div className="flex justify-center py-12">
              <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-gold" />
            </div>
          ) : historyLogs.length === 0 ? (
            <div className="bg-paper border border-line rounded-xl py-12 text-center">
              <History size={28} className="mx-auto text-ink-4 mb-3" />
              <p className="text-ink-3 text-sm">No prep was logged on this date.</p>
              <p className="text-xs text-ink-3 mt-1">Try a different date.</p>
            </div>
          ) : (() => {
            const STATUS_HIST: Record<string, { label: string; cls: string }> = {
              DONE:        { label: 'Done',        cls: 'bg-green-soft text-green-text' },
              PARTIAL:     { label: 'Partial',     cls: 'bg-gold-soft text-gold-2' },
              IN_PROGRESS: { label: 'In Progress', cls: 'bg-blue-soft text-blue-text' },
              BLOCKED:     { label: 'Blocked',     cls: 'bg-red-soft text-red-text' },
              SKIPPED:     { label: 'Skipped',     cls: 'bg-bg-2 text-ink-3' },
              NOT_STARTED: { label: 'Not Started', cls: 'bg-bg-2 text-ink-3' },
            }
            const done    = historyLogs.filter(l => l.status === 'DONE').length
            const partial = historyLogs.filter(l => l.status === 'PARTIAL').length
            const blocked = historyLogs.filter(l => l.status === 'BLOCKED').length
            const total   = historyLogs.length
            const completionRate = total > 0 ? Math.round(((done + partial) / total) * 100) : 0
            return (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {[
                    { label: 'Total', value: total, cls: 'text-ink' },
                    { label: 'Done', value: done, cls: 'text-green-text' },
                    { label: 'Partial', value: partial, cls: 'text-gold-2' },
                    { label: 'Completion', value: `${completionRate}%`, cls: completionRate >= 80 ? 'text-green-text' : completionRate >= 50 ? 'text-gold-2' : 'text-red-text' },
                  ].map(c => (
                    <div key={c.label} className="bg-paper border border-line rounded-xl p-3 text-center">
                      <div className="text-[11px] text-ink-3 font-mono uppercase tracking-wide mb-1">{c.label}</div>
                      <div className={`text-lg font-bold font-mono ${c.cls}`}>{c.value}</div>
                    </div>
                  ))}
                </div>

                {blocked > 0 && (
                  <div className="bg-red-soft border border-red-soft rounded-xl px-4 py-2.5 text-sm text-red-text">
                    {blocked} item{blocked !== 1 ? 's were' : ' was'} blocked — see notes below.
                  </div>
                )}

                <div className="bg-paper border border-line rounded-xl overflow-hidden">
                  <div className="px-4 py-2 bg-bg-2 border-b border-line flex items-center gap-2">
                    <span className="text-[11px] font-semibold text-ink-3 font-mono uppercase tracking-wide">Items Logged</span>
                    <span className="text-[11px] text-ink-4 font-mono">{total}</span>
                  </div>
                  <div className="divide-y divide-line">
                    {historyLogs.map(log => {
                      const meta = STATUS_HIST[log.status] ?? STATUS_HIST.NOT_STARTED
                      return (
                        <div key={log.id} className="px-4 py-3 flex items-center gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-semibold text-ink truncate">{log.prepItem.name}</div>
                            {log.note && <div className="text-xs text-ink-3 mt-0.5 truncate">{log.note}</div>}
                            {log.assignedTo && <div className="text-[11px] text-ink-3 font-mono">by {log.assignedTo}</div>}
                          </div>
                          <div className="flex items-center gap-3 shrink-0">
                            <span className="font-mono text-[13px] text-ink-2">
                              {log.actualPrepQty != null ? Number(log.actualPrepQty).toFixed(1) : '—'} {log.prepItem.unit}
                            </span>
                            <span className={`text-[11px] font-mono px-2 py-0.5 rounded-full font-medium ${meta.cls}`}>{meta.label}</span>
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

      {/* Redesigned To-do tab — drawer, cook-along modal, toast */}
      {/* Mobile keeps the existing drawer; desktop uses the rebuilt board drawer. */}
      <div className="md:hidden">
        <PrepDrawer
          item={drawerItem}
          detail={drawerDetail}
          countdown={countdown}
          recipeCost={null}
          onClose={closeDrawer}
          onStatusChange={onRowStatusChange}
          onOpenRecipe={openRecipeModal}
        />
      </div>
      {/* Quick yield prompt — shared by the mobile compact row and the desktop board row. */}
      <PrepDoneSheet
        item={doneSheetItem}
        onClose={() => setDoneSheetItem(null)}
        onConfirm={(item, qty) => {
          onRowStatusChange(item, 'DONE', qty)
          toast(`Done · ${qty} ${item.unit} made`)
          setDoneSheetItem(null)
        }}
      />
      <div className="hidden md:block">
        <PrepBoardDrawer
          item={drawerItem}
          view={viewMode === 'today' ? 'todo' : 'smart'}
          onClose={closeDrawer}
          onToggleOnList={handleToggleOnList}
          onStatusChange={(item, status, qty) => onRowStatusChange(item, status, qty)}
          onPriorityChange={handlePriorityChange}
          onEdit={(item) => { closeDrawer(); setEditing(item) }}
        />
      </div>
      <RecipeCookAlongModal
        open={recipeModal !== null}
        recipe={recipeModal?.recipe ?? null}
        ingredients={recipeModal?.ings ?? []}
        loading={recipeModal?.loading ?? false}
        initialMakeQty={recipeModal?.makeQty ?? 0}
        unit={recipeModal?.unit ?? ''}
        canStop={(() => {
          const src = recipeModal?.sourceItemId ? items.find(i => i.id === recipeModal.sourceItemId) : null
          return (src?.todayLog?.status ?? 'NOT_STARTED') === 'IN_PROGRESS'
        })()}
        onStop={onRecipeStop}
        onClose={() => setRecipeModal(null)}
        onComplete={onRecipeComplete}
        onOpenSubRecipe={(recipeId, name) => { setSubRecipeChecked(new Set()); setSubRecipeView({ recipeId, name }) }}
      />
      {subRecipeView && (
        // Higher stacking context so the sub-recipe peek sits above the
        // cook-along modal (z-[60]) it was opened from.
        <div className="relative z-[70]">
          <RecipeViewModal
            recipeId={subRecipeView.recipeId}
            recipeName={subRecipeView.name}
            checkedIngredients={subRecipeChecked}
            onToggleIngredient={(id) => setSubRecipeChecked(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next })}
            onClose={() => setSubRecipeView(null)}
          />
        </div>
      )}
      {toastNode}

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
