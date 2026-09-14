// The running balance behind theoretical stock — ONE rule, stated once:
//
//   a shelf never holds less than zero.
//
// Theoretical stock used to be `max(0, opening + Σ movements)`: net everything
// since the last count, then floor the total. That floor is applied LAST, so once
// an item's recorded use had outrun its recorded production (a stale count, a
// sub-recipe drawing 5 L per batch, cooks making a base without logging it) the
// item sat at zero and every later yield, delivery or transfer-in vanished into the
// deficit — the chef logged 4 L of adobo and Smart Prep still said "stock out".
//
// Here the floor is applied after EVERY movement, in the order the movements
// happened. A removal with nothing to draw from takes the shelf to zero and the
// unmet part is remembered as `shortfall` — use the model recorded that the shelf
// could not have supplied. A later addition then shows up in full, because a
// batch you just made is on the shelf whatever the ledger thought before it.
//
// Order inside a day (see {@link ledgerOrder}): deliveries first, then prep and
// transfers at the moment they were completed, then the day's sales and wastage.
// Sales and purchases are day-dated (UTC-midnight markers of the restaurant's
// day), prep logs and transfers carry a real completion instant; the instant is
// bucketed by the restaurant's day so an evening prep stays on the day it was
// made. Netting a day and flooring it would be the same as "additions first",
// and would lose the one ordering that matters most: a base made AFTER the
// sub-recipe that drew it down today is still on the shelf tonight.
import { displayDayKey } from './prep-day'

export type LedgerEventType = 'SALE' | 'WASTAGE' | 'PREP_IN' | 'PREP_OUT' | 'PURCHASE' | 'TRANSFER'

export interface LedgerEvent {
  id:          string
  /** The date the movement is APPLIED on — received date, log date, sale date. */
  date:        Date
  /**
   * The instant the movement actually happened, when the source records one
   * (a prep log's completion, a transfer's creation). Orders same-day events;
   * absent for day-dated sources (sales, purchases, wastage).
   */
  at?:         Date
  type:        LedgerEventType
  itemId:      string
  /** Signed, in the item's baseUnit: positive adds stock, negative removes it. */
  qtyBase:     number
  description: string
  revenueCenterId: string | null
}

/** Collects events as the maps are built. Array-compatible on purpose. */
export interface LedgerSink { push(event: LedgerEvent): void }

export interface LedgerBalance {
  /** Theoretical on hand, in baseUnit — never below zero. */
  expected:  number
  /** Recorded use the shelf could not supply, in baseUnit. Zero for a healthy item. */
  shortfall: number
}

/** Where a day-dated event sits inside its day: deliveries open it, sales close it. */
function phase(e: LedgerEvent): number {
  if (e.at) return 1
  if (e.type === 'PURCHASE') return 0
  if (e.type === 'SALE' || e.type === 'WASTAGE') return 2
  return 1   // a prep or transfer without an instant: at its day's marker
}

/** Chronological order of movements — the order the shelf saw them. */
export function ledgerOrder(a: LedgerEvent, b: LedgerEvent): number {
  const da = displayDayKey(a.date), db = displayDayKey(b.date)
  if (da !== db) return da < db ? -1 : 1
  const pa = phase(a), pb = phase(b)
  if (pa !== pb) return pa - pb
  const ta = (a.at ?? a.date).getTime(), tb = (b.at ?? b.date).getTime()
  if (ta !== tb) return ta - tb
  // Same moment: what was added is on the shelf before what was taken from it.
  const sa = a.qtyBase >= 0 ? 0 : 1, sb = b.qtyBase >= 0 ? 0 : 1
  if (sa !== sb) return sa - sb
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Run the movements over the opening balance, flooring the shelf at zero after each. */
export function runLedger(baseStock: number, events: readonly LedgerEvent[]): LedgerBalance {
  let running = baseStock
  let shortfall = 0
  if (running < 0) { shortfall = -running; running = 0 }
  const ordered = [...events].sort(ledgerOrder)
  for (const e of ordered) {
    running += e.qtyBase
    if (running < 0) { shortfall += -running; running = 0 }
  }
  return { expected: running, shortfall }
}

/**
 * A {@link LedgerSink} that keeps each item's movements apart, so a caller can
 * hand ONE sink to every movement builder and then read each item's balance.
 * Events are returned in the order they were pushed; `balance` orders them.
 */
export class MovementLedger implements LedgerSink {
  private readonly byItem = new Map<string, LedgerEvent[]>()

  push(e: LedgerEvent): void {
    const list = this.byItem.get(e.itemId)
    if (list) list.push(e)
    else this.byItem.set(e.itemId, [e])
  }

  events(itemId: string): LedgerEvent[] {
    return this.byItem.get(itemId) ?? []
  }

  /** Whether any movement touched the item at all. */
  moved(itemId: string): boolean {
    return this.byItem.has(itemId)
  }

  balance(itemId: string, baseStock: number): LedgerBalance {
    return runLedger(baseStock, this.events(itemId))
  }

  /** Every event, across items — for a caller that wants to forward them on. */
  all(): LedgerEvent[] {
    return Array.from(this.byItem.values()).flat()
  }
}
