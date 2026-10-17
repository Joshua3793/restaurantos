import { describe, it, expect } from 'vitest'
import { DIMENSION_BASE, validateChainItem, type ChainItem } from '@/lib/item-model'
import { validateMethod, type MethodStep } from '@/lib/recipe-method'
import type { DraftData, DraftLine } from '../recipe-scan/types'
import {
  applyPick, keepUncosted, confirmLine, canConfirm, setLineAmount, costSummary, timeSummary, formatMinutes,
  phaseRuns, moveStep, splitStep, mergeWithNext, deleteStep, renamePhase, startPhaseAt, patchStep,
  createItemBody, createdItemAmount, defaultCreateUnit, defaultSplitAt, needsYou,
} from '../recipe-scan/review'

function line(over: Partial<DraftLine> = {}): DraftLine {
  return {
    key: 'l1', raw: '3 cloves garlic', name: 'garlic', qtyText: '3 cloves', qty: null, unit: null,
    link: null, status: 'NO_MATCH', reason: null, allergens: null, ...over,
  }
}
function draft(lines: DraftLine[], method: MethodStep[] = [], over: Partial<DraftData> = {}): DraftData {
  return {
    name: 'House Romesco', yieldQty: 1.5, yieldUnit: 'l', yieldGuessed: false, categoryId: 'c1',
    revenueCenterId: null, lines, method, guessed: {}, siblingHints: {}, ...over,
  }
}
const gramItem = { dimension: 'MASS' as const, baseUnit: 'g', eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null }

describe('applyPick', () => {
  it('converts a real measure into the picked item’s unit and clears the sibling hint', () => {
    const d = draft([line({ raw: '200 ml olive oil', name: 'olive oil', qtyText: '200 ml' })], [], { siblingHints: { l1: 'Aioli' } })
    const out = applyPick(d, 'l1', { kind: 'item', id: 'oil', name: 'Olive Oil', amount: null, baseUnit: 'ml' })
    expect(out.lines[0]).toMatchObject({ link: { kind: 'item', id: 'oil', name: 'Olive Oil' }, qty: 200, unit: 'ml', status: 'MATCHED' })
    expect(out.siblingHints).toEqual({})
  })
  it('a count word on a weighed item asks how much (CHECK), never guesses silently', () => {
    const out = applyPick(draft([line()]), 'l1', { kind: 'item', id: 'g1', name: 'Garlic Peeled', amount: gramItem })
    expect(out.lines[0]).toMatchObject({ status: 'CHECK', qty: null, reason: '3 cloves — how much is a clove?' })
  })
  it('"to taste" becomes NO AMOUNT and a created item is flagged', () => {
    const d = draft([line({ raw: 'salt to taste', name: 'salt', qtyText: 'to taste' })])
    const out = applyPick(d, 'l1', { kind: 'item', id: 's', name: 'Salt', amount: gramItem }, { createdItem: true })
    expect(out.lines[0]).toMatchObject({ status: 'NO_AMOUNT', qty: 0, unit: 'g', createdItem: true })
  })
})

describe('line decisions', () => {
  it('keep uncosted unlinks; allergens still need choosing', () => {
    const d = draft([line({ link: { kind: 'item', id: 'x', name: 'X' }, status: 'CHECK', qty: 5, unit: 'g', createdItem: true })])
    const out = keepUncosted(d, 'l1').lines[0]
    expect(out).toMatchObject({ link: null, status: 'NO_MATCH', allergens: null })
    expect(out.createdItem).toBeUndefined()
    expect(needsYou(out)).toBe(true)
  })
  it('confirm needs an amount first', () => {
    const noAmt = draft([line({ link: { kind: 'item', id: 'g', name: 'G' }, status: 'CHECK' })])
    expect(confirmLine(noAmt, 'l1').lines[0].status).toBe('CHECK')
    const withAmt = setLineAmount(noAmt, 'l1', 15, 'g')
    expect(withAmt.lines[0].status).toBe('CHECK')
    expect(confirmLine(withAmt, 'l1').lines[0]).toMatchObject({ status: 'MATCHED', qty: 15, unit: 'g', reason: null })
  })
  it('a weight-for-cups line with no amount cannot be confirmed until a weight is typed', () => {
    const d = draft([line({ raw: '2 cups flour', qtyText: '2 cups', link: { kind: 'item', id: 'f', name: 'Flour' }, status: 'CHECK', qty: null, unit: null, reason: '2 cups — how many g?' })])
    expect(canConfirm(d.lines[0])).toBe(false)
    expect(confirmLine(d, 'l1').lines[0].status).toBe('CHECK')
    // Picking a unit first is not "no amount": the line still needs a number.
    const unitOnly = setLineAmount(d, 'l1', null, 'g')
    expect(unitOnly.lines[0]).toMatchObject({ qty: null, unit: 'g', status: 'CHECK' })
    expect(canConfirm(unitOnly.lines[0])).toBe(false)
    const typed = setLineAmount(unitOnly, 'l1', 250, 'g')
    expect(canConfirm(typed.lines[0])).toBe(true)
    expect(confirmLine(typed, 'l1').lines[0]).toMatchObject({ status: 'MATCHED', qty: 250, unit: 'g' })
  })
  it('a close guess on "to taste" (qty 0) confirms as NO AMOUNT', () => {
    const d = draft([line({ raw: 'salt to taste', qtyText: 'to taste', link: { kind: 'item', id: 's', name: 'Kosher Salt' }, status: 'CHECK', qty: 0, unit: 'g', reason: 'Close guess — check' })])
    expect(confirmLine(d, 'l1').lines[0]).toMatchObject({ status: 'NO_AMOUNT', qty: 0, reason: null })
  })
  it('an amount on a NO AMOUNT line makes it a normal line; clearing makes it NO AMOUNT', () => {
    const d = draft([line({ link: { kind: 'item', id: 's', name: 'Salt' }, status: 'NO_AMOUNT', qty: 0, unit: 'g' })])
    const a = setLineAmount(d, 'l1', 5, 'g')
    expect(a.lines[0]).toMatchObject({ status: 'MATCHED', qty: 5 })
    expect(setLineAmount(a, 'l1', null, 'g').lines[0]).toMatchObject({ status: 'NO_AMOUNT', qty: 0 })
  })
})

