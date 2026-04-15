'use client'
import { useEffect, useState, useCallback, useMemo } from 'react'
import { ChefHat, Plus, RefreshCw, Search, ChevronDown, ChevronUp } from 'lucide-react'
import { PrepKpiStrip }    from '@/components/prep/PrepKpiStrip'
import { PrepItemRow }     from '@/components/prep/PrepItemRow'
import { PrepItemForm }    from '@/components/prep/PrepItemForm'
import { PrepDetailPanel } from '@/components/prep/PrepDetailPanel'
import {
  PREP_PRIORITY_ORDER,
  PREP_PRIORITY_META,
  type PrepPriority,
} from '@/lib/prep-utils'
import type { PrepItemRich } from '@/components/prep/types'

export default function PrepPage() {
  const [items,      setItems]      = useState<PrepItemRich[]>([])
  const [loading,    setLoading]    = useState(true)
  const [generating, setGenerating] = useState(false)
  const [selected,   setSelected]   = useState<PrepItemRich | null>(null)
  const [editing,    setEditing]    = useState<PrepItemRich | null>(null)
  const [showAdd,    setShowAdd]    = useState(false)

  // Filters
  const [search,         setSearch]         = useState('')
  const [filterPriority, setFilterPriority] = useState('ALL')
  const [filterStatus,   setFilterStatus]   = useState('ALL')
  const [filterCategory, setFilterCategory] = useState('ALL')
  const [filterStation,  setFilterStation]  = useState('ALL')
  const [activeOnly,     setActiveOnly]     = useState(true)
  const [viewMode,       setViewMode]       = useState<'today' | 'needs-action'>('today')
  const [collapsed,      setCollapsed]      = useState<Record<string, boolean>>({})

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

  const filtered = useMemo(() => items.filter(item => {
    if (search && !item.name.toLowerCase().includes(search.toLowerCase())) return false
    if (filterPriority !== 'ALL' && item.priority !== filterPriority)     return false
    if (filterCategory !== 'ALL' && item.category !== filterCategory)     return false
    if (filterStation  !== 'ALL' && item.station  !== filterStation)      return false
    const s = item.todayLog?.status ?? 'NOT_STARTED'
    if (filterStatus !== 'ALL' && s !== filterStatus) return false
    if (viewMode === 'needs-action' && (s === 'DONE' || s === 'SKIPPED')) return false
    return true
  }), [items, search, filterPriority, filterCategory, filterStation, filterStatus, viewMode])

  const sections = useMemo(() => {
    const map: Record<PrepPriority, PrepItemRich[]> = {
      '911': [], NEEDED_TODAY: [], LOW_STOCK: [], LATER: [],
    }
    filtered.forEach(i => map[i.priority].push(i))
    return map
  }, [filtered])

  const categories = useMemo(() => [...new Set(items.map(i => i.category))].sort(), [items])
  const stations   = useMemo(() => [...new Set(items.map(i => i.station).filter(Boolean) as string[])].sort(), [items])

  const handleGenerate = async () => {
    setGenerating(true)
    await fetch('/api/prep/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    setGenerating(false)
    load()
  }

  async function handleStatusChange(itemId: string, newStatus: string, actualQty?: number) {
    const item = items.find(i => i.id === itemId)
    if (!item) return
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
  }

  async function handlePriorityChange(itemId: string, priority: string) {
    await fetch(`/api/prep/items/${itemId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manualPriorityOverride: priority }),
    })
    load()
  }

  const toggleSection = (p: string) =>
    setCollapsed(prev => ({ ...prev, [p]: !prev[p] }))

  const selCls = 'border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500'

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <ChefHat size={24} className="text-blue-600" /> Prep
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">Daily kitchen production board</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="flex items-center gap-2 px-4 py-2 text-sm border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw size={14} className={generating ? 'animate-spin' : ''} />
            {generating ? 'Generating…' : "Generate Today's Prep"}
          </button>
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            <Plus size={14} /> Add Prep Item
          </button>
        </div>
      </div>

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
            {categories.map(c => <option key={c}>{c}</option>)}
          </select>
          {stations.length > 0 && (
            <select className={selCls} value={filterStation} onChange={e => setFilterStation(e.target.value)}>
              <option value="ALL">All Stations</option>
              {stations.map(s => <option key={s}>{s}</option>)}
            </select>
          )}
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

      {/* Priority sections */}
      {loading ? (
        <div className="flex justify-center py-16">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white border border-gray-100 rounded-xl py-16 text-center">
          <ChefHat size={32} className="mx-auto text-gray-300 mb-3" />
          <p className="text-gray-500 text-sm">No prep items match your filters.</p>
          <p className="text-gray-400 text-xs mt-1">Click &ldquo;Generate Today&rsquo;s Prep&rdquo; to populate today&rsquo;s board.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {PREP_PRIORITY_ORDER.map(priority => {
            const sectionItems = sections[priority]
            if (sectionItems.length === 0) return null
            const meta   = PREP_PRIORITY_META[priority]
            const isOpen = !collapsed[priority]
            return (
              <div key={priority} className={`border rounded-xl overflow-hidden ${priority === '911' ? 'border-red-200' : priority === 'NEEDED_TODAY' ? 'border-orange-200' : priority === 'LOW_STOCK' ? 'border-amber-200' : 'border-gray-200'}`}>
                {/* Section header */}
                <button
                  onClick={() => toggleSection(priority)}
                  className={`w-full flex items-center justify-between px-4 py-3 ${meta.bgClass} hover:opacity-90 transition-opacity`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-base">{meta.emoji}</span>
                    <span className={`font-semibold text-sm ${meta.headingClass}`}>{meta.label}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${meta.badgeClass}`}>{sectionItems.length}</span>
                  </div>
                  {isOpen ? <ChevronUp size={16} className={meta.headingClass} /> : <ChevronDown size={16} className={meta.headingClass} />}
                </button>
                {/* Items */}
                {isOpen && (
                  <div className="divide-y divide-gray-50">
                    {sectionItems.map(item => (
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
              </div>
            )
          })}
        </div>
      )}

      {/* Detail panel */}
      {selected && (
        <PrepDetailPanel
          item={selected}
          onClose={() => setSelected(null)}
          onRefresh={() => { load(); setSelected(null) }}
          onEdit={() => { setEditing(selected); setSelected(null) }}
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
