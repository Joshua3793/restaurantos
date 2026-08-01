import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { User } from '@prisma/client'

// Same vi.mock-of-Prisma pattern as src/app/api/tips/periods/[id]/__tests__/route.test.ts.
// `dailyTotals` is stubbed (it hits SalesEntry); `selectBasis`, `resolveRoster`,
// `computeSplit` and `auditPeriod` are the REAL, pure implementations — this is
// the authoritative freeze/export path, so faking those would hide a
// regression in the wiring between them.
const basePeriod = {
  id: 'p1', revenueCenterId: 'rc1', startDate: '2026-07-12', endDate: '2026-07-14',
  status: 'DRAFT' as string, poolBasis: 'NET_SALES' as string, poolRatePct: 5, roundingStepCents: 100,
  salesOverride: null as unknown, tipsOverride: null as unknown,
  ignoredClockIds: [] as string[],
  punches: [] as unknown[], adjustments: [] as unknown[],
}

const tipPeriodFindUnique = vi.fn(async () => basePeriod as typeof basePeriod | null)
const cookFindMany = vi.fn(async () => [] as Array<{
  id: string; name: string; lastName: string | null; clockId: string | null
  wage: number | null; dailyHourCap: number | null; tipRoleId: string | null; onTipPool: boolean
}>)
const tipRoleFindMany = vi.fn(async () => [] as Array<{ id: string; name: string; multiplier: number; sortOrder: number }>)
const loadSettings = vi.fn(async () => ({
  periodDays: 3, poolDepartments: ['Back of House'], includeAutoGratuity: true,
  rewardTiers: [1.25, 1.5], denoms: [],
}))
const dailyTotals = vi.fn(async () => ({
  net: [100, 200, 0], tips: [10, null, 5] as Array<number | null>,
  missingSalesDays: [2], missingTipDays: [1], rcIds: ['rc1'], label: 'Test scope',
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    tipPeriod: { findUnique: (...a: unknown[]) => tipPeriodFindUnique(...(a as [])) },
    cook: { findMany: (...a: unknown[]) => cookFindMany(...(a as [])) },
    tipRole: { findMany: (...a: unknown[]) => tipRoleFindMany(...(a as [])) },
  },
}))
vi.mock('@/lib/tips/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tips/settings')>()
  return { ...actual, loadSettings: (...a: unknown[]) => loadSettings(...(a as [])) }
})
vi.mock('@/lib/tips/sales', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tips/sales')>()
  return { ...actual, dailyTotals: (...a: unknown[]) => dailyTotals(...(a as [])) }
})

const { buildPeriodSplit } = await import('@/lib/tips/build')

const user = { id: 'u1', role: 'MANAGER', isActive: true, name: 'Jo Manager', email: 'jo@x.test' } as unknown as User

beforeEach(() => {
  tipPeriodFindUnique.mockClear(); tipPeriodFindUnique.mockResolvedValue(basePeriod)
  cookFindMany.mockClear(); cookFindMany.mockResolvedValue([])
  tipRoleFindMany.mockClear(); tipRoleFindMany.mockResolvedValue([])
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

describe('buildPeriodSplit', () => {
  it('returns null when the period does not exist', async () => {
    tipPeriodFindUnique.mockResolvedValueOnce(null)
    const result = await buildPeriodSplit(user, 'missing')
    expect(result).toBeNull()
  })

  it(
    'derives the day window from the PERIOD\'s own stored dates, not the live TipSettings.periodDays — ' +
    'this is the authoritative freeze/export path, so drift here is worse than anywhere else',
    async () => {
      // The period was opened with a 14-day window, but the live, admin-editable
      // settings.periodDays has since been changed to 7. A punch dated day 10
      // (inside the real 14-day window, but outside a wrongly-derived 7-day one)
      // must still count toward the frozen split / payroll export.
      const period14 = {
        ...basePeriod,
        startDate: '2026-07-01', endDate: '2026-07-14',
        punches: [{
          clockId: '9', firstName: 'Ana', lastName: 'B', position: 'Cook',
          department: 'Back of House', dayIndex: 10, hours: 6, status: 'Approved', note: null,
        }],
      }
      tipPeriodFindUnique.mockResolvedValueOnce(period14)
      loadSettings.mockResolvedValueOnce({
        periodDays: 7, poolDepartments: ['Back of House'], includeAutoGratuity: true,
        rewardTiers: [1.25, 1.5], denoms: [],
      })
      dailyTotals.mockImplementationOnce(async (..._a: unknown[]) => {
        const dayCount = _a[3] as number
        return {
          net: Array(dayCount).fill(50), tips: Array(dayCount).fill(5) as Array<number | null>,
          missingSalesDays: [], missingTipDays: [], rcIds: ['rc1'], label: 'Test scope',
        }
      })
      cookFindMany.mockResolvedValueOnce([{
        id: 'c1', name: 'Ana', lastName: 'B', clockId: '9',
        wage: null, dailyHourCap: null, tipRoleId: null, onTipPool: true,
      }])

      const result = await buildPeriodSplit(user, 'p1')
      expect(result).not.toBeNull()
      expect(result!.dayLabels).toHaveLength(14)
      expect(result!.sales).toHaveLength(14) // the sales/tips window, not the 7-day setting
      expect(dailyTotals).toHaveBeenCalledWith(user, expect.anything(), '2026-07-01', 14)

      const person = result!.people.find(p => p.cookId === 'c1')
      expect(person?.hours[10]).toBe(6) // dropped silently if dayCount were derived as 7
    },
  )

  it('rejects a period whose stored endDate is inverted (before startDate) rather than silently building a negative window', async () => {
    tipPeriodFindUnique.mockResolvedValueOnce({ ...basePeriod, startDate: '2026-07-12', endDate: '2026-07-10' })
    await expect(buildPeriodSplit(user, 'p1')).rejects.toThrow()
  })

  it('picks the basis and missingBasisDays from the tips series on a TIPS_COLLECTED period', async () => {
    tipPeriodFindUnique.mockResolvedValueOnce({ ...basePeriod, poolBasis: 'TIPS_COLLECTED' })
    const result = await buildPeriodSplit(user, 'p1')
    // dailyTotals mock: tips = [10, null, 5], missingTipDays = [1]
    expect(result!.basis).toEqual([10, 0, 5])
  })

  it('lets a tips override of 0 win over live data, and turns a missing day non-missing once overridden', async () => {
    tipPeriodFindUnique.mockResolvedValueOnce({
      ...basePeriod, poolBasis: 'TIPS_COLLECTED',
      tipsOverride: [null, 7, 0], // day1 was missing (null); day2 was 5, overridden with a legitimate 0
    })
    const result = await buildPeriodSplit(user, 'p1')
    expect(result!.tips).toEqual([10, 7, 0])
    expect(result!.basis).toEqual([10, 7, 0]) // 0 must win, not fall back to the live 5
  })
})
