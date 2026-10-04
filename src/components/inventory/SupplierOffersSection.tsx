'use client'
// Supplier boxes section for the inventory item drawer: one row per supplier box
// (an InventorySupplierPrice row) with its pack, product code, normalized
// $/base-unit, stability and a main-box star. A manager can add a box, edit a
// box's pack / price / product code, and remove a box; the item follows its main
// box (the server keeps the two equal).
// Data: GET /api/inventory/[id]/suppliers (see src/lib/supplier-offers.ts);
// writes: POST …/suppliers, PATCH / DELETE …/suppliers/[offerId].

import { useEffect, useState, useCallback } from 'react'
import { Loader2, Star } from 'lucide-react'
import { formatPricePerBase } from '@/lib/utils'
import { DIMENSION_BASE, type Dimension, type PackLink, type Pricing } from '@/lib/item-model'
import type { SupplierOfferStats } from '@/lib/supplier-offers'
import { offerPriceLabel, offerDerivation } from '@/lib/invoice/offer-copy'
import { removeBoxMessage } from '@/lib/box-copy'
import { formatPurchaseDisplay } from '@/lib/count-uom'
import { boxPriceText, packPriceLine, shortDay, sortBoxes } from '@/lib/drawer-copy'
import { PackChainEditor, PricingEditor } from './ItemChainEditor'
import { Combobox } from './Combobox'

const STABILITY_BADGE: Record<NonNullable<SupplierOfferStats['stability']>, { label: string; cls: string }> = {
  stable:   { label: 'Stable',   cls: 'bg-green-soft text-green-text' },
  variable: { label: 'Variable', cls: 'bg-gold-soft text-gold-2' },
  volatile: { label: 'Volatile', cls: 'bg-red-soft text-red-text' },
}

function fmtPack(o: SupplierOfferStats): string {
  // Prefer the per-offer chain's top→leaf when present (ItemOffer semantics).
  if (Array.isArray(o.packChain) && o.packChain.length) {
    const links = o.packChain as Array<{ unit?: string; per?: number }>
    const parts = links
      .map(l => (l && l.per != null && l.unit ? `${l.per}${l.unit === 'each' ? '' : ' ' + l.unit}` : null))
      .filter(Boolean)
    if (parts.length) return parts.join(' × ')
  }
  if (o.packQty != null && o.packSize != null && o.packUOM) return `${o.packQty} × ${o.packSize}${o.packUOM}`
  return '—'
}

// $/base shown per kg/L for weight/volume bases so the numbers are readable.
const fmtPpb = formatPricePerBase

/** A box's chain as the editor wants it (numbers, not Decimal strings); falls back
 *  to the item's chain for a box that carries none. */
function boxChain(o: SupplierOfferStats, fallback: PackLink[]): PackLink[] {
  return Array.isArray(o.packChain) && o.packChain.length
    ? (o.packChain as PackLink[]).map(l => ({ unit: l.unit, per: Number(l.per) }))
    : fallback.map(l => ({ ...l }))
}

function boxPricing(o: SupplierOfferStats, fallback: Pricing): Pricing {
  const p = o.pricing as Pricing | null
  return p && (p.mode === 'PACK' || p.mode === 'RATE') ? p : { ...fallback }
}

/** What the add / edit form hands back on Save. */
interface BoxDraft {
  supplierId: string
  supplierItemCode: string
  packChain: PackLink[]
  pricing: Pricing
  makePrimary: boolean
}

// ─── The add / edit form (module scope so its inputs keep focus) ─────────────

