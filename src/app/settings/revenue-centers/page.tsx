'use client'
import { useState } from 'react'
import { Plus, Pencil, Trash2, Star, User, Target, ChevronDown, ChevronUp } from 'lucide-react'
import { RC_COLORS, rcHex } from '@/lib/rc-colors'
import { useRc, RevenueCenter } from '@/contexts/RevenueCenterContext'

const RC_TYPES = [
  { value: 'restaurant', label: 'Restaurant Service' },
  { value: 'catering',   label: 'Catering' },
  { value: 'events',     label: 'Events' },
  { value: 'retail',     label: 'Retail' },
  { value: 'other',      label: 'Other' },
] as const

interface RcFormData {
  name: string
  color: string
  isDefault: boolean
  isActive: boolean
  type: string
  description: string
  managerName: string
  targetFoodCostPct: string
  notes: string
}

const EMPTY_FORM: RcFormData = {
  name: '', color: 'blue', isDefault: false, isActive: true,
  type: 'other', description: '', managerName: '', targetFoodCostPct: '', notes: '',
}

function RcFormModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: RevenueCenter | null
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<RcFormData>(
    initial
      ? {
          name:              initial.name,
          color:             initial.color,
          isDefault:         initial.isDefault,
          isActive:          initial.isActive,
          type:              initial.type || 'other',
          description:       initial.description       ?? '',
          managerName:       initial.managerName       ?? '',
          targetFoodCostPct: initial.targetFoodCostPct != null ? String(parseFloat(initial.targetFoodCostPct)) : '',
          notes:             initial.notes             ?? '',
        }
      : EMPTY_FORM
  )
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim()) { setError('Name is required'); return }
    setSaving(true)
    const payload = {
      ...form,
      targetFoodCostPct: form.targetFoodCostPct !== '' ? parseFloat(form.targetFoodCostPct) : null,
      description:  form.description  || null,
      managerName:  form.managerName  || null,
      notes:        form.notes        || null,
    }
    const res = await fetch(
      initial ? `/api/revenue-centers/${initial.id}` : '/api/revenue-centers',
      { method: initial ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
    )
    setSaving(false)
    if (!res.ok) { const d = await res.json(); setError(d.error || 'Failed'); return }
    onSaved()
    onClose()
  }

  const f = (key: keyof RcFormData, val: string | boolean) =>
    setForm(prev => ({ ...prev, [key]: val }))

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-50" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
        <div className="bg-white w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl shadow-xl max-h-[90vh] overflow-y-auto">
          <div className="sticky top-0 bg-white px-5 pt-5 pb-3 border-b border-gray-100">
            <h3 className="font-semibold text-gray-900">
              {initial ? 'Edit Revenue Center' : 'New Revenue Center'}
            </h3>
          </div>

          <form onSubmit={handleSubmit} className="p-5 space-y-4">
            {/* Name */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Name *</label>
              <input
                autoFocus
                value={form.name}
                onChange={e => f('name', e.target.value)}
                placeholder="e.g. Catering, Events..."
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
              />
            </div>

            {/* Type */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Type</label>
              <select
                value={form.type}
                onChange={e => f('type', e.target.value)}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gold"
              >
                {RC_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>

            {/* Color */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-2">Color</label>
              <div className="grid grid-cols-8 gap-2">
                {RC_COLORS.map(c => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => f('color', c)}
                    className={`w-7 h-7 rounded-full transition-transform ${form.color === c ? 'ring-2 ring-offset-2 ring-gray-400 scale-110' : ''}`}
                    style={{ backgroundColor: rcHex(c) }}
                  />
                ))}
              </div>
            </div>

            {/* Description */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Description</label>
              <input
                value={form.description}
                onChange={e => f('description', e.target.value)}
                placeholder="What does this revenue center handle?"
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
              />
            </div>

            {/* Manager + Target food cost */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Manager</label>
                <input
                  value={form.managerName}
                  onChange={e => f('managerName', e.target.value)}
                  placeholder="Name"
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Target Food Cost %</label>
                <div className="relative">
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.1"
                    value={form.targetFoodCostPct}
                    onChange={e => f('targetFoodCostPct', e.target.value)}
                    placeholder="e.g. 28"
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 pr-7 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">%</span>
                </div>
              </div>
            </div>

            {/* Notes */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Notes</label>
              <textarea
                value={form.notes}
                onChange={e => f('notes', e.target.value)}
                placeholder="Any internal notes..."
                rows={2}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold resize-none"
              />
            </div>

            {/* Toggles */}
            <div className="flex flex-col gap-2 pt-1">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.isDefault}
                  onChange={e => f('isDefault', e.target.checked)}
                  className="rounded border-gray-300"
                />
                <span className="text-sm text-gray-700">Set as default revenue center</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={e => f('isActive', e.target.checked)}
                  className="rounded border-gray-300"
                />
                <span className="text-sm text-gray-700">Active</span>
              </label>
            </div>

            {error && <p className="text-xs text-red-500">{error}</p>}

            <div className="flex gap-2 pt-1">
              <button
                type="submit"
                disabled={saving}
                className="flex-1 py-2.5 bg-gray-900 text-white text-sm font-medium rounded-xl hover:bg-gray-800 disabled:opacity-50"
              >
                {saving ? 'Saving…' : initial ? 'Save Changes' : 'Create'}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 border border-gray-200 rounded-xl text-sm text-gray-600 hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  )
}

function RcCard({ rc, onEdit, onDelete }: { rc: RevenueCenter; onEdit: () => void; onDelete: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const typeLabel = RC_TYPES.find(t => t.value === rc.type)?.label ?? rc.type
  const hasDetails = rc.description || rc.managerName || rc.targetFoodCostPct || rc.notes

  return (
    <div className={`bg-white border rounded-2xl overflow-hidden transition-all ${rc.isActive ? 'border-gray-100' : 'border-gray-200 opacity-60'}`}>
      {/* Color accent bar */}
      <div className="h-1.5" style={{ backgroundColor: rcHex(rc.color) }} />

      <div className="p-4">
        <div className="flex items-start gap-3">
          <span className="w-10 h-10 rounded-xl shrink-0 flex items-center justify-center text-white font-bold text-lg"
            style={{ backgroundColor: rcHex(rc.color) }}>
            {rc.name[0].toUpperCase()}
          </span>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold text-gray-900">{rc.name}</h3>
              {rc.isDefault && (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded-full">
                  <Star size={9} /> Default
                </span>
              )}
              {!rc.isActive && (
                <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded-full">
                  Inactive
                </span>
              )}
              <span className="text-[10px] font-medium text-gray-400 bg-gray-50 px-1.5 py-0.5 rounded-full border border-gray-100">
                {typeLabel}
              </span>
            </div>

            {rc.description && (
              <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{rc.description}</p>
            )}

            {/* Key info row */}
            <div className="flex flex-wrap gap-3 mt-2">
              {rc.managerName && (
                <span className="flex items-center gap-1 text-xs text-gray-500">
                  <User size={11} /> {rc.managerName}
                </span>
              )}
              {rc.targetFoodCostPct != null && (
                <span className="flex items-center gap-1 text-xs text-gray-500">
                  <Target size={11} /> {parseFloat(rc.targetFoodCostPct)}% food cost target
                </span>
              )}
            </div>

            {rc.notes && (
              <div className="mt-2">
                {expanded ? (
                  <p className="text-xs text-gray-400 leading-relaxed">{rc.notes}</p>
                ) : null}
                <button
                  onClick={() => setExpanded(e => !e)}
                  className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-600 mt-1"
                >
                  {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                  {expanded ? 'Hide notes' : 'Show notes'}
                </button>
              </div>
            )}
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={onEdit}
              className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
              title="Edit"
            >
              <Pencil size={14} />
            </button>
            <button
              onClick={onDelete}
              className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
              title="Delete"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function RevenueCentersPage() {
  const { revenueCenters, reload } = useRc()
  const [editTarget, setEditTarget] = useState<RevenueCenter | null>(null)
  const [showForm, setShowForm]     = useState(false)
  const [deleteError, setDeleteError] = useState('')

  const handleDelete = async (rc: RevenueCenter) => {
    if (!confirm(`Delete "${rc.name}"?`)) return
    const res = await fetch(`/api/revenue-centers/${rc.id}`, { method: 'DELETE' })
    if (!res.ok) { const d = await res.json(); setDeleteError(d.error || 'Failed to delete'); return }
    setDeleteError('')
    reload()
  }

  const openAdd  = () => { setEditTarget(null); setShowForm(true) }
  const openEdit = (rc: RevenueCenter) => { setEditTarget(rc); setShowForm(true) }

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Revenue Centers</h1>
          <p className="text-sm text-gray-500 mt-0.5">{revenueCenters.length} center{revenueCenters.length !== 1 ? 's' : ''}</p>
        </div>
        <button
          onClick={openAdd}
          className="flex items-center gap-1.5 bg-gold text-white px-3 py-2 rounded-xl text-sm font-semibold hover:bg-[#a88930]"
        >
          <Plus size={16} /> Add
        </button>
      </div>

      {deleteError && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          {deleteError}
        </div>
      )}

      <div className="space-y-3">
        {revenueCenters.map(rc => (
          <RcCard
            key={rc.id}
            rc={rc}
            onEdit={() => openEdit(rc)}
            onDelete={() => handleDelete(rc)}
          />
        ))}
      </div>

      {showForm && (
        <RcFormModal
          initial={editTarget}
          onClose={() => setShowForm(false)}
          onSaved={reload}
        />
      )}
    </div>
  )
}
