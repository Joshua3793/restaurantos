'use client'
import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useDrawer } from '@/contexts/DrawerContext'
import dynamic from 'next/dynamic'
import {
  ChefHat, Plus, RefreshCw, Search, Settings, BookOpen,
  SlidersHorizontal, WifiOff, RefreshCcw, History, AlertTriangle, Check, Clock, MoreHorizontal,
} from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { prepDeadline, fmtDuration } from '@/lib/service-hours'
import { savePrepCache, loadPrepCache, loadQueue, enqueueMutation, flushQueue } from '@/lib/prep-offline'
import type { PrepItemRich, PrepLogData } from '@/components/prep/types'
import PrepShiftBand from '@/components/prep/PrepShiftBand'
import PrepAlertBanner from '@/components/prep/PrepAlertBanner'
import PrepToolbar from '@/components/prep/PrepToolbar'
import PrepTaskRow from '@/components/prep/PrepTaskRow'
import PrepTaskRowCompact from '@/components/prep/PrepTaskRowCompact'
import PrepGetAhead from '@/components/prep/PrepGetAhead'
import PrepRestState from '@/components/prep/PrepRestState'
import PrepDrawer from '@/components/prep/PrepDrawer'
import RecipeCookAlongModal from '@/components/prep/RecipeCookAlongModal'
import { usePrepToast } from '@/components/prep/PrepToast'
import { computeShiftSummary, groupPrepItems, computeWorkloadMinutes, formatMinutes, buildPrepCountdown } from '@/lib/prep-utils'
import type { PrepItemDetail, IngredientAvailability, RecipeStepsData } from '@/components/prep/types'

