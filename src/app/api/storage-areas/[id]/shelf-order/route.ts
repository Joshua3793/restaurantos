import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { compareShelfOrder, parseShelfOrderBody } from '@/lib/count-shelf-order'

// Mutating handler — never statically prerender (would 405 the PUT).
export const dynamic = 'force-dynamic'

function authFail(e: unknown) {
  if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
  throw e
}

// ── GET /api/storage-areas/[id]/shelf-order ───────────────────────────────────
// The area's countable items — active, stocked, not a PREP recipe's output —
// in their current shelf-walk order (placed first, then unplaced A–Z). With
// ?rcId=, only that kitchen's items (ItemRevenueCenter). Names only — no money.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession('LEAD') } catch (e) { return authFail(e) }

  const area = await prisma.storageArea.findUnique({ where: { id: params.id }, select: { id: true, name: true } })
  if (!area) return NextResponse.json({ error: 'Area not found.' }, { status: 404 })

  const rcId = req.nextUrl.searchParams.get('rcId')?.trim() || null
  const items = await prisma.inventoryItem.findMany({
    where: {
      storageAreaId: area.id,
      isActive: true,
      isStocked: true,
      NOT: { recipe: { type: 'PREP' } },
      ...(rcId ? { revenueCenters: { some: { revenueCenterId: rcId } } } : {}),
    },
    select: { id: true, itemName: true, category: true, shelfOrder: true },
  })
  items.sort((a, b) => compareShelfOrder(
    { areaName: null, shelfOrder: a.shelfOrder, name: a.itemName },
    { areaName: null, shelfOrder: b.shelfOrder, name: b.itemName },
  ))
  return NextResponse.json({ area, items }, { headers: { 'Cache-Control': 'no-store' } })
}

// ── PUT /api/storage-areas/[id]/shelf-order { itemIds } ───────────────────────
// Writes shelfOrder = index for each listed item that sits in this area, in one
// transaction. Listed ids from other areas are ignored; items in the area that
// are not listed keep their current position.
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession('LEAD') } catch (e) { return authFail(e) }

  let body: unknown
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid body.' }, { status: 400 }) }
  const parsed = parseShelfOrderBody(body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const area = await prisma.storageArea.findUnique({ where: { id: params.id }, select: { id: true } })
  if (!area) return NextResponse.json({ error: 'Area not found.' }, { status: 404 })

  const inArea = await prisma.inventoryItem.findMany({
    where: { id: { in: parsed.itemIds }, storageAreaId: area.id },
    select: { id: true },
  })
  const inAreaIds = new Set(inArea.map(i => i.id))

  const updates = parsed.itemIds
    .map((id, index) => ({ id, index }))
    .filter(u => inAreaIds.has(u.id))
    .map(u => prisma.inventoryItem.updateMany({
      // storageAreaId in the where guards against an item moving areas mid-save.
      where: { id: u.id, storageAreaId: area.id },
      data: { shelfOrder: u.index },
    }))
  if (updates.length > 0) await prisma.$transaction(updates)

  return NextResponse.json({ updated: updates.length, ignored: parsed.itemIds.length - updates.length })
}
