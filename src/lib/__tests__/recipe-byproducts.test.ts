import { describe, it, expect } from 'vitest'
import { netCost, creditGuardMessage, yieldBreakdown, withGross } from '@/lib/recipe-byproducts'

describe('netCost', () => {
  it('subtracts credits from the batch cost', () => {
    expect(netCost(258.79, 25.25)).toBeCloseTo(233.54)
  })
  it('never goes below zero', () => {
    expect(netCost(25, 30)).toBe(0)
  })
})

describe('creditGuardMessage', () => {
  it('names both amounts in dollars', () => {
    expect(creditGuardMessage(30, 25)).toBe('Credits $30.00 are more than the batch costs $25.00 — check the weights')
  })
})

describe('yieldBreakdown', () => {
  const brisket = {
    ingredients: [
      { qtyBase: 13, unit: 'kg', ingredientType: 'inventory' as const },
      { qtyBase: 300, unit: 'g', ingredientType: 'recipe' as const },
    ],
    baseYieldQty: 6,
    yieldUnit: 'kg',
    byproducts: [
      { itemName: 'Brisket Trim', qty: 2, unit: 'kg' },
      { itemName: 'Beef Fat Trim', qty: 1.5, unit: 'kg' },
    ],
  }

  it('shows where the raw weight went', () => {
    const b = yieldBreakdown(brisket)!
    expect(b.input).toBeCloseTo(13300)
    expect(b.main).toBeCloseTo(6000)
    expect(b.parts).toEqual([{ name: 'Brisket Trim', qty: 2000 }, { name: 'Beef Fat Trim', qty: 1500 }])
    expect(b.lost).toBeCloseTo(3800)
    expect(b.overflow).toBe(false)
  })

  it('counts volume lines as grams and skips uncosted each lines', () => {
    const b = yieldBreakdown({
      ...brisket,
      ingredients: [...brisket.ingredients, { qtyBase: 1, unit: 'l', ingredientType: 'custom' }, { qtyBase: 4, unit: 'each', ingredientType: 'custom' }],
    })!
    expect(b.input).toBeCloseTo(14300)
  })

  it('is hidden for a recipe that yields a count', () => {
    expect(yieldBreakdown({ ...brisket, baseYieldQty: 24, yieldUnit: 'each' })).toBeNull()
  })

  it('is hidden when nothing else comes off the batch', () => {
    expect(yieldBreakdown({ ...brisket, byproducts: [] })).toBeNull()
  })

  it('flags more coming out than went in', () => {
    const b = yieldBreakdown({
      ingredients: [{ qtyBase: 9, unit: 'kg', ingredientType: 'inventory' }],
      baseYieldQty: 10, yieldUnit: 'kg',
      byproducts: [{ itemName: 'Trim', qty: 1, unit: 'kg' }],
    })!
    expect(b.overflow).toBe(true)
    expect(b.lost).toBeCloseTo(-2000)
  })
})

describe('yieldBreakdown — counted ingredients (final review)', () => {
  it('is hidden when a costed ingredient is counted, not weighed', () => {
    expect(yieldBreakdown({
      ingredients: [{ qtyBase: 6, unit: 'each', ingredientType: 'inventory' }],
      baseYieldQty: 7, yieldUnit: 'kg',
      byproducts: [{ itemName: 'Bones', qty: 2, unit: 'kg' }],
    })).toBeNull()
  })
  it('still shows when only an uncosted custom line is counted', () => {
    expect(yieldBreakdown({
      ingredients: [{ qtyBase: 9, unit: 'kg', ingredientType: 'inventory' }, { qtyBase: 2, unit: 'sprig', ingredientType: 'custom' }],
      baseYieldQty: 6, yieldUnit: 'kg',
      byproducts: [{ itemName: 'Trim', qty: 1, unit: 'kg' }],
    })).not.toBeNull()
  })
})

describe('withGross — the editor\'s optimistic total (final review)', () => {
  it('nets the credit and raises the guard when an ingredient edit drops below the credits', () => {
    expect(withGross({ byproductCredit: 25.25 }, 19.7)).toEqual({ grossCost: 19.7, totalCost: 0, creditExceedsCost: true })
  })
  it('clears the guard when the ingredients cover the credits again', () => {
    expect(withGross({ byproductCredit: 25.25 }, 256.1)).toEqual({ grossCost: 256.1, totalCost: expect.closeTo(230.85), creditExceedsCost: false })
  })
  it('a recipe with no credits is just its ingredients', () => {
    expect(withGross({}, 10)).toEqual({ grossCost: 10, totalCost: 10, creditExceedsCost: false })
  })
})
