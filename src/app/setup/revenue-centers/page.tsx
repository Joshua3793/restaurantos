'use client'
import { useState, useEffect, useCallback } from 'react'
import { Plus, Pencil, Trash2, Star, User, Target, ChevronDown, ChevronUp, Clock, Copy, X, MapPin, UtensilsCrossed, Wine } from 'lucide-react'
import type { ServiceSchedule, ServiceWindow } from '@/lib/service-hours'
import { fmtWindow, fmtDuration, dayIndex } from '@/lib/service-hours'
import { RC_COLORS, rcHex } from '@/lib/rc-colors'
import { getVocab } from '@/lib/rc-vocab'
import { useRc } from '@/contexts/RevenueCenterContext'

// The /api/locations payload includes the schedule fields (which the context's
// slimmer Location type omits) — type them locally here.
interface ApiRevenueCenter {
  id: string
  name: string
  color: string
  isDefault: boolean
  isActive: boolean
  type: string                       // 'FOOD' | 'DRINK'
  locationId: string
  description: string | null
  managerName: string | null
  targetFoodCostPct: string | null
  targetCostPct: string | null
  notes: string | null
  createdAt: string
}

interface ApiLocation {
  id: string
  name: string
  color: string
  type: string                       // 'restaurant' | 'catering' | 'other'
  isDefault: boolean
  isActive: boolean
  description: string | null
  managerName: string | null
  notes: string | null
  defaultRevenueCenterId: string | null
  schedulingMode: string             // 'FIXED' | 'ON_DEMAND'
  prepLeadMinutes: number | null
  serviceSchedule: ServiceSchedule | null
  createdAt: string
  revenueCenters: ApiRevenueCenter[]
}

const LOCATION_TYPES = [
  { value: 'restaurant', label: 'Restaurant' },
  { value: 'catering',   label: 'Catering' },
  { value: 'other',      label: 'Other' },
] as const

const RC_TYPES = [
  { value: 'FOOD',  label: 'Food' },
  { value: 'DRINK', label: 'Drink / Bar' },
] as const

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const
const EMPTY_WINDOW: ServiceWindow = { label: '', start: '17:00', end: '22:00' }

/* ─────────────────────────  Service schedule editor  ───────────────────────── */

