'use client'
import { useState } from 'react'
import { Plus, Pencil, Trash2, ChevronUp, ChevronDown, ShieldAlert } from 'lucide-react'

export interface ChecklistItem {
  id: string
  revenueCenterId: string
  section: string
  title: string
  meta: string | null
  sortOrder: number
  isBlocker: boolean
}

/* ─────────────────────────────  Item row  ──────────────────────────────── */

export function ChecklistItemRow({
  item,
  isFirst,
  isLast,
  onEdit,
  onDelete,
  onMoveUp,
  onMoveDown,
}: {
  item: ChecklistItem
  isFirst: boolean
  isLast: boolean
  onEdit: () => void
  onDelete: () => void
  onMoveUp: () => void
  onMoveDown: () => void
}) {
  return (
    <div className="flex items-center gap-3 py-2.5 px-3 rounded-xl border border-line bg-paper">
      <div className="flex flex-col shrink-0">
        <button
          onClick={onMoveUp}
          disabled={isFirst}
          title="Move up"
          className="p-0.5 text-ink-4 hover:text-ink-2 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronUp size={13} />
        </button>
        <button
          onClick={onMoveDown}
          disabled={isLast}
          title="Move down"
          className="p-0.5 text-ink-4 hover:text-ink-2 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronDown size={13} />
        </button>
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-ink truncate">{item.title}</span>
          {item.isBlocker && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-red-text bg-red-soft px-1.5 py-0.5 rounded-full">
              <ShieldAlert size={9} /> Blocker
            </span>
          )}
        </div>
        {item.meta && <p className="text-[11.5px] text-ink-4 mt-0.5 leading-snug">{item.meta}</p>}
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <button onClick={onEdit} title="Edit"
          className="p-1.5 text-ink-4 hover:text-ink-2 hover:bg-bg-2 rounded-lg transition-colors">
          <Pencil size={14} />
        </button>
        <button onClick={onDelete} title="Delete"
          className="p-1.5 text-ink-4 hover:text-red-text hover:bg-red-soft rounded-lg transition-colors">
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  )
}

/* ─────────────────────────────  Section block  ─────────────────────────── */

export function SectionBlock({
  section,
  items,
  onEdit,
  onDelete,
  onMove,
}: {
  section: string
  items: ChecklistItem[]
  onEdit: (item: ChecklistItem) => void
  onDelete: (item: ChecklistItem) => void
  onMove: (item: ChecklistItem, direction: 'up' | 'down') => void
}) {
  return (
    <div className="space-y-2">
      <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-3">{section}</h3>
      <div className="space-y-1.5">
        {items.map((item, i) => (
          <ChecklistItemRow
            key={item.id}
            item={item}
            isFirst={i === 0}
            isLast={i === items.length - 1}
            onEdit={() => onEdit(item)}
            onDelete={() => onDelete(item)}
            onMoveUp={() => onMove(item, 'up')}
            onMoveDown={() => onMove(item, 'down')}
          />
        ))}
      </div>
    </div>
  )
}

/* ─────────────────────────────  Item form modal  ────────────────────────── */

export interface ItemFormData {
  section: string
  title: string
  meta: string
  isBlocker: boolean
}

export const EMPTY_ITEM_FORM: ItemFormData = { section: '', title: '', meta: '', isBlocker: false }

