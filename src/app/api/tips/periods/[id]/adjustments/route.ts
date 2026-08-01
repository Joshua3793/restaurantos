import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { isRcInScope } from '@/lib/rc-scope'
import { periodDayCount } from '@/lib/tips/period'
import type { TipPeriod } from '@prisma/client'

export const dynamic = 'force-dynamic'

async function guard(
  userPromise: ReturnType<typeof requireSession>, id: string,
): Promise<{ error: NextResponse; period?: undefined } | { error?: undefined; period: TipPeriod }> {
  const user = await userPromise
  const period = await prisma.tipPeriod.findUnique({ where: { id } })
  if (!period) return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  if (!(await isRcInScope(user, period.revenueCenterId)))
    return { error: NextResponse.json({ error: 'Revenue center is outside your access.' }, { status: 403 }) }
  if (period.status === 'PAID')
    return { error: NextResponse.json({ error: 'This period is paid. Reopen it before editing hours.' }, { status: 409 }) }
  return { period }
}

/**
 * Upsert one person's override for one day.
 *   hours: number → manual hours replace the clocked hours
 *   hours: null   → fall back to the clocked hours
 *   boost: number → reward multiplier (1 = none)
 * A row whose hours are null AND boost is 1 carries no information, so it is
 * deleted rather than stored — that keeps the audit's "manual edits" line honest.
 */
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const g = await guard(requireSession('MANAGER'), params.id)
    if (g.error) return g.error

    const body = await req.json().catch(() => ({}))
    const cookId = String(body.cookId ?? '')
    const dayIndex = Number(body.dayIndex)
    // The bound is the PERIOD's own window, not the live, admin-editable
    // settings.periodDays. Too small blocks legitimate edits at the tail of a
    // long period; too large silently stores adjustments for days
    // `resolveRoster` never loops over, so they are accepted and then inert.
    const dayCount = periodDayCount(g.period.startDate, g.period.endDate)
    if (!cookId) return NextResponse.json({ error: 'cookId is required' }, { status: 400 })
    if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex >= dayCount)
      return NextResponse.json({ error: `dayIndex must be 0–${dayCount - 1}` }, { status: 400 })

    // isActive matters: build.ts and the payload route both resolve the roster
    // from `isActive: true` cooks only, so an adjustment against a deactivated
    // cook would store cleanly and then never apply to anything.
    const cook = await prisma.cook.findFirst({ where: { id: cookId, isActive: true } })
    if (!cook) return NextResponse.json({ error: 'Not a roster member' }, { status: 400 })

    const existing = await prisma.tipDayAdjustment.findUnique({
      where: { periodId_cookId_dayIndex: { periodId: params.id, cookId, dayIndex } },
    })

    let hours: number | null = existing?.hours == null ? null : Number(existing.hours)
    if (body.hours !== undefined) {
      if (body.hours === null || body.hours === '') hours = null
      else {
        const v = Number(body.hours)
        if (!isFinite(v) || v < 0 || v > 24) return NextResponse.json({ error: 'hours must be between 0 and 24' }, { status: 400 })
        hours = Math.round(v * 100) / 100
      }
    }

    let boost = existing ? Number(existing.boost) : 1
    if (body.boost !== undefined) {
      const v = Number(body.boost)
      if (!isFinite(v) || v < 1 || v > 5) return NextResponse.json({ error: 'boost must be between 1 and 5' }, { status: 400 })
      boost = v
    }

    if (hours == null && boost === 1) {
      if (existing) await prisma.tipDayAdjustment.delete({ where: { id: existing.id } })
      return NextResponse.json({ ok: true, cleared: true })
    }

    await prisma.tipDayAdjustment.upsert({
      where: { periodId_cookId_dayIndex: { periodId: params.id, cookId, dayIndex } },
      create: { periodId: params.id, cookId, dayIndex, hours, boost },
      update: { hours, boost },
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[tips/periods/[id]/adjustments PUT]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * Clears one person's adjustments (`?cookId=…`), or the whole period's — but
 * the period-wide clear needs an explicit `?all=true`. Every manual hours
 * override and reward boost in the period is real work somebody typed in, and
 * a bare DELETE (a dropped/typo'd query param, a client bug) used to wipe the
 * lot silently. Opting in is one extra param; recovering the data is not.
 */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const g = await guard(requireSession('MANAGER'), params.id)
    if (g.error) return g.error
    const cookId = req.nextUrl.searchParams.get('cookId')
    const all = req.nextUrl.searchParams.get('all') === 'true'
    if (!cookId && !all) {
      return NextResponse.json({
        error: 'Pass cookId to clear one person, or all=true to clear every adjustment in this period.',
      }, { status: 400 })
    }
    const { count } = await prisma.tipDayAdjustment.deleteMany({
      where: { periodId: params.id, ...(cookId ? { cookId } : {}) },
    })
    return NextResponse.json({ ok: true, cleared: count })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[tips/periods/[id]/adjustments DELETE]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
