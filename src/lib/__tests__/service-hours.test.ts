import { describe, it, expect } from 'vitest'
import {
  nextService, currentService, prepDeadlineMinutes, serviceStatus, upcomingInfo, fmtServiceHours,
  formatServiceStatus, serviceCaption,
  type RcService, type ServiceStatus,
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

  // An underway service ALWAYS wins: the original complaint was a header reading
  // "dinner in 7h32m" while brunch was actively being served.
  it('prefers the underway service over an upcoming one, and carries the next along', () => {
    const s = serviceStatus([BRUNCH, DINNER], 600, null) // 10:00 — Brunch underway, Dinner later
    expect(s.kind).toBe('underway')
    expect(s.kind === 'underway' && s.service.name).toBe('Brunch')
    expect(s.kind === 'underway' && s.next?.service.name).toBe('Dinner')
    expect(s.kind === 'underway' && s.next?.minsUntil).toBe(420) // 17:00 − 10:00
  })
  it('populates next.prepByMin from the lead', () => {
    const s = serviceStatus([BRUNCH, DINNER], 600, 60) // 10:00, 1h lead
    expect(s.kind === 'underway' && s.next?.prepByMin).toBe(960) // 17:00 − 1h
  })
  it('reports underway with next: null for the last service of the day', () => {
    expect(serviceStatus([BRUNCH], 600, null)).toEqual({ kind: 'underway', service: BRUNCH, next: null })
  })
  it('reports underway with next: null for the last of several', () => {
    const s = serviceStatus([BRUNCH, DINNER], 1100, null) // 18:20 — Dinner underway, nothing after
    expect(s).toEqual({ kind: 'underway', service: DINNER, next: null })
  })

  it('reports none when no services are configured (on-demand)', () => {
    expect(serviceStatus([], 600, 60)).toEqual({ kind: 'none' })
  })

  // The regression this contract exists to prevent: an RC that HAS a service
  // configured must never be indistinguishable from one that has none.
  it('reports closed — not none — after the last service has ended', () => {
    expect(serviceStatus([BRUNCH], 1000, null)).toEqual({ kind: 'closed' })
  })
  it('distinguishes closed from none at the same moment', () => {
    expect(serviceStatus([BRUNCH], 1000, null)).not.toEqual(serviceStatus([], 1000, null))
  })
  it('reports closed before the first start only if nothing remains — never here', () => {
    // 07:00, Brunch still ahead → upcoming, not closed.
    expect(serviceStatus([BRUNCH], 420, null).kind).toBe('upcoming')
  })

  it('reports a midnight-crossing service as underway on both sides', () => {
    expect(serviceStatus([LATE], 1380, null)).toEqual({ kind: 'underway', service: LATE, next: null }) // 23:00
    expect(serviceStatus([LATE], 60, null)).toEqual({ kind: 'underway', service: LATE, next: null })   // 01:00
  })
  // 05:00: Late has ended (02:00) but starts again at 22:00 TODAY — so the honest
  // answer is upcoming, not closed. `closed` is only for "nothing left today".
  it('reports upcoming once a midnight-crossing service has ended for the night', () => {
    const s = serviceStatus([LATE], 300, null) // 05:00
    expect(s.kind).toBe('upcoming')
    expect(s.kind === 'upcoming' && s.minsUntil).toBe(1020) // 22:00 − 05:00
  })
  it('does not queue a midnight-crossing service as its own next', () => {
    // At 01:00 Late is underway; it also "starts later today" at 22:00. It must
    // not appear in its own `next` slot ("Late underway · Late in 21h").
    const s = serviceStatus([LATE], 60, null)
    expect(s).toEqual({ kind: 'underway', service: LATE, next: null })
  })
  it('never reports a null-endMinutes service as underway — it is closed once started', () => {
    const NO_END = svc('NoEnd', 540, null)
    expect(serviceStatus([NO_END], 600, null)).toEqual({ kind: 'closed' }) // 10:00, started, no end
    expect(serviceStatus([NO_END], 480, null).kind).toBe('upcoming')       // 08:00, still ahead
  })
})

