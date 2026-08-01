import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { isRcInScope } from '@/lib/rc-scope'
import { dayLabels, periodDays, periodLabel } from '@/lib/tips/period'
import { dailyTotals, selectBasis } from '@/lib/tips/sales'
import { resolveRoster } from '@/lib/tips/roster'
import { loadSettings, toDto } from '@/lib/tips/settings'
import { toRoleDto } from '@/lib/tips/roles'
import type { TipPeriodPayload } from '@/lib/tips/types'
import type { PunchRow } from '@/lib/tips/audit'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireSession('MANAGER')
    const period = await prisma.tipPeriod.findUnique({
      where: { id: params.id },
      include: {
        revenueCenter: { select: { name: true } },
        punches: true,
        adjustments: true,
      },
    })
    if (!period) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await isRcInScope(user, period.revenueCenterId)))
      return NextResponse.json({ error: 'Revenue center is outside your access.' }, { status: 403 })

    const settings = await loadSettings()
    const settingsDto = toDto(settings)
    const dayCount = periodDays(period.startDate, settings.periodDays).length
    const labels = dayLabels(period.startDate, settings.periodDays)
    const dates = periodDays(period.startDate, settings.periodDays)

    // ── sales + tips: app-native, with the workbook overriding per day ──────
    const live = await dailyTotals(user, settings, period.startDate, settings.periodDays)

    /** Applies a per-day override array over a live series. */
    const applyOverride = <T extends number | null>(
      liveSeries: T[], raw: unknown, liveMissing: number[],
    ): { series: Array<number | null>; overridden: number[]; missing: number[] } => {
      const override = Array.isArray(raw) ? (raw as (number | null)[]) : null
      const overridden: number[] = []
      const series = liveSeries.map((v, i) => {
        const o = override?.[i]
        if (o == null || !isFinite(Number(o))) return v as number | null
        overridden.push(i)
        return Number(o)
      })
      return { series, overridden, missing: liveMissing.filter(i => !overridden.includes(i)) }
    }

    const salesRes = applyOverride(live.net, period.salesOverride, live.missingSalesDays)
    const tipsRes = applyOverride(live.tips, period.tipsOverride, live.missingTipDays)
    const net = salesRes.series.map(v => v ?? 0)
    const tipsSeries = tipsRes.series

    const poolBasis = period.poolBasis as 'NET_SALES' | 'TIPS_COLLECTED'
    // Single place the basis is picked, same as the raw (un-overridden) reader —
    // just fed the override-applied series instead of the live ones.
    const { basis, missingBasisDays } = selectBasis(
      { net, tips: tipsSeries, missingSalesDays: salesRes.missing, missingTipDays: tipsRes.missing },
      poolBasis,
    )
    const tipTotal = Math.round(
      tipsSeries.reduce<number>((a, v) => a + (v ?? 0), 0) * 100,
    ) / 100

    // ── roster: every cook, with this period's hours + boosts resolved ──────
    const cooks = await prisma.cook.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true, name: true, lastName: true, clockId: true, wage: true,
        dailyHourCap: true, tipRoleId: true, onTipPool: true,
      },
    })
    const roles = await prisma.tipRole.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    })

    const poolDepartments = settingsDto.poolDepartments
    // Single copy of the punches→hours fold; build.ts (Task 9) calls the same
    // function, so the page's numbers and the numbers frozen at payment can
    // never drift apart.
    const roster = resolveRoster({
      cooks: cooks.map(c => ({
        ...c,
        wage: c.wage == null ? null : Number(c.wage),
        dailyHourCap: c.dailyHourCap == null ? null : Number(c.dailyHourCap),
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
      clockId: p.clockId,
      firstName: p.firstName,
      lastName: p.lastName,
      position: p.position,
      department: p.department,
      dayIndex: p.dayIndex,
      hours: Number(p.hours),
      status: p.status,
      note: p.note,
    }))

    const payload: TipPeriodPayload = {
      period: {
        id: period.id,
        revenueCenterId: period.revenueCenterId,
        revenueCenterName: period.revenueCenter.name,
        startDate: period.startDate,
        endDate: period.endDate,
        status: period.status as 'DRAFT' | 'PAID',
        paidAt: period.paidAt?.toISOString() ?? null,
        paidByName: period.paidByName,
        poolBasis,
        poolRatePct: Number(period.poolRatePct),
        roundingStepCents: period.roundingStepCents,
        ignoredClockIds: (period.ignoredClockIds ?? []) as string[],
        salesFileName: period.salesFileName,
        clockFileName: period.clockFileName,
        salesImportedAt: period.salesImportedAt?.toISOString() ?? null,
        clockImportedAt: period.clockImportedAt?.toISOString() ?? null,
        snapshot: period.snapshot ?? null,
      },
      dayLabels: labels,
      dayDates: dates,
      periodLabel: periodLabel(period.startDate, settings.periodDays),
      basis,
      missingBasisDays,
      sales: {
        net,
        missingDays: salesRes.missing,
        overriddenDays: salesRes.overridden,
        scopeLabel: live.label,
      },
      tips: {
        collected: tipsSeries,
        missingDays: tipsRes.missing,
        overriddenDays: tipsRes.overridden,
        total: tipTotal,
        includesAutoGratuity: settingsDto.includeAutoGratuity,
      },
      roles: roles.map(toRoleDto),
      roster,
      punches,
      punchTotal: Math.round(punches.reduce((a, p) => a + p.hours, 0) * 100) / 100,
      rewardTiers: settingsDto.rewardTiers,
      denoms: settingsDto.denoms,
      poolDepartments,
    }
    return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[tips/periods/[id] GET]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireSession('MANAGER')
    const period = await prisma.tipPeriod.findUnique({ where: { id: params.id } })
    if (!period) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await isRcInScope(user, period.revenueCenterId)))
      return NextResponse.json({ error: 'Revenue center is outside your access.' }, { status: 403 })
    if (period.status === 'PAID')
      return NextResponse.json({ error: 'This period is paid. Reopen it before changing the split.' }, { status: 409 })

    const body = await req.json().catch(() => ({}))
    const data: Record<string, unknown> = {}
    if (body.poolBasis !== undefined) {
      // Switchable on a DRAFT period so a manager can compare "5% of sales" with
      // "30% of the tip pot" before committing. Blocked on PAID by the guard above.
      if (!['NET_SALES', 'TIPS_COLLECTED'].includes(body.poolBasis))
        return NextResponse.json({ error: "poolBasis must be 'NET_SALES' or 'TIPS_COLLECTED'" }, { status: 400 })
      data.poolBasis = body.poolBasis
    }
    if (body.poolRatePct !== undefined) {
      const v = Number(body.poolRatePct)
      if (!isFinite(v) || v < 0 || v > 100) return NextResponse.json({ error: 'poolRatePct must be between 0 and 100' }, { status: 400 })
      data.poolRatePct = v
    }
    if (body.roundingStepCents !== undefined) {
      const v = Number(body.roundingStepCents)
      if (![5, 10, 25, 100, 500].includes(v)) return NextResponse.json({ error: 'roundingStepCents must be 5, 10, 25, 100 or 500' }, { status: 400 })
      data.roundingStepCents = v
    }
    if (body.ignoredClockIds !== undefined) {
      if (!Array.isArray(body.ignoredClockIds)) return NextResponse.json({ error: 'ignoredClockIds must be an array' }, { status: 400 })
      data.ignoredClockIds = [...new Set(body.ignoredClockIds.map(String))]
    }

    await prisma.tipPeriod.update({ where: { id: params.id }, data })
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[tips/periods/[id] PATCH]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
