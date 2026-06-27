import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { validatePrepQty } from '@/lib/prep-utils'

const COMPLETION_STATUSES = new Set(['DONE', 'PARTIAL'])

export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const body = await req.json()
  const { status, actualPrepQty, assignedTo, dueTime, note, blockedReason } = body

  const existing = await prisma.prepLog.findUnique({ where: { id: params.id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

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

  const log = await prisma.prepLog.update({
    where: { id: params.id },
    data: {
      ...(status        !== undefined && { status }),
      ...(actualPrepQty !== undefined && { actualPrepQty: parseFloat(String(actualPrepQty)) }),
      ...(assignedTo    !== undefined && { assignedTo }),
      ...(dueTime       !== undefined && { dueTime }),
      ...(note          !== undefined && { note }),
      ...(blockedReason !== undefined && { blockedReason }),
    },
  })

  // When marking done/partial: clear manual priority override so Plan Prep resets to auto
  if (status && COMPLETION_STATUSES.has(status)) {
    await prisma.prepItem.update({
      where: { id: existing.prepItemId },
      data: { manualPriorityOverride: null },
    })
  }

  return NextResponse.json(log)
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const existing = await prisma.prepLog.findUnique({ where: { id: params.id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await prisma.prepLog.delete({ where: { id: params.id } })
  return NextResponse.json({ ok: true })
}
