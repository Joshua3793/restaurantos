// Validators shared by the Service write path (/api/services and /api/services/[id]).
import { describe, it, expect } from 'vitest'
import { validateTimeMinutes, validateSpan } from '@/lib/service-validation'

describe('validateTimeMinutes', () => {
  it('accepts a minute-of-day in range', () => {
    expect(validateTimeMinutes(0)).toBeNull()
    expect(validateTimeMinutes(540)).toBeNull()
    expect(validateTimeMinutes(1439)).toBeNull()
  })
  it('rejects out-of-range, non-integer and non-numeric values', () => {
    expect(validateTimeMinutes(-1)).toBeTruthy()
    expect(validateTimeMinutes(1440)).toBeTruthy()
    expect(validateTimeMinutes(9.5)).toBeTruthy()
    expect(validateTimeMinutes('540')).toBeTruthy()
    expect(validateTimeMinutes(null)).toBeTruthy()
  })
  it('names the field in the message', () => {
    expect(validateTimeMinutes(-1)).toContain('timeMinutes')
    expect(validateTimeMinutes(-1, 'endMinutes')).toContain('endMinutes')
  })
})

describe('validateSpan', () => {
  // A zero-length window passes the range check but makes currentService()'s
  // `now >= start && now < end` unsatisfiable — the service would silently never
  // report as underway. Reject it on write rather than ship a dead row.
  it('rejects an end equal to the start', () => {
    const err = validateSpan(540, 540)
    expect(err).toBeTruthy()
    expect(err).toContain('must differ')
  })
  it('accepts a normal window', () => {
    expect(validateSpan(540, 960)).toBeNull()
  })
  it('accepts a window crossing midnight (end < start)', () => {
    expect(validateSpan(1320, 120)).toBeNull()
  })
  it('ignores a null or absent end — hours-unknown stays legal', () => {
    expect(validateSpan(540, null)).toBeNull()
    expect(validateSpan(540, undefined)).toBeNull()
  })
})
