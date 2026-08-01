import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

const basePeriod = {
  id: 'p1', revenueCenterId: 'rc1', startDate: '2026-07-12', endDate: '2026-07-14', status: 'DRAFT',
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

  it('quotes a surname containing a comma so it does not shift the row', async () => {
    const res = await GET({} as NextRequest, { params: { id: 'p1' } })
    const csv = await res.text()
    const dataLine = csv.split('\n')[1]
    // The quoted, comma-containing surname must appear as ONE field...
    expect(dataLine).toContain('"Smith, Jr."')
    // ...and the row must still tokenize to the same column count as the header.
    const header = csv.split('\n')[0]
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
    expect(tokenize(dataLine)).toHaveLength(tokenize(header).length)
    expect(tokenize(dataLine)[1]).toBe('Smith, Jr.')
  })

  it('reports Share % and the tip-out figures against distributedTotal, not poolTotal', async () => {
    const res = await GET({} as NextRequest, { params: { id: 'p1' } })
    const csv = await res.text()
    const lines = csv.split('\n')
    // The surname contains a comma, so tokenize with the same quote-aware
    // splitter as the quoting test above rather than a naive split(',').
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
    const dataLine = tokenize(lines[1])
    // tip 55.5 / distributedTotal 55.5 => 100.00%
    expect(dataLine[9]).toBe('100.00')
    const distributedRow = lines.find(l => l.startsWith('Distributed to people'))
    expect(distributedRow).toBe('Distributed to people,55.50')
  })
})
