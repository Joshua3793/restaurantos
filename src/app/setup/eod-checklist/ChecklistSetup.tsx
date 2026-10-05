'use client'
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { PageHead } from '@/components/layout/PageHead'
import { useRc } from '@/contexts/RevenueCenterContext'
import {
  ChecklistItem, SectionBlock, ItemFormModal, QuickAddForm, ItemFormData,
} from './editor'

// Module-scope default: an inline default would be a new function every render,
// re-firing the loader effect in a loop.
const asItems = (d: unknown) => d as ChecklistItem[]

/**
 * One checklist-template editor, two lists: the end-of-day close
 * (/api/eod/checklist) and the opening checklist (/api/open-checklist). Both
 * APIs share the item shape and the POST / PATCH [id] / DELETE [id] /
 * PATCH reorder routes; only the wording differs.
 */
export function ChecklistSetup({ apiBase, crumbs, title, sub, blockerShort, blockerLabel, listItems = asItems }: {
  apiBase: string
  crumbs: ReactNode
  title: string
  sub: ReactNode
  blockerShort?: string
  blockerLabel?: string
  /** The GET payload → items (the opening list wraps them in `{ items }`). */
  listItems?: (data: unknown) => ChecklistItem[]
}) {
  const { revenueCenters } = useRc()
  const [rcId, setRcId] = useState<string | null>(null)
  const [items, setItems] = useState<ChecklistItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<ChecklistItem | null>(null)

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
      const res = await fetch(`${apiBase}?rcId=${id}`)
      if (!res.ok) throw new Error(`Failed to load (${res.status})`)
      setItems(listItems(await res.json()))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [apiBase, listItems])

  useEffect(() => { if (rcId) load(rcId) }, [rcId, load])

  // Group by section, preserving first-appearance order.
  const sectionOrder: string[] = []
  const bySection: Record<string, ChecklistItem[]> = {}
  for (const item of items) {
    if (!bySection[item.section]) { bySection[item.section] = []; sectionOrder.push(item.section) }
    bySection[item.section].push(item)
  }
  const knownSections = sectionOrder

  const refetch = () => { if (rcId) load(rcId) }

  const handleAdd = async (data: ItemFormData): Promise<string | void> => {
    if (!rcId) return 'No revenue center selected'
    const res = await fetch(apiBase, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revenueCenterId: rcId,
        section: data.section.trim(),
        title: data.title.trim(),
        meta: data.meta.trim() || null,
        isBlocker: data.isBlocker,
      }),
    })
    if (!res.ok) { const d = await res.json().catch(() => ({})); return d.error || 'Failed to create item' }
    refetch()
  }

  const handleEditSave = async (data: ItemFormData): Promise<string | void> => {
    if (!editing) return
    const res = await fetch(`${apiBase}/${editing.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        section: data.section.trim(),
        title: data.title.trim(),
        meta: data.meta.trim() || null,
        isBlocker: data.isBlocker,
      }),
    })
    if (!res.ok) { const d = await res.json().catch(() => ({})); return d.error || 'Failed to update item' }
    refetch()
  }

  const handleDelete = async (item: ChecklistItem) => {
    if (!confirm(`Delete "${item.title}"?`)) return
    const res = await fetch(`${apiBase}/${item.id}`, { method: 'DELETE' })
    if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.error || 'Failed to delete item'); return }
    setError('')
    refetch()
  }

  const handleMove = async (item: ChecklistItem, direction: 'up' | 'down') => {
    const idx = items.findIndex(i => i.id === item.id)
    const swapWith = direction === 'up' ? idx - 1 : idx + 1
    if (idx < 0 || swapWith < 0 || swapWith >= items.length) return
    const next = [...items]
    const tmp = next[idx]
    next[idx] = next[swapWith]
    next[swapWith] = tmp
    setItems(next) // optimistic reorder for snappy up/down
    const res = await fetch(`${apiBase}/reorder`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: next.map(i => i.id) }),
    })
    if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.error || 'Failed to reorder'); }
    refetch()
  }

  return (
    <div>
      <PageHead
        crumbs={crumbs}
        title={title}
        sub={sub}
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

      <div className="max-w-2xl space-y-5">
        <QuickAddForm sections={knownSections} onAdd={handleAdd} blockerShort={blockerShort} />

        {loading ? (
          <div className="text-sm text-ink-4 py-8 text-center">Loading…</div>
        ) : items.length === 0 ? (
          <div className="text-sm text-ink-4 py-8 text-center">No checklist items yet — add one above.</div>
        ) : (
          <div className="space-y-5">
            {sectionOrder.map(section => (
              <SectionBlock
                key={section}
                section={section}
                items={bySection[section]}
                onEdit={setEditing}
                onDelete={handleDelete}
                onMove={handleMove}
                blockerShort={blockerShort}
              />
            ))}
          </div>
        )}
      </div>

      {editing && (
        <ItemFormModal
          initial={editing}
          sections={knownSections}
          onClose={() => setEditing(null)}
          onSave={handleEditSave}
          blockerLabel={blockerLabel}
        />
      )}
    </div>
  )
}
