import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { prepDayKey, prepDayFrom } from '@/lib/prep-day'

export const dynamic = 'force-dynamic'

// Who's on today (Smart Prep): the cooks the chef ticked, per kitchen per prep
// day. GET reads today's row (none → nobody ticked); PUT replaces it. Any cook
// who can plan this kitchen may set it — same gate as posting the list.

const MAX_CREW = 50

const fail = (e: unknown) => {
  if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
  throw e
}

/** The planning day: today, or tomorrow once the day has rolled after close
 *  (the chef ticks tomorrow's crew in the evening). Anything else → null. */
function planningDay(raw: unknown): Date | null {
  const today = prepDayKey()
  if (raw == null || raw === '') return prepDayFrom(today)
  const tomorrow = prepDayKey(new Date(Date.now() + 86_400_000))
  return raw === today || raw === tomorrow ? prepDayFrom(raw) : null
}

const asIds = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

export async function GET(req: NextRequest) {
  try { await requireSession() } catch (e) { return fail(e) }
  const rc = req.nextUrl.searchParams.get('rc')
  if (!rc) return NextResponse.json({ error: 'rc is required' }, { status: 400 })
  const listDate = planningDay(req.nextUrl.searchParams.get('day'))
  if (!listDate) return NextResponse.json({ error: 'day must be today or tomorrow' }, { status: 400 })
  const row = await prisma.prepCrewDay.findUnique({
    where: { revenueCenterId_listDate: { revenueCenterId: rc, listDate } },
    select: { cookIds: true },
  })
  return NextResponse.json({ cookIds: asIds(row?.cookIds) })
}

export async function PUT(req: NextRequest) {
  let user
  try { user = await requireSession() } catch (e) { return fail(e) }
  const body = await req.json().catch(() => null)
  const revenueCenterId: unknown = body?.revenueCenterId
  if (typeof revenueCenterId !== 'string' || !revenueCenterId) {
    return NextResponse.json({ error: 'revenueCenterId is required' }, { status: 400 })
  }
  if (!Array.isArray(body?.cookIds)) return NextResponse.json({ error: 'cookIds must be a list' }, { status: 400 })
  const listDate = planningDay(body?.day)
  if (!listDate) return NextResponse.json({ error: 'day must be today or tomorrow' }, { status: 400 })
  try { await assertRcWritable(user, revenueCenterId) } catch (e) { return fail(e) }

  const wanted = [...new Set(asIds(body.cookIds))].slice(0, MAX_CREW)
  const known = new Set(
    (await prisma.cook.findMany({ where: { id: { in: wanted }, isActive: true }, select: { id: true } })).map(c => c.id),
  )
  const cookIds = wanted.filter(id => known.has(id))
  const row = await prisma.prepCrewDay.upsert({
    where: { revenueCenterId_listDate: { revenueCenterId, listDate } },
    create: { revenueCenterId, listDate, cookIds },
    update: { cookIds },
    select: { cookIds: true },
  })
  return NextResponse.json({ cookIds: asIds(row.cookIds) })
}
