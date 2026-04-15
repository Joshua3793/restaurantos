'use client'
import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { ChefHat, Plus, RefreshCw, Search } from 'lucide-react'
import { PrepKpiStrip }    from '@/components/prep/PrepKpiStrip'
import { PrepItemRow }     from '@/components/prep/PrepItemRow'
import { PrepItemForm }    from '@/components/prep/PrepItemForm'
import { PrepDetailPanel } from '@/components/prep/PrepDetailPanel'
import type { PrepItemRich } from '@/components/prep/types'

export default function PrepPage() {
  const [items,      setItems]      = useState<PrepItemRich[]>([])
  const [loading,    setLoading]    = useState(true)
  const [generating, setGenerating] = useState(false)
  const [selected,   setSelected]   = useState<PrepItemRich | null>(null)
  const [editing,    setEditing]    = useState<PrepItemRich | null>(null)
  const [showAdd,    setShowAdd]    = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

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
  const [viewMode,       setViewMode]       = useState<'today' | 'needs-action'>('today')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res  = await fetch(`/api/prep/items?active=${activeOnly}`)
      const data = await res.json()
      setItems(Array.isArray(data) ? data : [])
    } catch (e) {
      console.error('Failed to load prep items', e)
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [activeOnly])

  useEffect(() => { load() }, [load])

  // Silently generate today's logs on first load if none exist yet
  useEffect(() => {
    if (items.length > 0 && !hasAttemptedGenerate.current && items.every(i => i.todayLog === null)) {
      hasAttemptedGenerate.current = true
      fetch('/api/prep/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }).then(() => load())
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]) // intentionally not including load — one-shot on first populate

  // Auto-refresh every 60 seconds
  useEffect(() => {
    const id = setInterval(load, 60_000)
    return () => clearInterval(id)
  }, [load])

  const filtered = useMemo(() => items.filter(item => {
    if (search && !item.name.toLowerCase().includes(search.toLowerCase())) return false
    if (filterPriority !== 'ALL' && item.priority !== filterPriority)     return false
    if (filterCategory !== 'ALL' && item.category !== filterCategory)     return false
    const s = item.todayLog?.status ?? 'NOT_STARTED'
    if (filterStatus !== 'ALL' && s !== filterStatus) return false
    if (viewMode === 'needs-action' && (s === 'DONE' || s === 'SKIPPED')) return false
    return true
  }), [items, search, filterPriority, filterCategory, filterStatus, viewMode])

  const inProgress = useMemo(() => items.filter(i => i.todayLog?.status === 'IN_PROGRESS'), [items])

  const categories = useMemo(() => [...new Set(items.map(i => i.category))].sort(), [items])

  // Keep detail panel in sync with live data — avoids stale snapshot after auto-refresh
  const selectedLive = useMemo(
    () => selected ? (items.find(i => i.id === selected.id) ?? selected) : null,
    [selected, items],
  )

  const handleGenerate = async () => {
    setGenerating(true)
    try {
      await fetch('/api/prep/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      await load()
    } catch (e) {
      console.error('Failed to refresh prep logs', e)
      setActionError('Refresh failed — check your connection and try again.')
    } finally {
      setGenerating(false)
    }
  }

  async function handleStatusChange(itemId: string, newStatus: string, actualQty?: number) {
    if (pendingItems.current.has(itemId)) return
    const item = items.find(i => i.id === itemId)
    if (!item) return
    pendingItems.current.add(itemId)
    try {
      let logId = item.todayLog?.id
      if (!logId) {
        const log = await fetch('/api/prep/logs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prepItemId: itemId }),
        }).then(r => r.json())
        logId = log.id
      }
      await fetch(`/api/prep/logs/${logId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: newStatus,
          ...(actualQty !== undefined ? { actualPrepQty: actualQty } : {}),
        }),
      })
      load()
    } catch (e) {
      console.error('Failed to update prep status', e)
      setActionError('Status update failed — try again.')
    } finally {
      pendingItems.current.delete(itemId)
    }
  }

  async function handlePriorityChange(itemId: string, priority: string) {
    try {
      await fetch(`/api/prep/items/${itemId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manualPriorityOverride: priority }),
      })
      load()
    } catch (e) {
      console.error('Failed to update priority', e)
      setActionError('Priority update failed — try again.')
    }
  }

  const selCls = 'border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500'

  return (
    <div className="space-y-5">
      {/* Header */}
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
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="flex items-center gap-2 px-4 py-2 text-sm border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw size={14} className={generating ? 'animate-spin' : ''} />
            {generating ? 'Refreshing…' : 'Refresh'}
          </button>
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            <Plus size={14} /> Add Prep Item
          </button>
        </div>
      </div>

      {/* Action error banner */}
      {actionError && (
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          <span>{actionError}</span>
          <button onClick={() => setActionError(null)} className="shrink-0 text-red-400 hover:text-red-600">✕</button>
        </div>
      )}

      {/* KPI strip */}
      <PrepKpiStrip items={items} onFilterPriority={p => setFilterPriority(prev => prev === p ? 'ALL' : p)} />

      {/* Filters */}
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
            {(['today', 'needs-action'] as const).map(m => (
              <button key={m}
                onClick={() => setViewMode(m)}
                className={`px-3 py-1 text-xs rounded-md transition-colors ${viewMode === m ? 'bg-white shadow text-gray-800' : 'text-gray-500 hover:text-gray-700'}`}
              >
                {m === 'today' ? 'Today' : 'Needs Action'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Currently Making */}
      {inProgress.length > 0 && (
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
                onPriorityChange={handlePriorityChange} />
            ))}
          </div>
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
            {items.length === 0 ? 'No prep items yet.' : 'Nothing matches your filters.'}
          </p>
          {items.length > 0 && viewMode === 'needs-action' && filterStatus === 'DONE' && (
            <p className="text-xs text-gray-400 mt-1">Tip: switch to "Today" mode to see completed items.</p>
          )}
          {items.length === 0 && (
            <button onClick={() => setShowAdd(true)} className="mt-3 text-sm text-blue-600 hover:text-blue-700">
              Add your first prep item →
            </button>
          )}
        </div>
      ) : (
        <div className="bg-white border border-gray-100 rounded-xl overflow-hidden divide-y divide-gray-50">
          {filtered.map(item => (
            <PrepItemRow
              key={item.id}
              item={item}
              onClick={() => setSelected(item)}
              onStatusChange={handleStatusChange}
              onPriorityChange={handlePriorityChange}
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
    </div>
  )
}
