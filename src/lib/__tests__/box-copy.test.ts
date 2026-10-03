import { describe, it, expect } from 'vitest'
import { removeBoxMessage } from '@/lib/box-copy'

describe('removeBoxMessage', () => {
  it('a box that is not the main one: recipes keep the main box', () => {
    expect(removeBoxMessage({ supplierName: 'Sysco', itemName: 'Goats Cheese', isPrimary: false, otherBoxes: 1 }))
      .toBe("Remove Sysco's box for Goats Cheese? Recipes keep costing from the main box.")
  })

  it('the main box with others left: the next most recent becomes main', () => {
    expect(removeBoxMessage({ supplierName: 'Sysco', itemName: 'Goats Cheese', isPrimary: true, otherBoxes: 2 }))
      .toBe("Remove Sysco's box for Goats Cheese? The next most recent box becomes main.")
  })

  it('the only box: the item keeps its current price', () => {
    expect(removeBoxMessage({ supplierName: 'Sysco', itemName: 'Goats Cheese', isPrimary: true, otherBoxes: 0 }))
      .toBe("Remove Sysco's box for Goats Cheese? The item keeps its current price until a new box or invoice sets one.")
  })
})
