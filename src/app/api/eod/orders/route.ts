import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { getTheoreticalStockMap } from '@/lib/count-expected'
import { PRICING_SELECT, asChainItem, basePerPurchase } from '@/lib/item-model'
import { convertBaseToCountUom } from '@/lib/count-uom'

export const dynamic = 'force-dynamic'

// GET /api/eod/orders?rcId=
//
// Below-par "order suggestions" grouped by supplier, for a specific revenue
// center. Replicates the Order Guide logic in src/app/inventory/page.tsx
// (orderItems/belowPar/suggestedQty/bySupplier) server-side, read-only.
//
// Par/reorder are only meaningful for a SPECIFIC RC (they live on that RC's
// StockAllocation row — src/app/api/inventory/route.ts never attaches them
// for the "All Revenue Centers" view), so rcId is required here.
export async function GET(req: NextRequest) {
  try { await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const { searchParams } = new URL(req.url)
  const rcId = searchParams.get('rcId') || ''
  if (!rcId) {
    return NextResponse.json(
      { error: 'rcId is required — par/reorder levels are per revenue-center' },
      { status: 400 },
    )
  }

  const rc = await prisma.revenueCenter.findUnique({ where: { id: rcId }, select: { id: true, isDefault: true } })
  if (!rc) {
    return NextResponse.json({ error: 'Revenue center not found' }, { status: 404 })
  }

  // Non-PREP: an inventory item with a linked Recipe is a synced PREP item
  // (see syncPrepToInventory) — exclude those, mirroring the Order Guide's
  // `category !== 'PREPD'` filter but via the actual relation (the FK lives
  // on Recipe.inventoryItemId, so InventoryItem.recipe: null is the filter).
  const itemInclude = {
    id: true,
    supplier: { select: { id: true, name: true } },
    ...PRICING_SELECT,
    purchasePrice: true,
    stockOnHand: true,
    countUnit: true,
    supplierId: true,
    itemName: true,
    recipe: { select: { id: true } },
  } as const

  let rows: Array<{
    id: string
    itemName: string
    supplierId: string | null
    supplier: { id: string; name: string } | null
    dimension: string
    baseUnit: string
    packChain: unknown
    pricing: unknown
    countUnit: string
    purchasePrice: unknown
    stockOnHand: unknown
    recipe: { id: string } | null
    rcQuantity: number
    parLevel: number | null
    reorderQty: number | null
  }>

  if (rc.isDefault) {
    // Default RC: stockOnHand IS this RC's pool (mirrors /api/inventory's
    // "Default RC (Cafe)" branch). Par/reorder still come from this RC's
    // StockAllocation row (may not exist for every item).
    const [items, allocations] = await Promise.all([
      prisma.inventoryItem.findMany({
        where: { isActive: true, isStocked: true, recipe: null },
        select: itemInclude,
      }),
      prisma.stockAllocation.findMany({
        where: { revenueCenterId: rcId },
        select: { inventoryItemId: true, parLevel: true, reorderQty: true },
      }),
    ])
    const allocByItemId = Object.fromEntries(allocations.map(a => [a.inventoryItemId, a]))
    rows = items.map(i => {
      const alloc = allocByItemId[i.id]
      return {
        ...i,
        rcQuantity: Number(i.stockOnHand),
        parLevel: alloc?.parLevel != null ? Number(alloc.parLevel) : null,
        reorderQty: alloc?.reorderQty != null ? Number(alloc.reorderQty) : null,
      }
    })
  } else {
    // Non-default RC: on-hand + par/reorder come from this RC's StockAllocation
    // row (mirrors /api/inventory's "Non-default RC" branch) — only items
    // allocated to this RC are in scope.
    const allocations = await prisma.stockAllocation.findMany({
      where: {
        revenueCenterId: rcId,
        inventoryItem: { isActive: true, isStocked: true, recipe: null },
      },
      include: { inventoryItem: { select: itemInclude } },
    })
    rows = allocations
      .map(a => ({
        ...a.inventoryItem,
        rcQuantity: Number(a.quantity),
        parLevel: a.parLevel != null ? Number(a.parLevel) : null,
        reorderQty: a.reorderQty != null ? Number(a.reorderQty) : null,
      }))
  }

  // Theoretical stock (engine-computed from count + sales/purchases/wastage/prep)
  // is the "effective" on-hand, same precedence as the inventory page's
  // effStock: theoretical ?? raw RC quantity.
  const itemIds = rows.map(r => r.id)
  const theoMap = await getTheoreticalStockMap(rcId, itemIds)

  type Line = {
    id: string; name: string; onHand: number; par: number; unit: string
    suggestedQty: number; unitPrice: number; lineCost: number
  }
  const bySupplier = new Map<string, { supplierId: string | null; supplierName: string; lines: Line[] }>()

  for (const row of rows) {
    if (row.parLevel == null) continue // skip items with no par set

    const ci = asChainItem({
      dimension: row.dimension,
      baseUnit: row.baseUnit,
      packChain: row.packChain,
      pricing: row.pricing,
      countUnit: row.countUnit,
    })
    const countUnit = row.countUnit || row.baseUnit
    // Item facts in the exact shape convertBaseToCountUom/displayStock expects.
    const dims = {
      dimension: row.dimension,
      baseUnit: row.baseUnit,
      packChain: row.packChain,
      countUnit,
    }

    // On-hand in COUNT/DISPLAY units, replicating inventory/page.tsx's
    // `displayStock(i)` = convertBaseToCountUom(effStock(i), countUnit, dims).
    // parLevel/reorderQty are ALSO stored in count units, so both sides of the
    // below-par comparison are in the same unit. Crucially this uses
    // convertBaseToCountUom (resolveUnitBase) — which returns 1 for a COUNT
    // item whose baseUnit is "each" — NOT basePerUnit, which would divide by
    // the leaf-pack `per` and understate on-hand by that factor.
    const effStockBase = theoMap.has(row.id) ? theoMap.get(row.id)! : row.rcQuantity
    const onHandCount = convertBaseToCountUom(effStockBase, countUnit, dims)

    if (!(onHandCount < row.parLevel)) continue // not below par

    // countPerPurchase = count units in ONE purchase (top-of-chain) unit,
    // = convertBaseToCountUom(basePerPurchase(chain), countUnit) — same
    // conversion, applied to the base units contained in one purchase unit.
    const basePerPurchaseUnits = basePerPurchase(ci.packChain)
    const countPerPurchase = convertBaseToCountUom(basePerPurchaseUnits, countUnit, dims) || 1

    // suggestedQty is expressed in PURCHASE units (matches the Order Guide).
    // reorderQty, when set, is already a purchase-unit qty; otherwise convert
    // the count-unit shortfall (par - onHand) to purchase units and ceil.
    const suggestedQty = row.reorderQty != null
      ? Number(row.reorderQty)
      : Math.ceil((row.parLevel - onHandCount) / countPerPurchase)
    const unitPrice = Number(row.purchasePrice) // price per purchase (top-of-chain) unit

    const line: Line = {
      id: row.id,
      name: row.itemName,
      onHand: onHandCount,   // count units
      par: row.parLevel,     // count units
      unit: countUnit,       // count unit — for the "on hand X / par Y {unit}" display
      suggestedQty,          // purchase units
      unitPrice,             // per purchase unit
      lineCost: suggestedQty * unitPrice,
    }

    const key = row.supplierId ?? '__none__'
    const name = row.supplier?.name ?? 'No Supplier'
    if (!bySupplier.has(key)) bySupplier.set(key, { supplierId: row.supplierId ?? null, supplierName: name, lines: [] })
    bySupplier.get(key)!.lines.push(line)
  }

  const suppliers = Array.from(bySupplier.values())
    .map(g => ({ ...g, subtotal: g.lines.reduce((s, l) => s + l.lineCost, 0) }))
    .sort((a, b) => a.supplierName.localeCompare(b.supplierName))

  const lineCount = suppliers.reduce((s, g) => s + g.lines.length, 0)
  const total = suppliers.reduce((s, g) => s + g.subtotal, 0)

  return NextResponse.json(
    { rcId, suppliers, lineCount, total },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
