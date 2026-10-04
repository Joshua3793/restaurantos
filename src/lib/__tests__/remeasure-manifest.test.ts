import { describe, it, expect, vi } from 'vitest'
import { Prisma } from '@prisma/client'

// The exec module is server-only and talks to the database; only its PURE
// builders are under test here, so the heavy neighbours are stubbed.
vi.mock('@/lib/prisma', () => ({ prisma: {} }))
vi.mock('@/lib/recipeCosts', () => ({ propagatePrepCostChanges: async () => [] }))
vi.mock('@/lib/theoretical-cache', () => ({ invalidateTheoreticalCache: () => {} }))

const { buildManifest, undoBlocker, undoWrites, writtenRows } = await import('@/lib/remeasure-exec')
const { planRemeasure } = await import('@/lib/remeasure-plan')
type Loaded = Parameters<typeof buildManifest>[1]

/** A COUNT item (case of 12 at $40) re-measured by weight, one piece = 150 g.
 *  One box, one receipt, one count with its snapshot, one SKIPPED count with
 *  its THEORETICAL snapshot, one transfer, one RC allocation, and a session
 *  whose stored total is stale. Every field the loader fills is filled. */
function fixture(): Loaded {
  return {
    item: {
      id: 'item-1', itemName: 'Burrata', isStocked: true,
      dimension: 'COUNT', baseUnit: 'each', countUnit: 'case',
      packChain: [{ unit: 'case', per: 12 }],
      pricing: { mode: 'PACK', purchasePrice: 40 },
      eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null,
      stockOnHand: 36, lastCountQty: 36,
    },
    to: { dimension: 'MASS', unit: 'g' },
    bridge: { eachQty: 150, eachUnit: 'g' },
    boxes: [
      { id: 'box-sysco', supplierId: 'sup-sysco', supplierItemCode: 'BUR12', supplierName: 'Sysco', isPrimary: true, packChain: [{ unit: 'case', per: 12 }], pricing: { mode: 'PACK', purchasePrice: 40 }, packQty: 12, packSize: 1, packUOM: 'each' },
    ],
    receipts: [
      { id: 'r-case', rawQty: 2, rawUnit: 'cs', invoicePackQty: 12, invoicePackSize: 1, invoicePackUOM: 'each', rawUnitPrice: 40, rawLineTotal: 80, receivedQtyBase: 24,
        supplierId: 'sup-sysco', supplierName: 'SYSCO VANCOUVER', canonicalName: 'Sysco', supplierItemCode: 'BUR12' },
    ],
    counts: [
      {
        id: 'c-case', countedQty: 3, selectedUom: 'case', countedQtyBase: 36, priceAtCount: 40 / 12,
        snapshot: { id: 'snap-1', qtyOnHand: 36, unit: 'each', pricePerBaseUnit: 40 / 12, totalValue: 120 },
      },
      {
        id: 'c-skip', countedQty: null, selectedUom: 'case', countedQtyBase: null, skipped: true, priceAtCount: 40 / 12,
        snapshot: { id: 'snap-th', qtyOnHand: 10, unit: 'each', pricePerBaseUnit: 40 / 12, totalValue: 400 / 12 },
      },
    ],
    countSessions: [
      { lineId: 'c-case', sessionDate: '2026-09-01T00:00:00Z', revenueCenterId: 'rc-bar', rcIsDefault: false, skipped: false, countedQty: 3 },
      { lineId: 'c-skip', sessionDate: '2026-09-08T00:00:00Z', revenueCenterId: null, rcIsDefault: false, skipped: true, countedQty: null },
    ],
    allocations: [{ revenueCenterId: 'rc-bar', quantity: 36 }],
    sessions: [
      { id: 'sess-1', totalCountedValue: 160, snapshots: [
        { id: 'snap-1', source: 'COUNTED', totalValue: 120 },
        { id: 'snap-other', source: 'COUNTED', totalValue: 50 },
      ] },
    ],
    transfers: [{ id: 't-1', quantity: 12 }],
    recipeLines: 1,
    wastageRows: 0,
  }
}

const AFTER = new Date('2026-10-04T12:00:00.000Z')

function manifestOf(input = fixture()) {
  const plan = planRemeasure(input)
  if ('error' in plan) throw new Error(plan.error)
  return buildManifest(plan, input, AFTER)
}

