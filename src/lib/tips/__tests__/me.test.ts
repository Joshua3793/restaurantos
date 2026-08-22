import { describe, it, expect } from 'vitest'
import { projectMyPayout, type MyPayout } from '@/lib/tips/me'
import type { SplitPerson, TipPayoutRecord } from '@/lib/tips/types'

// The complete set of keys a staff response may contain. Written out BY HAND
// on purpose — this is an independent statement of the disclosure boundary, not
// a mirror of the implementation. If someone adds a field to SplitPerson and it
// reaches the output, this test fails.
const ALLOWED_TOP = [
  'periodId', 'startDate', 'endDate', 'paidAt', 'paidByName', 'status',
  'roleName', 'multiplier', 'dailyHourCap', 'hoursTotal', 'tip',
  'envelopeCents', 'perHour', 'days',
].sort()

const ALLOWED_DAY = [
  'label', 'hours', 'rawHours', 'capped', 'boost', 'edited', 'amount',
].sort()

function person(over: Partial<SplitPerson> = {}): SplitPerson {
  return {
    cookId: 'cook-1', name: 'Sam', lastName: 'Lee', clockId: '4521',
    wage: 21.5, roleId: 'role-1', onPool: true, dailyHourCap: 9,
    hours: [8, 9.5, 0], boosts: [1, 1.5, 1], edited: [false, true, false],
    multiplier: 1.25, roleName: 'Line Cook',
    hoursTotal: 17, weighted: 23.5, daily: [52.1, 88.4, 0],
    tip: 140.5, envelopeCents: 14100,
    ...over,
  } as SplitPerson
}

function record(over: Partial<TipPayoutRecord> = {}): TipPayoutRecord {
  return {
    seq: 1,
    paidAt: '2026-08-18T17:00:00.000Z',
    paidByName: 'Alex Fern',
    poolBasis: 'NET_SALES',
    poolRatePct: 5,
    roundingStepCents: 100,
    dayLabels: ['Mon 4', 'Tue 5', 'Wed 6'],
    basis: [4000, 5000, 3000],
    sales: [4000, 5000, 3000],
    tips: [700, 800, 600],
    tipTotal: 2100,
    roles: [{ id: 'role-1', name: 'Line Cook', multiplier: 1.25, sortOrder: 0 }],
    split: {
      pools: [200, 250, 150], poolTotal: 600, distributedTotal: 600,
      weightedByDay: [10, 12, 8], crewByDay: [3, 4, 2],
      people: [person(), person({ cookId: 'cook-2', name: 'Kim', tip: 99, daily: [30, 39, 30] })],
      hoursTotal: 40, weightedTotal: 60, envelopeTotalCents: 60000,
    },
    audit: { findings: [] },
    ...over,
  } as unknown as TipPayoutRecord
}

const snap = (over: Record<string, unknown> = {}) => ({
  version: 1, current: record(), history: [], trimmed: 0, ...over,
})

const call = (snapshotRaw: unknown, cookId = 'cook-1') =>
  projectMyPayout({
    periodId: 'p1', startDate: '2026-08-04', endDate: '2026-08-06',
    snapshotRaw, cookId,
  })

describe('projectMyPayout — disclosure boundary', () => {
  it('emits exactly the permitted top-level keys and nothing else', () => {
    const out = call(snap()) as MyPayout
    expect(Object.keys(out).sort()).toEqual(ALLOWED_TOP)
  })

  it('emits exactly the permitted day keys and nothing else', () => {
    const out = call(snap()) as MyPayout
    expect(out.days).toHaveLength(3)
    for (const day of out.days) {
      expect(Object.keys(day).sort()).toEqual(ALLOWED_DAY)
    }
  })

  it('leaks no house figure anywhere in the serialized output', () => {
    const json = JSON.stringify(call(snap()))
    // Pool/sales values present in the fixture that must never survive.
    for (const forbidden of [
      'poolTotal', 'crewByDay', 'weightedByDay', 'poolRatePct', 'distributedTotal', 'weighted', 'wage', 'clockId',
      'pools', 'basis', 'sales', 'tips', 'poolBasis', 'people',
    ]) {
      expect(json).not.toContain(forbidden)
    }
  })

  it('never includes another person on the pool', () => {
    const json = JSON.stringify(call(snap()))
    expect(json).not.toContain('Kim')
    expect(json).not.toContain('cook-2')
  })
})

