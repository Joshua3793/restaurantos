import { describe, it, expect } from 'vitest'
import {
  isSelfContradictory,
  planItemRewrite,
  planReceiptRefreeze,
  planCountRefreeze,
  type ChainItemRow,
  type ReceiptLine,
  type CountLineRow,
} from '@/lib/invoice/create-new-repair'
import { asChainItem, pricePerBaseUnit } from '@/lib/item-model'

// ─────────────────────────────────────────────────────────────────────────────
// The four real shapes (read-only dump, 2026-09-22). Every product below was
// created from a per-lb invoice line before the create-new seed knew about
// measure units, so each one is frozen through a chain that says 1 lb = 1 base.
// ─────────────────────────────────────────────────────────────────────────────

/** Potatoes Kennebec O/S — COUNT/each, `[{lb:1}]`, RATE $1.99/each. */
const KENNEBEC: ChainItemRow = {
  dimension: 'COUNT', baseUnit: 'each',
  packChain: [{ unit: 'lb', per: 1 }],
  pricing: { mode: 'RATE', rate: 1.99, rateUnit: 'each' },
  countUnit: 'each',
}
/** TRSM Sour Tuscan Salami — same shape, $22.08. */
const SALAMI: ChainItemRow = {
  dimension: 'COUNT', baseUnit: 'each',
  packChain: [{ unit: 'lb', per: 1 }],
  pricing: { mode: 'RATE', rate: 22.08, rateUnit: 'each' },
  countUnit: 'each',
}
/** Fennel O/S — COUNT/each with an `each` chain: the item shape alone is not
 *  self-contradictory (only its per-lb invoice line gives it away). */
const FENNEL: ChainItemRow = {
  dimension: 'COUNT', baseUnit: 'each',
  packChain: [{ unit: 'each', per: 1 }],
  pricing: { mode: 'RATE', rate: 5.49, rateUnit: 'each' },
  countUnit: 'each',
}
/** Kohlrabi Green — MASS/g, but the chain claims 1 lb = 1 g. */
const KOHLRABI: ChainItemRow = {
  dimension: 'MASS', baseUnit: 'g',
  packChain: [{ unit: 'lb', per: 1 }],
  pricing: { mode: 'RATE', rate: 3.99, rateUnit: 'lb' },
  countUnit: 'lb',
}
/** A correct MASS item — the control. */
const CORRECT_MASS: ChainItemRow = {
  dimension: 'MASS', baseUnit: 'g',
  packChain: [{ unit: 'kg', per: 1000 }],
  pricing: { mode: 'RATE', rate: 5.5, rateUnit: 'kg' },
  countUnit: 'kg',
}

describe('isSelfContradictory', () => {
  it('names all three contradictions in the Kennebec / Salami shape', () => {
    for (const item of [KENNEBEC, SALAMI]) {
      const reasons = isSelfContradictory(item)
      expect(reasons).toContain('COUNT with a measure-unit chain link')
      expect(reasons).toContain('RATE per each')
      expect(reasons).toContain('measure link per 1')
    }
  })

  it('names the per-1 measure link on Kohlrabi (MASS, 1 lb = 1 g)', () => {
    expect(isSelfContradictory(KOHLRABI)).toEqual(['measure link per 1'])
  })

  it('says nothing about Fennel — its item shape is a legitimate COUNT item', () => {
    // The audit script catches Fennel from its by-weight invoice line, never
    // from these four fields. Flagging every COUNT item priced $/each here
    // would bury the real findings.
    expect(isSelfContradictory(FENNEL)).toEqual([])
  })

  it('passes a correct MASS item', () => {
    expect(isSelfContradictory(CORRECT_MASS)).toEqual([])
  })

  it('passes a correct COUNT item with an each chain and a case', () => {
    expect(isSelfContradictory({
      dimension: 'COUNT', baseUnit: 'each',
      packChain: [{ unit: 'case', per: 24 }, { unit: 'each', per: 1 }],
      pricing: { mode: 'PACK', purchasePrice: 48 },
    })).toEqual([])
  })
})

