import { describe, it, expect } from 'vitest'
import { measureWord, bridgePrompt, changeLines, appliedToast, changedAgo, defaultTargetUnit } from '@/lib/remeasure-copy'
import type { RemeasureSummary } from '@/lib/remeasure-plan'

const side = { dimension: 'COUNT' as const, unit: 'each', packLabel: 'case (12 each)', priceLabel: '$40.00 per case', countUnit: 'each' }

function summary(over: Partial<RemeasureSummary> = {}): RemeasureSummary {
  return {
    from: side,
    to: { ...side, dimension: 'MASS', unit: 'g', countUnit: 'case' },
    boxes: [],
    counts: { n: 0, converted: 0, reread: 0, scaled: 0 },
    receipts: { n: 0, converted: 0, reread: 0, scaled: 0 },
    transfers: 0,
    recipes: 0,
    wastage: 0,
    warnings: [],
    ...over,
  }
}

describe('measureWord', () => {
  it('names each measure in plain words', () => {
    expect(measureWord('MASS')).toBe('weight')
    expect(measureWord('VOLUME')).toBe('volume')
    expect(measureWord('COUNT')).toBe('pieces')
  })
})

describe('bridgePrompt', () => {
  it('pieces → weight asks what one piece weighs', () => {
    expect(bridgePrompt('COUNT', 'MASS')).toEqual({ label: 'One piece weighs', unitOptions: ['g', 'kg', 'oz', 'lb'], kind: 'each' })
  })
  it('pieces → volume asks what one piece holds', () => {
    expect(bridgePrompt('COUNT', 'VOLUME')).toEqual({ label: 'One piece holds', unitOptions: ['ml', 'l'], kind: 'each' })
  })
  it('weight → pieces asks what one piece weighs', () => {
    expect(bridgePrompt('MASS', 'COUNT')).toEqual({ label: 'One piece weighs', unitOptions: ['g', 'kg', 'oz', 'lb'], kind: 'each' })
  })
  it('volume → pieces asks what one piece holds', () => {
    expect(bridgePrompt('VOLUME', 'COUNT')).toEqual({ label: 'One piece holds', unitOptions: ['ml', 'l'], kind: 'each' })
  })
  it('weight ↔ volume asks for the density, both ways', () => {
    const density = { label: '1 ml weighs (g)', unitOptions: ['g'], kind: 'density' }
    expect(bridgePrompt('MASS', 'VOLUME')).toEqual(density)
    expect(bridgePrompt('VOLUME', 'MASS')).toEqual(density)
  })
})

describe('changeLines', () => {
  it('nothing recorded: only the recipe line', () => {
    expect(changeLines(summary())).toEqual(['No recipe uses it.'])
  })

  it('singular wording for one of each', () => {
    expect(changeLines(summary({
      counts: { n: 1, converted: 1, reread: 0, scaled: 0 },
      receipts: { n: 1, converted: 1, reread: 0, scaled: 0 },
      boxes: [{ supplierName: 'Sysco', isPrimary: true, before: 'a', after: 'b' }],
      transfers: 1,
      recipes: 1,
      wastage: 1,
    }))).toEqual([
      '1 count will be converted.',
      '1 delivery will be converted.',
      '1 supplier box will be converted.',
      '1 stock transfer will be converted.',
      '1 recipe keeps its cost.',
      '1 wastage entry stays as typed.',
    ])
  })

  it('plural wording, what was re-read, then each warning verbatim', () => {
    const box = { supplierName: 'Sysco', isPrimary: false, before: 'a', after: 'b' }
    expect(changeLines(summary({
      counts: { n: 4, converted: 2, reread: 1, scaled: 1 },
      receipts: { n: 3, converted: 1, reread: 2, scaled: 0 },
      boxes: [box, box],
      transfers: 2,
      recipes: 5,
      wastage: 6,
      warnings: ['1 count could not be read in either measure and was scaled by the factor.'],
    }))).toEqual([
      '4 counts will be converted (1 re-read from what was typed).',
      '3 deliveries will be converted (2 re-read from the invoice).',
      '2 supplier boxes will be converted.',
      '2 stock transfers will be converted.',
      '5 recipes keep their cost.',
      '6 wastage entries stay as typed.',
      '1 count could not be read in either measure and was scaled by the factor.',
    ])
  })

  it('zero rows are left out, except recipes', () => {
    expect(changeLines(summary({ receipts: { n: 2, converted: 2, reread: 0, scaled: 0 } }))).toEqual([
      '2 deliveries will be converted.',
      'No recipe uses it.',
    ])
  })

  it('no code words', () => {
    const all = changeLines(summary({
      counts: { n: 4, converted: 2, reread: 1, scaled: 1 },
      receipts: { n: 3, converted: 1, reread: 2, scaled: 0 },
      boxes: [{ supplierName: 'Sysco', isPrimary: false, before: 'a', after: 'b' }],
      transfers: 2, recipes: 5, wastage: 6,
    })).join(' ')
    expect(all).not.toMatch(/bridge|re-expressed|restated|snapshot/i)
  })
})

