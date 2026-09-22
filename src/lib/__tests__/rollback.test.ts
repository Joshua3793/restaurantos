import { describe, it, expect, vi } from 'vitest'
// approve-undo.ts imports the prisma singleton for UndoCollector's default db.
// rollback.ts only imports its TYPE, but the module graph still resolves it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const prismaMock = vi.hoisted(() => ({}) as any)
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
import { Prisma } from '@prisma/client'
import type { Canon } from '@/lib/invoice/approve-undo'
import {
  planRollback,
  executeRollback,
  executeRestores,
  executeCreatedItemDeletes,
  type PlanInput,
  type CurrentItem,
  type CurrentOffer,
  type ItemRefs,
  type UndoRecord,
} from '@/lib/invoice/rollback'

// ── canonical shapes: exactly the selector field sets, nothing else ──────────
const itemCanon = (o: Partial<Canon> = {}): Canon => ({
  densityGPerMl: null,
  packChain: [{ unit: 'case', per: 24 }],
  pricing: { mode: 'PACK', purchasePrice: 10 },
  purchasePrice: 10,
  ...o,
})

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
  rawDescription: 'CILANTRO BUNCH',
  supplierItemCode: null,
  supplierName: 'Sysco',
  ...o,
})

const input = (o: Partial<PlanInput> = {}): PlanInput => ({
  records: [],
  current: { offers: new Map<string, CurrentOffer>(), items: new Map<string, CurrentItem>(), rules: new Map<string, Canon>() },
  refs: new Map<string, ItemRefs>(),
  legacy: null,
  ...o,
})

const item = (canon: Canon, itemName = 'Cilantro'): CurrentItem => ({ ...canon, itemName })
const offer = (canon: Canon, inventoryItemId = 'i1', supplierName = 'Sysco'): CurrentOffer => ({ ...canon, inventoryItemId, supplierName })
const noRefs: ItemRefs = { referencedBy: [] }

describe('planRollback — the one restore rule', () => {
  it('restores prev when the row still equals what the approval wrote', () => {
    const prev = itemCanon({ purchasePrice: 4.99, pricing: { mode: 'PACK', purchasePrice: 4.99 } })
    const next = itemCanon({ purchasePrice: 15.98, pricing: { mode: 'PACK', purchasePrice: 15.98 } })
    const plan = planRollback(
      input({
        records: [{ kind: 'ITEM', targetId: 'i1', prev, next }],
        current: { offers: new Map(), items: new Map([['i1', item(next)]]), rules: new Map() },
      })
    )
    expect(plan.rows).toHaveLength(1)
    expect(plan.rows[0]).toMatchObject({ kind: 'ITEM', targetId: 'i1', name: 'Cilantro', outcome: 'restored' })
    expect(plan.rows[0].write).toEqual({ table: 'item', op: 'update', data: prev })
    expect(plan.restoredItemIds).toEqual(['i1'])
    expect(plan.summary).toEqual({ restored: 1, deleted: 0, skipped: 0, bestEffort: 0 })
    expect(plan.legacy).toBe(false)
  })

  it('the display fields on `current` never make a row look changed', () => {
    const prev = itemCanon({ purchasePrice: 1 })
    const next = itemCanon({ purchasePrice: 2 })
    const plan = planRollback(
      input({
        records: [{ kind: 'ITEM', targetId: 'i1', prev, next }],
        // itemName is NOT a selector field; the same selector strips it both sides
        current: { offers: new Map(), items: new Map([['i1', item(next, 'Cilantro, bunch')]]), rules: new Map() },
      })
    )
    expect(plan.rows[0].outcome).toBe('restored')
    expect(plan.rows[0].name).toBe('Cilantro, bunch')
  })

  it('skips a row that changed since the approval — never overwrite a value the session did not write', () => {
    const plan = planRollback(
      input({
        records: [{ kind: 'ITEM', targetId: 'i1', prev: itemCanon({ purchasePrice: 1 }), next: itemCanon({ purchasePrice: 2 }) }],
        current: { offers: new Map(), items: new Map([['i1', item(itemCanon({ purchasePrice: 3 }))]]), rules: new Map() },
      })
    )
    expect(plan.rows[0]).toMatchObject({ outcome: 'skipped', reason: 'changed-since' })
    expect(plan.rows[0].write).toBeUndefined()
    expect(plan.summary.skipped).toBe(1)
  })

  it('deletes a row the approval created (prev = null)', () => {
    const next = offerCanon({ lastPrice: 46.4 })
    const plan = planRollback(
      input({
        records: [{ kind: 'OFFER', targetId: 'o1', prev: null, next }],
        current: { offers: new Map([['o1', offer(next)]]), items: new Map(), rules: new Map() },
      })
    )
    expect(plan.rows[0]).toMatchObject({ kind: 'OFFER', outcome: 'deleted', name: 'Sysco' })
    expect(plan.rows[0].write).toEqual({ table: 'offer', op: 'delete' })
    expect(plan.summary).toEqual({ restored: 0, deleted: 1, skipped: 0, bestEffort: 0 })
  })

  it('names an offer after its supplier and item when both are loaded', () => {
    const next = offerCanon()
    const plan = planRollback(
      input({
        records: [{ kind: 'OFFER', targetId: 'o1', prev: null, next }],
        current: {
          offers: new Map([['o1', offer(next, 'i1', 'GFS')]]),
          items: new Map([['i1', item(itemCanon(), 'Cilantro')]]),
          rules: new Map(),
        },
      })
    )
    expect(plan.rows[0].name).toBe('GFS → Cilantro')
  })

  it("skips 'gone' when the target no longer exists", () => {
    const plan = planRollback(
      input({
        records: [
          { kind: 'ITEM', targetId: 'i-missing', prev: itemCanon(), next: itemCanon() },
          { kind: 'MATCH_RULE', targetId: 'r-missing', prev: ruleCanon(), next: ruleCanon() },
        ],
      })
    )
    expect(plan.rows.map(r => [r.outcome, r.reason])).toEqual([
      ['skipped', 'gone'],
      ['skipped', 'gone'],
    ])
    // a gone rule still gets a readable name off the record itself
    expect(plan.rows[1].name).toBe('CILANTRO BUNCH')
  })

  it('restores a learned match rule to its prev', () => {
    const prev = ruleCanon({ inventoryItemId: 'other-item', supplierItemCode: 'CODE1' })
    const next = ruleCanon({ inventoryItemId: 'i1', supplierItemCode: null })
    const plan = planRollback(
      input({
        records: [{ kind: 'MATCH_RULE', targetId: 'r1', prev, next }],
        current: { offers: new Map(), items: new Map(), rules: new Map([['r1', next]]) },
      })
    )
    expect(plan.rows[0]).toMatchObject({ kind: 'MATCH_RULE', outcome: 'restored', name: 'CILANTRO BUNCH' })
    expect(plan.rows[0].write).toEqual({ table: 'rule', op: 'update', data: prev })
    // a rule is not an item price — it must not trigger a re-cost
    expect(plan.restoredItemIds).toEqual([])
  })
})

