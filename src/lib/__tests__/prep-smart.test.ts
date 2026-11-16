import { describe, it, expect } from 'vitest'
import {
  parFlag, isToMake, toMakeCount, rowKind, matchesFilter, filterCounts, prepListSections,
  type SmartItem,
} from '../prep-smart'

// Live values from the kitchen list (16 Nov 2026).
const item = (over: Partial<SmartItem> & { name: string }): SmartItem => ({
  id: over.name, category: 'Base Preparations', isOnList: false, prepEnabled: true,
  onHand: 0, parLevel: 4, minThreshold: 0, targetToday: null, manualPriorityOverride: null,
  unit: 'kg', linkedRecipe: null, pipeline: null,
  ...over,
})
const kimchi = item({ name: 'Kimchi (vegan)', category: 'Conserved & Pickles', parLevel: 5000, unit: 'kg', onHand: 13.6, linkedRecipe: { baseYieldQty: 13.25, yieldUnit: 'kg' } })
const hollandaise = item({ name: 'Hollandaise', category: 'Sauces & Dressings', parLevel: 4, unit: 'g' })
const pickleApples = item({ name: 'Pickle Apples', category: 'Conserved & Pickles', parLevel: 0.002, unit: 'kg' })
const pumpkin = item({ name: 'Caramelized Pumpkin Base', parLevel: 2000, unit: 'g', onHand: 2100, linkedRecipe: { baseYieldQty: 350, yieldUnit: 'g' } })
const charredCorn = item({ name: 'Charred Corn', parLevel: 0, unit: 'g', onHand: 11000 })
const biscuits = item({ name: 'Buttermilk Biscuits', category: 'Baked Goods', parLevel: 100, unit: 'each', onHand: 49, linkedRecipe: { baseYieldQty: 49, yieldUnit: 'each' } })
const pipeline = { qty: 4, readyAt: null, stageName: null, remainingActiveMinutes: 5, remainingPassiveMinutes: 0, nextActiveAt: null }

describe('parFlag — a par that cannot be right is flagged, not acted on', () => {
  it('Kimchi 5,000 kg with a 13.25 kg batch (377 batches) looks wrong', () => expect(parFlag(kimchi)).toBe('WRONG'))
  it('Hollandaise 4 g looks wrong', () => expect(parFlag(hollandaise)).toBe('WRONG'))
  it('Pickle Apples 0.002 kg (2 g) looks wrong', () => expect(parFlag(pickleApples)).toBe('WRONG'))
  it('Caramelized Pumpkin Base 2,000 g with a 350 g batch (5.7 batches) is fine', () => expect(parFlag(pumpkin)).toBeNull())
  it('Buttermilk Biscuits 100 each with a 49 each batch is fine', () => expect(parFlag(biscuits)).toBeNull())
  it('Charred Corn par 0 has no par set', () => expect(parFlag(charredCorn)).toBe('NONE'))
  it('par 0 with a day target is not "no par"', () => expect(parFlag({ ...charredCorn, targetToday: 2 })).toBeNull())
})

describe('isToMake — the one "to make" rule', () => {
  it('isToMake excludes flagged', () => expect(isToMake(kimchi, null, 600)).toBe(false))
  it('a below-par item is to make', () => expect(isToMake(biscuits, null, 600)).toBe(true))
  it('isToMake excludes on-list, cooking, switched-off and at-par items', () => {
    expect(isToMake({ ...biscuits, isOnList: true }, null, 600)).toBe(false)
    expect(isToMake({ ...biscuits, pipeline }, null, 600)).toBe(false)
    expect(isToMake({ ...biscuits, prepEnabled: false }, null, 600)).toBe(false)
    expect(isToMake(pumpkin, null, 600)).toBe(false)
  })
  it('toMakeCount counts only to-make items', () => {
    const list = [kimchi, hollandaise, biscuits, pumpkin, charredCorn, item({ name: 'Adobo Pulled Pork', unit: 'l', parLevel: 4 })]
    expect(toMakeCount(list, null, 600)).toBe(2)
  })
})

