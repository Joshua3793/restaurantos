import { describe, it, expect } from 'vitest'
import { andList, linkStations, listsOf, previewList, readyBy, tidyUps } from '@/lib/checklists/builder'
import type { EditItem, EditStation, EditView } from '@/lib/checklists/edit-format'
import { isPastDue, parseDueBy, shiftMinutes } from '@/lib/checklists/rules'
import { matchCategory, planListChange } from '@/lib/checklists/links'

const item = (o: Partial<EditItem> = {}): EditItem => ({
  id: 'i', title: 'Job', howTo: null, isBlocker: false, answer: 'TICK', unit: null, safeMin: null, safeMax: null,
  tempUnitId: null, days: 127, dueBy: null, linkId: null, ...o,
})
const station = (id: string, open: EditItem[][] = [], close: EditItem[][] = [], o: Partial<EditStation> = {}): EditStation => ({
  id, name: id, color: '#71717a', isShared: false, isActive: true,
  phases: {
    OPEN: open.map((items, i) => ({ id: `${id}-o${i}`, name: `Cat ${i}`, items })),
    CLOSE: close.map((items, i) => ({ id: `${id}-c${i}`, name: `Cat ${i}`, items })),
  },
  ...o,
})
const view = (stations: EditStation[]): EditView => ({ stations, tempUnits: [] })

describe('due-by rules', () => {
  it('parses times', () => {
    expect(parseDueBy('8:45')).toBe('08:45')
    expect(parseDueBy('')).toBe(null)
    expect(parseDueBy('24:00')).toBe(undefined)
  })
  it('orders the shift day from 05:00, so 00:30 is after 23:00', () => {
    expect(shiftMinutes('00:30')).toBeGreaterThan(shiftMinutes('23:00'))
    expect(shiftMinutes('05:00')).toBeLessThan(shiftMinutes('08:45'))
  })
  it('is late only once the clock passes the time', () => {
    expect(isPastDue('08:45', '08:45')).toBe(false)
    expect(isPastDue('08:45', '08:46')).toBe(true)
    expect(isPastDue('23:00', '00:30')).toBe(true)
    expect(isPastDue('00:30', '23:00')).toBe(false)
    expect(isPastDue(null, '23:00')).toBe(false)
  })
})

describe('shared jobs', () => {
  it('plans which lists gain a copy and which copies come off; the own list always stays', () => {
    const copies = [{ id: 'a', stationId: 'grill' }, { id: 'b', stationId: 'benny' }]
    expect(planListChange(copies, ['grill', 'crew'], 'grill')).toEqual({ add: ['crew'], remove: ['b'] })
    expect(planListChange(copies, [], 'grill')).toEqual({ add: [], remove: ['b'] })
    expect(planListChange([{ id: 'a', stationId: 'grill' }], ['benny'], 'grill')).toEqual({ add: ['benny'], remove: [] })
  })
  it('lands a copy in the category of the same name, any case', () => {
    expect(matchCategory([{ id: '1', name: 'Food safety' }], ' food SAFETY ')?.id).toBe('1')
    expect(matchCategory([{ id: '1', name: 'Equipment' }], 'Food safety')).toBe(null)
  })
  it('counts the lists a job sits on', () => {
    const v = view([
      station('grill', [[item({ id: 'g', linkId: 'L' })]]),
      station('benny', [[item({ id: 'b', linkId: 'L' })]]),
      station('pastry', [[item({ id: 'p' })]]),
    ])
    const links = linkStations(v, 'OPEN')
    expect(listsOf(links, item({ linkId: 'L' }), 'grill')).toEqual(['grill', 'benny'])
    expect(listsOf(links, item(), 'pastry')).toEqual(['pastry'])
  })
})

