import { describe, it, expect } from 'vitest'
import { compareShelfOrder, sortByShelf, parseShelfOrderBody, type ShelfSortable } from '../count-shelf-order'

const it_ = (name: string, areaName: string | null, shelfOrder: number | null): ShelfSortable => ({ name, areaName, shelfOrder })

describe('compareShelfOrder', () => {
  it('area first, then shelf position, then name', () => {
    const items = [
      it_('Goats Cheese', 'Walk-in', null),
      it_('Butter', 'Walk-in', 2),
      it_('Arugula', 'Walk-in', null),
      it_('Cream', 'Walk-in', 0),
      it_('Flour', 'Dry store', 5),
      it_('Ice', null, 0),
    ]
    expect(sortByShelf(items, x => x).map(x => x.name)).toEqual([
      'Flour', 'Cream', 'Butter', 'Arugula', 'Goats Cheese', 'Ice',
    ])
  })
  it('unplaced items sort after placed ones, A–Z', () => {
    expect(compareShelfOrder(it_('A', 'X', null), it_('Z', 'X', 9))).toBeGreaterThan(0)
    expect(compareShelfOrder(it_('A', 'X', null), it_('B', 'X', null))).toBeLessThan(0)
  })
  it('shelf position 0 is a real position', () => {
    expect(compareShelfOrder(it_('Z', 'X', 0), it_('A', 'X', 1))).toBeLessThan(0)
  })
  it('equal items compare 0', () => {
    expect(compareShelfOrder(it_('A', 'X', 1), it_('A', 'X', 1))).toBe(0)
  })
})

describe('parseShelfOrderBody', () => {
  it('accepts a list of ids', () => {
    expect(parseShelfOrderBody({ itemIds: ['a', 'b'] })).toEqual({ ok: true, itemIds: ['a', 'b'] })
    expect(parseShelfOrderBody({ itemIds: [] })).toEqual({ ok: true, itemIds: [] })
  })
  it('rejects bad bodies', () => {
    expect(parseShelfOrderBody(null).ok).toBe(false)
    expect(parseShelfOrderBody({}).ok).toBe(false)
    expect(parseShelfOrderBody({ itemIds: 'a' }).ok).toBe(false)
    expect(parseShelfOrderBody({ itemIds: ['a', 3] }).ok).toBe(false)
    expect(parseShelfOrderBody({ itemIds: ['a', ''] }).ok).toBe(false)
    expect(parseShelfOrderBody({ itemIds: ['a', 'a'] }).ok).toBe(false)
  })
})
