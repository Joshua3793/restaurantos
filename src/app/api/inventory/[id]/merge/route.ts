import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { planMerge } from '@/lib/item-merge'
import { loadMergeInputs, executeMerge, undoBlocker, MergeConflictError } from '@/lib/item-merge-exec'
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

  const onHand = body?.combinedOnHand
  const onHandOk = !!onHand
    && Number.isFinite(Number(onHand.countedQty)) && Number(onHand.countedQty) >= 0
    && typeof onHand.selectedUom === 'string' && !!onHand.selectedUom
    && typeof onHand.rcId === 'string' && !!onHand.rcId

  const inputs = await loadMergeInputs(params.id, absorbedId)
  if (!inputs) return NextResponse.json({ error: 'Item not found' }, { status: 404 })

  const plan = planMerge(inputs.survivor, inputs.absorbed, inputs.rel, inputs.sRel, {
    combinedOnHandProvided: onHandOk,
    newId: () => randomUUID(),
  })
  if (!plan.ok) return NextResponse.json(plan, { status: 422 })
  if (body?.dryRun) return NextResponse.json({ ok: true, dryRun: true, summary: plan.summary })

  const countedBy = user.name?.trim() || user.email
  let mergeId: string
  try {
    ({ mergeId } = await executeMerge(plan.manifest, countedBy))
  } catch (e) {
    if (e instanceof MergeConflictError) return NextResponse.json({ error: e.message }, { status: 409 })
    console.error('[merge] failed', e)
    return NextResponse.json({ error: 'The merge could not be completed. Nothing was changed.' }, { status: 500 })
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
        countedQty: Number(onHand.countedQty),
        selectedUom: onHand.selectedUom,
        rcId: onHand.rcId,
        countedBy,
      })
      if (!qc.ok) warning = `Merged, but the on-hand count failed: ${qc.error}. Quick-count the item now.`
    } catch (e) {
      console.error('[merge] combined on-hand quick count failed', e)
      warning = 'Merged, but the on-hand count failed. Quick-count the item now.'
    }
    if (warning) return NextResponse.json({ ok: true, dryRun: false, mergeId, summary: plan.summary, warning })
  }

  return NextResponse.json({ ok: true, dryRun: false, mergeId, summary: plan.summary })
}
