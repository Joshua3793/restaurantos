import { describe, it, expect } from 'vitest'
import { runLedger, ledgerOrder, MovementLedger, type LedgerEvent } from '@/lib/ledger-balance'

const ITEM = 'item-1'
let seq = 0
const ev = (
  type: LedgerEvent['type'],
  qtyBase: number,
  date: string,
  at?: string,
  itemId = ITEM,
): LedgerEvent => ({
  id: `e${++seq}`, type, qtyBase, date: new Date(date), itemId,
  description: type, revenueCenterId: null, ...(at ? { at: new Date(at) } : {}),
})

// Day markers are UTC midnight of the restaurant's (Pacific) day; instants are real times.
const D1 = '2026-08-12T00:00:00.000Z'
const D2 = '2026-08-16T00:00:00.000Z'
const D3 = '2026-09-13T00:00:00.000Z'

describe('runLedger — the shelf never goes below zero', () => {
  it('sums additions and removals like the old rule when nothing goes negative', () => {
    const r = runLedger(10, [ev('SALE', -4, D1), ev('PURCHASE', 5, D2), ev('WASTAGE', -1, D2), ev('PREP_IN', -2, D3), ev('PREP_OUT', 2, D3), ev('TRANSFER', 3, D3, D3)])
    expect(r.expected).toBe(13)
    expect(r.shortfall).toBe(0)
  })

  it('floors after each event, so a later yield is not swallowed by an earlier deficit', () => {
    // The Adobo case: 6 L made, then 25 L drawn by another prep, then 4 L made.
    const r = runLedger(0, [
      ev('PREP_OUT', 6000, D1, '2026-08-12T18:58:39Z'),
      ev('PREP_IN', -25000, D2, '2026-08-16T16:34:04Z'),
      ev('PREP_OUT', 4000, D3, '2026-09-14T01:57:19Z'),
    ])
    expect(r.expected).toBe(4000)
    // 19 L of recorded use had nothing to draw from.
    expect(r.shortfall).toBe(19000)
  })

  it('reports the whole deficit as shortfall when nothing is ever added', () => {
    const r = runLedger(0, [ev('SALE', -8, D1)])
    expect(r.expected).toBe(0)
    expect(r.shortfall).toBe(8)
  })

  it('clamps a negative opening balance before any event', () => {
    const r = runLedger(-3, [ev('PURCHASE', 2, D1)])
    expect(r.expected).toBe(2)
    expect(r.shortfall).toBe(3)
  })

  it('keeps the transfer term: into this RC adds, out of it removes, over-draw is shortfall', () => {
    expect(runLedger(0, [ev('TRANSFER', 5, D1, D1)]).expected).toBe(5)
    expect(runLedger(10, [ev('TRANSFER', -4, D1, D1)]).expected).toBe(6)
    const over = runLedger(3, [ev('TRANSFER', -10, D1, D1)])
    expect(over.expected).toBe(0)
    expect(over.shortfall).toBe(7)
  })
})

describe('ledgerOrder — where an event lands inside its day', () => {
  it('applies a purchase at the start of its day and sales at the end', () => {
    // Delivered and sold on the same day: 10 in, 5 out → 5, never "sold before it arrived".
    const r = runLedger(0, [ev('SALE', -5, D1), ev('PURCHASE', 10, D1)])
    expect(r.expected).toBe(5)
    expect(r.shortfall).toBe(0)
  })

  it('applies prep before the day\'s sales — you make the biscuits, then service sells them', () => {
    const r = runLedger(0, [ev('SALE', -40, D1), ev('PREP_OUT', 55, D1, '2026-08-12T15:00:00Z')])
    expect(r.expected).toBe(15)
    expect(r.shortfall).toBe(0)
  })

  it('orders two preps on the same day by when they were actually completed', () => {
    // Smoked Pulled Pork (draws 7.8 L) finished at 15:42Z; Adobo (4 L) at 18:57 Pacific.
    const spp   = ev('PREP_IN', -7778, D3, '2026-09-13T15:42:47Z')
    const adobo = ev('PREP_OUT', 4000, D3, '2026-09-14T01:57:19Z')
    const r = runLedger(0, [adobo, spp])
    expect(r.expected).toBe(4000)
    expect(r.shortfall).toBe(7778)
    // The other way round the draw eats the fresh batch.
    const rev = runLedger(0, [{ ...adobo, at: new Date('2026-09-13T15:00:00Z') }, spp])
    expect(rev.expected).toBe(0)
    expect(rev.shortfall).toBe(3778)
  })

  it('buckets an instant by the restaurant\'s day, not the UTC date', () => {
    // 01:57Z on the 14th is the evening of the 13th in Pacific: it belongs to the 13th,
    // ahead of a sale marker dated the 14th.
    const a = ev('PREP_OUT', 1, D3, '2026-09-14T01:57:19Z')
    const b = ev('SALE', -1, '2026-09-14T00:00:00.000Z')
    expect(ledgerOrder(a, b)).toBeLessThan(0)
  })

  it('is stable: additions before removals at the same moment, then by id', () => {
    const add = ev('PREP_OUT', 1, D1, '2026-08-12T15:00:00Z')
    const rem = ev('PREP_IN', -1, D1, '2026-08-12T15:00:00Z')
    expect(ledgerOrder(add, rem)).toBeLessThan(0)
    expect(ledgerOrder(rem, add)).toBeGreaterThan(0)
  })
})

describe('MovementLedger — a sink that keeps every item\'s events apart', () => {
  it('balances each item from its own events and its own opening stock', () => {
    const l = new MovementLedger()
    l.push(ev('SALE', -8, D1, undefined, 'a'))
    l.push(ev('PREP_OUT', 6, D2, undefined, 'a'))
    l.push(ev('PURCHASE', 3, D1, undefined, 'b'))
    expect(l.balance('a', 0)).toEqual({ expected: 6, shortfall: 8 })
    expect(l.balance('b', 1)).toEqual({ expected: 4, shortfall: 0 })
    expect(l.balance('c', 7)).toEqual({ expected: 7, shortfall: 0 })
    expect(l.moved('a')).toBe(true)
    expect(l.moved('c')).toBe(false)
    expect(l.events('a')).toHaveLength(2)
  })
})
