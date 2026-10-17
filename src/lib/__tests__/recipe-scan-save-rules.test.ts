import { describe, it, expect } from 'vitest'
import {
  saveBlockers, isDraftData, ingredientRows, aliasLearnings, countMeasureLearnings,
} from '../recipe-scan/save-rules'
import type { DraftData, DraftLine } from '../recipe-scan/types'

function line(over: Partial<DraftLine> = {}): DraftLine {
  return {
    key: 'l1', raw: '60 ml sherry vin', name: 'sherry vin', qtyText: '60 ml',
    qty: 60, unit: 'ml', link: { kind: 'item', id: 'i1', name: 'Sherry Vinegar' },
    status: 'MATCHED', reason: null, allergens: null, ...over,
  }
}
function draft(over: Partial<DraftData> = {}): DraftData {
  return {
    name: 'House Romesco', yieldQty: 2, yieldUnit: 'l', yieldGuessed: false,
    categoryId: 'cat1', revenueCenterId: 'rc1', lines: [line()], method: [],
    guessed: {}, siblingHints: {}, ...over,
  }
}

describe('saveBlockers', () => {
  it('a clean draft can save', () => {
    expect(saveBlockers(draft(), [])).toEqual([])
  })

  it('counts lines that need a check', () => {
    const d = draft({ lines: [line({ key: 'a', status: 'CHECK' }), line({ key: 'b', status: 'CHECK' }), line({ key: 'c' })] })
    expect(saveBlockers(d, [])).toEqual(['2 lines need a check'])
    expect(saveBlockers(draft({ lines: [line({ status: 'CHECK' })] }), [])).toEqual(['1 line needs a check'])
  })

  it('needs a yield', () => {
    expect(saveBlockers(draft({ yieldQty: null }), [])).toEqual(['Add the yield'])
    expect(saveBlockers(draft({ yieldQty: 0 }), [])).toEqual(['Add the yield'])
    expect(saveBlockers(draft({ yieldUnit: null }), [])).toEqual(['Add the yield'])
    expect(saveBlockers(draft({ yieldUnit: '  ' }), [])).toEqual(['Add the yield'])
  })

  it('needs a category', () => {
    expect(saveBlockers(draft({ categoryId: null }), [])).toEqual(['Pick a category'])
  })

  it('counts unlinked lines with no allergen choice', () => {
    const d = draft({ lines: [line({ link: null, status: 'NO_MATCH', allergens: null, qty: null, unit: null })] })
    expect(saveBlockers(d, [])).toEqual(['Choose allergens for 1 unlinked line'])
    const two = draft({
      lines: [
        line({ key: 'a', link: null, status: 'NO_MATCH', allergens: null }),
        line({ key: 'b', link: null, status: 'NO_MATCH', allergens: null }),
        line({ key: 'c', link: null, status: 'NO_MATCH', allergens: [] }), // "No allergens" is a choice
      ],
    })
    expect(saveBlockers(two, [])).toEqual(['Choose allergens for 2 unlinked lines'])
  })

  it('refuses a name that already exists, whatever the case', () => {
    expect(saveBlockers(draft(), ['house romesco'])).toEqual(['A recipe called House Romesco already exists'])
  })

  it('needs a name', () => {
    expect(saveBlockers(draft({ name: '  ' }), [])).toEqual(['Add a name'])
  })
})

describe('isDraftData', () => {
  it('accepts a draft and refuses junk', () => {
    expect(isDraftData(draft())).toBe(true)
    expect(isDraftData(null)).toBe(false)
    expect(isDraftData({ lines: [] })).toBe(false)
    expect(isDraftData({ ...draft(), lines: 'x' })).toBe(false)
    expect(isDraftData({ ...draft(), lines: [{ key: 'a' }] })).toBe(false)
  })
})

