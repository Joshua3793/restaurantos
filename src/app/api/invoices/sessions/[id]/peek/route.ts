import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { quickExtractMeta } from '@/lib/invoice-ocr'
import { loadBuffer } from '@/lib/invoice-files'
import { proposeGroups, fileKind, type GroupingFile, type PeekMeta } from '@/lib/invoice-grouping'

export const dynamic = 'force-dynamic'
// 10 parallel Haiku calls finish in ~5s; 60s leaves room for slow CDN fetches.
export const maxDuration = 60

// POST /api/invoices/sessions/[id]/peek — quick-peek every file, cache the
// metadata on InvoiceFile.peekMeta, and return a proposed invoice grouping.
// Idempotent: files with cached peekMeta are never re-peeked.
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

  // Peek uncached, non-CSV files in parallel. allSettled: one unreadable
  // photo must never block the batch — it lands in the unassigned bucket.
  // Cached results carrying an `error` are re-peeked: a transient Haiku
  // failure must not permanently degrade a batch. Genuinely-unreadable
  // photos return null fields WITHOUT error and stay cached.
  const needPeek = session.files.filter(
    f => (f.peekMeta == null || (f.peekMeta as unknown as PeekMeta).error != null)
      && fileKind(f.fileType, f.fileName) !== 'csv',
  )
  const results = await Promise.allSettled(
    needPeek.map(async f => quickExtractMeta(await loadBuffer(f), f.fileType, f.fileName)),
  )

  const freshMeta = new Map<string, PeekMeta>()
  for (const [i, r] of results.entries()) {
    freshMeta.set(needPeek[i].id, r.status === 'fulfilled'
      ? { supplierName: r.value.supplierName, invoiceDate: r.value.invoiceDate, invoiceNumber: r.value.invoiceNumber }
      : {
          supplierName: null, invoiceDate: null, invoiceNumber: null,
          error: (r.reason instanceof Error ? r.reason.message : String(r.reason)).slice(0, 300),
        })
  }
  // CSVs get an empty (non-null) peekMeta so the cache marks them handled.
  for (const f of session.files) {
    if (f.peekMeta == null && fileKind(f.fileType, f.fileName) === 'csv') {
      freshMeta.set(f.id, { supplierName: null, invoiceDate: null, invoiceNumber: null })
    }
  }
  await Promise.all(
    [...freshMeta.entries()].map(([id, meta]) =>
      prisma.invoiceFile.update({ where: { id }, data: { peekMeta: meta as unknown as Prisma.InputJsonValue } }),
    ),
  )

  const groupingFiles: GroupingFile[] = session.files.map(f => ({
    id: f.id,
    fileName: f.fileName,
    fileType: f.fileType,
    peekMeta: freshMeta.get(f.id) ?? (f.peekMeta as unknown as PeekMeta | null),
  }))
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
