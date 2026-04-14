import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { computeScale } from '@/lib/prep-utils'

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const body = await req.json()
  const newActualPrepQty = parseFloat(String(body.newActualPrepQty))

  if (!newActualPrepQty || isNaN(newActualPrepQty)) {
    return NextResponse.json({ error: 'newActualPrepQty is required' }, { status: 400 })
  }

  const log = await prisma.prepLog.findUnique({
    where: { id: params.id },
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

  if (!log)                       return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!log.inventoryAdjusted)     return NextResponse.json({ error: 'No adjustment to revert' }, { status: 400 })
  if (!log.prepItem.linkedRecipe) return NextResponse.json({ error: 'No linked recipe' }, { status: 400 })

  const recipe    = log.prepItem.linkedRecipe
  const prevQty   = parseFloat(String(log.actualPrepQty ?? 0))
  const baseYield = parseFloat(String(recipe.baseYieldQty))

  const { scale: prevScale } = computeScale(prevQty, log.prepItem.unit, recipe.yieldUnit, baseYield)
  const { scale: nextScale } = computeScale(newActualPrepQty, log.prepItem.unit, recipe.yieldUnit, baseYield)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ops: any[] = []

  // Ingredients: reverse prev deduction, apply new deduction (net delta)
  for (const ing of recipe.ingredients) {
    if (!ing.inventoryItemId || !ing.inventoryItem) continue
    const qtyBase  = parseFloat(String(ing.qtyBase))
    const netDelta = (qtyBase * prevScale) - (qtyBase * nextScale) // positive = restore stock
    ops.push(
      prisma.inventoryItem.update({
        where: { id: ing.inventoryItemId },
        data: { stockOnHand: { increment: netDelta } },
      }),
    )
  }

  // Output: reverse prev credit, apply new credit (net delta)
  if (recipe.inventoryItemId) {
    const netCredit = (baseYield * nextScale) - (baseYield * prevScale)
    ops.push(
      prisma.inventoryItem.update({
        where: { id: recipe.inventoryItemId },
        data: { stockOnHand: { increment: netCredit } },
      }),
    )
  }

  ops.push(
    prisma.prepLog.update({
      where: { id: params.id },
      data: { actualPrepQty: newActualPrepQty, inventoryAdjusted: true },
    }),
  )

  await prisma.$transaction(ops)

  return NextResponse.json({ ok: true, previousQty: prevQty, newQty: newActualPrepQty })
}
