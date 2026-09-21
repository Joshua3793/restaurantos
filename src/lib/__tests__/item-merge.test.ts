import { describe, it, expect } from 'vitest'
import { planMerge, planUndo, type MergeItemRow, type MergeRelations, type SurvivorRelations, type MergeOp } from '@/lib/item-merge'
import { lineCountedBase, type ItemDims } from '@/lib/count-uom'

const row = (over: Partial<MergeItemRow>): MergeItemRow => ({
  id: 'x', itemName: 'x', baseUnit: 'g', dimension: 'MASS', countUnit: 'kg',
  packChain: [{ unit: 'case', per: 1000 }], pricing: { mode: 'PACK', purchasePrice: 10 }, stockOnHand: 0,
  eachMeasure: null, densityGPerMl: null, isActive: true, mergedIntoId: null,
  ownedByRecipe: false, inOpenCount: false, theoreticalOnHand: 0, ...over,
})
const noRel: MergeRelations = {
  scanItemIds: [], invoiceLineItemIds: [], priceAlertIds: [], matchRuleIds: [], transferIds: [],
  wastageIds: [], recipeIngredients: [], countLines: [], snapshots: [], offers: [], allocations: [], itemRcs: [],
  latestPurchaseSupplier: null, priorAbsorbeeIds: [],
}
const noSRel: SurvivorRelations = { offers: [], allocations: [], itemRcs: [], snapshots: [] }
const S = row({ id: 'S', itemName: 'kennebec potato' })
const A = row({ id: 'A', itemName: 'Potatoes, Kennebec O/S' })
/** deterministic id source per plan() call */
const makeNewId = () => { let n = 0; return () => `new-${++n}` }
const plan = (s = S, a = A, rel = noRel, sRel = noSRel, provided = false) =>
  planMerge(s, a, rel, sRel, { combinedOnHandProvided: provided, newId: makeNewId() })

/** Builds the same ItemDims the planner builds from a MergeItemRow, for tests
 *  that call the count-uom reader directly as the oracle. */
