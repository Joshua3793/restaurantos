import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { computeSuggestedQty } from '@/lib/prep-utils'
import { getTheoreticalStockMap } from '@/lib/count-expected'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const dateStr = body.date as string | undefined

  const today = dateStr ? new Date(dateStr) : new Date()
  today.setHours(0, 0, 0, 0)
  const tomorrow = new Date(today.getTime() + 86_400_000)

  const items = await prisma.prepItem.findMany({
    where: { isActive: true },
    include: {
      linkedInventoryItem: { select: { id: true } },
      linkedRecipe: {
        include: { inventoryItem: { select: { id: true } } },
      },
      logs: {
        where: { logDate: { gte: today, lt: tomorrow } },
        take: 1,
      },
    },
  })

  // Build theoretical stock maps grouped by revenueCenterId (batched, not per-item).
  // Prep items span multiple RCs (including null = global/shared), so we group by RC,
  // fetch one map per distinct RC, then look each item up in its RC's map.
  const rcToIds = new Map<string | null, string[]>()
  for (const item of items) {
    const invId = item.linkedInventoryItem?.id ?? item.linkedRecipe?.inventoryItem?.id
    if (!invId) continue
    const rc = item.revenueCenterId ?? null
    if (!rcToIds.has(rc)) rcToIds.set(rc, [])
    rcToIds.get(rc)!.push(invId)
  }

  const theoreticalMaps = new Map<string | null, Map<string, number>>()
  await Promise.all(
    Array.from(rcToIds.entries()).map(async ([rc, ids]) => {
      const map = await getTheoreticalStockMap(rc, ids)
      theoreticalMaps.set(rc, map)
    })
  )

  let created = 0
  let skipped = 0

  for (const item of items) {
    if (item.logs.length > 0) { skipped++; continue }

    const invId = item.linkedInventoryItem?.id ?? item.linkedRecipe?.inventoryItem?.id
    const rc = item.revenueCenterId ?? null
    let onHand = 0
    if (invId) {
      onHand = theoreticalMaps.get(rc)?.get(invId) ?? 0
    }

    const parLevel    = parseFloat(String(item.parLevel))
    const targetToday = item.targetToday ? parseFloat(String(item.targetToday)) : null
    const suggested   = computeSuggestedQty(onHand, parLevel, targetToday)

    await prisma.prepLog.create({
      data: {
        prepItemId:     item.id,
        logDate:        today,
        status:         'NOT_STARTED',
        requiredQty:    suggested,
        revenueCenterId: item.revenueCenterId ?? null,
      },
    })
    created++
  }

  return NextResponse.json({ created, skipped, date: today.toISOString() })
}
