import { describe, it, expect } from 'vitest'
import { cookBoard, makeText, type CookStartItem } from '../cook-start'

const ANA = { id: 'ana', name: 'Ana' }
const BEN = { id: 'ben', name: 'Ben' }

// The step is forced with the chef's override so the test does not depend on stock maths.
function job(id: string, step: 'PASS' | 'MID' | 'CLOSE' | 'TMRW', over: Partial<CookStartItem> = {}): CookStartItem {
  return {
    id, name: id, unit: 'L', onHand: 1, parLevel: 2, minThreshold: 0, targetToday: null,
    manualPriorityOverride: step, stations: [], startByMinutes: null,
    assignedCook: null,
    todayLog: { status: 'NOT_STARTED', postedAt: '2026-10-04T14:00:00Z', listOrder: null },
    ...over,
  } as unknown as CookStartItem
}

const kitchen = [
  job('Chimichurri', 'MID', { assignedCook: ANA }),
  job('Hollandaise', 'PASS', { assignedCook: ANA }),
  job('Aioli', 'PASS', { assignedCook: ANA, todayLog: { status: 'DONE', postedAt: 'x' } }),
  job('Red onion', 'CLOSE', { assignedCook: ANA, todayLog: { status: 'IN_PROGRESS', postedAt: 'x' } }),
  job('Hash browns', 'PASS', { assignedCook: BEN }),
  job('Short rib', 'PASS'),
  job('Granola', 'TMRW'),
  job('Not posted', 'PASS', { todayLog: { status: 'NOT_STARTED', postedAt: null } }),
]

describe('cookBoard — a linked cook', () => {
  const b = cookBoard(kitchen, 'ana')

  it('lists only my open jobs, most urgent step first', () => {
    expect(b.jobs.map(j => [j.item.name, j.urg])).toEqual([['Hollandaise', 'PASS'], ['Chimichurri', 'MID']])
  })

  it('counts my done and in-flight jobs separately', () => {
    expect(b.doing.map(t => t.name)).toEqual(['Red onion'])
    expect([b.done, b.total]).toEqual([1, 4])
  })

  it('offers only urgent jobs nobody has taken', () => {
    expect(b.grabs.map(j => j.item.name)).toEqual(['Short rib'])
  })
})

describe('cookBoard — the shared kitchen login', () => {
  it('shows every posted open job and no separate grabs list', () => {
    const b = cookBoard(kitchen, null)
    expect(b.jobs.map(j => j.item.name)).toEqual(['Hash browns', 'Hollandaise', 'Short rib', 'Chimichurri', 'Granola'])
    expect(b.grabs).toEqual([])
    expect([b.done, b.total]).toEqual([1, 7])
  })
})

describe('makeText', () => {
  it('reads the posted quantity the way the To Do row does', () => {
    expect(makeText(job('a', 'PASS', { todayLog: { requiredQty: 2, postedAt: 'x' } }))).toBe('Make 2 L')
    expect(makeText(job('a', 'PASS', { todayLog: { requiredQty: 1.25, postedAt: 'x' } }))).toBe('Make 1.3 L')
    expect(makeText(job('a', 'PASS', { unit: 'ml', todayLog: { requiredQty: 8000, postedAt: 'x' } }))).toBe('Make 8000 ml')
  })

  it('adds the batch count when the recipe yield allows it', () => {
    const item = job('a', 'PASS', { todayLog: { requiredQty: 4, postedAt: 'x' } })
    Object.assign(item, { linkedRecipe: { baseYieldQty: 2, yieldUnit: 'L' } })
    expect(makeText(item)).toBe('Make 4 L · ×2 batch')
  })
})
