import { describe, it, expect } from 'vitest'
import { parseQty, resolveAmount, type AmountItem } from '../recipe-scan/amount'

describe('parseQty', () => {
  it('reads fractions and ranges', () => {
    expect(parseQty('1/2')).toBe(0.5); expect(parseQty('1½')).toBe(1.5)
    expect(parseQty('2-3')).toBe(2.5); expect(parseQty('250g')).toBe(250)
    expect(parseQty('a pinch')).toBeNull()
  })
  it('reads mixed numbers, decimals, unicode fractions and "to" ranges', () => {
    expect(parseQty('1 1/2')).toBe(1.5)
    expect(parseQty('¾')).toBe(0.75)
    expect(parseQty('1.5 kg')).toBe(1.5)
    expect(parseQty('2 to 3')).toBe(2.5)
    expect(parseQty('2–3')).toBe(2.5)
    expect(parseQty('1,000 g')).toBe(1000)
  })
  it('never returns NaN or Infinity for odd text', () => {
    for (const t of ['', '   ', '1/0', '/', '-', '--', '.', '..', '1/', '/2', 'to', '2 to', '½½', 'NaN', 'Infinity', '1e999', '9'.repeat(400), '0/0', '-3', '1 - ', '2-', '- 2']) {
      const v = parseQty(t)
      expect(v === null || Number.isFinite(v)).toBe(true)
    }
    expect(parseQty('1/0')).toBeNull()
    expect(parseQty('')).toBeNull()
    expect(parseQty('Infinity')).toBeNull()
  })
  it('reads 1-1/2 as one and a half, but keeps fraction ranges', () => {
    expect(parseQty('1-1/2')).toBe(1.5)
    expect(parseQty('1-1/2 cups')).toBe(1.5)
    expect(parseQty('2-3/4')).toBe(2.75)
    expect(parseQty('1/2-3/4')).toBe(0.625)
    expect(parseQty('2-3')).toBe(2.5)
    expect(parseQty('1-1/0')).toBe(1)
  })
  it('a dangling range keeps the first number', () => {
    expect(parseQty('2-')).toBe(2)
  })
})

