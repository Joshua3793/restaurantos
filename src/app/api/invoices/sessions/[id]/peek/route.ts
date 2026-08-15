import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { quickExtractMeta, PEEK_VERSION } from '@/lib/invoice-ocr'
import { loadBuffer } from '@/lib/invoice-files'
import { matchSupplierByName } from '@/lib/supplier-matcher'
import { proposeGroups, fileKind, type GroupingFile, type PeekMeta } from '@/lib/invoice-grouping'

export const dynamic = 'force-dynamic'
// 10 parallel Sonnet peeks finish in ~5-8s; 60s leaves room for slow CDN fetches.
export const maxDuration = 60

// POST /api/invoices/sessions/[id]/peek — quick-peek every file, cache the
// metadata on InvoiceFile.peekMeta, and return a proposed invoice grouping.
// Idempotent: files with current-version cached peekMeta are never re-peeked.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const session = await prisma.invoiceSession.findUnique({
    where: { id: params.id },
    include: {
      files: {
        select: { id: true, fileName: true, fileType: true, fileUrl: true, peekMeta: true, ocrStatus: true, ocrRawJson: true },
        orderBy: { createdAt: 'asc' },
      },
    },
  })
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  // UPLOADING = files still registering; PROCESSING = upload routes set this on
  // registration; GROUPING = a resumed batch. Anything later means OCR already ran.
  if (!['UPLOADING', 'PROCESSING', 'GROUPING'].includes(session.status)) {
    return NextResponse.json(
      { error: `Session is ${session.status} — grouping is only available before scanning` },
      { status: 409 },
    )
  }
  if (session.files.length === 0) {
    return NextResponse.json({ error: 'No files uploaded' }, { status: 400 })
  }
  // A session whose OCR is underway must never be re-parked in GROUPING.
  if (session.files.some(f => f.ocrStatus !== 'PENDING' || f.ocrRawJson != null)) {
    return NextResponse.json(
      { error: 'Scanning already started for this session — grouping is no longer available' },
      { status: 409 },
    )
  }

  // Peek non-CSV files in parallel. allSettled: one unreadable photo must
  // never block the batch — it lands in the unassigned bucket.
  // Re-peek when the cache is missing, carries an `error` (a transient API
  // failure must not permanently degrade a batch — genuinely-unreadable
  // photos return null fields WITHOUT error and stay cached), or was produced
  // by an older peek pipeline (v mismatch — e.g. pre-Sonnet digit misreads).
  const needPeek = session.files.filter(f => {
    if (fileKind(f.fileType, f.fileName) === 'csv') return false
    const cached = f.peekMeta as unknown as PeekMeta | null
    return cached == null || cached.error != null || cached.v !== PEEK_VERSION
  })
  const results = await Promise.allSettled(
    needPeek.map(async f => quickExtractMeta(await loadBuffer(f), f.fileType, f.fileName)),
  )

  const freshMeta = new Map<string, PeekMeta>()
  for (const [i, r] of results.entries()) {
    freshMeta.set(needPeek[i].id, r.status === 'fulfilled'
      ? {
          supplierName: r.value.supplierName, invoiceDate: r.value.invoiceDate, invoiceNumber: r.value.invoiceNumber,
          pageType: r.value.pageType, supplierConfidence: r.value.supplierConfidence,
          numberConfidence: r.value.numberConfidence, v: PEEK_VERSION,
        }
      : {
          supplierName: null, invoiceDate: null, invoiceNumber: null,
          pageType: 'unknown', supplierConfidence: 'low', numberConfidence: 'low', v: PEEK_VERSION,
          error: (r.reason instanceof Error ? r.reason.message : String(r.reason)).slice(0, 300),
        })
  }
  // CSVs get an empty (non-null) peekMeta so the cache marks them handled.
  for (const f of session.files) {
    if (f.peekMeta == null && fileKind(f.fileType, f.fileName) === 'csv') {
      freshMeta.set(f.id, {
        supplierName: null, invoiceDate: null, invoiceNumber: null,
        pageType: 'unknown', supplierConfidence: 'low', numberConfidence: 'low', v: PEEK_VERSION,
      })
    }
  }
  await Promise.all(
    [...freshMeta.entries()].map(([id, meta]) =>
      prisma.invoiceFile.update({ where: { id }, data: { peekMeta: meta as unknown as Prisma.InputJsonValue } }),
    ),
  )

  // Canonicalize peeked supplier names against the Supplier table so variants
  // and truncations ("ISCO", "Sysco Inc.") collapse into one supplier before
  // grouping. The RAW name stays in the cached peekMeta; canonicalization is
  // recomputed per call (a handful of names, cheap).
  const effMeta = new Map<string, PeekMeta | null>(
    session.files.map(f => [f.id, freshMeta.get(f.id) ?? (f.peekMeta as unknown as PeekMeta | null)]),
  )
  const rawNames = [...new Set(
    [...effMeta.values()].map(m => m?.supplierName).filter((x): x is string => !!x),
  )]
  const canonical = new Map<string, string>()
  await Promise.all(rawNames.map(async raw => {
    try {
      const supplierId = await matchSupplierByName(raw)
      if (!supplierId) return
      const sup = await prisma.supplier.findUnique({ where: { id: supplierId }, select: { name: true } })
      if (sup?.name) canonical.set(raw, sup.name)
    } catch { /* keep the raw name */ }
  }))

  const groupingFiles: GroupingFile[] = session.files.map(f => {
    const m = effMeta.get(f.id) ?? null
    const canonicalName = m?.supplierName ? canonical.get(m.supplierName) : undefined
    return {
      id: f.id,
      fileName: f.fileName,
      fileType: f.fileType,
      peekMeta: m && canonicalName ? { ...m, supplierName: canonicalName } : m,
    }
  })
  const proposal = proposeGroups(groupingFiles)

  // >1 file → park in GROUPING (protects it from the PROCESSING sweeper and
  // renders a resumable "Needs grouping" card). Single file never enters GROUPING.
  if (session.files.length > 1 && session.status !== 'GROUPING') {
    await prisma.invoiceSession.update({ where: { id: params.id }, data: { status: 'GROUPING' } })
  }

  return NextResponse.json({
    sessionId: session.id,
    files: session.files.map(f => ({ id: f.id, fileName: f.fileName, fileType: f.fileType, fileUrl: f.fileUrl })),
    groups: proposal.groups,
    unassigned: proposal.unassigned,
  })
}
