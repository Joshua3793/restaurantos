import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import type { MergeSummary } from '@/lib/item-merge'
import { combineMergeSummaries } from '@/lib/item-merge-copy'
import {
  loadTheoreticalOnHandMany, planAndExecuteMergeBatch, undoBlocker,
  MergeConflictError, MergeInputError, MAX_BATCH_MERGE, type BatchMergeOutcome,
} from '@/lib/item-merge-exec'
import { isSafeRowId, parseCombinedOnHand } from '@/lib/item-merge-rows'
import { recordQuickCount } from '@/lib/quick-count'
import { invalidateTheoreticalCache } from '@/lib/theoretical-cache'

export const dynamic = 'force-dynamic'
// The ledger read alone is 8-13 s on a busy item, before a transaction that may
// take 30, and the Quick Count afterwards reads the ledger again and finalizes.
// A kill between `countSession.create` and `finalizeCountSession` would strand
// an IN_PROGRESS QUICK session that trips OPEN_COUNT for that item forever.
export const maxDuration = 300

const authFail = (e: unknown) => {
  if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
  throw e
}

// GET /api/inventory/:id/merge → the merges into this survivor that can still be undone.
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession('MANAGER') } catch (e) { return authFail(e) }

  const rows = await prisma.itemMerge.findMany({
    where: { survivorId: params.id, undoneAt: null },
    orderBy: { mergedAt: 'desc' },
  })
  const names = await prisma.inventoryItem.findMany({
    where: { id: { in: rows.map(r => r.absorbedId) } },
    select: { id: true, itemName: true },
  })
  const nameOf = new Map(names.map(x => [x.id, x.itemName]))
  const merges = await Promise.all(rows.map(async r => {
    const reason = await undoBlocker(prisma, r)
    return {
      id: r.id,
      absorbedName: nameOf.get(r.absorbedId) ?? 'Unknown item',
      mergedAt: r.mergedAt,
      canUndo: !reason,
      reason,
    }
  }))
  return NextResponse.json({ merges })
}

