import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// Returns the recent approved-purchase history for an inventory item, derived
// from the active InvoiceScanItem records. Used by the invoice review drawer
// to render an inline sparkline of recent unit prices.
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { id } = params

  const scanItems = await prisma.invoiceScanItem.findMany({
    where: {
      matchedItemId: id,
      approved: true,
      session: { status: 'APPROVED' },
      rawUnitPrice: { not: null },
    },
    include: {
      session: {
        select: {
          id: true,
          invoiceDate: true,
          invoiceNumber: true,
          supplierName: true,
          approvedAt: true,
        },
      },
    },
    orderBy: { session: { approvedAt: 'desc' } },
    take: 12,
  })

  // Sort newest-first for the API consumer; the sparkline reverses to chrono
  // when drawing.
  const history = scanItems.map(s => ({
    date:           s.session.invoiceDate ?? (s.session.approvedAt?.toISOString() ?? null),
    invoiceNumber:  s.session.invoiceNumber,
    supplierName:   s.session.supplierName,
    unitPrice:      Number(s.rawUnitPrice),
    qty:            s.rawQty != null ? Number(s.rawQty) : null,
    rawPriceType:   s.rawPriceType,
    invoicePackUOM: s.invoicePackUOM,
  }))

  return NextResponse.json(history)
}