describe('planRollback — ITEM_CREATED', () => {
  const rec: UndoRecord = { kind: 'ITEM_CREATED', targetId: 'new-item', prev: null, next: itemCanon() }
  const current = { offers: new Map<string, CurrentOffer>(), items: new Map([['new-item', item(itemCanon(), 'New Product')]]), rules: new Map<string, Canon>() }

  it('deletes an unreferenced created item', () => {
    const plan = planRollback(input({ records: [rec], current, refs: new Map([['new-item', noRefs]]) }))
    expect(plan.rows[0]).toMatchObject({ outcome: 'deleted', name: 'New Product' })
    expect(plan.rows[0].write).toEqual({ table: 'item', op: 'delete' })
  })

  it.each([
    ['an approved line on another session', ['3 approved invoice lines']],
    ['a recipe ingredient', ['1 recipe']],
    ['a count line', ['count snapshot']],
    ['a remaining supplier offer', ['supplier offer']],
    ['a wastage log', ['wastage log']],
    ['a stock transfer', ['stock transfer']],
    ['a price alert', ['price alert']],
    ['a learned match', ['learned match']],
  ])('keeps a created item referenced by %s', (_label, referencedBy) => {
    const plan = planRollback(input({ records: [rec], current, refs: new Map([['new-item', { referencedBy }]]) }))
    expect(plan.rows[0]).toMatchObject({ outcome: 'skipped', reason: 'referenced' })
    expect(plan.rows[0].write).toBeUndefined()
  })

  it('reports every reference the loader found in `detail`', () => {
    const refs = new Map([['new-item', { referencedBy: ['3 approved invoice lines', '1 recipe', 'wastage log'] }]])
    const plan = planRollback(input({ records: [rec], current, refs }))
    expect(plan.rows[0]).toMatchObject({
      outcome: 'skipped',
      reason: 'referenced',
      detail: '3 approved invoice lines, 1 recipe, wastage log',
    })
  })

  it('keeps a created item whose references were never checked — a target absent from `refs` is never deleted', () => {
    const plan = planRollback(input({ records: [rec], current, refs: new Map() }))
    expect(plan.rows[0]).toMatchObject({ outcome: 'skipped', reason: 'referenced' })
    expect(plan.rows[0].write).toBeUndefined()
    expect(plan.rows[0].detail).toBeTruthy() // says WHY, so the preview isn't mute
  })

  it('skips a created item that changed since the approval, before any reference check', () => {
    const changed = { offers: new Map<string, CurrentOffer>(), items: new Map([['new-item', item(itemCanon({ purchasePrice: 99 }))]]), rules: new Map<string, Canon>() }
    const plan = planRollback(input({ records: [rec], current: changed, refs: new Map([['new-item', noRefs]]) }))
    expect(plan.rows[0]).toMatchObject({ outcome: 'skipped', reason: 'changed-since' })
  })

  // InventorySupplierPrice.inventoryItemId is `onDelete: Cascade`. Deleting the
  // item takes EVERY offer on it with it — including one this plan deliberately
  // refused to touch. A kept offer therefore protects its item, whatever `refs`
  // (loaded before the plan existed) says.
  it('keeps a created item when an offer on it was kept: the cascade would eat it', () => {
    const offerNext = offerCanon({ lastPrice: 46.4 })
    const plan = planRollback(
      input({
        records: [
          { kind: 'OFFER', targetId: 'o1', prev: null, next: offerNext },
          rec,
        ],
        current: {
          // the offer was re-priced after the approval ⇒ skipped 'changed-since'
          offers: new Map([['o1', offer(offerCanon({ lastPrice: 99 }), 'new-item', 'Sysco')]]),
          items: new Map([['new-item', item(itemCanon(), 'New Product')]]),
          rules: new Map(),
        },
        refs: new Map([['new-item', noRefs]]),
      })
    )
    expect(plan.rows[0]).toMatchObject({ kind: 'OFFER', outcome: 'skipped', reason: 'changed-since' })
    expect(plan.rows[1]).toMatchObject({ kind: 'ITEM_CREATED', outcome: 'skipped', reason: 'referenced' })
    expect(plan.rows[1].write).toBeUndefined()
    expect(plan.summary).toEqual({ restored: 0, deleted: 0, skipped: 2, bestEffort: 0 })
  })

  it('still deletes a created item whose offers are all being deleted with it', () => {
    const offerNext = offerCanon({ lastPrice: 46.4 })
    const plan = planRollback(
      input({
        records: [
          { kind: 'OFFER', targetId: 'o1', prev: null, next: offerNext },
          rec,
        ],
        current: {
          offers: new Map([['o1', offer(offerNext, 'new-item', 'Sysco')]]),
          items: new Map([['new-item', item(itemCanon(), 'New Product')]]),
          rules: new Map(),
        },
        refs: new Map([['new-item', noRefs]]),
      })
    )
    expect(plan.rows.map(r => r.outcome)).toEqual(['deleted', 'deleted'])
  })

  // `InvoiceMatchRule.inventoryItemId` is `onDelete: Restrict` — not Cascade like
  // an offer. Deleting a created item while a Restrict FK still points at it
  // doesn't quietly gut a row, it THROWS and aborts the whole transaction. A
  // match rule the approval created but someone has since edited is SKIPPED by
  // the planner (still equals `next`? no), so it survives and must protect its
  // item exactly like a kept offer does.
  it('keeps a created item when a match rule pointing at it was kept: Restrict would throw', () => {
    const ruleNext = ruleCanon({ inventoryItemId: 'new-item' })
    const plan = planRollback(
      input({
        records: [
          { kind: 'MATCH_RULE', targetId: 'r1', prev: null, next: ruleNext },
          rec,
        ],
        current: {
          offers: new Map(),
          items: new Map([['new-item', item(itemCanon(), 'New Product')]]),
          // edited since the approval (supplierItemCode moved) ⇒ skipped 'changed-since'
          rules: new Map([['r1', ruleCanon({ inventoryItemId: 'new-item', supplierItemCode: 'CHANGED' })]]),
        },
        refs: new Map([['new-item', noRefs]]),
      })
    )
    expect(plan.rows[0]).toMatchObject({ kind: 'MATCH_RULE', outcome: 'skipped', reason: 'changed-since' })
    expect(plan.rows[1]).toMatchObject({ kind: 'ITEM_CREATED', outcome: 'skipped', reason: 'referenced' })
    expect(plan.rows[1].write).toBeUndefined()
    // detail names the rule, mirroring the offer's guardCascades message
    expect(plan.rows[1].detail).toContain('CILANTRO BUNCH')
  })

  it('still deletes a created item whose match rule is deleted with it', () => {
    const ruleNext = ruleCanon({ inventoryItemId: 'new-item' })
    const plan = planRollback(
      input({
        records: [
          { kind: 'MATCH_RULE', targetId: 'r1', prev: null, next: ruleNext },
          rec,
        ],
        current: {
          offers: new Map(),
          items: new Map([['new-item', item(itemCanon(), 'New Product')]]),
          rules: new Map([['r1', ruleNext]]),
        },
        refs: new Map([['new-item', noRefs]]),
      })
    )
    expect(plan.rows.map(r => r.outcome)).toEqual(['deleted', 'deleted'])
  })
})

