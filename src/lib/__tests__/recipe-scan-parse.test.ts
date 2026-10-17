import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { parseExtraction, requireRecipes, NotARecipeError, ScanTooLongError } from '../recipe-scan/parse'
import { sheetToText } from '../recipe-scan/to-text'

const step = (over: Record<string, unknown> = {}) => ({
  text: 'Roast the garlic.', phase: 'Roast', minutes: 10, minutesStated: true,
  waitMinutes: null, waitNote: null, waitStated: false, ...over,
})

describe('parseExtraction', () => {
  it('parses a two-recipe payload', () => {
    const out = parseExtraction({
      recipes: [
        {
          name: 'Aioli', yieldQty: 500, yieldUnit: 'g', categoryHint: 'Sauces',
          ingredients: [
            { raw: '3 cloves garlic', qty: 3, unit: 'clove', name: 'garlic', estimate: { qty: 15, unit: 'g' } },
            { raw: 'salt to taste', qty: null, unit: null, name: 'salt' },
          ],
          steps: [step()],
        },
        { name: 'Pickles', yieldQty: null, yieldUnit: null, categoryHint: null,
          ingredients: [{ raw: '1 cucumber', qty: 1, unit: 'each', name: 'cucumber' }], steps: [] },
      ],
    })
    expect(out).toHaveLength(2)
    expect(out[0].name).toBe('Aioli')
    expect(out[0].ingredients[0].estimate).toEqual({ qty: 15, unit: 'g' })
    expect(out[0].ingredients[1].qty).toBeNull()
    expect(out[0].steps[0]).toMatchObject({ phase: 'Roast', minutes: 10, minutesStated: true })
    expect(out[1].ingredients[0].estimate).toBeNull()
  })

  it('drops empty recipes and returns [] when none are left', () => {
    const kept = parseExtraction({ recipes: [
      { name: 'Empty', ingredients: [], steps: [] },
      { name: 'Real', ingredients: [{ raw: '1 egg', qty: 1, unit: 'each', name: 'egg' }], steps: [] },
    ] })
    expect(kept.map(r => r.name)).toEqual(['Real'])
    expect(parseExtraction({ recipes: [{ name: 'Empty', ingredients: [], steps: [] }] })).toEqual([])
    expect(parseExtraction(null)).toEqual([])
    expect(parseExtraction({})).toEqual([])
  })

  it('clamps minutes and coerces numeric strings', () => {
    const [r] = parseExtraction({ recipes: [{
      name: 'X', yieldQty: '12',
      ingredients: [{ raw: '2 cups flour', qty: '2', unit: 'cup', name: 'flour' }],
      steps: [
        step({ minutes: '15' }),
        step({ minutes: -3, waitMinutes: 99999 }),
        step({ minutes: 99999 }),
      ],
    }] })
    expect(r.yieldQty).toBe(12)
    expect(r.ingredients[0].qty).toBe(2)
    expect(r.steps.map(s => s.minutes)).toEqual([15, 0, 1440])
    expect(r.steps[1].waitMinutes).toBe(1440)
  })

  it('missing raw falls back to name', () => {
    const [r] = parseExtraction({ recipes: [{
      name: 'X', ingredients: [{ name: 'butter', qty: 1, unit: 'kg' }], steps: [],
    }] })
    expect(r.ingredients[0].raw).toBe('butter')
  })
})

describe('requireRecipes', () => {
  const good = { recipes: [{ name: 'Real', ingredients: [{ raw: '1 egg', qty: 1, unit: 'each', name: 'egg' }], steps: [] }] }

  it('throws NotARecipeError for an empty list or a missing tool block', () => {
    expect(() => requireRecipes({ recipes: [] }, 'tool_use')).toThrow(NotARecipeError)
    expect(() => requireRecipes(undefined, 'tool_use')).toThrow(NotARecipeError)
    expect(() => requireRecipes({ recipes: [{ name: 'E', ingredients: [], steps: [] }] })).toThrow(NotARecipeError)
  })

  it('throws ScanTooLongError on a cut-off answer, whatever the input', () => {
    expect(() => requireRecipes(good, 'max_tokens')).toThrow(ScanTooLongError)
    expect(() => requireRecipes(undefined, 'max_tokens')).toThrow(ScanTooLongError)
    expect(() => requireRecipes({ recipes: [] }, 'max_tokens')).toThrow('Too much to read in one go')
  })

  it('returns recipes for a valid payload', () => {
    expect(requireRecipes(good, 'tool_use').map(r => r.name)).toEqual(['Real'])
    expect(requireRecipes(good, null)).toHaveLength(1)
  })
})

describe('sheetToText', () => {
  it('turns each sheet into a headed CSV block', () => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Item', 'Qty'], ['Garlic', 3]]), 'Aioli')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Cucumber', 1]]), 'Pickles')
    const text = sheetToText(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer)
    expect(text).toContain('## Aioli')
    expect(text).toContain('Garlic,3')
    expect(text).toContain('## Pickles')
    expect(text.indexOf('## Aioli')).toBeLessThan(text.indexOf('## Pickles'))
  })
})
// docxToText is not unit-tested: building a valid .docx fixture in-memory is awkward and it is a one-line mammoth call.
