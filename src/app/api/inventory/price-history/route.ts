import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// Batch price-history endpoint. Used by the invoice review drawer to load
// inline sparklines for every matched item in one round-trip instead of N.
//
// GET /api/inventory/price-history?ids=id1,id2,id3
// Returns: Record<inventoryItemId, Array<{ date, unitPrice, supplierName, ... }>>
export async function GET(req: NextRequest) {
  const idsParam = req.nextUrl.searchParams.get('ids') ?? ''
  const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean).slice(0, 200)
  if (ids.length === 0) return NextResponse.json({})

  const scanItems = await prisma.invoiceScanItem.findMany({
    where: {
      matchedItemId: { in: ids },
      approved: true,
      splitToSessionId: null,
      session: { status: 'APPROVED' },
      rawUnitPrice: { not: null },
    },
    include: {
      session: {
        select: {
          invoiceDate: true,
          supplierName: true,
          approvedAt: true,
        },
      },
    },
    orderBy: { session: { approvedAt: 'desc' } },
    take: ids.length * 12,
  })

  const out: Record<string, Array<{
    date: string | null
    supplierName: string | null
    unitPrice: number
  }>> = Object.fromEntries(ids.map(id => [id, []]))

  for (const s of scanItems) {
    if (!s.matchedItemId) continue
    const bucket = out[s.matchedItemId]
    if (!bucket || bucket.length >= 12) continue
    bucket.push({
      date:         s.session.invoiceDate ?? (s.session.approvedAt?.toISOString() ?? null),
      supplierName: s.session.supplierName,
      unitPrice:    Number(s.rawUnitPrice),
    })
  }

  return NextResponse.json(out)
}
