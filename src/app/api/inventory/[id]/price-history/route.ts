import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { id } = params

  const lineItems = await prisma.invoiceLineItem.findMany({
    where: { inventoryItemId: id },
    include: {
      invoice: {
        select: {
          invoiceDate: true,
          invoiceNumber: true,
          supplier: { select: { name: true } },
        },
      },
    },
    orderBy: { invoice: { invoiceDate: 'desc' } },
    take: 8,
  })

  const history = lineItems.map(li => ({
    invoiceDate: li.invoice.invoiceDate,
    invoiceNumber: li.invoice.invoiceNumber,
    supplierName: li.invoice.supplier.name,
    qtyPurchased: Number(li.qtyPurchased),
    unitPrice: Number(li.unitPrice),
    lineTotal: Number(li.lineTotal),
  }))

  return NextResponse.json(history)
}
