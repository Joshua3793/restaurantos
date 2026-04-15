import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { extractInvoiceFromImages, extractInvoiceFromPdf, extractInvoiceFromCsv } from '@/lib/invoice-ocr'
import { matchLineItems } from '@/lib/invoice-matcher'
import type { OcrResult } from '@/lib/invoice-ocr'

// Allow up to 120s for OCR (multi-page photo invoices can take a while)
export const maxDuration = 120

// POST /api/invoices/sessions/[id]/process
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await prisma.invoiceSession.findUnique({
    where: { id: params.id },
    include: {
      files: {
        select: { id: true, fileName: true, fileType: true, fileUrl: true, ocrStatus: true, ocrRawJson: true },
      },
    },
  })
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 })

  const pendingFiles = session.files.filter(f => f.ocrStatus === 'PENDING')
  if (!pendingFiles.length) {
    return NextResponse.json({ error: 'No pending files to process' }, { status: 400 })
  }

  const needsFreshOcr = pendingFiles.some(f => !f.ocrRawJson)
  if (needsFreshOcr && !process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: 'ANTHROPIC_API_KEY is not configured.' },
      { status: 503 }
    )
  }

  // Mark all as PROCESSING up front
  await prisma.invoiceFile.updateMany({
    where: { id: { in: pendingFiles.map(f => f.id) } },
    data: { ocrStatus: 'PROCESSING' },
  })

  const sessionMeta: Partial<OcrResult> = {}
  let allOcrItems: OcrResult['lineItems'] = []

  // ── Helper: load file bytes from data-URI or CDN URL ──────────────────────
  async function loadBuffer(file: typeof pendingFiles[0]): Promise<Buffer> {
    if (file.fileUrl.startsWith('data:')) {
      const comma = file.fileUrl.indexOf(',')
      return Buffer.from(file.fileUrl.slice(comma + 1), 'base64')
    }
    const res = await fetch(file.fileUrl)
    if (!res.ok) throw new Error(`Failed to fetch ${file.fileName}: ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }

  // ── Separate image files from PDFs / CSVs ─────────────────────────────────
  const imageFiles  = pendingFiles.filter(f => !f.ocrRawJson && isImage(f.fileType, f.fileName))
  const nonImgFiles = pendingFiles.filter(f => !f.ocrRawJson && !isImage(f.fileType, f.fileName))
  const cachedFiles = pendingFiles.filter(f =>  f.ocrRawJson)

  // ── 1. Load cached OCR results (no API call needed) ───────────────────────
  for (const file of cachedFiles) {
    try {
      const result = JSON.parse(file.ocrRawJson!) as OcrResult
      if (!Array.isArray(result.lineItems)) result.lineItems = []
      mergeResult(result, sessionMeta)
      allOcrItems = [...allOcrItems, ...result.lineItems]
      await prisma.invoiceFile.update({ where: { id: file.id }, data: { ocrStatus: 'COMPLETE' } })
    } catch (err) {
      console.error(`[process] Cached OCR JSON corrupt for ${file.fileName}:`, err)
      await prisma.invoiceFile.update({ where: { id: file.id }, data: { ocrStatus: 'PENDING' } })
    }
  }

  // ── 2. ALL image pages → single Claude call (biggest speed win) ───────────
  if (imageFiles.length > 0) {
    try {
      console.log(`[process] Sending ${imageFiles.length} image(s) in one Claude call`)
      const imagePayloads = await Promise.all(
        imageFiles.map(async (f) => {
          const buf = await loadBuffer(f)
          const ft  = f.fileType.toLowerCase()
          return {
            base64:    buf.toString('base64'),
            mediaType: (ft === 'image/png' ? 'image/png' : ft === 'image/webp' ? 'image/webp' : 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/webp',
          }
        })
      )

      const result = await extractInvoiceFromImages(imagePayloads)
      mergeResult(result, sessionMeta)
      allOcrItems = [...allOcrItems, ...result.lineItems]

      // Save OCR result on the first image file (represents the whole batch)
      await prisma.invoiceFile.update({
        where: { id: imageFiles[0].id },
        data: { ocrStatus: 'COMPLETE', ocrRawJson: JSON.stringify(result) },
      })
      // Mark remaining image files complete (their data is included in the first)
      if (imageFiles.length > 1) {
        await prisma.invoiceFile.updateMany({
          where: { id: { in: imageFiles.slice(1).map(f => f.id) } },
          data: { ocrStatus: 'COMPLETE' },
        })
      }
    } catch (err) {
      console.error('[process] Image OCR failed:', err)
      await prisma.invoiceFile.updateMany({
        where: { id: { in: imageFiles.map(f => f.id) } },
        data: { ocrStatus: 'ERROR' },
      })
    }
  }

  // ── 3. PDFs and CSVs — run in parallel ───────────────────────────────────
  if (nonImgFiles.length > 0) {
    await Promise.all(
      nonImgFiles.map(async (file) => {
        try {
          const buf = await loadBuffer(file)
          const ft  = file.fileType.toLowerCase()
          let result: OcrResult

          if (ft === 'text/csv' || file.fileName.endsWith('.csv')) {
            result = await extractInvoiceFromCsv(buf.toString('utf-8'))
          } else {
            result = await extractInvoiceFromPdf(buf)
          }

          await prisma.invoiceFile.update({
            where: { id: file.id },
            data: { ocrStatus: 'COMPLETE', ocrRawJson: JSON.stringify(result) },
          })
          mergeResult(result, sessionMeta)
          allOcrItems = [...allOcrItems, ...result.lineItems]
        } catch (err) {
          console.error(`[process] OCR failed for ${file.fileName}:`, err)
          await prisma.invoiceFile.update({ where: { id: file.id }, data: { ocrStatus: 'ERROR' } })
        }
      })
    )
  }

  console.log(`[process] Extracted ${allOcrItems.length} items:`, allOcrItems.map(i => i.description))

  // ── 4. Match items against inventory ─────────────────────────────────────
  let matched: Awaited<ReturnType<typeof matchLineItems>> = []
  try {
    matched = await matchLineItems(allOcrItems, session.supplierName)
    await prisma.invoiceScanItem.deleteMany({ where: { sessionId: params.id } })
    if (matched.length > 0) {
      await prisma.invoiceScanItem.createMany({
        data: matched.map((item, i) => ({
          sessionId:          params.id,
          rawDescription:     item.description,
          rawQty:             item.qty ?? null,
          rawUnit:            item.unit ?? null,
          rawUnitPrice:       item.unitPrice ?? null,
          rawLineTotal:       item.lineTotal ?? null,
          matchedItemId:      item.matchedItemId,
          matchConfidence:    item.matchConfidence,
          matchScore:         item.matchScore,
          action:             item.action,
          previousPrice:      item.previousPrice ?? null,
          newPrice:           item.newPrice ?? null,
          priceDiffPct:       item.priceDiffPct ?? null,
          formatMismatch:     item.formatMismatch,
          invoicePackQty:     item.invoicePackQty ?? null,
          invoicePackSize:    item.invoicePackSize ?? null,
          invoicePackUOM:     item.invoicePackUOM ?? null,
          needsFormatConfirm: item.needsFormatConfirm,
          sortOrder:          i,
        })),
      })
    }
  } catch (err) {
    console.error('[process] Matching failed:', err)
  }

  // ── 5. Always move to REVIEW ───────────────────────────────────────────────
  await prisma.invoiceSession.update({
    where: { id: params.id },
    data: {
      status:        'REVIEW',
      supplierName:  sessionMeta.supplierName  ?? session.supplierName,
      invoiceDate:   sessionMeta.invoiceDate   ?? session.invoiceDate,
      invoiceNumber: sessionMeta.invoiceNumber ?? session.invoiceNumber,
      subtotal:      sessionMeta.subtotal  ?? null,
      tax:           sessionMeta.tax       ?? null,
      total:         sessionMeta.total     ?? null,
    },
  })

  const errorFiles = session.files.filter(f =>
    pendingFiles.some(p => p.id === f.id)
  ).length  // We'll count the re-queried error count from DB instead

  // Re-fetch file statuses to get accurate error count after processing
  const updatedFiles = await prisma.invoiceFile.findMany({
    where: { sessionId: params.id },
    select: { ocrStatus: true },
  })
  const ocrErrorCount = updatedFiles.filter(f => f.ocrStatus === 'ERROR').length

  return NextResponse.json({
    processed: matched.length,
    ocrItemCount: allOcrItems.length,
    ocrErrors: ocrErrorCount,
    status: 'REVIEW',
  })
}

// ── DELETE /api/invoices/sessions/[id]/process — cancel processing ─────────
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await prisma.invoiceFile.updateMany({
    where: { sessionId: params.id, ocrStatus: 'PROCESSING' },
    data: { ocrStatus: 'PENDING' },
  })
  await prisma.invoiceSession.update({
    where: { id: params.id },
    data: { status: 'UPLOADING' },
  })
  return NextResponse.json({ ok: true })
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isImage(fileType: string, fileName: string): boolean {
  const ft = fileType.toLowerCase()
  return ft.startsWith('image/') || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(fileName)
}

function mergeResult(result: OcrResult, meta: Partial<OcrResult>) {
  if (!meta.supplierName  && result.supplierName)  meta.supplierName  = result.supplierName
  if (!meta.invoiceDate   && result.invoiceDate)   meta.invoiceDate   = result.invoiceDate
  if (!meta.invoiceNumber && result.invoiceNumber) meta.invoiceNumber = result.invoiceNumber
  if (!meta.subtotal      && result.subtotal)      meta.subtotal      = result.subtotal
  if (!meta.tax           && result.tax)           meta.tax           = result.tax
  if (!meta.total         && result.total)         meta.total         = result.total
}
