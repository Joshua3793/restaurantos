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
  const inputCls = 'border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold w-full'
  return (
    <div>
      <h3 className="text-sm font-semibold text-ink-2 mb-2">{label}</h3>
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
              className="shrink-0 p-1.5 text-ink-4 hover:text-red disabled:opacity-30 disabled:cursor-not-allowed"
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

/** A station row: `orig` is the name it had when the modal opened (null = added
 *  here). Editing a row in place is a RENAME and is propagated to every prep
 *  item and cook that names it; deleting a row strips the name from them. */
type StationEntry = { orig: string | null; name: string }

export function PrepSettingsModal({ onClose, onSaved }: Props) {
  const [entries,    setEntries]    = useState<StationEntry[]>([])
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
        // Filter out any empty strings that may have crept into the DB
        setEntries((data.stations ?? []).filter((s: string) => s.trim() !== '').map((s: string) => ({ orig: s, name: s })))
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
    const stations = entries.map(e => e.name.trim()).filter(Boolean)
    if (stations.length === 0) {
      setError('Stations list must have at least one entry.')
      return
    }
    // Renames = rows edited in place; removed = names that were loaded but no
    // row carries any more. The route rewrites PrepItem.stations / Cook.homeStation.
    const renames = entries
      .filter(e => e.orig && e.name.trim() && e.name.trim() !== e.orig)
      .map(e => ({ from: e.orig as string, to: e.name.trim() }))
    const stillPresent = new Set(entries.filter(e => e.orig).map(e => e.orig as string))
    const removed = original.filter(o => !stillPresent.has(o))
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/prep/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stations, renames, removed }),
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

  function addStation() {
    const v = newStation.trim()
    if (!v || entries.some(e => e.name === v)) return
    setEntries(prev => [...prev, { orig: null, name: v }])
    setNewStation('')
  }

  function removeStation(idx: number) {
    setEntries(prev => prev.filter((_, i) => i !== idx))
  }

  function updateStation(idx: number, val: string) {
    setEntries(prev => prev.map((e, i) => i === idx ? { ...e, name: val } : e))
  }

  const original = entries.length ? entries.filter(e => e.orig).map(e => e.orig as string) : []

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="prep-settings-title"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md flex flex-col" style={{ maxHeight: 'calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 2rem)' }}>
        <div className="flex items-center justify-between p-5 border-b border-line shrink-0">
          <div>
            <h2 id="prep-settings-title" className="font-semibold text-ink">Prep Settings</h2>
            <p className="text-xs text-ink-4 mt-0.5">Categories come from Recipe Book — only stations are configurable here.</p>
          </div>
          <button onClick={onClose} disabled={saving} aria-label="Close" className="p-2.5 flex items-center justify-center text-ink-4 hover:text-ink-3 disabled:opacity-50">
            <X size={18} />
          </button>
        </div>

        {loading ? (
          <div className="flex justify-center py-12">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-gold" />
          </div>
        ) : (
          <>
            <div className="p-5 space-y-6 flex-1 overflow-y-auto">
              <ListEditor
                label="Stations"
                items={entries.map(e => e.name)}
                onUpdate={updateStation}
                onRemove={removeStation}
                newValue={newStation}
                onNewValueChange={setNewStation}
                onAdd={addStation}
                addPlaceholder="Add station…"
              />

              {error && <p className="text-sm text-red">{error}</p>}
            </div>

            <div className="flex justify-end gap-2 p-5 border-t border-line shrink-0">
              <button type="button" onClick={onClose} disabled={saving}
                className="px-4 py-2 text-sm text-ink-3 border border-line rounded-lg hover:bg-bg disabled:opacity-50">
                Cancel
              </button>
              <button type="button" onClick={handleSave} disabled={saving}
                className="px-4 py-2 text-sm bg-ink text-paper [&_svg]:text-gold rounded-lg hover:bg-ink-2 disabled:opacity-50">
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