// Lazy-load conditional components — only mount when user opens them
const PrepDetailPanel   = dynamic(() => import('@/components/prep/PrepDetailPanel').then(m => ({ default: m.PrepDetailPanel })), { ssr: false, loading: () => null })
const PrepItemForm      = dynamic(() => import('@/components/prep/PrepItemForm').then(m => ({ default: m.PrepItemForm })), { ssr: false, loading: () => null })
const PrepSettingsModal = dynamic(() => import('@/components/prep/PrepSettingsModal').then(m => ({ default: m.PrepSettingsModal })), { ssr: false, loading: () => null })

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
  const [showHeaderMenu, setShowHeaderMenu] = useState(false)
  const [actionError,  setActionError]  = useState<string | null>(null)
  const [syncing,      setSyncing]      = useState(false)
  const [syncResult,   setSyncResult]   = useState<{ created: number; updated: number; skipped: number } | null>(null)
  const [isOffline,      setIsOffline]      = useState(false)
  const [offlineSyncing, setOfflineSyncing] = useState(false)
  const [pendingCount,   setPendingCount]   = useState(0)
  const [cacheAge,       setCacheAge]       = useState<number | null>(null)

  // Redesigned To-do tab — drawer, cook-along modal, toast, alert dismissal
  const { toast, toastNode } = usePrepToast()
  const [drawerItem, setDrawerItem] = useState<PrepItemRich | null>(null)
  const [drawerDetail, setDrawerDetail] = useState<PrepItemDetail | null>(null)
  const [recipeModal, setRecipeModal] = useState<{ sourceItemId: string; recipe: RecipeStepsData; ings: IngredientAvailability[]; makeQty: number; unit: string } | null>(null)
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
    try {
      const [rRes, dRes] = await Promise.all([
        fetch(`/api/recipes/${item.linkedRecipeId}`),
        fetch(`/api/prep/items/${item.id}`),
      ])
      const r = rRes.ok ? await rRes.json() : null
      const d: PrepItemDetail | null = dRes.ok ? await dRes.json() : null
      if (!r) return
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
      setRecipeModal({ sourceItemId: item.id, recipe, ings: d?.ingredients ?? [], makeQty: item.suggestedQty, unit: item.unit })
    } catch { /* ignore */ }
  }, [])

  // Adapter: new components call onStatusChange(item, status, qty); existing handler takes (itemId, status, qty)
  // NOT memoized: must use the current handleStatusChange closure (which reads
  // current `items`). useCallback([]) here froze the first-render closure where
  // items was [], so every status action early-returned on `items.find` → no-op.
  const onRowStatusChange = (item: PrepItemRich, status: string, qty?: number) => {
    handleStatusChange(item.id, status, qty)
  }

  // Add-to-prep from the cook-along modal: persist planned qty on today's log, then refresh
  const onAddToPrep = useCallback(async (qty: number) => {
    const targetId = recipeModal?.sourceItemId
    if (!targetId) { toast(`Set to make ${qty}`); return }
    try {
      await fetch('/api/prep/logs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prepItemId: targetId, requiredQty: qty }) })
    } catch { /* ignore */ }
    toast(`Task set to make ${qty}`)
    load()
  }, [recipeModal, toast, load])

  // Keep the open drawer's item in sync across the auto-refresh poll
  useEffect(() => {
    if (!drawerItem) return
    const fresh = items.find(i => i.id === drawerItem.id)
    if (fresh && fresh !== drawerItem) setDrawerItem(fresh)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items])

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
                ? 'bg-green-soft text-green-text border border-green-soft hover:border-red-300 hover:bg-red-50 hover:text-red-600'
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
                ? 'bg-green-soft text-green-text border border-green-soft hover:border-red-300 hover:bg-red-50 hover:text-red-600'
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
                <MoreHorizontal size={16} className={syncing || generating ? 'text-gold' : ''} />
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
                    <button onClick={() => { setShowHeaderMenu(false); handleSync() }} disabled={syncing}
                      className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-[13px] text-ink-2 active:bg-bg-2 disabled:opacity-50" role="menuitem">
                      <BookOpen size={15} className={`text-gold ${syncing ? 'animate-pulse' : ''}`} />
                      {syncing ? 'Syncing…' : 'Sync from recipes'}
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
              className="p-2 rounded-lg bg-gold text-white active:bg-[#a88930]" title="Add item">
              <Plus size={16} />
            </button>
          </div>
        </div>

        {/* Mobile view tabs */}
        <div className="flex bg-bg-2 border border-line rounded-xl p-1 mt-2.5 gap-0.5">
          {(['today', 'smartprep', 'history'] as const).map(m => (
            <button key={m} onClick={() => setViewMode(m)}
              className={`flex-1 py-1.5 text-xs font-medium rounded-lg transition-colors flex items-center justify-center gap-1 ${viewMode === m ? 'bg-paper shadow-[0_1px_2px_rgba(0,0,0,0.04)] text-ink' : 'text-ink-3'}`}>
              {m === 'today' ? <>To Do {todayItems.length > 0 && <span className="font-mono bg-gold text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full">{todayItems.length}</span>}</> : m === 'smartprep' ? <>Smart Prep {(spCritical.length + spNeeded.length) > 0 && <span className="font-mono bg-red text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full">{spCritical.length + spNeeded.length}</span>}</> : <><History size={12} /> History</>}
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
            <button onClick={handleSync} disabled={syncing}
              className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-[9px] border border-line bg-paper text-ink-2 text-[13px] font-medium hover:border-ink-3 transition-colors disabled:opacity-50 whitespace-nowrap">
              <BookOpen size={13} className={`text-ink-3 ${syncing ? 'animate-pulse' : ''}`} />
              {syncing ? 'Syncing…' : 'Sync from recipes'}
            </button>
            <button onClick={() => setShowSettings(true)} title="Settings"
              className="inline-flex items-center justify-center p-2.5 rounded-[9px] border border-line bg-paper text-ink-2 hover:border-ink-3 transition-colors">
              <Settings size={15} className="text-ink-3" />
            </button>
            <button onClick={() => setShowAdd(true)}
              className="inline-flex items-center gap-[7px] px-4 py-2.5 rounded-[9px] border border-ink bg-ink text-paper text-[13px] font-medium hover:bg-[#18181b] transition-colors whitespace-nowrap">
              <span className="text-gold font-semibold text-base leading-none">+</span>
              Add item
            </button>
          </div>
        </div>

        {/* Today filter is rendered once by <PrepToolbar> in the shared content block below. */}
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
        <div className="space-y-0">
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
          {/* Desktop gets the full filter toolbar; mobile chefs scan the grouped list, so it's hidden there. */}
          <div className="hidden md:block">
            <PrepToolbar
              search={search} onSearch={setSearch}
              categories={categories} stations={stations}
              filterCategory={filterCategory === 'ALL' ? '' : filterCategory}
              onFilterCategory={v => setFilterCategory(v === '' ? 'ALL' : v)}
              filterStation={filterStation === 'ALL' ? '' : (filterStation as string)}
              onFilterStation={v => setFilterStation(v === '' ? 'ALL' : v)}
              activeOnly={activeOnly} onActiveOnly={setActiveOnly}
              forceOpen={todayItems.length > 3}
            />
          </div>
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
                <div key={item.id}>
                  <div className="hidden md:block"><PrepTaskRow item={item} kind="critical" onOpen={openDrawer} onOpenRecipe={openRecipeModal} onStatusChange={onRowStatusChange} /></div>
                  <div className="md:hidden"><PrepTaskRowCompact item={item} kind="critical" onOpen={openDrawer} onOpenRecipe={openRecipeModal} onStatusChange={onRowStatusChange} /></div>
                </div>
              ))}
              {todayGroups.needed.length > 0 && (
                <div className="font-mono text-[10.5px] uppercase tracking-[0.05em] text-ink-3 mb-2.5 mt-4 flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-gold" />Needed today</div>
              )}
              {todayGroups.needed.map(item => (
                <div key={item.id}>
                  <div className="hidden md:block"><PrepTaskRow item={item} kind="needed" onOpen={openDrawer} onOpenRecipe={openRecipeModal} onStatusChange={onRowStatusChange} /></div>
                  <div className="md:hidden"><PrepTaskRowCompact item={item} kind="needed" onOpen={openDrawer} onOpenRecipe={openRecipeModal} onStatusChange={onRowStatusChange} /></div>
                </div>
              ))}
              <PrepGetAhead items={todayGroups.later} onAdd={(it) => handleToggleOnList(it.id, true)} />
              <p className="text-center text-xs text-ink-4 mt-4 pb-24 sm:pb-0">This list carries over each day — items stay until marked done or removed.</p>
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
          <div className="hidden md:flex items-center gap-3 px-4 py-3 bg-gradient-to-b from-[#fffbeb] to-[#fef9ec] border border-[#fcd34d] rounded-xl">
            <div className="w-7 h-7 rounded-[7px] bg-paper border border-[#fcd34d] grid place-items-center text-gold-2 shrink-0">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/></svg>
            </div>
            <p className="text-[13px] text-[#78350f] tracking-[-0.005em] leading-[1.4] flex-1">
              Suggestions are computed live from <b className="font-semibold text-ink">theoretical stock</b> — sales, wastage &amp; invoices since the last count. Resets at each stock count.
            </p>
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
                                        ? 'bg-bg-2 text-ink-2 border border-line hover:border-red-300 hover:bg-red-50 hover:text-red-600'
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
                                      ? 'bg-bg-2 text-ink-2 border border-line hover:border-red-300 hover:bg-red-50 hover:text-red-600'
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
                        {/* Desktop table header */}
                        <div className="hidden md:grid grid-cols-[16px_2fr_1fr_110px_1fr_220px_110px] gap-3 items-center px-[18px] py-2.5 bg-bg-2 border-b border-line font-mono text-[10.5px] text-ink-3 tracking-[0.01em]">
                          <div /> <div>ITEM</div> <div>STOCK VS PAR</div> <div>ON HAND</div> <div>MAKE</div> <div>OVERRIDE</div> <div className="text-right">ACTION</div>
                        </div>
                        {/* Desktop rows */}
                        <div className="hidden md:block">
                          {rows.map(item => <SmartPrepTableRow key={item.id} item={item} />)}
                        </div>
                        {/* Mobile cards */}
                        <div className="md:hidden pt-2 pb-1 flex flex-col gap-2">
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
                        {/* Desktop table header */}
                        <div className="hidden md:grid grid-cols-[16px_2fr_1fr_110px_1fr_220px_110px] gap-3 items-center px-[18px] py-2.5 bg-bg-2 border-b border-line font-mono text-[10.5px] text-ink-3 tracking-[0.01em]">
                          <div /> <div>ITEM</div> <div>STOCK VS PAR</div> <div>ON HAND</div> <div>MAKE</div> <div>OVERRIDE</div> <div className="text-right">ACTION</div>
                        </div>
                        <div className="hidden md:block">
                          {rows.map(item => <SmartPrepTableRow key={item.id} item={item} />)}
                        </div>
                        <div className="md:hidden pt-2 pb-1 flex flex-col gap-2">
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
      <PrepDrawer
        item={drawerItem}
        detail={drawerDetail}
        countdown={countdown}
        recipeCost={null}
        onClose={closeDrawer}
        onStatusChange={onRowStatusChange}
        onOpenRecipe={openRecipeModal}
      />
      <RecipeCookAlongModal
        open={recipeModal !== null}
        recipe={recipeModal?.recipe ?? null}
        ingredients={recipeModal?.ings ?? []}
        initialMakeQty={recipeModal?.makeQty ?? 0}
        unit={recipeModal?.unit ?? ''}
        onClose={() => setRecipeModal(null)}
        onAddToPrep={onAddToPrep}
      />
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
