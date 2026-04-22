import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { computeScale } from '@/lib/prep-utils'
import { convertQty } from '@/lib/uom'

const COMPLETION_STATUSES = new Set(['DONE', 'PARTIAL'])

async function applyInventoryTransaction(
  logId: string,
  actualQty: number,
): Promise<{ applied: boolean; warning: string | null }> {
  const log = await prisma.prepLog.findUnique({
    where: { id: logId },
    include: {
      prepItem: {
        include: {
          linkedRecipe: {
            include: {
              inventoryItem: true,
              ingredients: { include: { inventoryItem: true } },
            },
          },
        },
      },
    },
  })

  if (!log?.prepItem.linkedRecipe) return { applied: false, warning: null }

  const recipe = log.prepItem.linkedRecipe
  const { scale, unitMismatch } = computeScale(
    actualQty,
    log.prepItem.unit,
    recipe.yieldUnit,
    parseFloat(String(recipe.baseYieldQty)),
  )

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ops: any[] = []

  // Deduct each ingredient from inventory (convert units, clamp to 0)
  for (const ing of recipe.ingredients) {
    if (!ing.inventoryItemId || !ing.inventoryItem) continue
    const qtyInBaseUnit = convertQty(
      parseFloat(String(ing.qtyBase)),
      ing.unit,
      ing.inventoryItem.baseUnit,
    )
    const currentStock = parseFloat(String(ing.inventoryItem.stockOnHand ?? 0))
    const newStock = Math.max(0, currentStock - qtyInBaseUnit * scale)
    ops.push(
      prisma.inventoryItem.update({
        where: { id: ing.inventoryItemId },
        data: { stockOnHand: newStock },
      }),
    )
  }

  // Credit the output inventory item (convert from recipe yield unit → inventory base unit)
  if (recipe.inventoryItemId && recipe.inventoryItem) {
    const yieldInBaseUnit = convertQty(
      parseFloat(String(recipe.baseYieldQty)),
      recipe.yieldUnit,
      recipe.inventoryItem.baseUnit,
    )
    ops.push(
      prisma.inventoryItem.update({
        where: { id: recipe.inventoryItemId },
        data: { stockOnHand: { increment: yieldInBaseUnit * scale } },
      }),
    )
  }

  // Mark log as adjusted
  ops.push(
    prisma.prepLog.update({
      where: { id: logId },
      data: { inventoryAdjusted: true },
    }),
  )

  await prisma.$transaction(ops)

  return {
    applied: true,
    warning: unitMismatch
      ? 'Unit mismatch — applied 1 full batch. Verify quantities manually.'
      : null,
  }
}

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

  let inventoryResult: { applied: boolean; warning: string | null } = {
    applied: false,
    warning: null,
  }

  // Only fire the transaction once (idempotency via inventoryAdjusted flag)
  if (status && COMPLETION_STATUSES.has(status) && !existing.inventoryAdjusted && qty) {
    inventoryResult = await applyInventoryTransaction(params.id, qty)
  }

  return NextResponse.json({ ...log, inventoryResult })
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
