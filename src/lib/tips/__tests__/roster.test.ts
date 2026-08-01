import { describe, it, expect } from 'vitest'
import { readHoursCell, resolveRoster } from '@/lib/tips/roster'
import type { RosterCook, RosterPunch } from '@/lib/tips/roster'

const cook = (over: Partial<RosterCook> & { id: string; name: string }): RosterCook => ({
  lastName: null, clockId: null, wage: null, dailyHourCap: null,
  tipRoleId: 'dish', onTipPool: true, ...over,
})

const punch = (over: Partial<RosterPunch> & { clockId: string; hours: number }): RosterPunch => ({
  department: 'Back of House', dayIndex: 0, status: 'Approved', ...over,
})

const run = (cooks: RosterCook[], punches: RosterPunch[], adjustments: Parameters<typeof resolveRoster>[0]['adjustments'] = []) =>
  resolveRoster({ cooks, punches, adjustments, dayCount: 3, poolDepartments: ['Back of House'] })

describe('resolveRoster', () => {
  it('matches punches to a cook by clock id and sums them onto their day', () => {
    const [p] = run(
      [cook({ id: 'c1', name: 'Ana', clockId: '706' })],
      [punch({ clockId: '706', hours: 8 }), punch({ clockId: '706', hours: 1.5 })],
    )
    expect(p.hours).toEqual([9.5, 0, 0])
    expect(p.edited).toEqual([false, false, false])
  })

  it('never matches on name — a cook with no clock id gets no hours', () => {
    const [p] = run(
      [cook({ id: 'c1', name: 'Ana', lastName: 'Smith' })],
      [punch({ clockId: '706', hours: 8 })],
    )
    expect(p.hours).toEqual([0, 0, 0])
  })

  it('drops punches from another department, outside the period, or unapproved', () => {
    const [p] = run(
      [cook({ id: 'c1', name: 'Ana', clockId: '706' })],
      [
        punch({ clockId: '706', hours: 8 }),
        punch({ clockId: '706', hours: 5, department: 'Front of House' }),
        punch({ clockId: '706', hours: 5, dayIndex: 9 }),
        punch({ clockId: '706', hours: 5, dayIndex: 1, status: 'Pending' }),
      ],
    )
    expect(p.hours).toEqual([8, 0, 0])
  })

  it('accepts every department when none is configured', () => {
    const out = resolveRoster({
      cooks: [cook({ id: 'c1', name: 'Ana', clockId: '706' })],
      punches: [punch({ clockId: '706', hours: 8, department: 'Front of House' })],
      adjustments: [], dayCount: 3, poolDepartments: [],
    })
    expect(out[0].hours[0]).toBe(8)
  })

  it('lets a manual hours adjustment override the clocked hours and marks the day edited', () => {
    const [p] = run(
      [cook({ id: 'c1', name: 'Ana', clockId: '706' })],
      [punch({ clockId: '706', hours: 8 })],
      [{ cookId: 'c1', dayIndex: 0, hours: 6.25, boost: 1 }],
    )
    expect(p.hours[0]).toBe(6.25)
    expect(p.edited[0]).toBe(true)
  })

  it('applies a boost without touching the clocked hours', () => {
    const [p] = run(
      [cook({ id: 'c1', name: 'Ana', clockId: '706' })],
      [punch({ clockId: '706', hours: 8 })],
      [{ cookId: 'c1', dayIndex: 0, hours: null, boost: 1.5 }],
    )
    expect(p.hours[0]).toBe(8)
    expect(p.boosts[0]).toBe(1.5)
    expect(p.edited[0]).toBe(false)
  })

  it('carries the payroll fields straight through', () => {
    const [p] = run(
      [cook({ id: 'c1', name: 'Ana', lastName: 'Smith', clockId: '706', wage: 22, dailyHourCap: 8, tipRoleId: 'lead', onTipPool: false })],
      [],
    )
    expect(p).toMatchObject({
      cookId: 'c1', name: 'Ana', lastName: 'Smith', clockId: '706',
      wage: 22, dailyHourCap: 8, roleId: 'lead', onPool: false,
    })
  })
})

/**
 * The split table's hours box. Two silent-wrongness bugs lived in the onBlur
 * this replaced — see readHoursCell's own doc comment.
 */
describe('readHoursCell', () => {
  it('sends NOTHING when the value did not change — a blur is not an edit', () => {
    // The bug: blurring an untouched cell wrote an adjustment equal to the
    // clocked hours. No money moved, so nothing looked wrong — but it set
    // `edited[d]`, and auditPeriod skips edited days, switching off that day's
    // per-person reconciliation with no signal anywhere in the app.
    expect(readHoursCell('8', 8, false)).toEqual({ kind: 'skip' })
    expect(readHoursCell('  8  ', 8, false)).toEqual({ kind: 'skip' })
    expect(readHoursCell('8.00', 8, false)).toEqual({ kind: 'skip' })
    // Including on a day that already carries an override of the same value.
    expect(readHoursCell('6', 6, true)).toEqual({ kind: 'skip' })
  })

  it('commits a genuine change', () => {
    expect(readHoursCell('7.5', 8, false)).toEqual({ kind: 'commit', hours: 7.5 })
    expect(readHoursCell('0', 8, false)).toEqual({ kind: 'commit', hours: 0 })
  })

  it('clears the override when the box is emptied, rather than storing 0 hours', () => {
    // parseFloat('') is NaN, which used to land as a 0-hour override — the
    // person paid nothing for a day they worked. The API takes `hours: null`.
    expect(readHoursCell('', 6, true)).toEqual({ kind: 'commit', hours: null })
    expect(readHoursCell('   ', 6, true)).toEqual({ kind: 'commit', hours: null })
  })

  it('does nothing when an empty box had no override to clear', () => {
    expect(readHoursCell('', 0, false)).toEqual({ kind: 'skip' })
  })

  it('rejects an unreadable or negative figure without sending anything', () => {
    expect(readHoursCell('abc', 8, false)).toEqual({ kind: 'invalid' })
    expect(readHoursCell('-2', 8, false)).toEqual({ kind: 'invalid' })
  })
})
