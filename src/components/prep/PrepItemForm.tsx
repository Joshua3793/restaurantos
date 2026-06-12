'use client'
import { useState, useEffect, useCallback } from 'react'
import { X } from 'lucide-react'
import { PREP_STATIONS, PREP_PRIORITY_META, PREP_PRIORITY_ORDER } from '@/lib/prep-utils'
import type { PrepItemRich } from './types'


interface Recipe { id: string; name: string; yieldUnit: string }
interface RevenueCenter { id: string; name: string }

interface Props {
  item?: PrepItemRich | null
  onClose: () => void
  onSaved: () => void
}

const BLANK = {
  name: '', linkedRecipeId: '', linkedInventoryItemId: '',
  category: 'MISC', station: '',
  parLevel: '', unit: 'batch',
  targetToday: '', shelfLifeDays: '', estimatedPrepTime: '', notes: '',
  manualPriorityOverride: '',
  revenueCenterId: '',
}

type TimeUnit = 'min' | 'hr' | 'day'

// Convert stored minutes to display value + best unit
function minutesToDisplay(minutes: number): { value: string; unit: TimeUnit } {
  if (minutes >= 1440 && minutes % 1440 === 0) return { value: String(minutes / 1440), unit: 'day' }
  if (minutes >= 60   && minutes % 60   === 0) return { value: String(minutes / 60),   unit: 'hr'  }
  return { value: String(minutes), unit: 'min' }
}

const TIME_UNIT_TO_MINUTES: Record<TimeUnit, number> = { min: 1, hr: 60, day: 1440 }

