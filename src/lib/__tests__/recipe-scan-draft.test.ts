import { describe, it, expect } from 'vitest'
import { buildDraft, rematchDraft, type DraftContext } from '../recipe-scan/build-draft'
import { toMethod } from '../recipe-scan/method'
import { validateMethod } from '../recipe-method'
import type { Candidate } from '../recipe-scan/match'
import type { AmountItem } from '../recipe-scan/amount'
import type { ExtractedRecipe, ExtractedStep, ExtractedIngredient, DraftData } from '../recipe-scan/types'

function cand(id: string, name: string, over: Partial<Candidate> = {}): Candidate {
  return { kind: 'item', id, name, active: true, mergedIntoId: null, usedInRecipes: 0, boughtAs: '', supplier: null, ...over }
}
const massItem: AmountItem = { dimension: 'MASS', baseUnit: 'g', eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null }
const volItem: AmountItem = { dimension: 'VOLUME', baseUnit: 'ml', eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null }

function ctx(over: Partial<DraftContext> = {}): DraftContext {
  return {
    candidates: [], aliases: new Map(), measures: new Map(), items: new Map(),
    categories: [{ id: 'cat1', name: 'Sauces' }], revenueCenterId: 'rc1', siblingTitles: [], ...over,
  }
}
function step(over: Partial<ExtractedStep> = {}): ExtractedStep {
  return { text: 'Do it', phase: '', minutes: null, minutesStated: false, waitMinutes: null, waitNote: null, waitStated: false, ...over }
}
function ing(name: string, over: Partial<ExtractedIngredient> = {}): ExtractedIngredient {
  return { raw: name, qty: null, unit: null, name, ...over }
}
function recipe(over: Partial<ExtractedRecipe> = {}): ExtractedRecipe {
  return { name: 'Test', yieldQty: 2, yieldUnit: 'l', categoryHint: null, ingredients: [], steps: [], ...over }
}

describe('toMethod', () => {
  it('stated times are not guessed, estimated ones are', () => {
    const { method, guessed } = toMethod([
      step({ text: 'Chop', phase: 'Prep', minutes: 10, minutesStated: true }),
      step({ text: 'Simmer', minutes: 20, minutesStated: false, waitMinutes: 30, waitNote: 'cool', waitStated: false }),
      step({ text: 'Strain', waitMinutes: 15, waitStated: true }),
      step({ text: 'Pack' }),
    ])
    expect(method[0]).toMatchObject({ text: 'Chop', phase: 'Prep', minutes: 10 })
    expect(method[1].wait).toEqual({ minutes: 30, note: 'cool' })
    expect(guessed[method[0].key]).toBeUndefined()
    expect(guessed[method[1].key]).toEqual({ minutes: true, wait: true })
    expect(guessed[method[2].key]).toBeUndefined()
    expect(method[2].wait).toEqual({ minutes: 15 })
    expect(method[3].minutes).toBeUndefined()
  })

  it('a trailing wait gets a Label and date step', () => {
    const { method } = toMethod([
      step({ text: 'Mix', phase: 'Make' }),
      step({ text: 'Chill', phase: 'Set', waitMinutes: 60, waitStated: true }),
    ])
    expect(method).toHaveLength(3)
    expect(method[2]).toMatchObject({ text: 'Label and date.', phase: 'Set' })
    expect(validateMethod(method).ok).toBe(true)
  })

  it('an empty step list stays empty and valid', () => {
    const { method, guessed } = toMethod([])
    expect(method).toEqual([])
    expect(guessed).toEqual({})
  })
})

