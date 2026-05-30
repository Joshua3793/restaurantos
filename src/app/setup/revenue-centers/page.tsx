'use client'
import { useState, useEffect } from 'react'
import { Plus, Pencil, Trash2, Star, User, Target, ChevronDown, ChevronUp, Clock, Copy, X } from 'lucide-react'
import type { ServiceSchedule, ServiceWindow } from '@/lib/service-hours'
import { fmtWindow, fmtDuration, dayIndex } from '@/lib/service-hours'

interface RcInsight { spendWTD: number; runningFoodCostPct: number | null; itemCount: number }
import { RC_COLORS, rcHex } from '@/lib/rc-colors'
import { useRc, RevenueCenter } from '@/contexts/RevenueCenterContext'

const RC_TYPES = [
  { value: 'restaurant', label: 'Restaurant Service' },
  { value: 'catering',   label: 'Catering' },
  { value: 'events',     label: 'Events' },
  { value: 'retail',     label: 'Retail' },
  { value: 'other',      label: 'Other' },
] as const

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const
const EMPTY_WINDOW: ServiceWindow = { label: '', start: '17:00', end: '22:00' }

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
  schedulingMode: 'FIXED' | 'ON_DEMAND'
  prepLeadH: string          // hours portion of prep lead (UI)
  prepLeadM: string          // minutes portion of prep lead (UI)
  schedule: ServiceSchedule  // working copy, keys "0".."6"
}

