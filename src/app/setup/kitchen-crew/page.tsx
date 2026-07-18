'use client'
import { useCallback, useEffect, useState } from 'react'
import { Plus, Pencil, Trash2, Check, X, ChefHat, ChevronUp, ChevronDown, Ban, RotateCcw } from 'lucide-react'
import { PageHead } from '@/components/layout/PageHead'

interface Cook {
  id: string
  name: string
  initials: string
  homeStation: string | null
  isActive: boolean
  sortOrder: number
}

/* ─────────────────────────  Home-station select  ───────────────────────── */

function StationSelect({
  value, onChange, stations, className,
}: {
  value: string
  onChange: (v: string) => void
  stations: string[]
  className: string
}) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)} className={className}>
      <option value="">No station</option>
      {stations.map(s => <option key={s} value={s}>{s}</option>)}
    </select>
  )
}

/* ─────────────────────────────  Add form  ──────────────────────────────── */

function AddCookForm({
  stations, onAdd,
}: {
  stations: string[]
  onAdd: (name: string, initials: string, homeStation: string) => Promise<string | void>
}) {
  const [name, setName] = useState('')
  const [initials, setInitials] = useState('')
  const [homeStation, setHomeStation] = useState('')
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) { setError('Name is required'); return }
    if (!initials.trim()) { setError('Initials are required'); return }
    setError('')
    const err = await onAdd(name.trim(), initials.trim(), homeStation)
    if (err) { setError(err); return }
    setName('')
    setInitials('')
    setHomeStation('')
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap gap-2">
      <input
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder="New cook name (e.g. Mia)..."
        className="flex-1 min-w-[10rem] border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
      />
      <input
        value={initials}
        onChange={e => setInitials(e.target.value.toUpperCase().slice(0, 3))}
        placeholder="Initials"
        className="w-20 border border-line rounded-lg px-3 py-2 text-sm uppercase focus:outline-none focus:ring-2 focus:ring-gold"
      />
      <StationSelect
        value={homeStation}
        onChange={setHomeStation}
        stations={stations}
        className="border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
      />
      <button type="submit" className="flex items-center gap-2 bg-ink text-paper [&_svg]:text-gold px-3 py-2 rounded-lg text-sm hover:bg-ink-2">
        <Plus size={15} /> Add
      </button>
      {error && <p className="w-full text-xs text-red">{error}</p>}
    </form>
  )
}

/* ────────────────────────────────  Row  ────────────────────────────────── */

function CookRow({
  cook, stations, isFirst, isLast, onSave, onDelete, onDeactivate, onReactivate, onMove,
}: {
  cook: Cook
  stations: string[]
  isFirst: boolean
  isLast: boolean
  onSave: (id: string, name: string, initials: string, homeStation: string) => Promise<string | void>
  onDelete: (cook: Cook) => void
  onDeactivate: (cook: Cook) => void
  onReactivate: (cook: Cook) => void
  onMove: (cook: Cook, direction: 'up' | 'down') => void
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(cook.name)
  const [initials, setInitials] = useState(cook.initials)
  const [homeStation, setHomeStation] = useState(cook.homeStation ?? '')
  const [error, setError] = useState('')

  const startEdit = () => {
    setName(cook.name)
    setInitials(cook.initials)
    setHomeStation(cook.homeStation ?? '')
    setError('')
    setEditing(true)
  }

  const save = async () => {
    if (!name.trim()) { setError('Name is required'); return }
    if (!initials.trim()) { setError('Initials are required'); return }
    const err = await onSave(cook.id, name.trim(), initials.trim(), homeStation)
    if (err) { setError(err); return }
    setEditing(false)
  }

  return (
    <div className={`flex items-center gap-2 px-4 py-3 ${!cook.isActive ? 'opacity-50' : ''}`}>
      {/* Reorder */}
      <div className="flex flex-col shrink-0">
        <button onClick={() => onMove(cook, 'up')} disabled={isFirst}
          className="text-ink-4 hover:text-ink-2 disabled:opacity-30 disabled:hover:text-ink-4">
          <ChevronUp size={13} />
        </button>
        <button onClick={() => onMove(cook, 'down')} disabled={isLast}
          className="text-ink-4 hover:text-ink-2 disabled:opacity-30 disabled:hover:text-ink-4">
          <ChevronDown size={13} />
        </button>
      </div>

      <ChefHat size={16} className="text-ink-4 shrink-0" />

      {editing ? (
        <>
          <input
            autoFocus
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false) }}
            className="flex-1 border border-blue rounded px-2 py-1 text-sm focus:outline-none"
          />
          <input
            value={initials}
            onChange={e => setInitials(e.target.value.toUpperCase().slice(0, 3))}
            onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false) }}
            className="w-16 border border-blue rounded px-2 py-1 text-sm uppercase focus:outline-none"
          />
          <StationSelect
            value={homeStation}
            onChange={setHomeStation}
            stations={stations}
            className="border border-blue rounded px-2 py-1 text-sm focus:outline-none"
          />
          <button onClick={save} className="text-green hover:text-green-text"><Check size={16} /></button>
          <button onClick={() => setEditing(false)} className="text-ink-4 hover:text-ink-3"><X size={16} /></button>
          {error && <p className="w-full text-xs text-red mt-1">{error}</p>}
        </>
      ) : (
        <>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-medium text-ink-2 truncate">{cook.name}</span>
              {!cook.isActive && (
                <span className="text-[10px] font-semibold bg-red-soft text-red px-1.5 py-0.5 rounded-full shrink-0">
                  Inactive
                </span>
              )}
            </div>
            {cook.homeStation && <div className="text-xs text-ink-4">{cook.homeStation}</div>}
          </div>
          <span className="font-mono text-xs text-ink-3 bg-bg-2 px-2 py-1 rounded-lg shrink-0">
            {cook.initials}
          </span>
          {cook.isActive ? (
            <button onClick={() => onDeactivate(cook)} title="Deactivate — remove from roster, keep the record"
              className="p-1 text-ink-4 hover:text-red">
              <Ban size={14} />
            </button>
          ) : (
            <button onClick={() => onReactivate(cook)} title="Reactivate — restore to roster"
              className="p-1 text-ink-4 hover:text-green">
              <RotateCcw size={14} />
            </button>
          )}
          <button onClick={startEdit} className="text-ink-4 hover:text-gold p-1"><Pencil size={14} /></button>
          <button onClick={() => onDelete(cook)} className="text-ink-4 hover:text-red p-1"><Trash2 size={14} /></button>
        </>
      )}
    </div>
  )
}

