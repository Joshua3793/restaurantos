import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { computeExpectedForItem } from '@/lib/count-expected'
import { finalizeCountSession } from '@/lib/count-finalize'
import { convertBaseToCountUom, resolveCountUom } from '@/lib/count-uom'

export const dynamic = 'force-dynamic'

function itemDims(item: {
  baseUnit: string; purchaseUnit: string; qtyPerPurchaseUnit: unknown
  qtyUOM: string | null; innerQty: unknown; packSize: unknown
  packUOM: string; countUOM: string
}) {
  return {
    baseUnit:           item.baseUnit,
    purchaseUnit:       item.purchaseUnit,
    qtyPerPurchaseUnit: Number(item.qtyPerPurchaseUnit),
    qtyUOM:             item.qtyUOM ?? 'each',
    innerQty:           item.innerQty != null ? Number(item.innerQty) : null,
    packSize:           Number(item.packSize),
    packUOM:            item.packUOM,
    countUOM:           item.countUOM ?? 'each',
  }
}

// GET /api/inventory/count/:id/quick?rcId=... → expected on-hand for live preview
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const rcId = new URL(req.url).searchParams.get('rcId') || null

  const item = await prisma.inventoryItem.findUnique({ where: { id: params.id } })
  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const expected = await computeExpectedForItem(params.id, rcId)
  if (!expected) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const dims = itemDims(item)
  // Default count unit, self-healing from the purchase format like the count routes.
  const countUom = resolveCountUom(dims) || item.baseUnit
  const expectedCount = convertBaseToCountUom(expected.expectedBase, countUom, dims)

  return NextResponse.json({
    expectedBase:  expected.expectedBase,
    expectedCount,
    countUom,
    lastCountDate: item.lastCountDate,
  })
}

// POST /api/inventory/count/:id/quick  body { countedQty, selectedUom, rcId }
// Records a single-item count as a 1-line, auto-finalized QUICK CountSession so
// it carries full snapshot + variance + allocation behaviour for free.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const body = await req.json().catch(() => null)
  const countedQty  = Number(body?.countedQty)
  const selectedUom = typeof body?.selectedUom === 'string' ? body.selectedUom : null
  const rcId        = typeof body?.rcId === 'string' && body.rcId ? body.rcId : null

  if (!Number.isFinite(countedQty) || countedQty < 0)
    return NextResponse.json({ error: 'countedQty must be a non-negative number' }, { status: 400 })
  if (!selectedUom)
    return NextResponse.json({ error: 'selectedUom is required' }, { status: 400 })
  // A quick count must target a specific RC (the UI disables it in the "All RCs"
  // view) — otherwise we can't know which stock pool to write.
  if (!rcId)
    return NextResponse.json({ error: 'Pick a revenue center to quick-count' }, { status: 400 })

  const item = await prisma.inventoryItem.findUnique({ where: { id: params.id } })
  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const expected = await computeExpectedForItem(params.id, rcId)
  if (!expected) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const session = await prisma.countSession.create({
    data: {
      label:           `Quick count: ${item.itemName}`,
      sessionDate:     new Date(),
      type:            'QUICK',
      revenueCenterId: rcId,
      countedBy:       user.name?.trim() || user.email,
      lines: {
        create: [{
          inventoryItemId: item.id,
          expectedQty:     expected.expectedBase,
          countedQty,
          selectedUom,
          priceAtCount:    item.pricePerBaseUnit,
          sortOrder:       0,
        }],
      },
    },
  })

  const result = await finalizeCountSession(session.id)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  // Read back the locked variance for the UI ("you were X off").
  const line = await prisma.countLine.findFirst({
    where: { sessionId: session.id },
    select: { variancePct: true, varianceCost: true, expectedQty: true },
  })

  return NextResponse.json({
    ok:           true,
    sessionId:    session.id,
    expectedBase: Number(line?.expectedQty ?? expected.expectedBase),
    variancePct:  line?.variancePct  != null ? Number(line.variancePct)  : 0,
    varianceCost: line?.varianceCost != null ? Number(line.varianceCost) : 0,
    summary:      result.summary,
  })
}
