import { describe, it, expect, vi } from 'vitest'
// rollback-load.ts imports the prisma singleton (deleteSession runs the
// transaction on it). The pure pieces under test never touch it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const prismaMock = vi.hoisted(() => ({}) as any)
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
import type { Canon } from '@/lib/invoice/approve-undo'
import type { UndoRecord, CurrentOffer } from '@/lib/invoice/rollback'
import {
  referencePhrases,
  plannedRowDeletes,
  emptyRefCounts,
  type RefCounts,
} from '@/lib/invoice/rollback-load'

const counts = (o: Partial<RefCounts> = {}): RefCounts => ({ ...emptyRefCounts(), ...o })

describe('referencePhrases', () => {
  it('is empty when nothing points at the item', () => {
    expect(referencePhrases(counts())).toEqual([])
  })

  it('renders one phrase per non-zero relation, singular at 1', () => {
    expect(referencePhrases(counts({ recipes: 1 }))).toEqual(['1 recipe'])
    expect(referencePhrases(counts({ recipes: 3 }))).toEqual(['3 recipes'])
  })

  it('pluralises "learned match" irregularly', () => {
    expect(referencePhrases(counts({ matchRules: 1 }))).toEqual(['1 learned match'])
    expect(referencePhrases(counts({ matchRules: 2 }))).toEqual(['2 learned matches'])
  })

  // One case per relation the loader counts. If a relation is ever dropped from
  // RefCounts this table stops compiling — which is the point: the reference
  // check is the only thing standing between a rollback and silent data loss.
  const RELATIONS: Array<[keyof RefCounts, string]> = [
    ['approvedInvoiceLines', '2 approved invoice lines'],
    ['receiptLines', '2 receipt lines'],
    ['snapshots', '2 count snapshots'],
    ['countLines', '2 count lines'],
    ['wastageLogs', '2 wastage logs'],
    ['stockTransfers', '2 stock transfers'],
    ['priceAlerts', '2 price alerts'],
    ['matchRules', '2 learned matches'],
    ['recipeIngredients', '2 recipe ingredients'],
    ['recipes', '2 recipes'],
    ['prepItems', '2 prep items'],
    ['mergedItems', '2 merged items'],
    ['supplierOffers', '2 supplier prices'],
    ['stockAllocations', '2 stock allocations'],
    ['revenueCenters', '2 revenue centers'],
  ]
  it.each(RELATIONS)('counts %s', (key, phrase) => {
    expect(referencePhrases(counts({ [key]: 2 }))).toEqual([phrase])
  })

  it('joins several relations in table order', () => {
    expect(referencePhrases(counts({ recipes: 1, countLines: 4, supplierOffers: 2 })))
      .toEqual(['4 count lines', '2 supplier prices', '1 recipe'])
  })

  it('ignores negative or non-finite counts rather than printing them', () => {
    expect(referencePhrases(counts({ recipes: -1, countLines: NaN }))).toEqual([])
  })
})

// ── which offer / rule rows the plan will delete ─────────────────────────────
// Those are exactly the rows this deletion removes anyway, so they must not
// count as references keeping a created item alive. A created row that has
// CHANGED since the approval is NOT deleted (the planner skips it), so it does
// still count — and it keeps its item.
const offerCanon = (o: Partial<Canon> = {}): Canon => ({
  isPrimary: false,
  lastInvoiceSessionId: null,
  lastPrice: 10,
  packChain: null,
  packQty: null,
  packSize: null,
  packUOM: null,
  pricing: null,
  supplierId: null,
  supplierItemCode: null,
  ...o,
})

const ruleCanon = (o: Partial<Canon> = {}): Canon => ({
  inventoryItemId: 'i1',
  invoicePackQty: null,
  invoicePackSize: null,
  invoicePackUOM: null,
  rawDescription: 'ROMAINE 24CT',
  supplierName: 'SYSCO',
  supplierItemCode: null,
  ...o,
})

const asCurrentOffer = (c: Canon, inventoryItemId = 'i1'): CurrentOffer =>
  ({ ...c, inventoryItemId, supplierName: 'SYSCO' })

describe('plannedRowDeletes', () => {
  const rec = (o: Partial<UndoRecord>): UndoRecord =>
    ({ kind: 'OFFER', targetId: 'o1', prev: null, next: offerCanon(), ...o })

  it('deletes a created offer whose row still equals next', () => {
    const got = plannedRowDeletes(
      [rec({})],
      new Map([['o1', asCurrentOffer(offerCanon())]]),
      new Map(),
    )
    expect([...got.offerIds]).toEqual(['o1'])
    expect([...got.ruleIds]).toEqual([])
  })

  it('keeps a created offer that changed since the approval', () => {
    const got = plannedRowDeletes(
      [rec({})],
      new Map([['o1', asCurrentOffer(offerCanon({ lastPrice: 99 }))]]),
      new Map(),
    )
    expect([...got.offerIds]).toEqual([])
  })

  it('keeps a created offer whose row is already gone (nothing to exclude)', () => {
    const got = plannedRowDeletes([rec({})], new Map(), new Map())
    expect([...got.offerIds]).toEqual([])
  })

  it('never excludes an offer the approval only UPDATED (prev !== null)', () => {
    const got = plannedRowDeletes(
      [rec({ prev: offerCanon({ lastPrice: 8 }) })],
      new Map([['o1', asCurrentOffer(offerCanon())]]),
      new Map(),
    )
    expect([...got.offerIds]).toEqual([])
  })

  it('does the same for created match rules', () => {
    const records: UndoRecord[] = [
      { kind: 'MATCH_RULE', targetId: 'r1', prev: null, next: ruleCanon() },
      { kind: 'MATCH_RULE', targetId: 'r2', prev: null, next: ruleCanon({ rawDescription: 'moved on' }) },
      { kind: 'MATCH_RULE', targetId: 'r3', prev: ruleCanon(), next: ruleCanon() },
    ]
    const rules = new Map<string, Canon>([
      ['r1', ruleCanon()],
      ['r2', ruleCanon()],
      ['r3', ruleCanon()],
    ])
    const got = plannedRowDeletes(records, new Map(), rules)
    expect([...got.ruleIds]).toEqual(['r1'])
  })

  it('ignores ITEM and ITEM_CREATED records', () => {
    const records: UndoRecord[] = [
      { kind: 'ITEM', targetId: 'i1', prev: null, next: {} },
      { kind: 'ITEM_CREATED', targetId: 'i2', prev: null, next: {} },
    ]
    const got = plannedRowDeletes(records, new Map(), new Map())
    expect([...got.offerIds]).toEqual([])
    expect([...got.ruleIds]).toEqual([])
  })

  it('compares through the selector, so display fields never look like a change', () => {
    // `inventoryItemId` / `supplierName` hang off CurrentOffer but are not in
    // the OFFER selector — they must not make the row look edited.
    const got = plannedRowDeletes(
      [rec({})],
      new Map([['o1', asCurrentOffer(offerCanon(), 'a-different-item')]]),
      new Map(),
    )
    expect([...got.offerIds]).toEqual(['o1'])
  })
})
