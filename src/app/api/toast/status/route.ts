import { NextResponse } from 'next/server'
import { requireSession, AuthError } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

/**
 * GET /api/toast/status — last sync state for the setup page (ToastConnection +
 * most recent ToastSyncLog). ADMIN-only. No live Toast calls.
 */
export async function GET() {
  try {
    await requireSession('ADMIN')
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const [conn, lastLog] = await Promise.all([
    prisma.toastConnection.findUnique({ where: { id: 'singleton' } }),
    prisma.toastSyncLog.findFirst({ orderBy: { createdAt: 'desc' } }),
  ])

  return NextResponse.json({
    status: conn?.status ?? 'disconnected',
    lastSyncedAt: conn?.lastSyncedAt ?? null,
    lastError: conn?.lastError ?? null,
    lastLog: lastLog
      ? {
          businessDate: lastLog.windowStart,
          ordersPulled: lastLog.ordersPulled,
          lineItemsWritten: lastLog.lineItemsWritten,
          unmatchedCount: lastLog.unmatchedCount,
          status: lastLog.status,
          createdAt: lastLog.createdAt,
        }
      : null,
  })
}
