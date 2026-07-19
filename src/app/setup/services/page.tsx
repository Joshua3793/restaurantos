'use client'
import { useCallback, useEffect, useState } from 'react'
import { Plus, Pencil, Trash2, Check, X, Clock, ChevronUp, ChevronDown, Power } from 'lucide-react'
import { PageHead } from '@/components/layout/PageHead'
import { useRc } from '@/contexts/RevenueCenterContext'

interface Service {
  id: string
  revenueCenterId: string
  name: string
  timeMinutes: number
  sortOrder: number
  isActive: boolean
}

// ── HH:MM ⟷ minutes-past-midnight ──────────────────────────────────────────
function fmtClock(mins: number): string {
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function parseClock(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (!match) return null
  const h = parseInt(match[1], 10)
  const m = parseInt(match[2], 10)
  if (Number.isNaN(h) || Number.isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) return null
  return h * 60 + m
}

/* ─────────────────────────────  Add form  ──────────────────────────────── */

function AddServiceForm({ onAdd }: { onAdd: (name: string, timeMinutes: number) => Promise<string | void> }) {
  const [name, setName] = useState('')
  const [time, setTime] = useState('11:30')
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) { setError('Name is required'); return }
    const mins = parseClock(time)
    if (mins === null) { setError('Enter a valid time (HH:MM)'); return }
    setError('')
    const err = await onAdd(name.trim(), mins)
    if (err) { setError(err); return }
    setName('')
    setTime('11:30')
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap gap-2">
      <input
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder="New service name (e.g. Lunch)..."
        className="flex-1 min-w-[10rem] border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
      />
      <input
        type="time"
        value={time}
        onChange={e => setTime(e.target.value)}
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

function ServiceRow({
  service, isFirst, isLast, onSave, onDelete, onToggleActive, onMove,
}: {
  service: Service
  isFirst: boolean
  isLast: boolean
  onSave: (id: string, name: string, timeMinutes: number) => Promise<string | void>
  onDelete: (service: Service) => void
  onToggleActive: (service: Service) => void
  onMove: (service: Service, direction: 'up' | 'down') => void
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(service.name)
  const [time, setTime] = useState(fmtClock(service.timeMinutes))
  const [error, setError] = useState('')

  const startEdit = () => {
    setName(service.name)
    setTime(fmtClock(service.timeMinutes))
    setError('')
    setEditing(true)
  }

  const save = async () => {
    if (!name.trim()) { setError('Name is required'); return }
    const mins = parseClock(time)
    if (mins === null) { setError('Enter a valid time (HH:MM)'); return }
    const err = await onSave(service.id, name.trim(), mins)
    if (err) { setError(err); return }
    setEditing(false)
  }

  return (
    <div className={`flex items-center gap-2 px-4 py-3 ${service.isActive ? '' : 'opacity-50'}`}>
      {/* Reorder */}
      <div className="flex flex-col shrink-0">
        <button onClick={() => onMove(service, 'up')} disabled={isFirst}
          className="text-ink-4 hover:text-ink-2 disabled:opacity-30 disabled:hover:text-ink-4">
          <ChevronUp size={13} />
        </button>
        <button onClick={() => onMove(service, 'down')} disabled={isLast}
          className="text-ink-4 hover:text-ink-2 disabled:opacity-30 disabled:hover:text-ink-4">
          <ChevronDown size={13} />
        </button>
      </div>

      <Clock size={16} className="text-ink-4 shrink-0" />

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
            type="time"
            value={time}
            onChange={e => setTime(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false) }}
            className="border border-blue rounded px-2 py-1 text-sm focus:outline-none"
          />
          <button onClick={save} className="text-green hover:text-green-text"><Check size={16} /></button>
          <button onClick={() => setEditing(false)} className="text-ink-4 hover:text-ink-3"><X size={16} /></button>
          {error && <p className="w-full text-xs text-red mt-1">{error}</p>}
        </>
      ) : (
        <>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-ink-2 truncate">{service.name}</div>
            {!service.isActive && <div className="text-xs text-ink-4">Inactive</div>}
          </div>
          <span className="font-mono text-xs text-ink-3 bg-bg-2 px-2 py-1 rounded-lg shrink-0">
            {fmtClock(service.timeMinutes)}
          </span>
          <button onClick={() => onToggleActive(service)} title={service.isActive ? 'Deactivate' : 'Activate'}
            className={`p-1 ${service.isActive ? 'text-green hover:text-green-text' : 'text-ink-4 hover:text-ink-2'}`}>
            <Power size={14} />
          </button>
          <button onClick={startEdit} className="text-ink-4 hover:text-gold p-1"><Pencil size={14} /></button>
          <button onClick={() => onDelete(service)} className="text-ink-4 hover:text-red p-1"><Trash2 size={14} /></button>
        </>
      )}
    </div>
  )
}

