import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { computeSuggestedQty } from '@/lib/prep-utils'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const dateStr = body.date as string | undefined

  const today = dateStr ? new Date(dateStr) : new Date()
  today.setHours(0, 0, 0, 0)
  const tomorrow = new Date(today.getTime() + 86_400_000)

  const items = await prisma.prepItem.findMany({
    where: { isActive: true },
    include: {
      linkedInventoryItem: { select: { stockOnHand: true } },
      linkedRecipe: {
        include: { inventoryItem: { select: { stockOnHand: true } } },
      },
      logs: {
        where: { logDate: { gte: today, lt: tomorrow } },
        take: 1,
      },
    },
  })

  let created = 0
  let skipped = 0

  for (const item of items) {
    if (item.logs.length > 0) { skipped++; continue }

    let onHand = 0
    if (item.linkedInventoryItem) {
      onHand = parseFloat(String(item.linkedInventoryItem.stockOnHand))
    } else if (item.linkedRecipe?.inventoryItem) {
      onHand = parseFloat(String(item.linkedRecipe.inventoryItem.stockOnHand))
    }

    const parLevel    = parseFloat(String(item.parLevel))
    const targetToday = item.targetToday ? parseFloat(String(item.targetToday)) : null
    const suggested   = computeSuggestedQty(onHand, parLevel, targetToday)

    await prisma.prepLog.create({
      data: {
        prepItemId:  item.id,
        logDate:     today,
        status:      'NOT_STARTED',
        requiredQty: suggested,
      },
    })
    created++
  }

  return NextResponse.json({ created, skipped, date: today.toISOString() })
}