describe('planItemRewrite', () => {
  it('rewrites Kennebec to MASS / g / [{lb:453.592}] / RATE 1.99 per lb / count lb', () => {
    const next = planItemRewrite({ item: KENNEBEC, measure: 'lb' })
    expect(next.dimension).toBe('MASS')
    expect(next.baseUnit).toBe('g')
    expect(next.packChain).toEqual([{ unit: 'lb', per: 453.592 }])
    expect(next.pricing).toEqual({ mode: 'RATE', rate: 1.99, rateUnit: 'lb' })
    expect(next.countUnit).toBe('lb')
  })

  it('keeps the rate number unchanged and canonicalises the measure token', () => {
    const next = planItemRewrite({ item: KOHLRABI, measure: 'LBS' })
    expect(next.pricing).toEqual({ mode: 'RATE', rate: 3.99, rateUnit: 'lb' })
    expect(next.packChain).toEqual([{ unit: 'lb', per: 453.592 }])
  })

  it('handles a kg line', () => {
    const next = planItemRewrite({ item: KENNEBEC, measure: 'kg' })
    expect(next).toMatchObject({
      dimension: 'MASS', baseUnit: 'g', countUnit: 'kg',
      packChain: [{ unit: 'kg', per: 1000 }],
      pricing: { mode: 'RATE', rate: 1.99, rateUnit: 'kg' },
    })
  })

  it('handles volume lines (l and ml) as VOLUME / ml', () => {
    expect(planItemRewrite({ item: KENNEBEC, measure: 'l' })).toMatchObject({
      dimension: 'VOLUME', baseUnit: 'ml', countUnit: 'l', packChain: [{ unit: 'l', per: 1000 }],
    })
    expect(planItemRewrite({ item: KENNEBEC, measure: 'ml' })).toMatchObject({
      dimension: 'VOLUME', baseUnit: 'ml', packChain: [{ unit: 'ml', per: 1 }],
    })
  })

  it('carries a PACK price over as the rate rather than inventing one', () => {
    const next = planItemRewrite({
      item: { dimension: 'COUNT', baseUnit: 'each', packChain: [{ unit: 'lb', per: 1 }], pricing: { mode: 'PACK', purchasePrice: 7.25 } },
      measure: 'lb',
    })
    expect(next.pricing).toEqual({ mode: 'RATE', rate: 7.25, rateUnit: 'lb' })
  })

  it('refuses a count / container / unknown measure', () => {
    for (const bad of ['each', 'case', 'widget', '']) {
      expect(() => planItemRewrite({ item: KENNEBEC, measure: bad })).toThrow()
    }
  })
})

// ── Receipts ────────────────────────────────────────────────────────────────

const kennebecLine: ReceiptLine = {
  id: 'ln-kennebec', rawQty: 200, rawUnit: 'lb',
  totalQty: 200, totalQtyUOM: 'lb', rateUOM: 'lb',
  rate: 1.99, rawUnitPrice: 1.99, rawLineTotal: 398,
  receivedQtyBase: 200,
}
const salamiLine: ReceiptLine = {
  id: 'ln-salami', rawQty: 3.74, rawUnit: 'lb',
  totalQty: 3.74, totalQtyUOM: 'lb', rateUOM: 'lb',
  rate: 22.08, rawUnitPrice: 22.08, rawLineTotal: 82.58,
  receivedQtyBase: 3.74,
}
const fennelLine: ReceiptLine = {
  id: 'ln-fennel', rawQty: 12, rawUnit: 'lb',
  totalQty: 12, totalQtyUOM: 'lb', rateUOM: 'lb',
  rate: 5.49, rawUnitPrice: 5.49, rawLineTotal: 65.88,
  receivedQtyBase: 12,
}
/** Kohlrabi's three lines were already frozen in grams — the item was MASS all
 *  along, only its chain was wrong, and the chain never fed this path. */
const kohlrabiLines: ReceiptLine[] = [
  { id: 'ln-k1', rawQty: 10, rawUnit: 'lb', totalQty: 10, totalQtyUOM: 'lb', rateUOM: 'lb', rate: 3.99, rawUnitPrice: 3.99, rawLineTotal: 39.9, receivedQtyBase: 4535.92 },
  { id: 'ln-k2', rawQty: 8, rawUnit: 'lb', totalQty: 8, totalQtyUOM: 'lb', rateUOM: 'lb', rate: 3.99, rawUnitPrice: 3.99, rawLineTotal: 31.92, receivedQtyBase: 3628.736 },
  { id: 'ln-k3', rawQty: 5, rawUnit: 'lb', totalQty: 5, totalQtyUOM: 'lb', rateUOM: 'lb', rate: 3.99, rawUnitPrice: 3.99, rawLineTotal: 19.95, receivedQtyBase: 2267.96 },
]

