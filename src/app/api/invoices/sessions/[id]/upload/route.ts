import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// POST /api/invoices/sessions/[id]/upload
// Accepts JSON: { files: [{ url, fileName, fileType }] }
// Called after UploadThing completes client-side upload and returns CDN URLs.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await prisma.invoiceSession.findUnique({ where: { id: params.id } })
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 })

  const body = await req.json()
  const files: { url: string; fileName: string; fileType: string }[] = body.files || []

  if (!files.length) return NextResponse.json({ error: 'No files provided' }, { status: 400 })

  // Sequential creates: createdAt order must match payload order, since OCR
  // bbox.page indexes assume file order == page order.
  const created = []
  for (const f of files) {
    created.push(await prisma.invoiceFile.create({
      data: {
        sessionId: params.id,
        fileName:  f.fileName,
        fileType:  f.fileType,
        fileUrl:   f.url,
        ocrStatus: 'PENDING',
      },
    }))
  }

  // Status is decided by what the session now HOLDS, not by the peek: >1 file
  // is a batch to sort (GROUPING — only /split turns it into invoices), exactly
  // 1 is a single invoice the client OCRs right away. A peek that times out can
  // therefore never leave a batch as a PROCESSING corpse that the stale sweeper
  // flips to ERROR and "Retry" hands to /process as ONE invoice.
  const fileCount = await prisma.invoiceFile.count({ where: { sessionId: params.id } })
  await prisma.invoiceSession.update({
    where: { id: params.id },
    data:  { status: fileCount > 1 ? 'GROUPING' : 'PROCESSING' },
  })

  return NextResponse.json(
    { uploaded: created.map(f => ({ id: f.id, fileName: f.fileName })) },
    { status: 201 }
  )
}
