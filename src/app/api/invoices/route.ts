import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
  const invoices = await prisma.invoice.findMany({
    include: { supplier: true, lineItems: { include: { inventoryItem: true } } },
    orderBy: { createdAt: 'desc' },
  })
  return NextResponse.json(invoices)
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { lineItems, supplierId, invoiceDate, invoiceNumber, imageUrl, totalAmount, status, ocrRawData } = body
  const invoice = await prisma.invoice.create({
    data: {
      supplierId,
      invoiceDate: new Date(invoiceDate),
      invoiceNumber,
      imageUrl,
      totalAmount: parseFloat(totalAmount) || 0,
      status: status || 'PENDING',
      ocrRawData: ocrRawData ? JSON.stringify(ocrRawData) : null,
      lineItems: {
        create: (lineItems || []).map((li: { inventoryItemId: string; qtyPurchased: string | number; unitPrice: string | number; rawDescription?: string }) => ({
          inventoryItemId: li.inventoryItemId,
          qtyPurchased: parseFloat(String(li.qtyPurchased)),
          unitPrice: parseFloat(String(li.unitPrice)),
          lineTotal: parseFloat(String(li.qtyPurchased)) * parseFloat(String(li.unitPrice)),
          rawDescription: li.rawDescription || '',
        })),
      },
    },
    include: { supplier: true, lineItems: { include: { inventoryItem: true } } },
  })
  return NextResponse.json(invoice, { status: 201 })
}
