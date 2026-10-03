import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { lineCountedBase, countDimsOf } from '@/lib/count-uom'
import { LARGE_VARIANCE_PCT } from '@/lib/count-constants'
import { requireSession, AuthError } from '@/lib/auth'
import { isRcInScope } from '@/lib/rc-scope'
import { seesCountMoney, redactLineMoney, redactSummaryMoney } from '@/lib/count-redact'

export const dynamic = 'force-dynamic'

// GET /api/count/sessions/:id/report
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const session = await prisma.countSession.findUnique({
    where: { id: params.id },
    include: {
      lines: {
        include: { inventoryItem: { include: { storageArea: true } } },
        orderBy: { sortOrder: 'asc' },
      },
    },
  })
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // RC scope: same read guard as GET /api/count/sessions/:id — 404 (not 403) so
  // the response doesn't confirm the row exists; a legacy unscoped session is shared.
  if (session.revenueCenterId && !(await isRcInScope(user, session.revenueCenterId))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const lines = session.lines
    .filter(l => l.countedQty !== null && !l.skipped)
    .sort((a, b) => Math.abs(Number(b.varianceCost ?? 0)) - Math.abs(Number(a.varianceCost ?? 0)))

  const totalValue = lines.reduce((s, l) => {
    const item = l.inventoryItem
    const itemDims = countDimsOf(item)
    const qtyBase = lineCountedBase(l, itemDims)
    return s + qtyBase * Number(l.priceAtCount)
  }, 0)
  const totalVarianceCost  = lines.reduce((s, l) => s + Math.abs(Number(l.varianceCost ?? 0)), 0)
  const itemsWithLargeVariance = lines.filter(l => Math.abs(Number(l.variancePct ?? 0)) > LARGE_VARIANCE_PCT).length
  // Observed lines only (this report never included blank lines); carried = the
  // "Same as last" confirmations among them, uncounted = blank lines left out.
  const itemsCounted   = lines.length
  const itemsCarried   = lines.filter(l => l.carriedForward).length
  const itemsSkipped   = session.lines.filter(l => l.skipped).length
  const itemsUncounted = session.lines.length - itemsCounted - itemsSkipped

  const money = seesCountMoney(user.role)
  const summary = { totalValue, totalVarianceCost, itemsWithLargeVariance, itemsCounted, itemsCarried, itemsSkipped, itemsUncounted }
  return NextResponse.json({
    session: {
      id: session.id, label: session.label, sessionDate: session.sessionDate,
      countedBy: session.countedBy, status: session.status, finalizedAt: session.finalizedAt,
    },
    // Below MANAGER: counts and quantities only — no $ value, price or $ variance.
    summary: money ? summary : redactSummaryMoney(summary),
    lines: lines.map(l => {
      const row = {
        id: l.id,
        itemName:    l.inventoryItem.itemName,
        category:    l.inventoryItem.category,
        location:    l.inventoryItem.storageArea?.name ?? null,
        expectedQty: Number(l.expectedQty),
        countedQty:  Number(l.countedQty),
        carriedForward: l.carriedForward,
        selectedUom: l.selectedUom,
        variancePct: Number(l.variancePct ?? 0),
        varianceCost:Number(l.varianceCost ?? 0),
        priceAtCount:Number(l.priceAtCount),
      }
      return money ? row : redactLineMoney(row)
    }),
  })
}