const correctedOf = (item: ChainItemRow, measure: string) =>
  asChainItem({ ...item, ...planItemRewrite({ item, measure }) })

describe('planReceiptRefreeze', () => {
  it('re-freezes Kennebec 200 lb as 90,718.4 g', () => {
    const [row] = planReceiptRefreeze([kennebecLine], correctedOf(KENNEBEC, 'lb'))
    expect(row.id).toBe('ln-kennebec')
    expect(row.old).toBe(200)
    expect(row.next).toBeCloseTo(90718.4, 1)
    expect(row.via).toBe('billed-weight')
  })

  it('re-freezes Salami 3.74 lb as 1,696.4 g', () => {
    const [row] = planReceiptRefreeze([salamiLine], correctedOf(SALAMI, 'lb'))
    expect(row.next).toBeCloseTo(1696.4, 1)
  })

  it('re-freezes Fennel 12 lb as 5,443.1 g', () => {
    const [row] = planReceiptRefreeze([fennelLine], correctedOf(FENNEL, 'lb'))
    expect(row.next).toBeCloseTo(5443.1, 1)
  })

  it('leaves Kohlrabi unchanged — already grams', () => {
    const rows = planReceiptRefreeze(kohlrabiLines, correctedOf(KOHLRABI, 'lb'))
    expect(rows.map(r => r.next.toFixed(3))).toEqual(['4535.920', '3628.736', '2267.960'])
    expect(rows.every(r => Math.abs(r.next - (r.old ?? 0)) < 0.001)).toBe(true)
  })

  it('ignores the frozen value — it never reads receivedQtyBase back in', () => {
    // A frozen 999 must not become the answer (`via: 'frozen'`), or the repair
    // would be a no-op on exactly the rows it exists to fix.
    const [row] = planReceiptRefreeze([{ ...kennebecLine, receivedQtyBase: 999 }], correctedOf(KENNEBEC, 'lb'))
    expect(row.old).toBe(999)
    expect(row.next).toBeCloseTo(90718.4, 1)
  })

  it('gives an RC clone a share of its parent, never the rule', () => {
    const parent: ReceiptLine = { ...kennebecLine, id: 'p1' }
    const clone: ReceiptLine = { ...kennebecLine, id: 'c1', parentLineId: 'p1', rawLineTotal: 99.5, receivedQtyBase: 50 }
    const rows = planReceiptRefreeze([parent, clone], correctedOf(KENNEBEC, 'lb'))
    const c = rows.find(r => r.id === 'c1')!
    expect(c.next).toBeCloseTo(90718.4 * (99.5 / 398), 1)
    expect(c.via).toBe('clone of billed-weight')
  })

  it('leaves an orphan clone alone', () => {
    const clone: ReceiptLine = { ...kennebecLine, id: 'c2', parentLineId: 'nope', receivedQtyBase: 50 }
    const [row] = planReceiptRefreeze([clone], correctedOf(KENNEBEC, 'lb'))
    expect(row.next).toBe(50)
    expect(row.via).toBe('orphan clone — unchanged')
  })
})

// ── Count lines ─────────────────────────────────────────────────────────────

