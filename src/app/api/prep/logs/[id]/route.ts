import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { validatePrepQty } from '@/lib/prep-utils'
import { invalidateTheoreticalCache } from '@/lib/theoretical-cache'
import { markPlanDirty, prepDayStart, postedOpenWhere } from '@/lib/prep-plan-server'
import { isOpenPrepStatus } from '@/lib/prep-plan'
import { resolveStages, appendStageEvent, STAGE_DONE_KEY } from '@/lib/prep-stages'
import { Prisma } from '@prisma/client'
import { parseProgress } from '@/lib/prep-progress'
import { parseMethod } from '@/lib/recipe-method'
import { cookSequence, stepMoveFields, checkStepMove, moveTime } from '@/lib/prep-steps'

// Mutating handlers must never be statically prerendered — a prerendered
// route serves GET only and returns 405 for everything else.
export const dynamic = 'force-dynamic'

const COMPLETION_STATUSES = new Set(['DONE', 'PARTIAL'])

export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const body = await req.json()
  const { actualPrepQty, assignedTo, dueTime, note, blockedReason, requiredQty, listOrder, stageIndex, stepKey, fromStepKey, at, progress } = body
  let { status } = body

  // Planner draft fields (planned qty, chef note, bucket order) are the chef's:
  // LEAD+. `assignedTo` deliberately stays session-only — cooks claim their own.
  const editsPlan = requiredQty !== undefined || listOrder !== undefined || note !== undefined
  if (editsPlan) {
    try { await requireSession() }
    catch (e) {
      if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
      throw e
    }
  }

  const existing = await prisma.prepLog.findUnique({ where: { id: params.id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // ── Staged prep ─────────────────────────────────────────────────────────
  // Stage progress rides this ONE live log. A cook's `stageIndex` (Next / Back)
  // is validated against the recipe's resolved chain, stamps `stageEnteredAt`,
  // appends to the history (a correction is recorded, never erased) and forces
  // the log IN_PROGRESS when it is still open. Start resumes the stage the job
  // was on (else the first); Stop KEEPS the place (stage + step cursor) so Start
  // carries on from it; Done appends a terminal event.
  //
  // A `stepKey` move (Next / Back one method step — src/lib/prep-steps.ts) sets
  // the cursor and, through stepMoveFields, keeps the chain stage in sync.
  // Unstaged items: none of this writes anything. No LEAD gate — cooks advance
  // their own jobs, like Start / Done.
  const stageStamp: {
    stageIndex?: number | null; stageEnteredAt?: Date | null; stageHistory?: Prisma.InputJsonValue
    stepKey?: string | null; stepEnteredAt?: Date | null
  } = {}
  if (stageIndex !== undefined || stepKey !== undefined || status !== undefined) {
    const owner = await prisma.prepItem.findUnique({
      where: { id: existing.prepItemId },
      select: { linkedRecipe: { select: { stages: true, method: true } } },
    })
    const stages = resolveStages(owner?.linkedRecipe)
    const nowIso = new Date().toISOString()
    const enter = (index: number) => {
      stageStamp.stageIndex = index
      stageStamp.stageEnteredAt = new Date(nowIso)
      stageStamp.stageHistory = appendStageEvent(existing.stageHistory, {
        index, key: stages![index].key, enteredAt: nowIso, ...(existing.assignedTo ? { byCookId: existing.assignedTo } : {}),
      }) as unknown as Prisma.InputJsonValue
    }
    if (stepKey !== undefined) {
      const seq = cookSequence(parseMethod(owner?.linkedRecipe?.method))
      if (!seq) return NextResponse.json({ error: 'This item has no method' }, { status: 400 })
      if (typeof stepKey !== 'string') return NextResponse.json({ error: 'Unknown step' }, { status: 400 })
      const cursorLog = {
        status: existing.status, stepKey: existing.stepKey,
        stageIndex: existing.stageIndex, stageEnteredAt: existing.stageEnteredAt?.toISOString() ?? null,
        stageHistory: existing.stageHistory,
      }
      // A screen that has not caught up (another device already moved the job,
      // or finished it) must not drag it back out of a wait. A repeat of the
      // same move is a harmless no-op.
      const verdict = checkStepMove(seq, cursorLog, typeof fromStepKey === 'string' ? fromStepKey : null, stepKey)
      if (verdict === 'stale') return NextResponse.json({ error: 'This job was moved on another screen — showing the latest.' }, { status: 409 })
      if (verdict === 'noop') return NextResponse.json(existing)
      // An offline tap replays later: keep the time it was tapped.
      const when = moveTime(nowIso, typeof at === 'string' ? at : null, existing.stepEnteredAt?.toISOString() ?? null)
      const move = stepMoveFields(seq, cursorLog, stepKey, when, existing.assignedTo)
      if (!move) return NextResponse.json({ error: 'Unknown step' }, { status: 400 })
      stageStamp.stepKey = move.stepKey
      stageStamp.stepEnteredAt = new Date(move.stepEnteredAt)
      if (move.stageIndex !== undefined) {
        stageStamp.stageIndex = move.stageIndex
        stageStamp.stageEnteredAt = new Date(move.stageEnteredAt ?? when)
        stageStamp.stageHistory = move.stageHistory as unknown as Prisma.InputJsonValue
      }
      if (status === undefined && isOpenPrepStatus(existing.status)) status = 'IN_PROGRESS'
    } else if (stageIndex !== undefined) {
      if (!stages) return NextResponse.json({ error: 'This item has no stages' }, { status: 400 })
      const idx = Number(stageIndex)
      if (!Number.isInteger(idx) || idx < 0 || idx >= stages.length) {
        return NextResponse.json({ error: `stageIndex must be between 0 and ${stages.length - 1}` }, { status: 400 })
      }
      enter(idx)
      // A block-level move (an old screen, or a stage move queued before the
      // step cursor shipped): drop the saved step so the job reads from the
      // start of its new block instead of a step it has left.
      stageStamp.stepKey = null
      stageStamp.stepEnteredAt = null
      if (status === undefined && isOpenPrepStatus(existing.status)) status = 'IN_PROGRESS'
    } else if (stages && status === 'IN_PROGRESS' && existing.status !== 'IN_PROGRESS') {
      // Start (or reopen): resume the stage the job was on, else the first — with a fresh clock.
      const resume = existing.stageIndex != null && stages[existing.stageIndex] ? existing.stageIndex : 0
      enter(resume)
    } else if (status === 'NOT_STARTED') {
      // Stop keeps the place — nothing to write; the next Start resumes it.
    } else if (stages && status !== undefined && COMPLETION_STATUSES.has(status) && existing.stageIndex != null) {
      stageStamp.stageHistory = appendStageEvent(existing.stageHistory, {
        index: stages.length, key: STAGE_DONE_KEY, enteredAt: nowIso, ...(existing.assignedTo ? { byCookId: existing.assignedTo } : {}),
      }) as unknown as Prisma.InputJsonValue
    }
  }

  // Step cursor: Start (or reopen) gives a saved HANDS-ON step a fresh clock (a
  // saved wait keeps its own — the dough kept resting while stopped); finishing,
  // skipping or leaving the list clears it (a re-added job starts at step 1).
  if (stepKey === undefined && status === 'IN_PROGRESS' && existing.status !== 'IN_PROGRESS' && existing.stepKey && !existing.stepKey.endsWith(':wait')) {
    stageStamp.stepEnteredAt = new Date()
  }
  if (status !== undefined && (COMPLETION_STATUSES.has(status) || status === 'SKIPPED')) {
    stageStamp.stepKey = null
    stageStamp.stepEnteredAt = null
  }

  // ── Cook-along progress ─────────────────────────────────────────────────
  // Scale + ticked ingredients + ticked method steps ride this live log while
  // the item is on the To Do (src/lib/prep-progress.ts). No LEAD gate — it is
  // the cook's own working. `null` clears; a completion or skip clears it too,
  // so a re-added item starts from a clean sheet. Stop (NOT_STARTED) keeps it.
  let progressData: Prisma.InputJsonValue | typeof Prisma.DbNull | undefined
  if (progress !== undefined) {
    if (progress === null) progressData = Prisma.DbNull
    else {
      const parsed = parseProgress(progress)
      if (!parsed) return NextResponse.json({ error: 'progress must be an object' }, { status: 400 })
      progressData = parsed as unknown as Prisma.InputJsonValue
    }
  }
  if (status !== undefined && (COMPLETION_STATUSES.has(status) || status === 'SKIPPED')) progressData = Prisma.DbNull

  // Require actualPrepQty when completing
  const qty =
    actualPrepQty !== undefined
      ? parseFloat(String(actualPrepQty))
      : existing.actualPrepQty
        ? parseFloat(String(existing.actualPrepQty))
        : null

  if (status && COMPLETION_STATUSES.has(status) && !qty) {
    return NextResponse.json(
      { error: 'actualPrepQty is required to mark as Done or Partial' },
      { status: 400 },
    )
  }

  // Guard against unit-magnitude typos (e.g. 25000 into a kg field). Only when a
  // new qty is being recorded — leave existing rows untouched on metadata edits.
  if (actualPrepQty !== undefined && qty != null) {
    const prepItem = await prisma.prepItem.findUnique({
      where: { id: existing.prepItemId },
      select: { unit: true, linkedRecipe: { select: { yieldUnit: true, baseYieldQty: true } } },
    })
    if (prepItem?.linkedRecipe) {
      const err = validatePrepQty(qty, prepItem.unit, prepItem.linkedRecipe.yieldUnit, Number(prepItem.linkedRecipe.baseYieldQty))
      if (err) return NextResponse.json({ error: err }, { status: 400 })
    }
  }

  // Stamp start/completion on status transitions so the run sheet's live
  // in-progress timers work. IN_PROGRESS sets startedAt once (never overwrites
  // an existing start); an explicit completedAt:null in the same request clears
  // completedAt (the "reopen" case). DONE stamps completedAt.
  const now = new Date()
  const stamp: { startedAt?: Date; completedAt?: Date | null; logDate?: Date } = {}
  if (status === 'IN_PROGRESS') {
    stamp.startedAt = existing.startedAt ?? now
    if (body.completedAt === null) stamp.completedAt = null
  }
  if (status === 'DONE') stamp.completedAt = now

  // A job carried over from an earlier list is finished TODAY — re-date it, or the
  // production lands on the day it was posted for. That is not cosmetic: the
  // theoretical-stock engine windows prep against `logDate` (prepEventCounts in
  // count-expected.ts), so a stale date can push the yield behind a count cutoff
  // and the stock never gets credited. An item can hold more than one row a day
  // now (a second batch after the first was done), so this never collides.
  if (status !== undefined && COMPLETION_STATUSES.has(status)) {
    const today = prepDayStart()
    if (existing.logDate.getTime() < today.getTime()) stamp.logDate = today
  }

  // Reopening a finished batch while the item already has another open job today
  // would leave two open rows (PrepLog_one_open_per_item_day) — say so plainly.
  const log = await prisma.prepLog.update({
    where: { id: params.id },
    data: {
      ...(status        !== undefined && { status }),
      ...(actualPrepQty !== undefined && { actualPrepQty: parseFloat(String(actualPrepQty)) }),
      ...(assignedTo    !== undefined && { assignedTo }),
      ...(dueTime       !== undefined && { dueTime }),
      ...(note          !== undefined && { note }),
      ...(blockedReason !== undefined && { blockedReason }),
      ...(requiredQty   !== undefined && { requiredQty: requiredQty === null ? null : parseFloat(String(requiredQty)) }),
      ...(listOrder     !== undefined && { listOrder }),
      ...stamp,
      ...stageStamp,
      ...(progressData !== undefined && { progress: progressData }),
    },
  }).catch(e => {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return null
    throw e
  })
  if (!log) {
    return NextResponse.json({ error: 'This item is already on the list again — finish or remove that job first.' }, { status: 409 })
  }

  // Finishing the job clears any OLDER row still holding this item on the
  // kitchen's list. Those rows are what carry an unfinished job forward; left
  // posted, the oldest one would hand the item straight back tomorrow as if it
  // had never been made. (Their status stays as it was — the history is that the
  // job wasn't done that day.)
  if (status !== undefined && COMPLETION_STATUSES.has(status)) {
    await prisma.prepLog.updateMany({
      where: {
        prepItemId: existing.prepItemId,
        logDate: { lt: stamp.logDate ?? existing.logDate },
        ...postedOpenWhere,
      },
      data: { postedAt: null },
    })
  }

  // Draft edits after posting → the kitchen is on a stale list; flag the post.
  if (editsPlan) await markPlanDirty(existing.revenueCenterId)

  // Completing (or reverting) a prep changes theoretical stock — buildPrepMap counts
  // DONE/PARTIAL logs — so drop the cache when a completion is involved either way.
  if (COMPLETION_STATUSES.has(status) || COMPLETION_STATUSES.has(existing.status)) {
    invalidateTheoreticalCache()
  }

  // Keep `isOnList` coherent with status: completing/removing clears the item from
  // today's list (frees the Smart Prep "Add" button — the prep stays in History);
  // starting or resetting re-arms it onto the list. Completing also clears the
  // manual priority override so Plan Prep resets to auto.
  if (status !== undefined) {
    const data: { manualPriorityOverride?: null; isOnList?: boolean } = {}
    if (COMPLETION_STATUSES.has(status)) { data.manualPriorityOverride = null; data.isOnList = false }
    else if (status === 'SKIPPED') data.isOnList = false
    else if (status === 'NOT_STARTED' || status === 'IN_PROGRESS') data.isOnList = true
    if (Object.keys(data).length) {
      await prisma.prepItem.update({ where: { id: existing.prepItemId }, data })
    }
  }

  return NextResponse.json(log)
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const existing = await prisma.prepLog.findUnique({ where: { id: params.id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await prisma.prepLog.delete({ where: { id: params.id } })
  return NextResponse.json({ ok: true })
}
