import { describe, it, expect } from 'vitest'
import {
  parseMethod, validateMethod, methodToChain, chainBlocks, methodTotals, isTimedMethod,
  legacyToMethod, LAST_STEP_WAIT_ERROR, type MethodStep,
} from '../recipe-method'
import { resolveStages, validateStages, stageTotals, type RecipeStage } from '../prep-stages'
import { resolveActive, resolvePassive } from '../prep-runsheet'

// Smoked Brisket as the chef writes it — the spec's worked example (§2.4).
const brisket: MethodStep[] = [
  { key: 's1', phase: 'Curing',  text: 'Trim the brisket, leaving a ¼" fat cap', minutes: 25 },
  { key: 's2',                   text: 'Coat generously with Coffee Rub, massage in', minutes: 15, wait: { minutes: 720, note: 'uncovered in the walk-in' } },
  { key: 's3', phase: 'Smoking', text: 'Fire the smoker to 225°F, load fat side up', minutes: 20, wait: { minutes: 240, note: 'until deep mahogany bark, ~65°C internal' } },
  { key: 's4',                   text: 'Wrap in butcher paper with 4 tbsp tallow per piece', minutes: 10, wait: { minutes: 240, note: 'until 93°C internal' } },
  { key: 's5', phase: 'Resting', text: 'Unwrap for 30 min to stop the cook, re-wrap', minutes: 5, wait: { minutes: 120, note: 'in the cooler' } },
  { key: 's6',                   text: 'Slice against the grain, portion, log the yield', minutes: 30 },
]

