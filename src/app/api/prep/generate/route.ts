import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { computeSuggestedQty } from '@/lib/prep-utils'
import { getTheoreticalStockMap } from '@/lib/count-expected'
import { convertQty } from '@/lib/uom'

// Mutating handlers must never be statically prerendered — a prerendered
// route serves GET only and returns 405 for everything else.
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const body = await req.json().catch(() => ({}))
  const dateStr = body.date as string | undefined

  const today = dateStr ? new Date(dateStr) : new Date()
  today.setHours(0, 0, 0, 0)
  const tomorrow = new Date(today.getTime() + 86_400_000)

  const items = await prisma.prepItem.findMany({
    where: { isActive: true },
    include: {
      linkedInventoryItem: { select: { id: true, baseUnit: true } },
      linkedRecipe: {
        include: { inventoryItem: { select: { id: true, baseUnit: true } } },
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
    // theoretical onHand is in baseUnit; par/target are in the prep unit — convert.
    const invBaseUnit =
      item.linkedInventoryItem?.baseUnit ?? item.linkedRecipe?.inventoryItem?.baseUnit ?? null
    if (invBaseUnit && item.unit) {
      onHand = convertQty(onHand, invBaseUnit, item.unit)
    }

    const revenueCenterId: string | null = item.revenueCenterId ?? body.revenueCenterId ?? null
    if (!revenueCenterId) { skipped++; continue }

    const parLevel    = parseFloat(String(item.parLevel))
    const targetToday = item.targetToday ? parseFloat(String(item.targetToday)) : null
    const suggested   = computeSuggestedQty(onHand, parLevel, targetToday)

    await prisma.prepLog.create({
      data: {
        prepItemId:     item.id,
        logDate:        today,
        status:         'NOT_STARTED',
        requiredQty:    suggested,
        revenueCenterId,
      },
    })
    created++
  }

  return NextResponse.json({ created, skipped, date: today.toISOString() })
}