describe('buildDraft', () => {
  it('HIGH match links and converts the amount', () => {
    const d = buildDraft(
      recipe({ ingredients: [ing('Garlic', { raw: '100 g garlic', qty: 100, unit: 'g' })] }),
      ctx({ candidates: [cand('i1', 'Garlic')], items: new Map([['i1', massItem]]) }),
    )
    expect(d.lines[0]).toMatchObject({
      key: 'l1', link: { kind: 'item', id: 'i1', name: 'Garlic' }, qty: 100, unit: 'g', status: 'MATCHED', qtyText: '100 g',
    })
  })

  it('medium match becomes CHECK', () => {
    const d = buildDraft(
      recipe({ ingredients: [ing('Garlic Cloves Peeled', { qty: 100, unit: 'g' })] }),
      ctx({ candidates: [cand('i1', 'Garlic Cloves')], items: new Map([['i1', massItem]]) }),
    )
    expect(d.lines[0].link?.id).toBe('i1')
    expect(d.lines[0].status).toBe('CHECK')
    expect(d.lines[0].reason).toBe('Close guess — check')
    expect(d.lines[0].qty).toBe(100)
  })

  it('a medium match keeps the amount reason when there is one', () => {
    const d = buildDraft(
      recipe({ ingredients: [ing('Garlic Cloves Peeled', { raw: '3 cloves garlic cloves peeled', qty: 3, unit: 'cloves' })] }),
      ctx({ candidates: [cand('i1', 'Garlic Cloves')], items: new Map([['i1', massItem]]) }),
    )
    expect(d.lines[0].status).toBe('CHECK')
    expect(d.lines[0].reason).toBe('3 cloves — how much is a clove?')
    expect(d.lines[0].qty).toBeNull()
    expect(d.lines[0].qtyText).toBe('3 cloves')
  })

  it('uses a learned measure for a count word', () => {
    const d = buildDraft(
      recipe({ ingredients: [ing('Garlic', { qty: 3, unit: 'cloves' })] }),
      ctx({
        candidates: [cand('i1', 'Garlic')], items: new Map([['i1', massItem]]),
        measures: new Map([['i1:clove', { word: 'clove', qty: 5, unit: 'g' }]]),
      }),
    )
    expect(d.lines[0]).toMatchObject({ qty: 15, unit: 'g', status: 'MATCHED' })
  })

  it('a linked item with no unit info needs a check', () => {
    const d = buildDraft(
      recipe({ ingredients: [ing('Garlic', { qty: 100, unit: 'g' })] }),
      ctx({ candidates: [cand('i1', 'Garlic')] }),
    )
    expect(d.lines[0]).toMatchObject({ status: 'CHECK', reason: 'Unit unknown — check', qty: null, unit: null })
    expect(d.lines[0].link?.id).toBe('i1')
  })

  it('no match leaves allergens unchosen', () => {
    const d = buildDraft(
      recipe({ ingredients: [ing('Dragonfruit', { raw: '2 dragonfruit', qty: 2, unit: null })] }),
      ctx({ candidates: [cand('i1', 'Garlic')] }),
    )
    expect(d.lines[0]).toMatchObject({ status: 'NO_MATCH', link: null, qty: null, unit: null, allergens: null })
    expect(d.lines[0].qtyText).toBe('2')
  })

  it('a qty-less line keeps the words after the name', () => {
    const d = buildDraft(
      recipe({ ingredients: [ing('Salt', { raw: 'Salt to taste' }), ing('Pepper', { raw: 'Pepper' })] }),
      ctx({ candidates: [cand('i1', 'Salt'), cand('i2', 'Pepper')], items: new Map([['i1', massItem], ['i2', massItem]]) }),
    )
    expect(d.lines[0].qtyText).toBe('to taste')
    expect(d.lines[0].status).toBe('NO_AMOUNT')
    expect(d.lines[1].qtyText).toBe('Pepper')
  })

  it('sibling recipe gets a hint', () => {
    const d = buildDraft(
      recipe({ ingredients: [ing('Aioli', { raw: '1 cup Aioli', qty: 1, unit: 'cup' }), ing('Dragonfruit')] }),
      ctx({ siblingTitles: ['Aioli'] }),
    )
    expect(d.lines[0].status).toBe('NO_MATCH')
    expect(d.siblingHints).toEqual({ l1: 'Aioli' })
  })

  it('unknown category stays null, known one matches case-insensitively', () => {
    expect(buildDraft(recipe({ categoryHint: 'Desserts' }), ctx()).categoryId).toBeNull()
    expect(buildDraft(recipe({ categoryHint: 'sauces' }), ctx()).categoryId).toBe('cat1')
    expect(buildDraft(recipe({ categoryHint: null }), ctx()).categoryId).toBeNull()
  })

  it('a missing yield is flagged as guessed', () => {
    const d = buildDraft(recipe({ yieldQty: null, yieldUnit: null }), ctx())
    expect(d).toMatchObject({ yieldGuessed: true, yieldQty: null, revenueCenterId: 'rc1', name: 'Test' })
    expect(buildDraft(recipe(), ctx()).yieldGuessed).toBe(false)
  })
})

