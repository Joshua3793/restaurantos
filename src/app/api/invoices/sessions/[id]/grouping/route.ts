import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { parseDraft, reconcileDraft } from '@/lib/invoice-grouping-draft'

export const dynamic = 'force-dynamic'

// PUT /api/invoices/sessions/[id]/grouping — save the sorter's draft.
// The sorter calls this after every edit (move, discard, restore, corrected
// number, "scan as one"), so closing the screen never loses work. The body is
// the whole draft; it is validated against the session's files (unknown or
// duplicated ids are rejected) and reconciled before it is stored.
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const session = await prisma.invoiceSession.findUnique({
    where: { id: params.id },
    select: { id: true, status: true, files: { select: { id: true }, orderBy: { createdAt: 'asc' } } },
  })
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  if (session.status !== 'GROUPING') {
    return NextResponse.json(
      { error: `Session is ${session.status} — the grouping draft can only change while the batch is unsorted` },
      { status: 409 },
    )
  }

  const body = await req.json().catch(() => null)
  const fileIds = session.files.map(f => f.id)
  const parsed = parseDraft(body, fileIds)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const draft = reconcileDraft(parsed.draft, fileIds)

  await prisma.invoiceSession.update({
    where: { id: session.id },
    data: { groupingDraft: draft as unknown as Prisma.InputJsonValue },
  })
  return NextResponse.json({ ok: true, draft })
}
