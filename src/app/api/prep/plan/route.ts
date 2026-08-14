import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { prepDayStart } from '@/lib/prep-plan-server'

// Polled alongside /api/prep/items — must always run live.
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
  const rcId = new URL(req.url).searchParams.get('rcId')
  if (!rcId) return NextResponse.json({ post: null }, { headers: { 'Cache-Control': 'no-store' } })
  const row = await prisma.prepPost.findUnique({
    where: { revenueCenterId_listDate: { revenueCenterId: rcId, listDate: prepDayStart() } },
  })
  const post = row ? {
    id: row.id, postedAt: row.postedAt.toISOString(), postedByName: row.postedByName,
    itemCount: row.itemCount, activeMinutes: row.activeMinutes, dirty: row.dirty,
  } : null
  return NextResponse.json({ post }, { headers: { 'Cache-Control': 'no-store' } })
}
