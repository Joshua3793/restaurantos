import { describe, it, expect } from 'vitest'
import { ingredientNeedsQty, opensQtyEditor } from '@/lib/recipe-line'

// The recipe page marks an item line with no amount "Needs qty" and opens its
// amount box. A scanned "salt to taste" line is saved linked, qty 0, with the
// page's words as its note — that is a deliberate "no amount", not unfinished.
const line = (over: Partial<Parameters<typeof ingredientNeedsQty>[0]> = {}) =>
  ({ ingredientType: 'inventory' as const, qtyBase: 0, notes: null as string | null, ...over })

describe('ingredientNeedsQty / opensQtyEditor', () => {
  it('a hand-added item line with no amount needs one and opens for typing', () => {
    expect(ingredientNeedsQty(line())).toBe(true)
    expect(opensQtyEditor(line())).toBe(true)
  })
  it('a scanned "salt to taste" line (qty 0 with a note) is finished', () => {
    const salt = line({ notes: 'salt to taste' })
    expect(ingredientNeedsQty(salt)).toBe(false)
    expect(opensQtyEditor(salt)).toBe(false)
  })
  it('a blank note does not count', () => {
    expect(ingredientNeedsQty(line({ notes: '   ' }))).toBe(true)
    expect(opensQtyEditor(line({ notes: '   ' }))).toBe(true)
  })
  it('a line with an amount needs nothing', () => {
    expect(ingredientNeedsQty(line({ qtyBase: 5 }))).toBe(false)
    expect(opensQtyEditor(line({ qtyBase: 5 }))).toBe(false)
  })
  it('a sub-recipe or custom line is never "needs qty", but an empty one still opens unless noted', () => {
    expect(ingredientNeedsQty(line({ ingredientType: 'recipe' }))).toBe(false)
    expect(opensQtyEditor(line({ ingredientType: 'recipe' }))).toBe(true)
    expect(opensQtyEditor(line({ ingredientType: 'recipe', notes: 'to finish' }))).toBe(false)
  })
})
