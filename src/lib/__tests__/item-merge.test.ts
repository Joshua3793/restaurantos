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
  latestPurchaseSupplier: null, priorAbsorbeeIds: [],
}
const noSRel: SurvivorRelations = { offers: [], allocations: [], itemRcs: [], snapshots: [] }
const S = row({ id: 'S', itemName: 'kennebec potato' })
const A = row({ id: 'A', itemName: 'Potatoes, Kennebec O/S' })
/** deterministic id source per plan() call, per CRITICAL 1 */
const makeNewId = () => { let n = 0; return () => `new-${++n}` }
const plan = (s = S, a = A, rel = noRel, sRel = noSRel, provided = false) =>
  planMerge(s, a, rel, sRel, { combinedOnHandProvided: provided, newId: makeNewId() })

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
  it('MINOR 2: epsilon-tolerant on-hand guard — negative on-hand still fires, float noise does not', () => {
    expect(guard(plan(S, row({ id: 'A', theoreticalOnHand: -3 })))).toBe('NEEDS_ON_HAND')
    expect(plan(S, row({ id: 'A', theoreticalOnHand: 1e-10 })).ok).toBe(true)
  })
})

describe('planMerge ops', () => {
  it('re-points plain tables and tombstones the absorbed row (incl. zeroing its stock)', () => {
    const p = plan(S, A, { ...noRel, scanItems: [{ id: 'si1', receivedQtyBase: null }], matchRuleIds: ['r1'], priceAlertIds: ['p1'] })
    if (!p.ok) throw new Error(p.message)
    expect(p.manifest.ops).toContainEqual({ t: 'repoint', table: 'InvoiceScanItem', ids: ['si1'] })
    expect(p.manifest.ops).toContainEqual({ t: 'repoint', table: 'InvoiceMatchRule', ids: ['r1'] })
    expect(p.manifest.ops).toContainEqual({
      t: 'update', table: 'InventoryItem', id: 'A',
      before: { isActive: true, mergedIntoId: null, stockOnHand: 0 }, after: { isActive: false, mergedIntoId: 'S', stockOnHand: 0 },
    })
  })

  it('converts quantities when the base unit changes (each → g, ×300)', () => {
    const s = row({ id: 'S', eachMeasure: { qty: 300, unit: 'g' } })
    const a = row({ id: 'A', baseUnit: 'each', dimension: 'COUNT' })
    const p = plan(s, a, {
      ...noRel,
      scanItems: [{ id: 'si1', receivedQtyBase: 10 }],
      recipeIngredients: [{ id: 'ri1', qtyBase: 2, unit: 'each' }],
      countLines: [{ id: 'cl1', expectedQty: 4, countedQtyBase: 5, priceAtCount: 0.9, countedQty: 5, selectedUom: 'each', entries: null }],
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

  it('MINOR 1: does not convert a line whose unit dimension does not match the absorbed item', () => {
    // survivor COUNT (each, 250g/each) ← absorbed MASS (g); a `ml` (VOLUME) recipe
    // line matches neither cleanly and must be left alone, not force-converted.
    const s = row({ id: 'S', baseUnit: 'each', dimension: 'COUNT', eachMeasure: { qty: 250, unit: 'g' } })
    const a = row({ id: 'A', baseUnit: 'g', dimension: 'MASS' })
    const p = plan(s, a, { ...noRel, recipeIngredients: [{ id: 'ri1', qtyBase: 500, unit: 'ml' }] })
    if (!p.ok) throw new Error(p.message)
    expect(p.manifest.ops.some(o => o.t === 'update' && o.table === 'RecipeIngredient' && o.id === 'ri1')).toBe(false)
    expect(p.manifest.ops).toContainEqual({ t: 'repoint', table: 'RecipeIngredient', ids: ['ri1'] })
  })

  describe('CRITICAL 1: synthesized offer id', () => {
    it('gets an id from opts.newId, and undo deletes by that same id', () => {
      const p = plan(S, row({ id: 'A', packChain: [{ unit: 'lb', per: 453.592 }] }),
        { ...noRel, scanItems: [{ id: 'si1', receivedQtyBase: null }], latestPurchaseSupplier: { supplierId: null, supplierName: 'North Arm Farms' } })
      if (!p.ok) throw new Error(p.message)
      const created = p.manifest.ops.find(o => o.t === 'create') as { row: Record<string, unknown> }
      expect(created.row).toMatchObject({ inventoryItemId: 'S', supplierName: 'North Arm Farms', isPrimary: false, packChain: [{ unit: 'lb', per: 453.592 }] })
      expect(typeof created.row.id).toBe('string')
      expect((created.row.id as string).length).toBeGreaterThan(0)

      const undo = planUndo(p.manifest)
      const del = undo.find(o => o.t === 'delete' && o.table === 'InventorySupplierPrice') as { row: Record<string, unknown> }
      expect(del.row.id).toBe(created.row.id)
    })

    it('M4: does not synthesize when the derived price is not a finite positive number', () => {
      const p = plan(S, row({ id: 'A', packChain: [{ unit: 'lb', per: 453.592 }], pricing: { mode: 'PACK', purchasePrice: 0 } }),
        { ...noRel, scanItems: [{ id: 'si1', receivedQtyBase: null }], latestPurchaseSupplier: { supplierId: null, supplierName: 'North Arm Farms' } })
      if (!p.ok) throw new Error(p.message)
      expect(p.manifest.ops.some(o => o.t === 'create')).toBe(false)
      expect(p.summary.offerSynthesized).toBe(false)
    })
  })

  describe('offers', () => {
    it('offer collision keeps the newer, deletes the older, never leaves two primaries', () => {
      const p = plan(S, A,
        { ...noRel, offers: [{ id: 'oA', supplierName: 'Sysco', supplierId: 's', lastUpdated: '2026-09-01', isPrimary: true }] },
        { ...noSRel, offers: [{ id: 'oS', supplierName: 'Sysco', lastUpdated: '2026-08-01', isPrimary: false }] })
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
        { ...noSRel, offers: [{ id: 'oS', supplierName: 'Sysco', lastUpdated: '2026-09-01', isPrimary: false }] })
      if (!p.ok) throw new Error(p.message)
      const del = p.manifest.ops.find(o => o.t === 'delete' && o.table === 'InventorySupplierPrice' && o.row.id === 'oA') as { row: Record<string, unknown> }
      expect(del.row).toMatchObject({ lastPrice: 12.5, packQty: 3, inventoryItemId: 'A' })

      const undo = planUndo(p.manifest)
      const created = undo.find(o => o.t === 'create' && o.row.id === 'oA') as { row: Record<string, unknown> }
      expect(created.row).toMatchObject({ lastPrice: 12.5, packQty: 3, inventoryItemId: 'A' })
    })

    describe('CRITICAL 2: the survivor primary offer is never touched', () => {
      it('survivor primary + OLDER than the absorbed offer → absorbed offer deleted, survivor untouched', () => {
        const p = plan(S, A,
          { ...noRel, offers: [{ id: 'oA', supplierName: 'Sysco', supplierId: 's', lastUpdated: '2026-09-01', isPrimary: false }] },
          { ...noSRel, offers: [{ id: 'oS', supplierName: 'Sysco', lastUpdated: '2026-08-01', isPrimary: true }] })
        if (!p.ok) throw new Error(p.message)
        expect(p.manifest.ops.some(o => o.t === 'delete' && o.table === 'InventorySupplierPrice' && o.row.id === 'oA')).toBe(true)
        expect(p.manifest.ops.some(o => o.t === 'delete' && o.row.id === 'oS')).toBe(false)
        expect(p.manifest.ops.some(o => o.t === 'update' && o.table === 'InventorySupplierPrice')).toBe(false)
        expect(p.summary.survivorOffersReplaced).toBe(0)
        expect(p.summary.absorbedOffersDropped).toBe(1)
      })

      it('reviewer trace: survivor has a primary (Sysco) plus another offer (Other); absorbed brings a newer Sysco offer — never deleted, never a double primary on undo', () => {
        const p = plan(S, A,
          { ...noRel, offers: [{ id: 'oA', supplierName: 'Sysco', supplierId: 's', lastUpdated: '2026-09-01', isPrimary: false }] },
          { ...noSRel, offers: [
            { id: 'oS', supplierName: 'Sysco', lastUpdated: '2026-08-01', isPrimary: true },
            { id: 'oX', supplierName: 'Other', lastUpdated: '2026-01-01', isPrimary: false },
          ] })
        if (!p.ok) throw new Error(p.message)
        expect(p.manifest.ops.some(o => o.t === 'delete' && o.row.id === 'oS')).toBe(false)
        const undo = planUndo(p.manifest)
        expect(undo.some(o => o.t === 'create' && (o.row as Record<string, unknown>).isPrimary === true && (o.row as Record<string, unknown>).inventoryItemId === S.id)).toBe(false)
      })
    })
  })

  describe('IMPORTANT 2: Decimal safety', () => {
    it('sums Decimal-as-string snapshot inputs numerically, never by string concatenation', () => {
      const p = plan(S, A,
        { ...noRel, snapshots: [{ id: 'nA', sessionId: 'c1', qtyOnHand: '500' as never, unit: 'g', pricePerBaseUnit: 0.01, totalValue: '5' as never, source: 'COUNTED' }] },
        { ...noSRel, snapshots: [{ id: 'nS', sessionId: 'c1', qtyOnHand: '1000' as never, totalValue: '10' as never, source: 'THEORETICAL' }] })
      if (!p.ok) throw new Error(p.message)
      const upd = p.manifest.ops.find(o => o.t === 'update' && o.id === 'nS') as { after: Record<string, unknown> }
      expect(upd.after.qtyOnHand).toBe(1500)
      expect(upd.after.totalValue).toBe(15)
      expect(typeof upd.after.qtyOnHand).toBe('number')
      expect(typeof upd.after.totalValue).toBe('number')
    })
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

  it('MINOR 3: a no-op allocation move (k=1, same countUnit, no par/reorder) emits only a repoint', () => {
    const p = plan(S, A, { ...noRel, allocations: [{ id: 'aA1', revenueCenterId: 'rc1', quantity: 5, parLevel: null, reorderQty: null }] })
    if (!p.ok) throw new Error(p.message)
    expect(p.manifest.ops.some(o => o.t === 'update' && o.table === 'StockAllocation')).toBe(false)
    expect(p.manifest.ops).toContainEqual({ t: 'repoint', table: 'StockAllocation', ids: ['aA1'] })
  })

  describe('IMPORTANT 1: CountLine freeze + normalize', () => {
    const absorbedWithCase = row({ id: 'A', packChain: [{ unit: 'case', per: 12 }] })

    it('freezes a legacy null-base line through the ABSORBED chain, and normalises its display to the survivor base unit', () => {
      const p = plan(S, absorbedWithCase, { ...noRel, countLines: [
        { id: 'cl1', expectedQty: 0, countedQtyBase: null, priceAtCount: 0, countedQty: 3, selectedUom: 'case', entries: { rows: [1, 2] } },
      ] })
      if (!p.ok) throw new Error(p.message)
      const upd = p.manifest.ops.find(o => o.t === 'update' && o.table === 'CountLine' && o.id === 'cl1') as { before: Record<string, unknown>; after: Record<string, unknown> }
      expect(upd).toBeTruthy()
      expect(upd.after.countedQtyBase).toBe(36) // 3 case × 12 g/case × k(1)
      expect(upd.after.countedQty).toBe(36)
      expect(upd.after.selectedUom).toBe('g')
      expect(upd.after.entries).toBeNull()
      expect(upd.before).toEqual({ countedQtyBase: null, countedQty: 3, selectedUom: 'case', entries: { rows: [1, 2] } })
      expect('expectedQty' in upd.after).toBe(false) // k=1: expected/price untouched
    })

    it('does not touch a modern line already in a plain unit at k=1', () => {
      const p = plan(S, absorbedWithCase, { ...noRel, countLines: [
        { id: 'cl2', expectedQty: 5, countedQtyBase: 750, priceAtCount: 0.02, countedQty: 750, selectedUom: 'kg', entries: null },
      ] })
      if (!p.ok) throw new Error(p.message)
      expect(p.manifest.ops.some(o => o.t === 'update' && o.table === 'CountLine' && o.id === 'cl2')).toBe(false)
      expect(p.manifest.ops).toContainEqual({ t: 'repoint', table: 'CountLine', ids: ['cl2'] })
    })

    it('k=300: everything on the line converts (base, expected, price, display)', () => {
      const s = row({ id: 'S', eachMeasure: { qty: 300, unit: 'g' } })
      const a = row({ id: 'A', baseUnit: 'each', dimension: 'COUNT' })
      const p = plan(s, a, { ...noRel, countLines: [
        { id: 'cl3', expectedQty: 2, countedQtyBase: 5, priceAtCount: 0.9, countedQty: 5, selectedUom: 'each', entries: { x: 1 } },
      ] })
      if (!p.ok) throw new Error(p.message)
      const upd = p.manifest.ops.find(o => o.t === 'update' && o.table === 'CountLine' && o.id === 'cl3') as { before: Record<string, unknown>; after: Record<string, unknown> }
      expect(upd.before).toEqual({ countedQtyBase: 5, expectedQty: 2, priceAtCount: 0.9, countedQty: 5, selectedUom: 'each', entries: { x: 1 } })
      expect(upd.after.countedQtyBase).toBe(1500)
      expect(upd.after.expectedQty).toBe(600)
      expect(upd.after.priceAtCount as number).toBeCloseTo(0.003)
      expect(upd.after.countedQty).toBe(1500)
      expect(upd.after.selectedUom).toBe('g')
      expect(upd.after.entries).toBeNull()
    })

    it('undo restores every CountLine field exactly (k=300 case)', () => {
      const s = row({ id: 'S', eachMeasure: { qty: 300, unit: 'g' } })
      const a = row({ id: 'A', baseUnit: 'each', dimension: 'COUNT' })
      const p = plan(s, a, { ...noRel, countLines: [
        { id: 'cl3', expectedQty: 2, countedQtyBase: 5, priceAtCount: 0.9, countedQty: 5, selectedUom: 'each', entries: { x: 1 } },
      ] })
      if (!p.ok) throw new Error(p.message)
      const fwd = p.manifest.ops.find(o => o.t === 'update' && o.table === 'CountLine' && o.id === 'cl3') as { before: Record<string, unknown>; after: Record<string, unknown> }
      const undo = planUndo(p.manifest)
      const back = undo.find(o => o.t === 'update' && o.table === 'CountLine' && o.id === 'cl3') as { before: Record<string, unknown>; after: Record<string, unknown> }
      expect(back.before).toEqual(fwd.after)
      expect(back.after).toEqual(fwd.before)
    })
  })

  describe('IMPORTANT 3: tombstone chains', () => {
    it('re-points a previously-absorbed row\'s mergedIntoId onto the new survivor, one hop', () => {
      const p = plan(S, A, { ...noRel, priorAbsorbeeIds: ['Z1', 'Z2'] })
      if (!p.ok) throw new Error(p.message)
      expect(p.manifest.ops).toContainEqual({ t: 'update', table: 'InventoryItem', id: 'Z1', before: { mergedIntoId: 'A' }, after: { mergedIntoId: 'S' } })
      expect(p.manifest.ops).toContainEqual({ t: 'update', table: 'InventoryItem', id: 'Z2', before: { mergedIntoId: 'A' }, after: { mergedIntoId: 'S' } })
      const undo = planUndo(p.manifest)
      expect(undo).toContainEqual({ t: 'update', table: 'InventoryItem', id: 'Z1', before: { mergedIntoId: 'S' }, after: { mergedIntoId: 'A' } })
      expect(undo).toContainEqual({ t: 'update', table: 'InventoryItem', id: 'Z2', before: { mergedIntoId: 'S' }, after: { mergedIntoId: 'A' } })
    })
  })

  describe('IMPORTANT 4: the absorbed row\'s own stock is zeroed by the tombstone op', () => {
    it('non-zero absorbed stock is zeroed on the absorbed row, and added onto the survivor', () => {
      const p = plan(S, row({ id: 'A', stockOnHand: 40 }))
      if (!p.ok) throw new Error(p.message)
      expect(p.manifest.ops).toContainEqual({
        t: 'update', table: 'InventoryItem', id: 'S',
        before: { stockOnHand: 0 }, after: { stockOnHand: 40 },
      })
      expect(p.manifest.ops).toContainEqual({
        t: 'update', table: 'InventoryItem', id: 'A',
        before: { isActive: true, mergedIntoId: null, stockOnHand: 40 }, after: { isActive: false, mergedIntoId: 'S', stockOnHand: 0 },
      })
    })
  })
})

describe('planUndo', () => {
  it('is the exact inverse, in reverse order', () => {
    const p = plan(S, A, { ...noRel, scanItems: [{ id: 'si1', receivedQtyBase: null }] })
    if (!p.ok) throw new Error(p.message)
    const undo = planUndo(p.manifest)
    expect(undo[0]).toEqual({
      t: 'update', table: 'InventoryItem', id: 'A',
      before: { isActive: false, mergedIntoId: 'S', stockOnHand: 0 }, after: { isActive: true, mergedIntoId: null, stockOnHand: 0 },
    })
    expect(undo.at(-1)).toEqual({ t: 'repoint', table: 'InvoiceScanItem', ids: ['si1'] }) // executor re-points to absorbedId
  })

  it('round-trips every op kind without an `as` cast needed by callers', () => {
    const p = plan(S, A,
      { ...noRel,
        scanItems: [{ id: 'si1', receivedQtyBase: null }],
        offers: [{ id: 'oA', supplierName: 'Sysco', supplierId: 's', lastUpdated: '2026-09-01', isPrimary: true }],
      },
      { ...noSRel, offers: [{ id: 'oS', supplierName: 'Sysco', lastUpdated: '2026-08-01', isPrimary: false }] })
    if (!p.ok) throw new Error(p.message)
    const undo: MergeOp[] = planUndo(p.manifest)
    expect(undo.length).toBe(p.manifest.ops.length)
    // create <-> delete swapped for the offer that was fully dropped
    expect(undo.some(o => o.t === 'create' && o.table === 'InventorySupplierPrice')).toBe(true)
  })
})
