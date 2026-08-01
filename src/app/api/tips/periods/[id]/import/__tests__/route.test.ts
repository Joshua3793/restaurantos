import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

// Same vi.mock-of-Prisma pattern as the sibling tips route tests.
const basePeriod = {
  id: 'p1', revenueCenterId: 'rc1', startDate: '2026-07-12', endDate: '2026-07-14',
  status: 'DRAFT', poolBasis: 'NET_SALES', poolRatePct: 5, roundingStepCents: 100,
  salesOverride: null as unknown, tipsOverride: null as unknown,
  salesFileName: null, clockFileName: null, salesImportedAt: null, clockImportedAt: null,
  ignoredClockIds: [] as string[], paidAt: null, paidByName: null, snapshot: null,
}

const tipPeriodFindUnique = vi.fn(async () => basePeriod as typeof basePeriod | null)
const tipPeriodUpdate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...basePeriod, ...data }))
const tipPunchDeleteMany = vi.fn(async () => ({ count: 0 }))
const tipPunchCreateMany = vi.fn(async () => ({ count: 0 }))
const cookFindMany = vi.fn(async () => [] as Array<{ clockId: string | null }>)
const transaction = vi.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops))
const requireSession = vi.fn(async () => ({ id: 'u1', role: 'MANAGER', isActive: true }))
const isRcInScope = vi.fn(async () => true)
const loadSettings = vi.fn(async () => ({ periodDays: 3 }))

type SalesParse = {
  iso: string[]; sales: number[]; tips: Array<number | null> | null; reportedNet: number | null
  unparsedRows: Array<{ row: number; raw: unknown }>
}
type ClocksParse = {
  rows: Array<{
    clockId: string; firstName: string; lastName: string; position: string
    department: string; dayIndex: number; hours: number; status: string; note: string | null
  }>
  total: number; peopleCount: number; outside: number; pending: number
  unparsedRows: Array<{ row: number; clockId: string; raw: unknown }>
}
// vi.fn takes a FUNCTION type on Vitest 4, not the Vitest 2 <Args, Return> pair.
// Passing the old two-argument form silently inferred `never` parameters, which
// is what made every mockReturnValue/mockImplementation below fail to type.
const parseSalesWorkbook = vi.fn<(buf: Buffer) => SalesParse>(() => ({
  iso: ['2026-07-12'], sales: [500], tips: null, reportedNet: null, unparsedRows: [],
}))
const parseClocksWorkbook = vi.fn<(buf: Buffer, startDate: string, dayCount: number) => ClocksParse>(() => ({
  rows: [{
    clockId: '9', firstName: 'Ana', lastName: 'Lee', position: 'Cook',
    department: 'Back of House', dayIndex: 0, hours: 8, status: 'Approved', note: null,
  }],
  total: 8, peopleCount: 1, outside: 0, pending: 0, unparsedRows: [],
}))

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    tipPeriod: {
      findUnique: (...a: unknown[]) => tipPeriodFindUnique(...(a as [])),
      update: (...a: unknown[]) => tipPeriodUpdate(...(a as [{ data: Record<string, unknown> }])),
    },
    tipPunch: {
      deleteMany: (...a: unknown[]) => tipPunchDeleteMany(...(a as [])),
      createMany: (...a: unknown[]) => tipPunchCreateMany(...(a as [])),
    },
    cook: { findMany: (...a: unknown[]) => cookFindMany(...(a as [])) },
    $transaction: (...a: unknown[]) => transaction(...(a as [Array<Promise<unknown>>])),
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [])),
  AuthError: MockAuthError,
}))
vi.mock('@/lib/rc-scope', () => ({
  isRcInScope: (...a: unknown[]) => isRcInScope(...(a as [])),
}))
vi.mock('@/lib/tips/settings', () => ({
  loadSettings: (...a: unknown[]) => loadSettings(...(a as [])),
}))
vi.mock('@/lib/tips/xlsx', () => ({
  parseSalesWorkbook: (...a: unknown[]) => parseSalesWorkbook(...(a as [Buffer])),
  parseClocksWorkbook: (...a: unknown[]) => parseClocksWorkbook(...(a as [Buffer, string, number])),
}))

const { POST } = await import('@/app/api/tips/periods/[id]/import/route')
const { AuthError } = await import('@/lib/auth')

const req = (file: File | null, kind: string) => ({
  formData: async () => {
    const fd = new FormData()
    if (file) fd.set('file', file)
    fd.set('kind', kind)
    return fd
  },
}) as unknown as NextRequest

const workbook = (name = 'file.xlsx') => new File(['stub bytes'], name, {
  type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
})

