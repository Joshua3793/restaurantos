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

  it('warns when a roster member on the pool has no employee code', () => {
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

  it('telescopes the ledger through every bucket at once', () => {
    // One punch into each bucket, so the reordered loop is proved to be a
    // strict partition: lead − every deduction === the eligible subtotal.
    const r = run(
      [
        person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 8] }),
        person({ cookId: 'b', name: 'Bo', clockId: '559', hours: [0, 0], onPool: false }),
      ],
      [
        punch({ clockId: '706', hours: 8 }),
        punch({ clockId: '706', hours: 8, dayIndex: 1 }),
        punch({ clockId: '901', hours: 6, department: 'Front of House' }),  // dept
        punch({ clockId: '902', hours: 5, dayIndex: 9 }),                   // outside
        punch({ clockId: '959', hours: 4 }),                                // ignored
        punch({ clockId: '903', hours: 3 }),                                // unknown
        punch({ clockId: '559', hours: 2 }),                                // off pool
        punch({ clockId: '706', hours: 1, status: 'Pending' }),             // unapproved
      ],
      { ignoredClockIds: ['959'] },
    )
    const at = (label: string) => r.ledger.find(l => l.label === label)!.value
    expect(at('Clocked in the hours file')).toBeCloseTo(37, 6) // 8+8+6+5+4+3+2+1
    expect(at('Other department')).toBeCloseTo(-6, 6)
    expect(at('Dated outside the period')).toBeCloseTo(-5, 6)
    expect(at('Excluded on purpose')).toBeCloseTo(-4, 6)
    expect(at('Not on the tip roster')).toBeCloseTo(-3, 6)
    expect(at('Taken off the pool')).toBeCloseTo(-2, 6)
    expect(at('Not approved')).toBeCloseTo(-1, 6)
    expect(at('Eligible hours')).toBeCloseTo(16, 6)
    // 37 − 6 − 5 − 4 − 3 − 2 − 1 = 16
    const deductions = ['Other department', 'Dated outside the period', 'Not approved',
      'Not on the tip roster', 'Excluded on purpose', 'Taken off the pool']
    expect(at('Clocked in the hours file') + deductions.reduce((a, l) => a + at(l), 0))
      .toBeCloseTo(at('Eligible hours'), 6)
    expect(r.counts.unexplained).toBeCloseTo(0, 6)
  })
})