describe('appliedToast', () => {
  it('says the new measure and only what actually changed', () => {
    const box = { supplierName: 'Sysco', isPrimary: true, before: 'a', after: 'b' }
    const one = { n: 1, converted: 1, reread: 0, scaled: 0 }
    expect(appliedToast('MASS', summary({ counts: one, receipts: one, boxes: [box] })))
      .toBe('Now measured by weight. Counts, deliveries and boxes were converted.')
    expect(appliedToast('VOLUME', summary({ counts: one, boxes: [box] })))
      .toBe('Now measured by volume. Counts and boxes were converted.')
    expect(appliedToast('COUNT', summary({ receipts: one })))
      .toBe('Now measured by pieces. Deliveries were converted.')
  })
  it('nothing else moved: the measure alone', () => {
    expect(appliedToast('MASS', summary())).toBe('Now measured by weight.')
    expect(appliedToast('MASS')).toBe('Now measured by weight.')
  })
})

describe('changedAgo', () => {
  const now = new Date('2026-10-03T18:00:00Z')
  it('reads like a person would say it', () => {
    expect(changedAgo('2026-10-03T17:59:40Z', now)).toBe('just now')
    expect(changedAgo('2026-10-03T17:55:00Z', now)).toBe('5 min ago')
    expect(changedAgo('2026-10-03T15:00:00Z', now)).toBe('3 h ago')
    expect(changedAgo('2026-10-02T12:00:00Z', now)).toBe('yesterday')
    expect(changedAgo('2026-09-29T18:00:00Z', now)).toBe('4 days ago')
  })
  it('older than a week is a date', () => {
    expect(changedAgo('2026-09-12T18:00:00Z', now)).toBe('Sep 12')
  })
  it('a bad date says nothing', () => {
    expect(changedAgo('nope', now)).toBe('')
  })
})

describe('defaultTargetUnit', () => {
  it('follows the bridge unit when it is a unit of the new measure', () => {
    expect(defaultTargetUnit('MASS', 'g')).toBe('g')
    expect(defaultTargetUnit('MASS', 'lb')).toBe('lb')
    expect(defaultTargetUnit('VOLUME', 'ml')).toBe('ml')
  })
  it('canonicalises the bridge unit first', () => {
    expect(defaultTargetUnit('MASS', 'KG')).toBe('kg')
  })
  it('falls back to kg / l when the bridge is another measure or missing', () => {
    expect(defaultTargetUnit('VOLUME', 'g')).toBe('l')
    expect(defaultTargetUnit('MASS', 'ml')).toBe('kg')
    expect(defaultTargetUnit('MASS', '')).toBe('kg')
    expect(defaultTargetUnit('VOLUME', null)).toBe('l')
  })
  it('pieces are always each', () => {
    expect(defaultTargetUnit('COUNT', 'g')).toBe('each')
  })
})
