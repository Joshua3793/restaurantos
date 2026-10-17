import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { deleteFileBlobs } from '@/lib/invoice-files'
import { STUCK_AFTER_MS, STUCK_ERROR } from '@/lib/recipe-scan/scan-files'

export const dynamic = 'force-dynamic'

// GET /api/recipe-scans/[id] — the scan, its files (for the original viewer) and its drafts.
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  await prisma.recipeScan.updateMany({
    where: { id: params.id, status: 'READING', updatedAt: { lt: new Date(Date.now() - STUCK_AFTER_MS) } },
    data: { status: 'ERROR', error: STUCK_ERROR },
  })

  const scan = await prisma.recipeScan.findUnique({
    where: { id: params.id },
    select: {
      id: true, status: true, error: true, revenueCenterId: true, createdById: true, createdAt: true, updatedAt: true,
      files: { select: { id: true, fileName: true, fileType: true, fileUrl: true }, orderBy: { sortOrder: 'asc' } },
      drafts: {
        select: { id: true, index: true, title: true, status: true, savedRecipeId: true },
        orderBy: { index: 'asc' },
      },
    },
  })
  if (!scan) return NextResponse.json({ error: 'Scan not found' }, { status: 404 })
  return NextResponse.json(scan, { headers: { 'Cache-Control': 'no-store' } })
}

// DELETE /api/recipe-scans/[id] — discard the scan. A recipe already saved from
// it keeps its original ("See original"), so then only the unsaved drafts are
// discarded and the files stay; otherwise the scan, its drafts and the
// uploaded files all go.
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const scan = await prisma.recipeScan.findUnique({
    where: { id: params.id },
    select: { id: true, files: { select: { fileUrl: true } } },
  })
  if (!scan) return NextResponse.json({ error: 'Scan not found' }, { status: 404 })

  const usedBy = await prisma.recipe.count({ where: { sourceScanId: scan.id } })
  if (usedBy > 0) {
    const { count } = await prisma.recipeScanDraft.updateMany({
      where: { scanId: scan.id, status: 'OPEN' },
      data: { status: 'DISCARDED' },
    })
    return NextResponse.json({ ok: true, deleted: false, discardedDrafts: count })
  }

  await prisma.recipeScan.delete({ where: { id: scan.id } }) // files + drafts cascade
  const blobs = await deleteFileBlobs(scan.files)
  return NextResponse.json({ ok: true, deleted: true, blobs })
}
