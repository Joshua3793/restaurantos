import { describe, it, expect } from 'vitest'
import {
  parseStages, validateStages, resolveStages, stageTotals, currentStage, stageReadyAt,
  nextActiveStage, isResting, restState, stageLabel, stageElapsed, remainingChain,
  parseStageHistory, appendStageEvent, REST_GRACE_MINUTES, type RecipeStage,
} from '../prep-stages'
import { resolveActive, resolvePassive } from '../prep-runsheet'

// Sourdough: Mix (30) → Bulk (240) → Shape (20) → Proof (720) → Bake (60)
const sourdough: RecipeStage[] = [
  { key: 'mix',   name: 'Mix',   kind: 'ACTIVE',  minutes: 30 },
  { key: 'bulk',  name: 'Bulk',  kind: 'PASSIVE', minutes: 240 },
  { key: 'shape', name: 'Shape', kind: 'ACTIVE',  minutes: 20 },
  { key: 'proof', name: 'Proof', kind: 'PASSIVE', minutes: 720, note: 'overnight in the walk-in' },
  { key: 'bake',  name: 'Bake',  kind: 'ACTIVE',  minutes: 60 },
]

describe('validation — what the recipe PATCH applies', () => {
  it('accepts a well-formed chain and trims names', () => {
    const v = validateStages([{ key: 'a', name: ' Rub ', kind: 'ACTIVE', minutes: 20 }])
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.stages[0]).toEqual({ key: 'a', name: 'Rub', kind: 'ACTIVE', minutes: 20 })
  })
  it('needs at least one stage', () => {
    expect(validateStages([])).toMatchObject({ ok: false })
    expect(validateStages(null)).toMatchObject({ ok: false })
  })
  it('the last stage must be hands-on', () => {
    const v = validateStages([{ key: 'a', name: 'Rub', kind: 'ACTIVE', minutes: 20 }, { key: 'b', name: 'Cure', kind: 'PASSIVE', minutes: 4320 }])
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.error).toMatch(/last stage must be hands-on/)
  })
  it('rejects two unattended stages in a row', () => {
    const v = validateStages([
      { key: 'a', name: 'Mix', kind: 'ACTIVE', minutes: 30 },
      { key: 'b', name: 'Rest', kind: 'PASSIVE', minutes: 60 },
      { key: 'c', name: 'Rest again', kind: 'PASSIVE', minutes: 60 },
      { key: 'd', name: 'Bake', kind: 'ACTIVE', minutes: 60 },
    ])
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.error).toMatch(/merge them/)
  })
  it('minutes must be a whole number ≥ 0; keys unique; names required', () => {
    expect(validateStages([{ key: 'a', name: 'Mix', kind: 'ACTIVE', minutes: 1.5 }])).toMatchObject({ ok: false })
    expect(validateStages([{ key: 'a', name: 'Mix', kind: 'ACTIVE', minutes: -1 }])).toMatchObject({ ok: false })
    expect(validateStages([{ key: 'a', name: '', kind: 'ACTIVE', minutes: 1 }])).toMatchObject({ ok: false })
    expect(validateStages([{ key: 'a', name: 'X', kind: 'SLOW', minutes: 1 }])).toMatchObject({ ok: false })
    expect(validateStages([
      { key: 'a', name: 'Mix', kind: 'ACTIVE', minutes: 1 }, { key: 'a', name: 'Bake', kind: 'ACTIVE', minutes: 1 },
    ])).toMatchObject({ ok: false })
  })
  it('assigns a key to a new row that has none', () => {
    const v = validateStages([{ name: 'Mix', kind: 'ACTIVE', minutes: 30 }])
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.stages[0].key).toMatch(/^[a-z0-9]{6,}$/)
  })
  it('zero-minute stages are allowed (a step whose time is negligible)', () => {
    expect(validateStages([{ key: 'a', name: 'Plate', kind: 'ACTIVE', minutes: 0 }])).toMatchObject({ ok: true })
  })
})

describe('resolution — recipes without stages are UNSTAGED', () => {
  it('null / empty / malformed Json → null', () => {
    expect(resolveStages(null)).toBeNull()
    expect(resolveStages({ stages: null })).toBeNull()
    expect(resolveStages({ stages: [] })).toBeNull()
    expect(resolveStages({ stages: 'garbage' })).toBeNull()
    expect(resolveStages({ stages: [{ key: 'a', name: 'X', kind: 'ACTIVE' }] })).toBeNull()   // no minutes
    expect(parseStages([{ key: 'a', name: 'X', kind: 'ACTIVE', minutes: '15' }])).toEqual([{ key: 'a', name: 'X', kind: 'ACTIVE', minutes: 15 }])
  })
  it('a chain resolves and its totals derive', () => {
    expect(resolveStages({ stages: sourdough })).toEqual(sourdough)
    expect(stageTotals(sourdough)).toEqual({ active: 110, passive: 960 })
  })
  it('does NOT synthesize a chain from passiveMinutes', () => {
    expect(resolveStages({ stages: null, passiveMinutes: 240 } as { stages: null })).toBeNull()
  })
})

