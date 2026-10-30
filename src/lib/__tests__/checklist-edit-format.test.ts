import { describe, it, expect } from 'vitest'
import {
  chipName, chipOrder, copyName, daysToToggles, itemPills, moveId, numberPill, phaseCount,
  rangeLabel, togglesToDays, type EditItem,
} from '@/lib/checklists/edit-format'

const item = (o: Partial<EditItem> = {}): EditItem => ({
  id: 'i1', title: 'Lowboy temp', howTo: null, isBlocker: false, answer: 'TICK',
  unit: null, safeMin: null, safeMax: null, tempUnitId: null, days: 127, ...o,
})

describe('rangeLabel / numberPill', () => {
  it('two-sided, one-sided and empty', () => {
    expect(rangeLabel(0, 4)).toBe('0–4')
    expect(rangeLabel(60, null)).toBe('≥ 60')
    expect(rangeLabel(null, 4)).toBe('≤ 4')
    expect(rangeLabel(null, null)).toBe('')
    expect(rangeLabel(-18, -15)).toBe('-18–-15')
  })
  it('reads like the board', () => {
    expect(numberPill('°C', 0, 4)).toBe('NUMBER °C 0–4')
    expect(numberPill('°C', 60, null)).toBe('NUMBER °C ≥ 60')
    expect(numberPill('PPM', null, null)).toBe('NUMBER PPM')
  })
})

describe('itemPills', () => {
  it('blocker word follows the phase', () => {
    expect(itemPills(item({ isBlocker: true }), 'OPEN', null)[0]).toEqual({ label: 'BEFORE DOORS', tone: 'red' })
    expect(itemPills(item({ isBlocker: true }), 'CLOSE', null)[0]).toEqual({ label: 'BEFORE YOU LEAVE', tone: 'red' })
  })
  it('a number item shows its unit and range in blue', () => {
    expect(itemPills(item({ answer: 'NUMBER', unit: '°C', safeMin: 0, safeMax: 4 }), 'OPEN', null))
      .toEqual([{ label: 'NUMBER °C 0–4', tone: 'blue' }])
  })
  it('a temperature item names its Temps unit', () => {
    expect(itemPills(item({ answer: 'TEMP', tempUnitId: 't1' }), 'OPEN', 'Walk-in'))
      .toEqual([{ label: 'TEMP · Walk-in', tone: 'blue' }])
  })
  it('days show in gold unless every day; ticks get a grey TICK', () => {
    expect(itemPills(item({ days: 1 }), 'OPEN', null)).toEqual([
      { label: 'MON ONLY', tone: 'gold' }, { label: 'TICK', tone: 'grey' },
    ])
    expect(itemPills(item(), 'OPEN', null)).toEqual([{ label: 'TICK', tone: 'grey' }])
  })
})

describe('day toggles', () => {
  it('Monday is the first toggle and Sunday the last', () => {
    expect(daysToToggles(127)).toEqual([true, true, true, true, true, true, true])
    expect(daysToToggles(1)).toEqual([true, false, false, false, false, false, false])
    expect(daysToToggles(64)).toEqual([false, false, false, false, false, false, true])
    expect(daysToToggles(96)).toEqual([false, false, false, false, false, true, true])
  })
  it('round-trips every mask', () => {
    for (let d = 0; d <= 127; d++) expect(togglesToDays(daysToToggles(d))).toBe(d)
  })
})

describe('moveId', () => {
  it('swaps with the neighbour and stops at the ends', () => {
    expect(moveId(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c'])
    expect(moveId(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b'])
    expect(moveId(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c'])
    expect(moveId(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c'])
  })
})

describe('copyName', () => {
  it('appends " (copy)" only on a clash, ignoring case', () => {
    expect(copyName('Equipment', ['Before doors'])).toBe('Equipment')
    expect(copyName('Equipment', ['EQUIPMENT'])).toBe('Equipment (copy)')
  })
})

describe('stations', () => {
  const s = (id: string, isShared = false) => ({ id, name: id, isShared })
  it('the shared station goes first and reads "Everyone"', () => {
    expect(chipOrder([s('grill'), s('kitchen', true), s('dish')]).map(x => x.id)).toEqual(['kitchen', 'grill', 'dish'])
    expect(chipName({ name: 'Whole kitchen', isShared: true })).toBe('Everyone')
    expect(chipName({ name: 'Grill', isShared: false })).toBe('Grill')
  })
  it('counts the jobs in a phase', () => {
    const phases = {
      OPEN: [{ id: 'c1', name: 'A', items: [item(), item()] }, { id: 'c2', name: 'B', items: [item()] }],
      CLOSE: [],
    }
    expect(phaseCount({ phases }, 'OPEN')).toBe(3)
    expect(phaseCount({ phases }, 'CLOSE')).toBe(0)
  })
})