// POST /api/inventory/:id/merge
//   body { absorbedIds: string[] | absorbedId: string, dryRun?, combinedOnHand? }
// Folds one or several items into this one, all or nothing (see
// planAndExecuteMergeBatch). A dry run runs the merge and rolls it back, so the
// preview is the exact plan. One combined on-hand covers all of them.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  let user
  try { user = await requireSession('MANAGER') } catch (e) { return authFail(e) }

  const body = await req.json().catch(() => null)
  const raw: unknown[] = Array.isArray(body?.absorbedIds) ? body.absorbedIds
    : typeof body?.absorbedId === 'string' ? [body.absorbedId] : []
  const absorbedIds = Array.from(new Set(raw.filter((x): x is string => typeof x === 'string' && x !== '')))
  if (absorbedIds.length === 0) return NextResponse.json({ error: 'Pick at least one item to merge in.' }, { status: 400 })
  if (absorbedIds.length > MAX_BATCH_MERGE)
    return NextResponse.json({ error: `Merge at most ${MAX_BATCH_MERGE} items at a time.` }, { status: 400 })
  if (absorbedIds.includes(params.id)) return NextResponse.json({ error: 'Pick a different item to merge in.' }, { status: 400 })
  // Every id is interpolated into the `FOR UPDATE` lock's literal SQL.
  if (!isSafeRowId(params.id) || !absorbedIds.every(isSafeRowId))
    return NextResponse.json({ error: 'Not a valid item id' }, { status: 400 })

  // Strict, never coercing: `Number(null)` is 0, and a zero here would record an
  // un-undoable count that empties the item. Present-but-invalid is a 400, not
  // a silent "no figure given".
  const parsed = parseCombinedOnHand(body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const combinedOnHand = parsed.value

  // The Quick Count a combined on-hand triggers is not in the manifest and
  // cannot be inverted, so it permanently trips the "counted since the merge"
  // undo blocker. Same value on a dry run and the real thing, so the UI can warn
  // before anyone commits to it.
  const willDisableUndo = !!combinedOnHand

  // Theoretical on-hand comes from the ledger, which uses the prisma singleton
  // internally — ONE read for every item, outside the transaction, handed in.
  const onHand = await loadTheoreticalOnHandMany(params.id, absorbedIds)
  const mergedBy = user.name?.trim() || user.email
  const names = new Map((await prisma.inventoryItem.findMany({
    where: { id: { in: absorbedIds } }, select: { id: true, itemName: true },
  })).map(x => [x.id, x.itemName]))

  const run = (o: { dryRun: boolean; provided?: boolean }) => planAndExecuteMergeBatch({
    survivorId: params.id, absorbedIds, combinedOnHand,
    combinedOnHandProvided: o.provided, onHand, mergedBy,
    newId: () => randomUUID(), dryRun: o.dryRun,
  })

  const fail = (outcome: Exclude<BatchMergeOutcome, { ok: true }>) => {
    if (outcome.kind === 'not_found') return NextResponse.json({ error: 'Item not found' }, { status: 404 })
    return NextResponse.json({ ...outcome.plan, itemId: outcome.absorbedId, itemName: names.get(outcome.absorbedId) ?? null }, { status: 422 })
  }
  const shape = (merges: { absorbedId: string; mergeId: string | null; summary: MergeSummary }[]) => ({
    summary: combineMergeSummaries(merges.map(m => m.summary)),
    items: merges.map(m => ({ ...m, itemName: names.get(m.absorbedId) ?? null })),
  })

  let outcome: BatchMergeOutcome
  try {
    if (body?.dryRun) {
      outcome = await run({ dryRun: true })
      if (outcome.ok) return NextResponse.json({ ok: true, dryRun: true, willDisableUndo, ...shape(outcome.merges) })
      // Asked for a combined on-hand: plan it again AS IF one were given (the
      // planner only looks at whether a figure is given, never its value), so the
      // sheet shows what the merge would move the moment the guard appears. A
      // blocker that only shows up past this guard comes back as the answer.
      if (outcome.kind === 'guard' && outcome.plan.guard === 'NEEDS_ON_HAND' && !willDisableUndo) {
        const withOnHand = await run({ dryRun: true, provided: true })
        if (!withOnHand.ok) return fail(withOnHand)
        return NextResponse.json({
          ...outcome.plan, itemId: outcome.absorbedId, itemName: names.get(outcome.absorbedId) ?? null,
          withOnHand: shape(withOnHand.merges),
        }, { status: 422 })
      }
      return fail(outcome)
    }

    // The real thing: each plan is built INSIDE the transaction that applies it,
    // so a row attached to an absorbed item in the meantime cannot be left behind.
    outcome = await run({ dryRun: false })
  } catch (e) {
    // Raised before any write, from inside the transaction.
    if (e instanceof MergeInputError) return NextResponse.json({ error: e.message }, { status: 400 })
    if (e instanceof MergeConflictError)
      return NextResponse.json({ error: `The item changed while merging — try again. (${e.message})` }, { status: 409 })
    console.error('[merge] failed', e)
    return NextResponse.json({ error: 'The merge could not be completed. Nothing was changed.' }, { status: 500 })
  }
  if (!outcome.ok) return fail(outcome)

  // A merge moves purchases, wastage and transfers onto the survivor and zeroes
  // the absorbed rows' stock — every input the theoretical ledger reads. Drop the
  // cache so the drawer/prep/cost-chrome don't show the pre-merge picture for the
  // next 30 s. (The Quick Count below drops it again through its own finalize.)
  invalidateTheoreticalCache()

  const done = { ok: true as const, dryRun: false as const, willDisableUndo, ...shape(outcome.merges) }

  // AFTER the merge transaction, deliberately outside it: the person's combined
  // on-hand figure, recorded as ONE quick count for the whole set. It supersedes
  // the manifests' own stockOnHand writes and is NOT undoable — which is why a
  // failure here does not roll the merge back, it just tells them to count the
  // item themselves. The unit and the revenue center were already validated
  // before the merge committed, so this should only ever fail on something
  // transient.
  if (combinedOnHand) {
    let warning: string | null = null
    try {
      const qc = await recordQuickCount({
        itemId: params.id,
        countedQty: combinedOnHand.countedQty,
        selectedUom: combinedOnHand.selectedUom,
        rcId: combinedOnHand.rcId,
        countedBy: mergedBy,
      })
      if (!qc.ok) warning = `Merged, but the on-hand count failed: ${qc.error}. Quick-count the item now.`
    } catch (e) {
      console.error('[merge] combined on-hand quick count failed', e)
      warning = 'Merged, but the on-hand count failed. Quick-count the item now.'
    }
    if (warning) return NextResponse.json({ ...done, warning })
  }

  return NextResponse.json(done)
}
