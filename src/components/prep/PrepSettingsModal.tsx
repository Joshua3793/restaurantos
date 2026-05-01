'use client'
import { useState, useEffect } from 'react'
import { X, Plus, Trash2 } from 'lucide-react'

// ── ListEditor lives at module scope so its reference is stable across renders ──
// Defining it inside PrepSettingsModal would cause React to remount it on every
// parent state change (e.g. every keystroke), losing input focus.
function ListEditor({
  label,
  items,
  onUpdate,
  onRemove,
  newValue,
  onNewValueChange,
  onAdd,
  addPlaceholder,
}: {
  label: string
  items: string[]
  onUpdate: (idx: number, val: string) => void
  onRemove: (idx: number) => void
  newValue: string
  onNewValueChange: (v: string) => void
  onAdd: () => void
  addPlaceholder: string
}) {
  const inputCls = 'border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold w-full'
  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-700 mb-2">{label}</h3>
      <div className="space-y-1.5 mb-3">
        {items.map((item, idx) => (
          <div key={idx} className="flex items-center gap-2">
            <input
              className={inputCls}
              value={item}
              onChange={e => onUpdate(idx, e.target.value)}
              onBlur={e => onUpdate(idx, e.target.value.trim())}
            />
            <button
              type="button"
              onClick={() => onRemove(idx)}
              disabled={items.length <= 1}
              className="shrink-0 p-1.5 text-gray-400 hover:text-red-500 disabled:opacity-30 disabled:cursor-not-allowed"
              aria-label="Remove"
              title="Remove"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <input
          className={inputCls}
          value={newValue}
          onChange={e => onNewValueChange(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onAdd() } }}
          placeholder={addPlaceholder}
        />
        <button
          type="button"
          onClick={onAdd}
          disabled={!newValue.trim()}
          className="shrink-0 p-1.5 text-gold hover:text-gold disabled:opacity-30 disabled:cursor-not-allowed"
          aria-label="Add"
          title="Add"
        >
          <Plus size={16} />
        </button>
      </div>
    </div>
  )
}

interface Props {
  onClose: () => void
  onSaved: () => void
}

export function PrepSettingsModal({ onClose, onSaved }: Props) {
  const [categories, setCategories] = useState<string[]>([])
  const [stations,   setStations]   = useState<string[]>([])
  const [newCategory, setNewCategory] = useState('')
  const [newStation,  setNewStation]  = useState('')
  const [saving,  setSaving]  = useState(false)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/prep/settings', { signal: controller.signal })
      .then(r => {
        if (!r.ok) throw new Error('Settings fetch failed')
        return r.json()
      })
      .then(data => {
        setCategories(data.categories ?? [])
        setStations(data.stations ?? [])
        setLoading(false)
      })
      .catch(err => {
        if (err.name === 'AbortError') return
        setError('Failed to load settings')
        setLoading(false)
      })
    return () => controller.abort()
  }, [])

  async function handleSave() {
    if (categories.length === 0 || stations.length === 0) {
      setError('Both lists must have at least one entry.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/prep/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          categories: categories.map(c => c.trim()).filter(Boolean),
          stations:   stations.map(s => s.trim()).filter(Boolean),
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data.error ?? 'Failed to save')
      } else {
        onSaved()
        onClose()
      }
    } catch {
      setError('Network error — try again.')
    } finally {
      setSaving(false)
    }
  }

  function addCategory() {
    const v = newCategory.trim()
    if (!v || categories.includes(v)) return
    setCategories(prev => [...prev, v])
    setNewCategory('')
  }

  function removeCategory(idx: number) {
    setCategories(prev => prev.filter((_, i) => i !== idx))
  }

  function updateCategory(idx: number, val: string) {
    setCategories(prev => prev.map((c, i) => i === idx ? val : c))
  }

  function addStation() {
    const v = newStation.trim()
    if (!v || stations.includes(v)) return
    setStations(prev => [...prev, v])
    setNewStation('')
  }

  function removeStation(idx: number) {
    setStations(prev => prev.filter((_, i) => i !== idx))
  }

  function updateStation(idx: number, val: string) {
    setStations(prev => prev.map((s, i) => i === idx ? val : s))
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="prep-settings-title"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <h2 id="prep-settings-title" className="font-semibold text-gray-900">Prep Settings</h2>
          <button onClick={onClose} disabled={saving} aria-label="Close" className="p-1 text-gray-400 hover:text-gray-600 disabled:opacity-50">
            <X size={18} />
          </button>
        </div>

        {loading ? (
          <div className="flex justify-center py-12">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-gold" />
          </div>
        ) : (
          <div className="p-5 space-y-6">
            <ListEditor
              label="Categories"
              items={categories}
              onUpdate={updateCategory}
              onRemove={removeCategory}
              newValue={newCategory}
              onNewValueChange={setNewCategory}
              onAdd={addCategory}
              addPlaceholder="Add category…"
            />
            <div className="border-t border-gray-100" />
            <ListEditor
              label="Stations"
              items={stations}
              onUpdate={updateStation}
              onRemove={removeStation}
              newValue={newStation}
              onNewValueChange={setNewStation}
              onAdd={addStation}
              addPlaceholder="Add station…"
            />

            {error && <p className="text-sm text-red-600">{error}</p>}

            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={onClose} disabled={saving}
                className="px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50">
                Cancel
              </button>
              <button type="button" onClick={handleSave} disabled={saving}
                className="px-4 py-2 text-sm bg-gold text-white rounded-lg hover:bg-[#a88930] disabled:opacity-50">
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