describe('buildManifest', () => {
  const m = manifestOf()

  it('records the factor, both measures and the instant apply stamped', () => {
    expect(m.itemId).toBe('item-1')
    expect(m.k).toBe(150)
    expect(m.from).toEqual({ dimension: 'COUNT', unit: 'each' })
    expect(m.to).toEqual({ dimension: 'MASS', unit: 'g' })
    expect(m.afterLastUpdated).toBe('2026-10-04T12:00:00.000Z')
  })

  it('captures the item before-values, bridges and stock baselines included', () => {
    expect(m.item.before).toEqual({
      dimension: 'COUNT', baseUnit: 'each',
      packChain: [{ unit: 'case', per: 12 }], pricing: { mode: 'PACK', purchasePrice: 40 },
      countUnit: 'case', eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null,
      stockOnHand: 36, lastCountQty: 36,
    })
  })

  it('captures every box before-value, pack format included', () => {
    expect(m.boxes).toEqual([{
      id: 'box-sysco',
      before: { packChain: [{ unit: 'case', per: 12 }], pricing: { mode: 'PACK', purchasePrice: 40 }, packQty: 12, packSize: 1, packUOM: 'each' },
    }])
  })

  it('captures the frozen receipt, count, snapshot, allocation, session total and transfer', () => {
    expect(m.receipts).toEqual([{ id: 'r-case', old: 24 }])
    expect(m.counts).toEqual([
      { id: 'c-case', old: 36, priceAtCount: 40 / 12 },
      { id: 'c-skip', old: null, priceAtCount: 40 / 12 },     // its price is restated too
    ])
    expect(m.snapshots).toEqual([
      { id: 'snap-1', before: { qtyOnHand: 36, unit: 'each', pricePerBaseUnit: 40 / 12, totalValue: 120 } },
      // The theoretical snapshot: quantity, unit and $/base all restated — all captured.
      { id: 'snap-th', before: { qtyOnHand: 10, unit: 'each', pricePerBaseUnit: 40 / 12, totalValue: 400 / 12 } },
    ])
    expect(m.allocations).toEqual([{ revenueCenterId: 'rc-bar', old: 36 }])
    expect(m.sessions).toEqual([{ id: 'sess-1', old: 160 }])
    expect(m.transfers).toEqual([{ id: 't-1', old: 12 }])
  })

  it('leaves out rows the change does not move', () => {
    const input = fixture()
    input.sessions[0].totalCountedValue = 170          // already right — re-sums to 170
    input.transfers = [{ id: 't-0', quantity: 0 }]     // 0 × k = 0
    const mm = manifestOf(input)
    expect(mm.sessions).toEqual([])
    expect(mm.transfers).toEqual([])
  })

  it('is plain JSON — survives the Json column', () => {
    expect(JSON.parse(JSON.stringify(m))).toEqual(m)
  })

  it('reads Decimal-ish strings as numbers', () => {
    const input = fixture()
    input.item.stockOnHand = '36'
    input.item.lastCountQty = null
    input.item.eachMeasureQty = '100'
    input.item.eachMeasureUnit = 'g'
    const mm = manifestOf(input)
    expect(mm.item.before.stockOnHand).toBe(36)
    expect(mm.item.before.lastCountQty).toBeNull()
    expect(mm.item.before.eachMeasureQty).toBe(100)
  })
})

describe('writtenRows — what apply writes', () => {
  const input = fixture()
  const plan = planRemeasure(input)
  if ('error' in plan) throw new Error(plan.error)
  const w = writtenRows(plan, input)

  it('a stock baseline no count sets is scaled and WRITTEN, never skipped', () => {
    // No unscoped count: stockOnHand 36 each → 36 × 150 g.
    expect(w.stockOnHand).toBeCloseTo(5400, 9)
    expect(w.lastCountQty).toBeCloseTo(5400, 9)
    expect(w.allocations).toEqual([{ revenueCenterId: 'rc-bar', old: 36, next: 5400 }])
  })

  it('the theoretical snapshot is written with its new quantity, unit and $/base', () => {
    expect(w.unitOnly).toHaveLength(1)
    const s = w.unitOnly[0].snapshotUnitOnly!
    expect(s).toMatchObject({ id: 'snap-th', unit: 'g' })
    expect(s.qtyOnHand).toBeCloseTo(1500, 9)
    expect(s.pricePerBaseUnit * s.qtyOnHand).toBeCloseTo(400 / 12, 9)   // value unchanged
  })

  it('the count snapshot keeps its count-time value, its $/base ÷ k', () => {
    const s = w.snapshots[0].snapshot!
    expect(s.qtyOnHand).toBeCloseTo(5400, 9)
    expect(s.totalValue).toBeCloseTo(120, 9)
    expect(s.pricePerBaseUnit).toBeCloseTo(40 / 12 / 150, 12)
  })

  it('the receipt re-derives through its own supplier box', () => {
    expect(w.receipts).toHaveLength(1)
    expect(w.receipts[0].next).toBeCloseTo(3600, 9)
    expect(w.receipts[0].scaled).toBe(false)
  })
})

