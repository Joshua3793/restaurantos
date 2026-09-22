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
  loadItemRefs,
  TX_OPTIONS,
  type RefCounts,
} from '@/lib/invoice/rollback-load'

const counts = (o: Partial<RefCounts> = {}): RefCounts => ({ ...emptyRefCounts(), ...o })

// `deleteSession`'s `$transaction` runs on the real prisma singleton (mocked
// away above), so the transaction itself isn't exercised here — but the
// options it's called with are a plain exported constant, and getting them
// wrong silently turns every non-trivial invoice delete back into a P2028.
describe('TX_OPTIONS', () => {
  it('gives the rollback transaction real headroom over Prisma\'s defaults (maxWait 2s, timeout 5s)', () => {
    expect(TX_OPTIONS.timeout).toBe(30_000)
    expect(TX_OPTIONS.maxWait).toBe(10_000)
    expect(TX_OPTIONS.timeout).toBeGreaterThan(5_000)
    expect(TX_OPTIONS.maxWait).toBeGreaterThan(2_000)
  })
})

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
  // `invoiceLines` is exercised separately below (it carries the unapproved
  // detail). `stockAllocations`/`revenueCenters` are gone on purpose — see the
  // dedicated describe block below.
  const RELATIONS: Array<[keyof RefCounts, string]> = [
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

// `RefCounts` no longer has a field for these — Fix 3. Both relations are
// `onDelete: Cascade` membership rows (StockAllocation, ItemRevenueCenter) that
// approve itself creates for every (item, non-default RC) pair it touches, not
// a claim on stock. Counting them would make every item an invoice creates on
// a non-default RC (e.g. CATERING) permanently `referenced`.
describe('RefCounts — StockAllocation and ItemRevenueCenter are not fields at all', () => {
  it('emptyRefCounts has no stockAllocations/revenueCenters key', () => {
    const empty = emptyRefCounts() as unknown as Record<string, unknown>
    expect(empty).not.toHaveProperty('stockAllocations')
    expect(empty).not.toHaveProperty('revenueCenters')
  })
})

// `InvoiceScanItem.matchedItem` is SetNull. The old loader counted only
// `approved: true` lines, so deleting a created item could silently null a
// DRAFT invoice's match suggestion on another session. Fix 4: count ALL scan
// lines outside this session (and its clones), and call out how many are
// unapproved so the preview says why the count includes drafts.
describe('referencePhrases — invoice lines carry the unapproved detail', () => {
  it('is empty with no invoice lines', () => {
    expect(referencePhrases(counts({ invoiceLines: 0, unapprovedInvoiceLines: 0 }))).toEqual([])
  })

  it('is a plain count when every line is approved', () => {
    expect(referencePhrases(counts({ invoiceLines: 2, unapprovedInvoiceLines: 0 }))).toEqual(['2 invoice lines'])
  })

  it('is singular at 1 with no unapproved lines', () => {
    expect(referencePhrases(counts({ invoiceLines: 1, unapprovedInvoiceLines: 0 }))).toEqual(['1 invoice line'])
  })

  it('appends the unapproved detail when some lines are drafts', () => {
    expect(referencePhrases(counts({ invoiceLines: 2, unapprovedInvoiceLines: 1 }))).toEqual(['2 invoice lines (1 unapproved)'])
  })

  it('keeps invoice lines right after receipt lines, same relative slot as before', () => {
    expect(referencePhrases(counts({ receiptLines: 1, invoiceLines: 2, unapprovedInvoiceLines: 0 })))
      .toEqual(['1 receipt line', '2 invoice lines'])
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

// ── loadItemRefs — Fix 3 (StockAllocation/ItemRevenueCenter excluded) and
// Fix 4 (all InvoiceScanItem rows counted, unapproved called out) ───────────
type GroupRow = { _count: { _all: number } } & Record<string, unknown>

/** A minimal `Db` stand-in: every model the loader touches, each `groupBy`
 *  resolving to fixture rows keyed by model name (ignoring the query args —
 *  the fixtures are pre-filtered as if the query had already run). Leaving a
 *  key OUT entirely (rather than defaulting it to `[]`) is deliberate where a
 *  test wants "if the loader still queries this table, blow up".
 */
function fakeDb(rows: Partial<Record<string, GroupRow[]>> = {}) {
  const groupBy = (name: string) => async () => rows[name] ?? []
  return {
    invoiceSession: { findMany: async () => rows.clones ?? [] },
    invoiceLineItem: { groupBy: groupBy('invoiceLineItem') },
    invoiceScanItem: { groupBy: groupBy('invoiceScanItem') },
    inventorySnapshot: { groupBy: groupBy('inventorySnapshot') },
    countLine: { groupBy: groupBy('countLine') },
    wastageLog: { groupBy: groupBy('wastageLog') },
    stockTransfer: { groupBy: groupBy('stockTransfer') },
    priceAlert: { groupBy: groupBy('priceAlert') },
    inventorySupplierPrice: { groupBy: groupBy('inventorySupplierPrice') },
    stockAllocation: { groupBy: groupBy('stockAllocation') },
    itemRevenueCenter: { groupBy: groupBy('itemRevenueCenter') },
    recipeIngredient: { groupBy: groupBy('recipeIngredient') },
    recipe: { groupBy: groupBy('recipe') },
    prepItem: { groupBy: groupBy('prepItem') },
    inventoryItem: { groupBy: groupBy('inventoryItem') },
    invoiceMatchRule: { groupBy: groupBy('invoiceMatchRule') },
  }
}

const noPlanned = { offerIds: new Set<string>(), ruleIds: new Set<string>() }
const asDb = (db: ReturnType<typeof fakeDb>) => db as unknown as Parameters<typeof loadItemRefs>[0]

describe('loadItemRefs — StockAllocation and ItemRevenueCenter are excluded entirely', () => {
  it('a created item whose only relations are one StockAllocation row and one ItemRevenueCenter row is deletable', async () => {
    const db = fakeDb({
      stockAllocation: [{ inventoryItemId: 'new-item', _count: { _all: 1 } }],
      itemRevenueCenter: [{ inventoryItemId: 'new-item', _count: { _all: 1 } }],
    })
    const refs = await loadItemRefs(asDb(db), 'session-1', ['new-item'], noPlanned)
    expect(refs.get('new-item')).toEqual({ referencedBy: [] })
  })
})

describe('loadItemRefs — every InvoiceScanItem row outside this session counts, approved or not', () => {
  it('counts an unapproved scan line on another session and calls it out', async () => {
    const db = fakeDb({
      invoiceScanItem: [{ matchedItemId: 'new-item', approved: false, _count: { _all: 1 } }],
    })
    const refs = await loadItemRefs(asDb(db), 'session-1', ['new-item'], noPlanned)
    expect(refs.get('new-item')).toEqual({ referencedBy: ['1 invoice line (1 unapproved)'] })
  })

  it('mixes approved and unapproved lines into one phrase', async () => {
    const db = fakeDb({
      invoiceScanItem: [
        { matchedItemId: 'new-item', approved: true, _count: { _all: 1 } },
        { matchedItemId: 'new-item', approved: false, _count: { _all: 1 } },
      ],
    })
    const refs = await loadItemRefs(asDb(db), 'session-1', ['new-item'], noPlanned)
    expect(refs.get('new-item')).toEqual({ referencedBy: ['2 invoice lines (1 unapproved)'] })
  })

  it('says nothing extra when every counted line is approved', async () => {
    const db = fakeDb({
      invoiceScanItem: [{ matchedItemId: 'new-item', approved: true, _count: { _all: 2 } }],
    })
    const refs = await loadItemRefs(asDb(db), 'session-1', ['new-item'], noPlanned)
    expect(refs.get('new-item')).toEqual({ referencedBy: ['2 invoice lines'] })
  })
})
