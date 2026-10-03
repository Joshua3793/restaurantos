import { describe, it, expect } from 'vitest'
import { adoptTarget, adoptBlocked } from '@/lib/invoice/adopt-target'

// "Use the invoice's format" must fix the box the invoice speaks for — the
// invoice supplier's box, picked by the same rule the review screen reads lines
// through — never the item's own price while the item has boxes.

const SYSCO = 'sup-sysco'
const GFS = 'sup-gfs'
const box = (id: string, supplierId: string, supplierItemCode: string | null, isPrimary = false) =>
  ({ id, supplierId, supplierItemCode, isPrimary })

describe('adoptTarget', () => {
  it('an item with no boxes changes its own pack and price', () => {
    expect(adoptTarget({ offers: [], supplierId: SYSCO, itemCode: '123' })).toEqual({ kind: 'item' })
  })

  it("picks the invoice supplier's box with the line's SKU, and says whether it is main", () => {
    const offers = [box('b1', GFS, '123', true), box('b2', SYSCO, '999'), box('b3', SYSCO, ' abc ')]
    expect(adoptTarget({ offers, supplierId: SYSCO, itemCode: 'ABC' })).toEqual({ kind: 'box', offerId: 'b3', isPrimary: false })
    expect(adoptTarget({ offers, supplierId: GFS, itemCode: '123' })).toEqual({ kind: 'box', offerId: 'b1', isPrimary: true })
  })

  it("falls back to the supplier's uncoded box, else its only box", () => {
    const uncoded = [box('b1', SYSCO, '111', true), box('b2', SYSCO, null)]
    expect(adoptTarget({ offers: uncoded, supplierId: SYSCO, itemCode: 'NEW' })).toEqual({ kind: 'box', offerId: 'b2', isPrimary: false })
    const only = [box('b1', GFS, null, true), box('b2', SYSCO, '111')]
    expect(adoptTarget({ offers: only, supplierId: SYSCO, itemCode: 'NEW' })).toEqual({ kind: 'box', offerId: 'b2', isPrimary: false })
  })

  it('a supplier with no matching box gets a new box', () => {
    // Sysco has no box at all.
    expect(adoptTarget({ offers: [box('b1', GFS, null, true)], supplierId: SYSCO, itemCode: '123' })).toEqual({ kind: 'new-box' })
    // Sysco has two coded boxes, neither this SKU — a new product.
    const two = [box('b1', SYSCO, '111', true), box('b2', SYSCO, '222')]
    expect(adoptTarget({ offers: two, supplierId: SYSCO, itemCode: '333' })).toEqual({ kind: 'new-box' })
  })

  it('an invoice with no linked supplier cannot pick a box', () => {
    expect(adoptTarget({ offers: [box('b1', SYSCO, null, true)], supplierId: null, itemCode: '123' })).toEqual({ kind: 'unlinked' })
  })
})

// The adopt modal opens only on a measure conflict. A supplier box must be in its
// item's measure, so for an item with boxes nothing may be sent: the main box
// would make the item read "1 case = 9071.84 each" and re-cost every recipe.
describe('adoptBlocked', () => {
  const BOX = { kind: 'box', offerId: 'b1', isPrimary: true } as const
  const NEW_BOX = { kind: 'new-box' } as const

  it("a weight line onto a counted item's box (main or not) or a new box → blocked", () => {
    expect(adoptBlocked({ lineDimension: 'MASS', itemDimension: 'COUNT', target: BOX })).toBe(true)
    expect(adoptBlocked({ lineDimension: 'MASS', itemDimension: 'COUNT', target: { ...BOX, isPrimary: false } })).toBe(true)
    expect(adoptBlocked({ lineDimension: 'MASS', itemDimension: 'COUNT', target: NEW_BOX })).toBe(true)
  })

  it("a counted line or a volume line onto a weight item's box → blocked", () => {
    expect(adoptBlocked({ lineDimension: 'COUNT', itemDimension: 'MASS', target: BOX })).toBe(true)
    expect(adoptBlocked({ lineDimension: 'VOLUME', itemDimension: 'MASS', target: NEW_BOX })).toBe(true)
  })

  it("a box in the item's own measure → not blocked", () => {
    expect(adoptBlocked({ lineDimension: 'MASS', itemDimension: 'MASS', target: BOX })).toBe(false)
  })

  it('an item whose measure is not known yet → a box target is blocked', () => {
    expect(adoptBlocked({ lineDimension: 'MASS', itemDimension: null, target: NEW_BOX })).toBe(true)
  })

  it('a box-less item changes its own measure (the server guards history) → not blocked', () => {
    expect(adoptBlocked({ lineDimension: 'MASS', itemDimension: 'COUNT', target: { kind: 'item' } })).toBe(false)
  })

  it('an unlinked invoice is refused on its own, not by this rule', () => {
    expect(adoptBlocked({ lineDimension: 'MASS', itemDimension: 'COUNT', target: { kind: 'unlinked' } })).toBe(false)
  })
})
