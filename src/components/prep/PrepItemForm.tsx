'use client'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { X } from 'lucide-react'
import { PREP_STATIONS, PREP_PRIORITY_META, PREP_PRIORITY_ORDER } from '@/lib/prep-utils'
import { PREP_YIELD_UNITS } from '@/lib/uom'
import { startByMinutes, fmtClock, fmtStartBy, fmtMins } from '@/lib/prep-runsheet'
import type { PrepItemRich } from './types'


interface Recipe { id: string; name: string; yieldUnit: string }
interface Service { id: string; name: string; timeMinutes: number; endMinutes: number | null }
interface RevenueCenter { id: string; name: string; services?: Service[] }

interface Props {
  item?: PrepItemRich | null
  onClose: () => void
  onSaved: () => void
}

const BLANK = {
  name: '', linkedRecipeId: '', linkedInventoryItemId: '',
  category: 'MISC', station: '',
  parLevel: '', unit: 'batch',
  targetToday: '', shelfLifeDays: '', notes: '',
  manualPriorityOverride: '',
  revenueCenterId: '',
  // Run-sheet inputs. `targetServiceId` is what start-by counts back FROM; the two
  // minute fields are what it counts back BY. Blank ⇒ inherit the linked recipe.
  targetServiceId: '', activeMinutesOverride: '', passiveMinutesOverride: '', passiveNoteOverride: '',
}

// NOTE: the legacy `estimatedPrepTime` field (and its min/hr/day unit picker)
// was removed here — `activeMinutesOverride` ("Hands-on") is now the single
// source of how long an item takes, because it is what `resolveActive` reads and
// therefore what start-by counts back by. Existing `estimatedPrepTime` values were
// copied across by scripts/backfill-prep-timing.ts; the column is left untouched
// in the DB so the migration stays reversible.

