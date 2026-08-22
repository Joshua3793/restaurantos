import { describe, it, expect } from 'vitest'
import { dateLabel, paidLine } from '@/lib/tips/payout-label'

describe('dateLabel', () => {
  it('formats a normal ISO date', () => {
    expect(dateLabel('2026-08-12T18:00:00.000Z')).toBe('Aug 12')
  })

  it('treats null as no known date', () => {
    expect(dateLabel(null)).toBeNull()
  })

  it('treats the epoch sentinel (legacy snapshot backfill) as no known date', () => {
    // src/lib/tips/snapshot.ts readSnapshot() writes exactly this string when
    // a legacy flat snapshot has no recorded paidAt.
    expect(dateLabel(new Date(0).toISOString())).toBeNull()
  })

  it('treats an unparseable string as no known date, not "Invalid Date"', () => {
    expect(dateLabel('not-a-real-date')).toBeNull()
  })
})

describe('paidLine', () => {
  it('renders "paid <date> by <name>" when both are known', () => {
    expect(paidLine('2026-08-12T18:00:00.000Z', 'Jo Manager')).toBe(' · paid Aug 12 by Jo Manager')
  })

  it('renders "paid <date>" when only the date is known', () => {
    expect(paidLine('2026-08-12T18:00:00.000Z', null)).toBe(' · paid Aug 12')
  })

  it('falls back to "paid by <name>" when the date is unknown (epoch sentinel)', () => {
    expect(paidLine(new Date(0).toISOString(), 'Jo Manager')).toBe(' · paid by Jo Manager')
  })

  it('falls back to "paid by <name>" when paidAt is null', () => {
    expect(paidLine(null, 'Jo Manager')).toBe(' · paid by Jo Manager')
  })

  it('renders nothing when neither is known', () => {
    expect(paidLine(null, null)).toBe('')
    expect(paidLine('not-a-real-date', null)).toBe('')
  })
})
