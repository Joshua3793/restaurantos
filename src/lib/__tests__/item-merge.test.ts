import { describe, it, expect } from 'vitest'
import { baseFactor, planMerge, planUndo, type MergeItemRow, type MergeRelations, type SurvivorRelations, type MergeOp } from '@/lib/item-merge'

const row = (over: Partial<MergeItemRow>): MergeItemRow => ({
  id: 'x', itemName: 'x', baseUnit: 'g', dimension: 'MASS', countUnit: 'kg',
  packChain: [{ unit: 'case', per: 1000 }], pricing: { mode: 'PACK', purchasePrice: 10 }, stockOnHand: 0,
  eachMeasure: null, densityGPerMl: null, isActive: true, mergedIntoId: null,
  ownedByRecipe: false, inOpenCount: false, theoreticalOnHand: 0, ...over,
})
const noRel: MergeRelations = {
  scanItems: [], invoiceLineItemIds: [], priceAlertIds: [], matchRuleIds: [], transfers: [],
  wastage: [], recipeIngredients: [], countLines: [], snapshots: [], offers: [], allocations: [], itemRcs: [],
  latestPurchaseSupplier: null,
}
const noSRel: SurvivorRelations = { offers: [], allocations: [], itemRcs: [], snapshots: [] }
const S = row({ id: 'S', itemName: 'kennebec potato' })
const A = row({ id: 'A', itemName: 'Potatoes, Kennebec O/S' })
const plan = (s = S, a = A, rel = noRel, sRel = noSRel, provided = false) => planMerge(s, a, rel, sRel, { combinedOnHandProvided: provided })

describe('baseFactor', () => {
  it('same dimension → 1', () => expect(baseFactor(A, S)).toBe(1))
  it('each → g through the survivor each-measure', () => {
    expect(baseFactor(row({ baseUnit: 'each', dimension: 'COUNT' }), row({ eachMeasure: { qty: 0.3, unit: 'kg' } }))).toBe(300)
  })
  it('g → each through the survivor each-measure', () => {
    expect(baseFactor(row({}), row({ baseUnit: 'each', dimension: 'COUNT', eachMeasure: { qty: 250, unit: 'g' } }))).toBeCloseTo(1 / 250)
  })
  it('ml → g through density', () => {
    expect(baseFactor(row({ baseUnit: 'ml', dimension: 'VOLUME' }), row({ densityGPerMl: 0.92 }))).toBeCloseTo(0.92)
  })
  it('no bridge → null', () => expect(baseFactor(row({ baseUnit: 'each', dimension: 'COUNT' }), S)).toBeNull())
})

describe('guards', () => {
  const guard = (p: ReturnType<typeof plan>) => (p.ok ? null : p.guard)
  it('same item', () => expect(guard(plan(S, S))).toBe('SAME_ITEM'))
  it('PREP-owned, either side', () => {
    expect(guard(plan(row({ id: 'S', ownedByRecipe: true }), A))).toBe('PREP_OWNED')
    expect(guard(plan(S, row({ id: 'A', ownedByRecipe: true })))).toBe('PREP_OWNED')
  })
  it('tombstone', () => expect(guard(plan(S, row({ id: 'A', mergedIntoId: 'Z', isActive: false })))).toBe('TOMBSTONE'))
  it('open count', () => expect(guard(plan(S, row({ id: 'A', inOpenCount: true })))).toBe('OPEN_COUNT'))
  it('no bridge', () => expect(guard(plan(S, row({ id: 'A', baseUnit: 'each', dimension: 'COUNT' })))).toBe('NO_BRIDGE'))
  it('absorbed on-hand > 0 needs a combined on-hand', () => {
    expect(guard(plan(S, row({ id: 'A', theoreticalOnHand: 12 })))).toBe('NEEDS_ON_HAND')
    expect(plan(S, row({ id: 'A', theoreticalOnHand: 12 }), noRel, noSRel, true).ok).toBe(true)
  })
})

