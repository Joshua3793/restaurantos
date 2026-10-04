'use client'
// Confirmation modal for resolving a dimension conflict by taking the invoice
// line's format (the "item is the wrong side" path). Derives the new chain from
// the SAME buildOffer the conflict detector uses, then writes it to the record
// the invoice speaks for (`adoptTarget`):
//   - an item with no supplier boxes → the item's own pack, price and count unit
//     via the pricing route. When the invoice is in another measure the measure
//     changes too; the route allows that only while the item has no history
//     (otherwise DIMENSION_LOCKED, shown here as its plain sentence);
//   - an item with boxes → the INVOICE SUPPLIER's box (picked like `pickOffer`),
//     or a new non-main box for that supplier. The item follows only its main
//     box. A box must be in the item's measure, and this modal is only reached
//     when the line's measure differs from the item's — so for an item with
//     boxes NO request is sent (`adoptBlocked`): the modal links to the item's
//     drawer, where "Change how it's measured" lives, and the button stays off. The
//     box routes refuse a box in another measure too (INVALID), as a backstop.
// It never touches stock (that moves only through counts). Re-costs recipes when
// the item's price moves, so it spells out the impact before the user confirms.

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { X, AlertTriangle, Loader2, ArrowRight } from 'lucide-react'
import type { ScanItem } from '@/components/invoices/types'
import { buildOffer, scanItemToOfferInput } from '@/lib/invoice/offer'
import { adoptTarget, adoptBlocked, type AdoptBox } from '@/lib/invoice/adopt-target'
import { dimensionOf, type PackLink } from '@/lib/item-model'
import { canonicalUom } from '@/lib/uom'
import { ActButton } from './atoms'

const DIM_LABEL: Record<string, string> = { MASS: 'weight', VOLUME: 'volume', COUNT: 'count' }

/** The slice of a supplier box (GET /api/inventory/[id]/suppliers) this modal reads. */
type Box = AdoptBox & { supplierName: string; lastUpdated: string }