export function PrepItemForm({ item, onClose, onSaved }: Props) {
  const [form, setForm]           = useState(BLANK)
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
        notes:                 item.notes                ?? '',
        manualPriorityOverride: item.manualPriorityOverride ?? '',
        revenueCenterId:       item.revenueCenterId       ?? '',
        targetServiceId:       item.targetServiceId       ?? '',
        // Bind the RAW override, never the resolved value — see types.ts. A blank
        // input with a recipe-supplied time shows that time as a placeholder instead.
        activeMinutesOverride:  item.activeMinutesOverride  != null ? String(item.activeMinutesOverride)  : '',
        passiveMinutesOverride: item.passiveMinutesOverride != null ? String(item.passiveMinutesOverride) : '',
        passiveNoteOverride:    item.passiveNoteOverride    ?? '',
      })
    }
  }, [item])

  const set = useCallback((k: keyof typeof BLANK, v: string) => {
    setForm(prev => ({ ...prev, [k]: v }))
  }, [])

  // The unit is authoritative from the linked recipe's yield unit (prep-sync rewrites
  // it on every recipe change), so a recipe-linked prep item must NOT let the user pick
  // a divergent unit — that's how dimension mismatches (par in "l" vs recipe in "g")
  // sneak in and bias every downstream stock calc. Lock it to the recipe's yield unit;
  // only free-standing prep items get the canonical picker.
  const linkedRecipe = recipes.find(r => r.id === form.linkedRecipeId) ?? null
  const recipeUnit = linkedRecipe?.yieldUnit ?? (form.linkedRecipeId ? form.unit : null)
  useEffect(() => {
    if (linkedRecipe && linkedRecipe.yieldUnit && form.unit !== linkedRecipe.yieldUnit) {
      set('unit', linkedRecipe.yieldUnit)
    }
  }, [linkedRecipe, form.unit, set])

  // Services to offer under "Ready for". Scoped to the chosen RC; a Shared item
  // (no RC) can still target a service, so fall back to every RC's services and
  // disambiguate them by name — otherwise two RCs' "Brunch" are indistinguishable.
  const serviceOptions = useMemo(() => {
    const scoped = form.revenueCenterId
      ? revenueCenters.filter(rc => rc.id === form.revenueCenterId)
      : revenueCenters
    const multiRc = scoped.length > 1
    return scoped.flatMap(rc =>
      (rc.services ?? []).map(s => ({ ...s, label: multiRc ? `${s.name} · ${rc.name}` : s.name })),
    )
  }, [revenueCenters, form.revenueCenterId])

  // Live preview of what the run sheet will compute. `activeMinutes` falls back to
  // the linked recipe exactly as resolveActive does server-side, so the numbers here
  // match the ladder rather than only reflecting what's typed.
  const svc = serviceOptions.find(s => s.id === form.targetServiceId) ?? null
  const effActive  = form.activeMinutesOverride  !== '' ? Number(form.activeMinutesOverride)  : item?.activeMinutes  ?? null
  const effPassive = form.passiveMinutesOverride !== '' ? Number(form.passiveMinutesOverride) : item?.passiveMinutes ?? null
  const totalMin   = (effActive ?? 0) + (effPassive ?? 0)
  const startBy    = startByMinutes(svc?.timeMinutes ?? null, effActive, effPassive)

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
      notes:                 form.notes || null,
      manualPriorityOverride: form.manualPriorityOverride || null,
      revenueCenterId:       form.revenueCenterId || null,
      // Sent as raw strings — the server's numOrNull keeps 0 and turns '' into null.
      targetServiceId:        form.targetServiceId,
      activeMinutesOverride:  form.activeMinutesOverride,
      passiveMinutesOverride: form.passiveMinutesOverride,
      passiveNoteOverride:    form.passiveNoteOverride || null,
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
            {field('Unit', recipeUnit ? (
              <div className={inputCls + ' bg-bg text-ink-3 flex items-center justify-between cursor-default'} title="Inherited from the linked recipe's yield unit">
                <span>{recipeUnit}</span>
                <span className="text-[11px] text-ink-4">from recipe</span>
              </div>
            ) : (
              <select className={selCls} value={form.unit} onChange={e => set('unit', e.target.value)}>
                {PREP_YIELD_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
              </select>
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

          {/* ── Timing ──────────────────────────────────────────────────────────
              Hands-on + passive are what the run sheet counts back BY. Both are
              item-level OVERRIDES: left blank they inherit the linked recipe's
              times, which the placeholders surface so the inherited value is
              visible rather than implied. */}
          <div className="pt-1">
            <div className="font-mono text-[10.5px] font-semibold tracking-[0.06em] uppercase text-ink-3 mb-2.5">
              Timing
            </div>
            <div className="grid grid-cols-3 gap-3">
              {field('Hands-on (min)', (
                <input className={inputCls} type="number" min="0" step="5" inputMode="numeric"
                  value={form.activeMinutesOverride}
                  onChange={e => set('activeMinutesOverride', e.target.value)}
                  placeholder={item?.activeMinutes != null ? String(item.activeMinutes) : '—'} />
              ))}
              {field('Passive (min)', (
                <input className={inputCls} type="number" min="0" step="5" inputMode="numeric"
                  value={form.passiveMinutesOverride}
                  onChange={e => set('passiveMinutesOverride', e.target.value)}
                  placeholder={item?.passiveMinutes != null ? String(item.passiveMinutes) : '—'} />
              ))}
              {field('Passive note', (
                <input className={inputCls} value={form.passiveNoteOverride}
                  onChange={e => set('passiveNoteOverride', e.target.value)}
                  placeholder={item?.passiveNote ?? 'cool'} />
              ))}
            </div>
            {form.activeMinutesOverride === '' && item?.activeMinutes != null && (
              <p className="text-[11px] text-ink-4 mt-1.5">
                Blank inherits the linked recipe&apos;s times.
              </p>
            )}
          </div>

          {/* ── Ready for ───────────────────────────────────────────────────────
              The service this item must be ready FOR. Without it `startByMinutes`
              is null and the row has no place on the time ladder — it drops into
              the catch-all bucket. This is the field that makes the run sheet work. */}
          <div className="pt-1">
            <div className="font-mono text-[10.5px] font-semibold tracking-[0.06em] uppercase text-ink-3 mb-2.5">
              Ready for
            </div>
            {serviceOptions.length === 0 ? (
              <p className="text-[12px] text-ink-4">
                No active services on this revenue center. Add one in Setup → Revenue Centers to put
                this item on the time ladder.
              </p>
            ) : (
              field('Service', (
                <select className={selCls} value={form.targetServiceId}
                  onChange={e => set('targetServiceId', e.target.value)}>
                  <option value="">— None (no start-by time) —</option>
                  {serviceOptions.map(s => (
                    <option key={s.id} value={s.id}>{s.label} · {fmtClock(s.timeMinutes)}</option>
                  ))}
                </select>
              ))
            )}

            {/* Live read-out of the exact maths the ladder runs. */}
            <div className="grid grid-cols-2 gap-2 mt-3">
              <div className="bg-bg border border-line rounded-[11px] px-3 py-2.5">
                <div className="font-mono text-[9.5px] font-medium tracking-[0.06em] uppercase text-ink-4">Total time</div>
                <div className="font-mono text-[15px] font-semibold mt-1">
                  {totalMin > 0 ? fmtMins(totalMin) : '—'}
                </div>
              </div>
              <div className="bg-bg border border-line rounded-[11px] px-3 py-2.5">
                <div className="font-mono text-[9.5px] font-medium tracking-[0.06em] uppercase text-ink-4">Start by</div>
                <div className="font-mono text-[15px] font-semibold mt-1">
                  {startBy != null ? fmtStartBy(startBy) : '—'}
                  {svc && startBy != null && (
                    <span className="text-[10px] font-medium text-ink-3"> · for {svc.name}</span>
                  )}
                </div>
              </div>
            </div>
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
