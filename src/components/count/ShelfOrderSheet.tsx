'use client'
// "Shelf order" — arrange an area's items in the order they sit on the shelves,
// so the count walks the walk-in instead of reading A–Z. Phone-first bottom
// sheet (a centred panel on desktop). LEAD+ only; the page gates the entry.

import { useEffect, useState } from 'react'
import { ArrowUp, ArrowDown, ChevronsUp, X } from 'lucide-react'
import { useBackDismiss } from '@/lib/back-stack'
import { useRc } from '@/contexts/RevenueCenterContext'

interface AreaOption { id: string; name: string }
interface ShelfItem { id: string; itemName: string; category: string; shelfOrder: number | null }

export function ShelfOrderSheet({ open, onClose, areas, initialAreaId, onSaved }: {
  open: boolean
  onClose: () => void
  areas: AreaOption[]
  initialAreaId: string | null
  /** Called after a save with the area and its items' new positions (id → index). */
  onSaved?: (areaId: string, order: Map<string, number>) => void
}) {
  useBackDismiss(open, onClose)
  // The kitchen in view: the list shows only its items (null = every kitchen).
  const { activeRcId } = useRc()

  const [areaId, setAreaId] = useState<string | null>(initialAreaId ?? areas[0]?.id ?? null)
  const [items, setItems] = useState<ShelfItem[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Re-seed the area each time the sheet opens.
  useEffect(() => {
    if (open) setAreaId(initialAreaId ?? areas[0]?.id ?? null)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open || !areaId) return
    let cancelled = false
    setLoading(true); setError(null); setDirty(false)
    const q = activeRcId ? `?rcId=${encodeURIComponent(activeRcId)}` : ''
    fetch(`/api/storage-areas/${encodeURIComponent(areaId)}/shelf-order${q}`, { cache: 'no-store' })
      .then(async r => {
        const j = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(j.error || 'Could not load this area.')
        return j as { items: ShelfItem[] }
      })
      .then(j => { if (!cancelled) setItems(j.items) })
      .catch(e => { if (!cancelled) { setItems([]); setError(e.message) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, areaId, activeRcId])

  if (!open) return null

  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length || from === to) return
    setItems(prev => {
      const next = [...prev]
      const [it] = next.splice(from, 1)
      next.splice(to, 0, it)
      return next
    })
    setDirty(true)
  }

  const save = async () => {
    if (!areaId) return
    setSaving(true); setError(null)
    try {
      const itemIds = items.map(i => i.id)
      const r = await fetch(`/api/storage-areas/${encodeURIComponent(areaId)}/shelf-order`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemIds }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error || 'Could not save the shelf order.')
      setItems(prev => prev.map((it, i) => ({ ...it, shelfOrder: i })))
      setDirty(false)
      onSaved?.(areaId, new Map(itemIds.map((id, i) => [id, i])))
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the shelf order.')
    } finally {
      setSaving(false)
    }
  }

  const btn = 'w-11 h-11 grid place-items-center rounded-[10px] border border-line bg-paper text-ink-2 active:bg-bg-2 disabled:opacity-30'

  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center md:justify-center"
      onMouseDown={(e) => { (e.currentTarget as HTMLElement).dataset.mdown = String(e.target === e.currentTarget) }}
      onClick={(e) => { if (e.target === e.currentTarget && (e.currentTarget as HTMLElement).dataset.mdown === 'true' && !dirty) onClose() }}
    >
      <div className="absolute inset-0 bg-black/40 pointer-events-none" />
      <div
        className="relative bg-paper w-full md:max-w-lg rounded-t-2xl md:rounded-2xl flex flex-col max-h-[90vh]"
        onClick={e => e.stopPropagation()}
        role="dialog" aria-label="Shelf order"
      >
        <div className="px-5 pt-3 pb-3 border-b border-line">
          <div className="w-9 h-1 bg-line rounded-full mx-auto mb-3 md:hidden" />
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-[17px] text-ink tracking-[-0.02em]">Shelf order</h3>
            <button onClick={onClose} aria-label="Close" className="w-11 h-11 -mr-3 grid place-items-center">
              <X size={20} className="text-ink-4" />
            </button>
          </div>
          <p className="text-[14px] text-ink-3 mb-3">Put items in the order you walk past them. The count follows this order.</p>
          {areas.length > 1 && (
            <select
              value={areaId ?? ''}
              onChange={e => {
                if (dirty && !window.confirm('Drop the changes to this area?')) return
                setAreaId(e.target.value)
              }}
              aria-label="Area"
              className="w-full min-h-[44px] border border-line rounded-[10px] px-3 text-[16px] text-ink bg-paper focus:outline-none focus:ring-2 focus:ring-gold"
            >
              {areas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-2">
          {loading ? (
            <p className="text-[16px] text-ink-3 text-center py-8">Loading…</p>
          ) : items.length === 0 ? (
            <p className="text-[16px] text-ink-3 text-center py-8">{error ?? 'No items in this area.'}</p>
          ) : (
            <ol className="space-y-1.5">
              {items.map((it, i) => (
                <li key={it.id} className="flex items-center gap-2 px-2 py-1.5 rounded-[12px] border border-line bg-paper">
                  <span className="w-7 shrink-0 text-right font-mono text-[13px] text-ink-4">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[16px] text-ink leading-snug break-words">{it.itemName}</div>
                    <div className="text-[13px] text-ink-4">
                      {it.category}{it.shelfOrder == null && !dirty ? ' · not placed yet' : ''}
                    </div>
                  </div>
                  <button className={btn} onClick={() => move(i, 0)} disabled={i === 0} aria-label={`Move ${it.itemName} to top`}>
                    <ChevronsUp size={18} />
                  </button>
                  <button className={btn} onClick={() => move(i, i - 1)} disabled={i === 0} aria-label={`Move ${it.itemName} up`}>
                    <ArrowUp size={18} />
                  </button>
                  <button className={btn} onClick={() => move(i, i + 1)} disabled={i === items.length - 1} aria-label={`Move ${it.itemName} down`}>
                    <ArrowDown size={18} />
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className="px-5 pt-3 pb-6 md:pb-4 border-t border-line">
          {error && items.length > 0 && <p className="text-[14px] text-red mb-2">{error}</p>}
          <button
            onClick={save}
            disabled={saving || loading || items.length === 0 || !dirty}
            className="w-full min-h-[48px] rounded-[12px] bg-ink text-paper text-[16px] font-medium disabled:opacity-40"
          >
            {saving ? 'Saving…' : dirty ? 'Save shelf order' : 'No changes'}
          </button>
        </div>
      </div>
    </div>
  )
}
