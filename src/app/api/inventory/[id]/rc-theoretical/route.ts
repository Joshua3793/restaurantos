import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getTheoreticalStock } from '@/lib/count-expected'

export const dynamic = 'force-dynamic'

// GET /api/inventory/[id]/rc-theoretical
// Per-RC THEORETICAL on-hand (baseUnit) for one item — the number the Revenue-centers
// panel shows. Under the theoretical model an RC's stock is computed on read (baseline
// + purchases + prep + transfers − consumption − wastage), so a pull/transfer shifts
// these values without any real-stock write. Returns { [rcId]: qtyBase }.
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const item = await prisma.inventoryItem.findUnique({ where: { id: params.id }, select: { id: true } })
  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const rcs = await prisma.revenueCenter.findMany({ select: { id: true } })
  const entries = await Promise.all(
    rcs.map(async rc => [rc.id, (await getTheoreticalStock(params.id, rc.id)) ?? 0] as const),
  )

  return NextResponse.json(Object.fromEntries(entries))
}