describe('rematchDraft', () => {
  const base = (): DraftData => ({
    name: 'Test', yieldQty: 1, yieldUnit: 'l', yieldGuessed: false, categoryId: null, revenueCenterId: null,
    method: [], guessed: {}, siblingHints: { l2: 'Aioli' },
    lines: [
      { key: 'l1', raw: 'Garlic', name: 'Garlic', qtyText: '100 g', qty: 100, unit: 'g', link: { kind: 'item', id: 'gone', name: 'Garlic' }, status: 'MATCHED', reason: null, allergens: null },
      { key: 'l2', raw: '1 cup Aioli', name: 'Aioli', qtyText: '1 cup', qty: null, unit: null, link: null, status: 'NO_MATCH', reason: null, allergens: null },
      { key: 'l3', raw: 'Odd thing', name: 'Odd thing', qtyText: '5 g', qty: null, unit: null, link: null, status: 'NO_MATCH', reason: null, allergens: ['Mustard'] },
      { key: 'l4', raw: 'Oil', name: 'Oil', qtyText: '10 ml', qty: 10, unit: 'ml', link: { kind: 'item', id: 'oil', name: 'Oil' }, status: 'MATCHED', reason: null, allergens: null },
    ],
  })

  it('rematch links a saved sibling and drops a vanished item', () => {
    const c = ctx({
      candidates: [cand('r1', 'Aioli', { kind: 'recipe' }), cand('oil', 'Oil')],
      items: new Map([['r1', volItem], ['oil', volItem]]),
    })
    const out = rematchDraft(base(), c)
    // vanished item: back to unmatched
    expect(out.lines[0]).toMatchObject({ link: null, status: 'NO_MATCH', qty: null, unit: null, allergens: null })
    // sibling now exists: linked, hint removed
    expect(out.lines[1].link).toEqual({ kind: 'recipe', id: 'r1', name: 'Aioli' })
    expect(out.lines[1].status).toBe('MATCHED')
    expect(out.lines[1].unit).toBe('ml')
    expect(out.lines[1].qty).toBeCloseTo(236.6, 1)
    expect(out.siblingHints).toEqual({})
    // hand-chosen allergens survive on a line that stays unlinked
    expect(out.lines[2]).toMatchObject({ link: null, status: 'NO_MATCH', allergens: ['Mustard'] })
    // a line the chef already linked is untouched
    expect(out.lines[3]).toEqual(base().lines[3])
  })

  it('kept-uncosted line is not relinked', () => {
    const d = base()
    d.lines[2] = { ...d.lines[2], allergens: [] }
    const out = rematchDraft(d, ctx({ candidates: [cand('o2', 'Odd thing')], items: new Map([['o2', massItem]]) }))
    expect(out.lines[2]).toEqual(d.lines[2])
    expect(out.lines[2]).toMatchObject({ link: null, status: 'NO_MATCH', allergens: [] })
  })

  it('kept-uncosted sibling line is relinked when its sibling is saved', () => {
    const d = base()
    d.lines[1] = { ...d.lines[1], allergens: ['Egg'] }
    const out = rematchDraft(d, ctx({ candidates: [cand('r1', 'Aioli', { kind: 'recipe' })], items: new Map([['r1', volItem]]) }))
    expect(out.lines[1].link).toEqual({ kind: 'recipe', id: 'r1', name: 'Aioli' })
    expect(out.siblingHints).toEqual({})
  })

  it('a link to a merged-away or inactive item is dropped', () => {
    const c = ctx({ candidates: [cand('gone', 'Garlic', { active: false }), cand('oil', 'Oil')] })
    const out = rematchDraft(base(), c)
    expect(out.lines[0].link).toBeNull()
    expect(out.lines[0].status).toBe('NO_MATCH')
  })

  it('does not mutate its input', () => {
    const d = base()
    const copy = JSON.parse(JSON.stringify(d))
    rematchDraft(d, ctx({ candidates: [cand('oil', 'Oil')] }))
    expect(d).toEqual(copy)
  })
})
