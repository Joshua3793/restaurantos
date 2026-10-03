import { describe, it, expect } from 'vitest'
import { movementQtyBase, MOVEMENT_ITEM_SELECT } from '@/lib/movement-qty'

const BUN_NO_BRIDGE = { baseUnit: 'each', dimension: 'COUNT', eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null }
const BUN_85G       = { baseUnit: 'each', dimension: 'COUNT', eachMeasureQty: '85', eachMeasureUnit: 'g', densityGPerMl: null }
const FLOUR         = { baseUnit: 'g',    dimension: 'MASS',  eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null }
const OIL_092       = { baseUnit: 'ml',   dimension: 'VOLUME', eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: '0.92' }
const OIL_NO_DENS   = { baseUnit: 'ml',   dimension: 'VOLUME', eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null }
const LOAF_1100G    = { baseUnit: 'g',    dimension: 'MASS',  eachMeasureQty: '1100', eachMeasureUnit: 'g', densityGPerMl: null }

describe('movementQtyBase — same dimension is convertQty, unchanged', () => {
  it('1 kg of flour → 1000 g', () => expect(movementQtyBase(1, 'kg', FLOUR)).toEqual({ qtyBase: 1000, unbridged: null }))
  it('500 g of flour → 500 g', () => expect(movementQtyBase(500, 'g', FLOUR)).toEqual({ qtyBase: 500, unbridged: null }))
  it('3 each of buns → 3 each', () => expect(movementQtyBase(3, 'each', BUN_NO_BRIDGE)).toEqual({ qtyBase: 3, unbridged: null }))
})

describe('movementQtyBase — count ↔ measured through the each-measure', () => {
  it('200 g of a bun that weighs 85 g → 2.35 buns (the recipe-costing rule, not 200 buns)', () => {
    const r = movementQtyBase(200, 'g', BUN_85G)
    expect(r.unbridged).toBeNull()
    expect(r.qtyBase).toBeCloseTo(200 / 85, 9)
  })
  it('3 each of a by-weight loaf that weighs 1100 g → 3300 g', () => {
    expect(movementQtyBase(3, 'each', LOAF_1100G)).toEqual({ qtyBase: 3300, unbridged: null })
  })
  it('200 g of a bun with NO each-measure → 0, reported as unbridged', () => {
    expect(movementQtyBase(200, 'g', BUN_NO_BRIDGE)).toEqual({ qtyBase: 0, unbridged: { qty: 200, unit: 'g' } })
  })
  it('2 each of flour (no each-measure) → 0, unbridged', () => {
    expect(movementQtyBase(2, 'each', FLOUR)).toEqual({ qtyBase: 0, unbridged: { qty: 2, unit: 'each' } })
  })
})

describe('movementQtyBase — weight ↔ volume keeps today\'s tolerance', () => {
  it('920 g of oil with density 0.92 → 1000 ml', () => {
    const r = movementQtyBase(920, 'g', OIL_092)
    expect(r.unbridged).toBeNull()
    expect(r.qtyBase).toBeCloseTo(1000, 9)
  })
  it('920 g of oil with NO density → 920 ml (1:1 passthrough, never unbridged)', () => {
    expect(movementQtyBase(920, 'g', OIL_NO_DENS)).toEqual({ qtyBase: 920, unbridged: null })
  })
})

describe('MOVEMENT_ITEM_SELECT', () => {
  it('selects exactly the fields movementQtyBase reads, plus id', () => {
    expect(Object.keys(MOVEMENT_ITEM_SELECT).sort()).toEqual(['baseUnit', 'densityGPerMl', 'dimension', 'eachMeasureQty', 'eachMeasureUnit', 'id'])
  })
})