describe('methodToChain — the run-sheet chain is derived, never authored', () => {
  it('Smoked Brisket: six steps and four waits derive to the nine-stage chain', () => {
    const chain = methodToChain(brisket)!
    expect(chain.map(s => `${s.kind}:${s.name}:${s.minutes}`)).toEqual([
      'ACTIVE:Curing:40',
      'PASSIVE:Curing · wait:720',
      'ACTIVE:Smoking:20',
      'PASSIVE:Smoking · wait:240',
      'ACTIVE:Wrap in butcher paper with 4 tbsp…:10',
      'PASSIVE:Smoking · wait:240',
      'ACTIVE:Resting:5',
      'PASSIVE:Resting · wait:120',
      'ACTIVE:Slice against the grain, portion, log…:30',
    ])
    expect(chain[1].note).toBe('uncovered in the walk-in')
    expect(stageTotals(chain)).toEqual({ active: 105, passive: 1320 })
    expect(methodTotals(brisket)).toEqual({ active: 105, passive: 1320 })
  })
  it('the derived chain satisfies the stage rules the run sheet relies on', () => {
    expect(validateStages(methodToChain(brisket))).toMatchObject({ ok: true })
  })
  it('keys are stable: a block takes its first step’s key, a wait its step’s key + ":wait"', () => {
    const chain = methodToChain(brisket)!
    expect(chain.map(s => s.key)).toEqual(['s1', 's2:wait', 's3', 's3:wait', 's4', 's4:wait', 's5', 's5:wait', 's6'])
  })
  it('chainBlocks says which steps each stage covers', () => {
    expect(chainBlocks(brisket).map(b => `${b.kind}:${b.stepKeys.join('+')}`)).toEqual([
      'ACTIVE:s1+s2', 'PASSIVE:s2', 'ACTIVE:s3', 'PASSIVE:s3', 'ACTIVE:s4', 'PASSIVE:s4', 'ACTIVE:s5', 'PASSIVE:s5', 'ACTIVE:s6',
    ])
  })
  it('an untimed method (plain instructions) is unstaged', () => {
    const plain: MethodStep[] = [{ key: 'a', text: 'Mix' }, { key: 'b', text: 'Bake' }]
    expect(isTimedMethod(plain)).toBe(false)
    expect(methodToChain(plain)).toBeNull()
    expect(chainBlocks(plain)).toEqual([])
    expect(methodToChain(null)).toBeNull()
    expect(methodToChain([])).toBeNull()
  })
  it('hands-on minutes with no wait is one block', () => {
    const chain = methodToChain([{ key: 'a', text: 'Mix', minutes: 30 }, { key: 'b', text: 'Bake', minutes: 60 }])!
    expect(chain).toEqual([{ key: 'a', name: 'Mix', kind: 'ACTIVE', minutes: 90 }])
  })
  it('a zero-minute block between waits is still a checkpoint the cook taps', () => {
    const chain = methodToChain([
      { key: 'a', text: 'Mix', minutes: 30, wait: { minutes: 60 } },
      { key: 'b', text: 'Flip', minutes: 2, wait: { minutes: 60 } },
      { key: 'c', text: 'Bake', minutes: 20 },
    ])!
    expect(chain.map(s => `${s.kind}:${s.minutes}`)).toEqual(['ACTIVE:30', 'PASSIVE:60', 'ACTIVE:2', 'PASSIVE:60', 'ACTIVE:20'])
  })
  it('two waits with no hands-on work between them merge into one', () => {
    const chain = methodToChain([
      { key: 'a', text: 'Mix', minutes: 30, wait: { minutes: 60, note: 'rest' } },
      { key: 'b', text: 'Leave it', wait: { minutes: 30, note: 'still resting' } },
      { key: 'c', text: 'Bake', minutes: 20 },
    ])!
    expect(chain.map(s => `${s.kind}:${s.minutes}`)).toEqual(['ACTIVE:30', 'PASSIVE:90', 'ACTIVE:20'])
    expect(chain[1].note).toBe('rest · still resting')
    expect(chainBlocks(chain && [
      { key: 'a', text: 'Mix', minutes: 30, wait: { minutes: 60 } },
      { key: 'b', text: 'Leave it', wait: { minutes: 30 } },
      { key: 'c', text: 'Bake', minutes: 20 },
    ])[1].stepKeys).toEqual(['a', 'b'])
  })
  it('a phase label carries forward until the next one', () => {
    const chain = methodToChain([
      { key: 'a', phase: 'Dough', text: 'Mix', minutes: 20, wait: { minutes: 240 } },
      { key: 'b', text: 'Shape', minutes: 10, wait: { minutes: 720 } },
      { key: 'c', phase: 'Bake', text: 'Bake', minutes: 60 },
    ])!
    expect(chain.map(s => s.name)).toEqual(['Dough', 'Dough · wait', 'Shape', 'Dough · wait', 'Bake'])
  })
  it('refuses to derive a chain that ends on a wait (a hand-edited column)', () => {
    expect(methodToChain([{ key: 'a', text: 'Mix', minutes: 30, wait: { minutes: 60 } }])).toBeNull()
  })
})

describe('validateMethod — what the recipe routes apply', () => {
  it('accepts, trims, and assigns missing keys', () => {
    const v = validateMethod([{ text: ' Mix ', minutes: '30', phase: ' ' }, { text: 'Bake', wait: null }])
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.method[0]).toMatchObject({ text: 'Mix', minutes: 30 })
      expect(v.method[0].phase).toBeUndefined()
      expect(v.method[0].key).toMatch(/^[a-z0-9]{6,}$/)
    }
  })
  it('a wait on the last step is the one structural rule, stated for the chef', () => {
    const v = validateMethod([{ key: 'a', text: 'Rub', minutes: 20, wait: { minutes: 4320 } }])
    expect(v).toEqual({ ok: false, error: LAST_STEP_WAIT_ERROR })
  })
  it('empty is fine (no method); bad shapes are not', () => {
    expect(validateMethod(null)).toEqual({ ok: true, method: [] })
    expect(validateMethod([])).toEqual({ ok: true, method: [] })
    expect(validateMethod('x')).toMatchObject({ ok: false })
    expect(validateMethod([{ text: '' }])).toMatchObject({ ok: false })
    expect(validateMethod([{ text: 'x', minutes: 1.5 }])).toMatchObject({ ok: false })
    expect(validateMethod([{ text: 'x', wait: { minutes: 0 } }, { text: 'y' }])).toMatchObject({ ok: false })
    expect(validateMethod([{ key: 'k', text: 'x' }, { key: 'k', text: 'y' }])).toMatchObject({ ok: false })
  })
  it('zero hands-on minutes is stored as absent', () => {
    const v = validateMethod([{ text: 'Plate', minutes: 0 }])
    if (v.ok) expect(v.method[0].minutes).toBeUndefined()
  })
})

