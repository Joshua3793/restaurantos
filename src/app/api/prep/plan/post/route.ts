import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { resolveActive } from '@/lib/prep-runsheet'
import { prepDayStart, prepDayRange } from '@/lib/prep-plan-server'

export const dynamic = 'force-dynamic'

// Post today's draft to the kitchen: stamp postedAt on every draft item's log
// (creating missing logs), un-stamp anything posted earlier but since removed,
// and upsert the PrepPost header. The kitchen's To Do reads postedAt — nothing
// reaches a cook until this runs.
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
  const day = prepDayRange()

  // The draft = active on-list items visible to this RC (its own + Shared).
  const draft = await prisma.prepItem.findMany({
    where: {
      isActive: true, isOnList: true,
      OR: [{ revenueCenterId: null }, { revenueCenterId }],
    },
    select: {
      id: true, estimatedPrepTime: true,
      activeMinutesOverride: true, passiveMinutesOverride: true, passiveNoteOverride: true,
      linkedRecipe: { select: { activeMinutes: true, passiveMinutes: true, passiveNote: true } },
      logs: { where: { logDate: day }, take: 1, select: { id: true } },
    },
  })
  if (draft.length === 0) return NextResponse.json({ error: 'Nothing on the list to post' }, { status: 400 })

  const draftIds = draft.map(d => d.id)
  const activeMinutes = draft.reduce((a, d) => a + (resolveActive(d) ?? d.estimatedPrepTime ?? 0), 0)
  const now = new Date()
  const postedByName = user.name ?? user.email ?? 'Chef'
  const missing = draft.filter(d => d.logs.length === 0)

  const [, , , post] = await prisma.$transaction([
    // Items posted earlier but since removed from the draft leave the kitchen's list.
    prisma.prepLog.updateMany({
      where: { logDate: day, postedAt: { not: null }, prepItemId: { notIn: draftIds } },
      data: { postedAt: null },
    }),
    // Ensure every draft item has today's log (unique prepItemId+logDate absorbs races).
    prisma.prepLog.createMany({
      data: missing.map(d => ({ prepItemId: d.id, revenueCenterId, logDate: listDate, status: 'NOT_STARTED' })),
      skipDuplicates: true,
    }),
    prisma.prepLog.updateMany({
      where: { prepItemId: { in: draftIds }, logDate: day },
      data: { postedAt: now },
    }),
    prisma.prepPost.upsert({
      where: { revenueCenterId_listDate: { revenueCenterId, listDate } },
      update: { postedAt: now, postedByName, itemCount: draft.length, activeMinutes, dirty: false },
      create: { revenueCenterId, listDate, postedAt: now, postedByName, itemCount: draft.length, activeMinutes, dirty: false },
    }),
  ])

  return NextResponse.json({
    post: {
      id: post.id, postedAt: post.postedAt.toISOString(), postedByName: post.postedByName,
      itemCount: post.itemCount, activeMinutes: post.activeMinutes, dirty: post.dirty,
    },
  })
}
