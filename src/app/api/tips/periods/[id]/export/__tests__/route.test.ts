import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

const basePeriod = {
  id: 'p1', revenueCenterId: 'rc1', startDate: '2026-07-12', endDate: '2026-07-14',
  status: 'DRAFT', snapshot: null as unknown,
}

const tipPeriodFindUnique = vi.fn(async () => basePeriod as typeof basePeriod | null)
const requireSession = vi.fn(async () => ({ id: 'u1', role: 'MANAGER', isActive: true }))
const isRcInScope = vi.fn(async () => true)

const personWithComma = {
  cookId: 'c1', name: 'Ana', lastName: 'Smith, Jr.', clockId: '9', roleName: 'Cook',
  multiplier: 1, hoursTotal: 10, weighted: 10, boosts: [1, 1], tip: 55.5, envelopeCents: 5500,
}
const cleanBuild = {
  split: { people: [personWithComma], poolTotal: 100, distributedTotal: 55.5, envelopeTotalCents: 5500 },
  poolBasis: 'NET_SALES', poolRatePct: 5, roundingStepCents: 100,
  sales: [1000, 500], tipTotal: 60, dayLabels: ['Sun 12'], basis: [1000],
  tips: [60], roles: [],
}
const buildPeriodSplit = vi.fn(async () => cleanBuild as typeof cleanBuild | null)

/** A frozen payout whose numbers deliberately DIFFER from the live build. */
const frozenPayout = {
  seq: 2,
  paidAt: '2026-07-20T18:00:00.000Z',
  paidByName: 'Jo Manager',
  poolBasis: 'NET_SALES', poolRatePct: 5, roundingStepCents: 100,
  dayLabels: ['Sun 12'], basis: [900], sales: [900, 400], tips: [40], tipTotal: 40, roles: [],
  split: {
    people: [{ ...personWithComma, tip: 44.5, envelopeCents: 4500 }],
    poolTotal: 80, distributedTotal: 44.5, envelopeTotalCents: 4500,
  },
  audit: { counts: { error: 0 }, findings: [] },
}
const paidSnapshot = {
  version: 1,
  current: frozenPayout,
  history: [{ ...frozenPayout, seq: 1, paidAt: '2026-07-19T18:00:00.000Z', paidByName: 'Early Bird' }],
  trimmed: 0,
}

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

vi.mock('@/lib/prisma', () => ({
  prisma: { tipPeriod: { findUnique: (...a: unknown[]) => tipPeriodFindUnique(...(a as [])) } },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [])),
  AuthError: MockAuthError,
}))
vi.mock('@/lib/rc-scope', () => ({
  isRcInScope: (...a: unknown[]) => isRcInScope(...(a as [])),
}))
vi.mock('@/lib/tips/build', () => ({
  buildPeriodSplit: (...a: unknown[]) => buildPeriodSplit(...(a as [])),
}))

const { GET } = await import('@/app/api/tips/periods/[id]/export/route')
const { AuthError } = await import('@/lib/auth')

/** BOM off, CRLF split — the sheet is RFC-4180, not \n-joined. */
const lines = (csv: string) => csv.replace(/^﻿/, '').split('\r\n')

const tokenize = (line: string) => {
  const out: string[] = []
  let cur = ''; let inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (ch === '"') inQ = false
      else cur += ch
    } else if (ch === '"') inQ = true
    else if (ch === ',') { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur)
  return out
}

beforeEach(() => {
  tipPeriodFindUnique.mockClear(); tipPeriodFindUnique.mockResolvedValue(basePeriod)
  requireSession.mockClear(); requireSession.mockResolvedValue({ id: 'u1', role: 'MANAGER', isActive: true })
  isRcInScope.mockClear(); isRcInScope.mockResolvedValue(true)
  buildPeriodSplit.mockClear(); buildPeriodSplit.mockResolvedValue(cleanBuild)
})

