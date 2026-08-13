import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { prepDayStart, prepDayRange } from '@/lib/prep-plan-server'

export const dynamic = 'force-dynamic'

// Recall today's posted list back to draft: the kitchen's To Do empties, the
// draft (isOnList) is untouched.
export async function POST(req: NextRequest) {
  let user
  try { user = await requireSession('LEAD') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
  const body = await req.json().catch(() => null)
  const revenueCenterId: string | undefined = body?.revenueCenterId
  if (!revenueCenterId) return NextResponse.json({ error: 'revenueCenterId is required' }, { status: 400 })
  try { await assertRcWritable(user, revenueCenterId) }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
  const listDate = prepDayStart()
  await prisma.$transaction([
    prisma.prepLog.updateMany({
      where: { logDate: prepDayRange(), postedAt: { not: null } },
      data: { postedAt: null },
    }),
    prisma.prepPost.deleteMany({ where: { revenueCenterId, listDate } }),
  ])
  return NextResponse.json({ ok: true })
}