describe('resolveActive / resolvePassive read the chain, unless an override wins', () => {
  const base = { activeMinutesOverride: null, passiveMinutesOverride: null, passiveNoteOverride: null }
  it('staged recipe → Σ ACTIVE / Σ PASSIVE, ignoring the recipe minute columns', () => {
    const i = { ...base, linkedRecipe: { activeMinutes: 45, passiveMinutes: 30, passiveNote: null, stages: sourdough } }
    expect(resolveActive(i)).toBe(110)
    expect(resolvePassive(i)).toBe(960)
  })
  it('an explicit item override still wins', () => {
    const i = { ...base, activeMinutesOverride: 90, passiveMinutesOverride: 0, linkedRecipe: { activeMinutes: 45, passiveMinutes: 30, passiveNote: null, stages: sourdough } }
    expect(resolveActive(i)).toBe(90)
    expect(resolvePassive(i)).toBe(0)
  })
  it('unstaged recipe is unchanged', () => {
    const i = { ...base, linkedRecipe: { activeMinutes: 45, passiveMinutes: 30, passiveNote: null, stages: null } }
    expect(resolveActive(i)).toBe(45)
    expect(resolvePassive(i)).toBe(30)
  })
})

describe('the live log’s place in the chain', () => {
  const t0 = Date.parse('2026-09-06T14:00:00.000Z')
  it('currentStage / nextActiveStage / stageLabel', () => {
    expect(currentStage(sourdough, { stageIndex: 1 })).toEqual({ index: 1, stage: sourdough[1] })
    expect(currentStage(sourdough, { stageIndex: null })).toBeNull()
    expect(currentStage(sourdough, { stageIndex: 9 })).toBeNull()
    expect(currentStage(sourdough, null)).toBeNull()
    expect(nextActiveStage(sourdough, 1)?.index).toBe(2)
    expect(nextActiveStage(sourdough, 3)?.index).toBe(4)
    expect(nextActiveStage(sourdough, 4)).toBeNull()
    expect(stageLabel(0, 5, sourdough[0])).toBe('Mix · 1/5')
  })
  it('stageReadyAt is epoch ms — a proof entered last evening is ready this morning', () => {
    const log = { stageIndex: 3, stageEnteredAt: '2026-09-05T20:00:00.000Z' }
    expect(stageReadyAt(log, sourdough[3])).toBe(Date.parse('2026-09-06T08:00:00.000Z'))
    expect(stageReadyAt({ stageIndex: 3, stageEnteredAt: null }, sourdough[3])).toBeNull()
  })
  it('isResting: IN_PROGRESS on a PASSIVE stage only', () => {
    expect(isResting(sourdough, { status: 'IN_PROGRESS', stageIndex: 1 })).toBe(true)
    expect(isResting(sourdough, { status: 'IN_PROGRESS', stageIndex: 0 })).toBe(false)
    expect(isResting(sourdough, { status: 'NOT_STARTED', stageIndex: 1 })).toBe(false)
    expect(isResting(sourdough, { status: 'IN_PROGRESS', stageIndex: null })).toBe(false)
    expect(isResting(null, { status: 'IN_PROGRESS', stageIndex: 1 })).toBe(false)
  })
  it('restState: resting → ready → overdue only past the grace', () => {
    expect(restState(t0, t0 - 1)).toBe('resting')
    expect(restState(t0, t0)).toBe('ready')
    expect(restState(t0, t0 + (REST_GRACE_MINUTES - 1) * 60_000)).toBe('ready')
    expect(restState(t0, t0 + REST_GRACE_MINUTES * 60_000)).toBe('overdue')
  })
  it('stageElapsed floors to minutes and never goes negative', () => {
    expect(stageElapsed({ stageEnteredAt: new Date(t0 - 90_000) }, t0)).toBe(1)
    expect(stageElapsed({ stageEnteredAt: new Date(t0 + 60_000) }, t0)).toBe(0)
    expect(stageElapsed({ stageEnteredAt: null }, t0)).toBe(0)
  })
  it('remainingChain counts the rest of the current stage plus every later one', () => {
    // 100 min into the 240 min bulk: 140 left + shape 20 + proof 720 + bake 60
    const log = { stageIndex: 1, stageEnteredAt: new Date(t0 - 100 * 60_000) }
    expect(remainingChain(sourdough, log, t0)).toEqual({ active: 80, passive: 860, readyAtMs: t0 + 940 * 60_000 })
    // a stage that overran contributes nothing more
    const over = { stageIndex: 1, stageEnteredAt: new Date(t0 - 300 * 60_000) }
    expect(remainingChain(sourdough, over, t0)?.passive).toBe(720)
    expect(remainingChain(sourdough, { stageIndex: null }, t0)).toBeNull()
  })
})

describe('stage history is append-only', () => {
  it('parses tolerantly and appends', () => {
    expect(parseStageHistory(null)).toEqual([])
    expect(parseStageHistory([{ index: 0, key: 'mix', enteredAt: 'x' }, 'junk', { index: 'no' }])).toEqual([{ index: 0, key: 'mix', enteredAt: 'x' }])
    const h = appendStageEvent([{ index: 0, key: 'mix', enteredAt: 'a' }], { index: 1, key: 'bulk', enteredAt: 'b', byCookId: 'c1' })
    expect(h).toEqual([{ index: 0, key: 'mix', enteredAt: 'a' }, { index: 1, key: 'bulk', enteredAt: 'b', byCookId: 'c1' }])
  })
})
