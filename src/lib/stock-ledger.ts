/**
 * The movement track behind an item's stock drawer.
 *
 * ONE rule, stated once: **last count + everything added − everything consumed
 * = theoretical stock**. The drawer used to break that promise in both directions,
 * because it computed the ledger itself and took the headline from the engine:
 *
 *   - a catch-weight invoice line (44.61 lb of salmon, billed per lb) was multiplied
 *     by the case size and posted as "+446.10 lb" — a clean 10× inflation on every
 *     RATE-priced item in the house;
 *   - prep was filtered and dated by `updatedAt`, so the prep-log repair scripts,
 *     which rewrote `updatedAt` on hundreds of rows, dragged a 26 June prep into
 *     the August window and showed it as "15 Aug";
 *   - none of the engine's own timing rules applied — "a count owns its day", and
 *     prep ordered against the count MOMENT — so movements already baked into the
 *     counted baseline were subtracted a second time.
 *
 * So this module does not compute movements. It asks the theoretical engine to
 * record its working ({@link TheoreticalTrace}) and reports what the engine did.
 * The list and the total cannot disagree, because there is only one of them.
 */
import { prisma } from '@/lib/prisma'
import {
  getTheoreticalStockMap,
  type LedgerEvent,
  type LedgerEventType,
} from '@/lib/count-expected'
import { getCountedStockMap } from '@/lib/counted-stock'

export type { LedgerEvent, LedgerEventType }

export interface ItemLedger {
  /** Physically counted baseline, ΣRC, in the item's baseUnit. */
  openingBase: number
  /** Session date of the OLDEST count contributing to `openingBase`; null = never counted. */
  openingDate: Date | null
  /** True when `openingBase` is the item's stock pool rather than a physical count. */
  openingIsCount: boolean
  /** Every movement the engine applied, newest first. Signed, in baseUnit. */
  events: LedgerEvent[]
  /** The live figure — byte-identical to what the inventory list shows. */
  theoreticalBase: number
  /**
   * theoretical − (opening + Σ events). Zero for virtually every item. Non-zero
   * when an RC's own column went negative and was floored at zero, or when the
   * counted baseline and the engine's per-RC opening balances disagree. Surfaced
   * as its own row rather than silently making the column not add up.
   */
  residualBase: number
}

/** Two figures that must not be compared with `===` after floating-point unit maths. */
const EPSILON = 1e-6

/** The additions/consumptions split, in the same base units as the events. */
export interface LedgerSplit {
  additions:    number   // purchases + prep yield
  consumptions: number   // sales + wastage + prep draw-down, as a POSITIVE magnitude
  /** Net of the transfer legs. Zero across all revenue centres, by construction. */
  transferNet:  number
}

/**
 * Split signed events into the two columns a chef reads.
 *
 * Transfers are held out of both. A transfer moves stock BETWEEN revenue centres,
 * so in an all-RC view its two legs cancel; counting them would inflate "added"
 * and "used" by the same amount and make both numbers lies. `transferNet` keeps
 * them accounted for so nothing is silently dropped.
 */
export function splitLedger(events: Pick<LedgerEvent, 'type' | 'qtyBase'>[]): LedgerSplit {
  let additions = 0, consumptions = 0, transferNet = 0
  for (const e of events) {
    if (e.type === 'TRANSFER') { transferNet += e.qtyBase; continue }
    if (e.qtyBase >= 0) additions += e.qtyBase
    else consumptions += -e.qtyBase
  }
  return { additions, consumptions, transferNet }
}

/**
 * Ledger for one item, scoped to a revenue centre (`null` = all of them).
 * Returns null when the item does not exist.
 */
export async function buildItemLedger(itemId: string, rcId?: string | null): Promise<ItemLedger | null> {
  const item = await prisma.inventoryItem.findUnique({
    where: { id: itemId },
    select: { id: true, stockOnHand: true },
  })
  if (!item) return null

  const events: LedgerEvent[] = []
  let openingFromEngine = 0

  const theoreticalMap = await getTheoreticalStockMap(rcId ?? null, [itemId], null, {
    sink: { push: e => { if (e.itemId === itemId) events.push(e) } },
    onRcResult: (_rc, id, baseStock) => { if (id === itemId) openingFromEngine += baseStock },
  })

  // An inactive or non-stocked item is outside the engine's scope entirely and
  // comes back absent, not zero — fall back to its own pool figure, as the
  // drawer has always done, rather than reporting a confident 0.
  const inScope = theoreticalMap.has(itemId)
  const theoreticalBase = inScope ? theoreticalMap.get(itemId)! : Math.max(0, Number(item.stockOnHand))

  // The headline baseline is the PHYSICAL count (ΣRC — each revenue centre's own
  // latest count), which is what "Last count" means to a chef. It agrees with the
  // engine's per-RC opening balances for all but a handful of items carrying a
  // stale StockAllocation; where it doesn't, the difference lands in `residual`
  // instead of being papered over.
  const countedMap = await getCountedStockMap(null, [itemId])
  const counted = rcId ? (await getCountedStockMap([rcId], [itemId])).get(itemId) : countedMap.get(itemId)
  const openingIsCount = counted != null
  const openingBase = openingIsCount ? counted!.qtyBase : (inScope ? openingFromEngine : Number(item.stockOnHand))
  const openingDate = openingIsCount ? new Date(counted!.date) : null

  const movementSum = events.reduce((acc, e) => acc + e.qtyBase, 0)
  const residual = theoreticalBase - (openingBase + movementSum)

  events.sort((a, b) => b.date.getTime() - a.date.getTime())

  return {
    openingBase,
    openingDate,
    openingIsCount,
    events,
    theoreticalBase,
    residualBase: Math.abs(residual) < EPSILON ? 0 : residual,
  }
}
