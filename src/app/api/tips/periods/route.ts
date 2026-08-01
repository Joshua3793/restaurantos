import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { assertRcWritable, resolveScopedRcIds } from '@/lib/rc-scope'
import { addDays, defaultPeriodStart } from '@/lib/tips/period'
import { loadSettings } from '@/lib/tips/settings'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const user = await requireSession('MANAGER')
    const allowed = await resolveScopedRcIds(user)
    const settings = await loadSettings()

    const periods = await prisma.tipPeriod.findMany({
      where: allowed === null ? {} : { revenueCenterId: { in: [...allowed] } },
      orderBy: { startDate: 'desc' },
      take: 26,
      include: { revenueCenter: { select: { name: true } } },
    })

    const today = new Date().toISOString().slice(0, 10)
    return NextResponse.json({
      defaultStartDate: defaultPeriodStart(today, settings.periodStartDow, settings.periodDays),
      periods: periods.map(p => ({
        id: p.id,
        revenueCenterId: p.revenueCenterId,
        revenueCenterName: p.revenueCenter.name,
        startDate: p.startDate,
        endDate: p.endDate,
        status: p.status,
        paidAt: p.paidAt?.toISOString() ?? null,
        paidByName: p.paidByName,
      })),
    })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[tips/periods GET]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * Opens (or re-opens) the period starting on `startDate`. Idempotent: the
 * (revenueCenterId, startDate) unique key means clicking "next period" twice
 * lands on the same row rather than creating a duplicate.
 */
export async function POST(req: NextRequest) {
  try {
    const user = await requireSession('MANAGER')
    const body = await req.json().catch(() => ({}))
    const settings = await loadSettings()

    const startDate = String(body.startDate ?? '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate))
      return NextResponse.json({ error: 'startDate must be YYYY-MM-DD' }, { status: 400 })

    const rcId = String(body.revenueCenterId ?? settings.poolRevenueCenterId ?? '')
    if (!rcId) return NextResponse.json({ error: 'Pick the revenue center this pool belongs to in Tip settings first.' }, { status: 400 })
    await assertRcWritable(user, rcId)

    const existing = await prisma.tipPeriod.findUnique({
      where: { revenueCenterId_startDate: { revenueCenterId: rcId, startDate } },
    })
    if (existing) return NextResponse.json({ id: existing.id })

    const created = await prisma.tipPeriod.create({
      data: {
        revenueCenterId: rcId,
        startDate,
        endDate: addDays(startDate, settings.periodDays - 1),
        // Frozen from settings at open time: changing the house rule later must
        // never silently restate a period somebody has already been paid for.
        poolBasis: settings.poolBasis,
        poolRatePct: settings.poolRatePct,
        roundingStepCents: settings.roundingStepCents,
      },
    })
    return NextResponse.json({ id: created.id }, { status: 201 })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[tips/periods POST]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