describe('upcomingInfo', () => {
  it('returns the upcoming service for kind upcoming', () => {
    expect(upcomingInfo(serviceStatus([BRUNCH], 480, 60))?.service.name).toBe('Brunch')
  })
  it('returns the queued service for kind underway', () => {
    expect(upcomingInfo(serviceStatus([BRUNCH, DINNER], 600, null))?.service.name).toBe('Dinner')
  })
  it('returns null for underway with nothing after, closed, none and null', () => {
    expect(upcomingInfo(serviceStatus([BRUNCH], 600, null))).toBeNull()
    expect(upcomingInfo(serviceStatus([BRUNCH], 1000, null))).toBeNull()
    expect(upcomingInfo(serviceStatus([], 600, null))).toBeNull()
    expect(upcomingInfo(null)).toBeNull()
  })
})

describe('formatServiceStatus', () => {
  // The one rendering every surface (`/prep` desktop + mobile, `/pass`, `/preshift`)
  // must route through — this is the contract that closes off the "hand-transcribed
  // in four places" divergence (a single-Brunch config showing "underway" on desktop
  // and nothing on mobile).
  it('upcoming — "{name} service in {duration}", no trail', () => {
    const s = serviceStatus([BRUNCH], 480, null) // 08:00
    expect(formatServiceStatus(s)).toEqual({ lead: 'Brunch service in 1h 0m', trail: null })
  })
  it('underway with next — lead is bare "service underway", trail is "{next.name} in {duration}"', () => {
    const s = serviceStatus([BRUNCH, DINNER], 600, null) // 10:00
    expect(formatServiceStatus(s)).toEqual({ lead: 'Brunch service underway', trail: 'Dinner in 7h 0m' })
  })
  it('underway, next: null — lead only, no trail', () => {
    const s = serviceStatus([BRUNCH], 600, null) // 10:00, last service of the day
    expect(formatServiceStatus(s)).toEqual({ lead: 'Brunch service underway', trail: null })
  })
  it('closed — null (render nothing)', () => {
    const s = serviceStatus([BRUNCH], 1000, null)
    expect(s.kind).toBe('closed')
    expect(formatServiceStatus(s)).toBeNull()
  })
  it('none — "on-demand", no trail', () => {
    const s = serviceStatus([], 600, null)
    expect(s.kind).toBe('none')
    expect(formatServiceStatus(s)).toEqual({ lead: 'on-demand', trail: null })
  })
  it('throws a type error (not silently "on-demand") if the union grows — exercised via tsc, not at runtime', () => {
    // This test only documents the contract; the actual exhaustiveness proof is the
    // `default: { const _never: never = status; ... }` branch inside formatServiceStatus
    // and the mirrored guards in each consumer, verified by temporarily widening
    // ServiceStatus and re-running `tsc --noEmit` (see final-review-fixes.md).
    const allKinds: ServiceStatus['kind'][] = ['upcoming', 'underway', 'closed', 'none']
    expect(allKinds).toHaveLength(4)
  })
})

describe('serviceCaption', () => {
  it('upcoming — bare service name', () => {
    expect(serviceCaption(serviceStatus([BRUNCH], 480, null))).toBe('Brunch')
  })
  it('underway with next — compound "{name} · {next.name} in {duration}"', () => {
    expect(serviceCaption(serviceStatus([BRUNCH, DINNER], 600, null))).toBe('Brunch · Dinner in 7h 0m')
  })
  it('underway, next: null — bare service name', () => {
    expect(serviceCaption(serviceStatus([BRUNCH], 600, null))).toBe('Brunch')
  })
  it('closed and none — null', () => {
    expect(serviceCaption(serviceStatus([BRUNCH], 1000, null))).toBeNull()
    expect(serviceCaption(serviceStatus([], 600, null))).toBeNull()
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
