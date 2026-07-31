import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { resolveSalesScopeRcIds } from '@/lib/tips/sales'
import { toDto, loadSettings } from '@/lib/tips/settings'

// Singleton row + a PUT handler: this route MUST stay dynamic or PUT 405s in prod.
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const user = await requireSession('MANAGER')
    const settings = await loadSettings()
    const scope = await resolveSalesScopeRcIds(user, settings)
    return NextResponse.json({ ...toDto(settings), salesScopeLabel: scope.label, salesScopeRcIds: scope.rcIds })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[tips/settings GET]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  try {
    const user = await requireSession('MANAGER')
    const body = await req.json().catch(() => ({}))
    const data: Record<string, unknown> = {}

    if (body.poolBasis !== undefined) {
      if (!['NET_SALES', 'TIPS_COLLECTED'].includes(body.poolBasis))
        return NextResponse.json({ error: "poolBasis must be 'NET_SALES' or 'TIPS_COLLECTED'" }, { status: 400 })
      data.poolBasis = body.poolBasis
    }
    if (body.includeAutoGratuity !== undefined) {
      if (typeof body.includeAutoGratuity !== 'boolean')
        return NextResponse.json({ error: 'includeAutoGratuity must be a boolean' }, { status: 400 })
      data.includeAutoGratuity = body.includeAutoGratuity
    }
    if (body.poolRatePct !== undefined) {
      const v = Number(body.poolRatePct)
      if (!isFinite(v) || v < 0 || v > 100) return NextResponse.json({ error: 'poolRatePct must be between 0 and 100' }, { status: 400 })
      data.poolRatePct = v
    }
    if (body.defaultDailyHourCap !== undefined) {
      // Prefill for NEW roster rows only. Changing it never restates a period —
      // the live cap is Cook.dailyHourCap, edited per person.
      if (body.defaultDailyHourCap === null || body.defaultDailyHourCap === '') data.defaultDailyHourCap = null
      else {
        const v = Number(body.defaultDailyHourCap)
        if (!isFinite(v) || v <= 0 || v > 24) return NextResponse.json({ error: 'defaultDailyHourCap must be between 0 and 24 hours' }, { status: 400 })
        data.defaultDailyHourCap = v
      }
    }
    if (body.rewardTiers !== undefined) {
      if (!Array.isArray(body.rewardTiers) || body.rewardTiers.some((n: unknown) => !isFinite(Number(n)) || Number(n) < 1))
        return NextResponse.json({ error: 'rewardTiers must be numbers of 1 or more' }, { status: 400 })
      const tierNums: number[] = Array.from(new Set(body.rewardTiers.map((n: unknown) => Number(n))))
      data.rewardTiers = tierNums.sort((a, b) => a - b)
    }
    if (body.roundingStepCents !== undefined) {
      const v = Number(body.roundingStepCents)
      if (![5, 10, 25, 100, 500].includes(v)) return NextResponse.json({ error: 'roundingStepCents must be 5, 10, 25, 100 or 500' }, { status: 400 })
      data.roundingStepCents = v
    }
    if (body.periodDays !== undefined) {
      const v = Number(body.periodDays)
      if (![7, 14, 28].includes(v)) return NextResponse.json({ error: 'periodDays must be 7, 14 or 28' }, { status: 400 })
      data.periodDays = v
    }
    if (body.periodStartDow !== undefined) {
      const v = Number(body.periodStartDow)
      if (!Number.isInteger(v) || v < 0 || v > 6) return NextResponse.json({ error: 'periodStartDow must be 0–6' }, { status: 400 })
      data.periodStartDow = v
    }
    if (body.salesSourceMode !== undefined) {
      if (!['LOCATION', 'RC'].includes(body.salesSourceMode))
        return NextResponse.json({ error: "salesSourceMode must be 'LOCATION' or 'RC'" }, { status: 400 })
      data.salesSourceMode = body.salesSourceMode
    }
    if (body.salesLocationId !== undefined) data.salesLocationId = body.salesLocationId || null
    if (body.salesRcIds !== undefined) {
      if (!Array.isArray(body.salesRcIds)) return NextResponse.json({ error: 'salesRcIds must be an array' }, { status: 400 })
      data.salesRcIds = body.salesRcIds.map(String)
    }
    if (body.poolRevenueCenterId !== undefined) data.poolRevenueCenterId = body.poolRevenueCenterId || null
    if (body.poolDepartments !== undefined) {
      if (!Array.isArray(body.poolDepartments)) return NextResponse.json({ error: 'poolDepartments must be an array' }, { status: 400 })
      data.poolDepartments = body.poolDepartments.map(String)
    }
    if (body.posMap !== undefined) data.posMap = body.posMap ?? {}
    if (body.denoms !== undefined) {
      if (!Array.isArray(body.denoms)) return NextResponse.json({ error: 'denoms must be an array' }, { status: 400 })
      data.denoms = body.denoms
    }

    await loadSettings() // guarantee the row exists before update
    const saved = await prisma.tipSettings.update({ where: { id: 'singleton' }, data })
    const scope = await resolveSalesScopeRcIds(user, saved)
    return NextResponse.json({ ...toDto(saved), salesScopeLabel: scope.label, salesScopeRcIds: scope.rcIds })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[tips/settings PUT]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