describe('parseMethod — tolerant reader', () => {
  it('round-trips and rejects malformed values', () => {
    expect(parseMethod(brisket)).toEqual(brisket)
    expect(parseMethod(null)).toBeNull()
    expect(parseMethod([])).toBeNull()
    expect(parseMethod([{ key: 'a' }])).toBeNull()
    expect(parseMethod([{ key: 'a', text: 'x', wait: { minutes: 0 } }])).toBeNull()
    expect(parseMethod([{ key: 'a', text: 'x', minutes: '15' }])).toEqual([{ key: 'a', text: 'x', minutes: 15 }])
  })
})

describe('resolveStages reads the method first, then the legacy stages', () => {
  const legacy: RecipeStage[] = [{ key: 'x', name: 'Rub', kind: 'ACTIVE', minutes: 20 }]
  it('method wins when it is timed', () => {
    expect(resolveStages({ method: brisket, stages: legacy })!.length).toBe(9)
  })
  it('an untimed method falls back to the stages column; nothing → null', () => {
    expect(resolveStages({ method: [{ key: 'a', text: 'Mix' }], stages: legacy })).toEqual(legacy)
    expect(resolveStages({ method: null, stages: null })).toBeNull()
    expect(resolveStages({ method: [{ key: 'a', text: 'Mix' }], stages: null })).toBeNull()
  })
  it('the timing totals the run sheet counts back from come from the derived chain', () => {
    const i = { activeMinutesOverride: null, passiveMinutesOverride: null, passiveNoteOverride: null, linkedRecipe: { activeMinutes: 40, passiveMinutes: 2820, passiveNote: 'smoke', method: brisket } }
    expect(resolveActive(i)).toBe(105)
    expect(resolvePassive(i)).toBe(1320)
  })
})

describe('legacyToMethod — the data migration’s conversion', () => {
  it('ACTIVE stages become steps, PASSIVE stages become waits on the step before, then free-text steps', () => {
    const stages: RecipeStage[] = [
      { key: 'a', name: 'Trim, Rub and Cure', kind: 'ACTIVE', minutes: 40, note: 'Coat with the Coffee Rub.' },
      { key: 'b', name: 'Cure', kind: 'PASSIVE', minutes: 720, note: 'walk-in' },
      { key: 'c', name: 'Slice', kind: 'ACTIVE', minutes: 30 },
    ]
    const m = legacyToMethod(stages, ['Slice', 'Wipe down'])!
    expect(m).toEqual([
      { key: 'a', text: 'Trim, Rub and Cure\nCoat with the Coffee Rub.', minutes: 40, wait: { minutes: 720, note: 'walk-in' } },
      { key: 'c', text: 'Slice', minutes: 30 },
      { key: expect.any(String), text: 'Wipe down' },
    ])
    // and it derives back to the SAME chain length, which is what keeps live stageIndex values meaningful
    expect(methodToChain(m)!.length).toBe(stages.length)
  })
  it('steps only → untimed method; nothing → null', () => {
    expect(legacyToMethod(null, ['Mix', ' Bake ', ''])).toEqual([
      { key: expect.any(String), text: 'Mix' }, { key: expect.any(String), text: 'Bake' },
    ])
    expect(legacyToMethod(null, [])).toBeNull()
  })
  it('a leading PASSIVE stage keeps its place as its own row', () => {
    const m = legacyToMethod([
      { key: 'p', name: 'Soak', kind: 'PASSIVE', minutes: 600 },
      { key: 'a', name: 'Cook', kind: 'ACTIVE', minutes: 30 },
    ], null)!
    expect(m[0]).toEqual({ key: 'p', text: 'Soak', wait: { minutes: 600 } })
    expect(methodToChain(m)!.map(s => s.kind)).toEqual(['ACTIVE', 'PASSIVE', 'ACTIVE'])
  })
})
