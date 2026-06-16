import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { PRICING_SELECT, asChainItem, pricePerBaseUnit } from '@/lib/item-model'

export const dynamic = 'force-dynamic'

/**
 * GET /api/insights/spine-audit
 *
 * Powers the click-through audit drawer on the cost-chrome strip.
 * The "spine" is `InventoryItem.pricePerBaseUnit` — every cost in the
 * app traces back to it. This endpoint surfaces:
 *
 * - Top 10 items by inventory value (driving the on-hand total)
 * - Last 5 invoice approvals (the most common writer)
 * - Latest PREP sync activity (recipe-derived writer)
 * - Items with stale or missing prices (data-quality nudges)
 */
export async function GET(_req: NextRequest) {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const [items, recentInvoices, stalePrepd] = await Promise.all([
    prisma.inventoryItem.findMany({
      where: { isActive: true, isStocked: true },
      select: {
        id: true,
        itemName: true,
        category: true,
        stockOnHand: true,
        lastUpdated: true,
        supplier: { select: { name: true } },
        ...PRICING_SELECT,
      },
    }),
    prisma.invoiceSession.findMany({
      where: { approvedAt: { not: null } },
      orderBy: { approvedAt: 'desc' },
      take: 5,
      select: {
        id: true,
        supplierName: true,
        invoiceNumber: true,
        approvedAt: true,
        total: true,
        scanItems: { where: { approved: true }, select: { id: true } },
      },
    }),
    prisma.recipe.findMany({
      where: { type: 'PREP', inventoryItemId: { not: null }, isActive: true },
      orderBy: { updatedAt: 'desc' },
      take: 5,
      select: {
        id: true,
        name: true,
        updatedAt: true,
        inventoryItem: {
          select: { id: true, itemName: true, lastUpdated: true, ...PRICING_SELECT },
        },
      },
    }),
  ])

  // Top by inventory value
  const ranked = items.map(it => {
    const ppb = pricePerBaseUnit(asChainItem(it))
    return {
      id: it.id,
      name: it.itemName,
      category: it.category,
      baseUnit: it.baseUnit,
      pricePerBaseUnit: ppb,
      stockOnHand: Number(it.stockOnHand),
      inventoryValue: Number(it.stockOnHand) * ppb,
      supplier: it.supplier?.name ?? null,
      lastUpdated: it.lastUpdated,
    }
  })
  ranked.sort((a, b) => b.inventoryValue - a.inventoryValue)

  const totalValue = ranked.reduce((s, it) => s + it.inventoryValue, 0)
  const zeroPriceCount = ranked.filter(it => it.pricePerBaseUnit === 0).length
  const staleCutoff = new Date(); staleCutoff.setDate(staleCutoff.getDate() - 30)
  const staleCount = ranked.filter(it => it.lastUpdated && new Date(it.lastUpdated) < staleCutoff).length

  return NextResponse.json({
    summary: {
      totalItems: items.length,
      totalValue,
      zeroPriceCount,
      staleCount,
    },
    topItems: ranked.slice(0, 10),
    recentInvoices: recentInvoices.map(inv => ({
      id: inv.id,
      supplier: inv.supplierName,
      invoiceNumber: inv.invoiceNumber,
      approvedAt: inv.approvedAt,
      total: inv.total !== null ? Number(inv.total) : null,
      lineCount: inv.scanItems.length,
    })),
    recentPrepSyncs: stalePrepd
      .filter(r => r.inventoryItem !== null)
      .map(r => ({
        id: r.inventoryItem!.id,
        itemName: r.inventoryItem!.itemName,
        recipeId: r.id,
        recipeName: r.name,
        pricePerBaseUnit: pricePerBaseUnit(asChainItem(r.inventoryItem!)),
        lastUpdated: r.inventoryItem!.lastUpdated,
      })),
  }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
