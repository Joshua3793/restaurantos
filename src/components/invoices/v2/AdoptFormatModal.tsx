'use client'
// Confirmation modal for resolving a dimension conflict by changing the matched
// inventory item to match the invoice line's format (the "item is the wrong
// side" path). Derives the new chain from the SAME buildOffer the conflict
// detector uses, then writes it via the item's pricing route — which validates
// the chain and cascades recipe re-costing. It changes only the pack, price and
// count unit, and — when the invoice is in another measure — the measure itself.
// The route allows that only while the item has no history (otherwise it answers
// DIMENSION_LOCKED with a plain sentence, shown here). It never touches stock
// (that moves only through counts). An item with a supplier box is priced on the
// box, so the route refuses it (HAS_OFFERS). Re-costs recipes, so it spells out
// the impact before the user confirms.

import { useEffect, useState } from 'react'
import { X, AlertTriangle, Loader2, ArrowRight } from 'lucide-react'
import type { ScanItem } from '@/components/invoices/types'
import { buildOffer, scanItemToOfferInput } from '@/lib/invoice/offer'
import { dimensionOf, type PackLink } from '@/lib/item-model'
import { canonicalUom } from '@/lib/uom'
import { ActButton } from './atoms'

const DIM_LABEL: Record<string, string> = { MASS: 'weight', VOLUME: 'volume', COUNT: 'count' }

