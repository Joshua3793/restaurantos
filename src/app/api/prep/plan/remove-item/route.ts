import { NextRequest, NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { resolveActive } from '@/lib/prep-runsheet'
import { livePostIds, ensureLiveLogs, postedOpenWhere } from '@/lib/prep-plan-server'
import { isOpenPrepStatus } from '@/lib/prep-plan'

export const dynamic = 'force-dynamic'

// Take ONE item off the kitchen's To Do without the Smart Prep → remove →
// re-post round trip, or put it back (`restore`).
//
// The log half is exactly what a re-post produces: `POST /api/prep/plan/post`
// already clears postedAt for every item `notIn draftIds`.
//
// The header half is NOT a re-post, and deliberately so. `post/route.ts` writes
// `itemCount = draft.length` because at the instant of a post the draft IS the
// posted set. They diverge immediately afterwards — that is the whole reason
// `PrepPost.dirty` exists, and `/api/prep/items/[id]` calls `markPlanDirty` on
// every `isOnList` change. Re-deriving the counters from the draft here would
// therefore fold a chef's unposted next-day additions into a header that is
// supposed to describe what the cooks are looking at right now. So the header
// moves by the ONE item this call actually changed, and only when the log write
// really changed something — see the ±1 comments below.
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

  // The timing fields `resolveActive` needs, so the header's hands-on total can
  // be moved by this item's own minutes — the same expression POST
  // /api/prep/plan/post sums over the draft, evaluated on one row.
  const item = await prisma.prepItem.findUnique({
    where: { id: prepItemId },
    select: {
      id: true, revenueCenterId: true, estimatedPrepTime: true,
      activeMinutesOverride: true, passiveMinutesOverride: true, passiveNoteOverride: true,
      linkedRecipe: { select: { activeMinutes: true, passiveMinutes: true, passiveNote: true } },
    },
  })
  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // `assertRcWritable` guards the REQUEST's revenue center, not the item's. An
  // item owned by another center is not visible to this one: without this the
  // log write would match nothing (a silent no-op, the other center's To Do
  // keeps the job) while `isOnList` was still flipped on that center's draft.
  // Same for an item reassigned between centers after its logs were written.
  if (item.revenueCenterId && item.revenueCenterId !== revenueCenterId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // PrepLog is keyed (prepItemId, logDate) — logs are NOT partitioned per RC,
  // and `revenueCenterId` on the row is simply whichever center last wrote it
  // (/api/prep/logs rewrites it on every update). A Shared item (no RC of its
  // own) shows on EVERY RC's To Do and has ONE log, so a Cafe chef must be able
  // to clear a row a Catering cook flipped to Catering. Only an RC-owned item's
  // log is safely scoped by RC — and there it still matters, so a removal
  // cannot reach into another center's list. Keyed off `item.revenueCenterId`:
  // the guard above proved it equals `revenueCenterId` or the item is Shared.
  const logScope: Prisma.PrepLogWhereInput =
    item.revenueCenterId ? { revenueCenterId: item.revenueCenterId, prepItemId } : { prepItemId }

  // A Shared item's single log row leaves (or rejoins) EVERY center's To Do at
  // once, so every center's header has to move with it — otherwise Catering's
  // band goes on claiming "3 items · 65m" over a To Do that now holds 2. Same
  // fan-out rule `markPlanDirty` uses, through the same helper. For an RC-owned
  // item this is just that one center's live post.
  const postIds = await livePostIds(item.revenueCenterId ? revenueCenterId : null)
  const minutes = resolveActive(item) ?? item.estimatedPrepTime ?? 0

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
    //
    // That fallback does NOT always mint: `isLiveLog` short-circuits true on
    // the date, so if the newest row is TODAY's DONE row ensureLiveLogs hands
    // that row straight back and the stamp below lands on a DONE log. The end
    // state is still exactly what the removal left — `postedOpenWhere` means a
    // removal never cleared a DONE row's postedAt, and the stamp only fires on
    // a row whose postedAt is null — so the pair still round-trips.
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
      // `postedAt: null` in the where is what makes the restore idempotent: a
      // second Undo (a double tap, a timeout retry, the prep page's offline
      // queue replaying) stamps nothing and so must not walk the counters up.
      const stamped = await tx.prepLog.updateMany({
        where: { id: logId, postedAt: null },
        data: { postedAt: new Date() },
      })
      // updateMany, not update: a row deleted mid-flight must not P2025 into a
      // 500 on a restore that otherwise succeeded.
      await tx.prepItem.updateMany({ where: { id: prepItemId }, data: { isOnList: true } })
      // +1 for the one item just put back, gated on a log write that really
      // happened. Atomic increment so it cannot clobber a concurrent post's
      // counters with a value read before the transaction. `updateMany` also
      // covers a concurrent Recall having deleted the header — the same defence
      // recall/route.ts uses. postedAt / postedByName / dirty are the post's own
      // provenance and this route is not a post, so they are left alone.
      if (stamped.count > 0 && postIds.length > 0) {
        await tx.prepPost.updateMany({
          where: { id: { in: postIds } },
          data: { itemCount: { increment: 1 }, activeMinutes: { increment: minutes } },
        })
      }
    })
    return NextResponse.json({ ok: true })
  }

  await prisma.$transaction(async tx => {
    // Any day, not just today: a carried job's row is exactly what holds it on
    // the list. The row itself is never deleted; emptying the whole list is
    // what Recall is for.
    const cleared = await tx.prepLog.updateMany({
      where: { ...logScope, ...postedOpenWhere },
      data: { postedAt: null },
    })
    // updateMany, not update — see the restore path.
    await tx.prepItem.updateMany({ where: { id: prepItemId }, data: { isOnList: false } })
    // −1 for the one item just taken off, gated on `cleared.count` so a second
    // removal (retry, double tap, offline replay) clears nothing and decrements
    // nothing. `itemCount: { gte: 1 }` is a DEFENSIVE clamp only — the gate
    // above is what actually keeps the counters honest; it exists so a header
    // corrupted by some other path can never be driven negative.
    if (cleared.count > 0 && postIds.length > 0) {
      await tx.prepPost.updateMany({
        where: { id: { in: postIds }, itemCount: { gte: 1 } },
        data: { itemCount: { decrement: 1 }, activeMinutes: { decrement: minutes } },
      })
    }
  })

  return NextResponse.json({ ok: true })
}