function BoxForm({
  mode, dimension, initial, supplierName, mainLocked, saving, error, onSave, onCancel,
}: {
  mode: 'add' | 'edit'
  dimension: Dimension
  initial: BoxDraft
  /** Edit: the box's supplier, shown read-only. */
  supplierName?: string
  /** Add on a box-less item: its first box is always the main box. */
  mainLocked: boolean
  saving: boolean
  error: string | null
  onSave: (d: BoxDraft) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<BoxDraft>(initial)
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([])
  const [pickedName, setPickedName] = useState('')

  useEffect(() => {
    if (mode !== 'add') return
    fetch('/api/suppliers')
      .then(r => (r.ok ? r.json() : []))
      .then((rows: { id: string; name: string }[]) => setSuppliers(rows.map(s => ({ id: s.id, name: s.name }))))
      .catch(() => setSuppliers([]))
  }, [mode])

  const canSave = !saving && (mode === 'edit' || !!draft.supplierId)

  return (
    <div className="px-3 py-3 bg-bg space-y-3">
      {mode === 'add' ? (
        <div>
          <label className="block text-xs font-medium text-ink-3 mb-1">Supplier</label>
          <Combobox
            items={suppliers}
            value={pickedName}
            placeholder="Type to search suppliers…"
            onSelect={(id, name) => { setDraft(d => ({ ...d, supplierId: id })); setPickedName(name) }}
            onAddNew={async (name) => {
              const res = await fetch('/api/suppliers', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
              })
              if (!res.ok) {
                alert('Could not add that supplier.')
                return null
              }
              const sup = await res.json()
              setSuppliers(prev => [...prev, { id: sup.id, name: sup.name }])
              return { id: sup.id, name: sup.name }
            }}
          />
        </div>
      ) : (
        <div className="text-[13px] font-medium text-ink">{supplierName}</div>
      )}

      <div>
        <label className="block text-xs font-medium text-ink-3 mb-1">
          Product code <span className="font-normal text-ink-4">(optional)</span>
        </label>
        <input
          type="text"
          value={draft.supplierItemCode}
          onChange={e => setDraft(d => ({ ...d, supplierItemCode: e.target.value }))}
          placeholder="The supplier's code on the invoice"
          className="w-full border border-line rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-gold"
        />
      </div>

      <PackChainEditor
        chain={draft.packChain}
        baseUnit={DIMENSION_BASE[dimension]}
        dimension={dimension}
        onChange={packChain => setDraft(d => ({ ...d, packChain }))}
      />

      <PricingEditor
        dimension={dimension}
        pricing={draft.pricing}
        onChange={pricing => setDraft(d => ({ ...d, pricing }))}
      />

      {mode === 'add' && (
        <label className="flex items-center gap-2 select-none cursor-pointer">
          <input
            type="checkbox"
            checked={mainLocked || draft.makePrimary}
            disabled={mainLocked}
            onChange={e => setDraft(d => ({ ...d, makePrimary: e.target.checked }))}
            className="w-4 h-4 rounded border-line-2 text-gold focus:ring-gold"
          />
          <span className="text-sm text-ink-2">Make this the main box</span>
        </label>
      )}

      {error && <p className="text-xs text-red-text">{error}</p>}

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!canSave}
          onClick={() => onSave({ ...draft, makePrimary: mainLocked || draft.makePrimary })}
          className="px-3 py-1.5 bg-ink text-paper text-[12px] font-medium rounded-[8px] hover:bg-ink-2 disabled:opacity-50 flex items-center gap-1 transition-colors"
        >
          {saving && <Loader2 size={10} className="animate-spin" />}
          Save
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 border border-line text-[12px] font-medium text-ink-2 rounded-[8px] hover:border-ink-3 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}


// ─── One box as a card (the item drawer's library layout) ────────────────────

/** One supplier box as a card: supplier, code, what the box holds, its price,
 *  its price per base unit, when it was last delivered, and whether it is the
 *  main box. Rendering only — every action is the section's own handler. */
