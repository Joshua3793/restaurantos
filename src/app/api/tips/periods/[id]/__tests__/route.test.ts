import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

// Same vi.mock-of-Prisma pattern as src/app/api/tips/roster/__tests__/route.test.ts.
// `dailyTotals` is stubbed (it hits SalesEntry) but `selectBasis` is the REAL,
// pure implementation via importOriginal — the whole point of this route is
// that it feeds selectBasis the override-applied series, so faking it too
// would hide a regression in that wiring.
const basePeriod = {
  id: 'p1', revenueCenterId: 'rc1', startDate: '2026-07-12', endDate: '2026-07-14',
  status: 'DRAFT', poolBasis: 'NET_SALES', poolRatePct: 5, roundingStepCents: 100,
  salesOverride: null as unknown, tipsOverride: null as unknown,
  salesFileName: null, clockFileName: null, salesImportedAt: null, clockImportedAt: null,
  ignoredClockIds: [] as string[], paidAt: null, paidByName: null, snapshot: null,
  revenueCenter: { name: 'Kitchen' },
  punches: [] as unknown[], adjustments: [] as unknown[],
}

const tipPeriodFindUnique = vi.fn(async () => basePeriod as typeof basePeriod | null)
const tipPeriodUpdate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...basePeriod, ...data }))
const cookFindMany = vi.fn(async () => [] as Array<{
  id: string; name: string; lastName: string | null; clockId: string | null
  wage: number | null; dailyHourCap: number | null; tipRoleId: string | null; onTipPool: boolean
}>)
const tipRoleFindMany = vi.fn(async () => [] as Array<{ id: string; name: string; multiplier: number; sortOrder: number }>)
const requireSession = vi.fn(async () => ({ id: 'u1', role: 'MANAGER', isActive: true }))
const isRcInScope = vi.fn(async () => true)
const loadSettings = vi.fn(async () => ({
  periodDays: 3, poolDepartments: ['Back of House'], includeAutoGratuity: true,
  rewardTiers: [1.25, 1.5], denoms: [],
}))
const dailyTotals = vi.fn(async () => ({
  net: [100, 200, 0], tips: [10, null, 5] as Array<number | null>,
  missingSalesDays: [2], missingTipDays: [1], rcIds: ['rc1'], label: 'Test scope',
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
    cook: { findMany: (...a: unknown[]) => cookFindMany(...(a as [])) },
    tipRole: { findMany: (...a: unknown[]) => tipRoleFindMany(...(a as [])) },
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [])),
  AuthError: MockAuthError,
}))
vi.mock('@/lib/rc-scope', () => ({
  isRcInScope: (...a: unknown[]) => isRcInScope(...(a as [])),
}))
vi.mock('@/lib/tips/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tips/settings')>()
  return { ...actual, loadSettings: (...a: unknown[]) => loadSettings(...(a as [])) }
})
vi.mock('@/lib/tips/sales', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tips/sales')>()
  return { ...actual, dailyTotals: (...a: unknown[]) => dailyTotals(...(a as [])) }
})

const { GET, PATCH } = await import('@/app/api/tips/periods/[id]/route')
const { AuthError } = await import('@/lib/auth')

const req = (body: Record<string, unknown>) => ({ json: async () => body }) as unknown as NextRequest

beforeEach(() => {
  tipPeriodFindUnique.mockClear(); tipPeriodFindUnique.mockResolvedValue(basePeriod)
  tipPeriodUpdate.mockClear()
  cookFindMany.mockClear(); cookFindMany.mockResolvedValue([])
  tipRoleFindMany.mockClear(); tipRoleFindMany.mockResolvedValue([])
  requireSession.mockClear(); requireSession.mockResolvedValue({ id: 'u1', role: 'MANAGER', isActive: true })
  isRcInScope.mockClear(); isRcInScope.mockResolvedValue(true)
  loadSettings.mockClear()
  loadSettings.mockResolvedValue({
    periodDays: 3, poolDepartments: ['Back of House'], includeAutoGratuity: true,
    rewardTiers: [1.25, 1.5], denoms: [],
  })
  dailyTotals.mockClear()
  dailyTotals.mockResolvedValue({
    net: [100, 200, 0], tips: [10, null, 5], missingSalesDays: [2], missingTipDays: [1],
    rcIds: ['rc1'], label: 'Test scope',
  })
})

