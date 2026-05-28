import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * GET /api/invoices/exceptions
 *
 * Powers the Inbox / Exceptions tab. Returns two queues:
 *
 *  - unmatched: invoice scan items in a REVIEW session that haven't been
 *    matched to an inventory item (matchedItemId is null). Each row links
 *    back to its session for resolution.
 *
 *  - duplicates: sessions whose (supplier + invoiceNumber + invoiceDate)
 *    appears more than once. Returns one row per group, surfacing the
 *    duplicate sessionIds.
 */
export async function GET(_req: NextRequest) {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const [unmatched, recentSessions] = await Promise.all([
    prisma.invoiceScanItem.findMany({
      where: {
        matchedItemId: null,
        session: { status: 'REVIEW' },
      },
      take: 50,
      select: {
        id: true,
        rawDescription: true,
        rawUnit: true,
        rawLineTotal: true,
        session: {
          select: { id: true, supplierName: true, invoiceNumber: true, invoiceDate: true, createdAt: true },
        },
      },
    }),
    prisma.invoiceSession.findMany({
      where: { invoiceNumber: { not: null }, supplierName: { not: null } },
      select: { id: true, supplierName: true, invoiceNumber: true, invoiceDate: true, total: true, status: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
  ])

  // Group by (supplier|number|date) to find dupes
  const groups = new Map<string, typeof recentSessions>()
  for (const s of recentSessions) {
    if (!s.supplierName || !s.invoiceNumber) continue
    const k = `${s.supplierName.toLowerCase()}|${s.invoiceNumber}|${(s.invoiceDate ?? '').toString().slice(0, 10)}`
    const arr = groups.get(k) ?? []
    arr.push(s)
    groups.set(k, arr)
  }
  const duplicates = Array.from(groups.values())
    .filter(g => g.length > 1)
    .map(g => ({
      supplierName: g[0].supplierName,
      invoiceNumber: g[0].invoiceNumber,
      invoiceDate: g[0].invoiceDate,
      sessions: g.map(s => ({
        id: s.id,
        status: s.status,
        total: s.total !== null ? Number(s.total) : null,
        createdAt: s.createdAt,
      })),
    }))

  return NextResponse.json({
    unmatched: unmatched.map(u => ({
      id: u.id,
      rawItemName: u.rawDescription,
      rawSize: u.rawUnit,
      rawLineTotal: u.rawLineTotal !== null ? Number(u.rawLineTotal) : null,
      createdAt: u.session.createdAt,
      session: {
        id: u.session.id,
        supplierName: u.session.supplierName,
        invoiceNumber: u.session.invoiceNumber,
        invoiceDate: u.session.invoiceDate,
      },
    })),
    duplicates,
    totalCount: unmatched.length + duplicates.length,
  }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
