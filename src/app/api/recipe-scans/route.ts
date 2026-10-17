import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import {
  MAX_SCAN_FILES, STUCK_AFTER_MS, STUCK_ERROR, fileKind, isAllowedScanUrl,
} from '@/lib/recipe-scan/scan-files'

export const dynamic = 'force-dynamic'

// GET /api/recipe-scans — the manager's own scans still in play (reading,
// couldn't read, or with a draft not yet saved/discarded), newest first, with
// a summary of each draft for the Reading list.
export async function GET() {
  let user
  try { user = await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  // A serverless kill mid-read leaves READING forever — turn it into a retry.
  await prisma.recipeScan.updateMany({
    where: { createdById: user.id, status: 'READING', updatedAt: { lt: new Date(Date.now() - STUCK_AFTER_MS) } },
    data: { status: 'ERROR', error: STUCK_ERROR },
  })

  const scans = await prisma.recipeScan.findMany({
    where: {
      createdById: user.id,
      OR: [
        { status: { in: ['UPLOADING', 'READING', 'ERROR'] } },
        { drafts: { some: { status: 'OPEN' } } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, status: true, error: true, revenueCenterId: true, createdAt: true, updatedAt: true,
      files: { select: { id: true, fileName: true, fileType: true }, orderBy: { sortOrder: 'asc' } },
      drafts: {
        select: { id: true, index: true, title: true, status: true, savedRecipeId: true },
        orderBy: { index: 'asc' },
      },
    },
  })
  return NextResponse.json(scans, { headers: { 'Cache-Control': 'no-store' } })
}

// POST /api/recipe-scans { files: {url,fileName,fileType}[], revenueCenterId }
// Creates the scan as READING and starts the read in the background.
export async function POST(req: NextRequest) {
  let user
  try { user = await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const body = await req.json().catch(() => null)
  const files: unknown = body?.files
  const revenueCenterId: string | null = typeof body?.revenueCenterId === 'string' && body.revenueCenterId
    ? body.revenueCenterId : null

  if (!Array.isArray(files) || files.length === 0) {
    return NextResponse.json({ error: 'Add a photo or file to scan.' }, { status: 400 })
  }
  if (files.length > MAX_SCAN_FILES) {
    return NextResponse.json({ error: `Up to ${MAX_SCAN_FILES} files per scan.` }, { status: 400 })
  }
  const clean: { fileUrl: string; fileName: string; fileType: string }[] = []
  for (const f of files) {
    const fileName = typeof f?.fileName === 'string' ? f.fileName.slice(0, 255) : ''
    const fileType = typeof f?.fileType === 'string' ? f.fileType.slice(0, 255) : ''
    if (!isAllowedScanUrl(f?.url)) return NextResponse.json({ error: 'File was not uploaded here.' }, { status: 400 })
    if (!fileKind(fileType, fileName)) {
      return NextResponse.json({ error: `${fileName || 'A file'} is not a photo, PDF, Word or Excel file.` }, { status: 400 })
    }
    clean.push({ fileUrl: f.url, fileName: fileName || 'file', fileType })
  }

  if (revenueCenterId) {
    try { await assertRcWritable(user, revenueCenterId) }
    catch (e) {
      if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
      throw e
    }
  }

  const scan = await prisma.recipeScan.create({
    data: {
      status: 'READING',
      createdById: user.id,
      revenueCenterId,
      files: { create: clean.map((f, i) => ({ ...f, sortOrder: i })) },
    },
    select: { id: true, status: true },
  })

  // Fire the read without waiting for it (as invoices do). waitUntil keeps this
  // function alive long enough for the request to go out; the read itself runs
  // in its own invocation (maxDuration 300). The manager's cookies go with it so
  // the process route's own MANAGER guard passes.
  const processUrl = new URL(`/api/recipe-scans/${scan.id}/process`, req.url)
  waitUntil(
    fetch(processUrl, {
      method: 'POST',
      headers: { cookie: req.headers.get('cookie') ?? '' },
    }).then(r => {
      if (!r.ok) console.error(`[recipe-scan] process ${scan.id} answered ${r.status}`)
    }).catch(e => console.error(`[recipe-scan] process ${scan.id} did not start`, e)),
  )

  return NextResponse.json(scan, { status: 201 })
}