// ── CRITICAL 1 ──────────────────────────────────────────────────────────────
// A worked shift paid $0 used to net out against somebody else's extra hours
// and leave the audit reporting all clear. Reconciliation is per person now.
describe('per-person hours reconciliation', () => {
  it('errors when a roster member clocked hours the split does not pay', () => {
    // Ana worked day 0 but her roster row is [0, 0]; Bo's [8, 8] absorbs the
    // difference house-wide, so `manual` alone nets to −8 and reads as an edit.
    const r = run(
      [
        person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [0, 0] }),
        person({ cookId: 'b', name: 'Bo', clockId: '559', hours: [8, 8] }),
      ],
      [
        punch({ clockId: '706', hours: 8 }),
        punch({ clockId: '559', hours: 8 }),
        punch({ clockId: '559', hours: 8, dayIndex: 1 }),
      ],
    )
    const f = r.findings.find(x => x.id === 'hours-706')!
    expect(f.severity).toBe('error')
    expect(f.title).toContain('Ana')
    expect(f.detail).toContain('8.00 h')   // clocked
    expect(f.detail).toContain('0.00 h')   // paid by the split
    expect(f.detail).toContain('Sun 12 +8.00 h')
    expect(f.actions!.length).toBeGreaterThan(0)
    expect(r.counts.error).toBe(1)
    expect(r.counts.unreconciledHours).toBeCloseTo(8, 6)
    // The house-wide residual still tells its own (insufficient) story.
    expect(r.ledger.find(l => l.label === 'Manual edits on the split')!.value).toBeCloseTo(-8, 6)
  })

  it('raises one finding per person, not one per day', () => {
    const r = run(
      [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [0, 0] })],
      [punch({ clockId: '706', hours: 8 }), punch({ clockId: '706', hours: 6, dayIndex: 1 })],
    )
    expect(r.findings.filter(f => f.id.startsWith('hours-'))).toHaveLength(1)
    expect(r.counts.unreconciledHours).toBeCloseTo(14, 6)
  })

  it('catches a per-person swap that nets to zero house-wide', () => {
    // Ana's 8 h written onto Bo: rawHours === eligible, so `manual` is 0.
    const r = run(
      [
        person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [0, 8] }),
        person({ cookId: 'b', name: 'Bo', clockId: '559', hours: [16, 8] }),
      ],
      [
        punch({ clockId: '706', hours: 8 }), punch({ clockId: '706', hours: 8, dayIndex: 1 }),
        punch({ clockId: '559', hours: 8 }), punch({ clockId: '559', hours: 8, dayIndex: 1 }),
      ],
    )
    expect(r.ledger.find(l => l.label === 'Manual edits on the split')!.value).toBeCloseTo(0, 6)
    expect(r.findings.find(f => f.id === 'hours-706')!.severity).toBe('error')
    expect(r.findings.find(f => f.id === 'hours-559')!.severity).toBe('error')
    expect(r.counts.unreconciledHours).toBeCloseTo(16, 6)
  })

  it('catches a roster still carrying last period’s hours', () => {
    const r = run(
      [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 8] })],
      [],   // the clock file was never imported
    )
    expect(r.findings.find(f => f.id === 'hours-706')!.severity).toBe('error')
    expect(r.counts.unreconciledHours).toBeCloseTo(16, 6)
  })

  it('accepts a difference the manager marked as a manual edit', () => {
    const r = run(
      [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [10, 8], edited: [true, false] })],
      [punch({ clockId: '706', hours: 8 }), punch({ clockId: '706', hours: 8, dayIndex: 1 })],
    )
    expect(r.findings.some(f => f.id.startsWith('hours-'))).toBe(false)
    expect(r.counts.unreconciledHours).toBeCloseTo(0, 6)
    expect(r.counts.error).toBe(0)
  })

  it('reconciles a matching roster silently', () => {
    const r = run(
      [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 8] })],
      [punch({ clockId: '706', hours: 8 }), punch({ clockId: '706', hours: 8, dayIndex: 1 })],
    )
    expect(r.counts.error).toBe(0)
    expect(r.counts.unreconciledHours).toBeCloseTo(0, 6)
  })
})

