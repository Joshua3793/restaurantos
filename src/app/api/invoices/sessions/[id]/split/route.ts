import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

interface SplitGroup {
  fileIds: string[]
  supplierName?: string | null
  invoiceNumber?: string | null
  invoiceDate?: string | null
}

// POST /api/invoices/sessions/[id]/split — commit a confirmed grouping.
// Group 1 keeps this session; each further group gets a fresh session and its
// files re-pointed (move, not copy — same pattern as the RC split). Files keep
// their createdAt, so capture order — the bbox.page invariant — survives the move.
// All resulting sessions are set to PROCESSING: the client fires /process for
// each immediately, and the sweeper (updatedAt-based) can rescue a killed run.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const body = await req.json().catch(() => null)
  const groups = body?.groups as SplitGroup[] | undefined
  if (!Array.isArray(groups) || groups.length === 0 ||
      groups.some(g => !Array.isArray(g.fileIds) || g.fileIds.length === 0)) {
    return NextResponse.json({ error: 'groups must be a non-empty array of non-empty fileId lists' }, { status: 400 })
  }

  const session = await prisma.invoiceSession.findUnique({
    where: { id: params.id },
    select: { id: true, status: true, revenueCenterId: true, files: { select: { id: true } } },
  })
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  if (!['UPLOADING', 'PROCESSING', 'GROUPING'].includes(session.status)) {
    return NextResponse.json({ error: `Session is ${session.status} — cannot re-split` }, { status: 409 })
  }

  // Every file of the session in exactly one group — no strays, no dupes, no misses.
  const sessionFileIds = new Set(session.files.map(f => f.id))
  const seen = new Set<string>()
  for (const g of groups) {
    for (const fid of g.fileIds) {
      if (!sessionFileIds.has(fid)) return NextResponse.json({ error: `Unknown file: ${fid}` }, { status: 400 })
      if (seen.has(fid)) return NextResponse.json({ error: `File in two groups: ${fid}` }, { status: 400 })
      seen.add(fid)
    }
  }
  if (seen.size !== sessionFileIds.size) {
    return NextResponse.json({ error: 'Every uploaded file must be assigned to a group' }, { status: 400 })
  }

  const [first, ...rest] = groups
  const ops: Prisma.PrismaPromise<unknown>[] = []

  ops.push(prisma.invoiceSession.update({
    where: { id: session.id },
    data: {
      status: 'PROCESSING',
      supplierName: first.supplierName ?? null,
      invoiceNumber: first.invoiceNumber ?? null,
      invoiceDate: first.invoiceDate ?? null,
      errorMessage: null,
    },
  }))

  const newIds: string[] = []
  for (const g of rest) {
    const newId = randomUUID()
    newIds.push(newId)
    ops.push(prisma.invoiceSession.create({
      data: {
        id: newId,
        status: 'PROCESSING',
        revenueCenterId: session.revenueCenterId,
        supplierName: g.supplierName ?? null,
        invoiceNumber: g.invoiceNumber ?? null,
        invoiceDate: g.invoiceDate ?? null,
      },
    }))
    ops.push(prisma.invoiceFile.updateMany({
      where: { id: { in: g.fileIds }, sessionId: session.id },
      data: { sessionId: newId },
    }))
  }

  await prisma.$transaction(ops)

  return NextResponse.json({ sessionIds: [session.id, ...newIds] })
}