describe('costSummary', () => {
  it('counts costed lines and names what is missing', () => {
    const d = draft([
      line({ key: 'a', link: { kind: 'item', id: '1', name: 'A' }, status: 'MATCHED', qty: 200, unit: 'ml' }),
      line({ key: 'b', link: { kind: 'item', id: '2', name: 'B' }, status: 'CHECK', qty: 60, unit: 'ml' }),
      line({ key: 'c' }),
      line({ key: 'd', link: { kind: 'item', id: '4', name: 'Salt' }, status: 'NO_AMOUNT', qty: 0, unit: 'g' }),
      line({ key: 'e', allergens: [] }),
      line({ key: 'f', link: { kind: 'item', id: '6', name: 'New' }, status: 'MATCHED', qty: 10, unit: 'g' }),
    ])
    const s = costSummary(d, {
      a: { lineCost: 2.48, unpriced: false }, b: { lineCost: 0.71, unpriced: false }, c: { lineCost: null, unpriced: false },
      d: { lineCost: 0, unpriced: false }, e: { lineCost: null, unpriced: false }, f: { lineCost: 0, unpriced: true },
    })
    expect(s).toMatchObject({ total: 6, costed: 2, matched: 2, check: 1, noMatch: 1, kept: 1, noAmount: 1, missing: 2, unpriced: 1, complete: false })
    expect(s.batch).toBeCloseTo(3.19)
    expect(s.perYield).toBeCloseTo(3.19 / 1.5)
  })
})

describe('time', () => {
  it('adds hands-on, waits and guessed flags', () => {
    const m: MethodStep[] = [{ key: 'a', text: 'Roast', minutes: 10, wait: { minutes: 45 } }, { key: 'b', text: 'Blend', minutes: 30 }]
    expect(timeSummary(m, { a: { minutes: true, wait: true } })).toEqual({ handsOn: 40, wait: 45, guessed: 2 })
    expect(formatMinutes(40)).toBe('40 min')
    expect(formatMinutes(765)).toBe('12h 45m')
    expect(formatMinutes(720)).toBe('12 h')
  })
})

const M = (): MethodStep[] => [
  { key: 'a', text: 'Rub the peppers with oil. Roast at 450°F until blistered.', phase: 'Roast', minutes: 10, wait: { minutes: 45, note: 'in the oven' } },
  { key: 'b', text: 'Peel and seed.', phase: 'Peel & toast', minutes: 15 },
  { key: 'c', text: 'Toast the almonds.', minutes: 5 },
  { key: 'd', text: 'Blend everything.', phase: 'Blend', minutes: 10 },
]