/* ────────────────────────────────  Page  ───────────────────────────────── */

export default function ServicesPage() {
  const { revenueCenters } = useRc()
  const [rcId, setRcId] = useState<string | null>(null)
  const [services, setServices] = useState<Service[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Default to the first RC once loaded.
  useEffect(() => {
    if (rcId === null && revenueCenters.length > 0) {
      setRcId(revenueCenters[0].id)
    }
  }, [revenueCenters, rcId])

  const load = useCallback(async (id: string) => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/services?revenueCenterId=${id}`)
      if (!res.ok) throw new Error(`Failed to load (${res.status})`)
      setServices(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { if (rcId) load(rcId) }, [rcId, load])

  const refetch = () => { if (rcId) load(rcId) }

  const handleAdd = async (name: string, timeMinutes: number): Promise<string | void> => {
    if (!rcId) return 'No revenue center selected'
    const res = await fetch('/api/services', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revenueCenterId: rcId, name, timeMinutes, sortOrder: services.length }),
    })
    if (!res.ok) { const d = await res.json().catch(() => ({})); return d.error || 'Failed to create service' }
    refetch()
  }

  const handleSave = async (id: string, name: string, timeMinutes: number): Promise<string | void> => {
    const res = await fetch(`/api/services/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, timeMinutes }),
    })
    if (!res.ok) { const d = await res.json().catch(() => ({})); return d.error || 'Failed to update service' }
    refetch()
  }

  const handleDelete = async (service: Service) => {
    if (!confirm(`Delete "${service.name}"? Prep items targeting it will just lose their service link.`)) return
    const res = await fetch(`/api/services/${service.id}`, { method: 'DELETE' })
    if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.error || 'Failed to delete service'); return }
    setError('')
    refetch()
  }

  const handleToggleActive = async (service: Service) => {
    const nextActive = !service.isActive
    setServices(prev => prev.map(s => s.id === service.id ? { ...s, isActive: nextActive } : s)) // optimistic
    const res = await fetch(`/api/services/${service.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: nextActive }),
    })
    if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.error || 'Failed to update service'); refetch(); return }
    setError('')
  }

  const handleMove = async (service: Service, direction: 'up' | 'down') => {
    const idx = services.findIndex(s => s.id === service.id)
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1
    if (idx < 0 || swapIdx < 0 || swapIdx >= services.length) return
    const swapped = [...services]
    const tmp = swapped[idx]
    swapped[idx] = swapped[swapIdx]
    swapped[swapIdx] = tmp

    // Normalize sortOrder to reflect the new display order (0..n-1); only
    // persist rows whose sortOrder actually changed.
    const next = swapped.map((s, i) => (s.sortOrder === i ? s : { ...s, sortOrder: i }))
    const patches = next.filter((s, i) => s !== swapped[i])
    setServices(next) // optimistic reorder for snappy up/down

    const results = await Promise.all(patches.map(s =>
      fetch(`/api/services/${s.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sortOrder: s.sortOrder }),
      })
    ))
    if (results.some(r => !r.ok)) setError('Failed to reorder')
    else setError('')
    refetch()
  }

  return (
    <div>
      <PageHead
        crumbs={<><Clock size={12} /> SETUP / SERVICES</>}
        title="Services"
        sub={<>When each service is ready — drives the prep run sheet.</>}
      />

      {/* RC selector */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        {revenueCenters.map(rc => (
          <button
            key={rc.id}
            onClick={() => setRcId(rc.id)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
              rcId === rc.id
                ? 'border-gold bg-gold/10 text-ink'
                : 'border-line text-ink-3 hover:bg-bg'
            }`}
          >
            {rc.name}
          </button>
        ))}
        {revenueCenters.length === 0 && (
          <span className="text-xs text-ink-4">No revenue centers configured yet.</span>
        )}
      </div>

      {error && (
        <div className="p-3 bg-red-soft border border-red-soft rounded-xl text-sm text-red-text mb-4">
          {error}
        </div>
      )}

      <div className="max-w-2xl space-y-4">
        <AddServiceForm onAdd={handleAdd} />

        <div className="bg-white rounded-xl border border-line shadow-sm divide-y divide-line">
          {loading ? (
            <div className="text-center py-12 text-ink-4">Loading…</div>
          ) : services.length === 0 ? (
            <div className="text-center py-12 text-ink-4">No services yet for this revenue center</div>
          ) : (
            services.map((service, i) => (
              <ServiceRow
                key={service.id}
                service={service}
                isFirst={i === 0}
                isLast={i === services.length - 1}
                onSave={handleSave}
                onDelete={handleDelete}
                onToggleActive={handleToggleActive}
                onMove={handleMove}
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}
