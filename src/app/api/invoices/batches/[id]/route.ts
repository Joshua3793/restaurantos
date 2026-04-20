import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const batch = await prisma.invoiceBatch.findUnique({
    where: { id: params.id },
    include: {
      sessions: {
        include: {
          files: { select: { id: true, fileName: true, ocrStatus: true } },
          _count: { select: { scanItems: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  })
  if (!batch) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(batch)
}