describe('method edits', () => {
  it('reads phases as runs', () => {
    expect(phaseRuns(M()).map(r => [r.phase, r.start, r.end])).toEqual([['Roast', 0, 1], ['Peel & toast', 1, 3], ['Blend', 3, 4]])
  })
  it('moving inside a phase swaps; at the edge the step joins the next phase', () => {
    const st = { method: M(), guessed: {} }
    const swapped = moveStep(st, 2, -1).method
    expect(swapped.map(s => s.key)).toEqual(['a', 'c', 'b', 'd'])
    expect(swapped[1].phase).toBe('Peel & toast')
    expect(swapped[2].phase).toBeUndefined()
    const crossed = moveStep(st, 2, 1).method
    expect(crossed.map(s => s.key)).toEqual(['a', 'b', 'c', 'd'])
    expect(phaseRuns(crossed).map(r => [r.phase, r.start, r.end])).toEqual([['Roast', 0, 1], ['Peel & toast', 1, 2], ['Blend', 2, 4]])
    expect(validateMethod(crossed).ok).toBe(true)
  })
  it('splits at the sentence break: hands-on stays, the wait moves to the second half', () => {
    const out = splitStep({ method: M(), guessed: { a: { minutes: true, wait: true } } }, 0)
    expect(out.method[0]).toMatchObject({ text: 'Rub the peppers with oil.', minutes: 10, phase: 'Roast' })
    expect(out.method[0].wait).toBeUndefined()
    expect(out.method[1]).toMatchObject({ text: 'Roast at 450°F until blistered.', wait: { minutes: 45 } })
    expect(out.guessed).toEqual({ a: { minutes: true }, [out.method[1].key]: { wait: true } })
    expect(phaseRuns(out.method)[0]).toMatchObject({ phase: 'Roast', start: 0, end: 2 })
  })
  it('splits at a given cursor position', () => {
    expect(splitStep({ method: M(), guessed: {} }, 3, 5).method.slice(3).map(s => s.text)).toEqual(['Blend.', 'Everything.'])
    const comma = splitStep({ method: [{ key: 'x', text: 'Blend the peppers, almonds and garlic.' }], guessed: {} }, 0, 18)
    expect(comma.method.map(s => s.text)).toEqual(['Blend the peppers.', 'Almonds and garlic.'])
    expect(defaultSplitAt('one')).toBeNull()
  })
  it('merges with the next step', () => {
    const out = mergeWithNext({ method: M(), guessed: { c: { minutes: true } } }, 1)
    expect(out.method).toHaveLength(3)
    expect(out.method[1]).toMatchObject({ key: 'b', text: 'Peel and seed. Toast the almonds.', minutes: 20, phase: 'Peel & toast' })
    expect(out.guessed).toEqual({ b: { minutes: true } })
  })
  it('a mid-sentence merge does not leave a capital in the middle', () => {
    const out = mergeWithNext({ method: [{ key: 'a', text: 'Blend the peppers' }, { key: 'b', text: 'Almonds too.' }], guessed: {} }, 0)
    expect(out.method[0].text).toBe('Blend the peppers almonds too.')
  })
  it('deleting the first step of a phase keeps the phase name on the next', () => {
    const out = deleteStep({ method: M(), guessed: {} }, 1)
    expect(out.method[1]).toMatchObject({ key: 'c', phase: 'Peel & toast' })
  })
  it('renames a phase and starts a new one mid-phase', () => {
    const st = { method: M(), guessed: {} }
    expect(renamePhase(st, 1, 'Peel').method[1].phase).toBe('Peel')
    const out = startPhaseAt(st, 2, 'Toast')
    expect(phaseRuns(out.method).map(r => r.phase)).toEqual(['Roast', 'Peel & toast', 'Toast', 'Blend'])
  })
  it('editing a guessed time clears its GUESSED flag only', () => {
    const out = patchStep({ method: M(), guessed: { a: { minutes: true, wait: true } } }, 0, { minutes: 12 })
    expect(out.method[0].minutes).toBe(12)
    expect(out.guessed).toEqual({ a: { wait: true } })
    const out2 = patchStep(out, 0, { wait: { minutes: 60, note: 'in the oven' } })
    expect(out2.guessed).toEqual({})
  })
})

describe('createItemBody', () => {
  it.each(['kg', 'g', 'l', 'ml', 'each', 'bunch', 'lb', 'cup'])('builds a chain validateChainItem accepts (%s)', unit => {
    const body = createItemBody('  Pimentón  ', unit, 'rc1')
    expect(body.itemName).toBe('Pimentón')
    expect(body.isStocked).toBe(true)
    expect(body.revenueCenterId).toBe('rc1')
    expect('pricing' in body).toBe(false)
    const ci: ChainItem = {
      dimension: body.dimension, baseUnit: DIMENSION_BASE[body.dimension], packChain: body.packChain,
      // pricing omitted from the body → the column default
      pricing: { mode: 'PACK', purchasePrice: 0 }, countUnit: body.countUnit,
    }
    expect(validateChainItem(ci)).toEqual([])
    expect(createdItemAmount(body).baseUnit).toBe(DIMENSION_BASE[body.dimension])
  })
  it('kg is a 1000 g link', () => {
    expect(createItemBody('X', 'KG')).toEqual({ itemName: 'X', dimension: 'MASS', packChain: [{ unit: 'kg', per: 1000 }], countUnit: 'kg', isStocked: true })
  })
  it('refuses an unknown unit', () => {
    expect(() => createItemBody('X', 'clove')).toThrow()
  })
  it('starts on the page’s measure family', () => {
    expect(defaultCreateUnit('1 tsp')).toBe('l')
    expect(defaultCreateUnit('250 g')).toBe('kg')
    expect(defaultCreateUnit('3 cloves')).toBe('kg')
    expect(defaultCreateUnit('2 each')).toBe('each')
  })
})