describe('planRollback — apply order', () => {
  it('surrenders the primary flag before claiming it: prev.isPrimary false comes first for the same item', () => {
    const demoted = offerCanon({ isPrimary: false }) // approve demoted this one: prev was primary
    const promoted = offerCanon({ isPrimary: true }) // approve promoted this one: prev was not
    const records: UndoRecord[] = [
      { kind: 'OFFER', targetId: 'was-primary', prev: offerCanon({ isPrimary: true }), next: demoted },
      { kind: 'OFFER', targetId: 'now-primary', prev: offerCanon({ isPrimary: false }), next: promoted },
    ]
    const plan = planRollback(
      input({
        records,
        current: {
          offers: new Map([
            ['was-primary', offer(demoted, 'i1', 'Sysco')],
            ['now-primary', offer(promoted, 'i1', 'GFS')],
          ]),
          items: new Map(),
          rules: new Map(),
        },
      })
    )
    // 'now-primary' restores isPrimary=false and must run FIRST, so that
    // 'was-primary' can take the flag back without tripping the partial index.
    expect(plan.rows.map(r => r.targetId)).toEqual(['now-primary', 'was-primary'])
    expect(plan.rows.every(r => r.outcome === 'restored')).toBe(true)
  })

  // `current.offers` carries EVERY offer of every item an OFFER record touches,
  // so the planner can see a third offer that took the primary flag while nobody
  // was looking. Restoring the flag onto A then trips the partial unique index
  // `(inventoryItemId) WHERE isPrimary` — the whole transaction dies, and with it
  // a rollback that had nothing to do with C.
  it('refuses to claim the primary flag back while a third offer holds it', () => {
    const aNext = offerCanon({ isPrimary: false })
    const records: UndoRecord[] = [
      { kind: 'OFFER', targetId: 'A', prev: offerCanon({ isPrimary: true }), next: aNext },
      { kind: 'OFFER', targetId: 'B', prev: offerCanon({ isPrimary: false }), next: offerCanon({ isPrimary: true }) },
    ]
    const plan = planRollback(
      input({
        records,
        current: {
          offers: new Map([
            ['A', offer(aNext, 'i1', 'Sysco')],
            // someone made C primary after the approval, which demoted B
            ['B', offer(offerCanon({ isPrimary: false }), 'i1', 'GFS')],
            ['C', offer(offerCanon({ isPrimary: true }), 'i1', 'Costco')],
          ]),
          items: new Map(),
          rules: new Map(),
        },
      })
    )
    const byId = Object.fromEntries(plan.rows.map(r => [r.targetId, r]))
    // B lost the flag, so it no longer equals what the approval wrote
    expect(byId.B).toMatchObject({ outcome: 'skipped', reason: 'changed-since' })
    // A still equals `next`, but C — not cleared, not deleted — holds primary
    expect(byId.A).toMatchObject({
      outcome: 'skipped',
      reason: 'changed-since',
      detail: 'another supplier is primary now',
    })
    expect(byId.A.write).toBeUndefined()
    expect(plan.summary.skipped).toBe(2)
  })

  it('still restores the plain two-offer swap — the other primary is being cleared in the same plan', () => {
    const demoted = offerCanon({ isPrimary: false })
    const promoted = offerCanon({ isPrimary: true })
    const plan = planRollback(
      input({
        records: [
          { kind: 'OFFER', targetId: 'A', prev: offerCanon({ isPrimary: true }), next: demoted },
          { kind: 'OFFER', targetId: 'B', prev: offerCanon({ isPrimary: false }), next: promoted },
        ],
        current: {
          offers: new Map([
            ['A', offer(demoted, 'i1', 'Sysco')],
            ['B', offer(promoted, 'i1', 'GFS')],
          ]),
          items: new Map(),
          rules: new Map(),
        },
      })
    )
    expect(plan.rows.map(r => [r.targetId, r.outcome])).toEqual([
      ['B', 'restored'],
      ['A', 'restored'],
    ])
  })

  it('claims the flag back when the offer holding it is being deleted in the same plan', () => {
    const aNext = offerCanon({ isPrimary: false })
    const cNext = offerCanon({ isPrimary: true })
    const plan = planRollback(
      input({
        records: [
          { kind: 'OFFER', targetId: 'A', prev: offerCanon({ isPrimary: true }), next: aNext },
          { kind: 'OFFER', targetId: 'C', prev: null, next: cNext }, // created by the approval
        ],
        current: {
          offers: new Map([
            ['A', offer(aNext, 'i1', 'Sysco')],
            ['C', offer(cNext, 'i1', 'Costco')],
          ]),
          items: new Map(),
          rules: new Map(),
        },
      })
    )
    expect(plan.rows.map(r => [r.targetId, r.outcome])).toEqual([
      ['C', 'deleted'],
      ['A', 'restored'],
    ])
  })

  it('leaves a primary restore alone when the other primary is on a DIFFERENT item', () => {
    const aNext = offerCanon({ isPrimary: false })
    const plan = planRollback(
      input({
        records: [{ kind: 'OFFER', targetId: 'A', prev: offerCanon({ isPrimary: true }), next: aNext }],
        current: {
          offers: new Map([
            ['A', offer(aNext, 'i1', 'Sysco')],
            ['Z', offer(offerCanon({ isPrimary: true }), 'i2', 'Costco')],
          ]),
          items: new Map(),
          rules: new Map(),
        },
      })
    )
    expect(plan.rows[0].outcome).toBe('restored')
  })

  it('applies kinds in order OFFER, ITEM, MATCH_RULE, ITEM_CREATED whatever order the records arrive in', () => {
    const records: UndoRecord[] = [
      { kind: 'ITEM_CREATED', targetId: 'new-item', prev: null, next: itemCanon() },
      { kind: 'MATCH_RULE', targetId: 'r1', prev: null, next: ruleCanon() },
      { kind: 'ITEM', targetId: 'i1', prev: itemCanon({ purchasePrice: 1 }), next: itemCanon() },
      { kind: 'OFFER', targetId: 'o1', prev: null, next: offerCanon() },
    ]
    const plan = planRollback(
      input({
        records,
        current: {
          offers: new Map([['o1', offer(offerCanon())]]),
          items: new Map([
            ['i1', item(itemCanon())],
            ['new-item', item(itemCanon(), 'New Product')],
          ]),
          rules: new Map([['r1', ruleCanon()]]),
        },
        refs: new Map([['new-item', noRefs]]),
      })
    )
    expect(plan.rows.map(r => r.kind)).toEqual(['OFFER', 'ITEM', 'MATCH_RULE', 'ITEM_CREATED'])
    expect(plan.restoredItemIds).toEqual(['i1'])
    expect(plan.summary).toEqual({ restored: 1, deleted: 3, skipped: 0, bestEffort: 0 })
  })
})