describe('rowKind and filters', () => {
  it('cooking beats listed beats flag beats make beats at par', () => {
    expect(rowKind({ ...kimchi, isOnList: true, pipeline }, null, 600)).toBe('COOKING')
    expect(rowKind({ ...kimchi, isOnList: true }, null, 600)).toBe('LISTED')
    expect(rowKind(kimchi, null, 600)).toBe('FLAG')
    expect(rowKind(biscuits, null, 600)).toBe('MAKE')
    expect(rowKind(pumpkin, null, 600)).toBe('ATPAR')
  })
  it('matchesFilter and filterCounts agree', () => {
    const list = [kimchi, hollandaise, biscuits, pumpkin, charredCorn]
    expect(filterCounts(list, null, 600)).toEqual({ ALL: 5, MAKE: 1, FIX: 2, NOPAR: 1 })
    expect(list.filter(t => matchesFilter(t, 'FIX', null, 600)).map(t => t.name)).toEqual(['Kimchi (vegan)', 'Hollandaise'])
  })
})

describe('prepListSections — the whole list by category', () => {
  it('categories are alphabetical; inside one: make → flag → listed → cooking → at par', () => {
    const adobo = item({ name: 'Adobo Pulled Pork', unit: 'l', parLevel: 4, onHand: 0 })
    const dashi = item({ name: 'Kombu-Shiitake Dashi', unit: 'l', parLevel: 20, onHand: 16, manualPriorityOverride: 'TMRW' })
    const starter = item({ name: 'Sourdough Starter (Gary)', unit: 'g', parLevel: 4 })
    const listed = item({ name: 'Biscuits on list', isOnList: true })
    const cooking = item({ name: 'Focaccia', isOnList: true, pipeline })
    const tallow = item({ name: 'Beef Tallow', parLevel: 4, onHand: 4.4 })
    const baked = item({ name: 'Sourdough Bread', category: 'Baked Goods', parLevel: 72, unit: 'each', onHand: 72 })
    const secs = prepListSections([tallow, cooking, starter, dashi, listed, adobo, baked], { ctx: null, nowMin: 600 })
    expect(secs.map(s => s.label)).toEqual(['Baked Goods', 'Base Preparations'])
    expect(secs[1].rows.map(r => r.name)).toEqual([
      'Adobo Pulled Pork', 'Kombu-Shiitake Dashi', 'Sourdough Starter (Gary)', 'Biscuits on list', 'Focaccia', 'Beef Tallow',
    ])
    expect(secs[1]).toMatchObject({ toMake: 2, flagged: 1, listed: 1, cooking: 1 })
  })
})

import { fmtAmount, fmtAmountOf, stepOnGrid, onGrid } from '../prep-smart'

describe('fmtAmount — amounts a cook can read', () => {
  it.each([
    [17055, 'g', '17.1 kg'], [2000, 'g', '2 kg'], [900, 'g', '900 g'], [0.5, 'l', '0.5 L'], [13, 'l', '13 L'],
    [1250, 'ml', '1.25 L'], [49, 'each', '49 each'], [12.9, 'kg', '12.9 kg'], [0.002, 'kg', '2 g'], [1.5, 'batch', '1.5 batch'],
    [4, 'g', '4 g'], [24000, 'g', '24 kg'], [1234567, 'ml', '1,234.6 L'],
  ])('%s %s → %s', (q, u, out) => expect(fmtAmount(q as number, u as string)).toBe(out))
  it('"have of need" uses the larger value\'s unit', () => {
    expect(fmtAmountOf(17055, 2000, 'g')).toBe('17.1 of 2 kg')
    expect(fmtAmountOf(0, 4, 'l')).toBe('0 of 4 L')
    expect(fmtAmountOf(49, 100, 'each')).toBe('49 of 100 each')
  })
})

describe('stepOnGrid — + and − land on the step grid', () => {
  it.each([
    [1.3, 0.5, 1, 1.5], [1.5, 0.5, 1, 2], [1.3, 0.5, -1, 1], [1, 0.5, -1, 0.5], [0.5, 0.5, -1, 0.5],
    [430, 25, 1, 450], [7, 1, -1, 6], [1, 1, 1, 2], [2.6, 0.5, 1, 3],
  ])('%s by %s dir %s → %s', (v, s, d, out) => expect(stepOnGrid(v as number, s as number, d as 1 | -1)).toBe(out))
  it('a batch-unit item steps by whole batches', () => expect(stepOnGrid(2, 1, 1)).toBe(3))
  it('onGrid', () => {
    expect(onGrid(1.5, 0.5)).toBe(true)
    expect(onGrid(1.3, 0.5)).toBe(false)
    expect(onGrid(450, 25)).toBe(true)
  })
})

