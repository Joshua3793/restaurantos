import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { extractInvoiceFromImage, extractInvoiceFromText, extractInvoiceFromCsv } from '@/lib/invoice-ocr'
import { matchLineItems } from '@/lib/invoice-matcher'

// POST /api/invoices/sessions/[id]/process
// Fetches files from UploadThing URLs, runs OCR, matches items, moves session to REVIEW.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await prisma.invoiceSession.findUnique({
    where: { id: params.id },
    include: { files: true },
  })
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 })

  const pendingFiles = session.files.filter(f => f.ocrStatus === 'PENDING')
  if (!pendingFiles.length) {
    return NextResponse.json({ error: 'No pending files to process' }, { status: 400 })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return NextResponse.json(
      { error: 'ANTHROPIC_API_KEY is not configured. Add it to your environment variables.' },
      { status: 503 }
    )
  }

  let allOcrItems: Awaited<ReturnType<typeof extractInvoiceFromImage>>['lineItems'] = []
  const sessionMeta: {
    supplierName?: string | null
    invoiceDate?: string | null
    invoiceNumber?: string | null
    subtotal?: number | null
    tax?: number | null
    total?: number | null
  } = {}

  for (const file of pendingFiles) {
    await prisma.invoiceFile.update({ where: { id: file.id }, data: { ocrStatus: 'PROCESSING' } })

    try {
      // Fetch file bytes — supports UploadThing CDN URLs and local base64 data URIs
      let buffer: Buffer
      if (file.fileUrl.startsWith('data:')) {
        const comma = file.fileUrl.indexOf(',')
        buffer = Buffer.from(file.fileUrl.slice(comma + 1), 'base64')
      } else {
        const response = await fetch(file.fileUrl)
        if (!response.ok) throw new Error(`Failed to fetch file: ${response.status}`)
        buffer = Buffer.from(await response.arrayBuffer())
      }

      let result
      const ft = file.fileType.toLowerCase()

      if (ft === 'text/csv' || file.fileName.endsWith('.csv')) {
        result = await extractInvoiceFromCsv(buffer.toString('utf-8'))
      } else if (ft === 'application/pdf' || file.fileName.endsWith('.pdf')) {
        const pdfParse = (await import('pdf-parse')).default
        const parsed = await pdfParse(buffer)
        result = await extractInvoiceFromText(parsed.text)
      } else {
        // Image — encode as base64 for Claude Vision
        const base64 = buffer.toString('base64')
        const mediaType = (ft === 'image/png' ? 'image/png'
          : ft === 'image/webp' ? 'image/webp'
          : 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/webp'
        result = await extractInvoiceFromImage(base64, mediaType)
      }

      await prisma.invoiceFile.update({
        where: { id: file.id },
        data: { ocrStatus: 'COMPLETE', ocrRawJson: JSON.stringify(result) },
      })

      allOcrItems = [...allOcrItems, ...result.lineItems]
      if (!sessionMeta.supplierName  && result.supplierName)  sessionMeta.supplierName  = result.supplierName
      if (!sessionMeta.invoiceDate   && result.invoiceDate)   sessionMeta.invoiceDate   = result.invoiceDate
      if (!sessionMeta.invoiceNumber && result.invoiceNumber) sessionMeta.invoiceNumber = result.invoiceNumber
      if (!sessionMeta.subtotal      && result.subtotal)      sessionMeta.subtotal      = result.subtotal
      if (!sessionMeta.tax           && result.tax)           sessionMeta.tax           = result.tax
      if (!sessionMeta.total         && result.total)         sessionMeta.total         = result.total
    } catch (err) {
      console.error(`OCR failed for ${file.fileName}:`, err)
      await prisma.invoiceFile.update({ where: { id: file.id }, data: { ocrStatus: 'ERROR' } })
    }
  }

  // Match all OCR items against inventory
  const matched = await matchLineItems(allOcrItems, session.supplierName)

  // Replace existing scan items
  await prisma.invoiceScanItem.deleteMany({ where: { sessionId: params.id } })
  await prisma.invoiceScanItem.createMany({
    data: matched.map((item, i) => ({
      sessionId:       params.id,
      rawDescription:  item.description,
      rawQty:          item.qty ?? null,
      rawUnit:         item.unit ?? null,
      rawUnitPrice:    item.unitPrice ?? null,
      rawLineTotal:    item.lineTotal ?? null,
      matchedItemId:   item.matchedItemId,
      matchConfidence: item.matchConfidence,
      matchScore:      item.matchScore,
      action:          item.action,
      previousPrice:   item.previousPrice ?? null,
      newPrice:        item.newPrice ?? null,
      priceDiffPct:    item.priceDiffPct ?? null,
      formatMismatch:  item.formatMismatch,
      sortOrder:       i,
    })),
  })

  await prisma.invoiceSession.update({
    where: { id: params.id },
    data: {
      status:        'REVIEW',
      supplierName:  sessionMeta.supplierName  ?? session.supplierName,
      invoiceDate:   sessionMeta.invoiceDate   ?? session.invoiceDate,
      invoiceNumber: sessionMeta.invoiceNumber ?? session.invoiceNumber,
      subtotal:      sessionMeta.subtotal ?? null,
      tax:           sessionMeta.tax ?? null,
      total:         sessionMeta.total ?? null,
    },
  })

  return NextResponse.json({ processed: matched.length, status: 'REVIEW' })
}