export function AdoptFormatModal({
  scanItem,
  supplierId,
  supplierName,
  onClose,
  onSaved,
}: {
  scanItem: ScanItem
  /** The invoice's linked supplier — whose box the line's format belongs on. */
  supplierId: string | null
  supplierName: string | null
  onClose: () => void
  onSaved: () => void
}) {
  const itemId = scanItem.matchedItemId
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [item, setItem] = useState<any>(null)
  const [boxes, setBoxes] = useState<Box[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The item AND its boxes, read together so the target and the row versions a
  // save names come from the same moment.
  const load = useCallback(async () => {
    if (!itemId) return null
    const [i, b] = await Promise.all([
      fetch(`/api/inventory/${itemId}`).then(r => (r.ok ? r.json() : Promise.reject(new Error('Failed to load item')))),
      fetch(`/api/inventory/${itemId}/suppliers`).then(r => (r.ok ? r.json() : Promise.reject(new Error('Failed to load supplier boxes')))),
    ])
    return { item: i, boxes: (Array.isArray(b) ? b : []) as Box[] }
  }, [itemId])

  useEffect(() => {
    if (!itemId) return
    let alive = true
    setLoading(true)
    load()
      .then(d => { if (alive && d) { setItem(d.item); setBoxes(d.boxes); setLoading(false) } })
      .catch(e => { if (alive) { setError(e.message); setLoading(false) } })
    return () => { alive = false }
  }, [itemId, load])

  const target = adoptTarget({ offers: boxes, supplierId, itemCode: scanItem.supplierItemCode ?? null })
  const targetBox = target.kind === 'box' ? boxes.find(b => b.id === target.offerId) ?? null : null

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
  // A box must be in its item's measure: a line in another measure cannot go
  // onto one until the item itself can be re-measured. Nothing is sent.
  const blocked = adoptBlocked({ lineDimension: offer.dimension, itemDimension: fromDim, target })
  const measureWord = (dim: string) => (dim === 'COUNT' ? 'counted' : `by ${DIM_LABEL[dim]}`)

  const itemName: string = item?.itemName ?? scanItem.rawDescription
  const boxSupplier = targetBox?.supplierName ?? supplierName ?? 'this supplier'
  // The item's own price moves only when the item is priced on itself or on the
  // box being changed — only then do recipes re-cost.
  const movesItemPrice = target.kind === 'item' || (target.kind === 'box' && target.isPrimary)
  const targetSentence: ReactNode =
    blocked && fromDim
      ? <>
          This invoice sells {itemName} {measureWord(offer.dimension)}, but the item is {measureWord(fromDim)}. {boxSupplier}&rsquo;s box has to be in the item&rsquo;s measure.{' '}
          <a href={`/inventory?item=${itemId}`} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
            Change how the item is measured from its drawer first.
          </a>
        </>
    : target.kind === 'item' ? "This changes the item's own pack and price."
    : target.kind === 'box' && target.isPrimary
      ? `This updates ${boxSupplier}'s box for ${itemName} — and the item's price, since it is the main box.`
    : target.kind === 'box' ? `This updates ${boxSupplier}'s box for ${itemName}; the item keeps its main box's price.`
    : target.kind === 'new-box'
      ? `This adds a ${boxSupplier} box for ${itemName} with the invoice's pack and price (not the main box).`
    : "Link the invoice's supplier first."
  const confirmLabel =
    target.kind === 'box' ? 'Update box & resolve'
    : target.kind === 'new-box' ? 'Add box & resolve'
    : 'Change item & resolve'

  /** The request that writes the invoice's format to the target. */
  function request(): { url: string; method: 'PATCH' | 'POST'; body: Record<string, unknown> } | null {
    if (blocked) return null
    if (target.kind === 'item') {
      // The item's own pack + price, naming the row version it was loaded at.
      // The invoice's measure rides along so the server can answer DIMENSION_LOCKED; no stock.
      return {
        url: `/api/inventory/${itemId}/pricing`, method: 'PATCH',
        body: { packChain: newChain, pricing: offer.pricing, countUnit, dimension: offer.dimension, expectedLastUpdated: item.lastUpdated },
      }
    }
    if (target.kind === 'box' && targetBox) {
      return {
        url: `/api/inventory/${itemId}/suppliers/${targetBox.id}`, method: 'PATCH',
        body: {
          packChain: newChain, pricing: offer.pricing, dimension: offer.dimension,
          // A line with no SKU leaves the box's code alone — clearing it would
          // stop the supplier's next invoice from finding this box by SKU.
          ...(scanItem.supplierItemCode ? { supplierItemCode: scanItem.supplierItemCode } : {}),
          expectedLastUpdated: targetBox.lastUpdated,
        },
      }
    }
    if (target.kind === 'new-box' && supplierId) {
      return {
        url: `/api/inventory/${itemId}/suppliers`, method: 'POST',
        body: {
          supplierId, supplierItemCode: scanItem.supplierItemCode ?? null,
          packChain: newChain, pricing: offer.pricing, dimension: offer.dimension, makePrimary: false,
          expectedLastUpdated: item.lastUpdated,
        },
      }
    }
    return null
  }

  async function confirm() {
    if (!item || !itemId) return
    const req = request()
    if (!req) return
    setSaving(true); setError(null)
    try {
      const res = await fetch(req.url, {
        method: req.method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        const msg: string = d.error || 'Failed to update item'
        if (res.status === 409 && d.code === 'DIMENSION_LOCKED') {
          setError(msg)
        } else if (res.status === 400 && d.code === 'INVALID') {
          // A box that does not fit the item (the server's sentence says why).
          setError(msg)
        } else {
          alert(msg)
          setError(msg)
          // Someone saved the item or box meanwhile — load fresh rows so a retry names them.
          if (res.status === 409 && d.code === 'STALE') {
            const fresh = await load().catch(() => null)
            if (fresh) { setItem(fresh.item); setBoxes(fresh.boxes) }
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
              <h3 className="text-[16px] font-semibold text-ink">
                {target.kind === 'item' ? 'Change item to match this invoice' : "Use this invoice's pack and price"}
              </h3>
              <p className="text-[12px] text-ink-4 mt-0.5">{itemName}</p>
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
                <div className={target.kind === 'unlinked' || blocked ? 'text-[13px] font-medium text-red' : 'text-[13px] text-ink'}>{targetSentence}</div>
                {target.kind === 'item' && (
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
                )}
                {target.kind !== 'unlinked' && (
                  <div className="rounded-lg border border-line bg-bg px-3 py-2 space-y-1">
                    <div><span className="text-ink-4">New pack:</span> <span className="font-medium text-ink">{packLabel}</span></div>
                    <div><span className="text-ink-4">New price basis:</span> <span className="font-medium text-ink">{pricingLabel}</span></div>
                  </div>
                )}
                {movesItemPrice && !blocked && (
                  <div className="flex items-start gap-2 rounded-lg bg-gold-soft/60 border border-gold-soft px-3 py-2.5">
                    <AlertTriangle size={15} className="text-gold-2 mt-0.5 shrink-0" />
                    <div className="text-[12px] text-ink-2 leading-snug">
                      This re-costs <b>{recipeCount} recipe{recipeCount === 1 ? '' : 's'}</b> that use this item.
                    </div>
                  </div>
                )}
                {target.kind === 'item' && measureChanges && fromDim && (
                  <div className="text-[12px] text-ink-3">
                    This changes {itemName} from {measurePhrase(fromDim, fromUnit)} to {measurePhrase(offer.dimension, offer.baseUnit)}.
                  </div>
                )}
                {error && <div className="text-[12px] text-red">{error}</div>}
              </>
            )}
          </div>

          <div className="flex justify-end gap-2 px-6 py-4 border-t border-bg-2">
            <ActButton onClick={onClose} disabled={saving}>Cancel</ActButton>
            <ActButton variant="primary" onClick={confirm} disabled={loading || saving || !item || target.kind === 'unlinked' || blocked}>
              {saving ? <><Loader2 size={14} className="animate-spin" /> Applying…</> : confirmLabel}
            </ActButton>
          </div>
        </div>
      </div>
    </>
  )
}