describe('projectMyPayout — payout selection', () => {
  it('reads the current payout and reports PAID', () => {
    expect(call(snap())?.status).toBe('PAID')
  })

  it('reads the last real payout of a REOPENED period and flags it', () => {
    // reopenSnapshot pushes current onto history and nulls current. The payout
    // still happened — the cook is holding the cash — so it must still show.
    const reopened = snap({ current: null, history: [record({ seq: 1, paidAt: '2026-08-18T17:00:00.000Z' })] })
    const out = call(reopened)
    expect(out?.status).toBe('BEING_CORRECTED')
    expect(out?.tip).toBe(140.5)
  })

  it('prefers the newest payout when a period was paid, reopened and re-paid', () => {
    const rePaid = snap({
      current: record({ seq: 2, split: { ...record().split, people: [person({ tip: 155.75 })] } }),
      history: [record({ seq: 1 })],
    })
    expect(call(rePaid)?.tip).toBe(155.75)
  })

  it('migrates a legacy flat snapshot through readSnapshot', () => {
    const legacy = { ...record(), paidByName: undefined }
    const out = call(legacy)
    expect(out?.tip).toBe(140.5)
    expect(out?.paidByName).toBeNull()
  })

  it('returns null when the snapshot is absent or unrecognisable', () => {
    expect(call(null)).toBeNull()
    expect(call({ nonsense: true })).toBeNull()
  })

  it('returns null — not a zero row — when the cook is not in the split', () => {
    expect(call(snap(), 'cook-absent')).toBeNull()
  })
})

describe('projectMyPayout — per-person figures', () => {
  it('caps hours at the person’s own contracted cap and marks the day', () => {
    const out = call(snap()) as MyPayout
    expect(out.days[1].rawHours).toBe(9.5)
    expect(out.days[1].hours).toBe(9)
    expect(out.days[1].capped).toBe(true)
    expect(out.days[0].capped).toBe(false)
  })

  it('treats a zero or negative cap as uncapped', () => {
    const s = snap({ current: record({ split: { ...record().split, people: [person({ dailyHourCap: 0 })] } }) })
    const out = call(s) as MyPayout
    expect(out.dailyHourCap).toBeNull()
    expect(out.days[1].hours).toBe(9.5)
    expect(out.days[1].capped).toBe(false)
  })

  it('carries the reward boost and the manual-edit marker per day', () => {
    const out = call(snap()) as MyPayout
    expect(out.days[1].boost).toBe(1.5)
    expect(out.days[1].edited).toBe(true)
    expect(out.days[0].boost).toBe(1)
    expect(out.days[0].edited).toBe(false)
  })

  it('computes perHour from the person’s own tip and hours', () => {
    const out = call(snap()) as MyPayout
    expect(out.perHour).toBeCloseTo(8.26, 2) // 140.50 / 17
  })

  it('guards perHour against zero hours instead of returning Infinity', () => {
    const s = snap({ current: record({ split: { ...record().split, people: [person({ hoursTotal: 0, tip: 0 })] } }) })
    expect(call(s)?.perHour).toBe(0)
  })

  it('carries the envelope and the exact tip separately', () => {
    const out = call(snap()) as MyPayout
    expect(out.tip).toBe(140.5)
    expect(out.envelopeCents).toBe(14100)
  })
})

describe('projectMyPayout — malformed hours in the stored snapshot', () => {
  it('does not throw when hours is entirely absent, and still returns day rows', () => {
    const noHours = person() as unknown as Record<string, unknown>
    delete noHours.hours
    const s = snap({
      current: record({ split: { ...record().split, people: [noHours as unknown as SplitPerson] } }),
    })
    expect(() => call(s)).not.toThrow()
    const out = call(s) as MyPayout
    expect(out).not.toBeNull()
    expect(out.days).toHaveLength(3)
    expect(out.days[0].hours).toBe(0)
    expect(out.days[0].rawHours).toBe(0)
    expect(out.days[0].capped).toBe(false)
  })

  it('coerces a non-numeric hours entry to a finite number that agrees with rawHours', () => {
    const s = snap({
      current: record({
        split: {
          ...record().split,
          // No cap, so effectiveHours would otherwise hand the raw string back verbatim.
          people: [person({ dailyHourCap: null, hours: ['9.5', 9, 0] as unknown as number[] })],
        },
      }),
    })
    const out = call(s) as MyPayout
    expect(out.days[0].hours).toBe(9.5)
    expect(Number.isFinite(out.days[0].hours)).toBe(true)
    expect(out.days[0].rawHours).toBe(9.5)
  })
})

describe('projectMyPayout — paidAt', () => {
  it('reports paidAt as null, never the literal string "undefined", when the stored record has none', () => {
    const s = snap({ current: record({ paidAt: undefined }) })
    const out = call(s) as MyPayout
    expect(out.paidAt).toBeNull()
  })
})
