import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

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
