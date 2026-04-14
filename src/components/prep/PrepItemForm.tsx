'use client'
import { useState, useEffect, useCallback } from 'react'
import { X } from 'lucide-react'
import { PREP_CATEGORIES, PREP_STATIONS, PREP_PRIORITY_META, PREP_PRIORITY_ORDER } from '@/lib/prep-utils'
import type { PrepItemRich } from './types'

interface Recipe { id: string; name: string; yieldUnit: string }

interface Props {
  item?: PrepItemRich | null
  onClose: () => void
  onSaved: () => void
}

const BLANK = {
  name: '', linkedRecipeId: '', linkedInventoryItemId: '',
  category: 'MISC', station: '',
  parLevel: '', unit: 'batch', minThreshold: '',
  targetToday: '', shelfLifeDays: '', notes: '',
  manualPriorityOverride: '',
}

export function PrepItemForm({ item, onClose, onSaved }: Props) {
  const [form, setForm]       = useState(BLANK)
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [saving, setSaving]   = useState(false)
  const [error, setError]     = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/recipes?type=PREP&isActive=true')
      .then(r => r.json())
      .then((data: Recipe[]) => setRecipes(Array.isArray(data) ? data : []))
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
        minThreshold:          String(item.minThreshold),
        targetToday:           item.targetToday != null ? String(item.targetToday) : '',
        shelfLifeDays:         item.shelfLifeDays != null ? String(item.shelfLifeDays) : '',
        notes:                 item.notes                ?? '',
        manualPriorityOverride: item.manualPriorityOverride ?? '',
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
      minThreshold:          form.minThreshold ? parseFloat(form.minThreshold) : 0,
      targetToday:           form.targetToday  ? parseFloat(form.targetToday)  : null,
      shelfLifeDays:         form.shelfLifeDays ? parseInt(form.shelfLifeDays) : null,
      notes:                 form.notes || null,
      manualPriorityOverride: form.manualPriorityOverride || null,
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
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      {children}
    </div>
  )
  const inputCls = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'
  const selCls   = inputCls + ' bg-white'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <h2 className="font-semibold text-gray-900">{item ? 'Edit Prep Item' : 'New Prep Item'}</h2>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
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

          <div className="grid grid-cols-2 gap-3">
            {field('Category', (
              <select className={selCls} value={form.category} onChange={e => set('category', e.target.value)}>
                {PREP_CATEGORIES.map(c => <option key={c}>{c}</option>)}
              </select>
            ))}
            {field('Station', (
              <select className={selCls} value={form.station} onChange={e => set('station', e.target.value)}>
                <option value="">— None —</option>
                {PREP_STATIONS.map(s => <option key={s}>{s}</option>)}
              </select>
            ))}
          </div>

          <div className="grid grid-cols-3 gap-3">
            {field('Par Level', (
              <input className={inputCls} type="number" min="0" step="0.1"
                value={form.parLevel} onChange={e => set('parLevel', e.target.value)} placeholder="0" />
            ))}
            {field('Min Threshold', (
              <input className={inputCls} type="number" min="0" step="0.1"
                value={form.minThreshold} onChange={e => set('minThreshold', e.target.value)} placeholder="0"
                title="Early warning — set above par level" />
            ))}
            {field('Unit', (
              <input className={inputCls} value={form.unit}
                onChange={e => set('unit', e.target.value)} placeholder="batch" />
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3">
            {field('Target Today (optional)', (
              <input className={inputCls} type="number" min="0" step="0.1"
                value={form.targetToday} onChange={e => set('targetToday', e.target.value)} placeholder="—" />
            ))}
            {field('Shelf Life (days)', (
              <input className={inputCls} type="number" min="0" step="1"
                value={form.shelfLifeDays} onChange={e => set('shelfLifeDays', e.target.value)} placeholder="—" />
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

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose}
              className="px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50">
              Cancel
            </button>
            <button type="submit" disabled={saving}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
              {saving ? 'Saving…' : item ? 'Save Changes' : 'Create Prep Item'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
