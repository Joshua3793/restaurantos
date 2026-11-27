import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { scopeWhereFromParams, assertRcWritable } from '@/lib/rc-scope'
import { deleteSession, RollbackRefused, type DeleteSessionResult } from '@/lib/invoice/rollback-load'
import { UPLOAD_NEVER_FINISHED } from '@/lib/invoices/inbox-items'
import { Prisma } from '@prisma/client'

/** A client-minted session id: a canonical UUID (crypto.randomUUID shape). */
const CLIENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// The bulk DELETE below runs `deleteSession` (and its 30s-headroom rollback
// transaction, `TX_OPTIONS` in rollback-load.ts) once per id in the list — past
// the Vercel function default well before a handful of sessions are through.
export const maxDuration = 300

// GET /api/invoices/sessions — list all sessions
export async function GET(req: NextRequest) {
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const { searchParams } = new URL(req.url)

  // Wrapped in AND below so the updateMany can add its own status/createdAt
  // conditions alongside the scope fragment.
  const scopeWhere = await scopeWhereFromParams(user, searchParams, { nullable: true })

  // Auto-recover sessions stuck in PROCESSING for >5 min (Vercel hard-kill leaves no ERROR)
  const staleThreshold = new Date(Date.now() - 5 * 60 * 1000)
  await prisma.invoiceSession.updateMany({
    where: { AND: [scopeWhere, { status: 'PROCESSING', updatedAt: { lt: staleThreshold } }] },
    data: { status: 'ERROR', errorMessage: 'Processing timed out. Tap retry to try again.' },
  })

  // Same rescue for an upload that never finished. The session row is created
  // BEFORE the photos are sent, and both upload routes flip it out of UPLOADING
  // the moment a file lands — so a session still UPLOADING after 10 min holds
  // no photos at all (the upload failed, or the screen was closed mid-send).
  // Left alone it spins in the inbox forever; as ERROR it says why and can be
  // deleted from the inbox (nothing was scanned, so nothing to roll back).
  const staleUploadThreshold = new Date(Date.now() - 10 * 60 * 1000)
  await prisma.invoiceSession.updateMany({
    where: { AND: [scopeWhere, { status: 'UPLOADING', updatedAt: { lt: staleUploadThreshold } }] },
    data: { status: 'ERROR', errorMessage: UPLOAD_NEVER_FINISHED },
  })

  const sessions = await prisma.invoiceSession.findMany({
    where: { AND: [scopeWhere] },
    orderBy: { createdAt: 'desc' },
    include: {
      files: { select: { id: true, fileName: true, ocrStatus: true }, orderBy: { createdAt: 'asc' } },
      _count: { select: { scanItems: true, priceAlerts: true, recipeAlerts: true } },
    },
  })
  // no-store: this list drives the live status pills — the page polls it every
  // 3s while a session is in a transient state, and any HTTP caching here makes
  // the poll (and post-approve refetches) serve stale statuses.
  return NextResponse.json(sessions, {
    headers: { 'Cache-Control': 'no-store' },
  })
}

// DELETE /api/invoices/sessions — bulk delete sessions by id list
// Body: { ids: string[] }
//
// Each id runs the SAME `deleteSession` the single DELETE does — one
// transaction per session, so one refusal never rolls back the ids that already
// succeeded. EVERY error is caught per id, not just `RollbackRefused` — a
// transaction timeout, a Prisma error, anything — so one bad id can never abort
// the ids still queued behind it, and can never lose the results already
// committed for the ids before it. A refused id (an RC copy → 409, a missing
// session → 404, anything else → 500) is collected into `refused` and the loop
// carries on; every id ends up under `sessions` or `refused`, never dropped.
export async function DELETE(req: NextRequest) {
  // Same gate as the single-id DELETE, and stricter: bulk is always MANAGER.
  // This reverts spine prices and deletes history, and it had no auth check at
  // all until 2026-09-03.
  let user
  try { user = await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const { ids } = await req.json().catch(() => ({ ids: [] as string[] }))
  if (!Array.isArray(ids) || ids.length === 0)
    return NextResponse.json({ error: 'ids array required' }, { status: 400 })

  const sessions: Array<{ id: string } & DeleteSessionResult> = []
  const refused: Array<{ id: string; error: string; status: number }> = []

  for (const id of ids) {
    try {
      sessions.push({ id, ...(await deleteSession(id, user)) })
    } catch (e) {
      if (e instanceof RollbackRefused) {
        refused.push({ id, error: e.message, status: e.status })
      } else {
        const message = e instanceof Error ? e.message : String(e)
        console.error(`[invoice bulk-delete] session ${id} failed:`, e)
        refused.push({ id, error: message, status: 500 })
      }
    }
  }

  return NextResponse.json({ ok: true, sessions, refused })
}

// POST /api/invoices/sessions — create a new session
export async function POST(req: NextRequest) {
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const { supplierName, supplierId, revenueCenterId, id } = await req.json().catch(() => ({}))

  // Optional id the phone minted before asking (useNativeScan): a create whose
  // reply was lost is asked for again with the SAME id, so a retry finds the
  // first session instead of leaving it behind as an empty "Uploading" row.
  let clientId: string | undefined
  if (id !== undefined && id !== null) {
    if (typeof id !== 'string' || !CLIENT_ID_RE.test(id)) {
      return NextResponse.json({ error: 'id must be a UUID' }, { status: 400 })
    }
    clientId = id.toLowerCase()
    const existing = await prisma.invoiceSession.findUnique({ where: { id: clientId } })
    if (existing) return NextResponse.json(existing, { status: 200 })
  }

  // Every invoice gets an RC so it is always visible to per-RC reporting.
  // Sidebar filtering is view-only and must NOT drive the invoice's RC, so we
  // fall back to the main (default) revenue center rather than any client value
  // derived from the active filter.
  let rcId: string | null = revenueCenterId || null
  if (!rcId) {
    const defaultRc = await prisma.revenueCenter.findFirst({
      where: { isDefault: true },
      select: { id: true },
    })
    rcId = defaultRc?.id ?? null
  }

  // Guard the RC the session is created against (explicit or default fallback).
  try { await assertRcWritable(user, rcId) }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  try {
    const session = await prisma.invoiceSession.create({
      data: {
        ...(clientId ? { id: clientId } : {}),
        status: 'UPLOADING',
        supplierName: supplierName || null,
        supplierId: supplierId || null,
        revenueCenterId: rcId,
      },
    })
    return NextResponse.json(session, { status: 201 })
  } catch (e) {
    // Two copies of the same request raced (a timed-out try and its retry):
    // the loser hands back the winner's session.
    if (clientId && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const existing = await prisma.invoiceSession.findUnique({ where: { id: clientId } })
      if (existing) return NextResponse.json(existing, { status: 200 })
    }
    throw e
  }
}