describe('resolveAmount', () => {
  const kg: AmountItem = { dimension: 'MASS', baseUnit: 'g', eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null }
  const litre: AmountItem = { dimension: 'VOLUME', baseUnit: 'ml', eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null }
  const egg: AmountItem = { dimension: 'COUNT', baseUnit: 'each', eachMeasureQty: 50, eachMeasureUnit: 'g', densityGPerMl: null }
  const onion: AmountItem = { dimension: 'MASS', baseUnit: 'g', eachMeasureQty: 150, eachMeasureUnit: 'g', densityGPerMl: null }

  it('keeps a known compatible unit silently', () =>
    expect(resolveAmount({ raw: '150 g almonds', qty: 150, unit: 'g', name: 'almonds' }, kg, null))
      .toEqual({ qty: 150, unit: 'g', status: 'MATCHED', reason: null }))
  it('converts a count word with the estimate and flags CHECK', () =>
    expect(resolveAmount({ raw: '3 cloves garlic', qty: 3, unit: 'clove', name: 'garlic', estimate: { qty: 15, unit: 'g' } }, kg, null))
      .toEqual({ qty: 15, unit: 'g', status: 'CHECK', reason: '3 cloves — about 15 g, check' }))
  it('uses a learned measure and does not flag', () =>
    expect(resolveAmount({ raw: '3 cloves garlic', qty: 3, unit: 'clove', name: 'garlic' }, kg, { word: 'clove', qty: 5, unit: 'g' }))
      .toEqual({ qty: 15, unit: 'g', status: 'MATCHED', reason: null }))
  it('unmatched lines are left as written', () =>
    expect(resolveAmount({ raw: '1 tsp pimentón', qty: 1, unit: 'tsp', name: 'pimentón' }, null, null))
      .toEqual({ qty: null, unit: null, status: 'NO_MATCH', reason: null }))
  it('no amount stays NO_AMOUNT with qty 0', () =>
    expect(resolveAmount({ raw: 'salt to taste', qty: null, unit: null, name: 'salt' }, kg, null))
      .toEqual({ qty: 0, unit: 'g', status: 'NO_AMOUNT', reason: null }))
  it('count word with no estimate asks', () =>
    expect(resolveAmount({ raw: '1 bunch dill', qty: 1, unit: 'bunch', name: 'dill' }, kg, null).status).toBe('CHECK'))

  it('bunch without an estimate gives the ask reason and no amount', () =>
    expect(resolveAmount({ raw: '1 bunch dill', qty: 1, unit: 'bunch', name: 'dill' }, kg, null))
      .toEqual({ qty: null, unit: null, status: 'CHECK', reason: '1 bunch — how much is a bunch?' }))
  it('plural count words are singularised and asked about', () =>
    expect(resolveAmount({ raw: '2 bunches dill', qty: 2, unit: 'bunches', name: 'dill' }, kg, null))
      .toEqual({ qty: null, unit: null, status: 'CHECK', reason: '2 bunches — how much is a bunch?' }))
  it('plural learned word matches the singular learned word', () =>
    expect(resolveAmount({ raw: '2 cloves garlic', qty: 2, unit: 'cloves', name: 'garlic' }, kg, { word: 'clove', qty: 5, unit: 'g' }))
      .toEqual({ qty: 10, unit: 'g', status: 'MATCHED', reason: null }))
  it('converts a learned measure into the item base unit', () =>
    expect(resolveAmount({ raw: '2 cans', qty: 2, unit: 'can', name: 'tomatoes' }, kg, { word: 'can', qty: 0.4, unit: 'kg' }))
      .toEqual({ qty: 800, unit: 'g', status: 'MATCHED', reason: null }))
  it('converts within a dimension into the item base unit', () =>
    expect(resolveAmount({ raw: '0.5 kg', qty: 0.5, unit: 'kg', name: 'x' }, kg, null))
      .toEqual({ qty: 500, unit: 'g', status: 'MATCHED', reason: null }))
  it('volume units convert silently for a volume item', () =>
    expect(resolveAmount({ raw: '2 tbsp oil', qty: 2, unit: 'tbsp', name: 'oil' }, litre, null))
      .toEqual({ qty: 29.5736, unit: 'ml', status: 'MATCHED', reason: null }))
  it('ml on a weighed item with no density and no estimate asks for the weight', () =>
    expect(resolveAmount({ raw: '100 ml honey', qty: 100, unit: 'ml', name: 'honey' }, kg, null))
      .toEqual({ qty: null, unit: null, status: 'CHECK', reason: '100 ml — how many g?' }))
  it('g on a volume item with no density and no estimate asks for the volume', () =>
    expect(resolveAmount({ raw: '100 g stock', qty: 100, unit: 'g', name: 'stock' }, litre, null))
      .toEqual({ qty: null, unit: null, status: 'CHECK', reason: '100 g — how many ml?' }))

  // Weight <-> volume with no density: never assume water (2 cups flour is not 2 g, nor 473 g).
  it('2 cups flour on a weighed item uses the reader’s gram estimate and flags CHECK', () =>
    expect(resolveAmount({ raw: '2 cups flour', qty: 2, unit: 'cups', name: 'flour', estimate: { qty: 240, unit: 'g' } }, kg, null))
      .toEqual({ qty: 240, unit: 'g', status: 'CHECK', reason: '2 cups — about 240 g, check' }))
  it('2 cups flour with no estimate asks how many g, with no amount', () =>
    expect(resolveAmount({ raw: '2 cups flour', qty: 2, unit: 'cup', name: 'flour' }, kg, null))
      .toEqual({ qty: null, unit: null, status: 'CHECK', reason: '2 cups — how many g?' }))
  it('1 tbsp sugar with an estimate in the wrong family still asks', () =>
    expect(resolveAmount({ raw: '1 tbsp sugar', qty: 1, unit: 'tbsp', name: 'sugar', estimate: { qty: 15, unit: 'ml' } }, kg, null))
      .toEqual({ qty: null, unit: null, status: 'CHECK', reason: '1 tbsp — how many g?' }))
  it('an estimate in kg is shown in the item’s own unit', () =>
    expect(resolveAmount({ raw: '2 cups flour', qty: 2, unit: 'cup', name: 'flour', estimate: { qty: 0.24, unit: 'kg' } }, kg, null))
      .toEqual({ qty: 240, unit: 'g', status: 'CHECK', reason: '2 cups — about 240 g, check' }))
  it('grams of a liquid on a volume item uses the ml estimate', () =>
    expect(resolveAmount({ raw: '200 g cream', qty: 200, unit: 'g', name: 'cream', estimate: { qty: 195, unit: 'ml' } }, litre, null))
      .toEqual({ qty: 195, unit: 'ml', status: 'CHECK', reason: '200 g — about 195 ml, check' }))
  it('a count-word estimate across weight/volume is not passed through 1:1', () =>
    expect(resolveAmount({ raw: '1 bunch parsley', qty: 1, unit: 'bunch', name: 'parsley', estimate: { qty: 2, unit: 'tbsp' } }, kg, null))
      .toEqual({ qty: null, unit: null, status: 'CHECK', reason: '1 bunch — how much is a bunch?' }))
  it('a learned measure across weight/volume is not passed through 1:1', () =>
    expect(resolveAmount({ raw: '1 bunch parsley', qty: 1, unit: 'bunch', name: 'parsley' }, kg, { word: 'bunch', qty: 30, unit: 'ml' }))
      .toEqual({ qty: null, unit: null, status: 'CHECK', reason: '1 bunch — how much is a bunch?' }))
  it('weight to volume with a density converts silently', () =>
    expect(resolveAmount({ raw: '100 ml honey', qty: 100, unit: 'ml', name: 'honey' }, { ...kg, densityGPerMl: 1.4 }, null))
      .toEqual({ qty: 140, unit: 'g', status: 'MATCHED', reason: null }))
  it('grams of a counted item convert through the each-measure', () =>
    expect(resolveAmount({ raw: '100 g egg', qty: 100, unit: 'g', name: 'egg' }, egg, null))
      .toEqual({ qty: 2, unit: 'each', status: 'MATCHED', reason: null }))
  it('grams of a counted item with no each-measure asks', () => {
    const r = resolveAmount({ raw: '100 g egg', qty: 100, unit: 'g', name: 'egg' }, { ...egg, eachMeasureQty: null, eachMeasureUnit: null }, null)
    expect(r.status).toBe('CHECK'); expect(r.qty).toBeNull(); expect(r.unit).toBeNull()
  })
  it('bare number on a counted item is that many each', () =>
    expect(resolveAmount({ raw: '3 eggs', qty: 3, unit: null, name: 'egg' }, egg, null))
      .toEqual({ qty: 3, unit: 'each', status: 'MATCHED', reason: null }))
  it('"each" on a weighed item uses the each-measure', () =>
    expect(resolveAmount({ raw: '2 onions', qty: 2, unit: 'each', name: 'onion' }, onion, null))
      .toEqual({ qty: 300, unit: 'g', status: 'MATCHED', reason: null }))
  it('a count word on a counted item with a learned each measure', () =>
    expect(resolveAmount({ raw: '1 dozen eggs', qty: 1, unit: 'dozen', name: 'egg' }, egg, null))
      .toEqual({ qty: 12, unit: 'each', status: 'MATCHED', reason: null }))
  it('estimate in a unit that cannot cost against the item falls back to asking', () => {
    const r = resolveAmount({ raw: '1 bunch dill', qty: 1, unit: 'bunch', name: 'dill', estimate: { qty: 3, unit: 'each' } }, kg, null)
    expect(r).toEqual({ qty: null, unit: null, status: 'CHECK', reason: '1 bunch — how much is a bunch?' })
  })
  it('a learned measure for a different word is ignored', () =>
    expect(resolveAmount({ raw: '1 bunch dill', qty: 1, unit: 'bunch', name: 'dill' }, kg, { word: 'clove', qty: 5, unit: 'g' }).status).toBe('CHECK'))

  it('odd quantities never produce NaN', () => {
    const odd = [NaN, Infinity, -Infinity, -2, 0]
    for (const q of odd) {
      const r = resolveAmount({ raw: 'x', qty: q, unit: 'g', name: 'x' }, kg, null)
      expect(r).toEqual({ qty: 0, unit: 'g', status: 'NO_AMOUNT', reason: null })
    }
    const r = resolveAmount({ raw: 'x', qty: 3, unit: 'clove', name: 'x', estimate: { qty: NaN, unit: 'g' } }, kg, { word: 'clove', qty: NaN, unit: 'g' })
    expect(r.status).toBe('CHECK')
    expect(r.qty === null || Number.isFinite(r.qty)).toBe(true)
  })
  it('an unmatched line with no amount is still NO_MATCH', () =>
    expect(resolveAmount({ raw: 'salt', qty: null, unit: null, name: 'salt' }, null, null))
      .toEqual({ qty: null, unit: null, status: 'NO_MATCH', reason: null }))

  it('plural measure units convert like their singular on a volume item', () => {
    expect(resolveAmount({ raw: '2 tablespoons oil', qty: 2, unit: 'tablespoons', name: 'oil' }, litre, null))
      .toEqual({ qty: 29.5736, unit: 'ml', status: 'MATCHED', reason: null })
    expect(resolveAmount({ raw: '2 teaspoons oil', qty: 2, unit: 'teaspoons', name: 'oil' }, litre, null))
      .toEqual({ qty: 9.85784, unit: 'ml', status: 'MATCHED', reason: null })
    expect(resolveAmount({ raw: '250 millilitres oil', qty: 250, unit: 'millilitres', name: 'oil' }, litre, null))
      .toEqual({ qty: 250, unit: 'ml', status: 'MATCHED', reason: null })
  })
  it('plural measure units on an item with an each-measure are not read as counts', () => {
    // onion: 150 g each. a volume on a weighed item asks for the weight — never 300 g, never 2 g.
    expect(resolveAmount({ raw: '2 tablespoons parsley', qty: 2, unit: 'tablespoons', name: 'parsley' }, onion, null))
      .toEqual({ qty: null, unit: null, status: 'CHECK', reason: '2 tbsp — how many g?' })
    expect(resolveAmount({ raw: '2 teaspoons parsley', qty: 2, unit: 'teaspoons', name: 'parsley' }, onion, null).status).toBe('CHECK')
    expect(resolveAmount({ raw: '100 millilitres x', qty: 100, unit: 'millilitres', name: 'x' }, onion, null))
      .toEqual({ qty: null, unit: null, status: 'CHECK', reason: '100 ml — how many g?' })
  })
  it('plural measure units on a counted item with an each-measure do not use the bridge wrongly', () => {
    const r = resolveAmount({ raw: '2 tablespoons x', qty: 2, unit: 'tablespoons', name: 'x' }, egg, null)
    expect(r).toEqual({ qty: null, unit: null, status: 'CHECK', reason: '2 tbsp — this item is counted, how many?' })
  })
  it('plural units in a learned measure or estimate convert too', () => {
    expect(resolveAmount({ raw: '2 cans', qty: 2, unit: 'can', name: 'x' }, litre, { word: 'can', qty: 2, unit: 'tablespoons' }))
      .toEqual({ qty: 59.1472, unit: 'ml', status: 'MATCHED', reason: null })
    expect(resolveAmount({ raw: '1 bunch', qty: 1, unit: 'bunch', name: 'x', estimate: { qty: 2, unit: 'tablespoons' } }, litre, null))
      .toEqual({ qty: 29.5736, unit: 'ml', status: 'CHECK', reason: '1 bunch — about 29.57 ml, check' })
  })
  it('a plural unit in the item each-measure is understood', () =>
    expect(resolveAmount({ raw: '2 onions', qty: 2, unit: 'each', name: 'onion' }, { ...onion, eachMeasureUnit: 'grams' }, null))
      .toEqual({ qty: 300, unit: 'g', status: 'MATCHED', reason: null }))
})
