import { NextRequest, NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { resolveActive } from '@/lib/prep-runsheet'
import { livePost, ensureLiveLogs, postedOpenWhere } from '@/lib/prep-plan-server'
import { isOpenPrepStatus } from '@/lib/prep-plan'

export const dynamic = 'force-dynamic'

// The timing fields POST /api/prep/plan/post feeds to `resolveActive` when it
// sums the posted header's hands-on total. Shared so the recompute below is the
// same expression, on the same rows, as the post it has to agree with.
const DRAFT_TIMING_SELECT = {
  id: true, estimatedPrepTime: true,
  activeMinutesOverride: true, passiveMinutesOverride: true, passiveNoteOverride: true,
  linkedRecipe: { select: { activeMinutes: true, passiveMinutes: true, passiveNote: true } },
} as const

/**
 * Rewrite the posted header's counters from the draft as it now stands — the
 * same query and the same sum POST /api/prep/plan/post runs.
 *
 * Derived, never incremented: arithmetic on a value read before the write is
 * wrong the moment the same call is replayed (the prep page queues these
 * offline), or the log write it is supposed to describe matches nothing. This
 * is idempotent, so it needs no floor and survives a replay or a concurrent
 * post. `updateMany` because a concurrent Recall may have deleted the header
 * mid-flight — the same defence recall/route.ts uses — and it must not 500 a
 * removal that otherwise succeeded.
 *
 * Only the counters are touched: postedAt / postedByName / dirty are the post's
 * own provenance and this route is not a post.
 */
async function recomputeHeaderCounters(tx: Prisma.TransactionClient, revenueCenterId: string, postId: string) {
  const draft = await tx.prepItem.findMany({
    where: {
      isActive: true, isOnList: true,
      OR: [{ revenueCenterId: null }, { revenueCenterId }],
    },
    select: DRAFT_TIMING_SELECT,
  })
  const activeMinutes = draft.reduce((a, d) => a + (resolveActive(d) ?? d.estimatedPrepTime ?? 0), 0)
  await tx.prepPost.updateMany({
    where: { id: postId },
    data: { itemCount: draft.length, activeMinutes },
  })
}

// Take ONE item off the kitchen's To Do without the Smart Prep → remove →
// re-post round trip, or put it back (`restore`).
//
// The end state is exactly what a re-post produces: `POST /api/prep/plan/post`
// already clears postedAt for every item `notIn draftIds`, and rebuilds the
// header's counters from the draft. Both halves are reproduced here, so this is
// a shortcut to a state the app can already reach, not a new one.
//
// Deliberately NOT here: any inventory write. No PrepLog status change, no
// theoretical-stock invalidation, no InventoryTransaction. The prep is simply
// not on today's list.
//
// Deliberately NOT here: markPlanDirty. The removal is already reflected on the
// line, so flagging the post as "chef has unposted changes" would be a lie. A
// Shared item has a single log row, so clearing its postedAt takes it off every
// RC's To Do at once — that line is reflected too.
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

  const item = await prisma.prepItem.findUnique({
    where: { id: prepItemId },
    select: { id: true, revenueCenterId: true },
  })
  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // PrepLog is keyed (prepItemId, logDate) — logs are NOT partitioned per RC,
  // and `revenueCenterId` on the row is simply whichever center last wrote it
  // (/api/prep/logs rewrites it on every update). A Shared item (no RC of its
  // own) shows on EVERY RC's To Do and has ONE log, so a Cafe chef must be able
  // to clear a row a Catering cook flipped to Catering. Only an RC-owned item's
  // log is safely scoped by RC — and there it still matters, so a removal
  // cannot reach into another center's list.
  const logScope: Prisma.PrepLogWhereInput =
    item.revenueCenterId ? { revenueCenterId, prepItemId } : { prepItemId }

  const post = await livePost(revenueCenterId)

  if (restore) {
    // Undo. The removal cleared postedAt on the item's newest row, which for a
    // job carried from an earlier day makes `isLiveLog` (it needs postedAt on a
    // pre-today row) stop recognising it — ensureLiveLogs would drop it into
    // `missing` and mint a fresh NOT_STARTED row, orphaning the cook's timer,
    // claim and planned qty on the abandoned one. So re-stamp that exact row
    // when it is still open.
    //
    // Newest row ONLY, never the newest OPEN row: reaching past a resolved row
    // to an older open one resurrects a job that was already made — see
    // NEWEST_LOG in src/lib/prep-plan-server.ts. When the newest row IS
    // resolved (or there is none), fall back to ensureLiveLogs, the same
    // primitive the post route uses, which keeps the one-live-log-per-item
    // invariant.
    const newest = await prisma.prepLog.findFirst({
      where: logScope,
      orderBy: { logDate: 'desc' },
      select: { id: true, status: true },
    })
    let candidate = newest && isOpenPrepStatus(newest.status) ? newest.id : undefined
    if (!candidate) {
      const liveLogs = await ensureLiveLogs([prepItemId], revenueCenterId)
      candidate = liveLogs.get(prepItemId)
    }
    if (!candidate) return NextResponse.json({ error: 'Could not resolve a live log for this item' }, { status: 409 })
    const logId = candidate

    await prisma.$transaction(async tx => {
      await tx.prepLog.update({ where: { id: logId }, data: { postedAt: new Date() } })
      await tx.prepItem.update({ where: { id: prepItemId }, data: { isOnList: true } })
      // After the isOnList write, so the draft it reads is the post-restore one.
      if (post) await recomputeHeaderCounters(tx, revenueCenterId, post.id)
    })
    return NextResponse.json({ ok: true })
  }

  await prisma.$transaction(async tx => {
    // Any day, not just today: a carried job's row is exactly what holds it on
    // the list. The row itself is never deleted; emptying the whole list is
    // what Recall is for.
    await tx.prepLog.updateMany({
      where: { ...logScope, ...postedOpenWhere },
      data: { postedAt: null },
    })
    await tx.prepItem.update({ where: { id: prepItemId }, data: { isOnList: false } })
    // Keep the posted header honest — PostedBand renders both counters.
    if (post) await recomputeHeaderCounters(tx, revenueCenterId, post.id)
  })

  return NextResponse.json({ ok: true })
}
