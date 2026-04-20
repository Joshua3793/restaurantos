import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// POST /api/invoices/batches/[id]/files
// Accepts multipart form data. Stores files as base64 data-URIs on InvoiceBatchFile.
// Mirrors the pattern of /sessions/[id]/upload-local.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const batch = await prisma.invoiceBatch.findUnique({ where: { id: params.id } })
  if (!batch) return NextResponse.json({ error: 'Batch not found' }, { status: 404 })

  const formData = await req.formData()
  const files = formData.getAll('files') as File[]
  if (!files.length) return NextResponse.json({ error: 'No files provided' }, { status: 400 })

  const created = await Promise.all(
    files.map(async (f) => {
      const bytes = await f.arrayBuffer()
      const base64 = Buffer.from(bytes).toString('base64')
      const dataUri = `data:${f.type || 'application/octet-stream'};base64,${base64}`
      return prisma.invoiceBatchFile.create({
        data: {
          batchId:  params.id,
          fileName: f.name,
          fileType: f.type || 'application/octet-stream',
          fileUrl:  dataUri,
          metaStatus: 'PENDING',
        },
      })
    })
  )

  return NextResponse.json(
    { uploaded: created.map(f => ({ id: f.id, fileName: f.fileName })) },
    { status: 201 }
  )
}
