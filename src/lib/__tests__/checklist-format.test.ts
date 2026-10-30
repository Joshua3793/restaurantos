import { describe, it, expect } from 'vitest'
import { lastTimeLabel } from '@/lib/checklists/format'

// October 2026 is Pacific Daylight Time (UTC-7).
describe('lastTimeLabel', () => {
  const at = '2026-10-29T05:31:00.000Z' // Wed 28 Oct 22:31 Pacific

  it('same Pacific day reads the time only', () => {
    expect(lastTimeLabel(at, new Date('2026-10-29T06:10:00Z'))).toBe('22:31') // 23:10 the same night
  })

  it('00:30 Pacific the next morning still reads "yesterday"', () => {
    expect(lastTimeLabel(at, new Date('2026-10-29T07:30:00Z'))).toBe('yesterday 22:31')
  })

  it('older readings carry the weekday and date', () => {
    expect(lastTimeLabel('2026-10-28T05:31:00.000Z', new Date('2026-10-30T19:00:00Z'))).toBe('Tue 27 Oct 22:31')
  })

  it('compares Pacific dates, not UTC dates', () => {
    // 16:30 PT (23:30Z on the 28th) and 22:00 PT (05:00Z on the 29th) are one Pacific day.
    expect(lastTimeLabel('2026-10-28T23:30:00.000Z', new Date('2026-10-29T05:00:00Z'))).toBe('16:30')
  })
})
