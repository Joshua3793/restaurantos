import { describe, it, expect } from 'vitest'
import { matchIngredient, type Candidate } from '../recipe-scan/match'

function c(id: string, name: string, over: Partial<Candidate> = {}): Candidate {
  return {
    kind: 'item', id, name, active: true, mergedIntoId: null,
    usedInRecipes: 0, boughtAs: '', supplier: null, ...over,
  }
}

const none = new Map<string, { kind: 'item' | 'recipe'; id: string }>()

describe('matchIngredient', () => {
  it('alias wins over fuzzy', () => {
    const cands = [c('1', 'Sherry Vinegar'), c('2', 'Sherry Wine')]
    const aliases = new Map([['sherry vin', { kind: 'item' as const, id: '1' }]])
    const r = matchIngredient('sherry vin', 'Sherry Vin 1L', cands, aliases)
    expect(r.best?.id).toBe('1')
    expect(r.confidence).toBe('HIGH')
    expect(r.options[0].id).toBe('1')
  })

  it('falls back to the alias of the raw text', () => {
    const cands = [c('1', 'Sherry Vinegar')]
    const aliases = new Map([['sherry vin 1l', { kind: 'item' as const, id: '1' }]])
    const r = matchIngredient('vinegar thing', 'Sherry Vin 1L', cands, aliases)
    expect(r.best?.id).toBe('1')
    expect(r.confidence).toBe('HIGH')
  })

  it('exact name is HIGH', () => {
    const cands = [c('1', 'Olive Oil'), c('2', 'Olive Oil Extra Virgin')]
    const r = matchIngredient('Olive Oil Extra Virgin', '', cands, none)
    expect(r.best?.id).toBe('2')
    expect(r.confidence).toBe('HIGH')
  })

  it('close guess is MEDIUM', () => {
    const cands = [
      c('w', 'Garlic Whole', { usedInRecipes: 2 }),
      c('p', 'Garlic Peeled', { usedInRecipes: 9 }),
    ]
    const r = matchIngredient('garlic', '', cands, none)
    expect(r.best?.id).toBe('p')
    expect(r.confidence).toBe('MEDIUM')
  })

  it('nothing close is NONE but returns options', () => {
    const cands = [c('1', 'Smoked Paprika'), c('2', 'Olive Oil')]
    const r = matchIngredient('pimentón', '', cands, none)
    expect(r.best).toBeNull()
    expect(r.confidence).toBe('NONE')
    expect(r.options.map(o => o.id).sort()).toEqual(['1', '2'])
  })

  it('prep recipes are candidates', () => {
    const cands = [c('r1', 'House Romesco', { kind: 'recipe' }), c('1', 'Almonds')]
    const r = matchIngredient('romesco', '', cands, none)
    expect(r.best?.id).toBe('r1')
    expect(r.best?.kind).toBe('recipe')
    expect(r.confidence).toBe('MEDIUM')
  })

  it('inactive and merged are never offered', () => {
    const cands = [
      c('old', 'Tomato Roma', { mergedIntoId: 'new' }),
      c('new', 'Tomato Roma Fresh'),
      c('dead', 'Tomato Roma Old', { active: false }),
      c('gone', 'Tomato Roma Lost', { mergedIntoId: 'missing' }),
    ]
    const r = matchIngredient('tomato roma', '', cands, none)
    const ids = r.options.map(o => o.id)
    expect(ids).toEqual(['new'])
    expect(r.best?.id).toBe('new')
  })

  it('an alias to a merged item resolves to its target; to a dead id is ignored', () => {
    const cands = [c('old', 'A', { mergedIntoId: 'new' }), c('new', 'Shallots')]
    const merged = new Map([['eschalot', { kind: 'item' as const, id: 'old' }]])
    const r = matchIngredient('eschalot', '', cands, merged)
    expect(r.best?.id).toBe('new')
    expect(r.confidence).toBe('HIGH')

    const dead = new Map([['eschalot', { kind: 'item' as const, id: 'nope' }]])
    const r2 = matchIngredient('eschalot', '', cands, dead)
    expect(r2.confidence).toBe('NONE')
    expect(r2.best).toBeNull()
  })

  it('matches plurals: "tomatoes" -> "Tomato"', () => {
    const r = matchIngredient('tomatoes', '', [c('1', 'Tomato'), c('2', 'Basil')], none)
    expect(r.best?.id).toBe('1')
    expect(r.confidence).toBe('HIGH')
  })

  it('matches accents: "jalapeños" -> "Jalapeno"', () => {
    const r = matchIngredient('jalapeños', '', [c('1', 'Jalapeno'), c('2', 'Basil')], none)
    expect(r.best?.id).toBe('1')
    expect(r.confidence).toBe('HIGH')
  })

  it('options are the top 5, best first', () => {
    const cands = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((x, i) =>
      c(x, i === 3 ? 'Red Onion' : `Red Thing ${x}`))
    const r = matchIngredient('red onion', '', cands, none)
    expect(r.options).toHaveLength(5)
    expect(r.options[0].id).toBe('d')
  })
})
