import 'server-only'
import { prisma } from '@/lib/prisma'
import type { User } from '@prisma/client'
import { computeSplit } from './engine'
import { auditPeriod } from './audit'
import { dailyTotals, selectBasis } from './sales'
import { resolveRoster } from './roster'
import { dayLabels } from './period'
import { loadSettings } from './settings'
import type { PoolBasis, SplitResult, TipPerson, TipRoleDef } from './types'
import type { AuditResult, PunchRow } from './audit'

export interface BuiltPeriodSplit {
  split: SplitResult
  audit: AuditResult
  roles: TipRoleDef[]
  people: TipPerson[]
  dayLabels: string[]
  basis: number[]
  poolBasis: PoolBasis
  sales: number[]
  tips: Array<number | null>
  tipTotal: number
  poolRatePct: number
  roundingStepCents: number
}

/**
 * Rebuilds a period's split and audit on the server from the persisted rows.
 * The page recomputes the same numbers in the browser on every keystroke; this
 * is the authoritative pass used to freeze a payment and to build the export,
 * so both go through exactly the same pure functions — resolveRoster,
 * selectBasis, computeSplit, auditPeriod — as the page's own payload route
 * (src/app/api/tips/periods/[id]/route.ts). Never re-fold punches/adjustments
 * inline here: a second copy of that fold is how the page's numbers and the
 * numbers frozen at payment drift apart.
 */
export async function buildPeriodSplit(user: User, periodId: string): Promise<BuiltPeriodSplit | null> {
  const period = await prisma.tipPeriod.findUnique({
    where: { id: periodId },
    include: { punches: true, adjustments: true },
  })
  if (!period) return null

  const settings = await loadSettings()
  const dayCount = settings.periodDays
  const poolDepartments = (settings.poolDepartments ?? []) as string[]
  const rewardTiers = (settings.rewardTiers ?? []) as number[]
  const labels = dayLabels(period.startDate, dayCount)

  const live = await dailyTotals(user, settings, period.startDate, dayCount)

  /** Applies a per-day override array over a live series. Mirrors the payload route. */
  const applyOverride = (
    liveSeries: Array<number | null>, raw: unknown, liveMissing: number[],
  ) => {
    const override = Array.isArray(raw) ? (raw as (number | null)[]) : null
    const overridden = new Set<number>()
    const series = liveSeries.map((v, i) => {
      const o = override?.[i]
      if (o == null || !isFinite(Number(o))) return v
      overridden.add(i)
      return Number(o)
    })
    return { series, missing: liveMissing.filter(i => !overridden.has(i)) }
  }

  const salesRes = applyOverride(live.net, period.salesOverride, live.missingSalesDays)
  const tipsRes = applyOverride(live.tips, period.tipsOverride, live.missingTipDays)
  const sales = salesRes.series.map(v => v ?? 0)
  const tips = tipsRes.series

  const poolBasis = period.poolBasis as PoolBasis
  // Single place the basis is picked — same helper the payload route uses —
  // just fed the override-applied series instead of the live ones.
  const { basis, missingBasisDays } = selectBasis(
    { net: sales, tips, missingSalesDays: salesRes.missing, missingTipDays: tipsRes.missing },
    poolBasis,
  )
  const tipTotal = Math.round(tips.reduce<number>((a, v) => a + (v ?? 0), 0) * 100) / 100

  const roleRows = await prisma.tipRole.findMany({
    where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  })
  const roles: TipRoleDef[] = roleRows.map(r => ({
    id: r.id, name: r.name, multiplier: Number(r.multiplier), sortOrder: r.sortOrder,
  }))

  const cooks = await prisma.cook.findMany({
    where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  })
  // Same resolver the payload route uses — one copy, so the numbers the page
  // shows and the numbers frozen at payment can never drift apart.
  const people: TipPerson[] = resolveRoster({
    cooks: cooks.map(c => ({
      id: c.id, name: c.name, lastName: c.lastName, clockId: c.clockId,
      wage: c.wage == null ? null : Number(c.wage),
      dailyHourCap: c.dailyHourCap == null ? null : Number(c.dailyHourCap),
      tipRoleId: c.tipRoleId, onTipPool: c.onTipPool,
    })),
    punches: period.punches.map(p => ({
      clockId: p.clockId, department: p.department, dayIndex: p.dayIndex,
      hours: Number(p.hours), status: p.status,
    })),
    adjustments: period.adjustments.map(a => ({
      cookId: a.cookId, dayIndex: a.dayIndex,
      hours: a.hours == null ? null : Number(a.hours), boost: Number(a.boost),
    })),
    dayCount,
    poolDepartments,
  })

  const punches: PunchRow[] = period.punches.map(p => ({
    clockId: p.clockId, firstName: p.firstName, lastName: p.lastName,
    position: p.position, department: p.department, dayIndex: p.dayIndex,
    hours: Number(p.hours), status: p.status, note: p.note,
  }))

  const poolRatePct = Number(period.poolRatePct)
  const split = computeSplit({
    basis, poolRatePct,
    roundingStepCents: period.roundingStepCents, roles, people,
  })
  // people[] on the split already carries each person's RESOLVED dailyHourCap,
  // roleId, roleName and multiplier as of this build — the mutable Cook/TipRole
  // rows those come from can change later, so the snapshot the pay route
  // freezes from `split` is what preserves "what they were actually paid on".
  const audit = auditPeriod({
    dayLabels: labels, basis, poolBasis, tipsCollected: tips,
    roles, people, punches, split,
    roundingStepCents: period.roundingStepCents,
    poolDepartments, ignoredClockIds: (period.ignoredClockIds ?? []) as string[],
    rewardTiers,
    missingBasisDays,
  })

  return {
    split, audit, roles, people, dayLabels: labels,
    basis, poolBasis, sales, tips, tipTotal,
    poolRatePct, roundingStepCents: period.roundingStepCents,
  }
}