function ServiceScheduleEditor({
  schedule,
  onChange,
}: {
  schedule: ServiceSchedule
  onChange: (next: ServiceSchedule) => void
}) {
  const dayWindows = (idx: number): ServiceWindow[] => schedule[String(idx)] ?? []

  const setDay = (idx: number, windows: ServiceWindow[]) => {
    const next = { ...schedule }
    if (windows.length) next[String(idx)] = windows
    else delete next[String(idx)]
    onChange(next)
  }

  const addWindow = (idx: number) => setDay(idx, [...dayWindows(idx), { ...EMPTY_WINDOW }])
  const removeWindow = (idx: number, wi: number) => setDay(idx, dayWindows(idx).filter((_, i) => i !== wi))
  const editWindow = (idx: number, wi: number, key: keyof ServiceWindow, val: string) =>
    setDay(idx, dayWindows(idx).map((w, i) => (i === wi ? { ...w, [key]: val } : w)))

  const copyMondayToAll = () => {
    const mon = dayWindows(0)
    const next: ServiceSchedule = {}
    for (let i = 0; i < 7; i++) if (mon.length) next[String(i)] = mon.map(w => ({ ...w }))
    onChange(next)
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="block text-xs font-medium text-ink-3">Weekly service hours</label>
        <button type="button" onClick={copyMondayToAll}
          className="flex items-center gap-1 text-[11px] text-ink-4 hover:text-ink-2">
          <Copy size={11} /> Copy Mon → all
        </button>
      </div>
      {DAY_LABELS.map((label, idx) => {
        const windows = dayWindows(idx)
        return (
          <div key={label} className="border border-line rounded-xl p-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-ink-2 w-10">{label}</span>
              {windows.length === 0 && <span className="text-[11px] text-ink-4">Closed</span>}
              <button type="button" onClick={() => addWindow(idx)}
                className="flex items-center gap-1 text-[11px] text-gold hover:text-gold-2">
                <Plus size={11} /> Window
              </button>
            </div>
            {windows.map((w, wi) => (
              <div key={wi} className="flex items-center gap-1.5 mt-2">
                <input
                  value={w.label}
                  onChange={e => editWindow(idx, wi, 'label', e.target.value)}
                  placeholder="Lunch"
                  className="flex-1 min-w-0 border border-line rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-gold"
                />
                <input type="time" value={w.start} onChange={e => editWindow(idx, wi, 'start', e.target.value)}
                  className="border border-line rounded-lg px-1.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-gold" />
                <span className="text-ink-4 text-xs">–</span>
                <input type="time" value={w.end} onChange={e => editWindow(idx, wi, 'end', e.target.value)}
                  className="border border-line rounded-lg px-1.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-gold" />
                <button type="button" onClick={() => removeWindow(idx, wi)}
                  className="p-1 text-ink-4 hover:text-red">
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}

/* ──────────────────────────────  Location form  ────────────────────────────── */

interface LocationFormData {
  name: string
  color: string
  type: string
  isDefault: boolean
  isActive: boolean
  description: string
  managerName: string
  notes: string
  defaultRevenueCenterId: string
  schedulingMode: 'FIXED' | 'ON_DEMAND'
  prepLeadH: string
  prepLeadM: string
  schedule: ServiceSchedule
}

const EMPTY_LOCATION_FORM: LocationFormData = {
  name: '', color: 'blue', type: 'restaurant', isDefault: false, isActive: true,
  description: '', managerName: '', notes: '', defaultRevenueCenterId: '',
  schedulingMode: 'FIXED', prepLeadH: '', prepLeadM: '', schedule: {},
}

function LocationFormModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: ApiLocation | null
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<LocationFormData>(
    initial
      ? {
          name:           initial.name,
          color:          initial.color,
          type:           initial.type || 'restaurant',
          isDefault:      initial.isDefault,
          isActive:       initial.isActive,
          description:    initial.description ?? '',
          managerName:    initial.managerName ?? '',
          notes:          initial.notes ?? '',
          defaultRevenueCenterId: initial.defaultRevenueCenterId ?? '',
          schedulingMode: initial.schedulingMode === 'ON_DEMAND' ? 'ON_DEMAND' : 'FIXED',
          prepLeadH:      initial.prepLeadMinutes != null ? String(Math.floor(initial.prepLeadMinutes / 60)) : '',
          prepLeadM:      initial.prepLeadMinutes != null ? String(initial.prepLeadMinutes % 60) : '',
          schedule:       initial.serviceSchedule ?? {},
        }
      : EMPTY_LOCATION_FORM
  )
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')

  const f = (key: keyof LocationFormData, val: string | boolean) =>
    setForm(prev => ({ ...prev, [key]: val }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim()) { setError('Name is required'); return }
    setSaving(true)
    const prepLeadMinutes =
      form.prepLeadH === '' && form.prepLeadM === ''
        ? null
        : (parseInt(form.prepLeadH || '0', 10) * 60) + parseInt(form.prepLeadM || '0', 10)
    const payload: Record<string, unknown> = {
      name: form.name.trim(),
      color: form.color,
      type: form.type,
      isDefault: form.isDefault,
      isActive: form.isActive,
      description: form.description || null,
      managerName: form.managerName || null,
      notes: form.notes || null,
      schedulingMode: form.schedulingMode,
      prepLeadMinutes,
      serviceSchedule: form.schedulingMode === 'ON_DEMAND' ? null : form.schedule,
    }
    // Default RC only applies once the location has child RCs (edit flow).
    if (initial) payload.defaultRevenueCenterId = form.defaultRevenueCenterId || null
    const res = await fetch(
      initial ? `/api/locations/${initial.id}` : '/api/locations',
      { method: initial ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
    )
    setSaving(false)
    if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.error || 'Failed'); return }
    onSaved()
    onClose()
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-50" onClick={onClose} />
      <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4">
        <div className="bg-white w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl shadow-xl max-h-[90vh] overflow-y-auto">
          <div className="sticky top-0 bg-white px-5 pt-5 pb-3 border-b border-line">
            <h3 className="font-semibold text-ink">{initial ? 'Edit Location' : 'New Location'}</h3>
          </div>

          <form onSubmit={handleSubmit} className="p-5 space-y-4">
            <div>
              <label className="block text-xs font-medium text-ink-3 mb-1">Name *</label>
              <input
                autoFocus
                value={form.name}
                onChange={e => f('name', e.target.value)}
                placeholder="e.g. Main Kitchen, Catering HQ..."
                className="w-full border border-line rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-ink-3 mb-1">Type</label>
              <select
                value={form.type}
                onChange={e => f('type', e.target.value)}
                className="w-full border border-line rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gold"
              >
                {LOCATION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-ink-3 mb-2">Color</label>
              <div className="grid grid-cols-8 gap-2">
                {RC_COLORS.map(c => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => f('color', c)}
                    className={`w-7 h-7 rounded-full transition-transform ${form.color === c ? 'ring-2 ring-offset-2 ring-line-2 scale-110' : ''}`}
                    style={{ backgroundColor: rcHex(c) }}
                  />
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-ink-3 mb-1">Description</label>
              <input
                value={form.description}
                onChange={e => f('description', e.target.value)}
                placeholder="What is this location?"
                className="w-full border border-line rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-ink-3 mb-1">Manager</label>
              <input
                value={form.managerName}
                onChange={e => f('managerName', e.target.value)}
                placeholder="Name"
                className="w-full border border-line rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-ink-3 mb-1">Notes</label>
              <textarea
                value={form.notes}
                onChange={e => f('notes', e.target.value)}
                placeholder="Any internal notes..."
                rows={2}
                className="w-full border border-line rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold resize-none"
              />
            </div>

            {/* Default revenue center — only meaningful once the location has child RCs */}
            {initial && (
              <div>
                <label className="block text-xs font-medium text-ink-3 mb-1">Default revenue center</label>
                {initial.revenueCenters.length === 0 ? (
                  <p className="text-xs text-ink-4">Add a revenue center first.</p>
                ) : (
                  <>
                    <select
                      value={form.defaultRevenueCenterId}
                      onChange={e => f('defaultRevenueCenterId', e.target.value)}
                      className="w-full border border-line rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gold"
                    >
                      <option value="">None</option>
                      {initial.revenueCenters.map(rc => (
                        <option key={rc.id} value={rc.id}>{rc.name}</option>
                      ))}
                    </select>
                    <p className="text-xs text-ink-4 mt-1">Toast sales not matched to a specific menu route go here.</p>
                  </>
                )}
              </div>
            )}

            {/* Scheduling — lives on the Location */}
            <div className="pt-2 border-t border-line space-y-3">
              <div className="flex items-center gap-1.5">
                <Clock size={13} className="text-ink-4" />
                <span className="text-xs font-semibold text-ink-2">Service hours &amp; prep timing</span>
              </div>

              <div className="flex gap-1.5">
                {(['FIXED', 'ON_DEMAND'] as const).map(mode => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => f('schedulingMode', mode)}
                    className={`flex-1 py-2 text-xs font-medium rounded-xl border transition-colors ${
                      form.schedulingMode === mode
                        ? 'border-gold bg-gold/10 text-ink'
                        : 'border-line text-ink-3 hover:bg-bg'
                    }`}
                  >
                    {mode === 'FIXED' ? 'Fixed hours' : 'On-demand / by booking'}
                  </button>
                ))}
              </div>

              <div>
                <label className="block text-xs font-medium text-ink-3 mb-1">Prep lead before service</label>
                <div className="flex items-center gap-2">
                  <input type="number" min="0" value={form.prepLeadH}
                    onChange={e => f('prepLeadH', e.target.value)} placeholder="0"
                    className="w-16 border border-line rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                  <span className="text-xs text-ink-4">h</span>
                  <input type="number" min="0" max="59" value={form.prepLeadM}
                    onChange={e => f('prepLeadM', e.target.value)} placeholder="0"
                    className="w-16 border border-line rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                  <span className="text-xs text-ink-4">m</span>
                </div>
              </div>

              {form.schedulingMode === 'FIXED' && (
                <ServiceScheduleEditor
                  schedule={form.schedule}
                  onChange={next => setForm(prev => ({ ...prev, schedule: next }))}
                />
              )}
            </div>

            <div className="flex flex-col gap-2 pt-1">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form.isDefault}
                  onChange={e => f('isDefault', e.target.checked)} className="rounded border-line-2" />
                <span className="text-sm text-ink-2">Set as default location</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form.isActive}
                  onChange={e => f('isActive', e.target.checked)} className="rounded border-line-2" />
                <span className="text-sm text-ink-2">Active</span>
              </label>
            </div>

            {error && <p className="text-xs text-red">{error}</p>}

            <div className="flex gap-2 pt-1 pb-[env(safe-area-inset-bottom)]">
              <button type="submit" disabled={saving}
                className="flex-1 py-2.5 bg-ink text-white text-sm font-medium rounded-xl hover:bg-ink disabled:opacity-50">
                {saving ? 'Saving…' : initial ? 'Save Changes' : 'Create'}
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

/* ────────────────────────────  Revenue-center form  ─────────────────────────── */

interface RcFormData {
  name: string
  color: string
  type: string                  // FOOD | DRINK
  targetCostPct: string
  isDefault: boolean
  isActive: boolean
  description: string
  managerName: string
  notes: string
}

const EMPTY_RC_FORM: RcFormData = {
  name: '', color: 'blue', type: 'FOOD', targetCostPct: '',
  isDefault: false, isActive: true, description: '', managerName: '', notes: '',
}

function RcFormModal({
  locationId,
  locationName,
  initial,
  onClose,
  onSaved,
}: {
  locationId: string
  locationName: string
  initial: ApiRevenueCenter | null
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<RcFormData>(
    initial
      ? {
          name:          initial.name,
          color:         initial.color,
          type:          initial.type === 'DRINK' ? 'DRINK' : 'FOOD',
          targetCostPct: initial.targetCostPct != null
            ? String(parseFloat(initial.targetCostPct))
            : initial.targetFoodCostPct != null ? String(parseFloat(initial.targetFoodCostPct)) : '',
          isDefault:     initial.isDefault,
          isActive:      initial.isActive,
          description:   initial.description ?? '',
          managerName:   initial.managerName ?? '',
          notes:         initial.notes ?? '',
        }
      : EMPTY_RC_FORM
  )
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')

  const f = (key: keyof RcFormData, val: string | boolean) =>
    setForm(prev => ({ ...prev, [key]: val }))

  const vocab = getVocab(form.type)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim()) { setError('Name is required'); return }
    setSaving(true)
    // CRITICAL: create must include locationId or POST /api/revenue-centers 400s.
    const payload: Record<string, unknown> = {
      locationId,
      name: form.name.trim(),
      color: form.color,
      type: form.type,
      targetCostPct: form.targetCostPct !== '' ? parseFloat(form.targetCostPct) : null,
      isDefault: form.isDefault,
      isActive: form.isActive,
      description: form.description || null,
      managerName: form.managerName || null,
      notes: form.notes || null,
    }
    const res = await fetch(
      initial ? `/api/revenue-centers/${initial.id}` : '/api/revenue-centers',
      { method: initial ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
    )
    setSaving(false)
    if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.error || 'Failed'); return }
    onSaved()
    onClose()
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-50" onClick={onClose} />
      <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4">
        <div className="bg-white w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl shadow-xl max-h-[90vh] overflow-y-auto">
          <div className="sticky top-0 bg-white px-5 pt-5 pb-3 border-b border-line">
            <h3 className="font-semibold text-ink">{initial ? 'Edit Revenue Center' : 'New Revenue Center'}</h3>
            <p className="text-xs text-ink-4 mt-0.5">in {locationName}</p>
          </div>

          <form onSubmit={handleSubmit} className="p-5 space-y-4">
            <div>
              <label className="block text-xs font-medium text-ink-3 mb-1">Name *</label>
              <input
                autoFocus
                value={form.name}
                onChange={e => f('name', e.target.value)}
                placeholder="e.g. Bar, Dining Room, Catering..."
                className="w-full border border-line rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
              />
            </div>

            {/* Type FOOD | DRINK */}
            <div>
              <label className="block text-xs font-medium text-ink-3 mb-1">Type</label>
              <div className="flex gap-1.5">
                {RC_TYPES.map(t => (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => f('type', t.value)}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium rounded-xl border transition-colors ${
                      form.type === t.value
                        ? 'border-gold bg-gold/10 text-ink'
                        : 'border-line text-ink-3 hover:bg-bg'
                    }`}
                  >
                    {t.value === 'DRINK' ? <Wine size={13} /> : <UtensilsCrossed size={13} />}
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-ink-3 mb-2">Color</label>
              <div className="grid grid-cols-8 gap-2">
                {RC_COLORS.map(c => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => f('color', c)}
                    className={`w-7 h-7 rounded-full transition-transform ${form.color === c ? 'ring-2 ring-offset-2 ring-line-2 scale-110' : ''}`}
                    style={{ backgroundColor: rcHex(c) }}
                  />
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-ink-3 mb-1">Description</label>
              <input
                value={form.description}
                onChange={e => f('description', e.target.value)}
                placeholder="What does this revenue center handle?"
                className="w-full border border-line rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-ink-3 mb-1">Manager</label>
                <input
                  value={form.managerName}
                  onChange={e => f('managerName', e.target.value)}
                  placeholder="Name"
                  className="w-full border border-line rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-3 mb-1">{vocab.targetLabel}</label>
                <div className="relative">
                  <input
                    type="number" min="0" max="100" step="0.1"
                    value={form.targetCostPct}
                    onChange={e => f('targetCostPct', e.target.value)}
                    placeholder="e.g. 28"
                    className="w-full border border-line rounded-xl px-3 py-2 pr-7 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-ink-4">%</span>
                </div>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-ink-3 mb-1">Notes</label>
              <textarea
                value={form.notes}
                onChange={e => f('notes', e.target.value)}
                placeholder="Any internal notes..."
                rows={2}
                className="w-full border border-line rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold resize-none"
              />
            </div>

            <div className="flex flex-col gap-2 pt-1">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form.isDefault}
                  onChange={e => f('isDefault', e.target.checked)} className="rounded border-line-2" />
                <span className="text-sm text-ink-2">Set as default revenue center</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form.isActive}
                  onChange={e => f('isActive', e.target.checked)} className="rounded border-line-2" />
                <span className="text-sm text-ink-2">Active</span>
              </label>
            </div>

            {error && <p className="text-xs text-red">{error}</p>}

            <div className="flex gap-2 pt-1 pb-[env(safe-area-inset-bottom)]">
              <button type="submit" disabled={saving}
                className="flex-1 py-2.5 bg-ink text-white text-sm font-medium rounded-xl hover:bg-ink disabled:opacity-50">
                {saving ? 'Saving…' : initial ? 'Save Changes' : 'Create'}
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

/* ──────────────────────────────  RC row (compact)  ──────────────────────────── */

function RcRow({ rc, onEdit, onDelete }: {
  rc: ApiRevenueCenter; onEdit: () => void; onDelete: () => void
}) {
  const target = rc.targetCostPct != null
    ? parseFloat(rc.targetCostPct)
    : rc.targetFoodCostPct != null ? parseFloat(rc.targetFoodCostPct) : null
  const isDrink = rc.type === 'DRINK'
  const vocab = getVocab(rc.type)

  return (
    <div className={`flex items-center gap-3 py-2.5 px-3 rounded-xl border border-line bg-white ${rc.isActive ? '' : 'opacity-60'}`}>
      <span className="w-7 h-7 rounded-lg shrink-0 flex items-center justify-center text-white font-bold text-sm"
        style={{ backgroundColor: rcHex(rc.color) }}>
        {rc.name[0].toUpperCase()}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-ink truncate">{rc.name}</span>
          {rc.isDefault && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-gold bg-gold-soft px-1.5 py-0.5 rounded-full">
              <Star size={9} /> Default
            </span>
          )}
          <span className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full ${
            isDrink ? 'bg-blue-soft text-blue-text' : 'bg-bg-2 text-ink-3'
          }`}>
            {isDrink ? <Wine size={9} /> : <UtensilsCrossed size={9} />} {isDrink ? 'Drink' : 'Food'}
          </span>
          {!rc.isActive && (
            <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-4 bg-bg-2 px-1.5 py-0.5 rounded-full">
              Inactive
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-3 mt-0.5">
          {rc.managerName && (
            <span className="flex items-center gap-1 text-[11px] text-ink-4"><User size={10} /> {rc.managerName}</span>
          )}
          {target != null && (
            <span className="flex items-center gap-1 text-[11px] text-ink-4">
              <Target size={10} /> {target}% {vocab.costPctLabel.toLowerCase()} target
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button onClick={onEdit} title="Edit"
          className="p-1.5 text-ink-4 hover:text-ink-2 hover:bg-bg-2 rounded-lg transition-colors">
          <Pencil size={14} />
        </button>
        <button onClick={onDelete} title="Delete"
          className="p-1.5 text-ink-4 hover:text-red hover:bg-red-soft rounded-lg transition-colors">
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  )
}

/* ───────────────────────────────  Location card  ────────────────────────────── */

function LocationCard({
  loc, onEditLoc, onDeleteLoc, onAddRc, onEditRc, onDeleteRc,
}: {
  loc: ApiLocation
  onEditLoc: () => void
  onDeleteLoc: () => void
  onAddRc: () => void
  onEditRc: (rc: ApiRevenueCenter) => void
  onDeleteRc: (rc: ApiRevenueCenter) => void
}) {
  const [expanded, setExpanded] = useState(true)
  const typeLabel = LOCATION_TYPES.find(t => t.value === loc.type)?.label ?? loc.type
  const todayIdx = dayIndex(new Date())
  const todayWindows = loc.schedulingMode === 'FIXED' ? (loc.serviceSchedule?.[String(todayIdx)] ?? []) : []
  const prepLeadLabel = loc.prepLeadMinutes != null && loc.prepLeadMinutes > 0
    ? fmtDuration(loc.prepLeadMinutes * 60_000) : null
  const defaultRcName = loc.defaultRevenueCenterId
    ? loc.revenueCenters.find(rc => rc.id === loc.defaultRevenueCenterId)?.name ?? null
    : null

  return (
    <div className={`bg-white border rounded-2xl overflow-hidden transition-all ${loc.isActive ? 'border-line' : 'border-line opacity-60'}`}>
      <div className="h-1.5" style={{ backgroundColor: rcHex(loc.color) }} />
      <div className="p-4">
        <div className="flex items-start gap-3">
          <span className="w-10 h-10 rounded-xl shrink-0 flex items-center justify-center text-white"
            style={{ backgroundColor: rcHex(loc.color) }}>
            <MapPin size={18} />
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold text-ink">{loc.name}</h3>
              {loc.isDefault && (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-gold bg-gold-soft px-1.5 py-0.5 rounded-full">
                  <Star size={9} /> Default
                </span>
              )}
              {!loc.isActive && (
                <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-4 bg-bg-2 px-1.5 py-0.5 rounded-full">
                  Inactive
                </span>
              )}
              <span className="text-[10px] font-medium text-ink-4 bg-bg px-1.5 py-0.5 rounded-full border border-line">
                {typeLabel}
              </span>
            </div>
            {loc.description && <p className="text-xs text-ink-3 mt-0.5 leading-relaxed">{loc.description}</p>}

            <div className="flex flex-wrap gap-3 mt-2">
              {loc.managerName && (
                <span className="flex items-center gap-1 text-xs text-ink-3"><User size={11} /> {loc.managerName}</span>
              )}
              {defaultRcName && (
                <span className="flex items-center gap-1 text-xs text-ink-3"><Target size={11} /> Default: {defaultRcName}</span>
              )}
            </div>

            {/* Service row */}
            <div className="flex items-center gap-2 mt-2.5 flex-wrap">
              <span className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-ink-4 font-medium">
                <Clock size={11} /> Service
              </span>
              {loc.schedulingMode === 'ON_DEMAND' ? (
                <span className="inline-flex items-center gap-1.5 bg-bg border border-line rounded-lg px-2 py-1 text-[11.5px] text-ink-3">
                  By booking
                </span>
              ) : todayWindows.length === 0 ? (
                <span className="text-[11.5px] text-ink-4">Closed today</span>
              ) : (
                todayWindows.map((w, i) => (
                  <span key={i} className="inline-flex items-center gap-1.5 bg-bg border border-line rounded-lg px-2 py-1 text-[11.5px] text-ink-3">
                    <span className="font-semibold text-ink-2">{w.label}</span>
                    <span className="text-ink-4 font-mono text-[11px]">{fmtWindow(w)}</span>
                  </span>
                ))
              )}
              {prepLeadLabel && (
                <span className="inline-flex items-center gap-1.5 bg-bg border border-line rounded-lg px-2 py-1 text-[11.5px] text-ink-4">
                  Prep lead {prepLeadLabel}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button onClick={onEditLoc} title="Edit location"
              className="p-1.5 text-ink-4 hover:text-ink-2 hover:bg-bg-2 rounded-lg transition-colors">
              <Pencil size={14} />
            </button>
            <button onClick={onDeleteLoc} title="Delete location"
              className="p-1.5 text-ink-4 hover:text-red hover:bg-red-soft rounded-lg transition-colors">
              <Trash2 size={14} />
            </button>
          </div>
        </div>

        {/* Revenue centers under this location */}
        <div className="mt-3 pt-3 border-t border-line">
          <div className="flex items-center justify-between mb-2">
            <button onClick={() => setExpanded(e => !e)}
              className="flex items-center gap-1 text-xs font-semibold text-ink-3 hover:text-ink-2">
              {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              Revenue centers
              <span className="text-ink-4 font-normal">({loc.revenueCenters.length})</span>
            </button>
            <button onClick={onAddRc}
              className="flex items-center gap-1 text-xs font-medium text-gold hover:text-gold-2">
              <Plus size={13} /> Add RC
            </button>
          </div>
          {expanded && (
            loc.revenueCenters.length === 0 ? (
              <p className="text-xs text-ink-4 py-2">No revenue centers yet — add one above.</p>
            ) : (
              <div className="space-y-2">
                {loc.revenueCenters.map(rc => (
                  <RcRow key={rc.id} rc={rc} onEdit={() => onEditRc(rc)} onDelete={() => onDeleteRc(rc)} />
                ))}
              </div>
            )
          )}
        </div>
      </div>
    </div>
  )
}

/* ─────────────────────────────────  Page  ──────────────────────────────────── */

export default function LocationsAndRevenueCentersPage() {
  const { reload: reloadContext } = useRc()
  const [locations, setLocations] = useState<ApiLocation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Location form modal
  const [locForm, setLocForm] = useState<{ open: boolean; initial: ApiLocation | null }>({ open: false, initial: null })
  // RC form modal
  const [rcForm, setRcForm] = useState<{ open: boolean; locationId: string; locationName: string; initial: ApiRevenueCenter | null } | null>(null)

  const load = useCallback(async () => {
    setError('')
    try {
      const res = await fetch('/api/locations')
      if (!res.ok) throw new Error(`Failed to load (${res.status})`)
      setLocations(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Keep the global RC selector in sync after edits.
  const refreshAll = async () => { await load(); await reloadContext() }

  const handleDeleteLocation = async (loc: ApiLocation) => {
    if (!confirm(`Delete location "${loc.name}"?`)) return
    const res = await fetch(`/api/locations/${loc.id}`, { method: 'DELETE' })
    if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.error || 'Failed to delete'); return }
    setError('')
    refreshAll()
  }

  const handleDeleteRc = async (rc: ApiRevenueCenter) => {
    if (!confirm(`Delete revenue center "${rc.name}"?`)) return
    const res = await fetch(`/api/revenue-centers/${rc.id}`, { method: 'DELETE' })
    if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.error || 'Failed to delete'); return }
    setError('')
    refreshAll()
  }

  const rcCount = locations.reduce((n, l) => n + l.revenueCenters.length, 0)

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-ink">Locations &amp; Revenue Centers</h1>
          <p className="text-sm text-ink-3 mt-0.5">
            {locations.length} location{locations.length !== 1 ? 's' : ''} · {rcCount} revenue center{rcCount !== 1 ? 's' : ''}
          </p>
        </div>
        <button
          onClick={() => setLocForm({ open: true, initial: null })}
          className="flex items-center gap-1.5 bg-ink text-paper [&_svg]:text-gold px-3 py-2 rounded-xl text-sm font-semibold hover:bg-ink-2"
        >
          <Plus size={16} /> Location
        </button>
      </div>

      {error && (
        <div className="p-3 bg-red-soft border border-red-soft rounded-xl text-sm text-red-text">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-ink-4 py-8 text-center">Loading…</div>
      ) : locations.length === 0 ? (
        <div className="text-sm text-ink-4 py-8 text-center">No locations yet — add one to get started.</div>
      ) : (
        <div className="space-y-3">
          {locations.map(loc => (
            <LocationCard
              key={loc.id}
              loc={loc}
              onEditLoc={() => setLocForm({ open: true, initial: loc })}
              onDeleteLoc={() => handleDeleteLocation(loc)}
              onAddRc={() => setRcForm({ open: true, locationId: loc.id, locationName: loc.name, initial: null })}
              onEditRc={rc => setRcForm({ open: true, locationId: loc.id, locationName: loc.name, initial: rc })}
              onDeleteRc={handleDeleteRc}
            />
          ))}
        </div>
      )}

      {locForm.open && (
        <LocationFormModal
          initial={locForm.initial}
          onClose={() => setLocForm({ open: false, initial: null })}
          onSaved={refreshAll}
        />
      )}

      {rcForm?.open && (
        <RcFormModal
          locationId={rcForm.locationId}
          locationName={rcForm.locationName}
          initial={rcForm.initial}
          onClose={() => setRcForm(null)}
          onSaved={refreshAll}
        />
      )}
    </div>
  )
}