describe('planRollback — the Cilantro shape', () => {
  it('restores the PACK object exactly, not the RATE shape the approve left behind', () => {
    const packChain = [{ unit: 'each', per: 1 }]
    const prev: Canon = {
      pricing: { mode: 'PACK', purchasePrice: 4.99 },
      purchasePrice: 4.99,
      packChain,
      densityGPerMl: null,
    }
    const next: Canon = {
      pricing: { mode: 'RATE', rate: 15.98, rateUnit: 'lb' },
      purchasePrice: 15.98,
      packChain,
      densityGPerMl: null,
    }
    const plan = planRollback(
      input({
        records: [{ kind: 'ITEM', targetId: 'cilantro', prev, next }],
        current: { offers: new Map(), items: new Map([['cilantro', item(next, 'Cilantro')]]), rules: new Map() },
      })
    )
    expect(plan.rows[0].outcome).toBe('restored')
    expect(plan.rows[0].write?.data?.pricing).toEqual({ mode: 'PACK', purchasePrice: 4.99 })
    expect(plan.rows[0].write?.data?.purchasePrice).toBe(4.99)
    expect(plan.restoredItemIds).toEqual(['cilantro'])
  })
})

describe('planRollback — the legacy path', () => {
  const matchedItem = {
    dimension: 'MASS',
    baseUnit: 'g',
    packChain: [{ unit: 'case', per: 1000 }],
    pricing: { mode: 'PACK', purchasePrice: 20 },
    eachMeasureQty: null,
    eachMeasureUnit: null,
    densityGPerMl: null,
  }

  it('best-efforts UPDATE_PRICE lines with a positive previousPrice, and nothing else', () => {
    const plan = planRollback(
      input({
        legacy: {
          status: 'APPROVED',
          priceAlerts: [],
          lines: [
            { approved: true, action: 'UPDATE_PRICE', matchedItemId: 'i1', previousPrice: 15, matchedItem, itemName: 'Flour' },
            { approved: true, action: 'ADD_SUPPLIER', matchedItemId: 'i2', previousPrice: 8, matchedItem },
            { approved: true, action: 'UPDATE_PRICE', matchedItemId: 'i3', previousPrice: null, matchedItem },
            { approved: true, action: 'CREATE_ITEM', matchedItemId: 'i4', previousPrice: 5, matchedItem },
            { approved: true, action: 'UPDATE_PRICE', matchedItemId: null, previousPrice: 5, matchedItem },
          ],
        },
      })
    )
    expect(plan.legacy).toBe(true)
    expect(plan.rows.map(r => r.targetId)).toEqual(['i1'])
    expect(plan.rows[0]).toMatchObject({
      kind: 'ITEM',
      name: 'Flour',
      outcome: 'best-effort',
      reason: 'approved before undo records existed',
    })
    expect(plan.rows[0].write).toEqual({
      table: 'item',
      op: 'update',
      data: { purchasePrice: 15, pricing: { mode: 'PACK', purchasePrice: 15 } },
    })
    expect(plan.restoredItemIds).toEqual(['i1'])
    expect(plan.summary).toEqual({ restored: 0, deleted: 0, skipped: 0, bestEffort: 1 })
  })

  // C1: the legacy path must never write a price the approval never wrote.
  // ADD_SUPPLIER lines are assigned by invoice-matcher.ts exactly when the
  // line did NOT move the item's price (a non-primary supplier's line never
  // re-priced the spine), and their `previousPrice` is THAT supplier's own
  // last price — reverting one overwrites the item with the wrong number.
  it('never reverts an ADD_SUPPLIER line, even with a clean positive previousPrice', () => {
    const plan = planRollback(
      input({
        legacy: {
          status: 'APPROVED',
          priceAlerts: [],
          lines: [
            { approved: true, action: 'ADD_SUPPLIER', matchedItemId: 'i1', previousPrice: 15, matchedItem, itemName: 'Flour' },
          ],
        },
      })
    )
    expect(plan.legacy).toBe(true)
    expect(plan.rows).toEqual([])
    expect(plan.restoredItemIds).toEqual([])
  })

  // `Number(null)` is 0, and `Number('')` is 0 too — the empties are already
  // filtered above, but a genuine `previousPrice: 0` must be rejected the same
  // way: it is never a real pre-session price and would zero the item.
  it('ignores a line whose previousPrice is exactly 0', () => {
    const plan = planRollback(
      input({
        legacy: {
          status: 'APPROVED',
          priceAlerts: [],
          lines: [
            { approved: true, action: 'UPDATE_PRICE', matchedItemId: 'i1', previousPrice: 0, matchedItem, itemName: 'Flour' },
            { approved: true, action: 'UPDATE_PRICE', matchedItemId: 'i2', previousPrice: -5, matchedItem },
            { approved: true, action: 'UPDATE_PRICE', matchedItemId: 'i3', previousPrice: 15, matchedItem },
          ],
        },
      })
    )
    expect(plan.rows.map(r => r.targetId)).toEqual(['i3'])
  })

  it('emits one row per line — a second line for the same item overwrites, as today', () => {
    const plan = planRollback(
      input({
        legacy: {
          status: 'APPROVED',
          priceAlerts: [],
          lines: [
            { approved: true, action: 'UPDATE_PRICE', matchedItemId: 'i1', previousPrice: 15, matchedItem },
            { approved: true, action: 'UPDATE_PRICE', matchedItemId: 'i1', previousPrice: 17, matchedItem },
          ],
        },
      })
    )
    expect(plan.rows).toHaveLength(2)
    expect(plan.rows.map(r => r.write?.data?.purchasePrice)).toEqual([15, 17])
    expect(plan.restoredItemIds).toEqual(['i1']) // deduplicated for the re-cost
  })

  // Today's DELETE selects `where: { action: 'UPDATE_PRICE', approved: true }`.
  // An unapproved line never moved a price, so reverting to its `previousPrice`
  // would invent one.
  it('ignores a line that was never approved', () => {
    const plan = planRollback(
      input({
        legacy: {
          status: 'APPROVED',
          priceAlerts: [],
          lines: [
            { approved: false, action: 'UPDATE_PRICE', matchedItemId: 'i1', previousPrice: 15, matchedItem },
            { approved: true, action: 'UPDATE_PRICE', matchedItemId: 'i2', previousPrice: 15, matchedItem },
          ],
        },
      })
    )
    expect(plan.rows.map(r => r.targetId)).toEqual(['i2'])
  })

  it('Number()s a Prisma Decimal previousPrice and skips one that is not a finite number', () => {
    const decimalish = { toString: () => '15.5', toNumber: () => 15.5, valueOf: () => '15.5' }
    const plan = planRollback(
      input({
        legacy: {
          status: 'APPROVED',
          priceAlerts: [],
          lines: [
            { approved: true, action: 'UPDATE_PRICE', matchedItemId: 'i1', previousPrice: decimalish, matchedItem },
            { approved: true, action: 'UPDATE_PRICE', matchedItemId: 'i2', previousPrice: '12.25', matchedItem },
            { approved: true, action: 'UPDATE_PRICE', matchedItemId: 'i3', previousPrice: 'not a price', matchedItem },
            { approved: true, action: 'UPDATE_PRICE', matchedItemId: 'i4', previousPrice: undefined, matchedItem },
          ],
        },
      })
    )
    expect(plan.rows.map(r => r.targetId)).toEqual(['i1', 'i2'])
    expect(plan.rows.map(r => r.write?.data?.purchasePrice)).toEqual([15.5, 12.25])
  })

  it('does not take the legacy path for a session that was never approved', () => {
    const plan = planRollback(
      input({
        legacy: {
          status: 'REVIEW',
          priceAlerts: [],
          lines: [{ approved: true, action: 'UPDATE_PRICE', matchedItemId: 'i1', previousPrice: 15, matchedItem }],
        },
      })
    )
    expect(plan.legacy).toBe(false)
    expect(plan.rows).toEqual([])
  })

  it('ignores the legacy lines entirely once undo records exist', () => {
    const next = itemCanon()
    const plan = planRollback(
      input({
        records: [{ kind: 'ITEM', targetId: 'i1', prev: itemCanon({ purchasePrice: 1 }), next }],
        current: { offers: new Map(), items: new Map([['i1', item(next)]]), rules: new Map() },
        legacy: {
          status: 'APPROVED',
          priceAlerts: [],
          lines: [{ approved: true, action: 'UPDATE_PRICE', matchedItemId: 'i9', previousPrice: 15, matchedItem }],
        },
      })
    )
    expect(plan.legacy).toBe(false)
    expect(plan.rows.map(r => r.targetId)).toEqual(['i1'])
  })
})

