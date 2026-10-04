import { describe, it, expect } from 'vitest'
import {
  parseRepairArgs, unitFactorBetween, planUnitless, planBlocked, boxRefreshBlockers,
  planSplitCreateNew, compareToReviewed, appendRepairNote, boxRefreshWrite,
  type BlockedInput, type BoxFacts, type SplitCloneInput, type ParentLineInput,
} from '@/lib/invoice/accuracy-repair'

// ─────────────────────────────────────────────────────────────────────────────
describe('parseRepairArgs', () => {
  it('reads each mode, dry by default', () => {
    expect(parseRepairArgs(['--mode', 'unitless-weight'])).toEqual({ mode: 'unitless-weight', apply: false, withBoxRefresh: false })
    expect(parseRepairArgs(['--mode=blocked', '--with-box-refresh'])).toEqual({ mode: 'blocked', apply: false, withBoxRefresh: true })
    expect(parseRepairArgs(['--mode', 'split-create-new', '--apply'])).toEqual({ mode: 'split-create-new', apply: true, withBoxRefresh: false })
  })
  it('refuses a bare --apply, an unknown flag, an unknown mode, and a box refresh outside blocked', () => {
    expect(parseRepairArgs(['--apply'])).toHaveProperty('error')
    expect(parseRepairArgs([])).toHaveProperty('error')
    expect(parseRepairArgs(['--mode', 'blocked', '--aply'])).toHaveProperty('error')
    expect(parseRepairArgs(['--mode', 'everything'])).toHaveProperty('error')
    expect(parseRepairArgs(['--mode', 'unitless-weight', '--with-box-refresh'])).toHaveProperty('error')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('unitFactorBetween', () => {
  it('names the pure unit factor between two receipts', () => {
    expect(unitFactorBetween(15.775, 15775)).toBe(1000)
    expect(unitFactorBetween(15775, 15.775)).toBe(1 / 1000)
    expect(unitFactorBetween(10, 4535.92)).toBe(453.592)
    expect(unitFactorBetween(10, 22.0462)).toBe(2.20462)
    expect(unitFactorBetween(1, 28.3495)).toBe(28.3495)
  })
  it('tolerates 0.5 % and nothing more', () => {
    expect(unitFactorBetween(10, 10040)).toBe(1000)
    expect(unitFactorBetween(10, 10100)).toBeNull()
  })
  it('is null for anything else', () => {
    expect(unitFactorBetween(10, 13)).toBeNull()
    expect(unitFactorBetween(10, 30)).toBeNull()
    expect(unitFactorBetween(0, 1000)).toBeNull()
    expect(unitFactorBetween(10, 0)).toBeNull()
    expect(unitFactorBetween(10, 10)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('planUnitless', () => {
  const bison = { id: 'b1', prev: 15.775, next: 15775, weightPath: true, assumed: true, clones: [] }
  it('writes the bison receipt (a pure ×1000)', () => {
    expect(planUnitless([bison])).toEqual([
      { id: 'b1', kind: 'write', prev: 15.775, next: 15775, factor: 1000, clones: [] },
    ])
  })
  it('lists a 3× change as "needs a look" and never writes it', () => {
    const [p] = planUnitless([{ ...bison, next: 15.775 * 3 }])
    expect(p.kind).toBe('look')
  })
  it('leaves an unchanged line alone and ignores lines the rule does not cover', () => {
    expect(planUnitless([{ ...bison, prev: 15775 }])[0].kind).toBe('unchanged')
    expect(planUnitless([{ ...bison, assumed: false }])).toEqual([])
    expect(planUnitless([{ ...bison, weightPath: false }])).toEqual([])
  })
  it('never writes a zero, and a never-frozen line is a look, not a write', () => {
    expect(planUnitless([{ ...bison, next: 0 }])[0].kind).toBe('look')
    expect(planUnitless([{ ...bison, prev: null }])[0].kind).toBe('look')
  })
  it('carries an RC copy as parent × share', () => {
    const [p] = planUnitless([{ ...bison, clones: [{ id: 'c1', prev: 3.94375, parentTotal: 400, cloneTotal: 100 }] }])
    expect(p).toMatchObject({ kind: 'write', clones: [{ id: 'c1', prev: 3.94375, next: 15775 * 0.25 }] })
  })
  it('a copy that cannot be shared makes the line a look', () => {
    const [p] = planUnitless([{ ...bison, clones: [{ id: 'c1', prev: 1, parentTotal: 0, cloneTotal: 100 }] }])
    expect(p.kind).toBe('look')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
const D = (s: string) => new Date(s)
const goodBox: BoxFacts = {
  id: 'box1', isPrimary: false, lastUpdated: D('2026-09-01T10:00:00Z'),
  sourcePurchaseDate: D('2026-08-20T00:00:00Z'), newerSameSupplierLine: false,
  linePurchaseDate: D('2026-09-01T00:00:00Z'), sessionApprovedAt: D('2026-09-02T10:00:00Z'),
}
const write = { packChain: [{ unit: 'case', per: 1000 }], pricing: { mode: 'PACK' as const, purchasePrice: 10 }, packQty: 1, packSize: 1, packUOM: 'kg' }
const line = (over: Partial<BlockedInput> = {}): BlockedInput => ({
  id: 'l1', action: 'UPDATE_PRICE', approved: false, matchedItemId: 'i1', sessionStatus: 'APPROVED',
  isClone: false, splitToSessionId: null, item: { isActive: true, mergedIntoId: null },
  receiveBase: 4000, verdict: 'ok', rcId: 'rcK', defaultRcId: 'rcK', hasMembership: true, hasAllocation: false,
  box: null, boxWrite: null, ...over,
})

describe('planBlocked', () => {
  it('a non-split blocked line is received', () => {
    expect(planBlocked([line()], { withBoxRefresh: false })).toEqual([
      { id: 'l1', kind: 'write', receivedQtyBase: 4000, membership: null, allocation: null, boxRefresh: null, boxRefreshBlocked: [] },
    ])
  })
  it('registers the membership, and the allocation only for a non-default RC', () => {
    const [p] = planBlocked([line({ hasMembership: false, rcId: 'rcC' })], { withBoxRefresh: false })
    expect(p).toMatchObject({ kind: 'write', membership: { itemId: 'i1', rcId: 'rcC' }, allocation: { itemId: 'i1', rcId: 'rcC' } })
    const [q] = planBlocked([line({ hasMembership: false })], { withBoxRefresh: false })
    expect(q).toMatchObject({ membership: { itemId: 'i1', rcId: 'rcK' }, allocation: null })
  })
  it('a split parent is skipped — its RC copy already counts', () => {
    expect(planBlocked([line({ splitToSessionId: 'clone1' })], { withBoxRefresh: false })[0].kind).toBe('skip-split-parent')
  })
  it('an RC copy, an approved line, a non-priced action, an unapproved session are not candidates', () => {
    expect(planBlocked([line({ isClone: true }), line({ approved: true }), line({ action: 'CREATE_NEW' }), line({ sessionStatus: 'REVIEW' }), line({ matchedItemId: null })], { withBoxRefresh: false })).toEqual([])
  })
  it('a switched-off or merged item is listed, not written', () => {
    expect(planBlocked([line({ item: { isActive: false, mergedIntoId: null } })], { withBoxRefresh: false })[0]).toMatchObject({ kind: 'listed', reason: 'switched-off' })
    expect(planBlocked([line({ item: { isActive: false, mergedIntoId: 'x' } })], { withBoxRefresh: false })[0]).toMatchObject({ kind: 'listed', reason: 'merged' })
  })
  it('a line that cannot be received is listed', () => {
    expect(planBlocked([line({ receiveBase: 0 })], { withBoxRefresh: false })[0]).toMatchObject({ kind: 'listed', reason: 'cannot-receive' })
  })
  it('refreshes a qualifying non-primary box only with the flag', () => {
    const l = line({ box: goodBox, boxWrite: write })
    expect(planBlocked([l], { withBoxRefresh: false })[0]).toMatchObject({ boxRefresh: null })
    expect(planBlocked([l], { withBoxRefresh: true })[0]).toMatchObject({ boxRefresh: { boxId: 'box1', write } })
  })
  it('never refreshes the primary, and never gives a box-less item a box', () => {
    expect(planBlocked([line({ box: { ...goodBox, isPrimary: true }, boxWrite: write })], { withBoxRefresh: true })[0]).toMatchObject({ boxRefresh: null })
    expect(planBlocked([line({ box: null, boxWrite: write })], { withBoxRefresh: true })[0]).toMatchObject({ boxRefresh: null })
  })
})

describe('boxRefreshBlockers — each condition alone blocks the refresh', () => {
  const ok = (box: BoxFacts | null, verdict = 'ok') => boxRefreshBlockers(box, verdict)
  it('passes the qualifying box', () => expect(ok(goodBox)).toEqual([]))
  it('(1) no box / the primary', () => {
    expect(ok(null)).toHaveLength(1)
    expect(ok({ ...goodBox, isPrimary: true })).toHaveLength(1)
  })
  it('(2) the decision is not ok', () => expect(ok(goodBox, 'PACK_DISAGREES')).toHaveLength(1))
  it('(3) a newer approved line from the same supplier', () => expect(ok({ ...goodBox, newerSameSupplierLine: true })).toHaveLength(1))
  it('(4) the box came from a later (or unknown) invoice', () => {
    expect(ok({ ...goodBox, sourcePurchaseDate: D('2026-09-05T00:00:00Z') })).toHaveLength(1)
    expect(ok({ ...goodBox, sourcePurchaseDate: goodBox.linePurchaseDate })).toHaveLength(1)
    expect(ok({ ...goodBox, sourcePurchaseDate: null })).toHaveLength(1)
  })
  it('(5) the box was edited after this invoice was approved', () => {
    expect(ok({ ...goodBox, lastUpdated: D('2026-09-03T00:00:00Z') })).toHaveLength(1)
    expect(ok({ ...goodBox, sessionApprovedAt: null })).toHaveLength(1)
  })
})

describe('boxRefreshWrite — the approve route\'s offer write', () => {
  const item = { dimension: 'MASS', baseUnit: 'g', countUnit: 'kg', packChain: [{ unit: 'case', per: 3000 }], eachMeasureQty: null, eachMeasureUnit: null }
  const lineIn = { invoicePackQty: 4, invoicePackSize: 1, invoicePackUOM: 'lb', rawUnitPrice: 40, rawUnit: 'CS' }
  it('a case line with a printed pack builds the chain from the pack', () => {
    const w = boxRefreshWrite({
      line: lineIn, item, heldChain: null,
      d: { isUomMode: false, resolvedRateUnit: 'kg', reverseBridge: false, reverseBasePerCase: 0, newPurchasePrice: 40 },
    })
    expect(w.pricing).toEqual({ mode: 'PACK', purchasePrice: 40 })
    expect(w.packChain[0].unit).toBe('case')
    expect(w.packQty).toBe(4); expect(w.packSize).toBe(1); expect(w.packUOM).toBe('lb')
  })
  it('a line with no pack keeps the supplier\'s own chain', () => {
    const held = [{ unit: 'case', per: 2000 }]
    const w = boxRefreshWrite({
      line: { ...lineIn, invoicePackQty: null, invoicePackSize: null }, item, heldChain: held,
      d: { isUomMode: false, resolvedRateUnit: 'kg', reverseBridge: false, reverseBasePerCase: 0, newPurchasePrice: 40 },
    })
    expect(w.packChain).toEqual(held)
    expect(w).toMatchObject({ packQty: null, packSize: null, packUOM: null, pricing: { mode: 'PACK', purchasePrice: 40 } })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('planSplitCreateNew', () => {
  const clone: SplitCloneInput = { id: 'c1', parentSessionId: 'P', rawDescription: 'Venison', sortOrder: 3, rawLineTotal: 100, receivedQtyBase: null, rcId: 'rcC' }
  const parent: ParentLineInput = { id: 'p1', sessionId: 'P', rawDescription: 'Venison', sortOrder: 3, matchedItemId: 'item1', receivedQtyBase: 7050, rawLineTotal: 100 }
  const base = {
    clones: [clone], parents: [parent],
    itemCreatedBySession: new Map<string, string[]>(),
    items: new Map([['item1', { name: 'Venison Striploin', isActive: true, mergedIntoId: null }]]),
    memberships: new Set<string>(),
  }
  it('a unique parent → link the created item and its share of the receipt', () => {
    expect(planSplitCreateNew(base)).toEqual([{
      id: 'c1', kind: 'write', itemId: 'item1', itemName: 'Venison Striploin', share: 1,
      receivedQtyBase: 7050, kept: null, membership: { itemId: 'item1', rcId: 'rcC' }, flags: [],
    }])
  })
  it('scales the receipt by the money share', () => {
    const [p] = planSplitCreateNew({ ...base, clones: [{ ...clone, rawLineTotal: 25 }] })
    expect(p).toMatchObject({ kind: 'write', share: 0.25, receivedQtyBase: 7050 * 0.25 })
  })
  it('two parents with the same description and position → needs a look', () => {
    const [p] = planSplitCreateNew({ ...base, parents: [parent, { ...parent, id: 'p2' }] })
    expect(p.kind).toBe('look')
  })
  it('no parent, or a parent with no product → needs a look', () => {
    expect(planSplitCreateNew({ ...base, parents: [] })[0].kind).toBe('look')
    expect(planSplitCreateNew({ ...base, parents: [{ ...parent, matchedItemId: null }] })[0].kind).toBe('look')
  })
  it('an ITEM_CREATED record naming another product → needs a look; naming this one → fine', () => {
    expect(planSplitCreateNew({ ...base, itemCreatedBySession: new Map([['P', ['other']]]) })[0].kind).toBe('look')
    expect(planSplitCreateNew({ ...base, itemCreatedBySession: new Map([['P', ['item1']]]) })[0].kind).toBe('write')
  })
  it('a clone already frozen keeps its receipt (reported when it differs)', () => {
    const [same] = planSplitCreateNew({ ...base, clones: [{ ...clone, receivedQtyBase: 7050 }] })
    expect(same).toMatchObject({ kind: 'write', receivedQtyBase: null, kept: { value: 7050, fromParent: 7050, differs: false } })
    const [diff] = planSplitCreateNew({ ...base, clones: [{ ...clone, receivedQtyBase: 70.5 }] })
    expect(diff).toMatchObject({ kind: 'write', receivedQtyBase: null, kept: { value: 70.5, differs: true } })
  })
  it('a switched-off product is linked anyway and flagged; a merged one is a look', () => {
    const off = new Map([['item1', { name: 'B11NV', isActive: false, mergedIntoId: null }]])
    expect(planSplitCreateNew({ ...base, items: off })[0]).toMatchObject({ kind: 'write', flags: ['switched-off'] })
    const merged = new Map([['item1', { name: 'B11NV', isActive: false, mergedIntoId: 'x' }]])
    expect(planSplitCreateNew({ ...base, items: merged })[0].kind).toBe('look')
  })
  it('skips the membership when it exists', () => {
    expect(planSplitCreateNew({ ...base, memberships: new Set(['item1|rcC']) })[0]).toMatchObject({ membership: null })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('compareToReviewed', () => {
  it('passes when the fresh set is the reviewed set minus rows already applied', () => {
    expect(compareToReviewed({ reviewed: ['a', 'b', 'c'], fresh: ['a', 'b', 'c'], applied: [] }).ok).toBe(true)
    expect(compareToReviewed({ reviewed: ['a', 'b', 'c'], fresh: ['c'], applied: ['a', 'b'] }).ok).toBe(true)
  })
  it('refuses a new row, or a reviewed row that vanished without being applied', () => {
    expect(compareToReviewed({ reviewed: ['a'], fresh: ['a', 'z'], applied: [] })).toEqual({ ok: false, added: ['z'], missing: [] })
    expect(compareToReviewed({ reviewed: ['a', 'b'], fresh: ['a'], applied: [] })).toEqual({ ok: false, added: [], missing: ['b'] })
  })
})

describe('appendRepairNote', () => {
  it('appends one plain sentence, once', () => {
    const once = appendRepairNote('1 line skipped — price not updated.', 3, 'Oct 4, 2026')
    expect(once).toBe('1 line skipped — price not updated. Stock for 3 lines was received on Oct 4, 2026 by the invoice-accuracy repair; prices were left as they were.')
    expect(appendRepairNote(once, 3, 'Oct 4, 2026')).toBe(once)
    expect(appendRepairNote(null, 1, 'Oct 4, 2026')).toBe('Stock for 1 line was received on Oct 4, 2026 by the invoice-accuracy repair; prices were left as they were.')
  })
})