import { fmtDeadlineWords, deadlineLabel } from '../prep-plan'

describe('deadline words', () => {
  const clock = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  it('today / tomorrow / in N days', () => {
    expect(fmtDeadlineWords(900, clock)).toBe('today 15:00')
    expect(fmtDeadlineWords(1440 + 900, clock)).toBe('tomorrow 15:00')
    expect(fmtDeadlineWords(3 * 1440 + 900, clock)).toBe('in 3 days 15:00')
  })
  it('a deadline already passed reads Now', () => {
    expect(deadlineLabel(540, 700, clock)).toBe('Now')
    expect(deadlineLabel(700, 700, clock)).toBe('Now')
    expect(deadlineLabel(900, 700, clock)).toBe('15:00')
    expect(deadlineLabel(1440 + 900, 700, clock)).toBe('TMRW 15:00')
  })
})

import { planDayContext } from '../prep-plan'
import { crewCapacity, crewSchedule, wontFitText, cookGroups, planChanges } from '../prep-smart'

describe('crew capacity and the crew schedule', () => {
  const clock = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  // Brunch 09:00–15:00, the chef plans at 11:40.
  const ctx = planDayContext([{ timeMinutes: 540, endMinutes: 900 }], 700)!
  const focaccia = item({ name: 'Focaccia', isOnList: true, manualPriorityOverride: 'CLOSE', activeMinutes: 60, passiveMinutes: 220 })
  const salsa = item({ name: 'Corn Salsa', isOnList: true, manualPriorityOverride: 'CLOSE', activeMinutes: 30, passiveMinutes: 0 })
  const lateCritical = item({ name: 'Bacon Jam', isOnList: true, manualPriorityOverride: 'PASS', activeMinutes: 35, passiveMinutes: 400 })
  const cooking = item({ name: 'Apple Sauerkraut', isOnList: true, manualPriorityOverride: 'PASS', pipeline: { ...pipeline, remainingActiveMinutes: 10, remainingPassiveMinutes: 600 } })

  it('null without crew', () => expect(crewCapacity([focaccia], 0, ctx)).toBeNull())
  it('null without ctx (no services today)', () => expect(crewCapacity([focaccia], 2, null)).toBeNull())
  it('2 cooks from 11:40 to 15:00 = 400 min of hands; cooking jobs count what is left', () => {
    expect(crewCapacity([focaccia, salsa, cooking], 2, ctx)).toEqual({ hands: 400, needs: 100, fits: true })
    expect(crewCapacity([focaccia, salsa, cooking], 2, ctx)!.fits).toBe(true)
    expect(crewCapacity([focaccia, { ...salsa, activeMinutes: 400 }], 1, ctx)!.fits).toBe(false)
  })
  it('no crew → no schedule, so no won\'t-fit at all', () => {
    expect(crewSchedule([focaccia], 0, ctx, 700).size).toBe(0)
    expect(crewSchedule([focaccia], 2, null, 700).size).toBe(0)
  })
  it('an over-long Focaccia runs 80 min over with 2 cooks', () => {
    const s = crewSchedule([focaccia, salsa], 2, ctx, 700)
    expect(s.get('Focaccia')).toMatchObject({ fits: false, over: 80, deadline: 900 })
    expect(s.get('Corn Salsa')!.fits).toBe(true)
  })
  it('crewSchedule skips pipeline and passed deadlines', () => {
    const s = crewSchedule([cooking, lateCritical], 1, ctx, 700)
    expect(s.get('Apple Sauerkraut')).toMatchObject({ fits: true, over: 0 })
    expect(s.get('Bacon Jam')).toMatchObject({ fits: true, over: 0 })
  })
  it('wontFitText says it in hours and minutes', () => {
    const slot = crewSchedule([focaccia], 2, ctx, 700).get('Focaccia')!
    expect(wontFitText(slot, 2, clock)).toBe("won't be ready by 15:00 — 1 h 20 min over with 2 cooks")
    expect(wontFitText(slot, 1, clock)).toBe("won't be ready by 15:00 — 1 h 20 min over with 1 cook")
  })
})

