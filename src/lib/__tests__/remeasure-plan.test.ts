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
  it('a count-measure link below a COUNT container is folded into it, not lost (eggs: case of 15 dozen)', () => {
    // The literal rule ("keep container per as-is") would make a case 15 eggs.
    expect(rewriteChain([L('case', 15), L('dozen', 12)], 'COUNT', { dimension: 'MASS', unit: 'g' }, 50)).toEqual([L('case', 180), L('each', 50)])
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
      { id: 'box-sysco', supplierName: 'Sysco', isPrimary: true, packChain: [{ unit: 'case', per: 12 }], pricing: { mode: 'PACK', purchasePrice: 40 }, packQty: 12, packSize: 1, packUOM: 'each' },
      { id: 'box-snow', supplierName: 'Snow Cap', isPrimary: false, packChain: [{ unit: 'case', per: 6 }], pricing: { mode: 'PACK', purchasePrice: 22 }, packQty: 6, packSize: 1, packUOM: 'each' },
    ],
    receipts: [
      // Per-case line: 2 cases of 12 each, frozen at 24 each.
      { id: 'r-case', rawQty: 2, rawUnit: 'cs', invoicePackQty: 12, invoicePackSize: 1, invoicePackUOM: 'each', rawUnitPrice: 40, rawLineTotal: 80, receivedQtyBase: 24 },
      // Per-lb line: 10 lb billed at $6.05/lb, frozen at 10 — "10 each", wrong.
      { id: 'r-lb', rawQty: 1, rawUnit: 'cs', totalQty: 10, totalQtyUOM: 'lb', rateUOM: 'lb', rate: 6.05, rawUnitPrice: 60.5, rawLineTotal: 60.5, receivedQtyBase: 10 },
    ],
    counts: [
      { id: 'c-case', countedQty: 3, selectedUom: 'case', countedQtyBase: 36, snapshot: { id: 'snap-1', qtyOnHand: 36, unit: 'each' } },
      // Entered in lb on a COUNT item: unresolvable then, resolvable under MASS.
      { id: 'c-lb', countedQty: 5, selectedUom: 'lb', countedQtyBase: 5 },
    ],
    countSessions: [
      { lineId: 'c-case', sessionDate: '2026-09-01T00:00:00Z', revenueCenterId: null, rcIsDefault: false, skipped: false, countedQty: 3 },
      { lineId: 'c-lb', sessionDate: '2026-09-15T00:00:00Z', revenueCenterId: null, rcIsDefault: false, skipped: false, countedQty: 5 },
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

  it('receipts re-derive through the receiving rule, none scaled', () => {
    const rCase = p.receipts.find((r) => r.id === 'r-case')!
    const rLb = p.receipts.find((r) => r.id === 'r-lb')!
    expect(rCase.next).toBeCloseTo(3600, 9)
    expect(rCase.scaled).toBe(false)
    expect(rCase.via).not.toBe('scaled')
    expect(rLb.next).toBeCloseTo(4535.92, 9)
    expect(rLb.via).toBe('billed-weight')
    expect(rLb.scaled).toBe(false)
  })

  it('counts re-derive; the snapshot follows its line and keeps its value', () => {
    const ppb = pricePerBaseUnit(p.item.after)
    const cCase = p.counts.find((c) => c.id === 'c-case')!
    const cLb = p.counts.find((c) => c.id === 'c-lb')!
    expect(cCase.next).toBeCloseTo(5400, 9)
    expect(cCase.scaled).toBe(false)
    expect(cCase.snapshot).toMatchObject({ id: 'snap-1', unit: 'g' })
    expect(cCase.snapshot!.qtyOnHand).toBeCloseTo(5400, 9)
    expect(cCase.snapshot!.totalValue).toBeCloseTo(5400 * ppb, 9)
    expect(cCase.snapshot!.totalValue).toBeCloseTo(120, 9)           // 3 cases × $40 — the value did not move
    expect(cLb.next).toBeCloseTo(2267.96, 9)
    expect(cLb.scaled).toBe(false)
    expect(cLb.needsDecision).toBe(false)
  })

  it('stock baselines come from the latest observed count line', () => {
    expect(p.stock.stockOnHand.next).toBeCloseTo(2267.96, 9)
    expect(p.stock.stockOnHand.fromLineId).toBe('c-lb')
    expect(p.stock.lastCountQty.next).toBeCloseTo(2267.96, 9)
  })

  it('session totals re-sum over the rewritten snapshot', () => {
    expect(p.sessions).toHaveLength(1)
    expect(p.sessions[0].sessionId).toBe('sess-1')
    expect(p.sessions[0].next).toBeCloseTo(170, 9)
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
    expect(p.summary.counts).toEqual({ n: 2, scaled: 0 })
    expect(p.summary.receipts).toEqual({ n: 2, scaled: 0 })
    expect(p.summary.transfers).toBe(1)
    expect(p.summary.recipes).toBe(4)
    expect(p.summary.wastage).toBe(2)
    expect(p.summary.warnings).toEqual([])
  })
})

describe('planRemeasure — rows the rules cannot re-read are scaled and said', () => {
  it('a count entered in a third dimension is scaled old × k, with the warning', () => {
    const input = fixture()
    // "2 l" of a COUNT item going to weight: nothing bridges litres to grams.
    input.counts.push({ id: 'c-l', countedQty: 2, selectedUom: 'l', entries: [{ unit: 'l', qty: 2 }], countedQtyBase: 2 })
    input.countSessions.push({ lineId: 'c-l', sessionDate: '2026-09-10T00:00:00Z', revenueCenterId: null, rcIsDefault: false, skipped: false, countedQty: 2 })
    const p = plan(planRemeasure(input))
    const row = p.counts.find((c) => c.id === 'c-l')!
    expect(row.scaled).toBe(true)
    expect(row.via).toBe('scaled')
    expect(row.needsDecision).toBe(false)
    expect(row.next).toBe(300)
    expect(p.summary.counts).toEqual({ n: 3, scaled: 1 })
    expect(p.summary.warnings).toContain('1 count could not be re-read from what was typed and was scaled instead.')
  })

  it('a receipt with nothing to read is scaled old × k, with the warning', () => {
    const input = fixture()
    input.receipts.push({ id: 'r-none', rawQty: 0, receivedQtyBase: 6 })
    const p = plan(planRemeasure(input))
    const row = p.receipts.find((r) => r.id === 'r-none')!
    expect(row).toMatchObject({ old: 6, next: 900, via: 'scaled', scaled: true })
    expect(p.summary.receipts).toEqual({ n: 3, scaled: 1 })
    expect(p.summary.warnings).toContain('1 delivery could not be re-read from the invoice and was scaled instead.')
  })

  it('a stale snapshot is left alone and counted; stock with no count is left alone and said', () => {
    const input = fixture()
    input.counts[0].snapshot = { id: 'snap-1', qtyOnHand: 99, unit: 'each' }
    input.countSessions = []
    const p = plan(planRemeasure(input))
    expect(p.counts[0].snapshotMismatch).toBe(true)
    expect(p.counts[0].snapshot).toBeUndefined()
    expect(p.stock.stockOnHand.next).toBeNull()
    expect(p.summary.warnings).toContain('1 count snapshot was left alone (it no longer matches its count line).')
    expect(p.summary.warnings).toContain('Stock on hand was left alone — no finalized count sets it.')
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
    input.countSessions = []
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