describe('ingredientRows', () => {
  const base = (l: DraftLine) => (l.link?.kind === 'item' ? 'g' : 'ml')

  it('linked lines carry the link and the saved amount; no amount saves 0', () => {
    const rows = ingredientRows(draft({
      lines: [
        line(),
        line({ key: 'l2', raw: 'salt to taste', name: 'salt', qtyText: 'to taste', qty: 0, unit: 'g', status: 'NO_AMOUNT', link: { kind: 'item', id: 'salt', name: 'Salt' } }),
        line({ key: 'l3', raw: '1 cup aioli', name: 'aioli', qtyText: '1 cup', qty: null, unit: null, link: { kind: 'recipe', id: 'r1', name: 'Aioli' } }),
      ],
    }), base)
    expect(rows[0]).toEqual({ inventoryItemId: 'i1', linkedRecipeId: null, customName: null, qtyBase: 60, unit: 'ml', allergens: [], notes: '60 ml sherry vin', sortOrder: 0 })
    expect(rows[1]).toMatchObject({ inventoryItemId: 'salt', qtyBase: 0, unit: 'g', sortOrder: 1 })
    expect(rows[2]).toMatchObject({ inventoryItemId: null, linkedRecipeId: 'r1', qtyBase: 0, unit: 'ml' })
  })

  it('unlinked lines keep their words and allergens', () => {
    const rows = ingredientRows(draft({
      lines: [
        line({ raw: '3 cloves garlic', name: 'garlic', qtyText: '3 cloves', link: null, qty: null, unit: null, status: 'NO_MATCH', allergens: [] }),
        line({ key: 'l2', raw: 'pimentón to taste', name: 'pimentón', qtyText: 'to taste', link: null, qty: null, unit: null, status: 'NO_MATCH', allergens: ['Sulphites'] }),
      ],
    }), base)
    expect(rows[0]).toEqual({ inventoryItemId: null, linkedRecipeId: null, customName: 'garlic', qtyBase: 3, unit: 'cloves', allergens: [], notes: '3 cloves garlic', sortOrder: 0 })
    expect(rows[1]).toMatchObject({ customName: 'pimentón', qtyBase: 0, unit: 'to taste', allergens: ['Sulphites'] })
  })
})

describe('learning', () => {
  it('learns a wording only when it differs from the item name', () => {
    const d = draft({
      lines: [
        line(), // "sherry vin" → Sherry Vinegar: learn
        line({ key: 'l2', name: 'Sherry Vinegar', link: { kind: 'item', id: 'i1', name: 'Sherry Vinegar' } }), // same: skip
        line({ key: 'l3', name: 'aioli', link: { kind: 'recipe', id: 'r1', name: 'House Aioli' } }),
        line({ key: 'l4', name: 'mystery', link: null, status: 'NO_MATCH', allergens: [] }),
      ],
    })
    expect(aliasLearnings(d)).toEqual([
      { text: 'sherry vin', kind: 'item', id: 'i1' },
      { text: 'aioli', kind: 'recipe', id: 'r1' },
    ])
  })

  it('learns a count word per unit for item lines only', () => {
    const d = draft({
      lines: [
        line({ raw: '3 cloves garlic', name: 'garlic', qtyText: '3 cloves', qty: 15, unit: 'g', link: { kind: 'item', id: 'gar', name: 'Garlic Peeled' } }),
        line({ key: 'l2', qtyText: '60 ml' }), // a real measure: nothing to learn
        line({ key: 'l3', qtyText: '2 each', qty: 2, unit: 'each' }), // each is not a count word
        line({ key: 'l4', qtyText: '1 bunch', qty: 30, unit: 'g', link: { kind: 'recipe', id: 'r1', name: 'Herb Mix' } }), // recipe link: skip
        line({ key: 'l5', qtyText: 'a handful', qty: 20, unit: 'g' }), // no number: skip
        line({ key: 'l6', qtyText: '2 bunches', qty: 0, unit: 'g', status: 'NO_AMOUNT' }), // no saved qty: skip
      ],
    })
    expect(countMeasureLearnings(d)).toEqual([
      { inventoryItemId: 'gar', word: 'clove', qty: 5, unit: 'g' },
    ])
  })
})