/* ────────────────────────────────  Page  ───────────────────────────────── */

export default function KitchenCrewPage() {
  const [cooks, setCooks] = useState<Cook[]>([])
  const [stations, setStations] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [cooksRes, settingsRes] = await Promise.all([
        fetch('/api/prep/cooks?includeInactive=true'),
        fetch('/api/prep/settings'),
      ])
      if (!cooksRes.ok) throw new Error(`Failed to load cooks (${cooksRes.status})`)
      setCooks(await cooksRes.json())
      if (settingsRes.ok) {
        const settings = await settingsRes.json()
        setStations(Array.isArray(settings.stations) ? settings.stations : [])
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const refetch = () => load()

  const handleAdd = async (name: string, initials: string, homeStation: string): Promise<string | void> => {
    const res = await fetch('/api/prep/cooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, initials, homeStation: homeStation || null, sortOrder: cooks.length }),
    })
    if (!res.ok) { const d = await res.json().catch(() => ({})); return d.error || 'Failed to create cook' }
    refetch()
  }

  const handleSave = async (id: string, name: string, initials: string, homeStation: string): Promise<string | void> => {
    const res = await fetch(`/api/prep/cooks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, initials, homeStation: homeStation || null }),
    })
    if (!res.ok) { const d = await res.json().catch(() => ({})); return d.error || 'Failed to update cook' }
    refetch()
  }

  const handleDelete = async (cook: Cook) => {
    if (!confirm(`Delete "${cook.name}"? This permanently removes them from the roster.`)) return
    const res = await fetch(`/api/prep/cooks/${cook.id}`, { method: 'DELETE' })
    if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.error || 'Failed to delete cook'); return }
    setError('')
    refetch()
  }

  // Reversible lifecycle toggle — mirrors /setup/users. Deactivating drops a
  // cook off prep assignment lists (GET /api/prep/cooks default excludes
  // inactive) but keeps the record, so they can be reactivated here at any
  // time. This page always loads with includeInactive=true so both states
  // stay visible.
  const setActive = async (cook: Cook, isActive: boolean) => {
    setCooks(prev => prev.map(c => c.id === cook.id ? { ...c, isActive } : c)) // optimistic
    const res = await fetch(`/api/prep/cooks/${cook.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive }),
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      setError(d.error || `Failed to ${isActive ? 'reactivate' : 'deactivate'} cook`)
      refetch()
      return
    }
    setError('')
    refetch()
  }

  const handleDeactivate = (cook: Cook) => {
    if (!confirm(`Deactivate "${cook.name}"? They'll drop off prep assignment lists but can be reactivated later.`)) return
    setActive(cook, false)
  }

  const handleReactivate = (cook: Cook) => setActive(cook, true)

  const handleMove = async (cook: Cook, direction: 'up' | 'down') => {
    const idx = cooks.findIndex(c => c.id === cook.id)
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1
    if (idx < 0 || swapIdx < 0 || swapIdx >= cooks.length) return
    const swapped = [...cooks]
    const tmp = swapped[idx]
    swapped[idx] = swapped[swapIdx]
    swapped[swapIdx] = tmp

    // Normalize sortOrder to reflect the new display order (0..n-1); only
    // persist rows whose sortOrder actually changed.
    const next = swapped.map((c, i) => (c.sortOrder === i ? c : { ...c, sortOrder: i }))
    const patches = next.filter((c, i) => c !== swapped[i])
    setCooks(next) // optimistic reorder for snappy up/down

    const results = await Promise.all(patches.map(c =>
      fetch(`/api/prep/cooks/${c.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sortOrder: c.sortOrder }),
      })
    ))
    if (results.some(r => !r.ok)) setError('Failed to reorder')
    else setError('')
    refetch()
  }

  return (
    <div>
      <PageHead
        crumbs={<><ChefHat size={12} /> SETUP / KITCHEN CREW</>}
        title="Kitchen crew"
        sub={<>Cooks &amp; stations for the prep run sheet.</>}
      />

      {error && (
        <div className="p-3 bg-red-soft border border-red-soft rounded-xl text-sm text-red-text mb-4">
          {error}
        </div>
      )}

      <div className="max-w-2xl space-y-4">
        <AddCookForm stations={stations} onAdd={handleAdd} />

        <div className="bg-white rounded-xl border border-line shadow-sm divide-y divide-line">
          {loading ? (
            <div className="text-center py-12 text-ink-4">Loading…</div>
          ) : cooks.length === 0 ? (
            <div className="text-center py-12 text-ink-4">No cooks yet — add your first one above</div>
          ) : (
            cooks.map((cook, i) => (
              <CookRow
                key={cook.id}
                cook={cook}
                stations={stations}
                isFirst={i === 0}
                isLast={i === cooks.length - 1}
                onSave={handleSave}
                onDelete={handleDelete}
                onDeactivate={handleDeactivate}
                onReactivate={handleReactivate}
                onMove={handleMove}
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}