export function AdoptFormatModal({
  scanItem,
  onClose,
  onSaved,
}: {
  scanItem: ScanItem
  onClose: () => void
  onSaved: () => void
}) {
  const itemId = scanItem.matchedItemId
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [item, setItem] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!itemId) return
    let alive = true
    setLoading(true)
    fetch(`/api/inventory/${itemId}`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('Failed to load item'))))
      .then(d => { if (alive) { setItem(d); setLoading(false) } })
      .catch(e => { if (alive) { setError(e.message); setLoading(false) } })
    return () => { alive = false }
  }, [itemId])

  // New format derived from the invoice line — identical to the conflict detector.
  const offer = buildOffer(scanItemToOfferInput(scanItem))
  const newChain = offer.packChain as PackLink[]
  // Count unit: the chain's outer container, canonicalised so it reads "case",
  // never the raw OCR abbreviation "cs" (and never a bare base unit).
  const countUnit = canonicalUom(newChain[0]?.unit ?? offer.baseUnit)
  // Human pack label from the OCR pack fields ("1 × 5 lb"), NOT the base-unit
  // chain — rendering the leaf's per (grams) against the container unit produced
  // the nonsensical "2267.96 cs".
  const ocrPackSize = scanItem.invoicePackSize != null ? Number(scanItem.invoicePackSize) : null
  const ocrPackQty  = scanItem.invoicePackQty  != null ? Number(scanItem.invoicePackQty)  : null
  const ocrPackUOM  = scanItem.invoicePackUOM ?? scanItem.rateUOM ?? offer.baseUnit
  const packLabel = ocrPackSize != null
    ? (ocrPackQty && ocrPackQty > 1 ? `${ocrPackQty} × ${ocrPackSize} ${ocrPackUOM}` : `${ocrPackSize} ${ocrPackUOM}`)
    : newChain.map(l => `${Number(l.per)} ${canonicalUom(l.unit)}`).join(' × ')
  const pricingLabel = offer.pricing.mode === 'RATE'
    ? `$${Number(offer.pricing.rate).toFixed(2)} / ${offer.pricing.rateUnit}`
    : `$${Number(offer.pricing.purchasePrice).toFixed(2)} / ${countUnit}`

  const recipeCount = item?.recipeIngredients?.length ?? 0
  const fromDim = item ? (item.dimension ?? dimensionOf(item.baseUnit ?? 'each')) : null
  const fromUnit = item ? (item.countUnit || item.baseUnit) : ''
  // This modal is only reached when the invoice's measure differs from the
  // item's, so the measure changes along with the pack (the server refuses it
  // when the item has history).
  const measureChanges = !!fromDim && fromDim !== offer.dimension
  const measurePhrase = (dim: string, unit: string) =>
    dim === 'COUNT' ? `counted by ${unit}` : `measured by ${DIM_LABEL[dim]}`

  async function confirm() {
    if (!item || !itemId) return
    setSaving(true); setError(null)
    try {
      // The item's own pack + price, naming the row version it was loaded at.
      // The invoice's measure rides along; no stock.
      const res = await fetch(`/api/inventory/${itemId}/pricing`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          packChain: newChain,
          pricing:   offer.pricing,
          countUnit,
          dimension: offer.dimension,
          expectedLastUpdated: item.lastUpdated,
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        const msg: string = d.error || 'Failed to update item'
        if (res.status === 409 && d.code === 'HAS_OFFERS') {
          setError(`${msg} (Editing a box arrives in the next update.)`)
        } else if (res.status === 409 && d.code === 'DIMENSION_LOCKED') {
          setError(msg)
        } else {
          alert(msg)
          setError(msg)
          // Someone saved the item meanwhile — load the fresh row so a retry names it.
          if (res.status === 409 && d.code === 'STALE') {
            const fresh = await fetch(`/api/inventory/${itemId}`).then(r => (r.ok ? r.json() : null)).catch(() => null)
            if (fresh) setItem(fresh)
          }
        }
        setSaving(false)
        return
      }
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update item')
      setSaving(false)
    }
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-[60]" onClick={onClose} />
      <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
        <div className="bg-paper rounded-2xl shadow-xl w-full max-w-md flex flex-col max-h-[90vh]">
          <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-bg-2">
            <div>
              <h3 className="text-[16px] font-semibold text-ink">Change item to match this invoice</h3>
              <p className="text-[12px] text-ink-4 mt-0.5">{item?.itemName ?? scanItem.rawDescription}</p>
            </div>
            <button type="button" onClick={onClose} className="p-2.5 flex items-center justify-center text-ink-4 hover:text-ink-3 transition-colors">
              <X size={18} />
            </button>
          </div>

          <div className="px-6 py-5 space-y-4 text-[13px] text-ink-2">
            {loading ? (
              <div className="flex items-center gap-2 text-ink-4 py-6 justify-center"><Loader2 size={16} className="animate-spin" /> Loading item…</div>
            ) : (
              <>
                <div className="flex items-center gap-3">
                  <div className="flex-1 rounded-lg border border-line bg-bg px-3 py-2">
                    <div className="text-[10px] uppercase tracking-wide text-ink-4">Currently</div>
                    <div className="font-medium text-ink">{fromDim ? DIM_LABEL[fromDim] : '—'} ({fromUnit})</div>
                  </div>
                  <ArrowRight size={16} className="text-ink-4 shrink-0" />
                  <div className="flex-1 rounded-lg border border-line bg-bg px-3 py-2">
                    <div className="text-[10px] uppercase tracking-wide text-ink-4">Will become</div>
                    <div className="font-medium text-ink">{DIM_LABEL[offer.dimension]} ({offer.baseUnit})</div>
                  </div>
                </div>
                <div className="rounded-lg border border-line bg-bg px-3 py-2 space-y-1">
                  <div><span className="text-ink-4">New pack:</span> <span className="font-medium text-ink">{packLabel}</span></div>
                  <div><span className="text-ink-4">New price basis:</span> <span className="font-medium text-ink">{pricingLabel}</span></div>
                </div>
                <div className="flex items-start gap-2 rounded-lg bg-gold-soft/60 border border-gold-soft px-3 py-2.5">
                  <AlertTriangle size={15} className="text-gold-2 mt-0.5 shrink-0" />
                  <div className="text-[12px] text-ink-2 leading-snug">
                    This re-costs <b>{recipeCount} recipe{recipeCount === 1 ? '' : 's'}</b> that use this item.
                  </div>
                </div>
                {measureChanges && fromDim && (
                  <div className="text-[12px] text-ink-3">
                    This changes {item?.itemName ?? 'this item'} from {measurePhrase(fromDim, fromUnit)} to {measurePhrase(offer.dimension, offer.baseUnit)}.
                  </div>
                )}
                {error && <div className="text-[12px] text-red">{error}</div>}
              </>
            )}
          </div>

          <div className="flex justify-end gap-2 px-6 py-4 border-t border-bg-2">
            <ActButton onClick={onClose} disabled={saving}>Cancel</ActButton>
            <ActButton variant="primary" onClick={confirm} disabled={loading || saving}>
              {saving ? <><Loader2 size={14} className="animate-spin" /> Applying…</> : 'Change item & resolve'}
            </ActButton>
          </div>
        </div>
      </div>
    </>
  )
}
