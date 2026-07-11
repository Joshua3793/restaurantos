import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { convertCountQtyToBase, convertBaseToCountUom } from '@/lib/count-uom'
import { getTheoreticalStock } from '@/lib/count-expected'

// GET /api/stock-allocations?itemId= — allocations for a specific inventory item
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const itemId = searchParams.get('itemId')

  if (!itemId) return NextResponse.json({ error: 'itemId required' }, { status: 400 })

  const allocations = await prisma.stockAllocation.findMany({
    where: { inventoryItemId: itemId },
    include: { revenueCenter: { select: { id: true, name: true, color: true } } },
  })

  return NextResponse.json(allocations)
}

// POST /api/stock-allocations — move qty from the main pool (default RC) into an RC.
// THEORETICAL move: this records a StockTransfer (default RC → target RC) and grants
// membership. It does NOT write real stock — stockOnHand and StockAllocation.quantity
// are untouched. The transfer feeds the theoretical-stock engine (buildTransferMap),
// so the default RC's theoretical drops and the target RC's rises. Only a count ever
// changes real stock in hand.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const { inventoryItemId, rcId, quantity, notes } = body

  if (!inventoryItemId || !rcId || !quantity) {
    return NextResponse.json(
      { error: 'inventoryItemId, rcId, and quantity are required' },
      { status: 400 },
    )
  }

  const qty = parseFloat(String(quantity))
  if (isNaN(qty) || qty <= 0) {
    return NextResponse.json({ error: 'Quantity must be a positive number' }, { status: 400 })
  }

  const item = await prisma.inventoryItem.findUnique({ where: { id: inventoryItemId } })
  if (!item) return NextResponse.json({ error: 'Item not found' }, { status: 404 })

  const defaultRc = await prisma.revenueCenter.findFirst({ where: { isDefault: true } })
  if (!defaultRc) {
    return NextResponse.json({ error: 'No default revenue center — cannot pull from the main pool.' }, { status: 400 })
  }
  if (rcId === defaultRc.id) {
    return NextResponse.json({ error: 'Cannot pull the main pool into itself.' }, { status: 400 })
  }

  // `quantity` arrives in the item's countUOM (e.g. kg); transfers are persisted in
  // baseUnit (e.g. g) — the canonical unit for all stock, matching how the theoretical
  // engine reads StockTransfer.quantity. Convert before persisting / comparing.
  const countUOM = item.countUnit || item.baseUnit
  const dims = {
    dimension: item.dimension,
    baseUnit:  item.baseUnit,
    packChain: item.packChain,
    countUnit: item.countUnit,
  }
  const qtyBase = convertCountQtyToBase(qty, countUOM, dims)

  // Guard against pulling more than the main pool's THEORETICAL on-hand (not raw
  // stockOnHand): since pulls no longer decrement stockOnHand, the raw value would
  // never fall and you could over-allocate the same stock into many RCs.
  const availBase = (await getTheoreticalStock(inventoryItemId, defaultRc.id)) ?? 0
  if (availBase < qtyBase) {
    const availDisplay = convertBaseToCountUom(availBase, countUOM, dims)
    return NextResponse.json(
      { error: `Not enough stock in the main pool. Available: ${availDisplay.toFixed(2)} ${countUOM}` },
      { status: 400 },
    )
  }

  await prisma.$transaction([
    // The transfer IS the movement — a theoretical event, no real-stock write.
    prisma.stockTransfer.create({
      data: { fromRcId: defaultRc.id, toRcId: rcId, inventoryItemId, quantity: qtyBase, notes: notes || null },
    }),
    // Stock in an RC implies membership — otherwise the item would hold (theoretical)
    // stock there but be invisible in that RC's count. Idempotent.
    prisma.itemRevenueCenter.upsert({
      where: { inventoryItemId_revenueCenterId: { inventoryItemId, revenueCenterId: rcId } },
      create: { inventoryItemId, revenueCenterId: rcId },
      update: {},
    }),
  ])

  return NextResponse.json({ ok: true })
}

// PATCH /api/stock-allocations — upsert parLevel/reorderQty for one RC+item pair
export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const { inventoryItemId, rcId, parLevel, reorderQty } = body

  if (!inventoryItemId || !rcId) {
    return NextResponse.json({ error: 'inventoryItemId and rcId are required' }, { status: 400 })
  }
  if (parLevel !== null && parLevel !== undefined) {
    const p = Number(parLevel)
    if (isNaN(p) || p < 0) {
      return NextResponse.json({ error: 'parLevel must be a number >= 0' }, { status: 400 })
    }
  }
  if (reorderQty !== null && reorderQty !== undefined) {
    const r = Number(reorderQty)
    if (isNaN(r) || r <= 0) {
      return NextResponse.json({ error: 'reorderQty must be a number > 0' }, { status: 400 })
    }
  }

  try {
    const allocation = await prisma.stockAllocation.upsert({
      where: { revenueCenterId_inventoryItemId: { revenueCenterId: rcId, inventoryItemId } },
      update: {
        ...(parLevel !== undefined ? { parLevel: parLevel === null ? null : Number(parLevel) } : {}),
        ...(reorderQty !== undefined ? { reorderQty: reorderQty === null ? null : Number(reorderQty) } : {}),
      },
      create: {
        revenueCenterId: rcId,
        inventoryItemId,
        quantity: 0,
        parLevel: parLevel ?? null,
        reorderQty: reorderQty ?? null,
      },
    })
    return NextResponse.json(allocation)
  } catch (err) {
    console.error('PATCH /api/stock-allocations', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
