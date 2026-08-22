import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { displayDayKey } from '@/lib/prep-day'
import { parseInvoiceDate } from '@/lib/purchase-date'

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
      splitToSessionId: null,
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
  //
  // Field names are the ones the drawer reads. They used to be `date` / `qty` /
  // no line total at all against a UI reading `invoiceDate` / `qtyPurchased` /
  // `lineTotal`, so every row rendered "Invalid Date … $0.00 total".
  const history = scanItems.map(s => {
    const resolved = parseInvoiceDate(s.session.invoiceDate) ?? s.session.approvedAt ?? null
    return {
      invoiceDate:    s.session.invoiceDate ?? resolved?.toISOString() ?? null,
      // 'YYYY-MM-DD' to print — see displayDayKey. Formatting the raw value in the
      // browser's zone walks a UTC-midnight invoice date back to the previous day.
      dayKey:         resolved ? displayDayKey(resolved) : null,
      invoiceNumber:  s.session.invoiceNumber,
      supplierName:   s.session.supplierName,
      unitPrice:      Number(s.rawUnitPrice),
      // rawLineTotal is what the invoice actually billed. Never re-derive it as
      // unitPrice × qty — that is wrong for every catch-weight line.
      qtyPurchased:   s.rawQty != null ? Number(s.rawQty) : null,
      lineTotal:      s.rawLineTotal != null ? Number(s.rawLineTotal) : null,
      invoicePackUOM: s.invoicePackUOM,
    }
  })

  return NextResponse.json(history)
}
