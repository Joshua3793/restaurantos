import { NextRequest, NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { loadBuffer } from '@/lib/invoice-files'
import { extractRecipes } from '@/lib/recipe-scan/extract'
import { NotARecipeError, ScanTooLongError } from '@/lib/recipe-scan/parse'
import { docxToText, sheetToText } from '@/lib/recipe-scan/to-text'
import { buildDraft } from '@/lib/recipe-scan/build-draft'
import { loadDraftContext } from '@/lib/recipe-scan/context'
import { READ_ERROR, groupScanFiles } from '@/lib/recipe-scan/scan-files'
import type { ExtractedRecipe } from '@/lib/recipe-scan/types'

export const dynamic = 'force-dynamic'
// Reading a cookbook chapter or a long PDF can take minutes (as invoice OCR).
export const maxDuration = 300

class Skip extends Error {}

// POST /api/recipe-scans/[id]/process — read the files with Claude and write
// one draft per recipe found. The browser fires this (without waiting) right
// after POST /api/recipe-scans, and again as the Reading list's Retry on a scan
// that couldn't be read.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const scan = await prisma.recipeScan.findUnique({
    where: { id: params.id },
    select: {
      id: true, status: true, revenueCenterId: true,
      files: { select: { fileName: true, fileType: true, fileUrl: true }, orderBy: { sortOrder: 'asc' } },
    },
  })
  if (!scan) return NextResponse.json({ error: 'Scan not found' }, { status: 404 })

  if (scan.status === 'ERROR') {
    // Retry: claim it so two taps start one read.
    const claim = await prisma.recipeScan.updateMany({
      where: { id: scan.id, status: 'ERROR' },
      data: { status: 'READING', error: null },
    })
    if (claim.count === 0) return NextResponse.json({ error: 'Already reading' }, { status: 409 })
  } else if (scan.status !== 'READING') {
    return NextResponse.json({ error: 'This scan has already been read' }, { status: 409 })
  }

  const fail = async (error: string) => {
    await prisma.recipeScan.updateMany({
      where: { id: scan.id, status: 'READING' },
      data: { status: 'ERROR', error },
    })
  }

  try {
    const recipes: ExtractedRecipe[] = []
    for (const group of groupScanFiles(scan.files)) {
      const bufs = await Promise.all(group.files.map(f => loadBuffer(f)))
      const src =
        group.kind === 'image' ? { images: bufs }
        : group.kind === 'pdf' ? { pdf: bufs[0] }
        : group.kind === 'docx' ? { text: await docxToText(bufs[0]) }
        : { text: sheetToText(bufs[0]) }
      try {
        recipes.push(...await extractRecipes(src))
      } catch (e) {
        // One file with no recipe in it doesn't sink the others.
        if (e instanceof NotARecipeError) continue
        throw e
      }
    }
    if (recipes.length === 0) throw new NotARecipeError()

    const names = recipes.map(r => r.name)
    const ctx = await loadDraftContext({ revenueCenterId: scan.revenueCenterId, siblingTitles: names })
    const drafts = recipes.map((r, i) => buildDraft(r, {
      ...ctx,
      // Every OTHER recipe in this scan is a sibling the page may refer to.
      siblingTitles: names.filter((_, j) => j !== i),
    }))

    await prisma.$transaction(async tx => {
      const done = await tx.recipeScan.updateMany({
        where: { id: scan.id, status: 'READING' },
        data: { status: 'READY', error: null },
      })
      // Timed out to ERROR (or read by a retry) meanwhile: leave that alone.
      if (done.count === 0) throw new Skip()
      await tx.recipeScanDraft.createMany({
        data: drafts.map((d, i) => ({
          scanId: scan.id,
          index: i,
          title: d.name,
          data: d as unknown as Prisma.InputJsonValue,
        })),
      })
    })

    return NextResponse.json({ ok: true, drafts: drafts.length })
  } catch (e) {
    if (e instanceof Skip) return NextResponse.json({ error: 'Scan changed while reading' }, { status: 409 })
    if (e instanceof ScanTooLongError) {
      await fail(e.message)
    } else {
      if (!(e instanceof NotARecipeError)) console.error(`[recipe-scan] process ${scan.id} failed`, e)
      await fail(READ_ERROR)
    }
    return NextResponse.json({ ok: false }, { status: 200 })
  }
}
