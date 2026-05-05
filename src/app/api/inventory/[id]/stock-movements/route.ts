import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { convertQty } from '@/lib/uom'
import { convertBaseToCountUom } from '@/lib/count-uom'
import { computeScale } from '@/lib/prep-utils'

export type MovementType = 'SALE' | 'WASTAGE' | 'PREP_IN' | 'PREP_OUT' | 'PURCHASE'

export interface StockMovement {
  id: string
  date: string
  type: MovementType
  qty: number   // in displayUnit, negative = deduction, positive = addition
  unit: string
  description: string
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
      id: true, baseUnit: true, countUOM: true,
      stockOnHand: true, lastCountDate: true, lastCountQty: true,
      purchaseUnit: true, qtyPerPurchaseUnit: true, packSize: true, packUOM: true,
      qtyUOM: true, innerQty: true,
    },
  })
  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const nonNullItem = item

  const displayUnit = nonNullItem.countUOM || nonNullItem.baseUnit
  // lastCountQty is the physically verified quantity — use as baseline.
  // Fall back to stockOnHand if item has never been formally counted.
  const baseQty = nonNullItem.lastCountQty != null ? Number(nonNullItem.lastCountQty) : Number(nonNullItem.stockOnHand)
  // Look back 90 days if never formally counted
  const since: Date = nonNullItem.lastCountDate ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)

  const itemDimsForDisplay = {
    baseUnit:           nonNullItem.baseUnit,
    purchaseUnit:       nonNullItem.purchaseUnit,
    qtyPerPurchaseUnit: Number(nonNullItem.qtyPerPurchaseUnit),
    qtyUOM:             nonNullItem.qtyUOM ?? 'each',
    innerQty:           nonNullItem.innerQty != null ? Number(nonNullItem.innerQty) : null,
    packSize:           Number(nonNullItem.packSize ?? 1),
    packUOM:            nonNullItem.packUOM ?? 'each',
    countUOM:           displayUnit,
  }

  function toDisplay(qtyInBase: number): number {
    return convertBaseToCountUom(qtyInBase, displayUnit, itemDimsForDisplay)
  }

  const raw: Array<{ id: string; date: Date; type: MovementType; qtyBase: number; description: string }> = []

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
  const scanItems = await prisma.invoiceScanItem.findMany({
    where: {
      matchedItemId: params.id,
      approved: true,
      action: { in: ['UPDATE_PRICE', 'ADD_SUPPLIER'] },
      session: { status: 'APPROVED', approvedAt: { gte: since } },
      rawQty: { not: null },
    },
    include: {
      session: { select: { supplierName: true, invoiceDate: true, invoiceNumber: true, approvedAt: true } },
    },
  })
  for (const si of scanItems) {
    const qty = Number(si.rawQty ?? 0)
    if (qty <= 0) continue
    let baseUnits: number
    const packQty  = si.invoicePackQty  ? Number(si.invoicePackQty)  : 0
    const packSize = si.invoicePackSize ? Number(si.invoicePackSize) : 0
    const packUOM  = si.invoicePackUOM ?? null
    if (packQty > 0 && packSize > 0 && packUOM) {
      baseUnits = convertQty(qty * packQty * packSize, packUOM, nonNullItem.baseUnit)
    } else {
      baseUnits = qty * Number(nonNullItem.qtyPerPurchaseUnit) * Number(nonNullItem.packSize)
    }
    const supplier = si.session.supplierName ?? 'Purchase'
    const invNum   = si.session.invoiceNumber ? ` · #${si.session.invoiceNumber}` : ''
    const date     = si.session.approvedAt ?? (si.session.invoiceDate ? new Date(si.session.invoiceDate) : new Date())
    raw.push({ id: si.id, date, type: 'PURCHASE', qtyBase: baseUnits, description: `${supplier}${invNum}` })
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
                where: { status: { in: ['DONE', 'PARTIAL'] }, inventoryAdjusted: true, updatedAt: { gte: since } },
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
      status: { in: ['DONE', 'PARTIAL'] },
      inventoryAdjusted: true,
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
    const credited  = convertQty(actualQty, recipe.yieldUnit, nonNullItem.baseUnit)
    raw.push({
      id: `prep-out-${log.id}`,
      date: log.updatedAt, type: 'PREP_OUT', qtyBase: credited,
      description: `Prep output: ${recipe.name}`,
    })
  }

  // Sort newest first
  raw.sort((a, b) => b.date.getTime() - a.date.getTime())

  // Compute theoretical from baseline + all movements
  const totalMovement  = raw.reduce((sum, m) => sum + m.qtyBase, 0)
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
    })),
  }

  return NextResponse.json(response)
}
