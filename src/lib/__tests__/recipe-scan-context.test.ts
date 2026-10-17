import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/prisma', () => ({ prisma: {} }))

import { costOfLine, searchCandidates } from '../recipe-scan/context'
import type { Candidate } from '../recipe-scan/match'

const kgItem = {
  dimension: 'MASS', baseUnit: 'g', packChain: [{ unit: 'kg', per: 1000 }],
  pricing: { mode: 'PACK', purchasePrice: 12 }, countUnit: 'kg',
  eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null,
}

describe('costOfLine', () => {
  it('costs the amount in the item base unit, at read time', () => {
    expect(costOfLine(kgItem, 250, 'g')).toBeCloseTo(3)
    expect(costOfLine(kgItem, 0.5, 'kg')).toBeCloseTo(6)
  })
  it('unknown amount or a count against a weighed item is no cost, not $0', () => {
    expect(costOfLine(kgItem, null, 'g')).toBeNull()
    expect(costOfLine(kgItem, 3, 'each')).toBeNull()
  })
  it('an unpriced item costs 0', () => {
    expect(costOfLine({ ...kgItem, pricing: { mode: 'PACK', purchasePrice: 0 } }, 250, 'g')).toBe(0)
  })
})

function cand(id: string, name: string, over: Partial<Candidate> = {}): Candidate {
  return { kind: 'item', id, name, active: true, mergedIntoId: null, usedInRecipes: 0, boughtAs: '', supplier: null, ...over }
}

describe('searchCandidates', () => {
  it('ranks names containing the words first and never offers inactive or merged', () => {
    const all = [
      cand('1', 'Garlic Peeled', { usedInRecipes: 9 }),
      cand('2', 'Garlic Whole'),
      cand('3', 'Old Garlic', { active: false }),
      cand('4', 'Garlic Dup', { active: false, mergedIntoId: '1' }),
      cand('5', 'Paprika'),
    ]
    expect(searchCandidates('garlic', all).map(c => c.id)).toEqual(['1', '2'])
    expect(searchCandidates('', all).map(c => c.id)).toEqual(['1', '2', '5'])
  })
})