describe('readyBy', () => {
  it('is the latest due time on the list, in shift order', () => {
    const s = station('grill', [[item({ dueBy: '08:15' }), item({ dueBy: '08:45' })], [item()]], [[item({ dueBy: '23:00' }), item({ dueBy: '00:30' })]])
    expect(readyBy(s, 'OPEN')).toBe('08:45')
    expect(readyBy(s, 'CLOSE')).toBe('00:30')
    expect(readyBy(station('x'), 'OPEN')).toBe(null)
  })
})

describe('previewList', () => {
  it('shows only the jobs that apply that weekday, numbered in list order', () => {
    const s = station('grill', [[item({ id: 'a', title: 'Hot line on' }), item({ id: 'b', title: 'Mise', days: 32 + 64 })]])
    const tue = previewList(s, 'OPEN', 1, () => null)
    expect(tue.lines.map(l => l.title)).toEqual(['Hot line on'])
    expect(tue.hidden).toBe(1)
    const sat = previewList(s, 'OPEN', 5, () => null)
    expect(sat.lines.map(l => l.title)).toEqual(['Hot line on', 'Mise'])
    expect(sat.hidden).toBe(0)
  })
  it('a temperature job takes its fridge range', () => {
    const s = station('grill', [[item({ answer: 'TEMP', tempUnitId: 't1' })]])
    const p = previewList(s, 'OPEN', 0, id => (id === 't1' ? { safeMin: 0, safeMax: 4 } : null))
    expect(p.lines[0]).toMatchObject({ unit: '°C', safeMin: 0, safeMax: 4 })
  })
})

describe('tidyUps', () => {
  it('suggests sharing the same job on several lists, not one already shared', () => {
    const v = view([
      station('alpha', [], [[item({ id: 'a', title: 'Cool down hot food' })]]),
      station('benny', [], [[item({ id: 'b', title: 'cool down  HOT food' })]]),
      station('grill', [[item({ id: 'g1', title: 'Lowboy', linkId: 'L' })]], [[item({ id: 'g', title: 'Mop' })]]),
      station('crew', [[item({ id: 'c1', title: 'Lowboy', linkId: 'L' })]]),
    ])
    const t = tidyUps(v)
    expect(t).toHaveLength(1)
    expect(t[0]).toMatchObject({ kind: 'share', phase: 'CLOSE', stations: ['alpha', 'benny'], itemIds: ['a', 'b'] })
  })
  it('never suggests sharing temperatures of different fridges', () => {
    const v = view([
      station('alpha', [[item({ id: 'a', title: 'Lowboy temp', answer: 'TEMP', tempUnitId: 'f1' })]]),
      station('benny', [[item({ id: 'b', title: 'Lowboy temp', answer: 'TEMP', tempUnitId: 'f2' })]]),
    ])
    expect(tidyUps(v)).toEqual([])
  })
  it('flags a list that is nearly all must-do, and a repeated category', () => {
    const must = [item({ isBlocker: true }), item({ isBlocker: true }), item({ isBlocker: true }), item({ isBlocker: true })]
    const s = station('benny', [must, [item({ id: 'x', title: 'Other' })]])
    s.phases.OPEN[1].name = 'cat 0'
    const t = tidyUps(view([s]))
    expect(t.map(x => x.kind)).toEqual(['merge', 'must'])
    expect(t[0]).toMatchObject({ fromId: 'benny-o1', intoId: 'benny-o0' })
    expect(t[1]).toMatchObject({ must: 4, total: 5 })
  })
  it('leaves out dismissed suggestions', () => {
    const v = view([
      station('alpha', [[item({ id: 'a', title: 'Mop' })]]),
      station('benny', [[item({ id: 'b', title: 'Mop' })]]),
    ])
    const key = tidyUps(v)[0].key
    expect(tidyUps(v, new Set([key]))).toEqual([])
  })
  it('joins names', () => {
    expect(andList(['Alpha'])).toBe('Alpha')
    expect(andList(['Alpha', 'Benny', 'Grill'])).toBe('Alpha, Benny and Grill')
  })
})