describe('undoBlocker', () => {
  const m = manifestOf()
  const ok = { itemLastUpdated: AFTER, countLinesSince: 0, remeasuresSince: 0 }

  it('null when nothing has happened since', () => {
    expect(undoBlocker(m, ok)).toBeNull()
  })
  it('the item changed since', () => {
    expect(undoBlocker(m, { ...ok, itemLastUpdated: new Date('2026-10-04T12:00:01.000Z') }))
      .toBe('The item has changed since — undo is no longer safe.')
  })
  it('a count was recorded since', () => {
    expect(undoBlocker(m, { ...ok, countLinesSince: 1 })).toBe('A count was recorded since — undo is no longer safe.')
  })
  it('the measure was changed again since', () => {
    expect(undoBlocker(m, { ...ok, remeasuresSince: 1 })).toBe('Its measure was changed again since — undo that one first.')
  })
  it('writes the item row cannot see: a box edited, a delivery approved, stock moved', () => {
    expect(undoBlocker(m, { ...ok, boxesChanged: 1 })).toBe('The item has changed since — undo is no longer safe.')
    expect(undoBlocker(m, { ...ok, receiptsSince: 1 })).toBe('A delivery was received since — undo is no longer safe.')
    expect(undoBlocker(m, { ...ok, transfersSince: 2 })).toBe('Stock was moved since — undo is no longer safe.')
    expect(undoBlocker(m, { ...ok, boxesChanged: 0, receiptsSince: 0, transfersSince: 0 })).toBeNull()
  })
})

describe('undoWrites', () => {
  const m = manifestOf()
  const NOW = new Date('2026-10-05T09:00:00.000Z')
  const w = undoWrites(m, NOW)

  it('restores the item, bridges and stock included, and bumps lastUpdated', () => {
    expect(w.item).toEqual({
      id: 'item-1',
      data: {
        dimension: 'COUNT', baseUnit: 'each',
        packChain: [{ unit: 'case', per: 12 }], pricing: { mode: 'PACK', purchasePrice: 40 },
        countUnit: 'case', eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null,
        stockOnHand: 36, lastCountQty: 36, lastUpdated: NOW,
      },
    })
  })

  it('restores boxes with their pack format', () => {
    expect(w.boxes).toEqual([{
      id: 'box-sysco',
      data: { packChain: [{ unit: 'case', per: 12 }], pricing: { mode: 'PACK', purchasePrice: 40 }, packQty: 12, packSize: 1, packUOM: 'each' },
    }])
  })

  it('a box that had no chain gets Json null back, not a JS null', () => {
    const mm = { ...m, boxes: [{ id: 'b', before: { packChain: null, pricing: null, packQty: null, packSize: null, packUOM: null } }] }
    expect(undoWrites(mm, NOW).boxes[0].data).toEqual({
      packChain: Prisma.DbNull, pricing: Prisma.DbNull, packQty: null, packSize: null, packUOM: null,
    })
  })

  it('restores every frozen row', () => {
    expect(w.receipts).toEqual([{ id: 'r-case', data: { receivedQtyBase: 24 } }])
    expect(w.counts).toEqual([
      { id: 'c-case', data: { countedQtyBase: 36, priceAtCount: 40 / 12 } },
      { id: 'c-skip', data: { countedQtyBase: null, priceAtCount: 40 / 12 } },
    ])
    expect(w.snapshots).toEqual([
      { id: 'snap-1', data: { qtyOnHand: 36, unit: 'each', pricePerBaseUnit: 40 / 12, totalValue: 120 } },
      { id: 'snap-th', data: { qtyOnHand: 10, unit: 'each', pricePerBaseUnit: 40 / 12, totalValue: 400 / 12 } },
    ])
    expect(w.allocations).toEqual([{ revenueCenterId: 'rc-bar', data: { quantity: 36 } }])
    expect(w.sessions).toEqual([{ id: 'sess-1', data: { totalCountedValue: 160 } }])
    expect(w.transfers).toEqual([{ id: 't-1', data: { quantity: 12 } }])
  })

  it('a count line with no frozen price keeps the one it has', () => {
    const mm = { ...m, counts: [{ id: 'c', old: null, priceAtCount: null }] }
    expect(undoWrites(mm, NOW).counts).toEqual([{ id: 'c', data: { countedQtyBase: null } }])
  })
})