const dimsOf = (item: MergeItemRow): ItemDims => ({
  dimension: item.dimension, baseUnit: item.baseUnit, packChain: item.packChain,
  countUnit: item.countUnit, eachMeasureQty: item.eachMeasure?.qty ?? null, eachMeasureUnit: item.eachMeasure?.unit ?? null,
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
  it('absorbed on-hand > 0 needs a combined on-hand', () => {
    expect(guard(plan(S, row({ id: 'A', theoreticalOnHand: 12 })))).toBe('NEEDS_ON_HAND')
    expect(plan(S, row({ id: 'A', theoreticalOnHand: 12 }), noRel, noSRel, true).ok).toBe(true)
  })
  it('epsilon-tolerant on-hand guard — negative on-hand still fires, float noise does not', () => {
    expect(guard(plan(S, row({ id: 'A', theoreticalOnHand: -3 })))).toBe('NEEDS_ON_HAND')
    expect(plan(S, row({ id: 'A', theoreticalOnHand: 1e-10 })).ok).toBe(true)
  })

  describe('v1 SCOPE CUT: DIFFERENT_BASE_UNIT', () => {
    it('refuses a merge whose items track different base units', () => {
      const a = row({ id: 'A', itemName: A.itemName, baseUnit: 'each', dimension: 'COUNT' })
      const p = plan(S, a)
      expect(p.ok).toBe(false)
      if (p.ok) throw new Error('expected failure')
      expect(p.guard).toBe('DIFFERENT_BASE_UNIT')
      expect(p.message).toContain(A.itemName)
      expect(p.message).toContain(S.itemName)
      expect(p.message).toContain('each')
      expect(p.message).toContain('g')
    })

    it('compares canonically and case-insensitively — same unit under different spelling/case passes', () => {
      const p = plan(row({ id: 'S', baseUnit: 'g' }), row({ id: 'A', baseUnit: 'G' }))
      expect(p.ok).toBe(true)
    })

    it('there is no bridge left to ask for — NO_BRIDGE no longer exists as a guard', () => {
      const p = plan(S, row({ id: 'A', baseUnit: 'each', dimension: 'COUNT' }))
      if (p.ok) throw new Error('expected failure')
      expect(p.guard).not.toBe('NO_BRIDGE')
    })
  })

  describe('IMPORTANT Imp-2: BRIDGE_MISMATCH', () => {
    it('refuses when a count-bridged (each-measure) recipe line would re-cost differently on the survivor', () => {
      const s = row({ id: 'S', itemName: S.itemName, eachMeasure: { qty: 150, unit: 'g' } })
      const a = row({ id: 'A', itemName: A.itemName, eachMeasure: { qty: 200, unit: 'g' } })
      const p = plan(s, a, { ...noRel, recipeIngredients: [{ id: 'ri1', unit: 'each' }] })
      expect(p.ok).toBe(false)
      if (p.ok) throw new Error('expected failure')
      expect(p.guard).toBe('BRIDGE_MISMATCH')
      expect(p.message).toContain('150')
      expect(p.message).toContain('200')
      expect(p.message).toContain(S.itemName)
      expect(p.message).toContain('Set the same each-measure/density')
    })

    it('passes when both items carry the same each-measure', () => {
      const s = row({ id: 'S', eachMeasure: { qty: 150, unit: 'g' } })
      const a = row({ id: 'A', eachMeasure: { qty: 150, unit: 'g' } })
      const p = plan(s, a, { ...noRel, recipeIngredients: [{ id: 'ri1', unit: 'each' }] })
      expect(p.ok).toBe(true)
    })

    it('a recipe line in a same-dimension unit never triggers it, even with mismatched bridges', () => {
      const s = row({ id: 'S', eachMeasure: { qty: 150, unit: 'g' } })
      const a = row({ id: 'A', eachMeasure: { qty: 200, unit: 'g' } })
      const p = plan(s, a, { ...noRel, recipeIngredients: [{ id: 'ri1', unit: 'g' }] }) // MASS, same as item dimension
      expect(p.ok).toBe(true)
    })

    it('passes when neither item has the needed bridge (already unbridgeable on both sides today)', () => {
      const p = plan(S, A, { ...noRel, recipeIngredients: [{ id: 'ri1', unit: 'each' }] }) // both eachMeasure: null
      expect(p.ok).toBe(true)
    })

    it('refuses on a density mismatch for a weight↔volume line', () => {
      const s = row({ id: 'S', densityGPerMl: 1.0 })
      const a = row({ id: 'A', densityGPerMl: 0.92 })
      const p = plan(s, a, { ...noRel, recipeIngredients: [{ id: 'ri1', unit: 'ml' }] }) // VOLUME, item is MASS
      expect(p.ok).toBe(false)
      if (p.ok) throw new Error('expected failure')
      expect(p.guard).toBe('BRIDGE_MISMATCH')
      expect(p.message).toContain('density')
    })

    it('passes on an equal density for a weight↔volume line', () => {
      const s = row({ id: 'S', densityGPerMl: 0.92 })
      const a = row({ id: 'A', densityGPerMl: 0.92 })
      const p = plan(s, a, { ...noRel, recipeIngredients: [{ id: 'ri1', unit: 'ml' }] })
      expect(p.ok).toBe(true)
    })
  })
})

