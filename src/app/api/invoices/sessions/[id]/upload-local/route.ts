import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// POST /api/invoices/sessions/[id]/upload-local
// Local-dev fallback: accepts multipart form data and stores files as base64 data URIs.
// Used automatically when UPLOADTHING_TOKEN is not configured.
// In production, UploadThing CDN is used instead via /upload.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await prisma.invoiceSession.findUnique({ where: { id: params.id } })
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 })

  const formData = await req.formData()
  const files = formData.getAll('files') as File[]

  if (!files.length) return NextResponse.json({ error: 'No files provided' }, { status: 400 })

  const created = await Promise.all(
    files.map(async (f) => {
      const bytes = await f.arrayBuffer()
      const base64 = Buffer.from(bytes).toString('base64')
      const dataUri = `data:${f.type || 'application/octet-stream'};base64,${base64}`

      return prisma.invoiceFile.create({
        data: {
          sessionId: params.id,
          fileName:  f.name,
          fileType:  f.type || 'application/octet-stream',
          fileUrl:   dataUri,
          ocrStatus: 'PENDING',
        },
      })
    })
  )

  await prisma.invoiceSession.update({
    where: { id: params.id },
    data:  { status: 'PROCESSING' },
  })

  return NextResponse.json(
    { uploaded: created.map(f => ({ id: f.id, fileName: f.fileName })) },
    { status: 201 }
  )
}
