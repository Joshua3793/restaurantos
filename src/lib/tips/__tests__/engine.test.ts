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

  it('hits the target exactly when the total rounds DOWN (the mock overshoots here)', () => {
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

  // Finding 1: rounding used to target `poolTotal`, which can include day
  // pools nobody on the roster was on shift to earn — handing that money to
  // whoever else was standing there. It must target `distributedTotal`
  // (Σ tip) instead, so envelopes never exceed what people actually earned.
  describe('envelope rounding targets distributed tips, not the whole pool', () => {
    it('pays a $0 envelope when the only pool money is on a day the person did not work', () => {
      const r = computeSplit({
        ...base,
        basis: [0, 0, 500, 0], // day 2 has a pool, but nobody on the roster worked it
        people: [person({ cookId: 'a', name: 'Ana', hours: [8, 0, 0, 0] })],
      })
      expect(r.poolTotal).toBe(50) // the pool exists...
      expect(r.distributedTotal).toBe(0) // ...but nobody earned any of it
      expect(r.people[0].tip).toBe(0)
      expect(r.people[0].envelopeCents).toBe(0) // was 100 pre-fix: paid $1 she didn't earn
    })

    it('does not dispense more cash than the liability when a day pool goes unworked', () => {
      const r = computeSplit({
        ...base,
        basis: [1000, 1000, 1000, 1000], // day 3's $100 pool has no crew
        people: [
          person({ cookId: 'a', name: 'Ana', hours: [10, 0, 0, 0] }),
          person({ cookId: 'b', name: 'Bo', hours: [0, 10, 0, 0] }),
          person({ cookId: 'c', name: 'Cy', hours: [0, 0, 10, 0] }),
        ],
      })
      expect(r.poolTotal).toBe(400)
      expect(r.distributedTotal).toBeCloseTo(300, 6)
      for (const p of r.people) {
        expect(p.tip).toBeCloseTo(100, 6)
        expect(p.envelopeCents).toBe(10000) // was 10100 pre-fix: $303 dispensed against a $300 liability
      }
      expect(r.envelopeTotalCents).toBe(30000)
    })
  })

  // Finding 3: ties in fractional remainder used to resolve by array order
  // (Array.prototype.sort is stable), so a change to the caller's roster
  // order could silently move a rounding dollar between named people.
  it('gives the same people identical envelopes regardless of input order (tie-break on cookId)', () => {
    const scenario = (peopleOrder: TipPerson[]) => computeSplit({
      ...base,
      basis: [1000, 0, 0, 0], // $100 pool, split 3 ways = $33.33... each, tied fractions
      people: peopleOrder,
    })
    const a = person({ cookId: 'a', name: 'Ana', hours: [3, 0, 0, 0] })
    const b = person({ cookId: 'b', name: 'Bo', hours: [3, 0, 0, 0] })
    const c = person({ cookId: 'c', name: 'Cy', hours: [3, 0, 0, 0] })

    const forward = scenario([a, b, c])
    const reversed = scenario([c, b, a])

    const envOf = (r: ReturnType<typeof scenario>, id: string) =>
      r.people.find(p => p.cookId === id)!.envelopeCents

    expect(envOf(forward, 'a')).toBe(envOf(reversed, 'a'))
    expect(envOf(forward, 'b')).toBe(envOf(reversed, 'b'))
    expect(envOf(forward, 'c')).toBe(envOf(reversed, 'c'))
    // and the extra dollar should land on the alphabetically-first tie
    expect(envOf(forward, 'a')).toBe(3400)
  })

  // Finding 4: a refund-heavy day can make `basis` negative; nothing should
  // ever hand a cook a negative cash envelope.
  it('floors a negative day pool at zero instead of paying a negative envelope', () => {
    const r = computeSplit({
      ...base,
      basis: [1000, -400, 0, 0], // day 1 is refund-heavy: net negative
      people: [person({ cookId: 'a', name: 'Ana', hours: [0, 8, 0, 0] })], // only works the bad day
    })
    expect(r.pools[1]).toBe(0) // clamped, not -40
    expect(r.people[0].tip).toBe(0) // was -40 pre-fix
    expect(r.people[0].envelopeCents).toBe(0) // was -4000 pre-fix
    expect(r.people[0].tip).toBeGreaterThanOrEqual(0)
    expect(r.people[0].envelopeCents).toBeGreaterThanOrEqual(0)
  })

  // Finding 5: a non-positive rounding step used to silently produce NaN
  // envelopes via division by zero (or a negative step).
  it('treats a non-positive rounding step as whole-cent rounding instead of NaN', () => {
    const r = computeSplit({
      ...base,
      basis: [1000, 0, 0, 0],
      roundingStepCents: 0,
      people: [person({ cookId: 'a', name: 'Ana', hours: [10, 0, 0, 0] })],
    })
    expect(Number.isNaN(r.people[0].envelopeCents)).toBe(false)
    expect(r.people[0].envelopeCents).toBe(10000)
  })

  // Finding 5b: a non-integer rounding step (e.g., 33.3 cents) used to produce
  // fractional cent values, breaking the integer contract.
  it('treats a non-integer rounding step as whole-cent rounding, yielding integer cents', () => {
    const r = computeSplit({
      ...base,
      basis: [1000, 1000, 0, 0],
      roundingStepCents: 33.3,
      people: [
        person({ cookId: 'a', name: 'Ana', hours: [5, 0, 0, 0] }),
        person({ cookId: 'b', name: 'Bo', hours: [5, 0, 0, 0] }),
        person({ cookId: 'c', name: 'Cy', hours: [5, 0, 0, 0] }),
      ],
    })
    // With non-integer step, it should fall back to whole-cent rounding (step = 1).
    // All envelopes should be integers.
    for (const p of r.people) {
      expect(Number.isInteger(p.envelopeCents)).toBe(true)
      expect(Number.isNaN(p.envelopeCents)).toBe(false)
    }
  })

  // Finding 6: an invariant property test. Table-driven across a spread of
  // inputs — including an unworked day pool, tied fractions, a refund day,
  // and several awkward rounding steps — this would have caught Findings
  // 1, 3, and 4 (it cannot exercise Finding 2's decrement branch: with the
  // Finding-1 fix, Σ floor(unit) <= round(Σ unit) always holds — see the
  // task-3 report for the search that confirmed this).
  describe('invariant: envelopes are non-negative, sum to the rounded distributed total, and never stray more than a step from the exact tip', () => {
    const scenarios: Array<{ name: string; input: Parameters<typeof computeSplit>[0] }> = [
      {
        name: 'simple three-way split, $1 step',
        input: {
          basis: [1000, 0, 0, 0], poolRatePct: 10, roundingStepCents: 100, roles: ROLES,
          people: [
            person({ cookId: 'a', name: 'Ana', hours: [3, 0, 0, 0] }),
            person({ cookId: 'b', name: 'Bo', hours: [3, 0, 0, 0] }),
            person({ cookId: 'c', name: 'Cy', hours: [3, 0, 0, 0] }),
          ],
        },
      },
      {
        name: 'unworked day pool, 25c step',
        input: {
          basis: [0, 0, 500, 1234.56], poolRatePct: 8.5, roundingStepCents: 25, roles: ROLES,
          people: [
            person({ cookId: 'a', name: 'Ana', roleId: 'lead', hours: [4, 0, 0, 6.5] }),
            person({ cookId: 'b', name: 'Bo', hours: [0, 0, 0, 5.25] }),
          ],
        },
      },
      {
        name: 'refund-heavy day, $5 step',
        input: {
          basis: [1000, -400, 250, 0], poolRatePct: 12, roundingStepCents: 500, roles: ROLES,
          people: [
            person({ cookId: 'a', name: 'Ana', hours: [5, 8, 0, 0] }),
            person({ cookId: 'b', name: 'Bo', hours: [0, 8, 3, 0] }),
            person({ cookId: 'c', name: 'Cy', roleId: 'lead', hours: [5, 0, 3, 0] }),
          ],
        },
      },
      {
        name: 'many tied fractions, $1 step',
        input: {
          basis: [700, 0, 0, 0], poolRatePct: 10, roundingStepCents: 100, roles: ROLES,
          people: [
            person({ cookId: 'a', name: 'Ana', hours: [1, 0, 0, 0] }),
            person({ cookId: 'b', name: 'Bo', hours: [1, 0, 0, 0] }),
            person({ cookId: 'c', name: 'Cy', hours: [1, 0, 0, 0] }),
            person({ cookId: 'd', name: 'Di', hours: [1, 0, 0, 0] }),
            person({ cookId: 'e', name: 'Ed', hours: [1, 0, 0, 0] }),
            person({ cookId: 'f', name: 'Fi', hours: [1, 0, 0, 0] }),
            person({ cookId: 'g', name: 'Gi', hours: [1, 0, 0, 0] }),
          ],
        },
      },
      {
        name: 'odd step ($3), boosted + capped hours, four days',
        input: {
          basis: [842.17, 619.4, 0, 355.02], poolRatePct: 9.25, roundingStepCents: 300, roles: ROLES,
          people: [
            person({ cookId: 'a', name: 'Ana', roleId: 'lead', dailyHourCap: 8, hours: [10.5, 6, 0, 4.25], boosts: [1, 1.5, 1, 1] }),
            person({ cookId: 'b', name: 'Bo', hours: [3, 7.75, 0, 4.25] }),
            person({ cookId: 'c', name: 'Cy', hours: [0, 0, 0, 2] }),
          ],
        },
      },
    ]

    it.each(scenarios)('$name', ({ input }) => {
      const r = computeSplit(input)
      const step = input.roundingStepCents
      expect(r.envelopeTotalCents).toBe(Math.round((r.distributedTotal * 100) / step) * step)
      for (const p of r.people) {
        expect(p.envelopeCents).toBeGreaterThanOrEqual(0)
        expect(Math.abs(p.envelopeCents / 100 - p.tip)).toBeLessThan(step / 100)
      }
    })
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