// ── CRITICAL 2 ──────────────────────────────────────────────────────────────
// Status is judged last: a pending punch that could never have been paid is
// not a reason to block a payroll run.
describe('punch bucketing order', () => {
  it('does not block on a pending punch from somebody off the pool', () => {
    const r = run(
      [
        person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 8] }),
        person({ cookId: 'b', name: 'Bo', clockId: '559', hours: [0, 0], onPool: false }),
      ],
      [
        punch({ clockId: '706', hours: 8 }), punch({ clockId: '706', hours: 8, dayIndex: 1 }),
        punch({ clockId: '559', hours: 6, status: 'Pending' }),
      ],
    )
    expect(r.findings.some(f => f.id === 'unapproved-559')).toBe(false)
    expect(r.findings.find(f => f.id === 'offpool-559')!.severity).toBe('warn')
    expect(r.counts.error).toBe(0)
    expect(r.counts.missingHours).toBeCloseTo(0, 6)
    expect(r.ledger.find(l => l.label === 'Taken off the pool')!.value).toBeCloseTo(-6, 6)
  })

  it('lets the “Not kitchen” ignore action clear a pending punch', () => {
    const r = run(
      [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 8] })],
      [
        punch({ clockId: '706', hours: 8 }), punch({ clockId: '706', hours: 8, dayIndex: 1 }),
        punch({ clockId: '959', hours: 6, status: 'Pending' }),
      ],
      { ignoredClockIds: ['959'] },
    )
    expect(r.findings.some(f => f.id === 'unapproved-959')).toBe(false)
    expect(r.counts.error).toBe(0)
    expect(r.ledger.find(l => l.label === 'Excluded on purpose')!.value).toBeCloseTo(-6, 6)
  })

  it('does not block on a pending punch from another department or outside the period', () => {
    const r = run(
      [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 8] })],
      [
        punch({ clockId: '706', hours: 8 }), punch({ clockId: '706', hours: 8, dayIndex: 1 }),
        punch({ clockId: '901', hours: 6, department: 'Front of House', status: 'Pending' }),
        punch({ clockId: '902', hours: 5, dayIndex: 4, status: 'Pending' }),
      ],
    )
    expect(r.findings.some(f => f.id.startsWith('unapproved-'))).toBe(false)
    expect(r.counts.error).toBe(0)
  })

  it('reports an unmatched pending punch as unknown, not unapproved', () => {
    // 559 is both unknown and pending. Approving it would still not pay it —
    // nobody on the roster carries that code — so `unknown` is the real fault,
    // and it is the one that carries the "Add to roster" action.
    const r = run(
      [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 8] })],
      [
        punch({ clockId: '706', hours: 8 }), punch({ clockId: '706', hours: 8, dayIndex: 1 }),
        punch({ clockId: '559', hours: 6, status: 'Pending', firstName: 'Bo', lastName: 'Reyes' }),
      ],
    )
    expect(r.findings.find(f => f.id === 'unknown-559')!.severity).toBe('error')
    expect(r.findings.some(f => f.id === 'unapproved-559')).toBe(false)
    expect(r.counts.missingHours).toBeCloseTo(6, 6)
  })

  it('reports a pending punch from an on-pool roster member', () => {
    const r = run(
      [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 8] })],
      [
        punch({ clockId: '706', hours: 8 }), punch({ clockId: '706', hours: 8, dayIndex: 1 }),
        punch({ clockId: '706', hours: 3, status: 'Pending' }),
      ],
    )
    const f = r.findings.find(x => x.id === 'unapproved-706')!
    expect(f.severity).toBe('error')
    expect(r.counts.missingHours).toBeCloseTo(3, 6)
  })
})

// ── IMPORTANT 5 ─────────────────────────────────────────────────────────────
describe('malformed punch rows', () => {
  it('rejects non-finite hours and day indexes instead of letting NaN through', () => {
    const r = run(
      [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 8] })],
      [
        punch({ clockId: '706', hours: 8 }), punch({ clockId: '706', hours: 8, dayIndex: 1 }),
        punch({ clockId: '959', hours: NaN }),
        punch({ clockId: '958', hours: 4, dayIndex: NaN }),
      ],
    )
    const f = r.findings.find(x => x.id === 'malformed')!
    expect(f.severity).toBe('error')
    expect(f.title).toContain('2 shifts')
    // Nothing non-finite reaches the ledger or the counts.
    r.ledger.forEach(row => expect(Number.isFinite(row.value)).toBe(true))
    expect(Number.isFinite(r.counts.missingHours)).toBe(true)
    expect(Number.isFinite(r.counts.unreconciledHours)).toBe(true)
    expect(Number.isFinite(r.counts.eligible)).toBe(true)
    expect(r.ledger.find(l => l.label === 'Clocked in the hours file')!.value).toBeCloseTo(16, 6)
  })

  it('does not treat a NaN day index as inside the period', () => {
    const r = run(
      [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 8] })],
      [
        punch({ clockId: '706', hours: 8 }), punch({ clockId: '706', hours: 8, dayIndex: 1 }),
        punch({ clockId: '706', hours: 4, dayIndex: NaN }),
      ],
    )
    expect(r.counts.eligible).toBeCloseTo(16, 6)
    expect(r.findings.find(f => f.id === 'malformed')!.severity).toBe('error')
  })
})

