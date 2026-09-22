import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { scopeWhereFromParams, assertRcWritable } from '@/lib/rc-scope'
import { deleteSession, RollbackRefused, type DeleteSessionResult } from '@/lib/invoice/rollback-load'

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

  const { supplierName, supplierId, revenueCenterId } = await req.json().catch(() => ({}))

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

  const session = await prisma.invoiceSession.create({
    data: {
      status: 'UPLOADING',
      supplierName: supplierName || null,
      supplierId: supplierId || null,
      revenueCenterId: rcId,
    },
  })

  return NextResponse.json(session, { status: 201 })
}