describe('cook groups and plan changes', () => {
  const log = (o: object) => ({ todayLog: { assignedTo: null, postedAt: null, status: 'NOT_STARTED', ...o } })
  const a = { ...item({ name: 'A', isOnList: true }), ...log({ assignedTo: 'anju' }) }
  const b = { ...item({ name: 'B', isOnList: true }), ...log({ assignedTo: 'liam' }) }
  const c = { ...item({ name: 'C', isOnList: true }), ...log({ assignedTo: 'carson' }) }
  const d = { ...item({ name: 'D', isOnList: true }), ...log({}) }
  it('crew first in crew order, then other cooks, then Open', () => {
    const cooks = [{ id: 'anju', name: 'Anju' }, { id: 'carson', name: 'Carson' }, { id: 'liam', name: 'Liam' }]
    expect(cookGroups([d, c, a, b], cooks, ['liam', 'anju']).map(g => [g.label, g.rows.map(r => r.name)]))
      .toEqual([['Liam', ['B']], ['Anju', ['A']], ['Carson', ['C']], ['Open', ['D']]])
  })
  it('added, removed, unchanged and cooking since the last post', () => {
    const added = { ...item({ name: 'Bacon Jam', isOnList: true }), ...log({}) }
    const kept = { ...item({ name: 'Biscuits', isOnList: true }), ...log({ postedAt: '2026-11-16T16:00:00Z' }) }
    const removed = { ...item({ name: 'Hash' }), ...log({ postedAt: '2026-11-16T16:00:00Z' }) }
    const doneAndGone = { ...item({ name: 'Chimichurri' }), ...log({ postedAt: '2026-11-16T16:00:00Z', status: 'DONE' }) }
    const cooking = { ...item({ name: 'Focaccia', isOnList: true, pipeline }), ...log({ postedAt: '2026-11-16T16:00:00Z', status: 'IN_PROGRESS' }) }
    const ch = planChanges([added, kept, removed, doneAndGone, cooking])
    expect(ch.added.map(t => t.name)).toEqual(['Bacon Jam'])
    expect(ch.removed.map(t => t.name)).toEqual(['Hash'])
    expect(ch.cooking.map(t => t.name)).toEqual(['Focaccia'])
    expect(ch.unchanged).toBe(1)
  })
})

describe('review fixes', () => {
  it('evening planning counts tomorrow\'s hands, not the night', () => {
    // Brunch 09:00–15:00; the chef plans for tomorrow at 22:30.
    const ctx = planDayContext([{ timeMinutes: 540, endMinutes: 900 }], 1350)!
    expect(ctx.roll).toBe(1440)
    const job = item({ name: 'Corn Salsa', isOnList: true, manualPriorityOverride: 'CLOSE', activeMinutes: 30, passiveMinutes: 0 })
    // tomorrow's prep starts 2 h before doors (07:00) → 07:00..15:00 = 480 min per cook
    expect(crewCapacity([job], 2, ctx)).toEqual({ hands: 960, needs: 30, fits: true })
    expect(crewSchedule([job], 1, ctx, 1350).get('Corn Salsa')!.start).toBe(1440 + 420)
  })
  it('the stepper shows every 25 g step exactly', () => {
    expect(fmtAmount(1025, 'g', { exact: true })).toBe('1,025 g')
    expect(fmtAmount(1250, 'ml', { exact: true })).toBe('1,250 ml')
    expect(fmtAmount(1.5, 'kg', { exact: true })).toBe('1.5 kg')
  })
  it('kg and L under 10 keep two decimals', () => {
    expect(fmtAmount(0.75, 'kg')).toBe('0.75 kg')
    expect(fmtAmount(1250, 'ml')).toBe('1.25 L')
    expect(fmtAmountOf(40, 400, 'g')).toBe('40 of 400 g')
    expect(fmtAmountOf(0.04, 0.4, 'kg')).toBe('0.04 of 0.4 kg')
  })
})

describe('live-test wording', () => {
  const clock = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  it('a deadline tomorrow is said in words, not "TMRW"', () => {
    expect(wontFitText({ start: 0, end: 0, deadline: 1440 + 660, fits: false, over: 30 }, 2, clock))
      .toBe("won't be ready by tomorrow 11:00 — 30 min over with 2 cooks")
  })
})