describe('planMerge ops', () => {
  it('re-points plain tables and tombstones the absorbed row', () => {
    const p = plan(S, A, { ...noRel, scanItems: [{ id: 'si1', receivedQtyBase: null }], matchRuleIds: ['r1'], priceAlertIds: ['p1'] })
    if (!p.ok) throw new Error(p.message)
    expect(p.manifest.ops).toContainEqual({ t: 'repoint', table: 'InvoiceScanItem', ids: ['si1'] })
    expect(p.manifest.ops).toContainEqual({ t: 'repoint', table: 'InvoiceMatchRule', ids: ['r1'] })
    expect(p.manifest.ops).toContainEqual({
      t: 'update', table: 'InventoryItem', id: 'A',
      before: { isActive: true, mergedIntoId: null }, after: { isActive: false, mergedIntoId: 'S' },
    })
  })

  it('converts quantities when the base unit changes (each → g, ×300)', () => {
    const s = row({ id: 'S', eachMeasure: { qty: 300, unit: 'g' } })
    const a = row({ id: 'A', baseUnit: 'each', dimension: 'COUNT' })
    const p = plan(s, a, {
      ...noRel,
      scanItems: [{ id: 'si1', receivedQtyBase: 10 }],
      recipeIngredients: [{ id: 'ri1', qtyBase: 2, unit: 'each' }],
      countLines: [{ id: 'cl1', expectedQty: 4, countedQtyBase: 5, priceAtCount: 0.9 }],
    })
    if (!p.ok) throw new Error(p.message)
    const upd = (id: string) => p.manifest.ops.find(o => o.t === 'update' && o.id === id) as { after: Record<string, number | string> }
    expect(upd('si1').after.receivedQtyBase).toBe(3000)
    expect(upd('ri1').after).toEqual({ qtyBase: 600, unit: 'g' })
    expect(upd('cl1').after.countedQtyBase).toBe(1500)
    expect(upd('cl1').after.priceAtCount).toBeCloseTo(0.003)
  })

  it('non-integer factor is carried through without rounding (1/250)', () => {
    // survivor is a COUNT item (1 each = 250g); absorbed is tracked in g.
    const s = row({ id: 'S', baseUnit: 'each', dimension: 'COUNT', eachMeasure: { qty: 250, unit: 'g' } })
    const a = row({ id: 'A', baseUnit: 'g', dimension: 'MASS' })
    expect(baseFactor(a, s)).toBeCloseTo(1 / 250)
    const p = plan(s, a, { ...noRel, recipeIngredients: [{ id: 'ri1', qtyBase: 1000, unit: 'g' }] })
    if (!p.ok) throw new Error(p.message)
    expect(p.manifest.factor).toBeCloseTo(1 / 250)
    const upd = p.manifest.ops.find(o => o.t === 'update' && o.id === 'ri1') as { after: Record<string, unknown> }
    expect(upd.after.qtyBase as number).toBeCloseTo(4) // 1000g / 250g-per-each = 4 each — not rounded to an integer factor
    expect(upd.after.unit).toBe('each')
  })

  it('offer collision keeps the newer, deletes the older, never leaves two primaries', () => {
    const p = plan(S, A,
      { ...noRel, offers: [{ id: 'oA', supplierName: 'Sysco', supplierId: 's', lastUpdated: '2026-09-01', isPrimary: true }] },
      { ...noSRel, offers: [{ id: 'oS', supplierName: 'Sysco', lastUpdated: '2026-08-01' }] })
    if (!p.ok) throw new Error(p.message)
    expect(p.manifest.ops.some(o => o.t === 'delete' && o.table === 'InventorySupplierPrice' && o.row.id === 'oS')).toBe(true)
    expect(p.manifest.ops).toContainEqual({ t: 'repoint', table: 'InventorySupplierPrice', ids: ['oA'] })
    expect(p.manifest.ops.some(o => o.t === 'update' && o.id === 'oA' && o.after.isPrimary === false)).toBe(true)
  })

  it('delete row carries every field of the input row, including undeclared ones, for exact undo', () => {
    // the survivor's own offer is newer, so the absorbed's offer is dropped
    // entirely (not moved) — this exercises the "delete o itself" branch,
    // distinct from the "delete the survivor's dupe" branch above.
    const absorbedOffer = {
      id: 'oA', supplierName: 'Sysco', supplierId: 's', lastUpdated: '2026-08-01', isPrimary: false,
      lastPrice: 12.5, packQty: 3, // undeclared extra fields the executor loads as a full DB row
    }
    const p = plan(S, A,
      { ...noRel, offers: [absorbedOffer] },
      { ...noSRel, offers: [{ id: 'oS', supplierName: 'Sysco', lastUpdated: '2026-09-01' }] })
    if (!p.ok) throw new Error(p.message)
    const del = p.manifest.ops.find(o => o.t === 'delete' && o.table === 'InventorySupplierPrice' && o.row.id === 'oA') as { row: Record<string, unknown> }
    expect(del.row).toMatchObject({ lastPrice: 12.5, packQty: 3, inventoryItemId: 'A' })

    const undo = planUndo(p.manifest)
    const created = undo.find(o => o.t === 'create' && o.row.id === 'oA') as { row: Record<string, unknown> }
    expect(created.row).toMatchObject({ lastPrice: 12.5, packQty: 3, inventoryItemId: 'A' })
  })

  it('synthesizes an offer when the absorbed row has purchases but none', () => {
    const p = plan(S, row({ id: 'A', packChain: [{ unit: 'lb', per: 453.592 }] }),
      { ...noRel, scanItems: [{ id: 'si1', receivedQtyBase: null }], latestPurchaseSupplier: { supplierId: null, supplierName: 'North Arm Farms' } })
    if (!p.ok) throw new Error(p.message)
    const created = p.manifest.ops.find(o => o.t === 'create') as { row: Record<string, unknown> }
    expect(created.row).toMatchObject({ inventoryItemId: 'S', supplierName: 'North Arm Farms', isPrimary: false, packChain: [{ unit: 'lb', per: 453.592 }] })
  })

  it('two snapshots of one count session collapse into one, stronger source wins', () => {
    const p = plan(S, A,
      { ...noRel, snapshots: [{ id: 'nA', sessionId: 'c1', qtyOnHand: 500, unit: 'g', pricePerBaseUnit: 0.01, totalValue: 5, source: 'COUNTED' }] },
      { ...noSRel, snapshots: [{ id: 'nS', sessionId: 'c1', qtyOnHand: 1000, totalValue: 10, source: 'THEORETICAL' }] })
    if (!p.ok) throw new Error(p.message)
    const upd = p.manifest.ops.find(o => o.t === 'update' && o.id === 'nS') as { after: Record<string, unknown> }
    expect(upd.after).toMatchObject({ qtyOnHand: 1500, totalValue: 15, source: 'COUNTED' })
    const del = p.manifest.ops.find(o => o.t === 'delete' && o.table === 'InventorySnapshot' && o.row.id === 'nA') as { row: Record<string, unknown> }
    expect(del).toBeTruthy()
    // the deleted absorbed snapshot must keep its ORIGINAL (unconverted) values —
    // the executor recreates it verbatim on undo, and the survivor's `before` in
    // the paired update already restores the pre-merge total on that side.
    expect(del.row).toMatchObject({ qtyOnHand: 500, totalValue: 5, source: 'COUNTED', inventoryItemId: 'A' })
  })

  it('allocations union: collision sums, otherwise re-points', () => {
    const p = plan(S, A,
      { ...noRel, allocations: [
        { id: 'aA1', revenueCenterId: 'rc1', quantity: 5, parLevel: null, reorderQty: null },
        { id: 'aA2', revenueCenterId: 'rc2', quantity: 7, parLevel: null, reorderQty: null } ] },
      { ...noSRel, allocations: [{ id: 'aS1', revenueCenterId: 'rc1', quantity: 10 }] })
    if (!p.ok) throw new Error(p.message)
    const aS1 = p.manifest.ops.find(o => o.t === 'update' && o.id === 'aS1') as { after: Record<string, unknown> }
    expect(aS1.after.quantity as number).toBe(15)
    expect(p.manifest.ops).toContainEqual({ t: 'repoint', table: 'StockAllocation', ids: ['aA2'] })
  })
})