describe('executeRollback', () => {
  type Call = { table: string; op: string; id: string; data?: Record<string, unknown> }
  const fakeTx = () => {
    const calls: Call[] = []
    const model = (table: string) => ({
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        calls.push({ table, op: 'update', id: where.id, data })
        return {}
      },
      delete: async ({ where }: { where: { id: string } }) => {
        calls.push({ table, op: 'delete', id: where.id })
        return {}
      },
    })
    return {
      calls,
      tx: {
        inventorySupplierPrice: model('offer'),
        inventoryItem: model('item'),
        invoiceMatchRule: model('rule'),
      } as unknown as Parameters<typeof executeRollback>[0],
    }
  }

  it('applies every write in plan order and skips rows with none', async () => {
    const { calls, tx } = fakeTx()
    await executeRollback(tx, {
      legacy: false,
      restoredItemIds: [],
      summary: { restored: 0, deleted: 0, skipped: 0, bestEffort: 0 },
      rows: [
        { kind: 'OFFER', targetId: 'o1', name: 'Sysco', outcome: 'restored', write: { table: 'offer', op: 'update', data: offerCanon({ isPrimary: false }) } },
        { kind: 'OFFER', targetId: 'o2', name: 'GFS', outcome: 'skipped', reason: 'changed-since' },
        { kind: 'ITEM', targetId: 'i1', name: 'Cilantro', outcome: 'restored', write: { table: 'item', op: 'update', data: itemCanon() } },
        { kind: 'MATCH_RULE', targetId: 'r1', name: 'X', outcome: 'deleted', write: { table: 'rule', op: 'delete' } },
        { kind: 'ITEM_CREATED', targetId: 'n1', name: 'New', outcome: 'deleted', write: { table: 'item', op: 'delete' } },
      ],
    })
    expect(calls.map(c => `${c.table}:${c.op}:${c.id}`)).toEqual([
      'offer:update:o1',
      'item:update:i1',
      'rule:delete:r1',
      'item:delete:n1',
    ])
    // isPrimary rides along in the same update — ordering already guarantees
    // the partial unique index holds.
    expect(calls[0].data?.isPrimary).toBe(false)
  })

  it('sends Prisma.JsonNull for a restored null Json column, and plain values for the rest', async () => {
    const { calls, tx } = fakeTx()
    await executeRollback(tx, {
      legacy: false,
      restoredItemIds: [],
      summary: { restored: 1, deleted: 0, skipped: 0, bestEffort: 0 },
      rows: [
        {
          kind: 'OFFER',
          targetId: 'o1',
          name: 'Sysco',
          outcome: 'restored',
          write: { table: 'offer', op: 'update', data: offerCanon({ packChain: null, pricing: null, lastPrice: 46.4, packUOM: null }) },
        },
      ],
    })
    // DbNull, not JsonNull: the column means "this offer had no chain", i.e. SQL
    // NULL. JsonNull would store the JSON scalar `null` — a different value that
    // `{ packChain: null }` no longer finds.
    expect(calls[0].data?.packChain).toBe(Prisma.DbNull)
    expect(calls[0].data?.pricing).toBe(Prisma.DbNull)
    expect(calls[0].data?.lastPrice).toBe(46.4)
    expect(calls[0].data?.packUOM).toBeNull() // not a Json column — stays a plain null
  })
})