beforeEach(() => {
  tipPeriodFindUnique.mockClear(); tipPeriodFindUnique.mockResolvedValue(basePeriod)
  tipPeriodUpdate.mockClear()
  tipPunchDeleteMany.mockClear()
  tipPunchCreateMany.mockClear()
  cookFindMany.mockClear(); cookFindMany.mockResolvedValue([])
  transaction.mockClear()
  requireSession.mockClear(); requireSession.mockResolvedValue({ id: 'u1', role: 'MANAGER', isActive: true })
  isRcInScope.mockClear(); isRcInScope.mockResolvedValue(true)
  loadSettings.mockClear(); loadSettings.mockResolvedValue({ periodDays: 3 })
  parseSalesWorkbook.mockClear()
  parseSalesWorkbook.mockReturnValue({ iso: ['2026-07-12'], sales: [500], tips: null, reportedNet: null, unparsedRows: [] })
  parseClocksWorkbook.mockClear()
  parseClocksWorkbook.mockReturnValue({
    rows: [{
      clockId: '9', firstName: 'Ana', lastName: 'Lee', position: 'Cook',
      department: 'Back of House', dayIndex: 0, hours: 8, status: 'Approved', note: null,
    }],
    total: 8, peopleCount: 1, outside: 0, pending: 0, unparsedRows: [],
  })
})

