import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// GET /api/invoices/sessions — list all sessions
export async function GET() {
  const sessions = await prisma.invoiceSession.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      files: { select: { id: true, fileName: true, ocrStatus: true } },
      _count: { select: { scanItems: true, priceAlerts: true, recipeAlerts: true } },
    },
  })
  return NextResponse.json(sessions)
}

// POST /api/invoices/sessions — create a new session
export async function POST(req: NextRequest) {
  const { supplierName, supplierId } = await req.json().catch(() => ({}))

  const session = await prisma.invoiceSession.create({
    data: {
      status: 'UPLOADING',
      supplierName: supplierName || null,
      supplierId: supplierId || null,
    },
  })

  return NextResponse.json(session, { status: 201 })
}
