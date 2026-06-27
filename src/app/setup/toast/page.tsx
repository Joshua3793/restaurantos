'use client'
import { useState, useEffect, useMemo, useCallback } from 'react'
import { RefreshCw, CheckCircle2, XCircle, Loader2, Wand2, Search, X, Link2, Building2, Play, CalendarClock } from 'lucide-react'

// ─── Types (mirror the API shapes) ──────────────────────────────────────────

interface ConnTest {
  ok: boolean
  restaurantName?: string
  timeZone?: string
  sampleBusinessDate: number
  sampleOrderCount: number
  error?: string
}
interface DiscoveredRC {
  toastGuid: string
  orderCount: number
  mappedTo: { id: string; name: string } | null
}
interface RcData {
  discovered: DiscoveredRC[]
  revenueCenters: { id: string; name: string }[]
}
interface MenuRoutesData {
  menus: { menu: string; revenueCenterId: string | null }[]
  revenueCenters: { id: string; name: string }[]
}
interface MenuSyncResult {
  itemsSeen: number
  created: number
  updated: number
  menus: string[]
  groups: string[]
  unknownGroups: string[]
  lastUpdated?: string
}
interface ToastItemRow {
  id: string
  toastItemGuid: string
  toastName: string
  toastGroup: string | null
  toastMenu: string | null
  recipeId: string | null
  recipeName: string | null
  kind: 'food' | 'beverage' | 'ignore'
  suggestion: { id: string; name: string; confidence: 'exact' | 'fuzzy' | 'none' } | null
}
interface ItemsData {
  items: ToastItemRow[]
  recipes: { id: string; name: string }[]
  stats: { total: number; mapped: number; unmapped: number; foodUnmapped: number }
}

interface SyncStatus {
  status: string
  lastSyncedAt: string | null
  lastError: string | null
  lastLog: { businessDate: string; ordersPulled: number; lineItemsWritten: number; unmatchedCount: number; status: string; createdAt: string } | null
}
interface SyncRunResult {
  mode: 'day' | 'backfill'
  result?: { businessDate: number; ordersPulled: number; status: string; skippedUnmappedRcOrders: number; perRc: { revenueCenterName: string; totalRevenue: number; foodSalesPct: number; lineItemsWritten: number; unmatchedItems: number; unmatchedQty: number }[] }
  days?: number
  error?: string
}

type Filter = 'food-unmapped' | 'unmapped' | 'mapped' | 'all'

// yyyy-mm-dd → yyyymmdd int
const toInt = (d: string) => Number(d.replace(/-/g, ''))

// ─── Page ────────────────────────────────────────────────────────────────────

