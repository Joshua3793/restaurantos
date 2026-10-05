import { describe, it, expect } from 'vitest'
import { DEFAULT_OPENING_ITEMS, openProgress, bySection, seedItemId } from '../open-checklist'

describe('opening checklist', () => {
  it('counts done items and the before-doors ones still open', () => {
    expect(openProgress([
      { done: true, isBlocker: true },
      { done: false, isBlocker: true },
      { done: false, isBlocker: false },
    ])).toEqual({ done: 1, total: 3, blockersLeft: 1 })
  })

  it('groups by section in first-seen order', () => {
    const g = bySection([{ section: 'Food safety', t: 1 }, { section: 'Line set-up', t: 2 }, { section: 'Food safety', t: 3 }])
    expect(g.map(x => [x.section, x.rows.map(r => r.t)])).toEqual([['Food safety', [1, 3]], ['Line set-up', [2]]])
  })

  it('ships a default list with no money words and unique titles', () => {
    const titles = DEFAULT_OPENING_ITEMS.map(i => i.title)
    expect(new Set(titles).size).toBe(titles.length)
    expect(DEFAULT_OPENING_ITEMS.some(i => /\$|cash|cost|price|tip/i.test(`${i.title} ${i.meta ?? ''}`))).toBe(false)
  })

  it('seeds with stable ids so a double first-open cannot duplicate the list', () => {
    expect(seedItemId('rc1', 0)).toBe(seedItemId('rc1', 0))
    expect(seedItemId('rc1', 0)).not.toBe(seedItemId('rc2', 0))
  })
})