describe('GET /api/tips/periods/[id]', () => {
  it('builds the single-round-trip payload, with basis following poolBasis and missing days from the live totals', async () => {
    const res = await GET({} as NextRequest, { params: { id: 'p1' } })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.dayLabels).toHaveLength(3)
    expect(json.basis).toEqual([100, 200, 0]) // NET_SALES basis
    expect(json.missingBasisDays).toEqual([2]) // missingSalesDays, untouched by override
    expect(json.sales.missingDays).toEqual([2])
    expect(json.tips.missingDays).toEqual([1])
    expect(json.tips.collected).toEqual([10, null, 5])
    // null tip day must stay null, never coerced to 0
    expect(json.tips.collected[1]).toBeNull()
  })

  it('lets a sales override win per day while leaving un-overridden days at the app figure', async () => {
    tipPeriodFindUnique.mockResolvedValueOnce({ ...basePeriod, salesOverride: [null, 999, null] })
    const res = await GET({} as NextRequest, { params: { id: 'p1' } })
    const json = await res.json()
    expect(json.sales.net).toEqual([100, 999, 0])
    expect(json.sales.overriddenDays).toEqual([1])
  })

  it('returns 404 when the period does not exist', async () => {
    tipPeriodFindUnique.mockResolvedValueOnce(null)
    const res = await GET({} as NextRequest, { params: { id: 'missing' } })
    expect(res.status).toBe(404)
  })

  it('refuses a period outside the caller\'s revenue-center scope with 403', async () => {
    isRcInScope.mockResolvedValueOnce(false)
    const res = await GET({} as NextRequest, { params: { id: 'p1' } })
    expect(res.status).toBe(403)
    expect(cookFindMany).not.toHaveBeenCalled()
  })

  it('rejects an unauthenticated caller with 401 and never reaches the database', async () => {
    requireSession.mockRejectedValueOnce(new AuthError(401, 'Unauthorized'))
    const res = await GET({} as NextRequest, { params: { id: 'p1' } })
    expect(res.status).toBe(401)
    expect(tipPeriodFindUnique).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/tips/periods/[id]', () => {
  it('updates the editable split fields on a DRAFT period', async () => {
    const res = await PATCH(req({ poolRatePct: 6, roundingStepCents: 25 }), { params: { id: 'p1' } })
    expect(res.status).toBe(200)
    expect(tipPeriodUpdate).toHaveBeenCalledTimes(1)
    const data = tipPeriodUpdate.mock.calls[0][0].data as Record<string, unknown>
    expect(data.poolRatePct).toBe(6)
    expect(data.roundingStepCents).toBe(25)
  })

  it('rejects any edit once the period is PAID', async () => {
    tipPeriodFindUnique.mockResolvedValueOnce({ ...basePeriod, status: 'PAID' })
    const res = await PATCH(req({ poolRatePct: 6 }), { params: { id: 'p1' } })
    expect(res.status).toBe(409)
    expect(tipPeriodUpdate).not.toHaveBeenCalled()
  })

  it('rejects an out-of-scope period with 403', async () => {
    isRcInScope.mockResolvedValueOnce(false)
    const res = await PATCH(req({ poolRatePct: 6 }), { params: { id: 'p1' } })
    expect(res.status).toBe(403)
    expect(tipPeriodUpdate).not.toHaveBeenCalled()
  })

  it('rejects an unauthenticated caller with 401 and never reaches the database', async () => {
    requireSession.mockRejectedValueOnce(new AuthError(401, 'Unauthorized'))
    const res = await PATCH(req({ poolRatePct: 6 }), { params: { id: 'p1' } })
    expect(res.status).toBe(401)
    expect(tipPeriodUpdate).not.toHaveBeenCalled()
  })
})