// ── IMPORTANT 6 ─────────────────────────────────────────────────────────────
describe('reward boosts', () => {
  const boosted = (b: number) => {
    const p = person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 8] })
    p.boosts = [b, 1]
    return [p, person({ cookId: 'b', name: 'Bo', clockId: '559', hours: [8, 8] })]
  }
  const punches = [
    punch({ clockId: '706', hours: 8 }), punch({ clockId: '706', hours: 8, dayIndex: 1 }),
    punch({ clockId: '559', hours: 8 }), punch({ clockId: '559', hours: 8, dayIndex: 1 }),
  ]

  it('reports a boost that matches a configured tier as info', () => {
    const r = run(boosted(1.5), punches, { rewardTiers: [1.25, 1.5, 2] })
    const f = r.findings.find(x => x.id === 'boosts')!
    expect(f.severity).toBe('info')
    expect(f.detail).toContain('Ana · Sun 12 ×1.5')
    expect(r.findings.some(x => x.id === 'boost-offtier')).toBe(false)
  })

  it('warns on a boost that is not a configured tier', () => {
    const r = run(boosted(5), punches, { rewardTiers: [1.25, 1.5, 2] })
    const f = r.findings.find(x => x.id === 'boost-offtier')!
    expect(f.severity).toBe('warn')
    expect(f.detail).toContain('Ana · Sun 12 ×5')
    expect(f.actions![0].kind).toBe('goto')
    expect(r.findings.some(x => x.id === 'boosts')).toBe(false)
  })

  it('treats every boost as info when no tiers are configured', () => {
    const r = run(boosted(5), punches)
    expect(r.findings.find(x => x.id === 'boosts')!.severity).toBe('info')
    expect(r.findings.some(x => x.id === 'boost-offtier')).toBe(false)
  })

  it('says nothing when nobody is boosted', () => {
    const r = run(boosted(1), punches, { rewardTiers: [1.5] })
    expect(r.findings.some(x => x.id === 'boosts' || x.id === 'boost-offtier')).toBe(false)
  })
})

describe('basis days', () => {
  it('separates a negative basis day from one that simply took nothing', () => {
    const people = [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 8] })]
    const punches = [punch({ clockId: '706', hours: 8 }), punch({ clockId: '706', hours: 8, dayIndex: 1 })]
    const neg = auditPeriod({
      dayLabels: DAYS, basis: [1000, -500], poolBasis: 'NET_SALES',
      sales: [1000, -500], tipsCollected: [null, null], roles: ROLES, people, punches,
      split: computeSplit({ basis: [1000, -500], poolRatePct: 10, roundingStepCents: 100, roles: ROLES, people }),
      roundingStepCents: 100, poolDepartments: ['Back of House'],
      ignoredClockIds: [], missingBasisDays: [],
    })
    const f = neg.findings.find(x => x.id === 'negbasis')!
    expect(f.severity).toBe('warn')
    expect(f.detail).toContain('−$500.00')   // sign outside the dollar mark
    expect(f.detail).not.toContain('$-500')
    expect(neg.findings.some(x => x.id === 'zerobasis')).toBe(false)

    const zero = auditPeriod({
      dayLabels: DAYS, basis: [1000, 0], poolBasis: 'NET_SALES',
      sales: [1000, 0], tipsCollected: [null, null], roles: ROLES, people, punches,
      split: computeSplit({ basis: [1000, 0], poolRatePct: 10, roundingStepCents: 100, roles: ROLES, people }),
      roundingStepCents: 100, poolDepartments: ['Back of House'],
      ignoredClockIds: [], missingBasisDays: [],
    })
    expect(zero.findings.find(x => x.id === 'zerobasis')!.severity).toBe('warn')
    expect(zero.findings.some(x => x.id === 'negbasis')).toBe(false)
  })
})