// The route cannot run the whole plan in one pass: deleting a created item is
// blocked by this session's own scan lines (InvoiceScanItem → SetNull, but the
// approved InvoiceLineItem rows are Restrict), so the item deletes have to wait
// until the session and its clones are gone. Restores must NOT wait — they run
// while the session row is still there.
describe('executeRestores / executeCreatedItemDeletes', () => {
  type Call = { table: string; op: string; id: string; data?: Record<string, unknown> }
  const fakeTx = () => {
    const calls: Call[] = []
    const model = (table: string) => ({
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        calls.push({ table, op: 'update', id: where.id, data })
        return {}
      },
      delete: async ({ where }: { where: { id: string } }) => {
        calls.push({ table, op: 'delete', id: where.id })
        return {}
      },
    })
    return {
      calls,
      tx: {
        inventorySupplierPrice: model('offer'),
        inventoryItem: model('item'),
        invoiceMatchRule: model('rule'),
      } as unknown as Parameters<typeof executeRollback>[0],
    }
  }

  const plan = () => ({
    legacy: false,
    restoredItemIds: [],
    summary: { restored: 1, deleted: 3, skipped: 0, bestEffort: 0 },
    rows: [
      { kind: 'OFFER' as const, targetId: 'o1', name: 'Sysco', outcome: 'deleted' as const, write: { table: 'offer' as const, op: 'delete' as const } },
      { kind: 'ITEM' as const, targetId: 'i1', name: 'Cilantro', outcome: 'restored' as const, write: { table: 'item' as const, op: 'update' as const, data: itemCanon() } },
      { kind: 'MATCH_RULE' as const, targetId: 'r1', name: 'X', outcome: 'deleted' as const, write: { table: 'rule' as const, op: 'delete' as const } },
      { kind: 'ITEM_CREATED' as const, targetId: 'n1', name: 'New', outcome: 'deleted' as const, write: { table: 'item' as const, op: 'delete' as const } },
      { kind: 'ITEM_CREATED' as const, targetId: 'n2', name: 'Newer', outcome: 'deleted' as const, write: { table: 'item' as const, op: 'delete' as const } },
    ],
  })

  it('executeRestores runs everything except the created-item deletes', async () => {
    const { calls, tx } = fakeTx()
    await executeRestores(tx, plan())
    expect(calls.map(c => `${c.table}:${c.op}:${c.id}`)).toEqual(['offer:delete:o1', 'item:update:i1', 'rule:delete:r1'])
  })

  it('executeCreatedItemDeletes runs only the created-item deletes, in plan order', async () => {
    const { calls, tx } = fakeTx()
    await executeCreatedItemDeletes(tx, plan())
    expect(calls.map(c => `${c.table}:${c.op}:${c.id}`)).toEqual(['item:delete:n1', 'item:delete:n2'])
  })

  it('a created item the plan skipped is never deleted by either half', async () => {
    const p = plan()
    p.rows[3] = { kind: 'ITEM_CREATED', targetId: 'n1', name: 'New', outcome: 'skipped', reason: 'referenced' } as never
    const { calls, tx } = fakeTx()
    await executeRestores(tx, p)
    await executeCreatedItemDeletes(tx, p)
    expect(calls.map(c => c.id)).not.toContain('n1')
  })

  it('executeRollback is the two halves in order — the same sequence as one pass', async () => {
    const { calls, tx } = fakeTx()
    await executeRollback(tx, plan())
    expect(calls.map(c => `${c.table}:${c.op}:${c.id}`)).toEqual([
      'offer:delete:o1',
      'item:update:i1',
      'rule:delete:r1',
      'item:delete:n1',
      'item:delete:n2',
    ])
  })
})