describe('planMerge ops', () => {
  it('re-points plain tables and tombstones the absorbed row (incl. zeroing its stock) — no factor on the manifest', () => {
    const p = plan(S, A, { ...noRel, scanItemIds: ['si1'], matchRuleIds: ['r1'], priceAlertIds: ['p1'] })
    if (!p.ok) throw new Error(p.message)
    expect(p.manifest.ops).toContainEqual({ t: 'repoint', table: 'InvoiceScanItem', ids: ['si1'] })
    expect(p.manifest.ops).toContainEqual({ t: 'repoint', table: 'InvoiceMatchRule', ids: ['r1'] })
    expect(p.manifest.ops).toContainEqual({
      t: 'update', table: 'InventoryItem', id: 'A',
      before: { isActive: true, mergedIntoId: null, stockOnHand: 0 }, after: { isActive: false, mergedIntoId: 'S', stockOnHand: 0 },
    })
    expect('factor' in p.manifest).toBe(false)
    expect('factor' in p.summary).toBe(false)
  })

  describe('CRITICAL 1: synthesized offer id, and Crit-3 verbatim pricing', () => {
    it('gets an id from opts.newId, carries packChain+pricing verbatim, and undo deletes by that same id', () => {
      const p = plan(S, row({ id: 'A', packChain: [{ unit: 'lb', per: 453.592 }], pricing: { mode: 'PACK', purchasePrice: 22 } }),
        { ...noRel, scanItemIds: ['si1'], latestPurchaseSupplier: { supplierId: null, supplierName: 'North Arm Farms' } })
      if (!p.ok) throw new Error(p.message)
      const created = p.manifest.ops.find(o => o.t === 'create') as { row: Record<string, unknown> }
      // survivor has zero offers, so I-1 promotes this synthesized one to primary.
      expect(created.row).toMatchObject({
        inventoryItemId: 'S', supplierName: 'North Arm Farms', isPrimary: true,
        packChain: [{ unit: 'lb', per: 453.592 }], pricing: { mode: 'PACK', purchasePrice: 22 }, lastPrice: 22,
      })
      expect(typeof created.row.id).toBe('string')
      expect((created.row.id as string).length).toBeGreaterThan(0)
      expect(p.summary.primaryPromoted).toEqual({ supplierName: 'North Arm Farms' })

      const undo = planUndo(p.manifest)
      const del = undo.find(o => o.t === 'delete' && o.table === 'InventorySupplierPrice') as { row: Record<string, unknown> }
      expect(del.row.id).toBe(created.row.id)
    })

    it('Crit-3: a RATE-priced absorbed item synthesizes with the RATE pricing object and a finite lastPrice', () => {
      const p = plan(S, row({ id: 'A', pricing: { mode: 'RATE', rate: 3.5, rateUnit: 'g' } }),
        { ...noRel, scanItemIds: ['si1'], latestPurchaseSupplier: { supplierId: null, supplierName: 'North Arm Farms' } })
      if (!p.ok) throw new Error(p.message)
      const created = p.manifest.ops.find(o => o.t === 'create') as { row: Record<string, unknown> }
      expect(created.row.pricing).toEqual({ mode: 'RATE', rate: 3.5, rateUnit: 'g' })
      expect(created.row.lastPrice).toBe(3.5)
      expect(Number.isFinite(created.row.lastPrice as number)).toBe(true)
    })

    it('does not synthesize when the derived price is not a finite positive number', () => {
      const p = plan(S, row({ id: 'A', packChain: [{ unit: 'lb', per: 453.592 }], pricing: { mode: 'PACK', purchasePrice: 0 } }),
        { ...noRel, scanItemIds: ['si1'], latestPurchaseSupplier: { supplierId: null, supplierName: 'North Arm Farms' } })
      if (!p.ok) throw new Error(p.message)
      expect(p.manifest.ops.some(o => o.t === 'create')).toBe(false)
      expect(p.summary.offerSynthesized).toBe(false)
      expect(p.summary.primaryPromoted).toBeNull()
    })
  })

  describe('offers', () => {
    it('offer collision keeps the newer, deletes the older, and demotes it since the survivor already has a primary elsewhere', () => {
      const p = plan(S, A,
        { ...noRel, offers: [{ id: 'oA', supplierName: 'Sysco', supplierId: 's', lastUpdated: '2026-09-01', isPrimary: true }] },
        { ...noSRel, offers: [
          { id: 'oS', supplierName: 'Sysco', lastUpdated: '2026-08-01', isPrimary: false },
          { id: 'oKeep', supplierName: 'Keep Co', lastUpdated: '2020-01-01', isPrimary: true },
        ] })
      if (!p.ok) throw new Error(p.message)
      expect(p.manifest.ops.some(o => o.t === 'delete' && o.table === 'InventorySupplierPrice' && o.row.id === 'oS')).toBe(true)
      expect(p.manifest.ops).toContainEqual({ t: 'repoint', table: 'InventorySupplierPrice', ids: ['oA'] })
      expect(p.manifest.ops.some(o => o.t === 'update' && o.id === 'oA' && o.after.isPrimary === false)).toBe(true)
      // the survivor already has its own primary (oKeep, untouched) — nothing new to promote
      expect(p.summary.primaryPromoted).toBeNull()
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
        // absorbed's offer IS newer here, so this is a genuine override, not staleness.
        expect(p.summary.absorbedOffersDroppedForSurvivorPrimary).toBe(1)
        expect(p.summary.absorbedOffersDroppedStale).toBe(0)
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

    describe('M-iv: the date check runs before the primary test, so the two drop reasons are distinguishable', () => {
      it('a drop that is BOTH stale AND primary-protected is labelled stale — the primary rule adds nothing extra to say here', () => {
        const p = plan(S, A,
          { ...noRel, offers: [{ id: 'oA', supplierName: 'Sysco', supplierId: null, lastUpdated: '2020-01-01', isPrimary: false }] },
          { ...noSRel, offers: [{ id: 'oS', supplierName: 'Sysco', lastUpdated: '2026-01-01', isPrimary: true }] })
        if (!p.ok) throw new Error(p.message)
        expect(p.summary.absorbedOffersDroppedStale).toBe(1)
        expect(p.summary.absorbedOffersDroppedForSurvivorPrimary).toBe(0)
      })

      it('a drop that is primary-protected but NOT stale (the absorbed offer is genuinely newer) is labelled as the override it is', () => {
        const p = plan(S, A,
          { ...noRel, offers: [{ id: 'oA', supplierName: 'Sysco', supplierId: null, lastUpdated: '2026-09-01', isPrimary: false }] },
          { ...noSRel, offers: [{ id: 'oS', supplierName: 'Sysco', lastUpdated: '2020-01-01', isPrimary: true }] })
        if (!p.ok) throw new Error(p.message)
        expect(p.summary.absorbedOffersDroppedForSurvivorPrimary).toBe(1)
        expect(p.summary.absorbedOffersDroppedStale).toBe(0)
      })

      it('an ordinary stale drop (neither offer primary) is labelled stale', () => {
        const p = plan(S, A,
          { ...noRel, offers: [{ id: 'oA', supplierName: 'Sysco', supplierId: null, lastUpdated: '2020-01-01', isPrimary: false }] },
          { ...noSRel, offers: [{ id: 'oS', supplierName: 'Sysco', lastUpdated: '2026-01-01', isPrimary: false }] })
        if (!p.ok) throw new Error(p.message)
        expect(p.summary.absorbedOffersDroppedStale).toBe(1)
        expect(p.summary.absorbedOffersDroppedForSurvivorPrimary).toBe(0)
      })
    })

    describe('MINOR M-a: ts() NaN safety', () => {
      it('an unparsable lastUpdated is treated as oldest; a NaN-vs-NaN tie keeps the survivor', () => {
        const p = plan(S, A,
          { ...noRel, offers: [{ id: 'oA', supplierName: 'Sysco', supplierId: null, lastUpdated: 'not-a-date', isPrimary: false }] },
          { ...noSRel, offers: [{ id: 'oS', supplierName: 'Sysco', lastUpdated: 'also-not-a-date', isPrimary: false }] })
        if (!p.ok) throw new Error(p.message)
        expect(p.manifest.ops.some(o => o.t === 'delete' && o.row.id === 'oA')).toBe(true)
        expect(p.manifest.ops.some(o => o.t === 'delete' && o.row.id === 'oS')).toBe(false)
        expect(p.summary.absorbedOffersDroppedStale).toBe(1)
      })
    })

    describe('IMPORTANT I-1: exactly one primary after a merge', () => {
      it('scenario H: survivor with zero offers — the most recently updated moved offer is promoted; undo restores the absorbed item\'s original single primary', () => {
        const p = plan(S, A,
          { ...noRel, offers: [
            { id: 'o1', supplierName: 'Sysco', supplierId: null, lastUpdated: '2026-01-01', isPrimary: true },
            { id: 'o2', supplierName: 'Other', supplierId: null, lastUpdated: '2026-06-01', isPrimary: false },
          ] },
          { ...noSRel, offers: [] })
        if (!p.ok) throw new Error(p.message)
        expect(p.summary.primaryPromoted).toEqual({ supplierName: 'Other' })
        expect(p.manifest.ops).toContainEqual({ t: 'update', table: 'InventorySupplierPrice', id: 'o1', before: { isPrimary: true }, after: { isPrimary: false } })
        expect(p.manifest.ops).toContainEqual({ t: 'update', table: 'InventorySupplierPrice', id: 'o2', before: { isPrimary: false }, after: { isPrimary: true } })

        const primaryOps = p.manifest.ops.filter(o => o.t === 'update' && o.table === 'InventorySupplierPrice' && 'isPrimary' in o.after) as Array<{ id: string; after: Record<string, unknown> }>
        expect(primaryOps.filter(o => o.after.isPrimary === true).length).toBe(1)

        const repointIdx = p.manifest.ops.findIndex(o => o.t === 'repoint' && o.table === 'InventorySupplierPrice')
        const demoteIdx = p.manifest.ops.findIndex(o => o.t === 'update' && o.id === 'o1')
        const promoteIdx = p.manifest.ops.findIndex(o => o.t === 'update' && o.id === 'o2')
        expect(demoteIdx).toBeGreaterThanOrEqual(0)
        expect(demoteIdx).toBeLessThan(repointIdx)
        expect(promoteIdx).toBeGreaterThan(repointIdx)

        const undo = planUndo(p.manifest)
        expect(undo).toContainEqual({ t: 'update', table: 'InventorySupplierPrice', id: 'o1', before: { isPrimary: false }, after: { isPrimary: true } })
        expect(undo).toContainEqual({ t: 'update', table: 'InventorySupplierPrice', id: 'o2', before: { isPrimary: true }, after: { isPrimary: false } })
      })

      it('a survivor with its own primary offer gets no promotion at all', () => {
        const p = plan(S, A,
          { ...noRel, offers: [{ id: 'o1', supplierName: 'Other2', supplierId: null, lastUpdated: '2026-01-01', isPrimary: false }] },
          { ...noSRel, offers: [{ id: 'oS', supplierName: 'Sysco', lastUpdated: '2020-01-01', isPrimary: true }] })
        if (!p.ok) throw new Error(p.message)
        expect(p.summary.primaryPromoted).toBeNull()
        expect(p.manifest.ops.some(o => o.t === 'update' && o.table === 'InventorySupplierPrice' && 'isPrimary' in o.after)).toBe(false)
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
    // the deleted absorbed snapshot must keep its ORIGINAL values — the executor
    // recreates it verbatim on undo, and the survivor's `before` already restores
    // the pre-merge total on that side.
    expect(del.row).toMatchObject({ qtyOnHand: 500, totalValue: 5, source: 'COUNTED', inventoryItemId: 'A' })
  })

  it('a non-colliding snapshot is only re-pointed — same base unit, nothing to rewrite', () => {
    const p = plan(S, A, { ...noRel, snapshots: [{ id: 'nA', sessionId: 'c1', qtyOnHand: 500, unit: 'g', pricePerBaseUnit: 0.01, totalValue: 5, source: 'COUNTED' }] })
    if (!p.ok) throw new Error(p.message)
    expect(p.manifest.ops).toContainEqual({ t: 'repoint', table: 'InventorySnapshot', ids: ['nA'] })
    expect(p.manifest.ops.some(o => o.t === 'update' && o.table === 'InventorySnapshot')).toBe(false)
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

  it('a no-op allocation move (same countUnit, no par/reorder) emits only a repoint', () => {
    const p = plan(S, A, { ...noRel, allocations: [{ id: 'aA1', revenueCenterId: 'rc1', quantity: 5, parLevel: null, reorderQty: null }] })
    if (!p.ok) throw new Error(p.message)
    expect(p.manifest.ops.some(o => o.t === 'update' && o.table === 'StockAllocation')).toBe(false)
    expect(p.manifest.ops).toContainEqual({ t: 'repoint', table: 'StockAllocation', ids: ['aA1'] })
  })

  describe('IMPORTANT Imp-1: par/reorder — equal countUnit NAMES are not equal MEANINGS', () => {
    it('same countUnit name, but the two chains give it different meanings ⇒ cleared', () => {
      // both say "case"; absorbed's case is 4, survivor's is 12 — same name, different meaning.
      const a = row({ id: 'A', countUnit: 'case', packChain: [{ unit: 'case', per: 4 }] })
      const s = row({ id: 'S', countUnit: 'case', packChain: [{ unit: 'case', per: 12 }] })
      const p = plan(s, a, { ...noRel, allocations: [{ id: 'aA1', revenueCenterId: 'rc1', quantity: 5, parLevel: 10, reorderQty: 2 }] })
      if (!p.ok) throw new Error(p.message)
      const upd = p.manifest.ops.find(o => o.t === 'update' && o.table === 'StockAllocation' && o.id === 'aA1') as { after: Record<string, unknown> }
      expect(upd).toBeTruthy()
      expect(upd.after).toEqual({ parLevel: null, reorderQty: null })
    })

    it('same countUnit name, same meaning ⇒ bare repoint (par/reorder untouched)', () => {
      const a = row({ id: 'A', countUnit: 'case', packChain: [{ unit: 'case', per: 12 }] })
      const s = row({ id: 'S', countUnit: 'case', packChain: [{ unit: 'case', per: 12 }] })
      const p = plan(s, a, { ...noRel, allocations: [{ id: 'aA1', revenueCenterId: 'rc1', quantity: 5, parLevel: 10, reorderQty: 2 }] })
      if (!p.ok) throw new Error(p.message)
      expect(p.manifest.ops.some(o => o.t === 'update' && o.table === 'StockAllocation')).toBe(false)
      expect(p.manifest.ops).toContainEqual({ t: 'repoint', table: 'StockAllocation', ids: ['aA1'] })
    })

    it('"Case" vs "case", equal meaning ⇒ bare repoint (canonical + factor comparison both agree)', () => {
      const a = row({ id: 'A', countUnit: 'Case', packChain: [{ unit: 'case', per: 12 }] })
      const s = row({ id: 'S', countUnit: 'case', packChain: [{ unit: 'case', per: 12 }] })
      const p = plan(s, a, { ...noRel, allocations: [{ id: 'aA1', revenueCenterId: 'rc1', quantity: 5, parLevel: 10, reorderQty: 2 }] })
      if (!p.ok) throw new Error(p.message)
      expect(p.manifest.ops.some(o => o.t === 'update' && o.table === 'StockAllocation')).toBe(false)
      expect(p.manifest.ops).toContainEqual({ t: 'repoint', table: 'StockAllocation', ids: ['aA1'] })
    })
  })

  describe('CRITICAL 1 (Crit-1): count lines use the READERS\' own resolver, never a hand-rolled one', () => {
    // Reviewer divergence point 1: a COUNT item's leaf level shares its name
    // with the item's own base unit ("each") — counting IN "each" means 1 base
    // unit, not the leaf's pack content (12). basePerUnit (item-model.ts) gets
    // this wrong; the reader's step 0 gets it right.
    it('divergence 1: chain [{case,4},{each,12}], counted in "each" → base-unit each = 1, not 12', () => {
      const absorbed = row({ id: 'A', baseUnit: 'each', dimension: 'COUNT', packChain: [{ unit: 'case', per: 4 }, { unit: 'each', per: 12 }] })
      const survivor = row({ id: 'S', baseUnit: 'each', dimension: 'COUNT' })
      const line = { countedQtyBase: null, countedQty: 5, selectedUom: 'each', entries: null }
      const oracle = lineCountedBase(line, dimsOf(absorbed))
      expect(oracle).toBe(5) // sanity: NOT 60 (5 × 12)

      const p = plan(survivor, absorbed, { ...noRel, countLines: [{ id: 'cl1', ...line }] })
      if (!p.ok) throw new Error(p.message)
      const upd = p.manifest.ops.find(o => o.t === 'update' && o.table === 'CountLine' && o.id === 'cl1') as { after: Record<string, unknown> }
      expect(upd.after.countedQtyBase).toBe(oracle)
    })

    it('divergence 2: an unknown unit ("portion") on a COUNT item is unfrozen and counted, not frozen at ×1', () => {
      const absorbed = row({ id: 'A', baseUnit: 'each', dimension: 'COUNT', packChain: [{ unit: 'case', per: 4 }, { unit: 'each', per: 12 }] })
      const survivor = row({ id: 'S', baseUnit: 'each', dimension: 'COUNT' })
      const p = plan(survivor, absorbed, { ...noRel, countLines: [
        { id: 'cl2', countedQtyBase: null, countedQty: 5, selectedUom: 'portion', entries: null },
      ] })
      if (!p.ok) throw new Error(p.message)
      expect(p.manifest.ops.some(o => o.t === 'update' && o.table === 'CountLine' && o.id === 'cl2')).toBe(false)
      expect(p.summary.countLinesUnfrozen).toBe(1)
    })

    it('divergence 3: chain [{cs,4},{bag,12}] counted in the legacy generic word "case" → 48', () => {
      const absorbed = row({ id: 'A', packChain: [{ unit: 'cs', per: 4 }, { unit: 'bag', per: 12 }] })
      const survivor = row({ id: 'S' }) // same base unit (g), a different (default) chain
      const line = { countedQtyBase: null, countedQty: 1, selectedUom: 'case', entries: null }
      const oracle = lineCountedBase(line, dimsOf(absorbed))
      expect(oracle).toBe(48)

      const p = plan(survivor, absorbed, { ...noRel, countLines: [{ id: 'cl3', ...line }] })
      if (!p.ok) throw new Error(p.message)
      const upd = p.manifest.ops.find(o => o.t === 'update' && o.table === 'CountLine' && o.id === 'cl3') as { after: Record<string, unknown> }
      expect(upd.after.countedQtyBase).toBe(oracle)
    })

    it('divergence 4: a stored unit of "Case" (capitalised) resolves exactly like "case"', () => {
      const absorbed = row({ id: 'A', packChain: [{ unit: 'cs', per: 4 }, { unit: 'bag', per: 12 }] })
      const survivor = row({ id: 'S' })
      const line = { countedQtyBase: null, countedQty: 1, selectedUom: 'Case', entries: null }
      const oracle = lineCountedBase(line, dimsOf(absorbed))
      expect(oracle).toBe(48)

      const p = plan(survivor, absorbed, { ...noRel, countLines: [{ id: 'cl4', ...line }] })
      if (!p.ok) throw new Error(p.message)
      const upd = p.manifest.ops.find(o => o.t === 'update' && o.table === 'CountLine' && o.id === 'cl4') as { after: Record<string, unknown> }
      expect(upd.after.countedQtyBase).toBe(oracle)
    })

    it('IMPORTANT Imp-3: "cs" is NOT treated as the legacy word "case" (the reader compares the raw token, not the canonical one)', () => {
      // absorbed's chain has no literal "cs" link — only the canonical mapping
      // (cs → case) would make it look resolvable, and the reader does not do that.
      const absorbed = row({ id: 'A', packChain: [{ unit: 'case', per: 1000 }] })
      const survivor = row({ id: 'S' })
      const p = plan(survivor, absorbed, { ...noRel, countLines: [
        { id: 'cl10', countedQtyBase: null, countedQty: 5, selectedUom: 'cs', entries: null },
      ] })
      if (!p.ok) throw new Error(p.message)
      expect(p.manifest.ops.some(o => o.t === 'update' && o.table === 'CountLine' && o.id === 'cl10')).toBe(false)
      expect(p.summary.countLinesUnfrozen).toBe(1)
    })

    it('entries [{case×2},{each×3}] on a single-link chain [{case,12}] is oracle-equal (27)', () => {
      const absorbed = row({ id: 'A', baseUnit: 'each', dimension: 'COUNT', packChain: [{ unit: 'case', per: 12 }] })
      const survivor = row({ id: 'S', baseUnit: 'each', dimension: 'COUNT' })
      const entries = [{ unit: 'case', qty: 2 }, { unit: 'each', qty: 3 }]
      const line = { countedQtyBase: null, countedQty: null, selectedUom: 'each', entries }
      const oracle = lineCountedBase(line, dimsOf(absorbed))
      expect(oracle).toBe(27)

      const p = plan(survivor, absorbed, { ...noRel, countLines: [{ id: 'cl5', ...line }] })
      if (!p.ok) throw new Error(p.message)
      const upd = p.manifest.ops.find(o => o.t === 'update' && o.table === 'CountLine' && o.id === 'cl5') as { before: Record<string, unknown>; after: Record<string, unknown> }
      expect(upd.after.countedQtyBase).toBe(oracle)
      expect(upd.after.countedQty).toBe(oracle) // normalised: a chain-relative unit is ambiguous on the survivor
      expect(upd.after.selectedUom).toBe('each')
      expect(upd.after.entries).toBeNull()
      expect(upd.before.entries).toEqual(entries)
    })

    it('a modern line already in a plain measured unit (kg) with countedQtyBase set needs no op', () => {
      const p = plan(S, A, { ...noRel, countLines: [
        { id: 'cl6', countedQtyBase: 750, countedQty: 750, selectedUom: 'kg', entries: null },
      ] })
      if (!p.ok) throw new Error(p.message)
      expect(p.manifest.ops.some(o => o.t === 'update' && o.table === 'CountLine' && o.id === 'cl6')).toBe(false)
      expect(p.manifest.ops).toContainEqual({ t: 'repoint', table: 'CountLine', ids: ['cl6'] })
    })

    it('a line already displayed in the item\'s own base unit needs no op even without a chain-level match', () => {
      const p = plan(S, A, { ...noRel, countLines: [
        { id: 'cl7', countedQtyBase: 12, countedQty: 12, selectedUom: 'g', entries: null },
      ] })
      if (!p.ok) throw new Error(p.message)
      expect(p.manifest.ops.some(o => o.t === 'update' && o.table === 'CountLine' && o.id === 'cl7')).toBe(false)
    })

    it('M-b: an entry with a unit the reader cannot resolve leaves the whole line unfrozen, with no op at all', () => {
      const absorbed = row({ id: 'A', baseUnit: 'each', dimension: 'COUNT' }) // default chain, no 'gal' anywhere
      const survivor = row({ id: 'S', baseUnit: 'each', dimension: 'COUNT' })
      const p = plan(survivor, absorbed, { ...noRel, countLines: [
        { id: 'cl8', countedQtyBase: null, countedQty: null, selectedUom: 'kg',
          entries: [{ unit: 'gal', qty: 2 }] }, // VOLUME — matches neither a chain level nor absorbed's COUNT dimension
      ] })
      if (!p.ok) throw new Error(p.message)
      expect(p.manifest.ops.some(o => o.t === 'update' && o.table === 'CountLine' && o.id === 'cl8')).toBe(false)
      expect(p.summary.countLinesUnfrozen).toBe(1)
    })

    it('undo restores every CountLine field exactly', () => {
      const absorbed = row({ id: 'A', baseUnit: 'each', dimension: 'COUNT', packChain: [{ unit: 'case', per: 12 }] })
      const survivor = row({ id: 'S', baseUnit: 'each', dimension: 'COUNT' })
      const entries = [{ unit: 'case', qty: 2 }, { unit: 'each', qty: 3 }]
      const p = plan(survivor, absorbed, { ...noRel, countLines: [
        { id: 'cl9', countedQtyBase: null, countedQty: null, selectedUom: 'each', entries },
      ] })
      if (!p.ok) throw new Error(p.message)
      const fwd = p.manifest.ops.find(o => o.t === 'update' && o.table === 'CountLine' && o.id === 'cl9') as { before: Record<string, unknown>; after: Record<string, unknown> }
      const undo = planUndo(p.manifest)
      const back = undo.find(o => o.t === 'update' && o.table === 'CountLine' && o.id === 'cl9') as { before: Record<string, unknown>; after: Record<string, unknown> }
      expect(back.before).toEqual(fwd.after)
      expect(back.after).toEqual(fwd.before)
      expect(back.after.entries).toEqual(entries)
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
    const p = plan(S, A, { ...noRel, scanItemIds: ['si1'] })
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
        scanItemIds: ['si1'],
        offers: [{ id: 'oA', supplierName: 'Sysco', supplierId: 's', lastUpdated: '2026-09-01', isPrimary: true }],
      },
      { ...noSRel, offers: [
        { id: 'oS', supplierName: 'Sysco', lastUpdated: '2026-08-01', isPrimary: false },
        { id: 'oKeep', supplierName: 'Keep Co', lastUpdated: '2020-01-01', isPrimary: true },
      ] })
    if (!p.ok) throw new Error(p.message)
    const undo: MergeOp[] = planUndo(p.manifest)
    expect(undo.length).toBe(p.manifest.ops.length)
    // create <-> delete swapped for the offer that was fully dropped
    expect(undo.some(o => o.t === 'create' && o.table === 'InventorySupplierPrice')).toBe(true)
  })
})
