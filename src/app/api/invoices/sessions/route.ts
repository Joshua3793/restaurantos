import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { resolveScopedRcIds, scopedRcWhere, assertRcWritable } from '@/lib/rc-scope'

// GET /api/invoices/sessions — list all sessions
export async function GET(req: NextRequest) {
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const { searchParams } = new URL(req.url)
  const rcId      = searchParams.get('rcId')
  const isDefault = searchParams.get('isDefault') === 'true'

  const allowed = await resolveScopedRcIds(user)
  // scopedRcWhere reproduces the default-RC null-union shape and narrows to the
  // user's scope (failing closed for an out-of-scope rcId). Wrapped in AND so the
  // updateMany below can add its own status/createdAt conditions alongside it.
  const scopeWhere = scopedRcWhere(allowed, rcId, isDefault)

  // Auto-recover sessions stuck in PROCESSING for >5 min (Vercel hard-kill leaves no ERROR)
  const staleThreshold = new Date(Date.now() - 5 * 60 * 1000)
  await prisma.invoiceSession.updateMany({
    where: { AND: [scopeWhere, { status: 'PROCESSING', createdAt: { lt: staleThreshold } }] },
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
  return NextResponse.json(sessions, {
    headers: { 'Cache-Control': 'private, max-age=10, stale-while-revalidate=60' },
  })
}

// DELETE /api/invoices/sessions — bulk delete sessions by id list
// Body: { ids: string[] }
export async function DELETE(req: NextRequest) {
  const { ids } = await req.json().catch(() => ({ ids: [] as string[] }))
  if (!Array.isArray(ids) || ids.length === 0)
    return NextResponse.json({ error: 'ids array required' }, { status: 400 })

  let pricesReverted = 0

  for (const id of ids) {
    const session = await prisma.invoiceSession.findUnique({
      where: { id },
      select: {
        id: true, status: true,
        scanItems: {
          where: { action: 'UPDATE_PRICE', approved: true },
          select: {
            matchedItemId: true, previousPrice: true,
            matchedItem: { select: { id: true, baseUnit: true, pricing: true } },
          },
        },
      },
    })
    if (!session) continue

    if (session.status === 'APPROVED') {
      for (const scanItem of session.scanItems) {
        if (!scanItem.matchedItemId || scanItem.previousPrice === null || !scanItem.matchedItem) continue
        const prevPrice = Number(scanItem.previousPrice)
        // Revert the spine by rolling the `pricing` chain back to the previous
        // price (the computed pricePerBaseUnit is derived from it). The pricing
        // MODE follows the item's existing chain pricing. The pack FORMAT
        // (packChain/dimension/countUnit) is untouched — only price changed.
        const mi = scanItem.matchedItem
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const miPricing = mi.pricing as any
        const revertedPricing =
          miPricing?.mode === 'RATE'
            ? { mode: 'RATE', rate: prevPrice, rateUnit: miPricing.rateUnit || mi.baseUnit || 'each' }
            : { mode: 'PACK', purchasePrice: prevPrice }
        await prisma.inventoryItem.update({
          where: { id: scanItem.matchedItemId },
          data: {
            purchasePrice: prevPrice,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            pricing: revertedPricing as any,
          },
        })
        pricesReverted++
      }
    }

    await prisma.invoiceSession.delete({ where: { id } })
  }

  return NextResponse.json({ ok: true, deleted: ids.length, pricesReverted })
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
