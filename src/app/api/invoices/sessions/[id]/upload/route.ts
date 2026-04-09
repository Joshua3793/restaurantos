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

  const created = await Promise.all(
    files.map(f =>
      prisma.invoiceFile.create({
        data: {
          sessionId: params.id,
          fileName:  f.fileName,
          fileType:  f.fileType,
          fileUrl:   f.url,
          ocrStatus: 'PENDING',
        },
      })
    )
  )

  // Advance session to PROCESSING
  await prisma.invoiceSession.update({
    where: { id: params.id },
    data:  { status: 'PROCESSING' },
  })

  return NextResponse.json(
    { uploaded: created.map(f => ({ id: f.id, fileName: f.fileName })) },
    { status: 201 }
  )
}
