import { describe, it, expect } from 'vitest'
import { computeSplit, cappedAway, effectiveHours, breakdown, sortPeople } from '@/lib/tips/engine'
import type { TipPerson, TipRoleDef, Denom } from '@/lib/tips/types'

const ROLES: TipRoleDef[] = [
  { id: 'lead', name: 'Lead', multiplier: 1.5, sortOrder: 0 },
  { id: 'dish', name: 'Dish', multiplier: 1, sortOrder: 1 },
]

function person(over: Partial<TipPerson> & { cookId: string; name: string }): TipPerson {
  return {
    lastName: null, clockId: null, wage: null, roleId: 'dish', onPool: true,
    dailyHourCap: null,
    hours: Array(4).fill(0), boosts: Array(4).fill(1), edited: Array(4).fill(false),
    ...over,
  }
}

describe('effectiveHours', () => {
  it('returns the raw hours when the person is uncapped', () => {
    const p = person({ cookId: 'a', name: 'A', hours: [12, 4, 0, 0] })
    expect(effectiveHours(p, 0)).toBe(12)
  })

  it("clamps to the person's own cap", () => {
    const p = person({ cookId: 'a', name: 'A', hours: [12, 4, 0, 0], dailyHourCap: 10 })
    expect(effectiveHours(p, 0)).toBe(10)
    expect(effectiveHours(p, 1)).toBe(4)
  })

  it('caps two people on the same shift differently', () => {
    const eight = person({ cookId: 'a', name: 'Eight', hours: [11, 0, 0, 0], dailyHourCap: 8 })
    const ten = person({ cookId: 'b', name: 'Ten', hours: [11, 0, 0, 0], dailyHourCap: 10 })
    expect(effectiveHours(eight, 0)).toBe(8)
    expect(effectiveHours(ten, 0)).toBe(10)
  })

  it('reports what each cap clipped away', () => {
    const p = person({ cookId: 'a', name: 'A', hours: [11.5, 0, 0, 0], dailyHourCap: 8 })
    expect(cappedAway(p, 0)).toBeCloseTo(3.5, 6)
    expect(cappedAway(person({ cookId: 'b', name: 'B', hours: [11.5, 0, 0, 0] }), 0)).toBe(0)
  })
})

describe('per-person caps in the split', () => {
  it('pays the 8 h cook for 8 h and the 10 h cook for 10 h on the same day', () => {
    const r = computeSplit({
      basis: [1800, 0, 0, 0], poolRatePct: 10, roundingStepCents: 100, roles: ROLES,
      people: [
        person({ cookId: 'a', name: 'Ana', hours: [12, 0, 0, 0], dailyHourCap: 8 }),
        person({ cookId: 'b', name: 'Bo', hours: [12, 0, 0, 0], dailyHourCap: 10 }),
      ],
    })
    const ana = r.people.find(p => p.cookId === 'a')!
    const bo = r.people.find(p => p.cookId === 'b')!
    expect(ana.hoursTotal).toBe(8)
    expect(bo.hoursTotal).toBe(10)
    // weighted 8 + 10 = 18 → $180 pool splits 80 / 100
    expect(ana.tip).toBeCloseTo(80, 6)
    expect(bo.tip).toBeCloseTo(100, 6)
  })

  it('leaves an uncapped person on their full clocked hours', () => {
    const r = computeSplit({
      basis: [1000, 0, 0, 0], poolRatePct: 10, roundingStepCents: 100, roles: ROLES,
      people: [person({ cookId: 'a', name: 'Ana', hours: [13.25, 0, 0, 0] })],
    })
    expect(r.people[0].hoursTotal).toBe(13.25)
  })
})

