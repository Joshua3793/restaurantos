import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { ensureLiveLogs, markPlanDirty } from '@/lib/prep-plan-server'

export const dynamic = 'force-dynamic'

// Persist the chef's within-bucket order for today's draft. Creates missing
// logs (statusless), then writes listOrder per item.
export async function PATCH(req: NextRequest) {
  let user
  try { user = await requireSession('LEAD') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
  const body = await req.json().catch(() => null)
  const revenueCenterId: string | undefined = body?.revenueCenterId
  const orders: Array<{ prepItemId: string; listOrder: number }> = Array.isArray(body?.orders) ? body.orders : []
  if (!revenueCenterId || orders.length === 0) {
    return NextResponse.json({ error: 'revenueCenterId and orders are required' }, { status: 400 })
  }
  try { await assertRcWritable(user, revenueCenterId) }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
  // Order is written on the item's LIVE log, so re-ordering a job carried over
  // from an earlier list edits that row instead of opening a duplicate.
  const liveLogs = await ensureLiveLogs(orders.map(o => o.prepItemId), revenueCenterId)
  await prisma.$transaction(
    orders.flatMap(o => {
      const id = liveLogs.get(o.prepItemId)
      return id ? [prisma.prepLog.update({ where: { id }, data: { listOrder: o.listOrder } })] : []
    }),
  )
  await markPlanDirty(revenueCenterId)
  return NextResponse.json({ ok: true })
}
