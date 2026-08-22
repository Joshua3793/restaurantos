import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { MY_PAYOUT_LIMIT, projectMyPayout, type MyPayout } from '@/lib/tips/me'

export const dynamic = 'force-dynamic'

/**
 * The caller's OWN tip payouts. THE ONLY STAFF-REACHABLE TIPS ENDPOINT — every
 * other route under /api/tips/* is requireSession('MANAGER') and must stay that
 * way. Deliberately no minRole here: a manager who is also on the roster reads
 * their own pay through the same door.
 *
 * Paid periods only. A DRAFT recomputes whenever hours, a rate or an import
 * change, so it must never be served as though it were settled.
 *
 * Nothing here shapes the response — `projectMyPayout` is the whitelist, and it
 * is the only thing that ever touches a snapshot record.
 */
export async function GET() {
  try {
    const user = await requireSession()

    const cook = await prisma.cook.findUnique({
      where: { userId: user.id },
      select: { id: true, name: true },
    })
    // NOT a 404: the caller is a perfectly valid user who simply has no roster
    // row. The screen must say "ask a manager to link you", never "$0.00".
    if (!cook) {
      return NextResponse.json({ linked: false }, { headers: { 'Cache-Control': 'no-store' } })
    }

    // Every period that has EVER been paid — including reopened ones, whose
    // snapshot survives with current: null. Capped before projection, so a cook
    // who was off the pool for some of them correctly sees fewer rows.
    const periods = await prisma.tipPeriod.findMany({
      where: { snapshot: { not: Prisma.JsonNull } },
      orderBy: { startDate: 'desc' },
      take: MY_PAYOUT_LIMIT,
      select: { id: true, startDate: true, endDate: true, snapshot: true },
    })

    const payouts = periods
      .map(p => projectMyPayout({
        periodId: p.id,
        startDate: p.startDate,
        endDate: p.endDate,
        snapshotRaw: p.snapshot,
        cookId: cook.id,
      }))
      .filter((p): p is MyPayout => p !== null)

    return NextResponse.json(
      { linked: true, name: cook.name, payouts },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
}