const EMPTY_FORM: RcFormData = {
  name: '', color: 'blue', isDefault: false, isActive: true,
  type: 'other', description: '', managerName: '', targetFoodCostPct: '', notes: '',
  schedulingMode: 'FIXED', prepLeadH: '', prepLeadM: '', schedule: {},
}

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
        <label className="block text-xs font-medium text-gray-600">Weekly service hours</label>
        <button type="button" onClick={copyMondayToAll}
          className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-700">
          <Copy size={11} /> Copy Mon → all
        </button>
      </div>
      {DAY_LABELS.map((label, idx) => {
        const windows = dayWindows(idx)
        return (
          <div key={label} className="border border-gray-100 rounded-xl p-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-700 w-10">{label}</span>
              {windows.length === 0 && <span className="text-[11px] text-gray-400">Closed</span>}
              <button type="button" onClick={() => addWindow(idx)}
                className="flex items-center gap-1 text-[11px] text-gold hover:text-[#a88930]">
                <Plus size={11} /> Window
              </button>
            </div>
            {windows.map((w, wi) => (
              <div key={wi} className="flex items-center gap-1.5 mt-2">
                <input
                  value={w.label}
                  onChange={e => editWindow(idx, wi, 'label', e.target.value)}
                  placeholder="Lunch"
                  className="flex-1 min-w-0 border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-gold"
                />
                <input type="time" value={w.start} onChange={e => editWindow(idx, wi, 'start', e.target.value)}
                  className="border border-gray-200 rounded-lg px-1.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-gold" />
                <span className="text-gray-400 text-xs">–</span>
                <input type="time" value={w.end} onChange={e => editWindow(idx, wi, 'end', e.target.value)}
                  className="border border-gray-200 rounded-lg px-1.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-gold" />
                <button type="button" onClick={() => removeWindow(idx, wi)}
                  className="p-1 text-gray-300 hover:text-red-500">
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
          schedulingMode:    (initial.schedulingMode === 'ON_DEMAND' ? 'ON_DEMAND' : 'FIXED'),
          prepLeadH:         initial.prepLeadMinutes != null ? String(Math.floor(initial.prepLeadMinutes / 60)) : '',
          prepLeadM:         initial.prepLeadMinutes != null ? String(initial.prepLeadMinutes % 60) : '',
          schedule:          initial.serviceSchedule ?? {},
        }
      : EMPTY_FORM
  )
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim()) { setError('Name is required'); return }
    setSaving(true)
    const prepLeadMinutes =
      form.prepLeadH === '' && form.prepLeadM === ''
        ? null
        : (parseInt(form.prepLeadH || '0', 10) * 60) + parseInt(form.prepLeadM || '0', 10)
    const payload = {
      ...form,
      targetFoodCostPct: form.targetFoodCostPct !== '' ? parseFloat(form.targetFoodCostPct) : null,
      description:  form.description  || null,
      managerName:  form.managerName  || null,
      notes:        form.notes        || null,
      prepLeadMinutes,
      serviceSchedule: form.schedulingMode === 'ON_DEMAND' ? null : form.schedule,
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
      <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4">
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

            {/* Scheduling */}
            <div className="pt-2 border-t border-gray-100 space-y-3">
              <div className="flex items-center gap-1.5">
                <Clock size={13} className="text-gray-400" />
                <span className="text-xs font-semibold text-gray-700">Service hours &amp; prep timing</span>
              </div>

              {/* Mode toggle */}
              <div className="flex gap-1.5">
                {(['FIXED', 'ON_DEMAND'] as const).map(mode => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => f('schedulingMode', mode)}
                    className={`flex-1 py-2 text-xs font-medium rounded-xl border transition-colors ${
                      form.schedulingMode === mode
                        ? 'border-gold bg-gold/10 text-gray-900'
                        : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                    }`}
                  >
                    {mode === 'FIXED' ? 'Fixed hours' : 'On-demand / by booking'}
                  </button>
                ))}
              </div>

              {/* Prep lead */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Prep lead before service</label>
                <div className="flex items-center gap-2">
                  <input type="number" min="0" value={form.prepLeadH}
                    onChange={e => f('prepLeadH', e.target.value)} placeholder="0"
                    className="w-16 border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                  <span className="text-xs text-gray-400">h</span>
                  <input type="number" min="0" max="59" value={form.prepLeadM}
                    onChange={e => f('prepLeadM', e.target.value)} placeholder="0"
                    className="w-16 border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                  <span className="text-xs text-gray-400">m</span>
                </div>
              </div>

              {/* Weekly editor (Fixed only) */}
              {form.schedulingMode === 'FIXED' && (
                <ServiceScheduleEditor
                  schedule={form.schedule}
                  onChange={next => setForm(prev => ({ ...prev, schedule: next }))}
                />
              )}
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

            <div className="flex gap-2 pt-1 pb-[env(safe-area-inset-bottom)]">
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

function RcCard({ rc, insight, onEdit, onDelete }: {
  rc: RevenueCenter; insight?: RcInsight; onEdit: () => void; onDelete: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const typeLabel = RC_TYPES.find(t => t.value === rc.type)?.label ?? rc.type
  const hasDetails = rc.description || rc.managerName || rc.targetFoodCostPct || rc.notes
  const todayIdx = dayIndex(new Date())
  const todayWindows = rc.schedulingMode === 'FIXED' ? (rc.serviceSchedule?.[String(todayIdx)] ?? []) : []
  const prepLeadLabel = rc.prepLeadMinutes != null ? fmtDuration(rc.prepLeadMinutes * 60_000) : null
  const target = rc.targetFoodCostPct != null ? parseFloat(rc.targetFoodCostPct) : null
  const running = insight?.runningFoodCostPct ?? null
  const runningColor = target == null || running == null
    ? 'text-gray-400'
    : running <= target ? 'text-green-600' : running <= target + 2 ? 'text-amber-600' : 'text-red-500'

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

            {/* Service row */}
            <div className="flex items-center gap-2 mt-2.5 flex-wrap">
              <span className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-gray-400 font-medium">
                <Clock size={11} /> Service
              </span>
              {rc.schedulingMode === 'ON_DEMAND' ? (
                <span className="inline-flex items-center gap-1.5 bg-gray-50 border border-gray-100 rounded-lg px-2 py-1 text-[11.5px] text-gray-500">
                  By booking
                </span>
              ) : todayWindows.length === 0 ? (
                <span className="text-[11.5px] text-gray-400">Closed today</span>
              ) : (
                todayWindows.map((w, i) => (
                  <span key={i} className="inline-flex items-center gap-1.5 bg-gray-50 border border-gray-100 rounded-lg px-2 py-1 text-[11.5px] text-gray-600">
                    <span className="font-semibold text-gray-700">{w.label}</span>
                    <span className="text-gray-400 font-mono text-[11px]">{fmtWindow(w)}</span>
                  </span>
                ))
              )}
              {prepLeadLabel && (
                <span className="inline-flex items-center gap-1.5 bg-gray-50 border border-gray-100 rounded-lg px-2 py-1 text-[11.5px] text-gray-400">
                  Prep lead {prepLeadLabel}
                </span>
              )}
              {insight && (
                <span className="inline-flex items-center gap-1 text-[11.5px] text-gray-400">
                  · {insight.itemCount} items
                </span>
              )}
            </div>

            {/* Target vs running */}
            {target != null && (
              <div className="mt-2.5">
                <div className="flex items-center justify-between text-[11px] text-gray-400 mb-1">
                  <span>Target food cost <b className="text-gray-700">{target}%</b></span>
                  <span>Running{' '}
                    <b className={runningColor}>{running != null ? `${running.toFixed(1)}%` : '—'}</b>
                  </span>
                </div>
                <div className="h-2 rounded-full bg-gray-100 overflow-hidden relative">
                  <div className="h-full rounded-full"
                    style={{
                      width: `${Math.min(100, running ?? target)}%`,
                      backgroundColor: running == null ? '#d1d5db' : running <= target ? '#16a34a' : '#d97706',
                    }} />
                  <div className="absolute top-0 bottom-0 w-px bg-gray-900/40" style={{ left: `${Math.min(100, target)}%` }} />
                </div>
              </div>
            )}

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

interface RcInsightsResponse {
  centers: Record<string, RcInsight>
  totals: { activeCount: number; totalCount: number; blendedTargetPct: number | null; allocatedWTD: number }
}

function fmtMoney(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`
  return `$${Math.round(n).toLocaleString()}`
}

export default function RevenueCentersPage() {
  const { revenueCenters, reload } = useRc()
  const [editTarget, setEditTarget] = useState<RevenueCenter | null>(null)
  const [showForm, setShowForm]     = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [insights, setInsights] = useState<RcInsightsResponse | null>(null)

  const loadInsights = async () => {
    try {
      const res = await fetch('/api/insights/revenue-centers')
      if (res.ok) setInsights(await res.json())
    } catch { /* non-fatal: cards fall back to target-only */ }
  }
  useEffect(() => { loadInsights() }, [])

  const refreshAll = async () => { await reload(); await loadInsights() }

  const handleDelete = async (rc: RevenueCenter) => {
    if (!confirm(`Delete "${rc.name}"?`)) return
    const res = await fetch(`/api/revenue-centers/${rc.id}`, { method: 'DELETE' })
    if (!res.ok) { const d = await res.json(); setDeleteError(d.error || 'Failed to delete'); return }
    setDeleteError('')
    refreshAll()
  }

  const openAdd  = () => { setEditTarget(null); setShowForm(true) }
  const openEdit = (rc: RevenueCenter) => { setEditTarget(rc); setShowForm(true) }

  const totals = insights?.totals
  const activeCenters = revenueCenters.filter(rc => rc.isActive)
  const spendShare = activeCenters
    .map(rc => ({ rc, spend: insights?.centers[rc.id]?.spendWTD ?? 0 }))
    .filter(x => x.spend > 0)
  const spendTotal = spendShare.reduce((s, x) => s + x.spend, 0)

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Revenue Centers</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {revenueCenters.length} center{revenueCenters.length !== 1 ? 's' : ''}
            {totals && <> · each center&apos;s target drives its workspace cost-chrome</>}
          </p>
        </div>
        <button
          onClick={openAdd}
          className="flex items-center gap-1.5 bg-gold text-white px-3 py-2 rounded-xl text-sm font-semibold hover:bg-[#a88930]"
        >
          <Plus size={16} /> Add
        </button>
      </div>

      {/* KPI strip */}
      {totals && (
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-white border border-gray-100 rounded-2xl p-4">
            <div className="text-[10px] font-mono uppercase tracking-wide text-gray-400">Centers · Active</div>
            <div className="text-2xl font-bold text-gray-900 mt-1">
              {totals.activeCount}<span className="text-base text-gray-400 font-medium"> / {totals.totalCount}</span>
            </div>
          </div>
          <div className="bg-white border border-gray-100 rounded-2xl p-4">
            <div className="text-[10px] font-mono uppercase tracking-wide text-gray-400">Blended Target</div>
            <div className="text-2xl font-bold text-gray-900 mt-1">
              {totals.blendedTargetPct != null ? totals.blendedTargetPct.toFixed(1) : '—'}
              <span className="text-base text-gold font-semibold">%</span>
            </div>
          </div>
          <div className="bg-white border border-gray-100 rounded-2xl p-4">
            <div className="text-[10px] font-mono uppercase tracking-wide text-gray-400">Allocated · WTD</div>
            <div className="text-2xl font-bold text-gray-900 mt-1">{fmtMoney(totals.allocatedWTD)}</div>
          </div>
        </div>
      )}

      {deleteError && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          {deleteError}
        </div>
      )}

      {/* 2-column: list + rail (rail stacks below on mobile) */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-4 items-start">
        <div className="space-y-3">
          {revenueCenters.map(rc => (
            <RcCard
              key={rc.id}
              rc={rc}
              insight={insights?.centers[rc.id]}
              onEdit={() => openEdit(rc)}
              onDelete={() => handleDelete(rc)}
            />
          ))}
        </div>

        {/* Rail */}
        <div className="space-y-3">
          {spendShare.length > 0 && (
            <div className="bg-white border border-gray-100 rounded-2xl p-4">
              <h4 className="text-sm font-semibold text-gray-900 mb-3">Spend allocation · WTD</h4>
              <div className="h-2 rounded-full bg-gray-100 overflow-hidden flex mb-3">
                {spendShare.map(({ rc, spend }) => (
                  <span key={rc.id} style={{ background: rcHex(rc.color), width: `${(spend / spendTotal) * 100}%` }} />
                ))}
              </div>
              {spendShare.map(({ rc, spend }) => (
                <div key={rc.id} className="flex items-center gap-2.5 py-1.5 border-b border-dashed border-gray-100 last:border-0">
                  <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: rcHex(rc.color) }} />
                  <span className="flex-1 text-xs text-gray-600 truncate">{rc.name}</span>
                  <span className="font-mono text-xs font-semibold text-gray-900">{fmtMoney(spend)}</span>
                </div>
              ))}
            </div>
          )}

          <div className="bg-white border border-gray-100 rounded-2xl p-4">
            <h4 className="text-sm font-semibold text-gray-900 mb-2">Service hours drive timing</h4>
            <p className="text-xs text-gray-500 leading-relaxed">
              Each center&apos;s service windows and prep lead feed the day&apos;s countdowns — the Pre-shift
              &ldquo;to service&rdquo; banner and the Prep deadline both read from here.
            </p>
          </div>

          <div className="bg-white border border-gray-100 rounded-2xl p-4">
            <h4 className="text-sm font-semibold text-gray-900 mb-2">Why centers matter</h4>
            <p className="text-xs text-gray-500 leading-relaxed">
              Each center owns its target food cost. The live cost-chrome strip reads the active workspace&apos;s
              target — switch the workspace pill and every Cost, Variance, and Menu screen re-baselines.
            </p>
          </div>
        </div>
      </div>

      {showForm && (
        <RcFormModal
          initial={editTarget}
          onClose={() => setShowForm(false)}
          onSaved={refreshAll}
        />
      )}
    </div>
  )
}
