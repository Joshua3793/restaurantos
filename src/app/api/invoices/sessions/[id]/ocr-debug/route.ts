import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// GET /api/invoices/sessions/[id]/ocr-debug
// Returns raw OCR output stored for each file, plus scan item count.
// Used to diagnose "0 items found" after processing.
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
  const session = await prisma.invoiceSession.findUnique({
    where: { id: params.id },
    include: {
      files: {
        select: { id: true, fileName: true, ocrStatus: true, ocrRawJson: true },
        orderBy: { createdAt: 'asc' },
      },
      scanItems: { select: { id: true } },
    },
  })
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json({
    sessionId: params.id,
    sessionStatus: session.status,
    scanItemCount: session.scanItems.length,
    files: session.files.map(f => ({
      fileName: f.fileName,
      ocrStatus: f.ocrStatus,
      ocrResult: f.ocrRawJson ? JSON.parse(f.ocrRawJson) : null,
    })),
  })
}
