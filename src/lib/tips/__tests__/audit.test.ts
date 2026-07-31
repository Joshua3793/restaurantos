import { describe, it, expect } from 'vitest'
import { auditPeriod } from '@/lib/tips/audit'
import { computeSplit } from '@/lib/tips/engine'
import type { PunchRow } from '@/lib/tips/audit'
import type { TipPerson, TipRoleDef } from '@/lib/tips/types'

const ROLES: TipRoleDef[] = [{ id: 'dish', name: 'Dish', multiplier: 1, sortOrder: 0 }]
const DAYS = ['Sun 12', 'Mon 13']

function person(over: Partial<TipPerson> & { cookId: string; name: string }): TipPerson {
  return {
    lastName: null, clockId: null, wage: null, roleId: 'dish', onPool: true,
    dailyHourCap: null,
    hours: [0, 0], boosts: [1, 1], edited: [false, false], ...over,
  }
}

function punch(over: Partial<PunchRow> & { clockId: string; hours: number }): PunchRow {
  return {
    firstName: 'X', lastName: 'Y', position: 'Dishwasher', department: 'Back of House',
    dayIndex: 0, status: 'Approved', note: null, ...over,
  }
}

function run(people: TipPerson[], punches: PunchRow[], over: Record<string, unknown> = {}) {
  const split = computeSplit({
    basis: [1000, 1000], poolRatePct: 10,
    roundingStepCents: 100, roles: ROLES, people,
  })
  return auditPeriod({
    dayLabels: DAYS, basis: [1000, 1000], poolBasis: 'NET_SALES',
    sales: [1000, 1000], tipsCollected: [null, null],
    roles: ROLES, people, punches, split,
    roundingStepCents: 100, poolDepartments: ['Back of House'],
    ignoredClockIds: [], missingBasisDays: [], ...over,
  })
}

describe('auditPeriod', () => {
  it('is all clear when every punch matches a roster member', () => {
    // Ana must work BOTH days: a day with a basis and nobody on shift is an
    // orphan-day error by design, which would make "all clear" unreachable.
    const r = run(
      [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 8] })],
      [punch({ clockId: '706', hours: 8 }), punch({ clockId: '706', hours: 8, dayIndex: 1 })],
    )
    expect(r.counts.error).toBe(0)
    expect(r.counts.missingHours).toBeCloseTo(0, 6)
    expect(r.counts.shifts).toBe(2)
  })

  it('raises an error for hours clocked by somebody not on the roster', () => {
    const r = run(
      [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 0] })],
      [punch({ clockId: '706', hours: 8 }), punch({ clockId: '959', hours: 7.13, firstName: 'Bevan', lastName: 'Garrett' })],
    )
    const f = r.findings.find(x => x.id === 'unknown-959')!
    expect(f.severity).toBe('error')
    expect(f.title).toContain('Bevan Garrett')
    expect(f.actions!.map(a => a.kind)).toEqual(['addPerson', 'ignoreCode'])
    expect(r.counts.missingHours).toBeCloseTo(7.13, 6)
  })

  it('drops an ignored code out of the missing-hours total', () => {
    const r = run(
      [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 0] })],
      [punch({ clockId: '706', hours: 8 }), punch({ clockId: '959', hours: 7.13 })],
      { ignoredClockIds: ['959'] },
    )
    expect(r.findings.some(f => f.id === 'unknown-959')).toBe(false)
    expect(r.counts.missingHours).toBeCloseTo(0, 6)
  })

  it('flags unapproved punches as unpaid', () => {
    const r = run(
      [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 0] })],
      [punch({ clockId: '706', hours: 8 }), punch({ clockId: '706', hours: 3, dayIndex: 1, status: 'Pending' })],
    )
    expect(r.findings.find(f => f.id === 'unapproved-706')!.severity).toBe('error')
  })

  it('warns when somebody who worked is switched off the pool', () => {
    const r = run(
      [
        person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 0] }),
        person({ cookId: 'b', name: 'Bo', clockId: '559', hours: [8, 0], onPool: false }),
      ],
      [punch({ clockId: '706', hours: 8 }), punch({ clockId: '559', hours: 8 })],
    )
    const f = r.findings.find(x => x.id === 'offpool-559')!
    expect(f.severity).toBe('warn')
    expect(f.actions![0].kind).toBe('onPool')
  })

  it('ignores punches from another department', () => {
    const r = run(
      [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 0] })],
      [punch({ clockId: '706', hours: 8 }), punch({ clockId: '900', hours: 6, department: 'Front of House' })],
    )
    expect(r.counts.missingHours).toBeCloseTo(0, 6)
    expect(r.ledger.find(l => l.label === 'Other department')!.value).toBeCloseTo(-6, 6)
  })

  it("warns when someone's own shift cap removes paid hours, naming them", () => {
    const r = run(
      [
        person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [12, 0], dailyHourCap: 8 }),
        person({ cookId: 'b', name: 'Bo', clockId: '559', hours: [12, 0], dailyHourCap: 10 }),
      ],
      [punch({ clockId: '706', hours: 12 }), punch({ clockId: '559', hours: 12 })],
    )
    const f = r.findings.find(x => x.id === 'cap')!
    expect(f.severity).toBe('warn')
    expect(f.title).toContain('6.00 h')      // Ana loses 4, Bo loses 2
    expect(f.detail).toContain('Ana')
    expect(f.detail).toContain('8 h cap')
    expect(f.detail).toContain('Bo')
  })

  it('raises no cap finding when nobody is capped', () => {
    const r = run(
      [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [12, 0] })],
      [punch({ clockId: '706', hours: 12 })],
    )
    expect(r.findings.some(f => f.id === 'cap')).toBe(false)
  })

  it('errors when a day has sales but nobody on shift', () => {
    const r = run(
      [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 0] })],
      [punch({ clockId: '706', hours: 8 })],
    )
    expect(r.findings.find(f => f.id === 'orphan-1')!.severity).toBe('error')
  })

  it('errors when a roster member on the pool has no employee code', () => {
    const r = run(
      [person({ cookId: 'a', name: 'Ana', hours: [8, 0] })],
      [],
    )
    expect(r.findings.find(f => f.id === 'nocode')!.severity).toBe('warn')
  })

  it('errors when the app has no basis figure for a day', () => {
    const r = run(
      [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 0] })],
      [punch({ clockId: '706', hours: 8 })],
      { missingBasisDays: [1] },
    )
    expect(r.findings.find(f => f.id === 'nobasis')!.severity).toBe('error')
  })

  it('names the missing figure after the basis in use', () => {
    const sales = run(
      [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 0] })],
      [punch({ clockId: '706', hours: 8 })],
      { missingBasisDays: [1] },
    )
    expect(sales.findings.find(f => f.id === 'nobasis')!.title).toContain('net sales')

    const tips = run(
      [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 0] })],
      [punch({ clockId: '706', hours: 8 })],
      { poolBasis: 'TIPS_COLLECTED', missingBasisDays: [1] },
    )
    expect(tips.findings.find(f => f.id === 'nobasis')!.title).toContain('tips collected')
  })

  it('closes the ledger — clocked hours equal paid plus every deduction', () => {
    const r = run(
      [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 0] })],
      [punch({ clockId: '706', hours: 8 }), punch({ clockId: '959', hours: 5 })],
    )
    expect(r.counts.unexplained).toBeCloseTo(0, 6)
  })
})

