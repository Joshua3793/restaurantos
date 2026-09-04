import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { resolveActive } from '@/lib/prep-runsheet'
import { prepDayStart, ensureLiveLogs, postedOpenWhere } from '@/lib/prep-plan-server'

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
  // Optional: the step deadline label per item as the chef saw it in the post
  // dialog ("11:00", "TMRW 09:00"). Stamped on the live log as dueTime so the
  // To Do can keep showing what was posted if the live step moves later. The
  // client computes it (it already has the stock + service context); an
  // offline replay sends none and leaves dueTime untouched.
  const dues: Array<{ prepItemId: string; dueTime: string | null }> = Array.isArray(body?.dues)
    ? body.dues.filter((d: unknown): d is { prepItemId: string; dueTime: string | null } =>
        !!d && typeof d === 'object'
        && typeof (d as { prepItemId?: unknown }).prepItemId === 'string'
        && ((d as { dueTime?: unknown }).dueTime === null || typeof (d as { dueTime?: unknown }).dueTime === 'string'))
    : []
  if (!revenueCenterId) return NextResponse.json({ error: 'revenueCenterId is required' }, { status: 400 })
  try { await assertRcWritable(user, revenueCenterId) }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const listDate = prepDayStart()

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
    },
  })
  if (draft.length === 0) return NextResponse.json({ error: 'Nothing on the list to post' }, { status: 400 })

  const draftIds = draft.map(d => d.id)
  const activeMinutes = draft.reduce((a, d) => a + (resolveActive(d) ?? d.estimatedPrepTime ?? 0), 0)
  const now = new Date()
  const postedByName = user.name ?? user.email ?? 'Chef'

  // Stamp each item's LIVE log — a job carried over from an earlier list keeps its
  // row (and with it the cook's timer, claim and planned qty). Creating a fresh
  // row per calendar day would leave the carried one open behind it, and that row
  // would put the item back on the To Do as soon as the new one was completed.
  const liveLogs = await ensureLiveLogs(draftIds, revenueCenterId)
  const draftSet = new Set(draftIds)
  const dueWrites = dues.flatMap(d => {
    const id = draftSet.has(d.prepItemId) ? liveLogs.get(d.prepItemId) : undefined
    return id ? [prisma.prepLog.update({ where: { id }, data: { dueTime: d.dueTime } })] : []
  })

  const [, , post] = await prisma.$transaction([
    // Items posted earlier but since removed from the draft leave the kitchen's
    // list — including ones carried from an earlier day, which is why this is not
    // scoped to `day`. Scoped to this RC: posting must not empty another's list.
    prisma.prepLog.updateMany({
      where: { revenueCenterId, prepItemId: { notIn: draftIds }, ...postedOpenWhere },
      data: { postedAt: null },
    }),
    prisma.prepLog.updateMany({
      where: { id: { in: [...liveLogs.values()] } },
      data: { postedAt: now },
    }),
    prisma.prepPost.upsert({
      where: { revenueCenterId_listDate: { revenueCenterId, listDate } },
      update: { postedAt: now, postedByName, itemCount: draft.length, activeMinutes, dirty: false },
      create: { revenueCenterId, listDate, postedAt: now, postedByName, itemCount: draft.length, activeMinutes, dirty: false },
    }),
    ...dueWrites,
  ])

  return NextResponse.json({
    post: {
      id: post.id, postedAt: post.postedAt.toISOString(), postedByName: post.postedByName,
      itemCount: post.itemCount, activeMinutes: post.activeMinutes, dirty: post.dirty,
    },
  })
}