function BoxCard({
  o, baseUnit, dimension, itemChain, item, isCheapest, lastDelivery,
  canEdit, canSetPrimary, saving, onEdit, onRemove, onMakeMain,
}: {
  o: SupplierOfferStats
  baseUnit: string | null
  dimension: Dimension
  itemChain: PackLink[]
  item: { baseUnit: string | null; eachMeasureQty?: number | string | null; eachMeasureUnit?: string | null }
  isCheapest: boolean
  lastDelivery: string | null
  canEdit: boolean
  canSetPrimary: boolean
  saving: boolean
  onEdit: () => void
  onRemove: () => void
  onMakeMain: () => void
}) {
  const chain = boxChain(o, itemChain)
  const holds = formatPurchaseDisplay({ dimension, baseUnit: baseUnit ?? DIMENSION_BASE[dimension], packChain: chain })
  const badge = o.stability ? STABILITY_BADGE[o.stability] : null
  const derivation = offerDerivation(o, item, o.pricePerBaseUnit)
  return (
    <div className={`px-3 py-2.5 ${isCheapest ? 'bg-green-soft/40' : 'bg-paper'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[13.5px] font-medium text-ink">{o.supplierName}</span>
            {o.isPrimary && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-gold-soft text-gold-2 text-[10.5px] font-medium">
                <Star size={10} className="text-gold fill-gold" /> Main
              </span>
            )}
            {isCheapest && <span className="text-[10.5px] font-medium text-green-text">Cheapest</span>}
          </div>
          <div className="text-[12px] text-ink-3 mt-0.5">
            {holds}{o.supplierItemCode ? ` · code ${o.supplierItemCode}` : ''}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="font-mono text-[13.5px] font-semibold text-ink tabular-nums">
            {fmtPpb(o.pricePerBaseUnit, baseUnit)}
          </div>
          <div className="font-mono text-[11px] text-ink-3 tabular-nums">{boxPriceText(o.pricing, chain)}</div>
        </div>
      </div>
      {derivation && (
        <div className={`font-mono text-[10.5px] mt-1 ${derivation.startsWith('Unpriced') ? 'text-red-text' : 'text-ink-3'}`}>
          {derivation}
        </div>
      )}
      <div className="flex items-center gap-2 flex-wrap mt-1.5 text-[11.5px]">
        <span className="text-ink-4">
          {lastDelivery ? `Last delivered ${shortDay(lastDelivery)}` : 'No delivery on recent invoices'}
        </span>
        {badge && (
          <span className={`font-mono text-[9.5px] font-semibold uppercase px-2 py-[2px] rounded-full ${badge.cls}`}>
            {badge.label}{o.volatility !== null ? ` ±${Math.round(o.volatility * 100)}%` : ''}
          </span>
        )}
        {(canEdit || (canSetPrimary && !o.isPrimary)) && (
          <span className="ml-auto flex items-center gap-3">
            {canSetPrimary && !o.isPrimary && (
              <button type="button" disabled={saving} onClick={onMakeMain}
                className="font-medium text-gold-2 hover:text-gold disabled:opacity-50">Make main</button>
            )}
            {canEdit && (
              <>
                <button type="button" disabled={saving} onClick={onEdit}
                  className="font-medium text-ink-3 hover:text-ink disabled:opacity-50">Edit</button>
                <button type="button" disabled={saving} onClick={onRemove}
                  className="font-medium text-ink-3 hover:text-red-text disabled:opacity-50">Remove</button>
              </>
            )}
          </span>
        )}
      </div>
    </div>
  )
}

// ─── The section ─────────────────────────────────────────────────────────────

export function SupplierOffersSection({
  itemId, itemName, baseUnit, dimension, itemChain, itemPricing, itemLastUpdated,
  eachMeasureQty, eachMeasureUnit, onRepriced, canSetPrimary = true, canEdit = false, onChanged,
  variant = 'list', lastDeliveryOf,
}: {
  itemId: string
  itemName: string
  baseUnit: string | null
  /** The item's measure — a box always takes it (no measure switch on a box). */
  dimension: Dimension
  /** Seeds a new box: it starts as the item's own pack and price. */
  itemChain: PackLink[]
  itemPricing: Pricing
  /** The item's version — an add names it (a mismatch → STALE). */
  itemLastUpdated: string | null
  /** Count↔weight bridge (Prisma Decimal serialises as a string) — lets a $/lb
   *  offer on an `each` item show its real derivation instead of just "$0". */
  eachMeasureQty?: number | string | null
  eachMeasureUnit?: string | null
  onRepriced?: () => void
  /** Switching the primary re-prices the item — MANAGER+ (the PATCH refuses below that). */
  canSetPrimary?: boolean
  /** Add / edit / remove a box — MANAGER+ (the routes refuse below that). */
  canEdit?: boolean
  /** After any box write: the item's version and price may have moved. */
  onChanged?: () => void
  /** 'cards' — the item drawer's library layout: one card per box, main box
   *  first then cheapest, and a box-less item's own price in the empty state.
   *  Rendering only: every request is the same as the list's. */
  variant?: 'list' | 'cards'
  /** Cards: the day a supplier last delivered this item (a day key), or null. */
  lastDeliveryOf?: (supplierName: string) => string | null
}) {
  const [offers, setOffers] = useState<SupplierOfferStats[] | null>(null)
  const [saving, setSaving] = useState(false)
  /** Which form is open: 'add', a box id being edited, or none. */
  const [open, setOpen] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [listError, setListError] = useState<string | null>(null)

  const load = useCallback(() => {
    fetch(`/api/inventory/${itemId}/suppliers`)
      .then(r => (r.ok ? r.json() : []))
      .then(setOffers)
      .catch(() => setOffers([]))
  }, [itemId])

  useEffect(() => { load() }, [load])

  const setPrimary = async (offerId: string) => {
    setSaving(true)
    setOffers(prev => prev ? prev.map(o => ({ ...o, isPrimary: o.id === offerId })) : prev)
    const res = await fetch(`/api/inventory/${itemId}/suppliers`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offerId }),
    }).then(r => (r.ok ? r.json() : null)).catch(() => null)
    setSaving(false)
    load()
    // One item refresh: `onChanged` already re-fetches after any box write, so
    // `onRepriced` is only the fallback for a caller that passes nothing else.
    if (onChanged) onChanged()
    else if (res?.repriced) onRepriced?.()
  }

  /** Send one box write. Success → the refreshed boxes + the item re-fetched;
   *  refusal → the server's sentence (a clash also reloads the boxes and item). */
  const write = async (url: string, method: string, body: unknown, showError: (m: string) => void):
    Promise<{ ok: boolean; stale: boolean }> => {
    setSaving(true)
    try {
      const res = await fetch(url, {
        method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }).catch(() => null)
      if (!res) { showError('Could not reach the server. Try again.'); return { ok: false, stale: false } }
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        showError(data?.error ?? `Save failed (${res.status}). Try again.`)
        const stale = data?.code === 'STALE'
        if (stale) { load(); onChanged?.() }
        return { ok: false, stale }
      }
      if (Array.isArray(data)) setOffers(data); else load()
      onChanged?.()
      return { ok: true, stale: false }
    } finally {
      setSaving(false)
    }
  }

  const openForm = (key: string) => { setFormError(null); setListError(null); setOpen(key) }

  const saveAdd = async (d: BoxDraft) => {
    setFormError(null)
    const r = await write(`/api/inventory/${itemId}/suppliers`, 'POST', {
      supplierId: d.supplierId,
      supplierItemCode: d.supplierItemCode.trim() || null,
      packChain: d.packChain,
      pricing: d.pricing,
      makePrimary: d.makePrimary,
      expectedLastUpdated: itemLastUpdated,
    }, setFormError)
    if (r.ok) setOpen(null)
  }

  const saveEdit = async (o: SupplierOfferStats, d: BoxDraft) => {
    setFormError(null)
    let msg = ''
    const r = await write(`/api/inventory/${itemId}/suppliers/${o.id}`, 'PATCH', {
      packChain: d.packChain,
      pricing: d.pricing,
      supplierItemCode: d.supplierItemCode.trim() || null,
      expectedLastUpdated: o.lastUpdated,
    }, m => { msg = m })
    if (r.ok) setOpen(null)
    // Someone else saved this box meanwhile: close the form so the old draft
    // cannot be saved over their change (the list now shows the fresh box, and
    // reopening Edit starts from it). The sentence stays under the list.
    else if (r.stale) { setOpen(null); setListError(msg) }
    else setFormError(msg)
  }

  const remove = async (o: SupplierOfferStats, count: number) => {
    setListError(null)
    if (!confirm(removeBoxMessage({
      supplierName: o.supplierName, itemName, isPrimary: o.isPrimary, otherBoxes: count - 1,
    }))) return
    const r = await write(`/api/inventory/${itemId}/suppliers/${o.id}`, 'DELETE', {
      expectedLastUpdated: o.lastUpdated,
    }, setListError)
    if (r.ok && open === o.id) setOpen(null)
  }

  if (!offers) return null
  // Below MANAGER a box-less item shows nothing (as before) — except in the
  // drawer's cards, which still say what the item's own price is.
  if (offers.length === 0 && !canEdit && variant !== 'cards') return null

  const item = { baseUnit, eachMeasureQty, eachMeasureUnit }
  const cheapest = Math.min(...offers.map(o => o.pricePerBaseUnit).filter(p => p > 0))
  const primaryOffer = offers.find(o => o.isPrimary)
  const cheaperThanPrimary =
    !!primaryOffer && Number.isFinite(cheapest) && primaryOffer.pricePerBaseUnit > cheapest

  const addForm = (
    <BoxForm
      mode="add"
      dimension={dimension}
      initial={{
        supplierId: '',
        supplierItemCode: '',
        packChain: itemChain.map(l => ({ ...l })),
        pricing: { ...itemPricing },
        makePrimary: offers.length === 0,
      }}
      mainLocked={offers.length === 0}
      saving={saving}
      error={formError}
      onSave={saveAdd}
      onCancel={() => setOpen(null)}
    />
  )

  if (variant === 'cards') {
    return (
      <div className="space-y-2">
        {offers.length === 0 ? (
          <div className="bg-paper border border-line rounded-[10px] px-3 py-2.5 text-[12.5px] leading-snug">
            <div className="font-mono text-ink tabular-nums">{packPriceLine(itemPricing, itemChain, baseUnit ?? DIMENSION_BASE[dimension])}</div>
            <div className="text-ink-4 mt-0.5">
              {canEdit
                ? 'No supplier box yet — this is the item’s own price. Add a box to price it from a supplier.'
                : 'No supplier box yet — this is the item’s own price. A manager can add a supplier box.'}
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {sortBoxes(offers).map(o => (
              <div key={o.id} className="border border-line rounded-[10px] overflow-hidden">
                <BoxCard
                  o={o}
                  baseUnit={baseUnit}
                  dimension={dimension}
                  itemChain={itemChain}
                  item={item}
                  isCheapest={offers.length > 1 && o.pricePerBaseUnit > 0 && o.pricePerBaseUnit === cheapest}
                  lastDelivery={lastDeliveryOf ? lastDeliveryOf(o.supplierName) : null}
                  canEdit={canEdit && open !== o.id}
                  canSetPrimary={canSetPrimary && open !== o.id}
                  saving={saving}
                  onEdit={() => openForm(o.id)}
                  onRemove={() => remove(o, offers.length)}
                  onMakeMain={() => setPrimary(o.id)}
                />
                {canEdit && open === o.id && (
                  <BoxForm
                    mode="edit"
                    dimension={dimension}
                    supplierName={o.supplierName}
                    initial={{
                      supplierId: o.supplierId ?? '',
                      supplierItemCode: o.supplierItemCode ?? '',
                      packChain: boxChain(o, itemChain),
                      pricing: boxPricing(o, itemPricing),
                      makePrimary: o.isPrimary,
                    }}
                    mainLocked={false}
                    saving={saving}
                    error={formError}
                    onSave={d => saveEdit(o, d)}
                    onCancel={() => setOpen(null)}
                  />
                )}
              </div>
            ))}
          </div>
        )}
        {listError && <p className="text-xs text-red-text">{listError}</p>}
        {cheaperThanPrimary && (
          <div className="text-[11.5px] text-gold-2">
            A cheaper supplier is available — {fmtPpb(cheapest, baseUnit)} against the main box&rsquo;s {fmtPpb(primaryOffer!.pricePerBaseUnit, baseUnit)}.
          </div>
        )}
        {canEdit && (open === 'add' ? (
          <div className="border border-line rounded-[10px] overflow-hidden">{addForm}</div>
        ) : (
          <button
            type="button"
            disabled={saving}
            onClick={() => openForm('add')}
            className="text-xs font-medium text-gold-2 hover:text-gold transition-colors disabled:opacity-50"
          >
            + Add supplier box
          </button>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-4 font-semibold">
        Supplier boxes · {offers.length}
      </div>
      {offers.length > 0 && (
      <div className="border border-line rounded-lg divide-y divide-line overflow-hidden">
        {offers.map(o => {
          const isCheapest = offers.length > 1 && o.pricePerBaseUnit > 0 && o.pricePerBaseUnit === cheapest
          const badge = o.stability ? STABILITY_BADGE[o.stability] : null
          const derivation = offerDerivation(o, item, o.pricePerBaseUnit)
          return (
            <div key={o.id}>
            <div className={`flex items-center gap-3 px-3 py-2.5 ${isCheapest ? 'bg-green-soft/40' : 'bg-paper'}`}>
              <button
                type="button"
                disabled={saving || !canSetPrimary}
                onClick={() => setPrimary(o.id)}
                title={o.isPrimary ? 'Main box' : canSetPrimary ? 'Make this the main box' : 'Not the main box'}
                className="shrink-0 p-1 disabled:cursor-default"
              >
                <Star size={14} className={o.isPrimary ? 'text-gold fill-gold' : canSetPrimary ? 'text-line-2 hover:text-gold' : 'text-line-2'} />
              </button>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium text-ink truncate">{o.supplierName}</div>
                <div className="font-mono text-[10.5px] text-ink-4 mt-0.5">
                  {fmtPack(o)}{o.supplierItemCode ? ` · #${o.supplierItemCode}` : ''} · last {new Date(o.lastUpdated).toLocaleDateString('en-CA')}
                </div>
                {canEdit && open !== o.id && (
                  <div className="flex items-center gap-3 mt-1">
                    <button type="button" disabled={saving} onClick={() => openForm(o.id)}
                      className="text-[11.5px] font-medium text-ink-3 hover:text-ink disabled:opacity-50">Edit</button>
                    <button type="button" disabled={saving} onClick={() => remove(o, offers.length)}
                      className="text-[11.5px] font-medium text-ink-3 hover:text-red-text disabled:opacity-50">Remove</button>
                  </div>
                )}
              </div>
              {badge && (
                <span className={`font-mono text-[9.5px] font-semibold uppercase px-2 py-[3px] rounded-full shrink-0 ${badge.cls}`}>
                  {badge.label}{o.volatility !== null ? ` ±${Math.round(o.volatility * 100)}%` : ''}
                </span>
              )}
              <div className="text-right shrink-0">
                <div className="font-mono text-[13px] font-semibold text-ink tabular-nums">
                  {fmtPpb(o.pricePerBaseUnit, baseUnit)}
                </div>
                <div className="font-mono text-[10.5px] text-ink-4">{offerPriceLabel(o)}{isCheapest ? ' · cheapest' : ''}</div>
                {derivation && (
                  <div className={`font-mono text-[10.5px] mt-0.5 ${derivation.startsWith('Unpriced') ? 'text-red-text' : 'text-ink-3'}`}>
                    {derivation}
                  </div>
                )}
              </div>
            </div>
            {canEdit && open === o.id && (
              <BoxForm
                mode="edit"
                dimension={dimension}
                supplierName={o.supplierName}
                initial={{
                  supplierId: o.supplierId ?? '',
                  supplierItemCode: o.supplierItemCode ?? '',
                  packChain: boxChain(o, itemChain),
                  pricing: boxPricing(o, itemPricing),
                  makePrimary: o.isPrimary,
                }}
                mainLocked={false}
                saving={saving}
                error={formError}
                onSave={d => saveEdit(o, d)}
                onCancel={() => setOpen(null)}
              />
            )}
            </div>
          )
        })}
      </div>
      )}
      {listError && <p className="text-xs text-red-text">{listError}</p>}
      {cheaperThanPrimary && (
        <div className="font-mono text-[10.5px] text-gold-2">
          Cheaper supplier available — {fmtPpb(cheapest, baseUnit)} vs main box {fmtPpb(primaryOffer!.pricePerBaseUnit, baseUnit)}.
        </div>
      )}
      {canEdit && (open === 'add' ? (
        <div className="border border-line rounded-lg overflow-hidden">
          {addForm}
        </div>
      ) : (
        <button
          type="button"
          disabled={saving}
          onClick={() => openForm('add')}
          className="text-xs font-medium text-gold-2 hover:text-gold transition-colors disabled:opacity-50"
        >
          + Add supplier box
        </button>
      ))}
    </div>
  )
}
