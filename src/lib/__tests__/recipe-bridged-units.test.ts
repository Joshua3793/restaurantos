import { describe, it, expect } from 'vitest'
import { bridgedUnitGroups, convertQtyBridged } from '@/lib/uom'
import { asChainItem, pricePerBaseUnit } from '@/lib/item-model'
import { computeRecipeCost } from '@/lib/recipeCosts'

// Squash Butternut as it sits live: costed per each, $39.99 / case of 30, 1 each = 3 lb.
const butternut = {
  itemName: 'Squash Butternut', baseUnit: 'each', dimension: 'COUNT',
  packChain: [{ unit: 'case', per: 30 }, { unit: 'pack', per: 1 }],
  pricing: { mode: 'PACK', purchasePrice: 39.99 },
  eachMeasureQty: '3', eachMeasureUnit: 'lb', densityGPerMl: null,
}

describe('bridgedUnitGroups — the units a recipe line may pick', () => {
  it('a per-each item with a weight bridge offers Count AND Weight', () => {
    expect(bridgedUnitGroups('each', { qty: 3, unit: 'lb' })).toEqual(['Weight', 'Count'])
  })
  it("no bridge → only the item's own kind (unchanged)", () => {
    expect(bridgedUnitGroups('each', null)).toEqual(['Count'])
    expect(bridgedUnitGroups('g', null)).toEqual(['Weight'])
  })
  it('a weighed item with a per-each weight offers Count', () => {
    expect(bridgedUnitGroups('g', { qty: 250, unit: 'g' })).toEqual(['Weight', 'Count'])
  })
  it('density adds the other measured kind', () => {
    expect(bridgedUnitGroups('ml', null, 1.03)).toEqual(['Weight', 'Volume'])
  })
  it('a bridge measured in the other kind adds nothing it cannot convert', () => {
    expect(bridgedUnitGroups('g', { qty: 100, unit: 'ml' })).toEqual(['Weight'])
  })
  it('unknown base unit → [] (caller shows every group)', () => {
    expect(bridgedUnitGroups('', null)).toEqual([])
  })
  it('every unit it offers really converts (never the 1:1 passthrough)', () => {
    // 1 lb of butternut = 1/3 each, not 1 each
    expect(convertQtyBridged(1, 'lb', 'each', { qty: 3, unit: 'lb' })).toBeCloseTo(1 / 3, 6)
  })
})

describe('recipe costing through the bridge', () => {
  it('1000 g of butternut costs 0.73 each × $1.333 and carries the bridge to the editor', () => {
    const r = computeRecipeCost({
      baseYieldQty: 1, yieldUnit: 'each', menuPrice: null, portionSize: null,
      ingredients: [{
        id: 'i1', sortOrder: 0, qtyBase: 1000, unit: 'g', notes: null,
        inventoryItemId: 'sq', linkedRecipeId: null, inventoryItem: butternut, linkedRecipe: null,
      }],
    } as unknown as Parameters<typeof computeRecipeCost>[0])
    const perEach = pricePerBaseUnit(asChainItem(butternut as Parameters<typeof asChainItem>[0]))
    expect(perEach).toBeCloseTo(39.99 / 30, 6)
    const line = r.ingredients[0]
    expect(line.dimensionConflict).toBe(false)
    expect(line.lineCost).toBeCloseTo((1000 / (3 * 453.592)) * perEach, 6)
    expect(line.ingredientBridge).toEqual({ qty: 3, unit: 'lb' })
    expect(line.ingredientDensity).toBeNull()
  })
})