describe('the FOH → BOH tip-out', () => {
  // Both days worked, so the whole pool is distributed and no orphan-day error
  // muddies the error counts these tests assert on.
  const worker = [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 8] })]
  const punches = [punch({ clockId: '706', hours: 8 }), punch({ clockId: '706', hours: 8, dayIndex: 1 })]

  it('reports the pool as a share of the tips customers actually left', () => {
    // pool = 10% of [1000, 1000] = $200; tips collected = $800 → 25%
    const r = run(worker, punches, { tipsCollected: [400, 400] })
    const f = r.findings.find(x => x.id === 'takeout')!
    expect(f.severity).toBe('info')
    expect(f.title).toContain('25%')
    expect(f.detail).toContain('$600.00') // FOH remainder
  })

  it('warns when the sales-based pool takes more than half the tip pot', () => {
    const r = run(worker, punches, { tipsCollected: [180, 180] }) // $200 of $360 = 56%
    expect(r.findings.find(f => f.id === 'bigtakeout')!.severity).toBe('warn')
  })

  it('errors when the sales-based pool exceeds the tip pot entirely', () => {
    const r = run(worker, punches, { tipsCollected: [50, 50] }) // $200 pool vs $100 pot
    const f = r.findings.find(x => x.id === 'overdraw')!
    expect(f.severity).toBe('error')
    expect(f.detail).toContain('cannot fund')
  })

  it('never overdraws when the basis IS the tip pot', () => {
    const people = [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 8] })]
    const split = computeSplit({
      basis: [400, 400], poolRatePct: 10,
      roundingStepCents: 100, roles: ROLES, people,
    })
    const r = auditPeriod({
      dayLabels: DAYS, basis: [400, 400], poolBasis: 'TIPS_COLLECTED',
      sales: [1000, 1000], tipsCollected: [400, 400], roles: ROLES, people,
      punches, split, roundingStepCents: 100,
      poolDepartments: ['Back of House'], ignoredClockIds: [], missingBasisDays: [],
    })
    expect(r.findings.some(f => f.id === 'overdraw')).toBe(false)
    expect(r.findings.find(f => f.id === 'takeout')!.title).toContain('10%')
  })

  it('notes that tip data is missing without blocking a sales-based payout', () => {
    const r = run(worker, punches)
    const f = r.findings.find(x => x.id === 'notips')!
    expect(f.severity).toBe('info')
    expect(r.counts.error).toBe(0)
  })
})
