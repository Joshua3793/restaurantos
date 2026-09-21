// Repair plan for a supplier offer stored as a case (PACK) price when the
// supplier actually bills by weight — a shape possible only BEFORE this branch
// (line-first receiving + the dimension-aware rate formula). Pure + client-safe,
// so the dry-run script and its tests never touch Prisma or the DB.
//
// The plan never touches `packChain` or the provenance triple (packQty/packSize/
// packUOM) — only `pricing` + `lastPrice` move, exactly like the PRIMARY-offer
// spine write in src/lib/primary-offer.ts.

import { canonicalUom, UNIT_FACTORS } from '@/lib/uom'
import { type ChainItem, type Pricing, rateIsCostable } from '@/lib/item-model'
import { lineReceived, type LineQtyInput } from '@/lib/invoice/line-qty'
import { weightBasisRate } from '@/lib/invoice/approve-format'

/** A weight/volume unit the canonical table knows — never a count or container.
 *  Mirrors the private helper of the same name in line-qty.ts / approve-format.ts. */
function isMeasureUnit(u: string | null | undefined): boolean {
  if (!u) return false
  const f = UNIT_FACTORS[canonicalUom(u)]
  return !!f && f.dim !== 'count'
}

/** The fields of the offer under repair this module needs. */
export interface RepairOffer {
  pricing: unknown
  lastPrice: number
  isPrimary: boolean
}

/** The offer's most recent approved, non-clone purchase line — the evidence a
 *  repair is built from. `null` when the offer has no such line on record. */
export type RepairLine =
  | (LineQtyInput & {
      rate?: unknown
      rateUOM?: string | null
      totalQtyUOM?: string | null
      rawUnit?: string | null
      rawUnitPrice?: unknown
    })
  | null

export interface RepairInput {
  offer: RepairOffer
  item: ChainItem
  lastLine: RepairLine
}

export type RepairPlan =
  | { action: 'rewrite'; pricing: Pricing; lastPrice: number }
  | { action: 'skip'; reason: string }
  | { action: 'human'; reason: string }

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : null
}

/**
 * Decide what (if anything) should happen to a supplier offer's stored pricing.
 *
 * Order matters — each rule only applies once the ones above it are ruled out:
 *  1. no purchase line on record            → skip (nothing to repair from)
 *  2. the line was not received by weight    → skip (a genuine case price)
 *  3. the offer is already a weight RATE     → skip (nothing to fix)
 *  4. the item has no bridge for the rate    → skip (would price as 0 — refuse)
 *  5. the offer is the PRIMARY offer         → human (rewriting it re-prices the
 *                                               item and every recipe using it)
 *  6. otherwise                              → rewrite to a RATE over the
 *                                               canonical rate unit
 */
export function planOfferRepair(a: RepairInput): RepairPlan {
  const { offer, item, lastLine } = a

  if (!lastLine) return { action: 'skip', reason: 'no purchase line on record for this offer' }

  const received = lineReceived(lastLine, item)
  if (received.via !== 'billed-weight' && received.via !== 'shipped-unit') {
    return { action: 'skip', reason: `line was not received by weight (via: ${received.via})` }
  }

  const existing = offer.pricing && typeof offer.pricing === 'object' ? (offer.pricing as Pricing) : null
  if (existing?.mode === 'RATE' && isMeasureUnit(existing.rateUnit)) {
    return { action: 'skip', reason: 'offer is already a weight RATE' }
  }

  const rawRateUnit = lastLine.rateUOM ?? lastLine.totalQtyUOM ?? lastLine.rawUnit ?? null
  const rateUnit = canonicalUom(rawRateUnit)
  if (!rateUnit || !rateIsCostable(rateUnit, item)) {
    return {
      action: 'skip',
      reason: `item has no bridge for the rate unit (${rawRateUnit ?? 'none'})`,
    }
  }

  if (offer.isPrimary) {
    return {
      action: 'human',
      reason: 'offer is the PRIMARY offer — rewriting it re-prices the item and every recipe using it',
    }
  }

  // The naive reading (brief's fallback chain) would trust a printed rate whose
  // unit doesn't even match what is being stored, or fall back to a case price
  // wearing a per-weight label. weightBasisRate is the same reconciliation
  // approve-time already applies to a WEIGHT-basis line: trust a printed rate
  // only when its own rateUOM is a measure unit (or it reconciles unit-less
  // against the line total), else derive it from lineTotal ÷ received weight —
  // so the same invariant approve enforces (received × $/base ≈ lineTotal)
  // holds here too.
  const fallback = num(lastLine.rate) ?? num(lastLine.rawUnitPrice) ?? 0
  const { rate } = weightBasisRate({
    rate: num(lastLine.rate),
    rateUOM: lastLine.rateUOM ?? null,
    rawLineTotal: num(lastLine.rawLineTotal),
    receivedBase: received.base,
    rateUnit,
    item,
    fallback,
  })

  return { action: 'rewrite', pricing: { mode: 'RATE', rate, rateUnit }, lastPrice: rate }
}