export function PrepItemForm({ item, onClose, onSaved }: Props) {
  const [form, setForm]           = useState(BLANK)
  const [prepTimeUnit, setPrepTimeUnit] = useState<TimeUnit>('min')
  const [recipes, setRecipes]     = useState<Recipe[]>([])
  const [revenueCenters, setRevenueCenters] = useState<RevenueCenter[]>([])
  const [saving, setSaving]       = useState(false)
  const [error, setError]         = useState<string | null>(null)
  const [stations, setStations] = useState<string[]>(PREP_STATIONS)

  useEffect(() => {
    fetch('/api/recipes?type=PREP&isActive=true')
      .then(r => r.json())
      .then((data: Recipe[]) => setRecipes(Array.isArray(data) ? data : []))
  }, [])

  useEffect(() => {
    fetch('/api/revenue-centers')
      .then(r => r.json())
      .then((data: RevenueCenter[]) => setRevenueCenters(Array.isArray(data) ? data : []))
      .catch(() => { /* keep empty on error */ })
  }, [])

  useEffect(() => {
    fetch('/api/prep/settings')
      .then(r => { if (!r.ok) throw new Error(); return r.json() })
      .then(data => {
        if (Array.isArray(data.stations)) setStations(data.stations)
      })
      .catch(() => { /* keep defaults on error */ })
  }, [])

  useEffect(() => {
    if (item) {
      setForm({
        name:                  item.name,
        linkedRecipeId:        item.linkedRecipeId        ?? '',
        linkedInventoryItemId: item.linkedInventoryItemId ?? '',
        category:              item.category,
        station:               item.station               ?? '',
        parLevel:              String(item.parLevel),
        unit:                  item.unit,
        targetToday:           item.targetToday != null ? String(item.targetToday) : '',
        shelfLifeDays:         item.shelfLifeDays != null ? String(item.shelfLifeDays) : '',
        estimatedPrepTime:     item.estimatedPrepTime != null ? (() => { const d = minutesToDisplay(item.estimatedPrepTime!); setPrepTimeUnit(d.unit); return d.value })() : '',
        notes:                 item.notes                ?? '',
        manualPriorityOverride: item.manualPriorityOverride ?? '',
        revenueCenterId:       item.revenueCenterId       ?? '',
      })
    }
  }, [item])

  const set = useCallback((k: keyof typeof BLANK, v: string) => {
    setForm(prev => ({ ...prev, [k]: v }))
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim()) { setError('Name is required'); return }
    setSaving(true)
    setError(null)

    const payload = {
      name:                  form.name.trim(),
      linkedRecipeId:        form.linkedRecipeId        || null,
      linkedInventoryItemId: form.linkedInventoryItemId || null,
      category:              form.category,
      station:               form.station               || null,
      parLevel:              form.parLevel    ? parseFloat(form.parLevel)    : 0,
      unit:                  form.unit,
      targetToday:           form.targetToday  ? parseFloat(form.targetToday)  : null,
      shelfLifeDays:         form.shelfLifeDays ? parseInt(form.shelfLifeDays, 10) : null,
      estimatedPrepTime:     form.estimatedPrepTime ? Math.round(parseFloat(form.estimatedPrepTime) * TIME_UNIT_TO_MINUTES[prepTimeUnit]) : null,
      notes:                 form.notes || null,
      manualPriorityOverride: form.manualPriorityOverride || null,
      revenueCenterId:       form.revenueCenterId || null,
    }

    const url    = item ? `/api/prep/items/${item.id}` : '/api/prep/items'
    const method = item ? 'PUT' : 'POST'
    const res    = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    if (res.ok) { onSaved(); onClose() }
    else {
      const data = await res.json().catch(() => ({}))
      setError(data.error ?? 'Failed to save')
    }
    setSaving(false)
  }

  const field = (label: string, children: React.ReactNode) => (
    <div>
      <label className="block text-xs font-medium text-ink-3 mb-1">{label}</label>
      {children}
    </div>
  )
  const inputCls = 'w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold'
  const selCls   = inputCls + ' bg-white'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg flex flex-col" style={{ maxHeight: 'calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 2rem)' }}>
        <div className="flex items-center justify-between p-5 border-b border-line shrink-0">
          <h2 className="font-semibold text-ink">{item ? 'Edit Prep Item' : 'New Prep Item'}</h2>
          <button onClick={onClose} className="p-2.5 flex items-center justify-center text-ink-4 hover:text-ink-3"><X size={18} /></button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
          <div className="p-5 space-y-4 flex-1 overflow-y-auto">
          {field('Name *', (
            <input className={inputCls} value={form.name}
              onChange={e => set('name', e.target.value)} placeholder="e.g. Smoked Brisket" required />
          ))}

          {field('Linked Recipe (optional)', (
            <select className={selCls} value={form.linkedRecipeId}
              onChange={e => set('linkedRecipeId', e.target.value)}>
              <option value="">— None —</option>
              {recipes.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          ))}

          {field('Station', (
            <select className={selCls} value={form.station} onChange={e => set('station', e.target.value)}>
              <option value="">— None —</option>
              {stations.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          ))}

          {field('Revenue Center', (
            <select className={selCls} value={form.revenueCenterId} onChange={e => set('revenueCenterId', e.target.value)}>
              <option value="">Shared (all centers)</option>
              {revenueCenters.map(rc => <option key={rc.id} value={rc.id}>{rc.name}</option>)}
            </select>
          ))}

          <div className="grid grid-cols-2 gap-3">
            {field('Par Level', (
              <input className={inputCls} type="number" min="0" step="0.1"
                value={form.parLevel} onChange={e => set('parLevel', e.target.value)} placeholder="0" />
            ))}
            {field('Unit', (
              <select className={inputCls + ' bg-white'} value={form.unit} onChange={e => set('unit', e.target.value)}>
                {['batch', 'portion', 'serve', 'each', 'pkg', 'tray', 'kg', 'g', 'lb', 'oz', 'l', 'ml'].map(u => <option key={u}>{u}</option>)}
              </select>
            ))}
          </div>

          <div className="grid grid-cols-3 gap-3">
            {field('Target Today (optional)', (
              <input className={inputCls} type="number" min="0" step="0.1"
                value={form.targetToday} onChange={e => set('targetToday', e.target.value)} placeholder="—" />
            ))}
            {field('Shelf Life (days)', (
              <input className={inputCls} type="number" min="0" step="1"
                value={form.shelfLifeDays} onChange={e => set('shelfLifeDays', e.target.value)} placeholder="—" />
            ))}
            {field('Prep Time', (
              <div className="flex gap-1">
                <input className={inputCls + ' flex-1 min-w-0'} type="number" min="0" step="0.5"
                  value={form.estimatedPrepTime} onChange={e => set('estimatedPrepTime', e.target.value)} placeholder="—" />
                <select
                  className="border border-line-2 rounded-lg px-2 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gold shrink-0"
                  value={prepTimeUnit}
                  onChange={e => setPrepTimeUnit(e.target.value as TimeUnit)}
                >
                  <option value="min">min</option>
                  <option value="hr">hr</option>
                  <option value="day">day</option>
                </select>
              </div>
            ))}
          </div>

          {field('Manual Priority Override', (
            <select className={selCls} value={form.manualPriorityOverride}
              onChange={e => set('manualPriorityOverride', e.target.value)}>
              <option value="">— Auto (system decides) —</option>
              {PREP_PRIORITY_ORDER.map(p => (
                <option key={p} value={p}>{PREP_PRIORITY_META[p].label}</option>
              ))}
            </select>
          ))}

          {field('Notes', (
            <textarea className={inputCls} rows={2} value={form.notes}
              onChange={e => set('notes', e.target.value)} placeholder="Chef notes..." />
          ))}

          {error && <p className="text-sm text-red">{error}</p>}
          </div>

          <div className="flex justify-end gap-2 p-5 border-t border-line shrink-0">
            <button type="button" onClick={onClose}
              className="px-4 py-2 text-sm text-ink-3 border border-line rounded-lg hover:bg-bg">
              Cancel
            </button>
            <button type="submit" disabled={saving}
              className="px-4 py-2 text-sm bg-ink text-paper [&_svg]:text-gold rounded-lg hover:bg-ink-2 disabled:opacity-50">
              {saving ? 'Saving…' : item ? 'Save Changes' : 'Create Prep Item'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