describe('finding presentation', () => {
  it('gives the orphan-day error an in-app action like every other error', () => {
    const r = run(
      [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 0] })],
      [punch({ clockId: '706', hours: 8 })],
    )
    const f = r.findings.find(x => x.id === 'orphan-1')!
    expect(f.actions!.length).toBeGreaterThan(0)
    // Every blocking finding must offer the manager somewhere to go.
    r.findings.filter(x => x.severity === 'error').forEach(x => {
      expect(x.id === 'unapproved-706' || (x.actions?.length ?? 0) > 0).toBe(true)
    })
  })

  it('formats a $2.50 rounding step as money', () => {
    const people = [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 8] })]
    const split = computeSplit({ basis: [1001, 1000], poolRatePct: 10, roundingStepCents: 250, roles: ROLES, people })
    const r = auditPeriod({
      dayLabels: DAYS, basis: [1001, 1000], poolBasis: 'NET_SALES',
      sales: [1001, 1000], tipsCollected: [null, null], roles: ROLES, people,
      punches: [punch({ clockId: '706', hours: 8 }), punch({ clockId: '706', hours: 8, dayIndex: 1 })],
      split, roundingStepCents: 250, poolDepartments: ['Back of House'],
      ignoredClockIds: [], missingBasisDays: [],
    })
    const f = r.findings.find(x => x.id === 'drift')!
    expect(f.detail).toContain('$2.50')
    expect(f.detail).not.toContain('$2.5.')
  })

  it('leaves the manual row in exactly one state at every magnitude', () => {
    // `warn: > 0.005` against `muted: < 0.005` left the boundary in neither.
    for (const clocked of [8, 8.004, 8.005, 8.006, 8.01, 9]) {
      const r = run(
        [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 8], edited: [true, true] })],
        [punch({ clockId: '706', hours: clocked }), punch({ clockId: '706', hours: 8, dayIndex: 1 })],
      )
      const row = r.ledger.find(l => l.label === 'Manual edits on the split')!
      expect(row.warn === true || row.muted === true).toBe(true)
    }
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

  it('says something when only SOME days have tip data', () => {
    // The tip-out findings need a complete pot, so they stay suppressed — but
    // partial data used to fall between the branches and say nothing at all.
    const r = run(worker, punches, { tipsCollected: [400, null] })
    const f = r.findings.find(x => x.id === 'notips')!
    expect(f.severity).toBe('info')
    expect(f.title).toContain('1 day')
    expect(f.detail).toContain('Mon 13')
    expect(r.findings.some(x => ['takeout', 'bigtakeout', 'overdraw'].includes(x.id))).toBe(false)
  })

  // ── IMPORTANT 3 ───────────────────────────────────────────────────────────
  // Pins the tip-out maths to distributedTotal. Every other fixture in this
  // file works both days, so poolTotal === distributedTotal and the correction
  // is invisible. This one has an orphan day, where they diverge 2:1.
  describe('with a day pool nobody was on shift to earn', () => {
    // basis [1000, 1000] at 10% → pools [$100, $100], poolTotal $200.
    // Ana works day 0 only → day 1 pays nobody → distributedTotal $100.
    const orphaned = [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 0] })]
    const onePunch = [punch({ clockId: '706', hours: 8 })]

    it('measures the tip-out against what is distributed, not the whole pool', () => {
      // 100 / 800 = 12.5% → "13%". Against poolTotal it would read 200/800 = 25%.
      const r = run(orphaned, onePunch, { tipsCollected: [400, 400] })
      const f = r.findings.find(x => x.id === 'takeout')!
      expect(f.severity).toBe('info')
      expect(f.title).toContain('13%')
      expect(f.title).not.toContain('25%')
      expect(f.detail).toContain('$100.00')  // to the kitchen
      expect(f.detail).toContain('$700.00')  // left for front of house
      // The orphan day is the only thing blocking, and it is blocking by design.
      expect(r.findings.filter(x => x.severity === 'error').map(x => x.id)).toEqual(['orphan-1'])
      expect(r.findings.some(x => x.id === 'balance')).toBe(false)
      expect(r.findings.some(x => x.id === 'drift')).toBe(false)
    })

    it('does not raise a false overdraw on the undistributed half', () => {
      // pot $150. Distributed $100 fits inside it; poolTotal $200 would not,
      // and would block the payout over money that never leaves the pool.
      const r = run(orphaned, onePunch, { tipsCollected: [75, 75] })
      expect(r.findings.some(x => x.id === 'overdraw')).toBe(false)
      expect(r.findings.find(x => x.id === 'bigtakeout')!.severity).toBe('warn')
      expect(r.findings.filter(x => x.severity === 'error').map(x => x.id)).toEqual(['orphan-1'])
    })
  })
})