describe('planCountRefreeze', () => {
  const salami = correctedOf(SALAMI, 'lb')
  const salamiPpb = pricePerBaseUnit(salami)   // $22.08/lb → $/g
  const kohlrabi = correctedOf(KOHLRABI, 'lb')
  const kohlrabiPpb = pricePerBaseUnit(kohlrabi)

  const line = (over: Partial<CountLineRow> & Pick<CountLineRow, 'id'>): CountLineRow =>
    ({ countedQty: 0, selectedUom: 'each', countedQtyBase: 0, ...over })

  it('re-freezes Salami 3.135 lb as 1,422.0 g and values the snapshot at qty × ppb', () => {
    const [row] = planCountRefreeze(
      [line({ id: 'cl-1', countedQty: 3.135, selectedUom: 'lb', countedQtyBase: 3.135, snapshot: { id: 'sn-1', qtyOnHand: 3.135 } })],
      salami, salamiPpb,
    )
    expect(row.old).toBe(3.135)
    expect(row.next).toBeCloseTo(1422.0, 1)
    expect(row.needsDecision).toBe(false)
    expect(row.snapshot!.id).toBe('sn-1')
    expect(row.snapshot!.qtyOnHand).toBeCloseTo(1422.0, 1)
    expect(row.snapshot!.unit).toBe('g')
    expect(row.snapshot!.totalValue).toBeCloseTo(row.next * salamiPpb, 6)
    expect(row.snapshot!.pricePerBaseUnit).toBe(salamiPpb)
  })

  it('re-freezes Kohlrabi 10 lb as 4,535.9 g', () => {
    const [row] = planCountRefreeze(
      [line({ id: 'cl-2', countedQty: 10, selectedUom: 'lb', countedQtyBase: 10, snapshot: { id: 'sn-2', qtyOnHand: 10 } })],
      kohlrabi, kohlrabiPpb,
    )
    expect(row.next).toBeCloseTo(4535.9, 1)
    expect(row.snapshot!.totalValue).toBeCloseTo(4535.92 * kohlrabiPpb, 4)
  })

  it('leaves a 0-each count at 0 and asks no question about it', () => {
    const [row] = planCountRefreeze(
      [line({ id: 'cl-3', countedQty: 0, selectedUom: 'each', countedQtyBase: 0, snapshot: { id: 'sn-3', qtyOnHand: 0 } })],
      salami, salamiPpb,
    )
    expect(row.next).toBe(0)
    // Nothing to decide: zero of an unresolvable unit is still zero.
    expect(row.needsDecision).toBe(false)
  })

  it('flags Salami 3.135 "each" — the corrected item has no each level', () => {
    const [row] = planCountRefreeze(
      [line({ id: 'cl-4', countedQty: 3.135, selectedUom: 'each', countedQtyBase: 3.135, snapshot: { id: 'sn-4', qtyOnHand: 3.135 } })],
      salami, salamiPpb,
    )
    // lineCountedBase falls back to a 1:1 passthrough — 3.135 g, which is
    // nonsense as a quantity and is exactly why it needs a human.
    expect(row.next).toBeCloseTo(3.135, 6)
    expect(row.needsDecision).toBe(true)
  })

  it('resolves that line through --count-unit-override <id>=lb', () => {
    const [row] = planCountRefreeze(
      [line({ id: 'cl-4', countedQty: 3.135, selectedUom: 'each', countedQtyBase: 3.135, snapshot: { id: 'sn-4', qtyOnHand: 3.135 }, unitOverride: 'lb' })],
      salami, salamiPpb,
    )
    expect(row.next).toBeCloseTo(1422.0, 1)
    expect(row.needsDecision).toBe(false)
    expect(row.via).toBe('override 3.135 lb')
  })

  it('sums mixed-unit entries through the corrected chain', () => {
    const [row] = planCountRefreeze(
      [line({ id: 'cl-5', countedQty: 3, selectedUom: 'g', countedQtyBase: 3, entries: [{ unit: 'lb', qty: 2 }, { unit: 'g', qty: 100 }] })],
      salami, salamiPpb,
    )
    expect(row.next).toBeCloseTo(2 * 453.592 + 100, 3)
    expect(row.via).toBe('entries(2)')
  })

  it('refuses a unit override on a mixed-unit line rather than flattening it', () => {
    const [row] = planCountRefreeze(
      [line({ id: 'cl-6', countedQty: 3, selectedUom: 'g', countedQtyBase: 3, entries: [{ unit: 'each', qty: 2 }, { unit: 'g', qty: 100 }], unitOverride: 'lb' })],
      salami, salamiPpb,
    )
    expect(row.needsDecision).toBe(true)
    expect(row.next).toBe(3)
    expect(row.via).toContain('refused')
  })

  it('leaves a skipped or never-counted line alone', () => {
    const rows = planCountRefreeze(
      [line({ id: 'cl-7', countedQty: 5, selectedUom: 'lb', countedQtyBase: 5, skipped: true }),
       line({ id: 'cl-8', countedQty: null, selectedUom: 'lb', countedQtyBase: null })],
      salami, salamiPpb,
    )
    expect(rows.map(r => [r.next, r.via])).toEqual([[5, 'not counted'], [0, 'not counted']])
    expect(rows.every(r => r.snapshot === undefined)).toBe(true)
  })

  it('never rewrites a snapshot that was not frozen from this line', () => {
    const [row] = planCountRefreeze(
      [line({ id: 'cl-9', countedQty: 10, selectedUom: 'lb', countedQtyBase: 10, snapshot: { id: 'sn-9', qtyOnHand: 4535.92 } })],
      kohlrabi, kohlrabiPpb,
    )
    expect(row.snapshot).toBeUndefined()
    expect(row.snapshotMismatch).toBe(true)
  })
})