describe('planUndo', () => {
  it('is the exact inverse, in reverse order', () => {
    const p = plan(S, A, { ...noRel, scanItems: [{ id: 'si1', receivedQtyBase: null }] })
    if (!p.ok) throw new Error(p.message)
    const undo = planUndo(p.manifest)
    expect(undo[0]).toEqual({ t: 'update', table: 'InventoryItem', id: 'A', before: { isActive: false, mergedIntoId: 'S' }, after: { isActive: true, mergedIntoId: null } })
    expect(undo.at(-1)).toEqual({ t: 'repoint', table: 'InvoiceScanItem', ids: ['si1'] }) // executor re-points to absorbedId
  })

  it('round-trips every op kind without an `as` cast needed by callers', () => {
    const p = plan(S, A,
      { ...noRel,
        scanItems: [{ id: 'si1', receivedQtyBase: null }],
        offers: [{ id: 'oA', supplierName: 'Sysco', supplierId: 's', lastUpdated: '2026-09-01', isPrimary: true }],
      },
      { ...noSRel, offers: [{ id: 'oS', supplierName: 'Sysco', lastUpdated: '2026-08-01' }] })
    if (!p.ok) throw new Error(p.message)
    const undo: MergeOp[] = planUndo(p.manifest)
    expect(undo.length).toBe(p.manifest.ops.length)
    // create <-> delete swapped for the offer that was fully dropped
    expect(undo.some(o => o.t === 'create' && o.table === 'InventorySupplierPrice')).toBe(true)
  })
})
