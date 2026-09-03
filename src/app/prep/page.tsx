'use client'
import { useEffect, useState, useCallback, useMemo, useRef, memo } from 'react'
import { useDrawer } from '@/contexts/DrawerContext'
import dynamic from 'next/dynamic'
import {
  ChefHat, Plus, RefreshCw, Search, Settings,
  SlidersHorizontal, WifiOff, RefreshCcw, History, Clock, MoreHorizontal, Lock,
} from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { setScopeParams } from '@/lib/scope-params'
import { fmtDuration, serviceStatus, upcomingInfo, formatServiceStatus, type RcService } from '@/lib/service-hours'
import { savePrepCache, loadPrepCache, savePlanCache, loadPlanCache, loadQueue, enqueueMutation, flushQueue } from '@/lib/prep-offline'
import type { PrepItemRich, PrepLogData } from '@/components/prep/types'
import PrepShiftBand from '@/components/prep/PrepShiftBand'
import PrepAlertBanner from '@/components/prep/PrepAlertBanner'
import './prep-board.css'
import { PrepBoardDrawer } from '@/components/prep/board/PrepBoardDrawer'
import { RunSheet } from '@/components/prep/runsheet/RunSheet'
import { RunSheetMobile } from '@/components/prep/runsheet/RunSheetMobile'
import { useNowMinute } from '@/components/prep/runsheet/useNowMinute'
import type { Cook } from '@/components/prep/runsheet/assignee'
import PrepDoneSheet from '@/components/prep/PrepDoneSheet'
import PrepTaskLibrary from '@/components/prep/PrepTaskLibrary'
import PrepTaskList from '@/components/prep/PrepTaskList'
import type { PrepTask, PrepTaskTodayLog, PrepTaskRow, LinkedItemSummary } from '@/components/prep/types'
import PrepDrawer from '@/components/prep/PrepDrawer'
import { RecipeViewModal } from '@/components/prep/RecipeViewModal'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { usePrepToast } from '@/components/prep/PrepToast'
import { computeShiftSummary, computeWorkloadMinutes, formatMinutes, computePriority } from '@/lib/prep-utils'
import { applyStatusToItem, defaultDraftQty, effectivePriority } from '@/lib/prep-plan'
import { prepDayKey } from '@/lib/prep-day'
import { useUser } from '@/contexts/UserContext'
import { atLeast } from '@/lib/roles'
import { PlannerDesktop } from '@/components/prep/planner/PlannerDesktop'
import { PlannerMobile } from '@/components/prep/planner/PlannerMobile'
import type { PlannerHandlers } from '@/components/prep/planner/PlannerDesktop'
import { PostedBand } from '@/components/prep/runsheet/PostedBand'
import type { PrepPostInfo } from '@/components/prep/types'
import type { PrepItemDetail, IngredientAvailability, RecipeStepsData } from '@/components/prep/types'

// Lazy-load conditional components — only mount when user opens them
const PrepItemForm      = dynamic(() => import('@/components/prep/PrepItemForm').then(m => ({ default: m.PrepItemForm })), { ssr: false, loading: () => null })
const PrepSettingsModal = dynamic(() => import('@/components/prep/PrepSettingsModal').then(m => ({ default: m.PrepSettingsModal })), { ssr: false, loading: () => null })