export function ItemFormModal({
  initial,
  sections,
  onClose,
  onSave,
}: {
  initial: ChecklistItem | null
  sections: string[]
  onClose: () => void
  onSave: (data: ItemFormData) => Promise<string | void>
}) {
  const [form, setForm] = useState<ItemFormData>(
    initial
      ? { section: initial.section, title: initial.title, meta: initial.meta ?? '', isBlocker: initial.isBlocker }
      : EMPTY_ITEM_FORM
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const f = (key: keyof ItemFormData, val: string | boolean) =>
    setForm(prev => ({ ...prev, [key]: val }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.section.trim()) { setError('Section is required'); return }
    if (!form.title.trim()) { setError('Title is required'); return }
    setSaving(true)
    const err = await onSave(form)
    setSaving(false)
    if (err) { setError(err); return }
    onClose()
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-50" onClick={onClose} />
      <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4">
        <div className="bg-paper w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl shadow-xl max-h-[90vh] overflow-y-auto">
          <div className="sticky top-0 bg-paper px-5 pt-5 pb-3 border-b border-line">
            <h3 className="font-semibold text-ink">{initial ? 'Edit checklist item' : 'New checklist item'}</h3>
          </div>

          <form onSubmit={handleSubmit} className="p-5 space-y-4">
            <div>
              <label className="block text-xs font-medium text-ink-3 mb-1">Section *</label>
              <input
                autoFocus
                list="eod-section-options"
                value={form.section}
                onChange={e => f('section', e.target.value)}
                placeholder="e.g. Kitchen, Bar, Front of House..."
                className="w-full border border-line rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
              />
              <datalist id="eod-section-options">
                {sections.map(s => <option key={s} value={s} />)}
              </datalist>
            </div>

            <div>
              <label className="block text-xs font-medium text-ink-3 mb-1">Title *</label>
              <input
                value={form.title}
                onChange={e => f('title', e.target.value)}
                placeholder="e.g. Wipe down line, Empty ice well..."
                className="w-full border border-line rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-ink-3 mb-1">Meta / notes</label>
              <input
                value={form.meta}
                onChange={e => f('meta', e.target.value)}
                placeholder="Optional detail shown under the title"
                className="w-full border border-line rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
              />
            </div>

            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.isBlocker}
                onChange={e => f('isBlocker', e.target.checked)} className="rounded border-line-2" />
              <span className="text-sm text-ink-2">Blocker (must be completed before close-out)</span>
            </label>

            {error && <p className="text-xs text-red-text">{error}</p>}

            <div className="flex gap-2 pt-1 pb-[env(safe-area-inset-bottom)]">
              <button type="submit" disabled={saving}
                className="flex-1 py-2.5 bg-ink text-paper text-sm font-medium rounded-xl hover:bg-ink-2 disabled:opacity-50">
                {saving ? 'Saving…' : initial ? 'Save changes' : 'Create'}
              </button>
              <button type="button" onClick={onClose}
                className="px-4 py-2 border border-line rounded-xl text-sm text-ink-3 hover:bg-bg">
                Cancel
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  )
}

/* ─────────────────────────────  Quick add bar  ──────────────────────────── */

export function QuickAddForm({
  sections,
  onAdd,
}: {
  sections: string[]
  onAdd: (data: ItemFormData) => Promise<string | void>
}) {
  const [form, setForm] = useState<ItemFormData>(EMPTY_ITEM_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const f = (key: keyof ItemFormData, val: string | boolean) =>
    setForm(prev => ({ ...prev, [key]: val }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.section.trim() || !form.title.trim()) { setError('Section and title are required'); return }
    setSaving(true)
    const err = await onAdd(form)
    setSaving(false)
    if (err) { setError(err); return }
    setForm(EMPTY_ITEM_FORM)
    setError('')
  }

  return (
    <form onSubmit={handleSubmit} className="bg-paper border border-line rounded-xl p-3 space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <div className="sm:col-span-1">
          <input
            list="eod-section-options"
            value={form.section}
            onChange={e => f('section', e.target.value)}
            placeholder="Section"
            className="w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
          />
          <datalist id="eod-section-options">
            {sections.map(s => <option key={s} value={s} />)}
          </datalist>
        </div>
        <div className="sm:col-span-2">
          <input
            value={form.title}
            onChange={e => f('title', e.target.value)}
            placeholder="Item title"
            className="w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <input
          value={form.meta}
          onChange={e => f('meta', e.target.value)}
          placeholder="Meta / notes (optional)"
          className="flex-1 border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
        />
        <label className="flex items-center gap-1.5 cursor-pointer shrink-0">
          <input type="checkbox" checked={form.isBlocker}
            onChange={e => f('isBlocker', e.target.checked)} className="rounded border-line-2" />
          <span className="text-xs text-ink-3">Blocker</span>
        </label>
        <button type="submit" disabled={saving}
          className="flex items-center gap-1.5 bg-ink text-paper [&_svg]:text-gold px-3 py-2 rounded-lg text-sm font-semibold hover:bg-ink-2 disabled:opacity-50 shrink-0">
          <Plus size={14} /> Add
        </button>
      </div>
      {error && <p className="text-xs text-red-text">{error}</p>}
    </form>
  )
}
