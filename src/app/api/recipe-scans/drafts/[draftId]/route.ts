import { NextRequest, NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { rematchDraft } from '@/lib/recipe-scan/build-draft'
import { draftCosts, loadDraftContext, type ScanCandidate } from '@/lib/recipe-scan/context'
import { isDraftData } from '@/lib/recipe-scan/save-rules'
import type { DraftData } from '@/lib/recipe-scan/types'

export const dynamic = 'force-dynamic'

const DRAFT_SELECT = {
  id: true, scanId: true, index: true, title: true, status: true, savedRecipeId: true, updatedAt: true, data: true,
  scan: {
    select: {
      id: true, status: true, revenueCenterId: true,
      files: { select: { id: true, fileName: true, fileType: true, fileUrl: true }, orderBy: { sortOrder: 'asc' } },
      drafts: { select: { id: true, index: true, title: true, status: true }, orderBy: { index: 'asc' } },
    },
  },
} as const

async function guard(): Promise<NextResponse | null> {
  try { await requireSession('MANAGER'); return null }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
}

// GET /api/recipe-scans/drafts/[draftId] — the draft to review, re-matched on
// load (stale links dropped, a sibling saved since gets linked), with live
// line costs, the scan's files for the original viewer, what each linked
// item/prep is (`links`, keyed `kind:id`: its unit, how it's bought) and the
// PREP recipe names already taken (`existingNames`, for the Save blockers).
export async function GET(_req: NextRequest, { params }: { params: { draftId: string } }) {
  const denied = await guard()
  if (denied) return denied

  const draft = await prisma.recipeScanDraft.findUnique({ where: { id: params.draftId }, select: DRAFT_SELECT })
  if (!draft) return NextResponse.json({ error: 'Draft not found' }, { status: 404 })
  if (!isDraftData(draft.data)) return NextResponse.json({ error: 'This draft is damaged — scan the recipe again.' }, { status: 500 })

  let data: DraftData = draft.data
  const links: Record<string, { baseUnit: string | null; boughtAs: string; supplier: string | null; amount: ScanCandidate['amount'] }> = {}
  let existingNames: string[] = []
  if (draft.status === 'OPEN') {
    const ctx = await loadDraftContext({
      revenueCenterId: draft.scan.revenueCenterId,
      siblingTitles: draft.scan.drafts.filter(d => d.id !== draft.id).map(d => d.title),
    })
    const next = rematchDraft(data, ctx)
    if (JSON.stringify(next) !== JSON.stringify(data)) {
      data = next
      await prisma.recipeScanDraft.updateMany({
        where: { id: draft.id, status: 'OPEN' },
        data: { data: next as unknown as Prisma.InputJsonValue },
      })
    }
    const byKey = new Map((ctx.candidates as ScanCandidate[]).map(c => [`${c.kind}:${c.id}`, c]))
    for (const l of data.lines) {
      if (!l.link) continue
      const c = byKey.get(`${l.link.kind}:${l.link.id}`)
      if (c) links[`${c.kind}:${c.id}`] = { baseUnit: c.baseUnit, boughtAs: c.boughtAs, supplier: c.supplier, amount: c.amount }
    }
    existingNames = (await prisma.recipe.findMany({ where: { type: 'PREP' }, select: { name: true } })).map(r => r.name)
  }

  const costs = await draftCosts(data)
  return NextResponse.json(
    { ...draft, data, costs, links, existingNames },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

// PATCH /api/recipe-scans/drafts/[draftId] { data: DraftData } — autosave from
// the review screen. Only an OPEN draft can change.
export async function PATCH(req: NextRequest, { params }: { params: { draftId: string } }) {
  const denied = await guard()
  if (denied) return denied

  const body = await req.json().catch(() => null)
  const data = body?.data
  if (!isDraftData(data)) return NextResponse.json({ error: 'Invalid draft' }, { status: 400 })

  const { count } = await prisma.recipeScanDraft.updateMany({
    where: { id: params.draftId, status: 'OPEN' },
    data: {
      data: data as unknown as Prisma.InputJsonValue,
      title: data.name.trim() || 'Untitled recipe',
    },
  })
  if (count === 0) {
    const exists = await prisma.recipeScanDraft.findUnique({ where: { id: params.draftId }, select: { status: true } })
    if (!exists) return NextResponse.json({ error: 'Draft not found' }, { status: 404 })
    return NextResponse.json({ error: 'This draft is already saved or discarded.' }, { status: 409 })
  }

  const draft = await prisma.recipeScanDraft.findUnique({ where: { id: params.draftId }, select: DRAFT_SELECT })
  const costs = await draftCosts(data)
  return NextResponse.json({ ...draft, data, costs }, { headers: { 'Cache-Control': 'no-store' } })
}

// DELETE /api/recipe-scans/drafts/[draftId] — discard ONE recipe of the scan;
// the others are untouched.
export async function DELETE(_req: NextRequest, { params }: { params: { draftId: string } }) {
  const denied = await guard()
  if (denied) return denied

  const { count } = await prisma.recipeScanDraft.updateMany({
    where: { id: params.draftId, status: 'OPEN' },
    data: { status: 'DISCARDED' },
  })
  if (count === 0) {
    const exists = await prisma.recipeScanDraft.findUnique({ where: { id: params.draftId }, select: { status: true } })
    if (!exists) return NextResponse.json({ error: 'Draft not found' }, { status: 404 })
    return NextResponse.json({ error: 'This draft is already saved or discarded.' }, { status: 409 })
  }
  return NextResponse.json({ ok: true })
}