export default function ToastSetupPage() {
  const [conn, setConn] = useState<ConnTest | null>(null)
  const [connLoading, setConnLoading] = useState(true)

  const [rc, setRc] = useState<RcData | null>(null)
  const [rcEdits, setRcEdits] = useState<Record<string, string>>({}) // toastGuid → revenueCenterId|''
  const [rcSaving, setRcSaving] = useState(false)

  const [mr, setMr] = useState<MenuRoutesData | null>(null)
  const [mrEdits, setMrEdits] = useState<Record<string, string>>({}) // menu → revenueCenterId|''
  const [mrSaving, setMrSaving] = useState(false)

  const [items, setItems] = useState<ItemsData | null>(null)
  const [itemsLoading, setItemsLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<MenuSyncResult | null>(null)

  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<Filter>('food-unmapped')
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set())
  const [acceptingAll, setAcceptingAll] = useState(false)

  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [running, setRunning] = useState(false)
  const [runResult, setRunResult] = useState<SyncRunResult | null>(null)
  const [bfFrom, setBfFrom] = useState('')
  const [bfTo, setBfTo] = useState('')

  // ── Loaders ──
  const loadConn = useCallback(async () => {
    setConnLoading(true)
    try {
      const res = await fetch('/api/toast/test')
      setConn(await res.json())
    } catch {
      setConn({ ok: false, sampleBusinessDate: 0, sampleOrderCount: 0, error: 'Request failed' })
    } finally {
      setConnLoading(false)
    }
  }, [])

  const loadRc = useCallback(async (discover = false) => {
    try {
      const res = await fetch(`/api/toast/revenue-centers${discover ? '?discover=1' : ''}`)
      if (res.ok) {
        const data: RcData = await res.json()
        setRc(data)
        setRcEdits(Object.fromEntries(data.discovered.map((d) => [d.toastGuid, d.mappedTo?.id ?? ''])))
      }
    } catch { /* non-fatal */ }
  }, [])

  const loadItems = useCallback(async () => {
    setItemsLoading(true)
    try {
      const res = await fetch('/api/toast/items')
      if (res.ok) setItems(await res.json())
    } finally {
      setItemsLoading(false)
    }
  }, [])

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/toast/status')
      if (res.ok) setStatus(await res.json())
    } catch { /* non-fatal */ }
  }, [])

  const loadMr = useCallback(async () => {
    try {
      const res = await fetch('/api/toast/menu-routing')
      if (res.ok) {
        const data: MenuRoutesData = await res.json()
        setMr(data)
        setMrEdits(Object.fromEntries(data.menus.map((m) => [m.menu, m.revenueCenterId ?? ''])))
      }
    } catch { /* non-fatal */ }
  }, [])

  const saveMr = async () => {
    setMrSaving(true)
    try {
      const mappings = Object.entries(mrEdits).map(([menu, id]) => ({ menu, revenueCenterId: id || null }))
      await fetch('/api/toast/menu-routing', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mappings }),
      })
      await loadMr()
    } finally {
      setMrSaving(false)
    }
  }

  useEffect(() => { loadConn(); loadRc(); loadItems(); loadStatus(); loadMr() }, [loadConn, loadRc, loadItems, loadStatus, loadMr])

  const runSync = async (query: string) => {
    setRunning(true); setRunResult(null)
    try {
      const res = await fetch(`/api/cron/toast-sync${query}`)
      const data = await res.json()
      setRunResult(res.ok ? data : { mode: 'day', error: data.error || 'Sync failed' })
      await Promise.all([loadStatus(), loadItems()])
    } catch {
      setRunResult({ mode: 'day', error: 'Request failed' })
    } finally {
      setRunning(false)
    }
  }
  const syncYesterday = () => runSync('')
  const runBackfill = () => {
    if (!bfFrom || !bfTo) return
    runSync(`?from=${toInt(bfFrom)}&to=${toInt(bfTo)}`)
  }

  // ── Actions ──
  const syncMenu = async () => {
    setSyncing(true); setSyncResult(null)
    try {
      const res = await fetch('/api/toast/sync-menu', { method: 'POST' })
      const data = await res.json()
      if (res.ok) { setSyncResult(data); await loadItems() }
      else setSyncResult({ ...data, itemsSeen: 0, created: 0, updated: 0, menus: [], groups: [], unknownGroups: [] })
    } finally {
      setSyncing(false)
    }
  }

  const saveRc = async () => {
    setRcSaving(true)
    try {
      const mappings = Object.entries(rcEdits).map(([toastGuid, id]) => ({ toastGuid, revenueCenterId: id || null }))
      await fetch('/api/toast/revenue-centers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mappings }),
      })
      await loadRc()
    } finally {
      setRcSaving(false)
    }
  }

  const patchItems = useCallback(async (mappings: { id: string; recipeId: string | null }[]) => {
    setSavingIds((s) => { const n = new Set(s); mappings.forEach((m) => n.add(m.id)); return n })
    // optimistic
    setItems((prev) => {
      if (!prev) return prev
      const recName = (rid: string | null) => prev.recipes.find((r) => r.id === rid)?.name ?? null
      const nextItems = prev.items.map((it) => {
        const m = mappings.find((x) => x.id === it.id)
        return m ? { ...it, recipeId: m.recipeId, recipeName: recName(m.recipeId), suggestion: m.recipeId ? null : it.suggestion } : it
      })
      const mapped = nextItems.filter((r) => r.recipeId).length
      const foodUnmapped = nextItems.filter((r) => !r.recipeId && r.kind === 'food').length
      return { ...prev, items: nextItems, stats: { total: nextItems.length, mapped, unmapped: nextItems.length - mapped, foodUnmapped } }
    })
    try {
      await fetch('/api/toast/items', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mappings }),
      })
    } finally {
      setSavingIds((s) => { const n = new Set(s); mappings.forEach((m) => n.delete(m.id)); return n })
    }
  }, [])

  const acceptAllSuggestions = async () => {
    if (!items) return
    const toApply = items.items
      .filter((it) => !it.recipeId && it.suggestion)
      .map((it) => ({ id: it.id, recipeId: it.suggestion!.id }))
    if (!toApply.length) return
    setAcceptingAll(true)
    try { await patchItems(toApply) } finally { setAcceptingAll(false) }
  }

  // ── Derived list ──
  const visibleItems = useMemo(() => {
    if (!items) return []
    const q = search.trim().toLowerCase()
    return items.items.filter((it) => {
      if (filter === 'food-unmapped' && !(it.kind === 'food' && !it.recipeId)) return false
      if (filter === 'unmapped' && it.recipeId) return false
      if (filter === 'mapped' && !it.recipeId) return false
      if (q && !it.toastName.toLowerCase().includes(q) && !(it.recipeName ?? '').toLowerCase().includes(q)) return false
      return true
    })
  }, [items, search, filter])

  const suggestionCount = items?.items.filter((it) => !it.recipeId && it.suggestion).length ?? 0

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-ink">Toast Integration</h1>
          <p className="text-sm text-ink-3 mt-0.5">
            Connect Toast sales → map menu items to recipes. CAFE only; CATERING stays manual.
          </p>
        </div>
        <button
          onClick={loadConn}
          className="flex items-center gap-1.5 border border-line text-ink-2 px-3 py-2 rounded-xl text-sm font-medium hover:bg-bg"
        >
          <RefreshCw size={15} /> Test
        </button>
      </div>

      <ConnCard conn={conn} loading={connLoading} />

      <RcCard
        rc={rc} edits={rcEdits} setEdits={setRcEdits}
        onSave={saveRc} saving={rcSaving} onRediscover={() => loadRc(true)}
      />

      <MenuRoutingCard
        mr={mr} edits={mrEdits} setEdits={setMrEdits} onSave={saveMr} saving={mrSaving}
      />

      {/* Menu sync */}
      <div className="bg-white border border-line rounded-2xl p-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-sm font-semibold text-ink flex items-center gap-1.5"><Link2 size={14} /> Menu sync</h3>
            <p className="text-xs text-ink-3 mt-0.5">
              Pull the published Toast menu and refresh the item list below. Existing mappings are preserved.
            </p>
          </div>
          <button
            onClick={syncMenu} disabled={syncing}
            className="flex items-center gap-1.5 bg-ink text-paper [&_svg]:text-gold px-3 py-2 rounded-xl text-sm font-semibold hover:bg-ink-2 disabled:opacity-50"
          >
            {syncing ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
            {syncing ? 'Syncing…' : 'Sync menu'}
          </button>
        </div>
        {syncResult && (
          <div className="mt-3 text-xs text-ink-3 bg-bg rounded-xl p-3 space-y-1">
            {'error' in syncResult && (syncResult as { error?: string }).error ? (
              <p className="text-red-text">{(syncResult as { error?: string }).error}</p>
            ) : (
              <>
                <p><b className="text-ink">{syncResult.itemsSeen}</b> items · {syncResult.created} new · {syncResult.updated} updated · {syncResult.menus.length} menus / {syncResult.groups.length} groups</p>
                {syncResult.unknownGroups.length > 0 && (
                  <p className="text-gold">⚠ Unrecognized groups (guessed food/non-food): {syncResult.unknownGroups.join(', ')}</p>
                )}
              </>
            )}
          </div>
        )}
      </div>

      <SyncCard
        status={status} running={running} result={runResult}
        bfFrom={bfFrom} bfTo={bfTo} setBfFrom={setBfFrom} setBfTo={setBfTo}
        onSyncYesterday={syncYesterday} onBackfill={runBackfill}
      />

      {/* Item mapping */}
      <div className="bg-white border border-line rounded-2xl">
        <div className="p-4 border-b border-line">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h3 className="text-sm font-semibold text-ink">Item → recipe mapping</h3>
            {items && (
              <div className="flex items-center gap-2 text-[11px] font-mono">
                <Stat label="MAPPED" value={`${items.stats.mapped}/${items.stats.total}`} tone="ink" />
                <Stat label="FOOD UNMAPPED" value={String(items.stats.foodUnmapped)} tone={items.stats.foodUnmapped ? 'gold' : 'ink'} />
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 mt-3 flex-wrap">
            <div className="relative flex-1 min-w-[180px]">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-4" />
              <input
                value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search item or recipe…"
                className="w-full border border-line rounded-xl pl-8 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
              />
            </div>
            <div className="flex gap-1">
              {(['food-unmapped', 'unmapped', 'mapped', 'all'] as Filter[]).map((f) => (
                <button
                  key={f} onClick={() => setFilter(f)}
                  className={`px-2.5 py-2 text-xs font-medium rounded-xl border transition-colors ${
                    filter === f ? 'border-gold bg-gold/10 text-ink' : 'border-line text-ink-3 hover:bg-bg'
                  }`}
                >
                  {f === 'food-unmapped' ? 'Food to map' : f === 'unmapped' ? 'Unmapped' : f === 'mapped' ? 'Mapped' : 'All'}
                </button>
              ))}
            </div>
            <button
              onClick={acceptAllSuggestions} disabled={!suggestionCount || acceptingAll}
              className="flex items-center gap-1.5 border border-line text-ink-2 px-3 py-2 rounded-xl text-xs font-medium hover:bg-bg disabled:opacity-40"
              title="Apply every fuzzy/exact suggestion for unmapped items"
            >
              {acceptingAll ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
              Accept all ({suggestionCount})
            </button>
          </div>
        </div>

        <div className="divide-y divide-line">
          {itemsLoading ? (
            <div className="p-8 text-center text-ink-4 text-sm flex items-center justify-center gap-2">
              <Loader2 size={16} className="animate-spin" /> Loading items…
            </div>
          ) : !items || visibleItems.length === 0 ? (
            <div className="p-8 text-center text-ink-4 text-sm">
              {!items?.items.length ? 'No items yet — run “Sync menu” above.' : 'Nothing matches this filter.'}
            </div>
          ) : (
            visibleItems.map((it) => (
              <ItemRow
                key={it.id} item={it} recipes={items.recipes}
                saving={savingIds.has(it.id)}
                onSet={(recipeId) => patchItems([{ id: it.id, recipeId }])}
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Sub-components (module scope — avoid remount per CLAUDE.md) ──────────────

function Stat({ label, value, tone }: { label: string; value: string; tone: 'ink' | 'gold' }) {
  return (
    <span className="inline-flex items-center gap-1.5 bg-bg border border-line rounded-lg px-2 py-1">
      <span className="text-ink-4 uppercase tracking-wide">{label}</span>
      <b className={tone === 'gold' ? 'text-gold' : 'text-ink'}>{value}</b>
    </span>
  )
}

function ConnCard({ conn, loading }: { conn: ConnTest | null; loading: boolean }) {
  const ok = conn?.ok
  return (
    <div className={`border rounded-2xl p-4 ${ok ? 'border-line bg-white' : conn ? 'border-red-soft bg-red-soft/30' : 'border-line bg-white'}`}>
      <div className="flex items-center gap-3">
        {loading ? <Loader2 size={18} className="animate-spin text-ink-4" />
          : ok ? <CheckCircle2 size={18} className="text-green" />
          : <XCircle size={18} className="text-red" />}
        <div className="flex-1 min-w-0">
          {loading ? (
            <p className="text-sm text-ink-3">Testing connection…</p>
          ) : ok ? (
            <p className="text-sm text-ink">
              Connected to <b>{conn!.restaurantName}</b>
              <span className="text-ink-4"> · {conn!.timeZone} · {conn!.sampleOrderCount} orders on {conn!.sampleBusinessDate}</span>
            </p>
          ) : (
            <p className="text-sm text-red-text">Connection failed{conn?.error ? `: ${conn.error}` : ''}</p>
          )}
        </div>
      </div>
    </div>
  )
}

function RcCard({
  rc, edits, setEdits, onSave, saving, onRediscover,
}: {
  rc: RcData | null
  edits: Record<string, string>
  setEdits: (fn: (prev: Record<string, string>) => Record<string, string>) => void
  onSave: () => void
  saving: boolean
  onRediscover: () => void
}) {
  const dirty = rc?.discovered.some((d) => (edits[d.toastGuid] ?? '') !== (d.mappedTo?.id ?? '')) ?? false
  return (
    <div className="bg-white border border-line rounded-2xl p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-ink flex items-center gap-1.5"><Building2 size={14} /> Revenue centers</h3>
        <button onClick={onRediscover} className="text-[11px] text-ink-4 hover:text-ink-2 flex items-center gap-1">
          <RefreshCw size={11} /> Rediscover
        </button>
      </div>
      <p className="text-xs text-ink-3 mt-0.5">
        Toast revenue centers found in recent orders. Map each to an app revenue center (Toast names aren’t available via API — identify by order volume).
      </p>
      {!rc ? (
        <p className="text-xs text-ink-4 mt-3">Loading…</p>
      ) : rc.discovered.length === 0 ? (
        <p className="text-xs text-ink-4 mt-3">None discovered yet — click Rediscover.</p>
      ) : (
        <div className="mt-3 space-y-2">
          {rc.discovered.map((d) => (
            <div key={d.toastGuid} className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-[11px] text-ink-4 truncate flex-1 min-w-[160px]">{d.toastGuid}</span>
              <span className="text-[11px] text-ink-4 tabular-nums">{d.orderCount} orders</span>
              <select
                value={edits[d.toastGuid] ?? ''}
                onChange={(e) => setEdits((p) => ({ ...p, [d.toastGuid]: e.target.value }))}
                className="border border-line rounded-lg px-2 py-1.5 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-gold"
              >
                <option value="">— Unmapped —</option>
                {rc.revenueCenters.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
          ))}
          <div className="flex justify-end">
            <button
              onClick={onSave} disabled={!dirty || saving}
              className="bg-ink text-paper px-3 py-1.5 rounded-xl text-xs font-semibold hover:bg-ink-2 disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Save mapping'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function MenuRoutingCard({
  mr, edits, setEdits, onSave, saving,
}: {
  mr: MenuRoutesData | null
  edits: Record<string, string>
  setEdits: (fn: (prev: Record<string, string>) => Record<string, string>) => void
  onSave: () => void
  saving: boolean
}) {
  const dirty = mr?.menus.some((m) => (edits[m.menu] ?? '') !== (m.revenueCenterId ?? '')) ?? false
  return (
    <div className="bg-white border border-line rounded-2xl p-4">
      <h3 className="text-sm font-semibold text-ink flex items-center gap-1.5"><Building2 size={14} /> Menu → revenue center</h3>
      <p className="text-xs text-ink-3 mt-0.5">
        Route each Toast menu to a revenue center. Items are attributed by their menu (e.g. BAR → BAR, CATERING → CATERING),
        overriding the order’s revenue center. Leave “— Use order RC —” to fall back to the per-order mapping above.
      </p>
      {!mr ? (
        <p className="text-xs text-ink-4 mt-3">Loading…</p>
      ) : mr.menus.length === 0 ? (
        <p className="text-xs text-ink-4 mt-3">No menus yet — run “Sync menu” below first.</p>
      ) : (
        <div className="mt-3 space-y-2">
          {mr.menus.map((m) => (
            <div key={m.menu} className="flex items-center gap-2">
              <span className="text-sm text-ink-2 flex-1 min-w-0 truncate font-medium">{m.menu}</span>
              <select
                value={edits[m.menu] ?? ''}
                onChange={(e) => setEdits((p) => ({ ...p, [m.menu]: e.target.value }))}
                className="border border-line rounded-lg px-2 py-1.5 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-gold"
              >
                <option value="">— Use order RC —</option>
                {mr.revenueCenters.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
          ))}
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-ink-4">Don’t see a BAR center? Create it in Setup → Revenue centers, then it appears here.</span>
            <button
              onClick={onSave} disabled={!dirty || saving}
              className="bg-ink text-paper px-3 py-1.5 rounded-xl text-xs font-semibold hover:bg-ink-2 disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Save routing'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function fmtMoney(n: number) { return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` }
function fmtWhen(iso: string | null) {
  if (!iso) return 'never'
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function SyncCard({
  status, running, result, bfFrom, bfTo, setBfFrom, setBfTo, onSyncYesterday, onBackfill,
}: {
  status: SyncStatus | null
  running: boolean
  result: SyncRunResult | null
  bfFrom: string; bfTo: string
  setBfFrom: (v: string) => void; setBfTo: (v: string) => void
  onSyncYesterday: () => void; onBackfill: () => void
}) {
  const ok = status?.status === 'ok'
  return (
    <div className="bg-white border border-line rounded-2xl p-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-ink flex items-center gap-1.5"><CalendarClock size={14} /> Sales sync</h3>
          <p className="text-xs text-ink-3 mt-0.5">
            Pulls a day’s Toast orders → CAFE sales. Runs nightly; trigger manually or backfill a range here.
          </p>
        </div>
        <button
          onClick={onSyncYesterday} disabled={running}
          className="flex items-center gap-1.5 bg-ink text-paper [&_svg]:text-gold px-3 py-2 rounded-xl text-sm font-semibold hover:bg-ink-2 disabled:opacity-50"
        >
          {running ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
          {running ? 'Syncing…' : 'Sync yesterday'}
        </button>
      </div>

      {/* Last sync status */}
      <div className="mt-3 flex items-center gap-2 text-xs">
        <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border ${ok ? 'border-green-soft bg-green-soft/40 text-green' : status?.status === 'error' ? 'border-red-soft bg-red-soft/40 text-red-text' : 'border-line bg-bg text-ink-4'}`}>
          {ok ? <CheckCircle2 size={12} /> : status?.status === 'error' ? <XCircle size={12} /> : null}
          {status?.status ?? '—'}
        </span>
        <span className="text-ink-4">Last synced {fmtWhen(status?.lastSyncedAt ?? null)}</span>
        {status?.lastLog && (
          <span className="text-ink-4">· {status.lastLog.ordersPulled} orders · {status.lastLog.lineItemsWritten} lines · {status.lastLog.unmatchedCount} unmatched</span>
        )}
      </div>
      {status?.lastError && <p className="text-xs text-red-text mt-1">{status.lastError}</p>}

      {/* Backfill */}
      <div className="mt-3 pt-3 border-t border-line flex items-end gap-2 flex-wrap">
        <div>
          <label className="block text-[11px] text-ink-4 mb-1">Backfill from</label>
          <input type="date" value={bfFrom} onChange={(e) => setBfFrom(e.target.value)}
            className="border border-line rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-gold" />
        </div>
        <div>
          <label className="block text-[11px] text-ink-4 mb-1">to</label>
          <input type="date" value={bfTo} onChange={(e) => setBfTo(e.target.value)}
            className="border border-line rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-gold" />
        </div>
        <button
          onClick={onBackfill} disabled={running || !bfFrom || !bfTo}
          className="flex items-center gap-1.5 border border-line text-ink-2 px-3 py-1.5 rounded-xl text-xs font-medium hover:bg-bg disabled:opacity-40"
        >
          {running ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Backfill range
        </button>
      </div>

      {/* Result */}
      {result && (
        <div className="mt-3 text-xs bg-bg rounded-xl p-3 space-y-1">
          {result.error ? (
            <p className="text-red-text">{result.error}</p>
          ) : result.mode === 'backfill' ? (
            <p className="text-ink">Backfilled <b>{result.days}</b> day{result.days === 1 ? '' : 's'}.</p>
          ) : result.result ? (
            <>
              <p className="text-ink">
                <b>{result.result.businessDate}</b> · {result.result.ordersPulled} orders
                {result.result.status === 'skipped' && <span className="text-ink-4"> · no mapped sales</span>}
              </p>
              {result.result.perRc.map((r, i) => (
                <p key={i} className="text-ink-3">
                  {r.revenueCenterName}: <b className="text-ink">{fmtMoney(r.totalRevenue)}</b> · {(r.foodSalesPct * 100).toFixed(1)}% food · {r.lineItemsWritten} lines
                  {r.unmatchedItems > 0 && <span className="text-gold"> · {r.unmatchedItems} unmatched ({r.unmatchedQty} sold)</span>}
                </p>
              ))}
            </>
          ) : null}
        </div>
      )}
    </div>
  )
}

function ItemRow({
  item, recipes, saving, onSet,
}: {
  item: ToastItemRow
  recipes: { id: string; name: string }[]
  saving: boolean
  onSet: (recipeId: string | null) => void
}) {
  const kindTag =
    item.kind === 'food' ? <span className="text-[10px] font-semibold uppercase tracking-wide text-green bg-green-soft px-1.5 py-0.5 rounded-full">Food</span>
    : item.kind === 'beverage' ? <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-4 bg-bg-2 px-1.5 py-0.5 rounded-full">Bev</span>
    : <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-4 bg-bg-2 px-1.5 py-0.5 rounded-full">Ignore</span>

  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm text-ink truncate">{item.toastName}</span>
          {kindTag}
        </div>
        <div className="text-[11px] text-ink-4 mt-0.5">
          {item.toastMenu} · {item.toastGroup}
          {!item.recipeId && item.suggestion && (
            <button
              onClick={() => onSet(item.suggestion!.id)}
              className="ml-2 inline-flex items-center gap-1 text-gold hover:text-gold-2"
            >
              ↳ suggest: <b>{item.suggestion.name}</b>
              <span className={item.suggestion.confidence === 'exact' ? 'text-green' : 'text-gold'}>({item.suggestion.confidence})</span>
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        {saving && <Loader2 size={13} className="animate-spin text-ink-4" />}
        <select
          value={item.recipeId ?? ''}
          onChange={(e) => onSet(e.target.value || null)}
          className={`border rounded-lg px-2 py-1.5 text-xs bg-white max-w-[200px] focus:outline-none focus:ring-2 focus:ring-gold ${
            item.recipeId ? 'border-line text-ink' : 'border-line-2 text-ink-3'
          }`}
        >
          <option value="">— Not mapped —</option>
          {recipes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        {item.recipeId && (
          <button onClick={() => onSet(null)} className="p-1 text-ink-4 hover:text-red" title="Clear">
            <X size={13} />
          </button>
        )}
      </div>
    </div>
  )
}
