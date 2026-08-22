import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { convertBaseToCountUom, resolveCountUom } from '@/lib/count-uom'
import { buildItemLedger, splitLedger } from '@/lib/stock-ledger'
import { displayDayKey } from '@/lib/prep-day'

export const dynamic = 'force-dynamic'

export type MovementType = 'SALE' | 'WASTAGE' | 'PREP_IN' | 'PREP_OUT' | 'PURCHASE' | 'TRANSFER'

export interface StockMovement {
  id: string
  date: string
  /**
   * 'YYYY-MM-DD' — the day to PRINT. Business dates are stored as UTC-midnight
   * markers, so letting the browser format `date` in Pacific walks them back a
   * day. Render this and never construct a local Date from `date`.
   */
  dayKey: string
  type: MovementType
  qty: number   // in displayUnit, negative = deduction, positive = addition
  unit: string
  description: string
  revenueCenterId?: string | null
}

/**
 * The drawer's promise, in numbers: `opening + additions − consumptions + adjustment
 * === theoretical`, always, exactly. Sent as totals rather than left for the client
 * to add up, because the client only renders the most recent dozen movements.
 *
 * All figures are in `unit`.
 */
export interface StockReconciliation {
  opening:      number
  additions:    number   // purchases + prep yield
  consumptions: number   // sales + wastage + prep draw-down (positive magnitude)
  /**
   * Non-zero only when the engine's arithmetic and the physical count disagree:
   * a revenue centre whose column ran below zero and was floored there (the house
   * consumed more than it ever recorded receiving), or a stale opening balance.
   * Never hidden — an unexplained gap is the thing worth seeing.
   */
  adjustment:   number
  theoretical:  number
  unit:         string
  /** Total movements in the window; `movements` carries them all, the UI truncates. */
  movementCount: number
}

export interface StockMovementsResponse {
  lastCount: { qty: number; unit: string; date: string | null; dayKey: string | null }
  theoretical: { qty: number; unit: string }
  movements: StockMovement[]
  reconciliation: StockReconciliation
}

// GET /api/inventory/[id]/stock-movements
//
// The whole ledger comes from src/lib/stock-ledger.ts, which reads the theoretical
// engine's own working. This route only picks the display unit and converts.
// It deliberately computes NOTHING about stock itself: the previous version
// reimplemented the engine here and drifted from it on every axis (a catch-weight
// receipt showed 10× the weight actually delivered).
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const item = await prisma.inventoryItem.findUnique({
    where: { id: params.id },
    select: { id: true, baseUnit: true, dimension: true, packChain: true, countUnit: true },
  })
  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Resolve the display unit exactly like the drawer header does: a stored
  // countUOM that is no longer valid for the item's purchase structure (e.g.
  // a stale "each" on a by-weight item) falls back to the first valid unit.
  // Using the raw value here made the stock section read "each" while the rest
  // of the panel read "KG".
  const dims = { dimension: item.dimension, baseUnit: item.baseUnit, packChain: item.packChain }
  const displayUnit = resolveCountUom({ ...dims, countUnit: item.countUnit ?? item.baseUnit })
  const toDisplay = (qtyInBase: number): number => convertBaseToCountUom(qtyInBase, displayUnit, dims)

  const ledger = await buildItemLedger(params.id, null)
  if (!ledger) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const movements: StockMovement[] = ledger.events.map(e => ({
    id:              e.id,
    date:            e.date.toISOString(),
    dayKey:          displayDayKey(e.date),
    type:            e.type,
    qty:             toDisplay(e.qtyBase),
    unit:            displayUnit,
    description:     e.description,
    revenueCenterId: e.revenueCenterId,
  }))

  // Transfer legs stay in the list for provenance but out of the split — see splitLedger.
  const { additions, consumptions, transferNet } = splitLedger(ledger.events)

  const response: StockMovementsResponse = {
    lastCount: {
      qty:    toDisplay(ledger.openingBase),
      unit:   displayUnit,
      date:   ledger.openingDate?.toISOString() ?? null,
      dayKey: ledger.openingDate ? displayDayKey(ledger.openingDate) : null,
    },
    theoretical: { qty: toDisplay(ledger.theoreticalBase), unit: displayUnit },
    movements,
    reconciliation: {
      opening:       toDisplay(ledger.openingBase),
      additions:     toDisplay(additions),
      consumptions:  toDisplay(consumptions),
      // transferNet is zero across all RCs; folded in so the identity holds even
      // if a future scope makes it non-zero.
      adjustment:    toDisplay(ledger.residualBase + transferNet),
      theoretical:   toDisplay(ledger.theoreticalBase),
      unit:          displayUnit,
      movementCount: ledger.events.length,
    },
  }

  return NextResponse.json(response)
}
