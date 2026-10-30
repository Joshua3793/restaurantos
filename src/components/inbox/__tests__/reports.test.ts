import { describe, it, expect } from 'vitest'
import { reportState, reportsLine, ageLabel } from '../format'

describe('reportState', () => {
  it('is OPEN while the item is not done (waiting / snoozed too)', () => {
    expect(reportState({ status: 'OPEN', doneByName: null })).toBe('OPEN')
    expect(reportState({ status: 'WAITING', doneByName: null })).toBe('OPEN')
    expect(reportState({ status: 'SNOOZED', doneByName: null })).toBe('OPEN')
  })
  it('is FIXED when a person closed it', () => {
    expect(reportState({ status: 'DONE', doneByName: 'Josh' })).toBe('FIXED')
  })
  it('is CLEARED when done with nobody named', () => {
    expect(reportState({ status: 'DONE', doneByName: null })).toBe('CLEARED')
    expect(reportState({ status: 'DONE', doneByName: '  ' })).toBe('CLEARED')
  })
})

describe('reportsLine', () => {
  it('is null with no reports', () => expect(reportsLine([])).toBeNull())
  it('counts reports and fixed ones only', () => {
    expect(reportsLine([
      { status: 'DONE', doneByName: 'Josh' },
      { status: 'OPEN', doneByName: null },
      { status: 'DONE', doneByName: null },
    ])).toBe('3 reports · 1 fixed')
    expect(reportsLine([{ status: 'OPEN', doneByName: null }])).toBe('1 report · 0 fixed')
  })
})

describe('ageLabel', () => {
  const now = new Date('2026-10-30T20:00:00Z')
  it('reads minutes, hours, days', () => {
    expect(ageLabel('2026-10-30T20:00:00Z', now)).toBe('just now')
    expect(ageLabel('2026-10-30T19:48:00Z', now)).toBe('12 min ago')
    expect(ageLabel('2026-10-30T17:00:00Z', now)).toBe('3 h ago')
    expect(ageLabel('2026-10-28T20:00:00Z', now)).toBe('2 d ago')
  })
})