export default function PrepPage() {
  const { setDrawerOpen } = useDrawer()
  const { activeRc, activeRcId, activeKind, activeLocationId, isReadOnly } = useRc()
  const { role, user } = useUser()
  const [items,        setItems]        = useState<PrepItemRich[]>([])
  const [cooks,        setCooks]        = useState<Cook[]>([])
  // Today's posted-list header for the active RC (null = nothing posted yet).
  const [plan,         setPlan]         = useState<{ post: PrepPostInfo | null }>({ post: null })
  const [loading,      setLoading]      = useState(true)
  const [generating,   setGenerating]   = useState(false)
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
  // Mirrors `offlineSyncing` for the 60s interval effect below, which needs to
  // read the current in-flight state without depending on it — putting
  // `offlineSyncing` in that effect's deps would tear the interval down and
  // rebuild it on every sync, which is worse than the stomp it would fix.
  const offlineSyncingRef = useRef(false)
  useEffect(() => { offlineSyncingRef.current = offlineSyncing }, [offlineSyncing])
  const [pendingCount,   setPendingCount]   = useState(0)
  const [cacheAge,       setCacheAge]       = useState<number | null>(null)

  // Redesigned To-do tab — drawer, cook-along modal, toast, alert dismissal
  const { toast, toastNode } = usePrepToast()
  const [drawerItem, setDrawerItem] = useState<PrepItemRich | null>(null)
  // Quick yield prompt from the compact row's "Mark done" (no full drawer).
  const [doneSheetItem, setDoneSheetItem] = useState<PrepItemRich | null>(null)
  const [drawerDetail, setDrawerDetail] = useState<PrepItemDetail | null>(null)
  // The fused drawer's cook-along data (steps + cost, fetched alongside the prep detail).
  const [drawerRecipe, setDrawerRecipe] = useState<RecipeStepsData | null>(null)
  const [drawerRecipeLoading, setDrawerRecipeLoading] = useState(false)
  // Make quantity from the drawer's upscale slider — the single source of the yield that
  // "Done · add X" credits. PrepRecipeSection resets it to the base batch on recipe load.
  const [drawerMakeQty, setDrawerMakeQty] = useState(0)
  // Cache fetched cook-along data per prep item so reopening the drawer is instant.
  const recipeCache = useRef<Map<string, { recipe: RecipeStepsData; ings: IngredientAvailability[] }>>(new Map())
  // Sub-recipe peek (e.g. opening "Custard" linked inside French Toast)
  const [subRecipeView, setSubRecipeView] = useState<{ recipeId: string; name: string } | null>(null)
  const [subRecipeChecked, setSubRecipeChecked] = useState<Set<string>>(new Set())
  const [alertDismissed, setAlertDismissed] = useState(false)

  // Live Pacific-local clock for the desktop run sheet (start-by math + the
  // elapsed timer on a WorkingRow).
  const { nowMs, nowMin } = useNowMinute()

  // View state
  const [viewMode,          setViewMode]          = useState<'today' | 'smartprep' | 'history'>('today')
  const [showMobileFilters, setShowMobileFilters] = useState(false)
  const [showMobileSearch, setShowMobileSearch] = useState(false)

  // Filters (used in Smart Prep and Today)
  const [search,         setSearch]         = useState('')
  const [filterCategory, setFilterCategory] = useState('ALL')
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

  // Serialize status mutations per item. A rapid Start→Done must not race — two
  // PUTs committing out of order would lose the later status — and the follow-up
  // must not be dropped (an earlier "skip if already pending" guard silently ate a
  // Done fired while Start's ~2s write was still in flight, so the item stayed "in
  // progress" while the toast lied "done"). Each op chains after the item's
  // previous in-flight op; the optimistic UI update still applies immediately.
  const opChains = useRef<Map<string, Promise<void>>>(new Map())
  // Bumped on every optimistic local mutation. The /api/prep/items GET is slow
  // (several seconds — it recomputes theoretical stock per item), so a background
  // poll can still be in flight when the user marks an item done. When that stale
  // snapshot resolves it would clobber the optimistic change (e.g. a just-completed
  // item snapping back to "in progress"). A silent load compares this counter before
  // and after its fetch and discards its result if any mutation happened meanwhile.
  const mutationSeq = useRef(0)

  // Set by the MOUNT-time cache paint and consumed by the first non-silent
  // `load` that follows it, so that load does not slam the full-screen spinner
  // over a list the cook is already reading.
  //
  // One-shot on purpose. Latched, it also swallowed the spinner for every LATER
  // non-silent load — and those are user-initiated (flipping "active only",
  // tapping Refresh) against a ~5s /api/prep/items fetch, so the previous list
  // just sat there and the tap read as a no-op. Suppressing the spinner is only
  // ever right when something was painted a moment ago for this exact load.
  const cachePaintedOnMount = useRef(false)

  // ── Prep tasks (checklist) ─────────────────────────────────────────────────
  const [taskLibrary, setTaskLibrary] = useState<PrepTask[]>([])
  const [taskTodayIds, setTaskTodayIds] = useState<Set<string>>(new Set())
  const [inventoryForTasks, setInventoryForTasks] = useState<LinkedItemSummary[]>([])

  // The restaurant's prep day as a bare 'YYYY-MM-DD' (src/lib/prep-day.ts). Sent
  // to the task routes instead of a browser-local midnight ISO, so a tablet on
  // the wrong timezone still writes the day the kitchen is actually working.
  const todayDateStr = useMemo(() => prepDayKey(), [])

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

  // The linked-item picker only lives in the Tasks library on the Smart Prep tab, so
  // defer this full inventory pull until that tab is first opened instead of paying for
  // it on every prep-page mount.
  useEffect(() => {
    if (viewMode !== 'smartprep' || inventoryForTasks.length > 0) return
    fetch('/api/inventory')
      .then(r => r.ok ? r.json() : [])
      .then((items: { id: string; itemName: string }[]) =>
        setInventoryForTasks(items.map(i => ({ id: i.id, itemName: i.itemName }))))
      .catch(() => {})
  }, [viewMode, inventoryForTasks.length])

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
    // Consume the mount-paint suppression — see `cachePaintedOnMount`. Read and
    // cleared only on a non-silent load, so a background poll landing first can
    // never spend it on the user's behalf.
    if (!silent) {
      const skipSpinner = cachePaintedOnMount.current
      cachePaintedOnMount.current = false
      if (!skipSpinner) setLoading(true)
    }
    const seqAtStart = mutationSeq.current
    try {
      const res  = await fetch(`/api/prep/items?active=${activeOnly}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const fetched = Array.isArray(data) ? data : []
      // Discard a stale snapshot: if the user mutated an item while this slow fetch
      // was in flight (poll, mount load, or manual refresh), its data predates that
      // change and applying it would revert the optimistic update — e.g. a
      // just-completed item snapping back to "in progress". The mutation's own write
      // already made the server authoritative; the next quiet load will reconcile.
      // The fetch itself demonstrably succeeded and demonstrably came from the
      // server — both true regardless of whether it's safe to apply `fetched`
      // to state. So these two flip ABOVE the mutation guard: otherwise a
      // mutation landing mid-fetch makes the guard return early below, and
      // `setCacheAge` never clears — the "Showing the saved list" banner then
      // sticks around after a perfectly successful fetch, until some later poll
      // happens to land with no intervening mutation. Only `setItems` /
      // `savePrepCache` stay below the guard, because only those would clobber
      // an optimistic update with stale data. Do not "tidy" these back together.
      setIsOffline(false)
      setCacheAge(null)
      if (mutationSeq.current !== seqAtStart) return
      setItems(fetched)
      savePrepCache(fetched, { fetchedAt: Date.now() })
    } catch (e) {
      // ANY failure falls back to the cache — not just navigator.onLine === false.
      // A flaky signal fails the fetch while the browser still calls itself online,
      // and blanking the list mid-shift is the worst possible answer. The list is
      // never empty because of the network.
      const cached = loadPrepCache()
      if (cached && cached.items.length > 0) {
        // Only fills an empty list — never clobbers what is already on screen
        // (including an optimistic edit made while this fetch was in flight).
        // The check lives in the updater, but nothing is ASSIGNED inside it:
        // a state updater must stay pure or StrictMode's double-invoke makes it lie.
        setItems(prev => (prev.length === 0 ? cached.items : prev))
        setCacheAge(Math.round((Date.now() - cached.ts) / 60000))
      } else if (!silent) {
        setItems([])
      }
      setIsOffline(!navigator.onLine)
      console.error('Failed to load prep items', e)
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

  // Kitchen crew for the run sheet's claim popover / crew strip. Cooks change
  // rarely, so a one-shot load on mount is enough (no polling).
  const loadCooks = useCallback(async () => {
    try {
      const res = await fetch('/api/prep/cooks')
      if (res.ok) {
        const data = await res.json()
        setCooks(Array.isArray(data) ? data : [])
      }
    } catch { /* silent degradation — run sheet still renders without cooks */ }
  }, [])

  // Today's PrepPost header for the active RC — drives the planner footer, the
  // To Do provenance band, and the "unposted changes" pill.
  const loadPlan = useCallback(async () => {
    // No active RC (Location/"All" lens, or the RC context hasn't hydrated yet):
    // there is no RC-scoped post to show locally. Deliberately NOT writing this
    // to the plan cache — that cache is a SINGLE slot keyed by whichever RC last
    // wrote it (see savePlanCache), and `activeRcId` is transiently null on
    // every mount before RevenueCenterContext resolves the persisted selection.
    // Writing `{ post: null, revenueCenterId: null }` here would win that race
    // on nearly every load and permanently blank a real RC's cached header
    // before the cache-first paint effect ever got to read it. Leaving the slot
    // untouched is safe: the paint effect below only matches a cache entry
    // against a REAL active RC id, so a stale entry from a different RC is
    // simply ignored, not misattributed — and it lets the chef switch back to
    // that RC (even offline) and still see its real cached post.
    if (!activeRcId) { setPlan({ post: null }); return }
    try {
      const res = await fetch(`/api/prep/plan?rcId=${encodeURIComponent(activeRcId)}`, { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        setPlan(data)
        savePlanCache(data.post ?? null, activeRcId)
      }
    } catch { /* keep the last known post */ }
  }, [activeRcId])

  useEffect(() => { loadPlan() }, [loadPlan])

  // Chef gate: LEAD+ builds and posts the list; cooks get a read-only planner.
  const canPlan = role != null && atLeast(role, 'LEAD') && !isReadOnly && !!activeRcId

  // Optimistic mirror of the server-side dirty flag: any draft edit after a
  // post means the kitchen is on a stale list until the chef re-posts.
  //
  // Reads `plan` via closure rather than the setState-updater form the flag
  // flip itself uses, specifically so the cache write below happens exactly
  // once per call with the actual next value in hand (writing inside a state
  // updater is a side effect, and React 18 Strict Mode double-invokes updaters
  // in dev — see the `load()` catch branch for the same rule). The trade-off:
  // several `markPlanDirtyLocal()` calls in the same synchronous burst (e.g.
  // `handleAssignStation` looping over items) can each re-write the same
  // already-dirty value to the cache instead of writing once — harmless
  // (idempotent), just a few redundant localStorage writes.
  const markPlanDirtyLocal = useCallback(() => {
    if (!plan.post || plan.post.dirty) return
    // `plan.post` is only ever set while an RC is active, so `activeRcId` should
    // never be null here — but `savePlanCache` writes a single RC-keyed slot, and
    // a null-RC write would silently overwrite (orphan) whatever real RC's header
    // is cached there. Guard the invariant here instead of trusting it three files
    // away.
    if (!activeRcId) return
    const next = { ...plan.post, dirty: true }
    setPlan({ post: next })
    savePlanCache(next, activeRcId)
  }, [plan, activeRcId])

  useEffect(() => {
    setIsOffline(!navigator.onLine)
    setPendingCount(loadQueue().length)
    loadSettings()
    loadCooks()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadSettings, loadCooks])

  // Cache-first paint: the list a cook had a moment ago beats a spinner. The
  // fetch below replaces it as soon as it lands.
  useEffect(() => {
    const cached = loadPrepCache()
    if (cached && cached.items.length > 0) {
      cachePaintedOnMount.current = true
      setItems(cached.items)
      setCacheAge(Math.round((Date.now() - cached.ts) / 60000))
      setLoading(false)
    }
  }, [])

  // Paint the posted-band header from cache too — but only once we know which
  // RC is active, and only when the cached header actually belongs to it.
  // Deliberately depends on `activeRcId` rather than running mount-only ([]):
  // RevenueCenterContext resolves the persisted active RC asynchronously
  // (`activeRcId` starts null on every mount), so a `[]` effect would run
  // before there's anything to match the cache against and could never paint
  // anything. Re-running on every RC change is also a genuine feature, not
  // just a workaround: `loadPlanCache` is a SINGLE slot (see `PLAN_KEY` in
  // src/lib/prep-offline.ts), holding only the most recently loaded RC's
  // header — so switching to a DIFFERENT RC than that one correctly hits the
  // `else` below and blanks, rather than leaving whatever the last RC's post
  // happened to be on screen. It only "repaints" when the RC switched back to
  // is the same one the single slot was last stamped for.
  //
  // The `else` is load-bearing, not tidiness. `loadPlan`'s catch deliberately
  // KEEPS the last known post so a failed refresh doesn't blank a good header —
  // but "last known" is the previous RC's when the chef has just switched
  // centers offline. Without an active clear here, a Cafe band ("Posted list ·
  // 6 items · Chef has unposted changes") sits above Catering's To Do
  // indefinitely: the fetch throws, the catch keeps Cafe's post, and a cache
  // entry stamped for a different RC no-ops. Clearing on a MISMATCH is what
  // makes the RC stamp guard the state carry-over and not just the cache read.
  useEffect(() => {
    if (!activeRcId) return
    const cachedPlan = loadPlanCache()
    if (cachedPlan && cachedPlan.revenueCenterId === activeRcId) {
      setPlan({ post: cachedPlan.post })
    } else {
      setPlan({ post: null })
    }
  }, [activeRcId])

  // Every optimistic mutation reaches the cache, so a reload in a dead zone
  // still shows the chef's draft. `savePrepCache` without `fetchedAt` preserves
  // the last SERVER fetch time, so the age stamp keeps telling the truth.
  useEffect(() => {
    if (items.length === 0) return
    savePrepCache(items)
  }, [items])

  // The single source of the initial prep-items load (and the activeOnly-change reload).
  // Deliberately NOT also called in the effect above — doing so fired a second identical
  // ~5s /api/prep/items request on every mount.
  useEffect(() => { load() }, [load])

  // The fused item drawer handles its own overlay; keep the app chrome's drawer
  // flag off for this page (the old detail panel that used it is gone).
  useEffect(() => () => setDrawerOpen(false), [setDrawerOpen])

  // Online/offline events — auto-sync queue on reconnect
  useEffect(() => {
    const handleOnline = async () => {
      setIsOffline(false)
      const queue = loadQueue()
      if (queue.length > 0) {
        setOfflineSyncing(true)
        const result = await flushQueue()
        setPendingCount(loadQueue().length)
        setOfflineSyncing(false)
        if (result.failed > 0) {
          setActionError(`Synced ${result.synced} change${result.synced !== 1 ? 's' : ''}, but ${result.failed} failed — please refresh.`)
        }
      }
      load()
      // The queue's posts and removals are exactly the mutations that move the
      // PrepPost header, so the band is stale the instant a flush lands. Without
      // this it stayed stale until the 60s interval's own loadPlan — a header
      // reading "6 items" over a list of 4 for up to a minute after reconnect.
      loadPlan()
    }
    const handleOffline = () => setIsOffline(true)
    window.addEventListener('online',  handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online',  handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [load, loadPlan])

  const handleOfflineSync = useCallback(async () => {
    if (isOffline || offlineSyncing) return
    setOfflineSyncing(true)
    const result = await flushQueue()
    setPendingCount(loadQueue().length)
    setOfflineSyncing(false)
    if (result.failed > 0) {
      setActionError(`Synced ${result.synced}, but ${result.failed} change${result.failed !== 1 ? 's' : ''} failed — please refresh.`)
    }
    load()
    loadPlan()   // the flush just moved the header — see handleOnline
  }, [isOffline, offlineSyncing, load, loadPlan])

  // Fetch history logs when History tab is active or date changes
  useEffect(() => {
    if (viewMode !== 'history') return
    setHistoryLoading(true)
    fetch(`/api/prep/logs?date=${historyDate}`)
      .then(r => r.json())
      .then(data => { setHistoryLogs(Array.isArray(data) ? data : []); setHistoryLoading(false) })
      .catch(() => setHistoryLoading(false))
  }, [viewMode, historyDate])

  // Auto-refresh every 60 seconds (paused while offline). Also flushes the
  // offline queue when there's something pending: `flushQueue` previously had
  // only two triggers — the `online` event and the manual "Sync now" button —
  // so a mutation KEPT after a post-reconnect 5xx/401/408/429 (see THE RETRY
  // RULE in prep-offline.ts) would not retry again until the next
  // offline→online transition or a manual tap. `flushQueue` has its own
  // re-entrancy guard, so an overlapping trigger (e.g. a manual "Sync now"
  // mid-interval) is safe. Gated on a non-empty queue so this never fires an
  // empty flush every minute.
  useEffect(() => {
    if (isOffline) return
    const id = setInterval(() => {
      load(true)
      loadPlan()
      // Skip the flush while one is already in flight (e.g. a manual "Sync now").
      // `flushQueue`'s own re-entrancy guard makes an overlap harmless for data,
      // but its `.then` here would still fire immediately with `{0,0,0}` and
      // prematurely clear `offlineSyncing` / write a mid-flight `pendingCount`
      // out from under the real flush's own `.then`. Read via a ref, not
      // `offlineSyncing` state, so this stays out of the effect's deps.
      if (!offlineSyncingRef.current && loadQueue().length > 0) {
        setOfflineSyncing(true)
        flushQueue().then(result => {
          setPendingCount(loadQueue().length)
          setOfflineSyncing(false)
          if (result.failed > 0) {
            setActionError(`Synced ${result.synced} change${result.synced !== 1 ? 's' : ''}, but ${result.failed} failed — please refresh.`)
          }
        })
      }
    }, 60_000)
    return () => clearInterval(id)
  }, [load, loadPlan, isOffline])

  // ── Derived data ──────────────────────────────────────────────────────────

  const categories = useMemo(() => [...new Set(items.map(i => i.category))].sort(), [items])

  // Today tab: the kitchen works off the POSTED list — a draft add reaches To Do
  // only when the chef posts (Smart Prep v2). Work already in flight survives a
  // recall: anything started or completed today stays visible (the cook keeps
  // their timer and Done button even while the chef redrafts).
  const todayItems = useMemo(() =>
    items.filter(i =>
      i.todayLog?.postedAt != null ||
      i.todayLog?.status === 'IN_PROGRESS' ||
      i.todayLog?.status === 'DONE' || i.todayLog?.status === 'PARTIAL'
    ),
  [items])

  // Priority-change alerts: posted items that have escalated to Critical but not started
  const priorityAlerts = useMemo(() =>
    items.filter(i =>
      i.todayLog?.postedAt != null &&
      i.priority === '911' &&
      i.todayLog.status === 'NOT_STARTED'
    ),
  [items])

  // Planner pool — search + category shape the SUGGESTIONS pane; the station
  // chips inside the planner do their own narrowing, and the draft pane always
  // derives from the unfiltered list (a search must never hide draft rows).
  const plannerPool = useMemo(() => {
    return items.filter(item => {
      if (search && !item.name.toLowerCase().includes(search.toLowerCase())) return false
      if (filterCategory !== 'ALL' && item.category !== filterCategory) return false
      return true
    })
  }, [items, search, filterCategory])

  // Tab badges — computed priorities so a completion updates them instantly.
  const spCritical = useMemo(() => items.filter(i => effectivePriority(i) === '911'), [items])
  const spNeeded   = useMemo(() => items.filter(i => effectivePriority(i) === 'NEEDED_TODAY'), [items])

  // Redesigned To-do tab — derived
  const shiftSummary = useMemo(() => computeShiftSummary(todayItems), [todayItems])

  // The single service-status answer — same source the run sheet uses, so the header
  // and run sheet can no longer disagree about what's next. Null when no RC is active
  // ("All"/Location scope) — that's "unknown", NOT "on-demand" (svcStatus.kind === 'none'
  // means "this RC has no services", which only applies to an actual RC).
  // The active RC's configured (active) services — hoisted so the page header and
  // the run sheet consume the exact same array. The run sheet used to derive its own
  // service list from the prep items on the board; it now takes this as a prop.
  const rcServices = useMemo(
    () => (activeRc?.services ?? []) as RcService[],
    [activeRc],
  )

  const svcStatus = useMemo(
    () => activeRc ? serviceStatus(rcServices, nowMin, activeRc.prepLeadMinutes ?? null) : null,
    [activeRc, rcServices, nowMin],
  )

  // The service prep is counting down to — the upcoming one, or the one queued
  // behind a service that's already underway. Null once the day's last service
  // has started (kind 'underway' with no next, 'closed', or 'none').
  const svcNext = useMemo(() => upcomingInfo(svcStatus), [svcStatus])

  // Prep countdown (minutes-to-service + start-by clock) derived from svcStatus.
  // Consumed by PrepShiftBand + PrepDrawer; null unless a service is still ahead.
  const countdown = useMemo(() => {
    if (!svcNext) return null
    const m = svcNext.prepByMin
    return {
      serviceLabel: fmtDuration(svcNext.minsUntil * 60_000),
      minsToService: svcNext.minsUntil,
      startByHHMM: m == null ? '' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`,
    }
  }, [svcNext])

  // Compact prep-deadline label for the mobile header subtitle. No active RC → render
  // nothing (not "on-demand" — that's only true once we actually know the RC's schedule).
  // 'closed' (services configured, day's services over) also renders nothing.
  //
  // `underway` used to fall through to the `!svcNext` null-return below whenever the
  // underway service had no next one queued — so at noon under a single-Brunch config,
  // desktop's svcHeaderNode said "Brunch service underway" while mobile said nothing.
  // Routing `underway` (and `none`) through formatServiceStatus — the same function
  // svcHeaderNode uses — makes that divergence structurally impossible now.
  const prepBy = useMemo(() => {
    if (!activeRc || !svcStatus) return null
    if (svcStatus.kind === 'none') {
      const formatted = formatServiceStatus(svcStatus)
      const lead = activeRc.prepLeadMinutes != null ? fmtDuration(activeRc.prepLeadMinutes * 60_000) : null
      return { kind: 'onDemand' as const, text: formatted?.lead ?? 'on-demand', lead }
    }
    if (svcStatus.kind === 'underway') {
      const formatted = formatServiceStatus(svcStatus)
      if (!formatted) return null
      return { kind: 'underway' as const, lead: formatted.lead, trail: formatted.trail }
    }
    if (svcStatus.kind === 'closed') return null
    if (svcStatus.kind === 'upcoming') {
      if (!svcNext || svcNext.prepByMin == null) return null
      const m = svcNext.prepByMin
      const dl = new Date(); dl.setHours(Math.floor(m / 60), m % 60, 0, 0)
      return {
        kind: 'deadline' as const,
        time: dl.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
        left: fmtDuration(Math.max(0, m - nowMin) * 60_000),
      }
    }
    const _never: never = svcStatus
    return _never
  }, [svcStatus, svcNext, activeRc, nowMin])

  // Desktop header's service clause — computed once so the JSX doesn't need to
  // guard `activeRc`/`svcStatus` null-ness inline (mirrors /pass's `serviceClause`).
  // Text comes from service-hours.ts's formatServiceStatus — the same function
  // mobile's `prepBy` now calls — so this can no longer disagree with mobile.
  const svcHeaderNode = useMemo<React.ReactNode>(() => {
    if (!svcStatus) return null
    if (svcStatus.kind === 'upcoming' || svcStatus.kind === 'underway' || svcStatus.kind === 'closed' || svcStatus.kind === 'none') {
      const formatted = formatServiceStatus(svcStatus)
      if (!formatted) return null
      return <>
        {' · '}<b className="text-ink font-medium">{formatted.lead}</b>
        {formatted.trail && <>{' · '}<b className="text-ink font-medium">{formatted.trail}</b></>}
      </>
    }
    const _never: never = svcStatus
    return _never
  }, [svcStatus])
  const workloadLabel = useMemo(() => '~' + formatMinutes(computeWorkloadMinutes(todayItems)), [todayItems])

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleRefresh = async () => {
    setGenerating(true)
    try { await load() }
    catch { setActionError('Refresh failed — check your connection and try again.') }
    finally { setGenerating(false) }
  }


  async function handleStatusChange(itemId: string, newStatus: string, actualQty?: number) {
    const item = items.find(i => i.id === itemId)
    if (!item) return
    // Recording a prep log is a stock movement — it needs a concrete revenue center.
    // The API resolves prepItem.revenueCenterId ?? body.revenueCenterId, so only block
    // when the item carries no RC of its own AND no concrete RC is active ("All" view).
    if (!item.revenueCenterId && !activeRcId) {
      setActionError('Select a revenue center (not "All") to record prep.')
      return
    }
    mutationSeq.current++

    const now = new Date().toISOString()
    const completingNow = newStatus === 'DONE' || newStatus === 'PARTIAL'
    // Mirror the server's status→isOnList rule optimistically: completing/removing
    // clears the item from the list, starting/resetting re-arms it.
    const nextOnList = newStatus === 'NOT_STARTED' || newStatus === 'IN_PROGRESS'
    setItems(prev => prev.map(i => {
      if (i.id !== itemId) return i
      const existingLog = i.todayLog
      // Recompute onHand/priority/suggestedQty BEFORE swapping the log in:
      // applyStatusToItem reads the OLD todayLog to know what a re-log or a
      // reopen must un-credit. Without this, a completed item dropped back to
      // Smart Prep still wearing its pre-completion Critical pill until the
      // next (often discarded) background poll.
      const recomputed = applyStatusToItem(i, newStatus, actualQty)
      return {
        ...recomputed,
        isOnList: nextOnList,
        todayLog: existingLog
          ? { ...existingLog, status: newStatus as PrepLogData['status'], ...(actualQty !== undefined ? { actualPrepQty: actualQty } : {}) }
          : {
              id: `_opt_${itemId}`,
              prepItemId: itemId,
              logDate: todayDateStr,
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
              startedAt: null,
              completedAt: null,
              listOrder: null,
              postedAt: null,
            },
      }
    }))
    markSaving(itemId, true)

    if (!navigator.onLine) {
      enqueueMutation({ type: 'status', itemId, logId: item.todayLog?.id ?? null, status: newStatus, actualQty, revenueCenterId: item.revenueCenterId ?? activeRcId })
      setPendingCount(n => n + 1)
      markSaving(itemId, false)
      return
    }

    // Queue the network write behind any op already in flight for this item so
    // their PUTs commit in click order. The POST is an upsert on (prepItem, day),
    // so a redundant create from a stale `_opt_` id just returns the existing log.
    const prevOp = opChains.current.get(itemId) ?? Promise.resolve()
    const runOp = prevOp.catch(() => {}).then(async () => {
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
      }
    })
    opChains.current.set(itemId, runOp)
    // Only the last-queued op releases the chain slot and clears the saving flag.
    runOp.finally(() => {
      if (opChains.current.get(itemId) === runOp) {
        opChains.current.delete(itemId)
        markSaving(itemId, false)
      }
    })
    return runOp
  }

  // Assign (or unassign) a cook to a prep item from the run sheet's claim popover.
  // Mirrors handleStatusChange's log-ensure + per-item op chaining: create the day's
  // PrepLog if there isn't one yet, then PUT the assignment. The assignee chip
  // updates optimistically off the local `cooks` roster.
  async function handleClaim(item: PrepItemRich, cookId: string | null) {
    // No crew set up yet → the claim pill has nobody to assign, so both the desktop
    // popover (only an UNASSIGN row) and the mobile tap (cookId resolves to null)
    // would silently do nothing. Tell the user where to add cooks instead of no-op.
    if (cooks.length === 0) {
      setActionError('No kitchen crew yet — add cooks in Setup → People to assign prep.')
      return
    }
    // Assigning writes a PrepLog (a stock-scoped row) — needs a concrete RC.
    if (!item.revenueCenterId && !activeRcId) {
      setActionError('Select a revenue center (not "All") to assign a cook.')
      return
    }
    mutationSeq.current++

    const c = cookId ? cooks.find(x => x.id === cookId) ?? null : null
    const assignedCook = c ? { id: c.id, initials: c.initials, name: c.name, homeStation: c.homeStation } : null
    // Mirror handleStatusChange's log-seed: without a todayLog to patch, the
    // post-POST id patch-back below (`i.todayLog ? ... : i`) is a no-op, so an
    // item with no prior log never mirrors its new log id locally and re-POSTs
    // on every subsequent claim/status change until the next poll.
    const now = new Date().toISOString()
    setItems(prev => prev.map(i => {
      if (i.id !== item.id) return i
      const existingLog = i.todayLog
      return {
        ...i,
        assignedCook,
        todayLog: existingLog
          ? { ...existingLog, assignedTo: cookId }
          : {
              id: `_opt_${item.id}`,
              prepItemId: item.id,
              logDate: todayDateStr,
              status: 'NOT_STARTED',
              requiredQty: null,
              actualPrepQty: null,
              assignedTo: cookId,
              dueTime: null,
              note: null,
              blockedReason: null,
              inventoryAdjusted: false,
              createdAt: now,
              updatedAt: now,
              startedAt: null,
              completedAt: null,
              listOrder: null,
              postedAt: null,
            },
      }
    }))
    markSaving(item.id, true)

    if (!navigator.onLine) {
      // Claims aren't part of the offline mutation queue — best-effort online only.
      markSaving(item.id, false)
      return
    }

    const prevOp = opChains.current.get(item.id) ?? Promise.resolve()
    const runOp = prevOp.catch(() => {}).then(async () => {
      try {
        let logId = item.todayLog?.id
        if (!logId || logId.startsWith('_opt_')) {
          const log = await fetch('/api/prep/logs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prepItemId: item.id, revenueCenterId: item.revenueCenterId ?? activeRcId }),
          }).then(r => r.json())
          logId = log.id
          setItems(prev => prev.map(i => (i.id === item.id && i.todayLog ? { ...i, todayLog: { ...i.todayLog, id: log.id } } : i)))
        }
        await fetch(`/api/prep/logs/${logId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assignedTo: cookId }),
        })
      } catch {
        setActionError('Assign failed — try again.')
        load()
      }
    })
    opChains.current.set(item.id, runOp)
    runOp.finally(() => {
      if (opChains.current.get(item.id) === runOp) {
        opChains.current.delete(item.id)
        markSaving(item.id, false)
      }
    })
    return runOp
  }

  async function handlePriorityChange(itemId: string, priority: string) {
    mutationSeq.current++
    setItems(prev => prev.map(item => {
      if (item.id !== itemId) return item
      const override = priority || null
      return {
        ...item,
        manualPriorityOverride: override,
        // Recompute the collapsed 3-level priority from the (urgency) override —
        // computePriority normalizes both vocabularies — so every legacy pill and
        // sort re-derives instantly without a ~5s /api/prep/items reload.
        priority: computePriority(item.onHand, item.parLevel, item.minThreshold, item.targetToday, override),
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
    } catch {
      setActionError('Priority update failed — try again.')
      load()
    } finally {
      markSaving(itemId, false)
    }
  }

  async function handleDelete(itemId: string) {
    mutationSeq.current++
    try {
      setItems(prev => prev.filter(i => i.id !== itemId))
      await fetch(`/api/prep/items/${itemId}`, { method: 'DELETE' })
      // No reload — the optimistic filter already removed the row; a full ~5s
      // /api/prep/items refetch here just re-rendered the list a few seconds later.
    } catch {
      setActionError('Delete failed — try again.')
      load()
    }
  }

  // Toggle isOnList: add to list (true) or remove from list (false)
  async function handleToggleOnList(itemId: string, newValue: boolean) {
    // Optimistic update
    mutationSeq.current++
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
      // Removing simply takes the item off today's list (isOnList=false) — it drops
      // back to Smart Prep, still re-addable. No SKIPPED log: "removed" is not "skipped".
      await fetch(`/api/prep/items/${itemId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isOnList: newValue }),
      })
    } catch {
      setActionError('Could not update list — try again.')
      load()
    } finally {
      markSaving(itemId, false)
    }
  }

  // Take one item straight off the kitchen's To Do — no Smart Prep round trip,
  // no inventory write. `restore` is the Undo. The optimistic patch mirrors what
  // the route does: postedAt cleared (that is what todayItems filters on — see
  // `todayItems`) AND isOnList false. The Undo re-stamps postedAt and puts back
  // whatever isOnList actually WAS, which the caller carries — see below.
  async function handleRemoveFromToDo(
    item: PrepItemRich,
    restore = false,
    headerWasAdjusted?: boolean,
    priorIsOnList?: boolean,
  ) {
    const rcId = item.revenueCenterId ?? activeRcId
    if (!rcId) { setActionError('Select a revenue center (not "All") to change the list.'); return }

    // `isOnList` is the Smart Prep DRAFT flag, NOT "is on the kitchen's To Do"
    // (that is `todayLog.postedAt`). They diverge: post the list, then take the
    // item off the draft, and it stays posted with `isOnList` already false. So
    // an Undo cannot assert `true` — it has to put back whatever was there.
    // Threaded, not recomputed, for the same reason `headerWasAdjusted` is: the
    // Undo runs from a closure frozen at removal time (see the note below), so
    // it is TOLD the prior value rather than reading anything at click time.
    // Captured before the patch below, which is what overwrites it.
    const wasOnList = item.isOnList
    const nextIsOnList = restore ? priorIsOnList ?? true : false

    mutationSeq.current++
    const stamp = restore ? new Date().toISOString() : null
    setItems(prev => prev.map(i => (
      i.id === item.id
        ? {
            ...i,
            isOnList: nextIsOnList,
            todayLog: i.todayLog ? { ...i.todayLog, postedAt: stamp } : i.todayLog,
          }
        : i
    )))

    if (!navigator.onLine) {
      // `isOnList` rides along so the flush sends the same draft flag the online
      // path does — the route defaults an omitted one to `true`, which is wrong
      // for an item that was posted but already off the draft.
      enqueueMutation({ type: 'remove_item', itemId: item.id, revenueCenterId: rcId, restore, isOnList: nextIsOnList })
      setPendingCount(n => n + 1)
      // Move the posted band with the row, or it contradicts the list under it:
      // post 6 items offline, × two rows, and the synthetic header goes on
      // reading "6 items · 2h 10m" over a To Do that now holds 4 — for as long
      // as the chef stays offline, since nothing recomputes it until the queue
      // flushes. `remove-item/route.ts` goes to real trouble to keep that header
      // honest; the offline path used to bypass all of it.
      //
      // Mirrors the route's idempotence, but NOT by re-running the route's own
      // check on each call: `usePrepToast` stores this call's `onClick` verbatim
      // and invokes it later without re-reading anything (src/components/prep/
      // PrepToast.tsx:35), so the Undo call runs inside a CLOSURE frozen at
      // removal time — `item` is never mutated (setItems above builds a new
      // object) and `plan` is whatever this render saw, not what's on screen
      // when the chef actually taps Undo. Recomputing "was it posted" from
      // either of those on the Undo call reads stale data (worse: `item`'s
      // postedAt is unchanged, so the restore gate would evaluate as if nothing
      // had happened, and never re-credit the header).
      //
      // So only the REMOVAL direction computes the gate from source (the item's
      // real state right now); Undo doesn't recompute anything, it's told
      // explicitly what removal did and reverses exactly that — "adjust the
      // header" and "un-adjust the header" are then provably the same amount.
      // The arithmetic itself uses the functional setPlan form so it always
      // applies against the live header, not the one this closure was born
      // with.
      const didAdjust = restore ? !!headerWasAdjusted : !!item.todayLog?.postedAt
      if (didAdjust && activeRcId) {
        // The same expression the routes sum — `resolveActive(i) ?? estimatedPrepTime ?? 0`.
        // `item.activeMinutes` IS the resolved value; /api/prep/items runs
        // `resolveActive` before serializing the row.
        const minutes = item.activeMinutes ?? item.estimatedPrepTime ?? 0
        const delta = restore ? 1 : -1
        setPlan(prev => {
          if (!prev.post) return prev
          const nextPost: PrepPostInfo = {
            ...prev.post,
            itemCount:     Math.max(0, prev.post.itemCount + delta),
            activeMinutes: Math.max(0, prev.post.activeMinutes + delta * minutes),
          }
          savePlanCache(nextPost, activeRcId)
          return { post: nextPost }
        })
      }
      if (!restore) {
        toast(`${item.name} removed`, { label: 'Undo', onClick: () => { handleRemoveFromToDo(item, true, didAdjust, wasOnList) } })
      }
      return
    }

    try {
      const res = await fetch('/api/prep/plan/remove-item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // `isOnList` is restore-only: the removal path always clears the draft
        // flag, so sending it there would just be noise.
        body: JSON.stringify({
          revenueCenterId: rcId, prepItemId: item.id, restore,
          ...(restore ? { isOnList: nextIsOnList } : {}),
        }),
      })
      if (!res.ok) {
        // The server's `error` field is written for users (e.g. "already removed by
        // someone else") — surface it verbatim. Anything else reaching this branch
        // (a non-JSON error body) is not user copy, so fall back to a plain sentence
        // rather than whatever the parse failure says.
        let message = 'Could not update the list — try again.'
        try { const body = await res.json(); if (body?.error) message = body.error } catch { /* non-JSON error body */ }
        setActionError(message)
        load()
        return
      }
      if (!restore) {
        toast(`${item.name} removed`, { label: 'Undo', onClick: () => { handleRemoveFromToDo(item, true, undefined, wasOnList) } })
      } else {
        // RESTORE direction only: the optimistic patch above only restamps an
        // EXISTING todayLog's postedAt — it does nothing for a carried (pre-today)
        // job whose todayLog was already nulled out. isLiveLog (src/lib/prep-plan.ts)
        // keeps a pre-today log only while postedAt != null, so once removed, any
        // load() landing before Undo is clicked (the 60s poll, the Refresh button,
        // the activeOnly toggle, or another handler's error-path load()) returns
        // todayLog: null for it — the row would stay missing from the To Do until
        // the next poll even though the server-side restore succeeded. Reconcile
        // from the server. `true` = silent background reload — no full-screen
        // loading state over a list the cook is actively reading.
        //
        // The removal direction doesn't need this: every row on the To Do already
        // has a todayLog, so patching its postedAt to null is always sufficient.
        load(true)
      }
      loadPlan()
    } catch {
      // Network failure (offline) or an unparseable response — not user copy,
      // so don't surface the raw exception text (e.g. "TypeError: Failed to fetch").
      setActionError('Could not update the list — try again.')
      load()
    }
  }

  // ── Smart Prep v2 planner handlers ────────────────────────────────────────

  // Seed for an optimistic todayLog created by a draft edit (no log yet).
  const seedLog = (item: PrepItemRich, patch: Partial<PrepLogData>): PrepLogData => {
    const now = new Date().toISOString()
    return {
      id: `_opt_${item.id}`,
      prepItemId: item.id,
      logDate: todayDateStr,
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
      startedAt: null,
      completedAt: null,
      listOrder: null,
      postedAt: null,
      ...patch,
    }
  }

  // Persist a draft-field edit (planned qty / note / assignee / order) onto
  // today's log — ensure-log + PUT, op-chained per item like handleClaim.
  function handleDraftEdit(item: PrepItemRich, patch: { requiredQty?: number; note?: string; assignedTo?: string | null; listOrder?: number }) {
    if (!item.revenueCenterId && !activeRcId) {
      setActionError('Select a revenue center (not "All") to edit the prep list.')
      return
    }
    mutationSeq.current++
    setItems(prev => prev.map(i => {
      if (i.id !== item.id) return i
      return {
        ...i,
        todayLog: i.todayLog ? { ...i.todayLog, ...patch } : seedLog(i, patch as Partial<PrepLogData>),
      }
    }))
    markPlanDirtyLocal()
    markSaving(item.id, true)

    // Offline, the edit queues and replays on reconnect. The optimistic patch
    // above is already in `items`, and the items-cache effect persists it, so it
    // also survives a reload in a dead zone.
    if (!navigator.onLine) {
      enqueueMutation({
        type: 'draft_edit',
        itemId: item.id,
        logId: item.todayLog?.id ?? null,
        revenueCenterId: item.revenueCenterId ?? activeRcId,
        patch,
      })
      setPendingCount(n => n + 1)
      markSaving(item.id, false)
      return
    }

    const prevOp = opChains.current.get(item.id) ?? Promise.resolve()
    const runOp = prevOp.catch(() => {}).then(async () => {
      try {
        const logId = item.todayLog?.id
        if (!logId || logId.startsWith('_opt_')) {
          // POST is an upsert on (prepItem, day) and takes the draft fields directly.
          const log = await fetch('/api/prep/logs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prepItemId: item.id, revenueCenterId: item.revenueCenterId ?? activeRcId, ...patch }),
          }).then(r => r.json())
          setItems(prev => prev.map(i => (i.id === item.id && i.todayLog ? { ...i, todayLog: { ...i.todayLog, id: log.id } } : i)))
        } else {
          await fetch(`/api/prep/logs/${logId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
          })
        }
      } catch {
        setActionError('Update failed — try again.')
        load()
      }
    })
    opChains.current.set(item.id, runOp)
    runOp.finally(() => {
      if (opChains.current.get(item.id) === runOp) {
        opChains.current.delete(item.id)
        markSaving(item.id, false)
      }
    })
    return runOp
  }

  // Add to the draft, seeding the planned qty with the (batch-aware) suggestion.
  function handleAddToDraft(item: PrepItemRich) {
    handleToggleOnList(item.id, true)
    const hasQty = item.todayLog?.requiredQty != null && Number(item.todayLog.requiredQty) > 0
    const sugg = defaultDraftQty(item)
    if (!hasQty && sugg > 0) handleDraftEdit(item, { requiredQty: sugg })
  }

  function handleAddAllCritical() {
    items.filter(i => effectivePriority(i) === '911' && !i.isOnList).forEach(handleAddToDraft)
  }

  function handleAcceptSuggested() {
    for (const i of items) {
      if (!i.isOnList) continue
      const sugg = defaultDraftQty(i)
      if (sugg > 0 && Math.abs(Number(i.todayLog?.requiredQty ?? 0) - sugg) > 0.01) {
        handleDraftEdit(i, { requiredQty: sugg })
      }
    }
  }

  async function handleClearDraft() {
    const targets = items.filter(i => i.isOnList)
    if (targets.length === 0) return
    mutationSeq.current++
    setItems(prev => prev.map(i => (i.isOnList ? { ...i, isOnList: false } : i)))
    markPlanDirtyLocal()
    await Promise.all(targets.map(i =>
      fetch(`/api/prep/items/${i.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isOnList: false }),
      })
    ))
  }

  function handleAssignStation(station: string, cookId: string) {
    items.filter(i => i.isOnList && i.station === station).forEach(i => handleDraftEdit(i, { assignedTo: cookId }))
  }

  async function handleReorder(orders: Array<{ prepItemId: string; listOrder: number }>) {
    if (!activeRcId) return
    mutationSeq.current++
    const orderMap = new Map(orders.map(o => [o.prepItemId, o.listOrder]))
    setItems(prev => prev.map(i => {
      const lo = orderMap.get(i.id)
      if (lo === undefined) return i
      return { ...i, todayLog: i.todayLog ? { ...i.todayLog, listOrder: lo } : seedLog(i, { listOrder: lo }) }
    }))
    markPlanDirtyLocal()
    try {
      await fetch('/api/prep/plan/reorder', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revenueCenterId: activeRcId, orders }),
      })
    } catch {
      setActionError('Reorder failed — try again.')
      load()
    }
  }

  // Post the draft: the kitchen's To Do switches to exactly what's on the list.
  async function handlePost() {
    if (!activeRcId) { setActionError('Select a revenue center (not "All") to post the list.'); return }

    // Offline: stamp the post locally and queue it. The queued draft edits that
    // preceded this flush FIRST (deduplicateQueue preserves order), so the
    // server builds the post from the chef's own numbers.
    //
    // Known and accepted: a post queued at 06:00 and replayed at 14:00 posts a
    // list whose quantities are the chef's, but whose stock evidence is as old
    // as the queue.
    if (!navigator.onLine) {
      const stamp = new Date().toISOString()
      const drafted = items.filter(i => i.isOnList)
      mutationSeq.current++
      setItems(prev => prev.map(i => {
        if (i.isOnList) return { ...i, todayLog: i.todayLog ? { ...i.todayLog, postedAt: stamp } : seedLog(i, { postedAt: stamp }) }
        if (i.todayLog?.postedAt) return { ...i, todayLog: { ...i.todayLog, postedAt: null } }
        return i
      }))
      const localPost: PrepPostInfo = {
        id: `_opt_post_${activeRcId}`,
        postedAt: stamp,
        postedByName: user?.name ?? user?.email ?? 'Chef',
        itemCount: drafted.length,
        // Same sum RunSheet's `handsOn` shows. Deliberately NOT
        // computeWorkloadMinutes — that sums estimatedPrepTime, while the post
        // route sums `resolveActive(d) ?? d.estimatedPrepTime ?? 0`. This header
        // is a local stand-in either way: the server's real one replaces it on
        // the next loadPlan after the queue flushes.
        activeMinutes: drafted.reduce((a, i) => a + (i.activeMinutes ?? 0), 0),
        dirty: false,
        listDate: `${prepDayKey()}T00:00:00.000Z`,
      }
      setPlan({ post: localPost })
      savePlanCache(localPost, activeRcId)
      enqueueMutation({ type: 'post', itemId: '', revenueCenterId: activeRcId })
      setPendingCount(n => n + 1)
      toast('Posted — will sync when back online')
      return
    }
    try {
      const res = await fetch('/api/prep/plan/post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revenueCenterId: activeRcId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Post failed — try again.')
      setPlan({ post: data.post })
      savePlanCache(data.post, activeRcId)
      // Stamp postedAt locally so the To Do fills without waiting for a reload.
      mutationSeq.current++
      const stamp: string = data.post.postedAt
      setItems(prev => prev.map(i => {
        if (i.isOnList) return { ...i, todayLog: i.todayLog ? { ...i.todayLog, postedAt: stamp } : seedLog(i, { postedAt: stamp }) }
        if (i.todayLog?.postedAt) return { ...i, todayLog: { ...i.todayLog, postedAt: null } }
        return i
      }))
      toast('Posted to To Do')
      load(true)
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Post failed — try again.')
    }
  }

  async function handleRecall() {
    if (!activeRcId) return
    try {
      const res = await fetch('/api/prep/plan/recall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revenueCenterId: activeRcId }),
      })
      if (!res.ok) throw new Error((await res.json()).error || 'Recall failed — try again.')
      setPlan({ post: null })
      savePlanCache(null, activeRcId)
      mutationSeq.current++
      setItems(prev => prev.map(i => (i.todayLog?.postedAt ? { ...i, todayLog: { ...i.todayLog, postedAt: null } } : i)))
      toast('Recalled to draft')
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Recall failed — try again.')
    }
  }

  // One bundle for both planner renderers (desktop split view + mobile tabs).
  const plannerHandlers: PlannerHandlers = {
    // Arrow wrapper — `openDrawer` is a const declared later in this component;
    // naming it directly here would hit the temporal dead zone during render.
    onOpen: (item) => openDrawer(item),
    onAdd: handleAddToDraft,
    onRemove: (item) => handleToggleOnList(item.id, false),
    onQty: (item, qty) => handleDraftEdit(item, { requiredQty: qty }),
    onNote: (item, note) => handleDraftEdit(item, { note }),
    onAssign: (item, cookId) => handleDraftEdit(item, { assignedTo: cookId }),
    onAssignStation: handleAssignStation,
    onPriorityChange: handlePriorityChange,
    onReorder: handleReorder,
    onAcceptSuggested: handleAcceptSuggested,
    onAddAllCritical: handleAddAllCritical,
    onClearDraft: handleClearDraft,
    onPost: handlePost,
    onRecall: handleRecall,
  }

  // ── Redesigned To-do tab — drawer / cook-along / adapter handlers ──────────

  // Drawer open: set the item, then fetch BOTH its prep detail (ingredients + counts) and
  // its linked recipe (steps + cost) so the embedded cook-along has everything. Header +
  // stock paint instantly from the item; the recipe section shows skeletons until this lands.
  // Reuses recipeCache for instant paint on reopen (still refetches to catch availability/cost drift).
  const openDrawer = useCallback(async (item: PrepItemRich) => {
    setDrawerItem(item)
    setDrawerDetail(null)
    setDrawerMakeQty(item.suggestedQty)

    if (!item.linkedRecipeId) {
      setDrawerRecipe(null)
      setDrawerRecipeLoading(false)
      try {
        const res = await fetch(`/api/prep/items/${item.id}`)
        if (res.ok) setDrawerDetail(await res.json())
      } catch { /* leave detail null → drawer shows loading */ }
      return
    }

    // Instant paint from cache (or a partial header built from the item), then refetch.
    const cached = recipeCache.current.get(item.id)
    setDrawerRecipe(cached?.recipe ?? {
      id: item.linkedRecipeId,
      name: item.linkedRecipe?.name ?? item.name,
      steps: [],
      baseYieldQty: Number(item.linkedRecipe?.baseYieldQty) || 0,
      yieldUnit: item.linkedRecipe?.yieldUnit ?? item.unit,
      totalCost: 0,
      baseIngredientId: null,
    })
    setDrawerRecipeLoading(!cached)
    try {
      const [rRes, dRes] = await Promise.all([
        fetch(`/api/recipes/${item.linkedRecipeId}`),
        fetch(`/api/prep/items/${item.id}`),
      ])
      const r = rRes.ok ? await rRes.json() : null
      const d: PrepItemDetail | null = dRes.ok ? await dRes.json() : null
      if (d) setDrawerDetail(d)
      if (!r) { setDrawerRecipeLoading(false); return }
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
        baseIngredientId: r.baseIngredientId ?? null,
      }
      recipeCache.current.set(item.id, { recipe, ings: d?.ingredients ?? [] })
      setDrawerRecipe(recipe)
      setDrawerRecipeLoading(false)
    } catch {
      setDrawerRecipeLoading(false)
    }
  }, [])

  const closeDrawer = useCallback(() => {
    setDrawerItem(null); setDrawerDetail(null); setDrawerRecipe(null); setDrawerRecipeLoading(false)
  }, [])

  // Adapter: new components call onStatusChange(item, status, qty); existing handler takes (itemId, status, qty)
  // NOT memoized: must use the current handleStatusChange closure (which reads
  // current `items`). useCallback([]) here froze the first-render closure where
  // items was [], so every status action early-returned on `items.find` → no-op.
  const onRowStatusChange = (item: PrepItemRich, status: string, qty?: number) => {
    handleStatusChange(item.id, status, qty)
  }

  // Complete the drawer's prep at the upscale slider's yield (drawerMakeQty). Unifies the
  // former modal's "Done · add X" with the drawer's completion: qty ≥ suggested → DONE,
  // else PARTIAL (same rule as the old numeric prompt). Credits inventory + deducts ingredients.
  //
  // NOT memoized — same trap as onRowStatusChange above: it calls handleStatusChange, which
  // reads the current `items`. The previous useCallback([toast]) froze the FIRST-render
  // closure (items === []), so `items.find` returned undefined and every "Done · add X"
  // early-returned — the drawer completion silently did nothing.
  const onDrawerComplete = (item: PrepItemRich, qty: number) => {
    if (!qty || qty <= 0) return
    const status = qty >= item.suggestedQty ? 'DONE' : 'PARTIAL'
    handleStatusChange(item.id, status, qty)
    toast(`${status === 'DONE' ? 'Done' : 'Partial'} · added ${qty} ${item.unit}`)
  }

  // Keep the open drawer's item in sync across the auto-refresh poll
  useEffect(() => {
    if (!drawerItem) return
    const fresh = items.find(i => i.id === drawerItem.id)
    if (fresh && fresh !== drawerItem) setDrawerItem(fresh)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items])

  // ── Render helpers ────────────────────────────────────────────────────────

  const selCls = 'border border-line rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gold'
  const activeFilterCount = [filterCategory !== 'ALL'].filter(Boolean).length

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
                  {prepBy.kind === 'onDemand' ? (
                    <span className="text-ink-3">{prepBy.text}{prepBy.lead ? ` · lead ${prepBy.lead}` : ''}</span>
                  ) : prepBy.kind === 'underway' ? (
                    <span className="inline-flex items-center gap-1 text-gold-2 font-medium">
                      {prepBy.lead}{prepBy.trail ? ` · ${prepBy.trail}` : ''}
                    </span>
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

        {/* Smart Prep toolbar — collapsible search/filter (mobile only) */}
        {viewMode === 'smartprep' && (
          <div className="mt-3 space-y-2">
            <div className="flex items-center justify-end gap-2">
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
              {svcHeaderNode}
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

      {(isOffline || pendingCount > 0 || cacheAge !== null) && (
        <div className={`flex items-center justify-between gap-3 px-4 py-2.5 rounded-xl text-sm border ${
          isOffline ? 'bg-gold-soft border-gold-soft text-gold-2' : 'bg-gold/10 border-gold/30 text-blue-text'
        }`}>
          <div className="flex items-center gap-2 min-w-0">
            <WifiOff size={14} className="shrink-0" />
            <span className="truncate">
              {offlineSyncing
                ? 'Syncing changes…'
                : isOffline
                  ? `Offline${cacheAge !== null ? ` — data from ${cacheAge < 1 ? 'just now' : `${cacheAge}m ago`}` : ''}`
                  : cacheAge !== null
                    // Online by the browser's reckoning, but the fetch did not land.
                    ? `Showing the saved list — data from ${cacheAge < 1 ? 'just now' : `${cacheAge}m ago`}`
                    : 'Back online'}
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
          DESKTOP TODAY — prep run sheet (Task 13). Replaces the old
          desktop To Do board; Smart Prep + history keep their boards below.
      ══════════════════════════════════════════════════════ */}
      {viewMode === 'today' && (
        <div className="pb hidden md:block" style={{ containerType: 'inline-size' }}>
          {priorityAlerts.length > 0 && !alertDismissed && (
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
          {/* Prep tasks (checklist) — desktop Today. Task 13 replaced the shared
              PrepBoard (whose tasksSlot carried this) with RunSheet, which has no
              task slot of its own; restore the same conditional PrepTaskList the
              board used for the 'today' view. Rendered ABOVE the run sheet so the
              quick checklist reads first (the board put its tasks slot at the top). */}
          {!loading && activeTaskRows.length > 0 && (
            <div className="mb-3.5">
              <PrepTaskList asBlock rows={activeTaskRows} onDone={clearTaskToday} onRemove={clearTaskToday} />
            </div>
          )}
          {loading ? (
            <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gold" /></div>
          ) : todayItems.length === 0 && activeRcId ? (
            /* Nothing live to work on — the To Do stays empty until the chef posts.
               The old test also required `!plan.post`, but a post now stays live
               across days, so an old header would have suppressed this prompt
               forever once everything on it was done. */
            <div className="h-[420px] rounded-[14px] border-2 border-dashed border-line-2 bg-paper/50 flex flex-col items-center justify-center gap-2.5">
              <Lock size={26} className="text-ink-4" />
              <div className="text-[15px] font-semibold text-ink-2">Nothing posted yet</div>
              <div className="font-mono text-[11px] text-ink-4 tracking-[0.04em]">THE KITCHEN&apos;S TO DO STAYS EMPTY UNTIL THE CHEF POSTS THE LIST</div>
              {canPlan && (
                <button onClick={() => setViewMode('smartprep')}
                  className="mt-2 inline-flex items-center gap-2 bg-ink text-paper rounded-[10px] px-4 py-2.5 text-[13px] font-semibold">
                  <span className="text-gold font-semibold">→</span> Build the list in Smart prep
                </button>
              )}
            </div>
          ) : (
            <>
            {plan.post && activeRcId && <PostedBand post={plan.post} />}
            <RunSheet
              items={todayItems}
              cooks={cooks}
              services={rcServices}
              leadMinutes={activeRc?.prepLeadMinutes ?? null}
              nowMin={nowMin}
              nowMs={nowMs}
              onOpenRecipe={openDrawer}
              onStart={(item) => onRowStatusChange(item, 'IN_PROGRESS')}
              onReopen={(item) => onRowStatusChange(item, 'IN_PROGRESS')}
              onLog={setDoneSheetItem}
              onStop={(item) => onRowStatusChange(item, 'NOT_STARTED')}
              onClaim={handleClaim}
              onRemove={canPlan ? (item) => handleRemoveFromToDo(item) : undefined}
            />
            </>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          DESKTOP PLANNER — Smart Prep v2 (suggestions → draft → post)
      ══════════════════════════════════════════════════════ */}
      {viewMode === 'smartprep' && (
        <div className="hidden md:block">
          {loading ? (
            <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gold" /></div>
          ) : (
            <PlannerDesktop
              items={plannerPool}
              allItems={items}
              stations={stations}
              cooks={cooks}
              services={rcServices}
              nowMin={nowMin}
              canPlan={canPlan}
              post={plan.post}
              search={search}
              onSearch={setSearch}
              handlers={plannerHandlers}
              tasksSlot={
                <PrepTaskLibrary
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
              }
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
            /* Nothing posted yet — the kitchen's To Do stays empty until the chef posts. */
            <div className="bg-paper/60 border-2 border-dashed border-line-2 rounded-xl py-14 text-center">
              <Lock size={26} className="mx-auto text-ink-4 mb-2.5" />
              <p className="text-[14px] font-semibold text-ink-2">Nothing posted yet</p>
              <p className="font-mono text-[10px] text-ink-4 mt-1.5 px-6 tracking-[0.03em]">THE TO DO STAYS EMPTY UNTIL THE CHEF POSTS THE LIST</p>
              {canPlan && (
                <button onClick={() => setViewMode('smartprep')}
                  className="mt-3.5 inline-flex items-center gap-1.5 bg-ink text-paper rounded-[10px] px-3.5 py-2 text-[12.5px] font-semibold">
                  <span className="text-gold">→</span> Build the list
                </button>
              )}
            </div>
          ) : (
            /* Mobile run sheet — the Today surface (hero, queue, in-place
               WorkingRowMobile). Same wired callbacks as the desktop RunSheet. */
            <div className="pb-24 sm:pb-0">
              {plan.post && activeRcId && <PostedBand post={plan.post} />}
              <RunSheetMobile
                items={todayItems}
                cooks={cooks}
                services={rcServices}
                leadMinutes={activeRc?.prepLeadMinutes ?? null}
                nowMin={nowMin}
                nowMs={nowMs}
                onOpenRecipe={openDrawer}
                onStart={(item) => onRowStatusChange(item, 'IN_PROGRESS')}
                onReopen={(item) => onRowStatusChange(item, 'IN_PROGRESS')}
                onLog={setDoneSheetItem}
                onStop={(item) => onRowStatusChange(item, 'NOT_STARTED')}
                onClaim={handleClaim}
                onRemove={canPlan ? (item) => handleRemoveFromToDo(item) : undefined}
              />
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          SMART PREP TAB — mobile planner (Smart Prep v2)
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
              <PlannerMobile
                items={plannerPool}
                allItems={items}
                cooks={cooks}
                stations={stations}
                services={rcServices}
                nowMin={nowMin}
                canPlan={canPlan}
                post={plan.post}
                handlers={plannerHandlers}
              />
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

      {/* Fused item drawer — item context + embedded cook-along (upscale / ingredients / method). */}
      {/* Mobile Tailwind drawer; desktop rebuilt board drawer. Both open from a row tap AND the Recipe button. */}
      {/* A crash in any drawer/recipe modal (e.g. an error-shaped response while offline)
          must not white-screen the whole page — the boundary closes the open modals and recovers. */}
      <ErrorBoundary
        resetKeys={[drawerItem?.id, subRecipeView?.recipeId, doneSheetItem?.id]}
        onError={() => { closeDrawer(); setSubRecipeView(null); setDoneSheetItem(null) }}
        fallback={
          <div className="fixed inset-0 z-[95] grid place-items-center bg-[rgba(9,9,11,0.6)] p-6">
            <div className="bg-paper rounded-2xl shadow-2xl px-6 py-5 max-w-sm text-center">
              <p className="text-sm text-ink-2 mb-3">Something went wrong opening that item. It has been closed — please try again.</p>
              <button className="bg-ink text-white px-4 py-2 rounded-lg text-sm font-medium" onClick={() => { closeDrawer(); setSubRecipeView(null); setDoneSheetItem(null) }}>Dismiss</button>
            </div>
          </div>
        }
      >
      <div className="md:hidden">
        <PrepDrawer
          item={drawerItem}
          detail={drawerDetail}
          countdown={countdown}
          recipe={drawerRecipe}
          recipeLoading={drawerRecipeLoading}
          makeQty={drawerMakeQty}
          onMakeQtyChange={setDrawerMakeQty}
          onClose={closeDrawer}
          onStatusChange={onRowStatusChange}
          onComplete={onDrawerComplete}
          onOpenSubRecipe={(recipeId, name) => { setSubRecipeChecked(new Set()); setSubRecipeView({ recipeId, name }) }}
          onRemove={(item) => { handleToggleOnList(item.id, false); closeDrawer() }}
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
          detail={drawerDetail}
          view={viewMode === 'today' ? 'todo' : 'smart'}
          recipe={drawerRecipe}
          recipeLoading={drawerRecipeLoading}
          makeQty={drawerMakeQty}
          onMakeQtyChange={setDrawerMakeQty}
          onComplete={onDrawerComplete}
          onOpenSubRecipe={(recipeId, name) => { setSubRecipeChecked(new Set()); setSubRecipeView({ recipeId, name }) }}
          onClose={closeDrawer}
          onToggleOnList={handleToggleOnList}
          onStatusChange={(item, status, qty) => onRowStatusChange(item, status, qty)}
          onPriorityChange={handlePriorityChange}
          onEdit={(item) => { closeDrawer(); setEditing(item) }}
        />
      </div>
      {subRecipeView && (
        // Stacking context above BOTH drawers (mobile aside z-50, desktop .pb-drawer z-81)
        // so the sub-recipe peek sits on top of whichever drawer opened it.
        <div className="relative z-[90]">
          <RecipeViewModal
            recipeId={subRecipeView.recipeId}
            recipeName={subRecipeView.name}
            checkedIngredients={subRecipeChecked}
            onToggleIngredient={(id) => setSubRecipeChecked(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })}
            onClose={() => setSubRecipeView(null)}
          />
        </div>
      )}
      </ErrorBoundary>
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
