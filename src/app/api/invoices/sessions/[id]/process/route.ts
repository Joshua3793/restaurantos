import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { extractInvoiceFromImages, extractInvoiceFromPdf, extractInvoiceFromCsv } from '@/lib/invoice-ocr'
import { matchLineItems } from '@/lib/invoice-matcher'
import { matchSupplierByName } from '@/lib/supplier-matcher'
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

  // Allow retrying ERROR sessions — reset their files to PENDING
  if (session.status === 'ERROR') {
    await prisma.invoiceSession.update({
      where: { id: params.id },
      data: { status: 'PROCESSING', errorMessage: null },
    })
    await prisma.invoiceFile.updateMany({
      where: { sessionId: params.id, ocrStatus: { in: ['ERROR', 'PENDING'] } },
      data: { ocrStatus: 'PENDING' },
    })
  }

  // Re-fetch files after potential retry reset
  const filesToProcess = await prisma.invoiceFile.findMany({
    where: { sessionId: params.id, ocrStatus: 'PENDING' },
    select: { id: true, fileName: true, fileType: true, fileUrl: true, ocrStatus: true, ocrRawJson: true },
  })

  if (!filesToProcess.length) {
    return NextResponse.json({ error: 'No pending files to process' }, { status: 400 })
  }

  const needsFreshOcr = filesToProcess.some(f => !f.ocrRawJson)
  if (needsFreshOcr && !process.env.ANTHROPIC_API_KEY) {
    await prisma.invoiceSession.update({
      where: { id: params.id },
      data: { status: 'ERROR', errorMessage: 'ANTHROPIC_API_KEY is not configured.' },
    })
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not configured.' }, { status: 503 })
  }

  try {
    // Mark all as PROCESSING up front
    await prisma.invoiceFile.updateMany({
      where: { id: { in: filesToProcess.map(f => f.id) } },
      data: { ocrStatus: 'PROCESSING' },
    })

    const sessionMeta: Partial<OcrResult> = {}
    let allOcrItems: OcrResult['lineItems'] = []

    async function loadBuffer(file: typeof filesToProcess[0]): Promise<Buffer> {
      if (file.fileUrl.startsWith('data:')) {
        const comma = file.fileUrl.indexOf(',')
        return Buffer.from(file.fileUrl.slice(comma + 1), 'base64')
      }
      const res = await fetch(file.fileUrl)
      if (!res.ok) throw new Error(`Failed to fetch ${file.fileName}: ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    }

    const imageFiles  = filesToProcess.filter(f => !f.ocrRawJson && isImage(f.fileType, f.fileName))
    const nonImgFiles = filesToProcess.filter(f => !f.ocrRawJson && !isImage(f.fileType, f.fileName))
    const cachedFiles = filesToProcess.filter(f =>  f.ocrRawJson)

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
        await prisma.invoiceFile.update({
          where: { id: imageFiles[0].id },
          data: { ocrStatus: 'COMPLETE', ocrRawJson: JSON.stringify(result) },
        })
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
        throw err  // re-throw so outer catch sets session to ERROR
      }
    }

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
            throw err  // re-throw so outer catch sets session to ERROR
          }
        })
      )
    }

    console.log(`[process] Extracted ${allOcrItems.length} items`)

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

    const finalSupplierName = sessionMeta.supplierName ?? session.supplierName
    let autoSupplierId: string | null = null
    if (finalSupplierName) {
      autoSupplierId = await matchSupplierByName(finalSupplierName)
    }

    await prisma.invoiceSession.update({
      where: { id: params.id },
      data: {
        status:        'REVIEW',
        supplierName:  finalSupplierName,
        invoiceDate:   sessionMeta.invoiceDate   ?? session.invoiceDate,
        invoiceNumber: sessionMeta.invoiceNumber ?? session.invoiceNumber,
        subtotal:      sessionMeta.subtotal  ?? null,
        tax:           sessionMeta.tax       ?? null,
        total:         sessionMeta.total     ?? null,
        errorMessage:  null,
        ...(autoSupplierId ? { supplierId: autoSupplierId } : {}),
      },
    })

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

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[process] Unhandled error:', msg)
    await prisma.invoiceFile.updateMany({
      where: { sessionId: params.id, ocrStatus: 'PROCESSING' },
      data: { ocrStatus: 'ERROR' },
    }).catch(() => {})
    await prisma.invoiceSession.update({
      where: { id: params.id },
      data: { status: 'ERROR', errorMessage: msg.slice(0, 500) },
    }).catch(() => {})
    return NextResponse.json({ error: msg }, { status: 500 })
  }
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
