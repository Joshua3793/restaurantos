import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { livePost, postedOpenWhere } from '@/lib/prep-plan-server'

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
  // Un-post everything this RC still has on the kitchen's list, whatever day it
  // was posted for — carried jobs are exactly what the kitchen is looking at.
  // Scoped to this RC: a recall must not empty another revenue center's To Do.
  const post = await livePost(revenueCenterId)
  await prisma.$transaction([
    prisma.prepLog.updateMany({
      where: { revenueCenterId, ...postedOpenWhere },
      data: { postedAt: null },
    }),
    prisma.prepPost.deleteMany({ where: post ? { id: post.id } : { id: '' } }),
  ])
  return NextResponse.json({ ok: true })
}
