import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import Anthropic from '@anthropic-ai/sdk'
import sharp from 'sharp'

export const maxDuration = 120

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

interface FileMeta {
  invoiceNumber: string | null
  supplierName: string | null
}

function isImage(fileType: string, fileName: string): boolean {
  return fileType.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/i.test(fileName)
}

async function loadBuffer(fileUrl: string): Promise<Buffer> {
  if (fileUrl.startsWith('data:')) {
    const comma = fileUrl.indexOf(',')
    return Buffer.from(fileUrl.slice(comma + 1), 'base64')
  }
  const res = await fetch(fileUrl)
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

// Shrink images before metadata scan — Claude only needs to read text, not full detail
async function compressForMeta(buf: Buffer): Promise<Buffer> {
  return sharp(buf)
    .resize({ width: 1200, height: 1600, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 60 })
    .toBuffer()
}

// POST /api/invoices/batches/[id]/analyze
// Runs lightweight metadata extraction on all files, groups by invoice number,
// creates InvoiceSession + InvoiceFile records, updates batch status to PROCESSING.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const batch = await prisma.invoiceBatch.findUnique({
    where: { id: params.id },
    include: { files: true },
  })
  if (!batch) return NextResponse.json({ error: 'Batch not found' }, { status: 404 })
  if (!batch.files.length) return NextResponse.json({ error: 'No files in batch' }, { status: 400 })

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not configured.' }, { status: 503 })
  }

  const imageFiles  = batch.files.filter(f => isImage(f.fileType, f.fileName))
  const nonImgFiles = batch.files.filter(f => !isImage(f.fileType, f.fileName))

  // fileId → extracted metadata
  const metaMap = new Map<string, FileMeta>()

  // ── 1. Batch-extract metadata from all images in a single Claude call ──────
  if (imageFiles.length > 0) {
    try {
      const imageBuffers = await Promise.all(
        imageFiles.map(async f => {
          const buf = await loadBuffer(f.fileUrl)
          const compressed = await compressForMeta(buf).catch(() => buf)
          return compressed.toString('base64')
        })
      )

      const content: Anthropic.Messages.MessageParam['content'] = [
        ...imageBuffers.map(b64 => ({
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: b64 },
        })),
        {
          type: 'text' as const,
          text: `These are ${imageFiles.length} invoice image(s) numbered 0 to ${imageFiles.length - 1} in the order shown above.
For EACH image, extract only the invoice number and supplier/vendor name visible on that image.
Return ONLY a valid JSON array, no markdown fences:
[{"imageIndex":0,"invoiceNumber":"string or null","supplierName":"string or null"},...]`,
        },
      ]

      const resp = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content }],
      })
      const text = resp.content.find(c => c.type === 'text')?.text ?? '[]'
      const parsed: Array<{ imageIndex: number; invoiceNumber: string | null; supplierName: string | null }> =
        JSON.parse(text)
      for (const r of parsed) {
        const f = imageFiles[r.imageIndex]
        if (f) metaMap.set(f.id, { invoiceNumber: r.invoiceNumber || null, supplierName: r.supplierName || null })
      }
    } catch (err) {
      console.error('[analyze] Image metadata extraction failed:', err)
    }
    // Any image not set above gets null metadata → own group
    for (const f of imageFiles) {
      if (!metaMap.has(f.id)) metaMap.set(f.id, { invoiceNumber: null, supplierName: null })
    }
  }

  // ── 2. Extract metadata from PDFs individually in parallel ─────────────────
  if (nonImgFiles.length > 0) {
    await Promise.all(
      nonImgFiles.map(async f => {
        try {
          const buf = await loadBuffer(f.fileUrl)
          const resp = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 256,
            messages: [{
              role: 'user',
              content: [
                {
                  type: 'document' as const,
                  source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: buf.toString('base64') },
                },
                {
                  type: 'text' as const,
                  text: 'Extract only the invoice number and supplier name. Return ONLY valid JSON, no markdown: {"invoiceNumber":"string or null","supplierName":"string or null"}',
                },
              ],
            }],
          })
          const text = resp.content.find(c => c.type === 'text')?.text ?? '{}'
          const result: FileMeta = JSON.parse(text)
          metaMap.set(f.id, { invoiceNumber: result.invoiceNumber || null, supplierName: result.supplierName || null })
        } catch {
          metaMap.set(f.id, { invoiceNumber: null, supplierName: null })
        }
      })
    )
  }

  // ── 3. Persist extracted metadata on InvoiceBatchFile rows ────────────────
  await Promise.all(
    batch.files.map(f => {
      const meta = metaMap.get(f.id) ?? { invoiceNumber: null, supplierName: null }
      return prisma.invoiceBatchFile.update({
        where: { id: f.id },
        data: {
          detectedInvoiceNumber: meta.invoiceNumber,
          detectedSupplierName:  meta.supplierName,
          metaStatus: 'COMPLETE',
        },
      })
    })
  )

  // ── 4. Group files by (invoiceNumber + supplierName) ───────────────────────
  // Files with no invoice number each become their own group.
  const groups = new Map<string, typeof batch.files>()
  for (const f of batch.files) {
    const meta = metaMap.get(f.id) ?? { invoiceNumber: null, supplierName: null }
    const key = meta.invoiceNumber
      ? `${meta.invoiceNumber.trim()}|${(meta.supplierName ?? '').toLowerCase().trim()}`
      : `solo:${f.id}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(f)
  }

  // ── 5. Create one InvoiceSession per group + InvoiceFile records ───────────
  const sessionIds: string[] = []
  for (const [, groupFiles] of groups) {
    const rep = metaMap.get(groupFiles[0].id) ?? { invoiceNumber: null, supplierName: null }
    const session = await prisma.invoiceSession.create({
      data: {
        status:        'UPLOADING',
        batchId:       params.id,
        supplierName:  rep.supplierName  ?? null,
        invoiceNumber: rep.invoiceNumber ?? null,
      },
    })
    await prisma.invoiceFile.createMany({
      data: groupFiles.map(f => ({
        sessionId: session.id,
        fileName:  f.fileName,
        fileType:  f.fileType,
        fileUrl:   f.fileUrl,
        ocrStatus: 'PENDING',
      })),
    })
    sessionIds.push(session.id)
  }

  // ── 6. Advance batch status ────────────────────────────────────────────────
  await prisma.invoiceBatch.update({
    where: { id: params.id },
    data: { status: 'PROCESSING' },
  })

  return NextResponse.json({ sessions: sessionIds })
}