describe('POST /api/tips/periods/[id]/import', () => {
  it('rejects an unauthenticated caller with 401 and never touches the database', async () => {
    requireSession.mockRejectedValueOnce(new AuthError(401, 'Unauthorized'))
    const res = await POST(req(workbook(), 'sales'), { params: { id: 'p1' } })
    expect(res.status).toBe(401)
    expect(tipPeriodFindUnique).not.toHaveBeenCalled()
    expect(tipPeriodUpdate).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
  })

  it('rejects an out-of-scope period with 403', async () => {
    isRcInScope.mockResolvedValueOnce(false)
    const res = await POST(req(workbook(), 'sales'), { params: { id: 'p1' } })
    expect(res.status).toBe(403)
    expect(tipPeriodUpdate).not.toHaveBeenCalled()
  })

  it('refuses to import onto a PAID period', async () => {
    tipPeriodFindUnique.mockResolvedValueOnce({ ...basePeriod, status: 'PAID' })
    const res = await POST(req(workbook(), 'sales'), { params: { id: 'p1' } })
    expect(res.status).toBe(409)
    expect(tipPeriodUpdate).not.toHaveBeenCalled()
  })

  it('rejects a sales workbook that does not overlap the period', async () => {
    parseSalesWorkbook.mockReturnValueOnce({
      iso: ['2026-01-01', '2026-01-02'], sales: [100, 200], tips: null, reportedNet: null, unparsedRows: [],
    })
    const res = await POST(req(workbook(), 'sales'), { params: { id: 'p1' } })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/does not overlap this period/)
    expect(tipPeriodUpdate).not.toHaveBeenCalled()
  })

  it('imports sales, surfaces unparsedRows in the summary, and never stores null tips as zero', async () => {
    parseSalesWorkbook.mockReturnValueOnce({
      iso: ['2026-07-12'], sales: [500], tips: null, reportedNet: 480,
      unparsedRows: [{ row: 4, raw: 'oops' }],
    })
    const res = await POST(req(workbook(), 'sales'), { params: { id: 'p1' } })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.summary.unparsedRows).toEqual([{ row: 4, raw: 'oops' }])
    expect(json.summary.tipsTotal).toBeNull()
    const data = tipPeriodUpdate.mock.calls[0][0].data as Record<string, unknown>
    expect(data).not.toHaveProperty('tipsOverride')
  })

  it(
    'derives the clocks dayCount from the PERIOD window, so the destructive-wipe guard still ' +
    'fires when the live setting is LONGER than the period',
    async () => {
      // The stored window is 3 days (2026-07-12 → 07-14); the live, admin-
      // editable setting has since been widened to 14. The workbook's only
      // punch is day 5 — outside the REAL window, inside a wrongly-derived
      // 14-day one. `outside` is the SOLE input to the guard, so deriving
      // dayCount from the setting would let this wipe every real punch.
      loadSettings.mockResolvedValueOnce({ periodDays: 14 })
      parseClocksWorkbook.mockImplementationOnce((_b, _s, dayCount) => {
        // Mirrors the real parser's own `outside` fold.
        const rows = [{
          clockId: '9', firstName: 'Ana', lastName: 'Lee', position: 'Cook',
          department: 'Back of House', dayIndex: 5, hours: 8, status: 'Approved', note: null,
        }]
        return {
          rows, total: 8, peopleCount: 1,
          outside: rows.filter(r => r.dayIndex < 0 || r.dayIndex >= dayCount).length,
          pending: 0, unparsedRows: [],
        }
      })
      const res = await POST(req(workbook(), 'clocks'), { params: { id: 'p1' } })
      expect(res.status).toBe(400)
      expect(parseClocksWorkbook.mock.calls[0][2]).toBe(3) // the period's window, not 14
      // The live singleton must not be consulted at all on this path.
      expect(loadSettings).not.toHaveBeenCalled()
      expect(transaction).not.toHaveBeenCalled()
      expect(tipPunchDeleteMany).not.toHaveBeenCalled()
    },
  )

  it('carries a blank tips cell through as null, so it cannot override real tips with zero', async () => {
    // The workbook covers all three days but its Monday tips cell was blank.
    // A stored 0 would WIN over the app's own Toast figure for that day
    // (applyOverride treats 0 as a real number on purpose).
    parseSalesWorkbook.mockReturnValueOnce({
      iso: ['2026-07-12', '2026-07-13', '2026-07-14'],
      sales: [500, 600, 700],
      tips: [80, null, 90],
      reportedNet: null, unparsedRows: [],
    })
    const res = await POST(req(workbook(), 'sales'), { params: { id: 'p1' } })
    expect(res.status).toBe(200)
    const data = tipPeriodUpdate.mock.calls[0][0].data as Record<string, unknown>
    expect(data.tipsOverride).toEqual([80, null, 90])
  })

  it('aligns salesOverride to the PERIOD window, not the live setting', async () => {
    loadSettings.mockResolvedValueOnce({ periodDays: 14 })
    const res = await POST(req(workbook(), 'sales'), { params: { id: 'p1' } })
    expect(res.status).toBe(200)
    const data = tipPeriodUpdate.mock.calls[0][0].data as Record<string, unknown>
    // A 14-long array would be longer than the series build.ts maps it over.
    expect(data.salesOverride).toEqual([500, null, null])
    expect(loadSettings).not.toHaveBeenCalled()
  })

  it('reads the known clock codes BEFORE the punch transaction, so a failure there cannot leave punches written behind a 500', async () => {
    await POST(req(workbook(), 'clocks'), { params: { id: 'p1' } })
    expect(cookFindMany).toHaveBeenCalled()
    expect(cookFindMany.mock.invocationCallOrder[0]).toBeLessThan(transaction.mock.invocationCallOrder[0])
  })

  it('rejects a clocks workbook that does not overlap the period, without touching punches', async () => {
    parseClocksWorkbook.mockReturnValueOnce({
      rows: [{
        clockId: '9', firstName: 'Ana', lastName: 'Lee', position: 'Cook',
        department: 'Back of House', dayIndex: 40, hours: 8, status: 'Approved', note: null,
      }],
      total: 8, peopleCount: 1, outside: 1, pending: 0, unparsedRows: [],
    })
    const res = await POST(req(workbook(), 'clocks'), { params: { id: 'p1' } })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/does not overlap this period/)
    expect(transaction).not.toHaveBeenCalled()
    expect(tipPunchDeleteMany).not.toHaveBeenCalled()
  })

  it('re-imports clocks atomically — delete, create, and the file-stamp update all go through one transaction', async () => {
    const res = await POST(req(workbook(), 'clocks'), { params: { id: 'p1' } })
    expect(res.status).toBe(200)
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(tipPunchDeleteMany).toHaveBeenCalledTimes(1)
    expect(tipPunchCreateMany).toHaveBeenCalledTimes(1)
    const ops = transaction.mock.calls[0][0]
    expect(ops).toHaveLength(3)
    const json = await res.json()
    expect(json.summary.unparsedRows).toEqual([])
  })

  it('surfaces unparsedRows for clocks too', async () => {
    parseClocksWorkbook.mockReturnValueOnce({
      rows: [{
        clockId: '9', firstName: 'Ana', lastName: 'Lee', position: 'Cook',
        department: 'Back of House', dayIndex: 0, hours: 8, status: 'Approved', note: null,
      }],
      total: 8, peopleCount: 1, outside: 0, pending: 0,
      unparsedRows: [{ row: 7, clockId: '12', raw: '–' }],
    })
    const res = await POST(req(workbook(), 'clocks'), { params: { id: 'p1' } })
    const json = await res.json()
    expect(json.summary.unparsedRows).toEqual([{ row: 7, clockId: '12', raw: '–' }])
  })

  it('rejects a bad kind with 400 before touching the database', async () => {
    const res = await POST(req(workbook(), 'nonsense'), { params: { id: 'p1' } })
    expect(res.status).toBe(400)
    expect(tipPeriodUpdate).not.toHaveBeenCalled()
  })

  it('rejects a missing file with 400', async () => {
    const res = await POST(req(null, 'sales'), { params: { id: 'p1' } })
    expect(res.status).toBe(400)
  })

  it('turns a parser exception into a 400 carrying the parser\'s own message', async () => {
    parseSalesWorkbook.mockImplementationOnce(() => { throw new Error('No "Sales by day" sheet — export the Sales Summary with day detail turned on.') })
    const res = await POST(req(workbook(), 'sales'), { params: { id: 'p1' } })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/Sales by day/)
  })
})
