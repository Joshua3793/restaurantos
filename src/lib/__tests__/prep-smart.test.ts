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
