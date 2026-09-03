import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { resolveActive } from '@/lib/prep-runsheet'
import { livePost, ensureLiveLogs, postedOpenWhere } from '@/lib/prep-plan-server'

export const dynamic = 'force-dynamic'

// Take ONE item off the kitchen's To Do without the Smart Prep → remove →
// re-post round trip, or put it back (`restore`).
//
// The end state is exactly what a re-post produces: `POST /api/prep/plan/post`
// already clears postedAt for every item `notIn draftIds`. This is a shortcut to
// a state the app can already reach, not a new one.
//
// Deliberately NOT here: any inventory write. No PrepLog status change, no
// theoretical-stock invalidation, no InventoryTransaction. The prep is simply
// not on today's list.
//
// Deliberately NOT here: markPlanDirty. The removal is already reflected on the
// line, so flagging the post as "chef has unposted changes" would be a lie.
export async function POST(req: NextRequest) {
  let user
  try { user = await requireSession('LEAD') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const body = await req.json().catch(() => null)
  const revenueCenterId: string | undefined = body?.revenueCenterId
  const prepItemId: string | undefined = body?.prepItemId
  const restore: boolean = body?.restore === true
  if (!revenueCenterId) return NextResponse.json({ error: 'revenueCenterId is required' }, { status: 400 })
  if (!prepItemId) return NextResponse.json({ error: 'prepItemId is required' }, { status: 400 })

  try { await assertRcWritable(user, revenueCenterId) }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  // Minutes this item contributes to the posted header's hands-on total — the
  // same expression POST /api/prep/plan/post sums when it builds that total.
  const item = await prisma.prepItem.findUnique({
    where: { id: prepItemId },
    select: {
      id: true, estimatedPrepTime: true,
      activeMinutesOverride: true, passiveMinutesOverride: true, passiveNoteOverride: true,
      linkedRecipe: { select: { activeMinutes: true, passiveMinutes: true, passiveNote: true } },
    },
  })
  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const itemMinutes = resolveActive(item) ?? item.estimatedPrepTime ?? 0

  const post = await livePost(revenueCenterId)

  if (restore) {
    // postedOpenWhere requires postedAt != null, so it cannot find the row the
    // removal just cleared. ensureLiveLogs resolves (or creates) the item's ONE
    // live log — the same primitive the post route uses, and what keeps the
    // one-live-log-per-item invariant.
    const liveLogs = await ensureLiveLogs([prepItemId], revenueCenterId)
    const logId = liveLogs.get(prepItemId)
    if (!logId) return NextResponse.json({ error: 'Could not resolve a live log for this item' }, { status: 409 })

    await prisma.$transaction([
      prisma.prepLog.update({ where: { id: logId }, data: { postedAt: new Date() } }),
      prisma.prepItem.update({ where: { id: prepItemId }, data: { isOnList: true } }),
      ...(post ? [prisma.prepPost.update({
        where: { id: post.id },
        data: { itemCount: post.itemCount + 1, activeMinutes: post.activeMinutes + itemMinutes },
      })] : []),
    ])
    return NextResponse.json({ ok: true })
  }

  await prisma.$transaction([
    // Any day, not just today: a carried job's row is exactly what holds it on
    // the list. Scoped to this RC so a removal cannot empty another's To Do.
    prisma.prepLog.updateMany({
      where: { revenueCenterId, prepItemId, ...postedOpenWhere },
      data: { postedAt: null },
    }),
    prisma.prepItem.update({ where: { id: prepItemId }, data: { isOnList: false } }),
    // Keep the posted header honest — PostedBand renders both of these. Floored
    // at 0: a header can predate this item joining the list. The row itself is
    // never deleted; emptying the whole list is what Recall is for.
    ...(post ? [prisma.prepPost.update({
      where: { id: post.id },
      data: {
        itemCount: Math.max(0, post.itemCount - 1),
        activeMinutes: Math.max(0, post.activeMinutes - itemMinutes),
      },
    })] : []),
  ])

  return NextResponse.json({ ok: true })
}