describe('computeSplit', () => {
  const base = {
    basis: [1000, 1000, 0, 0],
    poolRatePct: 10,
    roundingStepCents: 100,
    roles: ROLES,
  }

  it('splits each day pool by weighted hours on that day', () => {
    const r = computeSplit({
      ...base,
      people: [
        person({ cookId: 'a', name: 'Ana', roleId: 'lead', hours: [10, 0, 0, 0] }),
        person({ cookId: 'b', name: 'Bo', roleId: 'dish', hours: [10, 10, 0, 0] }),
      ],
    })
    expect(r.pools).toEqual([100, 100, 0, 0])
    expect(r.poolTotal).toBeCloseTo(200, 6)
    // Day 0: weighted = 10×1.5 + 10×1 = 25 → Ana 15/25, Bo 10/25
    const ana = r.people.find(p => p.cookId === 'a')!
    const bo = r.people.find(p => p.cookId === 'b')!
    expect(ana.tip).toBeCloseTo(60, 6)
    expect(bo.tip).toBeCloseTo(140, 6) // 40 on day 0 + the whole 100 on day 1
  })

  it('distributes the pool to the cent', () => {
    const r = computeSplit({
      ...base,
      basis: [1234.56, 987.65, 543.21, 0],
      people: [
        person({ cookId: 'a', name: 'Ana', roleId: 'lead', hours: [7.33, 8.12, 0, 0] }),
        person({ cookId: 'b', name: 'Bo', hours: [9.5, 0, 6.25, 0] }),
        person({ cookId: 'c', name: 'Cy', hours: [0, 4.75, 8, 0] }),
      ],
    })
    const sum = r.people.reduce((a, p) => a + p.tip, 0)
    expect(Math.abs(sum - r.poolTotal)).toBeLessThan(0.005)
  })

  it('applies the reward multiplier only on the boosted day', () => {
    const boosted = person({ cookId: 'a', name: 'Ana', hours: [10, 0, 0, 0] })
    boosted.boosts[0] = 2
    const r = computeSplit({
      ...base,
      people: [boosted, person({ cookId: 'b', name: 'Bo', hours: [10, 0, 0, 0] })],
    })
    // Day 0 weighted = 20 + 10 = 30 → Ana 2/3 of $100
    expect(r.people.find(p => p.cookId === 'a')!.tip).toBeCloseTo(66.6667, 3)
  })

  it('excludes people who are off the pool and people with no hours', () => {
    const r = computeSplit({
      ...base,
      people: [
        person({ cookId: 'a', name: 'Ana', hours: [10, 0, 0, 0] }),
        person({ cookId: 'b', name: 'Bo', hours: [10, 0, 0, 0], onPool: false }),
        person({ cookId: 'c', name: 'Cy' }),
      ],
    })
    expect(r.people.map(p => p.cookId)).toEqual(['a'])
    expect(r.crewByDay[0]).toBe(1)
  })

  it('leaves a day pool undistributed when nobody was on shift', () => {
    const r = computeSplit({
      ...base,
      basis: [0, 0, 500, 0],
      people: [person({ cookId: 'a', name: 'Ana', hours: [8, 0, 0, 0] })],
    })
    expect(r.pools[2]).toBe(50)
    expect(r.weightedByDay[2]).toBe(0)
    expect(r.people[0].tip).toBe(0)
  })

  it('rounds envelopes to the step with largest remainder, hitting the target exactly', () => {
    const r = computeSplit({
      ...base,
      basis: [1000, 0, 0, 0],
      people: [
        person({ cookId: 'a', name: 'Ana', hours: [3, 0, 0, 0] }),
        person({ cookId: 'b', name: 'Bo', hours: [3, 0, 0, 0] }),
        person({ cookId: 'c', name: 'Cy', hours: [3, 0, 0, 0] }),
      ],
    })
    // $100 / 3 = $33.33 each; rounded to $1 the target is $100
    expect(r.envelopeTotalCents).toBe(10000)
    expect(r.people.map(p => p.envelopeCents).sort()).toEqual([3300, 3300, 3400])
  })

  it('gives back cents when the pool rounds DOWN (the mock overshoots here)', () => {
    const r = computeSplit({
      ...base,
      basis: [1004, 0, 0, 0], // pool = $100.40 → target at $1 rounding = $100
      roundingStepCents: 100,
      people: [
        person({ cookId: 'a', name: 'Ana', hours: [1, 0, 0, 0] }),
        person({ cookId: 'b', name: 'Bo', hours: [1, 0, 0, 0] }),
      ],
    })
    expect(r.envelopeTotalCents).toBe(10000)
  })
})

describe('breakdown', () => {
  const denoms: Denom[] = [
    { v: 5000, l: '$50', on: true },
    { v: 2000, l: '$20', on: true },
    { v: 500, l: '$5', on: false },
    { v: 100, l: '$1', on: true },
  ]

  it('makes the amount from the largest enabled notes first', () => {
    const b = breakdown(9300, denoms)
    expect(b.parts.map(p => [p.l, p.n])).toEqual([['$50', 1], ['$20', 2], ['$1', 3]])
    expect(b.remainder).toBe(0)
  })

  it('reports what it cannot make when a denomination is switched off', () => {
    const b = breakdown(50, denoms)
    expect(b.parts).toEqual([])
    expect(b.remainder).toBe(50)
  })
})

describe('sortPeople', () => {
  it('sorts by the requested key and direction, tie-breaking on name', () => {
    const r = computeSplit({
      basis: [1000, 0, 0, 0], poolRatePct: 10,
      roundingStepCents: 100, roles: ROLES,
      people: [
        person({ cookId: 'b', name: 'Bo', hours: [5, 0, 0, 0] }),
        person({ cookId: 'a', name: 'Ana', hours: [5, 0, 0, 0] }),
      ],
    })
    expect(sortPeople(r.people, 'name', 1).map(p => p.name)).toEqual(['Ana', 'Bo'])
    expect(sortPeople(r.people, 'name', -1).map(p => p.name)).toEqual(['Bo', 'Ana'])
  })
})
