import { describe, it, expect } from 'vitest'
import {
  remeasureFactor,
  rewriteChain,
  rewritePricing,
  rewriteCountUnit,
  planRemeasure,
  packLabel,
  priceLabel,
  type RemeasureInput,
  type RemeasurePlan,
} from '@/lib/remeasure-plan'
import { asChainItem, pricePerBaseUnit, type ChainItem, type PackLink, type Pricing } from '@/lib/item-model'

/** Relative closeness — the Global Constraints' 1e-9 price invariant. */
const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-12)

const ci = (over: Partial<ChainItem>): ChainItem => ({
  dimension: 'COUNT', baseUnit: 'each', packChain: [], pricing: { mode: 'PACK', purchasePrice: 0 }, ...over,
})

const kOf = (r: ReturnType<typeof remeasureFactor>): number => {
  if ('error' in r) throw new Error(`expected a factor, got: ${r.error}`)
  return r.k
}

const plan = (r: ReturnType<typeof planRemeasure>): RemeasurePlan => {
  if ('error' in r) throw new Error(`expected a plan, got: ${r.error}`)
  return r
}

// ─────────────────────────────────────────────────────────────────────────────
// remeasureFactor
// ─────────────────────────────────────────────────────────────────────────────

describe('remeasureFactor', () => {
  const COUNT = ci({ dimension: 'COUNT', baseUnit: 'each' })
  const MASS = ci({ dimension: 'MASS', baseUnit: 'g' })
  const VOLUME = ci({ dimension: 'VOLUME', baseUnit: 'ml' })

  it('COUNT → MASS: one piece weighs 150 g ⇒ k = 150', () => {
    expect(kOf(remeasureFactor(COUNT, { dimension: 'MASS', unit: 'g' }, { eachQty: 150, eachUnit: 'g' }))).toBe(150)
  })
  it('COUNT → VOLUME: one piece holds 250 ml ⇒ k = 250', () => {
    expect(kOf(remeasureFactor(COUNT, { dimension: 'VOLUME', unit: 'ml' }, { eachQty: 250, eachUnit: 'ml' }))).toBe(250)
  })
  it('COUNT → MASS converts the bridge unit to grams (0.5 lb ⇒ 226.796)', () => {
    expect(kOf(remeasureFactor(COUNT, { dimension: 'MASS', unit: 'lb' }, { eachQty: 0.5, eachUnit: 'lb' }))).toBeCloseTo(226.796, 9)
  })
  it('MASS → COUNT: 150 g a piece ⇒ k = 1/150', () => {
    expect(kOf(remeasureFactor(MASS, { dimension: 'COUNT', unit: 'each' }, { eachQty: 150, eachUnit: 'g' }))).toBeCloseTo(1 / 150, 15)
  })
  it('VOLUME → COUNT: 1 l a piece ⇒ k = 1/1000', () => {
    expect(kOf(remeasureFactor(VOLUME, { dimension: 'COUNT', unit: 'each' }, { eachQty: 1, eachUnit: 'l' }))).toBeCloseTo(1 / 1000, 15)
  })
  it('MASS → VOLUME: density 1.03 ⇒ k = 1/1.03', () => {
    expect(kOf(remeasureFactor(MASS, { dimension: 'VOLUME', unit: 'l' }, { densityGPerMl: 1.03 }))).toBeCloseTo(1 / 1.03, 15)
  })
  it('VOLUME → MASS: density 1.03 ⇒ k = 1.03', () => {
    expect(kOf(remeasureFactor(VOLUME, { dimension: 'MASS', unit: 'kg' }, { densityGPerMl: 1.03 }))).toBe(1.03)
  })

  it('same dimension is SAME_MEASURE, even with a different unit', () => {
    expect(remeasureFactor(MASS, { dimension: 'MASS', unit: 'lb' }, {})).toEqual({
      error: 'It is already measured by weight.', code: 'SAME_MEASURE',
    })
    expect(remeasureFactor(VOLUME, { dimension: 'VOLUME', unit: 'l' }, {})).toEqual({
      error: 'It is already measured by volume.', code: 'SAME_MEASURE',
    })
    expect(remeasureFactor(COUNT, { dimension: 'COUNT', unit: 'each' }, {})).toEqual({
      error: 'It is already measured by pieces.', code: 'SAME_MEASURE',
    })
  })

  it('NEEDS_BRIDGE when the each-measure is in the wrong dimension (COUNT → MASS with ml)', () => {
    expect(remeasureFactor(COUNT, { dimension: 'MASS', unit: 'g' }, { eachQty: 150, eachUnit: 'ml' })).toEqual({
      error: 'Tell the app how much one piece weighs first — for example 1 each = 150 g.', code: 'NEEDS_BRIDGE',
    })
  })
  it('NEEDS_BRIDGE wording for volume, and for a missing / zero quantity', () => {
    expect(remeasureFactor(COUNT, { dimension: 'VOLUME', unit: 'ml' }, {})).toEqual({
      error: 'Tell the app how much one piece holds first — for example 1 each = 150 g.', code: 'NEEDS_BRIDGE',
    })
    expect(remeasureFactor(MASS, { dimension: 'COUNT', unit: 'each' }, { eachQty: 0, eachUnit: 'g' })).toMatchObject({ code: 'NEEDS_BRIDGE' })
  })
  it('NEEDS_BRIDGE for weight ↔ volume without a density', () => {
    expect(remeasureFactor(MASS, { dimension: 'VOLUME', unit: 'ml' }, { densityGPerMl: 0 })).toEqual({
      error: 'Tell the app the density first — how many grams 1 ml weighs.', code: 'NEEDS_BRIDGE',
    })
  })
  it('the bridge in the request wins over the item’s stored one', () => {
    const stored = ci({ dimension: 'COUNT', baseUnit: 'each', eachMeasure: { qty: 100, unit: 'g' } })
    expect(kOf(remeasureFactor(stored, { dimension: 'MASS', unit: 'g' }, { eachQty: 150, eachUnit: 'g' }))).toBe(150)
    // …and the stored one is NOT a fallback: no bridge in the request ⇒ refused.
    expect(remeasureFactor(stored, { dimension: 'MASS', unit: 'g' }, {})).toMatchObject({ code: 'NEEDS_BRIDGE' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// rewriteChain
// ─────────────────────────────────────────────────────────────────────────────

describe('rewriteChain', () => {
  const L = (unit: string, per: number): PackLink => ({ unit, per })

  it('COUNT → MASS appends the each link: [{case:12}] → [{case:12},{each:150}]', () => {
    expect(rewriteChain([L('case', 12)], 'COUNT', { dimension: 'MASS', unit: 'g' }, 150)).toEqual([L('case', 12), L('each', 150)])
  })
  it('COUNT → MASS rescales an innermost each: [{each:1}] → [{each:150}]', () => {
    expect(rewriteChain([L('each', 1)], 'COUNT', { dimension: 'MASS', unit: 'g' }, 150)).toEqual([L('each', 150)])
  })
  it('COUNT → MASS on an empty chain: [] → [{each:150}]', () => {
    expect(rewriteChain([], 'COUNT', { dimension: 'MASS', unit: 'g' }, 150)).toEqual([L('each', 150)])
  })
  it('MASS → COUNT keeps containers: [{case:72},{each:74}] k=1/74 → [{case:72},{each:1}]', () => {
    expect(rewriteChain([L('case', 72), L('each', 74)], 'MASS', { dimension: 'COUNT', unit: 'each' }, 1 / 74)).toEqual([L('case', 72), L('each', 1)])
  })
  it('MASS → COUNT collapses the measure link: [{case:4},{lb:453.6}] k=1/150 → [{case:12.096}]', () => {
    expect(rewriteChain([L('case', 4), L('lb', 453.6)], 'MASS', { dimension: 'COUNT', unit: 'each' }, 1 / 150)).toEqual([L('case', 12.096)])
  })
  it('MASS → VOLUME d=1.03: [{case:4},{lb:453.6}] → [{case:1761.553398}]', () => {
    expect(rewriteChain([L('case', 4), L('lb', 453.6)], 'MASS', { dimension: 'VOLUME', unit: 'l' }, 1 / 1.03)).toEqual([L('case', 1761.553398)])
  })
  it('MASS → VOLUME with no container: [{lb:453.6}] → [{l:1000}]', () => {
    expect(rewriteChain([L('lb', 453.6)], 'MASS', { dimension: 'VOLUME', unit: 'l' }, 1 / 1.03)).toEqual([L('l', 1000)])
  })
  it('MASS → COUNT with no container: [{kg:1000}] → [{each:1}]', () => {
    expect(rewriteChain([L('kg', 1000)], 'MASS', { dimension: 'COUNT', unit: 'each' }, 1 / 150)).toEqual([L('each', 1)])
  })
  it('a count-measure link is a container: kept, with the piece link under it (eggs: case of 15 dozen)', () => {
    expect(rewriteChain([L('case', 15), L('dozen', 12)], 'COUNT', { dimension: 'MASS', unit: 'g' }, 50)).toEqual([L('case', 15), L('dozen', 12), L('each', 50)])
  })
  it('a lone dozen is kept: [{dozen:12}] COUNT → MASS 50 g → [{dozen:12},{each:50}]', () => {
    expect(rewriteChain([L('dozen', 12)], 'COUNT', { dimension: 'MASS', unit: 'g' }, 50)).toEqual([L('dozen', 12), L('each', 50)])
  })
  it('a pair is a container too', () => {
    expect(rewriteChain([L('case', 10), L('pair', 2)], 'COUNT', { dimension: 'MASS', unit: 'g' }, 80)).toEqual([L('case', 10), L('pair', 2), L('each', 80)])
  })
  it('a per below 1 keeps full precision (1 each = 0.001 oz ⇒ 0.0283495 g, not 0.02835)', () => {
    const out = rewriteChain([L('case', 12)], 'COUNT', { dimension: 'MASS', unit: 'g' }, 0.0283495)
    expect(out).toEqual([L('case', 12), L('each', 0.0283495)])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// rewritePricing
// ─────────────────────────────────────────────────────────────────────────────

describe('rewritePricing', () => {
  it('PACK stays PACK, same $, and $/base × k is unchanged ($40 / case of 12, COUNT → MASS, k=150)', () => {
    const before = ci({ dimension: 'COUNT', baseUnit: 'each', packChain: [{ unit: 'case', per: 12 }], pricing: { mode: 'PACK', purchasePrice: 40 } })
    const to = { dimension: 'MASS' as const, unit: 'g' }
    const chain = rewriteChain(before.packChain, 'COUNT', to, 150)
    const pricing = rewritePricing(before, chain, to, 150)
    expect(pricing).toEqual({ mode: 'PACK', purchasePrice: 40 })
    const after = ci({ dimension: 'MASS', baseUnit: 'g', packChain: chain, pricing })
    expect(rel(pricePerBaseUnit(after) * 150, pricePerBaseUnit(before))).toBeLessThan(1e-9)
  })

  it('RATE $2/each → $/lb at 150 g a piece = 2 / 150 × 453.592 ≈ 6.0479', () => {
    const before = ci({ dimension: 'COUNT', baseUnit: 'each', packChain: [{ unit: 'each', per: 1 }], pricing: { mode: 'RATE', rate: 2, rateUnit: 'each' } })
    const to = { dimension: 'MASS' as const, unit: 'lb' }
    const chain = rewriteChain(before.packChain, 'COUNT', to, 150)
    const pricing = rewritePricing(before, chain, to, 150)
    expect(pricing.mode).toBe('RATE')
    if (pricing.mode !== 'RATE') return
    expect(pricing.rateUnit).toBe('lb')
    expect(pricing.rate).toBeCloseTo(6.0479, 4)
    const after = ci({ dimension: 'MASS', baseUnit: 'g', packChain: chain, pricing })
    expect(rel(pricePerBaseUnit(after) * 150, pricePerBaseUnit(before))).toBeLessThan(1e-9)
  })

  it('a collapsed chain becomes RATE in the new unit: [{lb:453.6}] $3/lb MASS → VOLUME d=1.03 to l', () => {
    const before = ci({ dimension: 'MASS', baseUnit: 'g', packChain: [{ unit: 'lb', per: 453.6 }], pricing: { mode: 'RATE', rate: 3, rateUnit: 'lb' } })
    const to = { dimension: 'VOLUME' as const, unit: 'l' }
    const k = 1 / 1.03
    const chain = rewriteChain(before.packChain, 'MASS', to, k)
    const pricing = rewritePricing(before, chain, to, k)
    expect(pricing).toMatchObject({ mode: 'RATE', rateUnit: 'l' })
    const after = ci({ dimension: 'VOLUME', baseUnit: 'ml', packChain: chain, pricing })
    expect(rel(pricePerBaseUnit(after) * k, pricePerBaseUnit(before))).toBeLessThan(1e-9)
  })

  it('a collapsed PACK chain also becomes RATE — the pack no longer exists', () => {
    const before = ci({ dimension: 'MASS', baseUnit: 'g', packChain: [{ unit: 'kg', per: 1000 }], pricing: { mode: 'PACK', purchasePrice: 12 } })
    const to = { dimension: 'COUNT' as const, unit: 'each' }
    const k = 1 / 150
    const chain = rewriteChain(before.packChain, 'MASS', to, k)
    const pricing = rewritePricing(before, chain, to, k)
    expect(pricing).toMatchObject({ mode: 'RATE', rateUnit: 'each' })
    if (pricing.mode === 'RATE') expect(pricing.rate).toBeCloseTo(1.8, 9)   // $12/kg × 150 g
    const after = ci({ dimension: 'COUNT', baseUnit: 'each', packChain: chain, pricing })
    expect(rel(pricePerBaseUnit(after) * k, pricePerBaseUnit(before))).toBeLessThan(1e-9)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// rewriteCountUnit
// ─────────────────────────────────────────────────────────────────────────────

describe('rewriteCountUnit', () => {
  it('keeps a count unit that still names a link of the new chain', () => {
    expect(rewriteCountUnit('case', [{ unit: 'case', per: 12 }, { unit: 'each', per: 150 }], { dimension: 'MASS', unit: 'g' })).toBe('case')
  })
  it('keeps `each` on a MASS chain that has an each link', () => {
    expect(rewriteCountUnit('each', [{ unit: 'case', per: 72 }, { unit: 'each', per: 74 }], { dimension: 'MASS', unit: 'g' })).toBe('each')
  })
  it('keeps a unit of the new dimension', () => {
    expect(rewriteCountUnit('kg', [{ unit: 'case', per: 1800 }], { dimension: 'MASS', unit: 'g' })).toBe('kg')
  })
  it('`lb` on a COUNT target → each', () => {
    expect(rewriteCountUnit('lb', [{ unit: 'case', per: 12.096 }], { dimension: 'COUNT', unit: 'each' })).toBe('each')
  })
  it('a spelling of a chain link resolves to the link’s own spelling (cs → case)', () => {
    expect(rewriteCountUnit('cs', [{ unit: 'case', per: 12 }, { unit: 'each', per: 150 }], { dimension: 'MASS', unit: 'g' })).toBe('case')
  })
  it('no count unit → the target unit', () => {
    expect(rewriteCountUnit(null, [{ unit: 'each', per: 150 }], { dimension: 'MASS', unit: 'g' })).toBe('g')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// labels
// ─────────────────────────────────────────────────────────────────────────────

describe('labels', () => {
  it('priceLabel: PACK per its top unit, RATE per its rate unit, 2 dp', () => {
    expect(priceLabel(ci({ packChain: [{ unit: 'case', per: 12 }], pricing: { mode: 'PACK', purchasePrice: 40 } }))).toBe('$40.00 per case')
    expect(priceLabel(ci({ dimension: 'MASS', baseUnit: 'g', packChain: [{ unit: 'lb', per: 453.592 }], pricing: { mode: 'RATE', rate: 6.0479, rateUnit: 'lb' } }))).toBe('$6.05 per lb')
  })
  it('packLabel reads through formatPurchaseDisplay', () => {
    expect(packLabel(ci({ dimension: 'MASS', baseUnit: 'g', packChain: [{ unit: 'case', per: 12 }, { unit: 'each', per: 150 }] }))).toBe('case (12 × 150g)')
    expect(packLabel(ci({ packChain: [{ unit: 'case', per: 12 }] }))).toBe('case (12 each)')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// planRemeasure — end to end
// ─────────────────────────────────────────────────────────────────────────────

/** A COUNT item bought by the case of 12 at $40, being re-measured by weight
 *  (one piece = 150 g). Sysco is the main box (same chain); Snow Cap sells a 6. */
function fixture(): RemeasureInput {
  return {
    item: {
      id: 'item-1', itemName: 'Burrata', isStocked: true,
      dimension: 'COUNT', baseUnit: 'each', countUnit: 'case',
      packChain: [{ unit: 'case', per: 12 }],
      pricing: { mode: 'PACK', purchasePrice: 40 },
      stockOnHand: 60, lastCountQty: 60,
    },
    to: { dimension: 'MASS', unit: 'g' },
    bridge: { eachQty: 150, eachUnit: 'g' },
    boxes: [
      { id: 'box-sysco', supplierId: 'sup-sysco', supplierItemCode: null, supplierName: 'Sysco', isPrimary: true, packChain: [{ unit: 'case', per: 12 }], pricing: { mode: 'PACK', purchasePrice: 40 }, packQty: 12, packSize: 1, packUOM: 'each' },
      { id: 'box-snow', supplierId: 'sup-snow', supplierItemCode: null, supplierName: 'Snow Cap', isPrimary: false, packChain: [{ unit: 'case', per: 6 }], pricing: { mode: 'PACK', purchasePrice: 22 }, packQty: 6, packSize: 1, packUOM: 'each' },
    ],
    receipts: [
      // Per-case line: 2 cases of 12 each, frozen at 24 each.
      { id: 'r-case', rawQty: 2, rawUnit: 'cs', invoicePackQty: 12, invoicePackSize: 1, invoicePackUOM: 'each', rawUnitPrice: 40, rawLineTotal: 80, receivedQtyBase: 24 },
      // Per-lb line: 10 lb billed at $6.05/lb, frozen at 10 — "10 each", wrong.
      { id: 'r-lb', rawQty: 1, rawUnit: 'cs', totalQty: 10, totalQtyUOM: 'lb', rateUOM: 'lb', rate: 6.05, rawUnitPrice: 60.5, rawLineTotal: 60.5, receivedQtyBase: 10 },
    ],
    counts: [
      { id: 'c-case', countedQty: 3, selectedUom: 'case', countedQtyBase: 36, expectedQty: 30, priceAtCount: 40 / 12,
        snapshot: { id: 'snap-1', qtyOnHand: 36, unit: 'each', pricePerBaseUnit: 40 / 12, totalValue: 120 } },
      // Entered in lb on a COUNT item: unresolvable then, resolvable under MASS.
      { id: 'c-lb', countedQty: 5, selectedUom: 'lb', countedQtyBase: 5, expectedQty: 4, priceAtCount: 40 / 12 },
    ],
    allocations: [],
    sessions: [
      { id: 'sess-1', totalCountedValue: 170, snapshots: [
        { id: 'snap-1', source: 'COUNTED', totalValue: 120 },
        { id: 'snap-other', source: 'COUNTED', totalValue: 50 },
      ] },
    ],
    transfers: [{ id: 't-1', quantity: 12 }],
    recipeLines: 4,
    wastageRows: 2,
  }
}

describe('planRemeasure — COUNT → MASS end to end', () => {
  const p = plan(planRemeasure(fixture()))
  const before = asChainItem(fixture().item)

  it('k = 150 and the item gains the each link + the bridge', () => {
    expect(p.k).toBe(150)
    expect(p.item.after.dimension).toBe('MASS')
    expect(p.item.after.baseUnit).toBe('g')
    expect(p.item.after.packChain).toEqual([{ unit: 'case', per: 12 }, { unit: 'each', per: 150 }])
    expect(p.item.after.pricing).toEqual({ mode: 'PACK', purchasePrice: 40 })
    expect(p.item.after.countUnit).toBe('case')
    expect(p.item.eachMeasure).toEqual({ qty: 150, unit: 'g' })
    expect(p.item.after.eachMeasure).toEqual({ qty: 150, unit: 'g' })
    expect(p.errors).toEqual([])
  })

  it('price invariant: $/base × k unchanged for the item and every box', () => {
    expect(rel(pricePerBaseUnit(p.item.after) * p.k, pricePerBaseUnit(before))).toBeLessThan(1e-9)
    for (const b of p.boxes) {
      const src = fixture().boxes.find((x) => x.id === b.id)!
      const old = pricePerBaseUnit({ ...before, packChain: src.packChain as PackLink[], pricing: src.pricing as Pricing })
      const now = pricePerBaseUnit({ ...p.item.after, packChain: b.packChain, pricing: b.pricing })
      expect(rel(now * p.k, old)).toBeLessThan(1e-9)
    }
  })

  it('boxes keep their containers; the main box IS the item', () => {
    const sysco = p.boxes.find((b) => b.id === 'box-sysco')!
    const snow = p.boxes.find((b) => b.id === 'box-snow')!
    expect(sysco.packChain).toEqual([{ unit: 'case', per: 12 }, { unit: 'each', per: 150 }])
    expect(sysco.pricing).toEqual({ mode: 'PACK', purchasePrice: 40 })
    expect(snow.packChain).toEqual([{ unit: 'case', per: 6 }, { unit: 'each', per: 150 }])
    expect(snow.pricing).toEqual({ mode: 'PACK', purchasePrice: 22 })
    expect(p.item.after.packChain).toEqual(sysco.packChain)
    expect(p.item.after.pricing).toEqual(sysco.pricing)
    expect(sysco.before).toEqual({ packChain: [{ unit: 'case', per: 12 }], pricing: { mode: 'PACK', purchasePrice: 40 }, packQty: 12, packSize: 1, packUOM: 'each' })
  })

  it('a receipt the old measure could read is converted by the factor; one it could not is re-read', () => {
    const rCase = p.receipts.find((r) => r.id === 'r-case')!
    const rLb = p.receipts.find((r) => r.id === 'r-lb')!
    expect(rCase.next).toBeCloseTo(3600, 9)
    expect(rCase).toMatchObject({ via: 'converted', how: 'converted', scaled: false })
    // 10 lb billed on a pieces item with no bridge: unreadable then, a weight now.
    expect(rLb.next).toBeCloseTo(4535.92, 9)
    expect(rLb).toMatchObject({ via: 'billed-weight', how: 'reread', scaled: false })
  })

  it('a count the old measure could read is converted; "5 lb" on a pieces item is re-read from what was typed', () => {
    const cCase = p.counts.find((c) => c.id === 'c-case')!
    const cLb = p.counts.find((c) => c.id === 'c-lb')!
    expect(cCase.next).toBeCloseTo(5400, 9)
    expect(cCase).toMatchObject({ via: 'converted', how: 'converted', scaled: false })
    expect(cCase.snapshot).toMatchObject({ id: 'snap-1', unit: 'g' })
    expect(cCase.snapshot!.qtyOnHand).toBeCloseTo(5400, 9)
    expect(cCase.snapshot!.totalValue).toBe(120)                      // the stored value, untouched
    expect(cCase.snapshot!.pricePerBaseUnit).toBeCloseTo(40 / 12 / 150, 15)
    expect(cCase.priceAtCount).toBeCloseTo(40 / 12 / 150, 15)
    expect(cLb.priceAtCount).toBeCloseTo(40 / 12 / 150, 15)
    expect(cLb.next).toBeCloseTo(2267.96, 9)
    expect(cLb).toMatchObject({ how: 'reread', scaled: false, needsDecision: false })
  })

  it('every count line\'s expected quantity converts by the factor', () => {
    expect(p.counts.find((c) => c.id === 'c-case')!.expectedQty).toEqual({ old: 30, next: 4500 })
    expect(p.counts.find((c) => c.id === 'c-lb')!.expectedQty).toEqual({ old: 4, next: 600 })
  })

  it('stock baselines are converted by the factor — never re-derived from a count', () => {
    expect(p.stock.stockOnHand).toMatchObject({ old: 60, next: 9000, via: 'converted' })
    expect(p.stock.lastCountQty).toMatchObject({ old: 60, next: 9000, via: 'converted' })
  })

  it('session totals do not move — a remeasure changes the base, not the price history', () => {
    expect(p.sessions).toHaveLength(1)
    expect(p.sessions[0].sessionId).toBe('sess-1')
    expect(p.sessions[0].next).toBe(170)
    expect(p.sessions[0].next).toBe(p.sessions[0].old)
  })

  it('transfers scale by k', () => {
    expect(p.transfers).toEqual([{ id: 't-1', old: 12, next: 1800 }])
  })

  it('summary', () => {
    expect(p.summary.from).toMatchObject({ dimension: 'COUNT', unit: 'each', countUnit: 'case', priceLabel: '$40.00 per case', packLabel: 'case (12 each)' })
    expect(p.summary.to).toMatchObject({ dimension: 'MASS', unit: 'g', countUnit: 'case', priceLabel: '$40.00 per case', packLabel: 'case (12 × 150g)' })
    expect(p.summary.boxes).toEqual([
      { supplierName: 'Sysco', isPrimary: true, before: 'case (12 each) · $40.00 per case', after: 'case (12 × 150g) · $40.00 per case' },
      { supplierName: 'Snow Cap', isPrimary: false, before: 'case (6 each) · $22.00 per case', after: 'case (6 × 150g) · $22.00 per case' },
    ])
    expect(p.summary.counts).toEqual({ n: 2, converted: 1, reread: 1, scaled: 0 })
    expect(p.summary.receipts).toEqual({ n: 2, converted: 1, reread: 1, scaled: 0 })
    expect(p.summary.transfers).toBe(1)
    expect(p.summary.recipes).toBe(4)
    expect(p.summary.wastage).toBe(2)
    expect(p.summary.warnings).toEqual([])
  })
})

describe('planRemeasure — rows neither measure can read are scaled and said', () => {
  it('a count entered in a third dimension is scaled old × k, with the warning', () => {
    const input = fixture()
    // "2 l" of a COUNT item going to weight: nothing bridges litres to grams.
    input.counts.push({ id: 'c-l', countedQty: 2, selectedUom: 'l', entries: [{ unit: 'l', qty: 2 }], countedQtyBase: 2 })
    const p = plan(planRemeasure(input))
    const row = p.counts.find((c) => c.id === 'c-l')!
    expect(row).toMatchObject({ scaled: true, how: 'scaled', via: 'scaled', needsDecision: false, next: 300 })
    expect(p.summary.counts).toEqual({ n: 3, converted: 1, reread: 1, scaled: 1 })
    expect(p.summary.warnings).toContain('1 count could not be read in either measure and was scaled by the factor.')
  })

  it('a receipt with nothing to read is scaled old × k, with the warning', () => {
    const input = fixture()
    input.receipts.push({ id: 'r-none', rawQty: 0, receivedQtyBase: 6 })
    const p = plan(planRemeasure(input))
    const row = p.receipts.find((r) => r.id === 'r-none')!
    expect(row).toMatchObject({ old: 6, next: 900, via: 'scaled', how: 'scaled', scaled: true })
    expect(p.summary.receipts).toEqual({ n: 3, converted: 1, reread: 1, scaled: 1 })
    expect(p.summary.warnings).toContain('1 delivery could not be read in either measure and was scaled by the factor.')
  })

  it('plural warnings', () => {
    const input = fixture()
    input.receipts.push({ id: 'r-n1', rawQty: 0, receivedQtyBase: 6 }, { id: 'r-n2', rawQty: 0, receivedQtyBase: 2 })
    input.counts.push(
      { id: 'c-l1', countedQty: 2, selectedUom: 'l', countedQtyBase: 2 },
      { id: 'c-l2', countedQty: 1, selectedUom: 'l', countedQtyBase: 1 },
    )
    const p = plan(planRemeasure(input))
    expect(p.summary.warnings).toEqual([
      '2 counts could not be read in either measure and were scaled by the factor.',
      '2 deliveries could not be read in either measure and were scaled by the factor.',
    ])
  })

  it('a converted count\'s value converts on its own number, even when it does not match its line — no warning', () => {
    const input = fixture()
    input.counts[0].snapshot = { id: 'snap-1', qtyOnHand: 99, unit: 'each', pricePerBaseUnit: 40 / 12, totalValue: 330 }
    const p = plan(planRemeasure(input))
    expect(p.counts[0].snapshot).toMatchObject({ id: 'snap-1', qtyOnHand: 14850, unit: 'g', totalValue: 330 })
    expect(p.counts[0].snapshotMismatch).toBeFalsy()
    expect(p.summary.warnings).toEqual([])
  })

  it('a re-read count whose value no longer matches it: the value is converted by the factor, and said', () => {
    const input = fixture()
    input.counts[1].snapshot = { id: 'snap-lb', qtyOnHand: 7, unit: 'each', pricePerBaseUnit: 40 / 12, totalValue: 23.33 }
    const p = plan(planRemeasure(input))
    const row = p.counts.find((c) => c.id === 'c-lb')!
    expect(row.next).toBeCloseTo(2267.96, 9)                // the line is re-read…
    expect(row.snapshot).toMatchObject({ qtyOnHand: 1050, unit: 'g', totalValue: 23.33 })   // …its value only converted
    expect(row.snapshotMismatch).toBe(true)
    expect(p.summary.warnings).toContain('1 count value no longer matches its count and was converted by the factor.')
    expect(p.summary.warnings.join(' ')).not.toMatch(/snapshot/i)
  })

  it('stock, last count and every allocation convert by the factor, with no warning', () => {
    const input = fixture()
    input.allocations = [
      { revenueCenterId: 'rc-bar', quantity: 4 },
      { revenueCenterId: 'rc-kitchen', quantity: '2' },
      { revenueCenterId: 'rc-empty', quantity: 0 },
    ]
    const p = plan(planRemeasure(input))
    expect(p.stock.stockOnHand).toMatchObject({ old: 60, next: 9000, via: 'converted' })
    expect(p.stock.lastCountQty).toMatchObject({ old: 60, next: 9000, via: 'converted' })
    expect(p.stock.allocations).toEqual([
      { revenueCenterId: 'rc-bar', old: 4, next: 600, via: 'converted' },
      { revenueCenterId: 'rc-kitchen', old: 2, next: 300, via: 'converted' },
      { revenueCenterId: 'rc-empty', old: 0, next: 0, via: 'converted' },
    ])
    expect(p.summary.warnings).toEqual([])
  })

  it('an orphan clone receipt is scaled old × k and counted as scaled', () => {
    const input = fixture()
    input.receipts.push({ id: 'r-orphan', parentLineId: 'gone', rawQty: 1, rawUnit: 'cs', rawLineTotal: 10, receivedQtyBase: 6 })
    const p = plan(planRemeasure(input))
    expect(p.receipts.find((r) => r.id === 'r-orphan')).toMatchObject({ old: 6, next: 900, via: 'scaled', scaled: true })
    expect(p.summary.receipts).toEqual({ n: 3, converted: 1, reread: 1, scaled: 1 })
  })

  it('a clone of a scaled parent is scaled old × k too', () => {
    const input = fixture()
    input.receipts.push(
      { id: 'r-none', rawQty: 0, rawLineTotal: 30, receivedQtyBase: 6 },
      { id: 'r-none-clone', parentLineId: 'r-none', rawQty: 0, rawLineTotal: 15, receivedQtyBase: 3 },
    )
    const p = plan(planRemeasure(input))
    expect(p.receipts.find((r) => r.id === 'r-none-clone')).toMatchObject({ old: 3, next: 450, how: 'scaled', scaled: true })
  })

  it('a clone of a converted parent is converted old × k; a clone of a re-read parent is its share of the re-read', () => {
    const input = fixture()
    input.receipts.push(
      { id: 'r-case-clone', parentLineId: 'r-case', rawQty: 1, rawUnit: 'cs', rawLineTotal: 40, receivedQtyBase: 13 },
      { id: 'r-lb-clone', parentLineId: 'r-lb', rawQty: 1, rawUnit: 'cs', rawLineTotal: 30.25, receivedQtyBase: 5 },
    )
    const p = plan(planRemeasure(input))
    expect(p.receipts.find((r) => r.id === 'r-case-clone')).toMatchObject({ old: 13, next: 1950, how: 'converted', scaled: false })
    const lbClone = p.receipts.find((r) => r.id === 'r-lb-clone')!
    expect(lbClone.how).toBe('reread')
    expect(lbClone.next).toBeCloseTo(4535.92 / 2, 9)
  })

  it('a skipped / theoretical snapshot scales its expected quantity and its $/base, keeping its value', () => {
    const input = fixture()
    input.counts.push({
      id: 'c-skip', countedQty: null, selectedUom: 'case', skipped: true, countedQtyBase: null, priceAtCount: 40 / 12,
      snapshot: { id: 'snap-skip', qtyOnHand: 24, unit: 'each', pricePerBaseUnit: 40 / 12, totalValue: 80 },
    })
    const p = plan(planRemeasure(input))
    const row = p.counts.find((c) => c.id === 'c-skip')!
    expect(row.snapshot).toBeUndefined()
    expect(row.snapshotUnitOnly).toMatchObject({ id: 'snap-skip', unit: 'g', from: 'each', qtyOnHand: 3600 })
    expect(row.snapshotUnitOnly!.pricePerBaseUnit).toBeCloseTo(40 / 12 / 150, 15)
    expect(row.priceAtCount).toBeCloseTo(40 / 12 / 150, 15)
    expect(p.summary.counts).toEqual({ n: 3, converted: 2, reread: 1, scaled: 0 })
  })

  it('a skipped line holds its expected quantity in the base unit — both frozen numbers convert, and its unit follows', () => {
    const input = fixture()
    // lines/[lineId] route: skipped → countedQty = countedQtyBase = expectedQty (base).
    input.counts.push({ id: 'c-skip', countedQty: 24, selectedUom: 'each', skipped: true, countedQtyBase: 24, expectedQty: 24, priceAtCount: 40 / 12 })
    const p = plan(planRemeasure(input))
    const row = p.counts.find((c) => c.id === 'c-skip')!
    expect(row).toMatchObject({ old: 24, next: 3600, how: 'converted' })
    expect(row.countedQty).toEqual({ old: 24, next: 3600 })
    expect(row.selectedUom).toEqual({ old: 'each', next: 'g' })
    expect(row.expectedQty).toEqual({ old: 24, next: 3600 })
  })

  it('a skipped line in a unit other than the base keeps its typed quantity', () => {
    const input = fixture()
    input.counts.push({ id: 'c-skip', countedQty: 2, selectedUom: 'case', skipped: true, countedQtyBase: 24, priceAtCount: 40 / 12 })
    const p = plan(planRemeasure(input))
    const row = p.counts.find((c) => c.id === 'c-skip')!
    expect(row.next).toBe(3600)
    expect(row.countedQty).toBeUndefined()
    expect(row.selectedUom).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Final review — a pack that changed since must not rewrite correct history
// ─────────────────────────────────────────────────────────────────────────────

describe('planRemeasure — the box changed since the row was frozen', () => {
  /** Today Sysco's case holds 10. The count "3 case" was frozen at 36 and the
   *  delivery "2 cs" at 24 — when the case held 12. Both are exact history. */
  const changedPack = (): RemeasureInput => {
    const input = fixture()
    input.item.packChain = [{ unit: 'case', per: 10 }]
    input.item.stockOnHand = 36
    input.item.lastCountQty = 36
    input.boxes = [
      { id: 'box-sysco', supplierId: 'sup-sysco', supplierItemCode: null, supplierName: 'Sysco', isPrimary: true,
        packChain: [{ unit: 'case', per: 10 }], pricing: { mode: 'PACK', purchasePrice: 40 } },
    ]
    input.receipts = [
      { id: 'r-2cs', rawQty: 2, rawUnit: 'cs', rawUnitPrice: 48, rawLineTotal: 96, receivedQtyBase: 24,
        supplierId: 'sup-sysco', supplierName: 'Sysco', canonicalName: 'Sysco' },
    ]
    input.counts = [
      { id: 'c-3cs', countedQty: 3, selectedUom: 'case', countedQtyBase: 36, priceAtCount: 4,
        snapshot: { id: 'snap-3cs', qtyOnHand: 36, unit: 'each', pricePerBaseUnit: 4, totalValue: 144 } },
    ]
    input.sessions = [{ id: 'sess', totalCountedValue: 144, snapshots: [{ id: 'snap-3cs', source: 'COUNTED', totalValue: 144 }] }]
    return input
  }
  const p = plan(planRemeasure(changedPack()))

  it('the count stays 36 pieces = 5,400 g, not 30 pieces = 4,500 g', () => {
    const c = p.counts[0]
    expect(c.next).toBeCloseTo(5400, 9)
    expect(c.how).toBe('converted')
    expect(c.snapshot!.qtyOnHand).toBeCloseTo(5400, 9)
    expect(c.snapshot!.totalValue).toBe(144)
  })

  it('the delivery stays 24 pieces = 3,600 g, not 20 pieces = 3,000 g', () => {
    expect(p.receipts[0].next).toBeCloseTo(3600, 9)
    expect(p.receipts[0].how).toBe('converted')
  })

  it('stock follows: 36 pieces = 5,400 g', () => {
    expect(p.stock.stockOnHand.next).toBeCloseTo(5400, 9)
    expect(p.stock.lastCountQty.next).toBeCloseTo(5400, 9)
  })

  it('nothing is called scaled', () => {
    expect(p.summary.counts).toEqual({ n: 1, converted: 1, reread: 0, scaled: 0 })
    expect(p.summary.receipts).toEqual({ n: 1, converted: 1, reread: 0, scaled: 0 })
    expect(p.summary.warnings).toEqual([])
  })
})

describe('planRemeasure — count values with no line of their own', () => {
  it('a second value on one count (after a merge) is converted too', () => {
    const input = fixture()
    input.straySnapshots = [{ id: 'snap-dup', qtyOnHand: 12, unit: 'each', pricePerBaseUnit: 40 / 12, totalValue: 40 }]
    const p = plan(planRemeasure(input))
    expect(p.strays).toHaveLength(1)
    expect(p.strays[0]).toMatchObject({ id: 'snap-dup', qtyOnHand: 1800, unit: 'g' })
    expect(p.strays[0].pricePerBaseUnit).toBeCloseTo(40 / 12 / 150, 15)
  })
})

describe('planRemeasure — refusals', () => {
  it('passes the factor error through', () => {
    const input = fixture()
    input.to = { dimension: 'COUNT', unit: 'each' }
    expect(planRemeasure(input)).toEqual({ error: 'It is already measured by pieces.', code: 'SAME_MEASURE' })
    const input2 = fixture()
    input2.bridge = {}
    expect(planRemeasure(input2)).toMatchObject({ code: 'NEEDS_BRIDGE' })
  })

  it('an unpriced stocked item reports INVALID errors', () => {
    const input = fixture()
    input.item.pricing = { mode: 'PACK', purchasePrice: 0 }
    input.boxes = []
    const p = plan(planRemeasure(input))
    expect(p.errors).toContain('price must be above $0')
  })

  it('a box error is prefixed with its supplier', () => {
    const input = fixture()
    input.boxes[1].pricing = { mode: 'PACK', purchasePrice: 0 }
    const p = plan(planRemeasure(input))
    expect(p.errors).toContain('Snow Cap: price must be above $0')
  })
})

describe('planRemeasure — MASS → VOLUME keeps the each-measure, takes the density', () => {
  it('density stored; bridge passes through; collapsed RATE', () => {
    const input = fixture()
    input.item = {
      id: 'oil', itemName: 'Canola oil', isStocked: true,
      dimension: 'MASS', baseUnit: 'g', countUnit: 'lb',
      packChain: [{ unit: 'lb', per: 453.592 }],
      pricing: { mode: 'RATE', rate: 3, rateUnit: 'lb' },
      eachMeasureQty: 900, eachMeasureUnit: 'g',
      stockOnHand: 0, lastCountQty: 0,
    }
    input.to = { dimension: 'VOLUME', unit: 'l' }
    input.bridge = { densityGPerMl: 0.92 }
    input.boxes = []
    input.receipts = []
    input.counts = []
    input.sessions = []
    input.transfers = []
    const p = plan(planRemeasure(input))
    expect(p.k).toBeCloseTo(1 / 0.92, 15)
    expect(p.item.after.packChain).toEqual([{ unit: 'l', per: 1000 }])
    expect(p.item.after.pricing).toMatchObject({ mode: 'RATE', rateUnit: 'l' })
    expect(p.item.after.countUnit).toBe('l')
    expect(p.item.densityGPerMl).toBe(0.92)
    expect(p.item.eachMeasure).toEqual({ qty: 900, unit: 'g' })
    const before = asChainItem(input.item)
    expect(rel(pricePerBaseUnit(p.item.after) * p.k, pricePerBaseUnit(before))).toBeLessThan(1e-9)
    expect(p.errors).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Fix wave — receipts through each supplier's box
// ─────────────────────────────────────────────────────────────────────────────

describe('planRemeasure — receipts re-derive through the SUPPLIER’s own box', () => {
  const withSnowCap = () => {
    const input = fixture()
    input.receipts.push(
      // Snow Cap: 2 cases of THEIR 6, frozen 12 each. No pack printed on the line.
      { id: 'r-snow', rawQty: 2, rawUnit: 'cs', rawUnitPrice: 22, rawLineTotal: 44, receivedQtyBase: 12,
        supplierId: 'sup-snow', supplierName: 'Snow Cap', canonicalName: 'Snow Cap' },
      // Its RC split clone: carries no supplier fields of its own — it follows its parent.
      { id: 'r-snow-clone', parentLineId: 'r-snow', rawQty: 1, rawUnit: 'cs', rawLineTotal: 22, receivedQtyBase: 6 },
      // A line with no supplier at all reads through the item (= the main box).
      { id: 'r-bare', rawQty: 2, rawUnit: 'cs', rawUnitPrice: 40, rawLineTotal: 80, receivedQtyBase: 24 },
    )
    return input
  }

  it('Snow Cap 2 × 6 frozen 12 → 1800 g (not 3600 through the main box)', () => {
    const p = plan(planRemeasure(withSnowCap()))
    const row = p.receipts.find((r) => r.id === 'r-snow')!
    expect(row.next).toBeCloseTo(1800, 9)
    expect(row.scaled).toBe(false)
  })

  it('a clone stays with its parent’s box: half of 1800', () => {
    const p = plan(planRemeasure(withSnowCap()))
    expect(p.receipts.find((r) => r.id === 'r-snow-clone')!.next).toBeCloseTo(900, 9)
  })

  it('a line with no supplier fields falls back to the corrected item', () => {
    const p = plan(planRemeasure(withSnowCap()))
    expect(p.receipts.find((r) => r.id === 'r-bare')!.next).toBeCloseTo(3600, 9)
  })

  it('rows come back in input order', () => {
    const p = plan(planRemeasure(withSnowCap()))
    expect(p.receipts.map((r) => r.id)).toEqual(['r-case', 'r-lb', 'r-snow', 'r-snow-clone', 'r-bare'])
  })

  it('the SKU picks among one supplier’s several boxes', () => {
    const input = fixture()
    input.boxes.push({ id: 'box-snow-big', supplierId: 'sup-snow', supplierItemCode: 'SC-24', supplierName: 'Snow Cap', isPrimary: false,
      packChain: [{ unit: 'case', per: 24 }], pricing: { mode: 'PACK', purchasePrice: 80 } })
    input.boxes[1] = { ...input.boxes[1], supplierItemCode: 'SC-6' }
    input.receipts = [
      { id: 'r-6', rawQty: 1, rawUnit: 'cs', rawLineTotal: 22, receivedQtyBase: 6, supplierId: 'sup-snow', supplierName: 'Snow Cap', canonicalName: 'Snow Cap', supplierItemCode: 'SC-6' },
      { id: 'r-24', rawQty: 1, rawUnit: 'cs', rawLineTotal: 80, receivedQtyBase: 24, supplierId: 'sup-snow', supplierName: 'Snow Cap', canonicalName: 'Snow Cap', supplierItemCode: 'sc-24' },
    ]
    const p = plan(planRemeasure(input))
    expect(p.receipts.find((r) => r.id === 'r-6')!.next).toBeCloseTo(900, 9)
    expect(p.receipts.find((r) => r.id === 'r-24')!.next).toBeCloseTo(3600, 9)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Fix wave — count-time prices stay frozen
// ─────────────────────────────────────────────────────────────────────────────

describe('planRemeasure — snapshot prices stay at their count-time value', () => {
  it('a re-derived snapshot keeps its stored value even when its quantity is corrected, and the session total does not move', () => {
    const input = fixture()
    // "5 lb" on the COUNT item was frozen as 5 each at $3.3333/each = $16.67.
    input.counts[1].snapshot = { id: 'snap-lb', qtyOnHand: 5, unit: 'each', pricePerBaseUnit: 40 / 12, totalValue: '16.67' }
    input.sessions[0].snapshots.push({ id: 'snap-lb', source: 'COUNTED', totalValue: '16.67' })
    input.sessions[0].totalCountedValue = 186.67
    const p = plan(planRemeasure(input))
    const row = p.counts.find((c) => c.id === 'c-lb')!
    expect(row.snapshot!.qtyOnHand).toBeCloseTo(2267.96, 9)
    expect(row.snapshot!.totalValue).toBe(16.67)
    expect(row.snapshot!.pricePerBaseUnit).toBeCloseTo(40 / 12 / 150, 15)
    expect(row.snapshot!.unit).toBe('g')
    expect(p.sessions[0].next).toBeCloseTo(186.67, 9)
  })

  it('today’s price is NOT used: a count taken at an older price keeps that price ÷ k', () => {
    const input = fixture()
    input.counts[0].priceAtCount = 3
    input.counts[0].snapshot = { id: 'snap-1', qtyOnHand: 36, unit: 'each', pricePerBaseUnit: 3, totalValue: 108 }
    input.sessions[0].snapshots[0].totalValue = 108
    input.sessions[0].totalCountedValue = 158
    const p = plan(planRemeasure(input))
    const row = p.counts.find((c) => c.id === 'c-case')!
    expect(row.priceAtCount).toBeCloseTo(3 / 150, 15)
    expect(row.snapshot!.pricePerBaseUnit).toBeCloseTo(3 / 150, 15)
    expect(row.snapshot!.totalValue).toBe(108)
    expect(p.sessions[0].next).toBe(158)
  })

  it('a scaled count with a snapshot keeps its value too', () => {
    const input = fixture()
    input.counts.push({ id: 'c-l', countedQty: 2, selectedUom: 'l', countedQtyBase: 2, priceAtCount: 40 / 12,
      snapshot: { id: 'snap-l', qtyOnHand: 2, unit: 'each', pricePerBaseUnit: 40 / 12, totalValue: 6.67 } })
    const p = plan(planRemeasure(input))
    const row = p.counts.find((c) => c.id === 'c-l')!
    expect(row.scaled).toBe(true)
    expect(row.snapshot).toMatchObject({ qtyOnHand: 300, totalValue: 6.67, unit: 'g' })
    expect(row.snapshot!.pricePerBaseUnit).toBeCloseTo(40 / 12 / 150, 15)
  })

  it('a line with no stored priceAtCount gets none planned', () => {
    const input = fixture()
    input.counts[1].priceAtCount = null
    const p = plan(planRemeasure(input))
    expect(p.counts.find((c) => c.id === 'c-lb')!.priceAtCount).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Fix wave — a RATE printed in another dimension is a fact
// ─────────────────────────────────────────────────────────────────────────────

describe('planRemeasure — a RATE in the target dimension keeps its printed price', () => {
  const rateBoxInput = (isStocked: boolean, eachMeasure: { qty: number; unit: string } | null) => {
    const input = fixture()
    input.item.isStocked = isStocked
    input.item.eachMeasureQty = eachMeasure?.qty ?? null
    input.item.eachMeasureUnit = eachMeasure?.unit ?? null
    // A farm sells it by the pound: $3.49/lb, a case of 12.
    input.boxes.push({ id: 'box-farm', supplierId: 'sup-farm', supplierItemCode: null, supplierName: 'Farm', isPrimary: false,
      packChain: [{ unit: 'case', per: 12 }], pricing: { mode: 'RATE', rate: 3.49, rateUnit: 'lb' } })
    return input
  }

  for (const isStocked of [true, false]) {
    it(`unbridged before (unpriced) — kept as printed, not refused (${isStocked ? 'stocked' : 'unstocked'})`, () => {
      const p = plan(planRemeasure(rateBoxInput(isStocked, null)))
      const farm = p.boxes.find((b) => b.id === 'box-farm')!
      expect(farm.pricing).toEqual({ mode: 'RATE', rate: 3.49, rateUnit: 'lb' })
      expect(farm.packChain).toEqual([{ unit: 'case', per: 12 }, { unit: 'each', per: 150 }])
      expect(p.errors).toEqual([])
    })

    it(`bridged differently before (1 each = 100 g, now 150 g) — still the printed $3.49/lb, not refused (${isStocked ? 'stocked' : 'unstocked'})`, () => {
      const p = plan(planRemeasure(rateBoxInput(isStocked, { qty: 100, unit: 'g' })))
      expect(p.boxes.find((b) => b.id === 'box-farm')!.pricing).toEqual({ mode: 'RATE', rate: 3.49, rateUnit: 'lb' })
      expect(p.errors).toEqual([])
    })
  }

  it('the item’s own RATE $/lb (no boxes) is kept the same way', () => {
    const input = fixture()
    input.boxes = []
    input.item.pricing = { mode: 'RATE', rate: 3.49, rateUnit: 'lb' }
    input.item.eachMeasureQty = 100
    input.item.eachMeasureUnit = 'g'
    const p = plan(planRemeasure(input))
    expect(p.item.after.pricing).toEqual({ mode: 'RATE', rate: 3.49, rateUnit: 'lb' })
    expect(p.errors).toEqual([])
  })

  it('rewritePricing: a RATE in the OLD dimension still converts through k', () => {
    const before = ci({ dimension: 'COUNT', baseUnit: 'each', packChain: [{ unit: 'case', per: 12 }], pricing: { mode: 'RATE', rate: 2, rateUnit: 'each' } })
    const to = { dimension: 'MASS' as const, unit: 'g' }
    const pricing = rewritePricing(before, rewriteChain(before.packChain, 'COUNT', to, 150), to, 150)
    expect(pricing).toMatchObject({ mode: 'RATE', rateUnit: 'g' })
  })

  it('an unpriced item never causes a refusal on its own', () => {
    const input = fixture()
    input.item.isStocked = false
    input.item.pricing = { mode: 'PACK', purchasePrice: 0 }
    input.boxes = []
    expect(plan(planRemeasure(input)).errors).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Fix wave — containers, rounding, the guard
// ─────────────────────────────────────────────────────────────────────────────

describe('planRemeasure — count-measure links, rounding and the guard', () => {
  it('a dozen item: [{dozen:12}] $6 COUNT → MASS 50 g keeps dozen as chain link and count unit', () => {
    const input = fixture()
    input.item.packChain = [{ unit: 'dozen', per: 12 }]
    input.item.pricing = { mode: 'PACK', purchasePrice: 6 }
    input.item.countUnit = 'dozen'
    input.bridge = { eachQty: 50, eachUnit: 'g' }
    input.boxes = []
    input.receipts = []
    input.counts = []
    const p = plan(planRemeasure(input))
    expect(p.item.after.packChain).toEqual([{ unit: 'dozen', per: 12 }, { unit: 'each', per: 50 }])
    expect(p.item.after.pricing).toEqual({ mode: 'PACK', purchasePrice: 6 })
    expect(p.item.after.countUnit).toBe('dozen')
    expect(p.errors).toEqual([])
    expect(rel(pricePerBaseUnit(p.item.after) * p.k, pricePerBaseUnit(asChainItem(input.item)))).toBeLessThan(1e-9)
  })

  it('1 each = 0.001 oz is not falsely refused by the guard', () => {
    const input = fixture()
    input.bridge = { eachQty: 0.001, eachUnit: 'oz' }
    const p = plan(planRemeasure(input))
    expect(p.k).toBeCloseTo(0.0283495, 15)
    expect(p.item.after.packChain[1].per).toBe(p.k)
    expect(p.errors).toEqual([])
  })

  it('the guard compares the item with ITSELF before the main box replaces it', () => {
    // The main box is $44 (a different price from the item's $40) — the item may
    // legitimately differ from its main box until the next sync; neither is refused.
    const input = fixture()
    input.boxes[0].pricing = { mode: 'PACK', purchasePrice: 44 }
    const p = plan(planRemeasure(input))
    expect(p.errors).toEqual([])
    expect(p.item.after.pricing).toEqual({ mode: 'PACK', purchasePrice: 44 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Fix wave — MASS → COUNT end to end
// ─────────────────────────────────────────────────────────────────────────────

describe('planRemeasure — MASS → COUNT end to end', () => {
  /** Lemons bought by the case of 72 at 74 g each ($50), being counted by the piece. */
  const lemons = (): RemeasureInput => ({
    item: {
      id: 'lemons', itemName: 'Lemons', isStocked: true,
      dimension: 'MASS', baseUnit: 'g', countUnit: 'case',
      packChain: [{ unit: 'case', per: 72 }, { unit: 'each', per: 74 }],
      pricing: { mode: 'PACK', purchasePrice: 50 },
      eachMeasureQty: 74, eachMeasureUnit: 'g',
      stockOnHand: 10656, lastCountQty: 10656,
    },
    to: { dimension: 'COUNT', unit: 'each' },
    bridge: { eachQty: 74, eachUnit: 'g' },
    boxes: [
      { id: 'box-a', supplierId: 'sup-a', supplierItemCode: null, supplierName: 'Sysco', isPrimary: true,
        packChain: [{ unit: 'case', per: 72 }, { unit: 'each', per: 74 }], pricing: { mode: 'PACK', purchasePrice: 50 } },
      { id: 'box-b', supplierId: 'sup-b', supplierItemCode: null, supplierName: 'Market', isPrimary: false,
        packChain: [{ unit: 'case', per: 4 }, { unit: 'lb', per: 453.592 }], pricing: { mode: 'RATE', rate: 2, rateUnit: 'lb' } },
    ],
    receipts: [
      { id: 'r-a', rawQty: 1, rawUnit: 'cs', rawUnitPrice: 50, rawLineTotal: 50, receivedQtyBase: 5328,
        supplierId: 'sup-a', supplierName: 'Sysco', canonicalName: 'Sysco' },
    ],
    counts: [
      { id: 'c-1', countedQty: 2, selectedUom: 'case', countedQtyBase: 10656, priceAtCount: 50 / 5328,
        snapshot: { id: 's-1', qtyOnHand: 10656, unit: 'g', pricePerBaseUnit: 50 / 5328, totalValue: 100 } },
    ],
    allocations: [],
    sessions: [{ id: 'sess', totalCountedValue: 100, snapshots: [{ id: 's-1', source: 'COUNTED', totalValue: 100 }] }],
    transfers: [{ id: 't', quantity: 740 }],
    recipeLines: 0,
    wastageRows: 0,
  })

  const p = plan(planRemeasure(lemons()))

  it('k = 1/74; containers kept, each becomes 1', () => {
    expect(p.k).toBeCloseTo(1 / 74, 15)
    expect(p.item.after).toMatchObject({ dimension: 'COUNT', baseUnit: 'each', countUnit: 'case' })
    expect(p.item.after.packChain).toEqual([{ unit: 'case', per: 72 }, { unit: 'each', per: 1 }])
    expect(p.item.after.pricing).toEqual({ mode: 'PACK', purchasePrice: 50 })
    expect(p.errors).toEqual([])
  })

  it('the market box collapses its lb into the case and keeps $/base', () => {
    const b = p.boxes.find((x) => x.id === 'box-b')!
    expect(b.packChain[0].unit).toBe('case')
    expect(b.packChain[0].per).toBeCloseTo(4 * 453.592 / 74, 6)
    // $2/lb was a rate in the OLD dimension: converted through k.
    const before = asChainItem(lemons().item)
    const old = pricePerBaseUnit({ ...before, packChain: [{ unit: 'case', per: 4 }, { unit: 'lb', per: 453.592 }], pricing: { mode: 'RATE', rate: 2, rateUnit: 'lb' } })
    expect(rel(pricePerBaseUnit({ ...p.item.after, packChain: b.packChain, pricing: b.pricing }) * p.k, old)).toBeLessThan(1e-6)
  })

  it('receipt, count, snapshot, stock, transfer', () => {
    expect(p.receipts[0].next).toBeCloseTo(72, 9)
    expect(p.counts[0].next).toBeCloseTo(144, 9)
    expect(p.counts[0].snapshot).toMatchObject({ qtyOnHand: expect.closeTo(144, 9), unit: 'each', totalValue: 100 })
    expect(p.counts[0].snapshot!.pricePerBaseUnit).toBeCloseTo(50 / 72, 12)
    expect(p.counts[0].priceAtCount).toBeCloseTo(50 / 72, 12)
    expect(p.stock.stockOnHand.next).toBeCloseTo(144, 9)
    expect(p.sessions[0].next).toBe(100)
    expect(p.transfers).toEqual([{ id: 't', old: 740, next: 10 }])
  })
})