describe('GET /api/tips/periods/[id]/export', () => {
  it('rejects an unauthenticated caller with 401 and never builds the split', async () => {
    requireSession.mockRejectedValueOnce(new AuthError(401, 'Unauthorized'))
    const res = await GET({} as NextRequest, { params: { id: 'p1' } })
    expect(res.status).toBe(401)
    expect(buildPeriodSplit).not.toHaveBeenCalled()
  })

  it('rejects an out-of-scope period with 403', async () => {
    isRcInScope.mockResolvedValueOnce(false)
    const res = await GET({} as NextRequest, { params: { id: 'p1' } })
    expect(res.status).toBe(403)
    expect(buildPeriodSplit).not.toHaveBeenCalled()
  })

  it('returns 404 when the period does not exist', async () => {
    tipPeriodFindUnique.mockResolvedValueOnce(null)
    const res = await GET({} as NextRequest, { params: { id: 'missing' } })
    expect(res.status).toBe(404)
  })

  it('serves a CSV attachment with the right content type', async () => {
    const res = await GET({} as NextRequest, { params: { id: 'p1' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toMatch(/text\/csv/)
    expect(res.headers.get('Content-Disposition')).toMatch(/attachment/)
  })

  it('emits a UTF-8 BOM and CRLF line endings so Excel on Windows reads it correctly', async () => {
    const res = await GET({} as NextRequest, { params: { id: 'p1' } })
    // Check the BYTES: TextDecoder strips a leading BOM, so res.text() would
    // hide whether one was ever emitted.
    const bytes = new Uint8Array(await res.clone().arrayBuffer())
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf])
    const csv = await res.text()
    expect(csv).toContain('\r\n')
    // No bare LF anywhere — every newline must be part of a CRLF pair.
    expect(csv.replace(/\r\n/g, '')).not.toContain('\n')
  })

  it('quotes a surname containing a comma so it does not shift the row', async () => {
    const res = await GET({} as NextRequest, { params: { id: 'p1' } })
    const l = lines(await res.text())
    expect(l[1]).toContain('"Smith, Jr."')
    expect(tokenize(l[1])).toHaveLength(tokenize(l[0]).length)
    expect(tokenize(l[1])[1]).toBe('Smith, Jr.')
  })

  it('neutralises a name that would be executed as a formula, without mangling negative numbers', async () => {
    buildPeriodSplit.mockResolvedValueOnce({
      ...cleanBuild,
      // A poolTotal below distributedTotal makes the Undistributed row negative.
      split: {
        ...cleanBuild.split,
        poolTotal: 40,
        people: [{ ...personWithComma, name: '=1+1', lastName: '@SUM(A1)', clockId: '-9' }],
      },
    })
    const res = await GET({} as NextRequest, { params: { id: 'p1' } })
    const l = lines(await res.text())
    const row = tokenize(l[1])
    expect(row[0]).toBe("'=1+1")
    expect(row[1]).toBe("'@SUM(A1)")
    // '-9' parses as a number, so it is data, not a formula — left alone.
    expect(row[2]).toBe('-9')
    const undistributed = l.find(x => x.startsWith('Undistributed'))!
    expect(tokenize(undistributed)[1]).toBe('-15.50')
  })

  it('reports Share % and the tip-out figures against distributedTotal, not poolTotal', async () => {
    const res = await GET({} as NextRequest, { params: { id: 'p1' } })
    const l = lines(await res.text())
    // tip 55.5 / distributedTotal 55.5 => 100.00%
    expect(tokenize(l[1])[9]).toBe('100.00')
    expect(l.find(x => x.startsWith('Distributed to people'))).toBe('Distributed to people,55.50')
  })

  it('labels a DRAFT export as a live recalculation', async () => {
    const res = await GET({} as NextRequest, { params: { id: 'p1' } })
    const l = lines(await res.text())
    expect(l.find(x => x.startsWith('Figures'))).toMatch(/Live recalculation \(DRAFT/)
  })

  it(
    're-exports a PAID period from its FROZEN payout, not a live rebuild — the sheet is the ' +
    'payroll hand-off and must match the envelopes actually handed out',
    async () => {
      tipPeriodFindUnique.mockResolvedValueOnce({ ...basePeriod, status: 'PAID', snapshot: paidSnapshot })
      const res = await GET({} as NextRequest, { params: { id: 'p1' } })
      const l = lines(await res.text())
      // Never recomputed against the current roster/caps/sales.
      expect(buildPeriodSplit).not.toHaveBeenCalled()
      // Frozen figures, not the live build's 55.50 / 60.
      expect(tokenize(l[1])[10]).toBe('44.50')
      expect(l.find(x => x.startsWith('Distributed to people'))).toBe('Distributed to people,44.50')
      expect(l.find(x => x.startsWith('Tips collected'))).toBe('Tips collected,40.00')
      expect(l.find(x => x.startsWith('Net sales'))).toBe('Net sales,1300.00')
    },
  )

  it('says WHICH payout a re-export renders — the latest — with its own paidAt and authoriser', async () => {
    tipPeriodFindUnique.mockResolvedValueOnce({ ...basePeriod, status: 'PAID', snapshot: paidSnapshot })
    const res = await GET({} as NextRequest, { params: { id: 'p1' } })
    const figures = lines(await res.text()).find(x => x.startsWith('Figures'))!
    expect(figures).toContain('Frozen payout #2 of 2')
    expect(figures).toContain('2026-07-20T18:00:00.000Z')
    expect(figures).toContain('Jo Manager')
  })

  it('renders a legacy flat snapshot (written before the payout history existed) as payout #1', async () => {
    const legacy = {
      paidAt: '2026-07-01T12:00:00.000Z',
      poolBasis: 'NET_SALES', poolRatePct: 5, roundingStepCents: 100,
      dayLabels: ['Sun 12'], basis: [900], sales: [900], tips: [40], tipTotal: 40, roles: [],
      split: cleanBuild.split, audit: { counts: { error: 0 }, findings: [] },
    }
    tipPeriodFindUnique.mockResolvedValueOnce({ ...basePeriod, status: 'PAID', snapshot: legacy })
    const res = await GET({} as NextRequest, { params: { id: 'p1' } })
    const figures = lines(await res.text()).find(x => x.startsWith('Figures'))!
    expect(buildPeriodSplit).not.toHaveBeenCalled()
    expect(figures).toContain('Frozen payout #1 of 1')
    // The old shape never stored the authoriser — say unknown, never invent one.
    expect(figures).toContain('unknown')
  })

  it('falls back to a live build for a PAID period with no readable snapshot, and says so on the sheet', async () => {
    tipPeriodFindUnique.mockResolvedValueOnce({ ...basePeriod, status: 'PAID', snapshot: null })
    const res = await GET({} as NextRequest, { params: { id: 'p1' } })
    const l = lines(await res.text())
    expect(buildPeriodSplit).toHaveBeenCalledTimes(1)
    expect(l.find(x => x.startsWith('Figures'))).toMatch(/no readable frozen payout/)
  })
})
