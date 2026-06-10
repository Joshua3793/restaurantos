import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import fs from 'fs'
import path from 'path'
import { prisma } from '@/lib/prisma'
import { extractInvoiceFromImages, extractInvoiceFromPdf, extractInvoiceFromCsv, quickExtractMeta } from '@/lib/invoice-ocr'
import { matchLineItems } from '@/lib/invoice-matcher'
import { matchSupplierByName } from '@/lib/supplier-matcher'
import type { OcrResult } from '@/lib/invoice-ocr'

function hasAnthropicKey(): boolean {
  if (process.env.ANTHROPIC_API_KEY) return true
  try {
    const raw = fs.readFileSync(path.resolve(process.cwd(), '.env'), 'utf-8')
    return /^ANTHROPIC_API_KEY=["']?.+/m.test(raw)
  } catch { return false }
}

// Allow up to 300s for OCR — large invoices (100+ items) generate 30–40k output tokens
// which can take 90–150s to stream. 120s was too tight and caused silent function kills.
export const maxDuration = 300

// POST /api/invoices/sessions/[id]/process
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await prisma.invoiceSession.findUnique({
    where: { id: params.id },
    include: {
      files: {
        select: { id: true, fileName: true, fileType: true, fileUrl: true, ocrStatus: true, ocrRawJson: true },
        orderBy: { createdAt: 'asc' },
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
      // Include PROCESSING: a serverless kill can strand files there with no
      // other reclaim path — the stale-session sweeper in the sessions list
      // route flips the session to ERROR after 5 min, then this reset runs.
      where: { sessionId: params.id, ocrStatus: { in: ['ERROR', 'PENDING', 'PROCESSING'] } },
      data: { ocrStatus: 'PENDING' },
    })
  }

  // Re-fetch files after potential retry reset
  // File order defines OCR page order — bbox.page indexes into this array, and the viewer
  // indexes session.files the same way. Keep all file queries ordered by createdAt asc
  // (inserts are sequential).
  const filesToProcess = await prisma.invoiceFile.findMany({
    where: { sessionId: params.id, ocrStatus: 'PENDING' },
    select: { id: true, fileName: true, fileType: true, fileUrl: true, ocrStatus: true, ocrRawJson: true },
    orderBy: { createdAt: 'asc' },
  })

  if (!filesToProcess.length) {
    return NextResponse.json({ error: 'No pending files to process' }, { status: 400 })
  }

  // ── Quick peek: extract supplier / date from the first file using Haiku (~2s) ──
  // This runs before the full OCR so the session list shows identifiable info
  // (e.g. "Metro Foods · 08/05/2026") while Claude is still scanning line items.
  if (hasAnthropicKey()) {
    try {
      const firstFile = filesToProcess[0]
      const buf = await loadBuffer(firstFile)
      const quick = await quickExtractMeta(buf, firstFile.fileType, firstFile.fileName)
      const patch: Record<string, string> = {}
      if (quick.supplierName  && !session.supplierName)  patch.supplierName  = quick.supplierName
      if (quick.invoiceDate   && !session.invoiceDate)   patch.invoiceDate   = quick.invoiceDate
      if (quick.invoiceNumber && !session.invoiceNumber) patch.invoiceNumber = quick.invoiceNumber
      if (Object.keys(patch).length) {
        await prisma.invoiceSession.update({ where: { id: params.id }, data: patch })
        console.log(`[process] Quick peek: supplier=${quick.supplierName}, date=${quick.invoiceDate}`)
      }
    } catch (err) {
      // Non-fatal — full OCR will fill in the blanks
      console.warn('[process] Quick peek failed (non-fatal):', err instanceof Error ? err.message : err)
    }
  }

  // Learning mode: supplier unknown or fewer than 3 approved invoices from this supplier.
  // Uses higher image quality and larger thinking budget for better first-time format detection.
  const approvedCount = session.supplierName
    ? await prisma.invoiceSession.count({
        where: { supplierName: session.supplierName, status: 'APPROVED', id: { not: params.id } },
      })
    : 0
  const isLearning = !session.supplierName || approvedCount < 3
  if (isLearning) {
    console.log(`[process] Learning mode active (supplier: ${session.supplierName ?? 'unknown'}, approved invoices: ${approvedCount})`)
  }

  // Layout notes saved by a previous learning-mode run for this supplier.
  let savedFormatNotes: string | null = null
  if (session.supplierId) {
    const sup = await prisma.supplier.findUnique({
      where: { id: session.supplierId },
      select: { ocrFormatNotes: true },
    })
    savedFormatNotes = sup?.ocrFormatNotes ?? null
  }

  const needsFreshOcr = filesToProcess.some(f => !f.ocrRawJson)
  if (needsFreshOcr && !hasAnthropicKey()) {
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

    // loadBuffer defined at module scope — see bottom of file

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
      try {
        console.log(`[process] Sending ${imageFiles.length} image(s) in one Claude call`)
        const result = await extractInvoiceFromImages(imagePayloads, session.supplierName, isLearning, savedFormatNotes)
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
        const msg = err instanceof Error ? err.message : String(err)
        // The combined call can blow the output-token budget on very long
        // invoices. Fall back to OCR-ing each page separately and merging —
        // each page alone fits comfortably in the budget.
        // Caveat: rows split across a page break (or reprinted under "continued"
        // headers) may come back duplicated/partial — the combined call deduped
        // these holistically.
        if (imageFiles.length > 1 && /truncated/i.test(msg)) {
          console.warn('[process] Combined image OCR truncated — falling back to per-page OCR')
          // The viewer indexes session.files[bbox.page], so re-index each
          // single-page result (which returns page: 0) to the file's position
          // in the full ordered session file list.
          const pageIndexById = new Map(session.files.map((f, idx) => [f.id, idx]))
          const pageResults = await Promise.allSettled(
            imagePayloads.map(p => extractInvoiceFromImages([p], session.supplierName, isLearning, savedFormatNotes))
          )
          let anyOk = false
          const pageOcrResults: { page: number; result: OcrResult }[] = []
          for (const [i, r] of pageResults.entries()) {
            if (r.status === 'fulfilled') {
              anyOk = true
              const page = pageIndexById.get(imageFiles[i].id) ?? i
              for (const li of r.value.lineItems) {
                if (li.bbox) li.bbox.page = page
              }
              pageOcrResults.push({ page, result: r.value })
              allOcrItems = [...allOcrItems, ...r.value.lineItems]
              await prisma.invoiceFile.update({
                where: { id: imageFiles[i].id },
                data: { ocrStatus: 'COMPLETE', ocrRawJson: JSON.stringify(r.value) },
              })
            } else {
              console.error(`[process] Per-page OCR failed for ${imageFiles[i].fileName}:`, r.reason)
              await prisma.invoiceFile.update({
                where: { id: imageFiles[i].id },
                data: { ocrStatus: 'ERROR' },
              })
            }
          }
          if (!anyOk) {
            const firstReason = pageResults.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined
            throw new Error(
              `Per-page OCR fallback failed for all pages: ${firstReason?.reason instanceof Error ? firstReason.reason.message : String(firstReason?.reason ?? err)}`
            )
          }
          // Header merge: identity fields (supplier, invoice #, date, PO) read
          // best from the FIRST page; financial fields (totals, taxes, fees)
          // print on the LAST page of multi-page invoices. mergeResult is
          // first-wins, so feed it page order for identity and reverse page
          // order for the money fields.
          const identityMeta: Partial<OcrResult> = {}
          for (const { result } of pageOcrResults) mergeResult(result, identityMeta)
          const moneyMeta: Partial<OcrResult> = {}
          for (const { result } of [...pageOcrResults].reverse()) mergeResult(result, moneyMeta)
          mergeResult({
            ...(moneyMeta as OcrResult),
            supplierName:  identityMeta.supplierName  ?? null,
            invoiceNumber: identityMeta.invoiceNumber ?? null,
            invoiceDate:   identityMeta.invoiceDate   ?? null,
            poNumber:      identityMeta.poNumber      ?? null,
            lineItems: [],
          } as OcrResult, sessionMeta)
        } else {
          console.error('[process] Image OCR failed:', err)
          await prisma.invoiceFile.updateMany({
            where: { id: { in: imageFiles.map(f => f.id) } },
            data: { ocrStatus: 'ERROR' },
          })
          throw err  // re-throw so outer catch sets session to ERROR
        }
      }
    }

    if (nonImgFiles.length > 0) {
      // allSettled so one failing file doesn't abort the others
      const results = await Promise.allSettled(
        nonImgFiles.map(async (file) => {
          const buf = await loadBuffer(file)
          const ft  = file.fileType.toLowerCase()
          let result: OcrResult
          if (ft === 'text/csv' || file.fileName.endsWith('.csv')) {
            result = await extractInvoiceFromCsv(buf.toString('utf-8'))
          } else {
            result = await extractInvoiceFromPdf(buf, session.supplierName, isLearning, savedFormatNotes)
          }
          await prisma.invoiceFile.update({
            where: { id: file.id },
            data: { ocrStatus: 'COMPLETE', ocrRawJson: JSON.stringify(result) },
          })
          mergeResult(result, sessionMeta)
          allOcrItems = [...allOcrItems, ...result.lineItems]
        })
      )
      for (const [i, r] of results.entries()) {
        if (r.status === 'rejected') {
          console.error(`[process] OCR failed for ${nonImgFiles[i].fileName}:`, r.reason)
          await prisma.invoiceFile.update({ where: { id: nonImgFiles[i].id }, data: { ocrStatus: 'ERROR' } })
        }
      }
    }

    // If nothing was extracted and at least one file errored, this session is
    // an OCR failure — surface ERROR instead of an empty REVIEW screen.
    if (allOcrItems.length === 0) {
      const states = await prisma.invoiceFile.findMany({
        where: { sessionId: params.id },
        select: { ocrStatus: true },
      })
      if (states.some(f => f.ocrStatus === 'ERROR')) {
        throw new Error('Scanning failed for all uploaded files — no line items were extracted. Retry, or re-upload clearer photos.')
      }
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
            rawQty:             item.qtyShipped ?? item.qtyOrdered ?? null,
            rawUnit:            item.qtyShippedUOM ?? item.qtyOrderedUOM ?? null,
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
            totalQty:           item.totalQty    ?? null,
            totalQtyUOM:        item.totalQtyUOM ?? null,
            ocrConfidence:      item.confidence       ?? null,
            ocrNotes:           item.confidenceNotes  ?? null,
            // Mode-aware fields from the mode-first OCR schema
            pricingMode:        item.pricingMode       ?? null,
            pricingModeSignal:  item.pricingModeSignal ?? null,
            qtyOrdered:         item.qtyOrdered        ?? null,
            qtyOrderedUOM:      item.qtyOrderedUOM     ?? null,
            rate:               item.rate              ?? null,
            rateUOM:            item.rateUOM           ?? null,
            isCatchweight:      item.isCatchweight     ?? false,
            nominalWeight:      item.nominalWeight     ?? null,
            lineCategory:       item.lineCategory      ?? null,
            supplierItemCode:   item.supplierItemCode  ?? null,
            taxFlag:            item.taxFlag           ?? null,
            lineTaxAmount:      item.lineTaxAmount     ?? null,
            bbox:               item.bbox              ?? Prisma.DbNull,
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

    // Sum the split Canadian taxes back into the single InvoiceSession.tax column
    const taxSum = (sessionMeta.gst ?? 0) + (sessionMeta.hst ?? 0) + (sessionMeta.pst ?? 0)
    const taxValue =
      sessionMeta.gst != null || sessionMeta.hst != null || sessionMeta.pst != null
        ? taxSum
        : null

    await prisma.invoiceSession.update({
      where: { id: params.id },
      data: {
        status:          'REVIEW',
        supplierName:    finalSupplierName,
        invoiceDate:     sessionMeta.invoiceDate   ?? session.invoiceDate,
        invoiceNumber:   sessionMeta.invoiceNumber ?? session.invoiceNumber,
        poNumber:        sessionMeta.poNumber        ?? null,
        subtotal:        sessionMeta.subtotal        ?? null,
        tax:             taxValue,
        discount:        sessionMeta.discount        ?? null,
        fuelSurcharge:   sessionMeta.fuelSurcharge   ?? null,
        freight:         sessionMeta.freight         ?? null,
        minimumOrderFee: sessionMeta.minimumOrderFee ?? null,
        gst:             sessionMeta.gst             ?? null,
        hst:             sessionMeta.hst             ?? null,
        pst:             sessionMeta.pst             ?? null,
        ...(sessionMeta.otherCharges && sessionMeta.otherCharges.length > 0
          ? { otherCharges: sessionMeta.otherCharges }
          : {}),
        total:           sessionMeta.total ?? null,
        errorMessage:    null,
        ...(autoSupplierId ? { supplierId: autoSupplierId } : {}),
      },
    })

    // Persist learning-mode layout discovery for next time. autoSupplierId is
    // resolved just above; prefer it over the session's original supplierId.
    const formatNotesSupplierId = autoSupplierId ?? session.supplierId
    if (isLearning && sessionMeta.formatNotes && formatNotesSupplierId) {
      await prisma.supplier.update({
        where: { id: formatNotesSupplierId },
        data:  { ocrFormatNotes: sessionMeta.formatNotes.slice(0, 1000) },
      }).catch(() => {}) // non-critical
    }

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
  try {
    await prisma.invoiceFile.updateMany({
      where: { sessionId: params.id, ocrStatus: 'PROCESSING' },
      data: { ocrStatus: 'PENDING' },
    })
    await prisma.invoiceSession.update({
      where: { id: params.id },
      data: { status: 'UPLOADING' },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // P2025 = record not found — session already deleted, treat as success
    if (!msg.includes('P2025')) throw err
  }
  return NextResponse.json({ ok: true })
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function loadBuffer(file: { fileUrl: string; fileName: string }): Promise<Buffer> {
  if (file.fileUrl.startsWith('data:')) {
    const comma = file.fileUrl.indexOf(',')
    return Buffer.from(file.fileUrl.slice(comma + 1), 'base64')
  }
  const res = await fetch(file.fileUrl)
  if (!res.ok) throw new Error(`Failed to fetch ${file.fileName}: ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

function isImage(fileType: string, fileName: string): boolean {
  const ft = fileType.toLowerCase()
  return ft.startsWith('image/') || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(fileName)
}

function mergeResult(result: OcrResult, meta: Partial<OcrResult>) {
  if (meta.supplierName    == null && result.supplierName    != null) meta.supplierName    = result.supplierName
  if (meta.invoiceDate     == null && result.invoiceDate     != null) meta.invoiceDate     = result.invoiceDate
  if (meta.invoiceNumber   == null && result.invoiceNumber   != null) meta.invoiceNumber   = result.invoiceNumber
  if (meta.poNumber        == null && result.poNumber        != null) meta.poNumber        = result.poNumber
  if (meta.subtotal        == null && result.subtotal        != null) meta.subtotal        = result.subtotal
  if (meta.discount        == null && result.discount        != null) meta.discount        = result.discount
  if (meta.fuelSurcharge   == null && result.fuelSurcharge   != null) meta.fuelSurcharge   = result.fuelSurcharge
  if (meta.freight         == null && result.freight         != null) meta.freight         = result.freight
  if (meta.minimumOrderFee == null && result.minimumOrderFee != null) meta.minimumOrderFee = result.minimumOrderFee
  if (meta.gst             == null && result.gst             != null) meta.gst             = result.gst
  if (meta.hst             == null && result.hst             != null) meta.hst             = result.hst
  if (meta.pst             == null && result.pst             != null) meta.pst             = result.pst
  if (meta.total           == null && result.total           != null) meta.total           = result.total
  if (meta.formatNotes     == null && result.formatNotes     != null) meta.formatNotes     = result.formatNotes
}
