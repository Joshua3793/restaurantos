import { describe, it, expect } from 'vitest'
import {
  nextService, currentService, prepDeadlineMinutes, serviceStatus, fmtServiceHours,
  type RcService,
} from '@/lib/service-hours'

const svc = (name: string, start: number, end: number | null): RcService =>
  ({ id: name.toLowerCase(), name, timeMinutes: start, endMinutes: end })

const BRUNCH = svc('Brunch', 540, 960)    // 09:00–16:00
const DINNER = svc('Dinner', 1020, 1320)  // 17:00–22:00
const LATE   = svc('Late', 1320, 120)     // 22:00–02:00 (crosses midnight)

describe('nextService', () => {
  it('returns the earliest service starting after now', () => {
    expect(nextService([DINNER, BRUNCH], 480)?.name).toBe('Brunch') // 08:00
    expect(nextService([DINNER, BRUNCH], 600)?.name).toBe('Dinner') // 10:00
  })
  it('returns null once every service has started', () => {
    expect(nextService([BRUNCH, DINNER], 1380)).toBeNull() // 23:00
  })
  it('returns null for no services', () => {
    expect(nextService([], 600)).toBeNull()
  })
})

describe('currentService', () => {
  it('returns the service in progress', () => {
    expect(currentService([BRUNCH, DINNER], 600)?.name).toBe('Brunch') // 10:00
  })
  it('excludes the boundary end and includes the boundary start', () => {
    expect(currentService([BRUNCH], 540)?.name).toBe('Brunch') // 09:00 exactly
    expect(currentService([BRUNCH], 960)).toBeNull()           // 16:00 exactly
  })
  it('handles a service crossing midnight', () => {
    expect(currentService([LATE], 1380)?.name).toBe('Late') // 23:00
    expect(currentService([LATE], 60)?.name).toBe('Late')   // 01:00
    expect(currentService([LATE], 300)).toBeNull()          // 05:00
  })
  it('never reports a service with unknown hours as underway', () => {
    expect(currentService([svc('NoEnd', 540, null)], 600)).toBeNull()
  })
})

describe('prepDeadlineMinutes', () => {
  it('is the next start minus the lead', () => {
    expect(prepDeadlineMinutes([BRUNCH], 480, 60)).toBe(480) // 09:00 − 1h
  })
  it('treats a null lead as zero', () => {
    expect(prepDeadlineMinutes([BRUNCH], 480, null)).toBe(540)
  })
  it('wraps below midnight', () => {
    expect(prepDeadlineMinutes([svc('Early', 30, 300)], 0, 60)).toBe(1410) // 00:30 − 1h → 23:30
  })
  it('is null when nothing is upcoming', () => {
    expect(prepDeadlineMinutes([BRUNCH], 1000, 60)).toBeNull()
  })
})

describe('serviceStatus', () => {
  it('reports the upcoming service, with minutes and prep-by', () => {
    const s = serviceStatus([BRUNCH], 480, 60) // 08:00
    expect(s).toEqual({ kind: 'upcoming', service: BRUNCH, minsUntil: 60, prepByMin: 480 })
  })
  it('prefers an upcoming service over one already underway', () => {
    const s = serviceStatus([BRUNCH, DINNER], 600, null) // Brunch underway, Dinner later
    expect(s.kind).toBe('upcoming')
    expect(s.kind === 'upcoming' && s.service.name).toBe('Dinner')
  })
  it('falls back to underway when it is the last service', () => {
    const s = serviceStatus([BRUNCH], 600, null)
    expect(s).toEqual({ kind: 'underway', service: BRUNCH })
  })
  it('reports none when no services are configured (on-demand)', () => {
    expect(serviceStatus([], 600, 60)).toEqual({ kind: 'none' })
  })
  it('reports none after the last service has ended', () => {
    expect(serviceStatus([BRUNCH], 1000, null)).toEqual({ kind: 'none' })
  })
})

describe('fmtServiceHours', () => {
  it('renders a start–end range', () => {
    expect(fmtServiceHours(BRUNCH)).toBe('09:00–16:00')
  })
  it('renders only the start when the end is unknown', () => {
    expect(fmtServiceHours(svc('NoEnd', 540, null))).toBe('09:00')
  })
})
