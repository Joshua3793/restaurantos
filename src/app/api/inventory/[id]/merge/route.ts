import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { planMerge } from '@/lib/item-merge'
import {
  loadMergeInputs, loadTheoreticalOnHand, planAndExecuteMerge, undoBlocker, MergeConflictError,
} from '@/lib/item-merge-exec'
import { recordQuickCount } from '@/lib/quick-count'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

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
    const reason = await undoBlocker(r)
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

// POST /api/inventory/:id/merge  body { absorbedId, dryRun?, combinedOnHand? }
// Folds `absorbedId` into this item. A dry run plans and writes nothing.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  let user
  try { user = await requireSession('MANAGER') } catch (e) { return authFail(e) }

  const body = await req.json().catch(() => null)
  const absorbedId = typeof body?.absorbedId === 'string' ? body.absorbedId : ''
  if (!absorbedId) return NextResponse.json({ error: 'absorbedId is required' }, { status: 400 })

  const onHandInput = body?.combinedOnHand
  const onHandOk = !!onHandInput
    && Number.isFinite(Number(onHandInput.countedQty)) && Number(onHandInput.countedQty) >= 0
    && typeof onHandInput.selectedUom === 'string' && !!onHandInput.selectedUom
    && typeof onHandInput.rcId === 'string' && !!onHandInput.rcId

  // A combined on-hand is recorded as a quick count AFTER the merge. That count
  // is not in the manifest and cannot be inverted, so it permanently trips the
  // "counted since the merge" undo blocker — the UI has to say so up front,
  // which is what this flag is for. Same value on a dry run and the real thing.
  const willDisableUndo = onHandOk

  // Theoretical on-hand comes from the ledger, which uses the prisma singleton
  // internally — computed here, outside the merge transaction, and handed in.
  const onHand = await loadTheoreticalOnHand(params.id, absorbedId)

  if (body?.dryRun) {
    const inputs = await loadMergeInputs(params.id, absorbedId, prisma, onHand)
    if (!inputs) return NextResponse.json({ error: 'Item not found' }, { status: 404 })
    const plan = planMerge(inputs.survivor, inputs.absorbed, inputs.rel, inputs.sRel, {
      combinedOnHandProvided: onHandOk,
      newId: () => randomUUID(),
    })
    if (!plan.ok) return NextResponse.json(plan, { status: 422 })
    return NextResponse.json({
      ok: true,
      dryRun: true,
      summary: plan.summary,
      willDisableUndo,
      countLinesUnfrozen: plan.summary.countLinesUnfrozen,
      primaryPromoted: plan.summary.primaryPromoted,
    })
  }

  // The real thing: the plan is built INSIDE the transaction that applies it, so
  // a row attached to the absorbed item in the meantime cannot be left behind.
  const mergedBy = user.name?.trim() || user.email
  let outcome
  try {
    outcome = await planAndExecuteMerge({
      survivorId: params.id,
      absorbedId,
      combinedOnHandProvided: onHandOk,
      onHand,
      mergedBy,
      newId: () => randomUUID(),
    })
  } catch (e) {
    if (e instanceof MergeConflictError)
      return NextResponse.json({ error: `The item changed while merging — try again. (${e.message})` }, { status: 409 })
    console.error('[merge] failed', e)
    return NextResponse.json({ error: 'The merge could not be completed. Nothing was changed.' }, { status: 500 })
  }

  if (!outcome.ok) {
    if (outcome.kind === 'not_found') return NextResponse.json({ error: 'Item not found' }, { status: 404 })
    return NextResponse.json(outcome.plan, { status: 422 })
  }

  const done = {
    ok: true as const,
    dryRun: false as const,
    mergeId: outcome.mergeId,
    summary: outcome.summary,
    willDisableUndo,
    countLinesUnfrozen: outcome.summary.countLinesUnfrozen,
    primaryPromoted: outcome.summary.primaryPromoted,
  }

  // AFTER the merge transaction, deliberately outside it: the person's combined
  // on-hand figure, recorded as a quick count. It supersedes the manifest's own
  // stockOnHand write and is NOT undoable — which is why a failure here does not
  // roll the merge back, it just tells them to count the item themselves.
  if (onHandOk) {
    let warning: string | null = null
    try {
      const qc = await recordQuickCount({
        itemId: params.id,
        countedQty: Number(onHandInput.countedQty),
        selectedUom: onHandInput.selectedUom,
        rcId: onHandInput.rcId,
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
