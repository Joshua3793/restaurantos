import { describe, it, expect } from 'vitest'
import { bestAliasScore, capAliasConfidence } from '@/lib/invoice-matcher'

describe('bestAliasScore', () => {
  it('scores against the item name when that is the best', () => {
    const r = bestAliasScore('Zucchini Green', 'Zucchini Green', [])
    expect(r).toEqual({ score: 100, viaAlias: false })
  })
  it('a learned description from another supplier lifts a weak name match', () => {
    const byName = bestAliasScore('ZUCCHINI GRN FANCY 20LB', 'Farm Squash Zuchinni', [])
    const byAlias = bestAliasScore('ZUCCHINI GRN FANCY 20LB', 'Farm Squash Zuchinni', ['ZUCCHINI GREEN FANCY'])
    expect(byAlias.score).toBeGreaterThan(byName.score)
    expect(byAlias.viaAlias).toBe(true)
  })
  it('an alias that scores lower than the name is ignored', () => {
    expect(bestAliasScore('Butter Unsalted', 'Butter Unsalted', ['COCOA BUTTER CHIPS']).viaAlias).toBe(false)
  })
})

describe('capAliasConfidence', () => {
  it('caps a HIGH match won only through an alias down to MEDIUM', () => {
    expect(capAliasConfidence('HIGH', true)).toBe('MEDIUM')
  })
  it('leaves a HIGH match won on the item name itself alone', () => {
    expect(capAliasConfidence('HIGH', false)).toBe('HIGH')
  })
  it('leaves non-HIGH confidences untouched regardless of how they were won', () => {
    expect(capAliasConfidence('MEDIUM', true)).toBe('MEDIUM')
    expect(capAliasConfidence('LOW', true)).toBe('LOW')
    expect(capAliasConfidence('NONE', true)).toBe('NONE')
  })
})
