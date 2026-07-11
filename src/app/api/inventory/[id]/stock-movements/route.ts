import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { convertQty } from '@/lib/uom'
import { convertBaseToCountUom, resolveCountUom } from '@/lib/count-uom'
import { computeScale } from '@/lib/prep-utils'
import { asChainItem, basePerUnit } from '@/lib/item-model'
import { parseInvoiceDate } from '@/lib/purchase-date'

export type MovementType = 'SALE' | 'WASTAGE' | 'PREP_IN' | 'PREP_OUT' | 'PURCHASE' | 'TRANSFER'

export interface StockMovement {
  id: string
  date: string
  type: MovementType
  qty: number   // in displayUnit, negative = deduction, positive = addition
  unit: string
  description: string
  revenueCenterId?: string | null   // present on PURCHASE rows; which RC the purchase was attributed to
}

export interface StockMovementsResponse {
  lastCount: { qty: number; unit: string; date: string | null }
  theoretical: { qty: number; unit: string }
  movements: StockMovement[]
}

// GET /api/inventory/[id]/stock-movements
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const item = await prisma.inventoryItem.findUnique({
    where: { id: params.id },
    select: {
      id: true, baseUnit: true,
      stockOnHand: true, lastCountDate: true, lastCountQty: true,
      dimension: true, packChain: true, countUnit: true, pricing: true,
    },
  })
  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const nonNullItem = item

  // lastCountQty is the physically verified quantity — use as baseline.
  // Fall back to stockOnHand if item has never been formally counted.
  const baseQty = nonNullItem.lastCountQty != null ? Number(nonNullItem.lastCountQty) : Number(nonNullItem.stockOnHand)
  // Look back 90 days if never formally counted
  const since: Date = nonNullItem.lastCountDate ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)

  // Resolve the display unit exactly like the drawer header does: a stored
  // countUOM that is no longer valid for the item's purchase structure (e.g.
  // a stale "each" on a by-weight item) falls back to the first valid unit.
  // Using the raw value here made the stock section read "each" while the rest
  // of the panel read "KG".
  const dimsBase = {
    dimension: nonNullItem.dimension,
    baseUnit:  nonNullItem.baseUnit,
    packChain: nonNullItem.packChain,
  }
  const displayUnit = resolveCountUom({ ...dimsBase, countUnit: nonNullItem.countUnit ?? nonNullItem.baseUnit })

  function toDisplay(qtyInBase: number): number {
    return convertBaseToCountUom(qtyInBase, displayUnit, dimsBase)
  }

  const raw: Array<{ id: string; date: Date; type: MovementType; qtyBase: number; description: string; revenueCenterId?: string | null }> = []

  // ── WASTAGE ────────────────────────────────────────────────────────────────
  const wastageLogs = await prisma.wastageLog.findMany({
    where: { inventoryItemId: params.id, date: { gte: since } },
    orderBy: { date: 'desc' },
  })
  for (const w of wastageLogs) {
    const qtyBase = convertQty(Number(w.qtyWasted), w.unit, nonNullItem.baseUnit)
    raw.push({
      id: w.id, date: w.date, type: 'WASTAGE', qtyBase: -qtyBase,
      description: w.reason && w.reason !== 'UNKNOWN' ? w.reason : 'Wastage',
    })
  }

  // ── PURCHASES (from approved invoice sessions) ────────────────────────────
  // A purchase belongs to the day the goods were RECEIVED (the invoice's own date),
  // not the day the session was approved — matching the theoretical-stock model in
  // count-expected.ts (buildPurchaseMap). The DB filter is a superset (either date
  // in-window); the real inclusion + display date use the resolved received date
  // below, so a pre-count invoice keyed in after the count drops out of the list
  // (it's already in the counted baseline) instead of inflating theoretical stock.
  const scanItems = await prisma.invoiceScanItem.findMany({
    where: {
      matchedItemId: params.id,
      approved: true,
      // CREATE_NEW = the invoice that created the item also received its first stock.
      action: { in: ['UPDATE_PRICE', 'ADD_SUPPLIER', 'CREATE_NEW'] },
      session: { status: 'APPROVED', OR: [{ approvedAt: { gte: since } }, { purchaseDate: { gte: since } }] },
      rawQty: { not: null },
      splitToSessionId: null,
    },
    include: {
      session: { select: { supplierName: true, invoiceDate: true, invoiceNumber: true, approvedAt: true, purchaseDate: true, revenueCenterId: true } },
    },
  })
  for (const si of scanItems) {
    const qty = Number(si.rawQty ?? 0)
    if (qty <= 0) continue
    // Received date: resolved purchaseDate → raw invoiceDate string → approvedAt.
    const receivedDate = si.session.purchaseDate ?? parseInvoiceDate(si.session.invoiceDate) ?? si.session.approvedAt ?? new Date()
    // Skip anything received on/before the count baseline — it's already counted.
    if (receivedDate < since) continue
    let baseUnits: number
    const packQty  = si.invoicePackQty  ? Number(si.invoicePackQty)  : 0
    const packSize = si.invoicePackSize ? Number(si.invoicePackSize) : 0
    const packUOM  = si.invoicePackUOM ?? null
    if (packQty > 0 && packSize > 0 && packUOM) {
      baseUnits = convertQty(qty * packQty * packSize, packUOM, nonNullItem.baseUnit)
    } else {
      // Fall back to the item's own pack CHAIN: base units received =
      // qtyShipped × the chain's top-level base content (levelBaseUnits[top]).
      const ci = asChainItem(nonNullItem)
      const top = ci.packChain[0]?.unit
      baseUnits = qty * (top ? basePerUnit(ci, top) : 1)
    }
    const supplier = si.session.supplierName ?? 'Purchase'
    const invNum   = si.session.invoiceNumber ? ` · #${si.session.invoiceNumber}` : ''
    raw.push({ id: si.id, date: receivedDate, type: 'PURCHASE', qtyBase: baseUnits, description: `${supplier}${invNum}`, revenueCenterId: si.session.revenueCenterId ?? null })
  }

  // ── SALES consumption ─────────────────────────────────────────────────────
  // Find all recipes that use this item as a direct ingredient
  const recipeIngredients = await prisma.recipeIngredient.findMany({
    where: { inventoryItemId: params.id },
    include: {
      recipe: {
        include: {
          saleLineItems: {
            where: { sale: { date: { gte: since } } },
            include: { sale: { select: { id: true, date: true } } },
          },
        },
      },
    },
  })
  for (const ri of recipeIngredients) {
    const recipe = ri.recipe
    const portionsPerBatch = recipe.portionSize && Number(recipe.portionSize) > 0
      ? Number(recipe.baseYieldQty) / Number(recipe.portionSize)
      : 1
    for (const li of recipe.saleLineItems) {
      const batches  = li.qtySold / portionsPerBatch
      const consumed = convertQty(Number(ri.qtyBase) * batches, ri.unit, nonNullItem.baseUnit)
      raw.push({
        id: `sale-${li.saleId}-${ri.id}`,
        date: li.sale.date, type: 'SALE', qtyBase: -consumed,
        description: `${recipe.name} × ${li.qtySold}`,
      })
    }
  }

  // ── PREP: this item used as ingredient (deduction) ────────────────────────
  const prepIngredientRows = await prisma.recipeIngredient.findMany({
    where: { inventoryItemId: params.id },
    include: {
      recipe: {
        include: {
          prepItems: {
            include: {
              logs: {
                // NOTE: do NOT filter on inventoryAdjusted — the theoretical-stock
                // model never sets it (prep no longer writes stockOnHand directly),
                // so filtering on it would hide every prep movement. Mirrors buildPrepMap.
                where: { status: { in: ['DONE', 'PARTIAL'] }, actualPrepQty: { not: null }, updatedAt: { gte: since } },
              },
            },
          },
        },
      },
    },
  })
  for (const ri of prepIngredientRows) {
    for (const prepItem of ri.recipe.prepItems) {
      for (const log of prepItem.logs) {
        const actualQty = Number(log.actualPrepQty ?? 0)
        if (actualQty <= 0) continue
        const { scale } = computeScale(actualQty, prepItem.unit, ri.recipe.yieldUnit, Number(ri.recipe.baseYieldQty))
        const consumed  = convertQty(Number(ri.qtyBase) * scale, ri.unit, nonNullItem.baseUnit)
        raw.push({
          id: `prep-in-${log.id}-${ri.id}`,
          date: log.updatedAt, type: 'PREP_IN', qtyBase: -consumed,
          description: `Prep: ${ri.recipe.name}`,
        })
      }
    }
  }

  // ── PREP: this item is the output of a prep recipe (credit) ──────────────
  const prepOutputLogs = await prisma.prepLog.findMany({
    where: {
      // See note above: inventoryAdjusted is unset under the theoretical model.
      status: { in: ['DONE', 'PARTIAL'] },
      actualPrepQty: { not: null },
      updatedAt: { gte: since },
      prepItem: { linkedRecipe: { inventoryItemId: params.id } },
    },
    include: {
      prepItem: {
        include: {
          linkedRecipe: { select: { name: true, yieldUnit: true, baseYieldQty: true } },
        },
      },
    },
  })
  for (const log of prepOutputLogs) {
    const recipe    = log.prepItem.linkedRecipe!
    const actualQty = Number(log.actualPrepQty ?? 0)
    if (actualQty <= 0) continue
    // Mirror buildPrepMap exactly: scale the recipe's base yield by how many batches
    // were made (computeScale converts prep-unit → yield-unit). Treating actualPrepQty
    // as if it were already in the yield unit diverged from the page's theoretical math.
    const { scale } = computeScale(actualQty, log.prepItem.unit, recipe.yieldUnit, Number(recipe.baseYieldQty))
    const credited  = convertQty(Number(recipe.baseYieldQty), recipe.yieldUnit, nonNullItem.baseUnit) * scale
    raw.push({
      id: `prep-out-${log.id}`,
      date: log.updatedAt, type: 'PREP_OUT', qtyBase: credited,
      description: `Prep output: ${recipe.name}`,
    })
  }

  // ── RC-to-RC TRANSFERS (theoretical moves between revenue centers) ─────────
  // Shown for provenance/history. This drawer is a GLOBAL (all-RC) view, and a
  // transfer only moves stock between RCs — it never changes total on-hand — so
  // transfer rows are display-only and excluded from the theoretical total below.
  const transfers = await prisma.stockTransfer.findMany({
    where: { inventoryItemId: params.id, createdAt: { gte: since } },
    include: { fromRc: { select: { name: true } }, toRc: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take: 20,
  })
  for (const t of transfers) {
    raw.push({
      id: `transfer-${t.id}`,
      date: t.createdAt, type: 'TRANSFER', qtyBase: Number(t.quantity),
      description: `${t.fromRc.name} → ${t.toRc.name}`,
    })
  }

  // Sort newest first
  raw.sort((a, b) => b.date.getTime() - a.date.getTime())

  // Compute theoretical from baseline + all movements. Transfers are net-zero at the
  // global level (they only shuffle stock between RCs), so they're excluded here.
  const totalMovement  = raw.reduce((sum, m) => (m.type === 'TRANSFER' ? sum : sum + m.qtyBase), 0)
  const theoreticalBase = Math.max(0, baseQty + totalMovement)

  const response: StockMovementsResponse = {
    lastCount:   { qty: toDisplay(baseQty), unit: displayUnit, date: nonNullItem.lastCountDate?.toISOString() ?? null },
    theoretical: { qty: toDisplay(theoreticalBase), unit: displayUnit },
    movements: raw.map(m => ({
      id:          m.id,
      date:        m.date.toISOString(),
      type:        m.type,
      qty:         toDisplay(m.qtyBase),
      unit:        displayUnit,
      description: m.description,
      revenueCenterId: m.revenueCenterId ?? null,
    })),
  }

  return NextResponse.json(response)
}
