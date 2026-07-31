import { describe, it, expect } from 'vitest'
import { splitTipAcrossRcs } from '@/lib/toast/sales-sync'

/** Sum every RC's slice, so conservation can be asserted against the input. */
const sum = (m: Map<string, { tips: number; gratuity: number }>) =>
  [...m.values()].reduce((a, v) => a + v.tips + v.gratuity, 0)

const allRcsExist = () => true
const noRcsExist = () => false

describe('splitTipAcrossRcs', () => {
  it('splits proportionally across two revenue centers', () => {
    const r = splitTipAcrossRcs({
      checkRcRevenue: new Map([['cafe', 75], ['bar', 25]]),
      orderRc: 'cafe',
      bucketExists: allRcsExist,
      tips: 20,
      gratuity: 4,
    })
    expect(r.perRc.get('cafe')).toEqual({ tips: 15, gratuity: 3 })
    expect(r.perRc.get('bar')).toEqual({ tips: 5, gratuity: 1 })
    expect(r.unattributed).toBe(0)
  })

  it('attributes a fully comped check to the single RC it routed to', () => {
    // 100% discount → every selection price is 0, but the guest still tipped.
    // The RC is known, so the tip is NOT unattributable.
    const r = splitTipAcrossRcs({
      checkRcRevenue: new Map([['cafe', 0]]),
      orderRc: undefined,
      bucketExists: allRcsExist,
      tips: 10,
      gratuity: 0,
    })
    expect(r.perRc.get('cafe')).toEqual({ tips: 10, gratuity: 0 })
    expect(r.unattributed).toBe(0)
  })

  it('never hands a negative-revenue RC a negative tip', () => {
    // +$100 to cafe, −$20 adjustment to bar. Bar earns no share; cafe takes all.
    const r = splitTipAcrossRcs({
      checkRcRevenue: new Map([['cafe', 100], ['bar', -20]]),
      orderRc: 'cafe',
      bucketExists: allRcsExist,
      tips: 10,
      gratuity: 0,
    })
    expect(r.perRc.get('cafe')).toEqual({ tips: 10, gratuity: 0 })
    expect(r.perRc.has('bar')).toBe(false)
    expect(r.unattributed).toBe(0)
  })

  it('falls back to the order RC when the check routed nothing and that RC has a bucket', () => {
    const r = splitTipAcrossRcs({
      checkRcRevenue: new Map(),
      orderRc: 'cafe',
      bucketExists: (rcId) => rcId === 'cafe',
      tips: 7,
      gratuity: 3,
    })
    expect(r.perRc.get('cafe')).toEqual({ tips: 7, gratuity: 3 })
    expect(r.unattributed).toBe(0)
  })

  it('refuses to conjure a bucket for an order RC that took no revenue today', () => {
    // Every selection voided/deferred/ignored, but the payment carried a tip.
    // Creating a bucket here would delete that RC's manual entry and write $0.
    const r = splitTipAcrossRcs({
      checkRcRevenue: new Map(),
      orderRc: 'catering',
      bucketExists: noRcsExist,
      tips: 12,
      gratuity: 0,
    })
    expect(r.perRc.size).toBe(0)
    expect(r.unattributed).toBe(12)
  })

  it('reports the tip as unattributed when there is no order RC at all', () => {
    const r = splitTipAcrossRcs({
      checkRcRevenue: new Map(),
      orderRc: undefined,
      bucketExists: allRcsExist,
      tips: 5,
      gratuity: 2,
    })
    expect(r.perRc.size).toBe(0)
    expect(r.unattributed).toBe(7)
  })

  it('falls through to the order RC when several RCs all routed zero revenue', () => {
    const r = splitTipAcrossRcs({
      checkRcRevenue: new Map([['cafe', 0], ['bar', 0]]),
      orderRc: 'bar',
      bucketExists: allRcsExist,
      tips: 9,
      gratuity: 0,
    })
    expect(r.perRc.get('bar')).toEqual({ tips: 9, gratuity: 0 })
    expect(r.unattributed).toBe(0)
  })

  it('is a no-op for a check with no tip', () => {
    const r = splitTipAcrossRcs({
      checkRcRevenue: new Map([['cafe', 50]]),
      orderRc: 'cafe',
      bucketExists: allRcsExist,
      tips: 0,
      gratuity: 0,
    })
    expect(r.perRc.size).toBe(0)
    expect(r.unattributed).toBe(0)
  })

  it('conserves the total to the cent in every branch', () => {
    const cases: Parameters<typeof splitTipAcrossRcs>[0][] = [
      { checkRcRevenue: new Map([['a', 33], ['b', 33], ['c', 34]]), orderRc: 'a', bucketExists: allRcsExist, tips: 10, gratuity: 0 },
      { checkRcRevenue: new Map([['a', 1], ['b', 2]]),              orderRc: 'a', bucketExists: allRcsExist, tips: 3.33, gratuity: 1.11 },
      { checkRcRevenue: new Map([['a', 100], ['b', -40]]),          orderRc: 'a', bucketExists: allRcsExist, tips: 7.77, gratuity: 0 },
      { checkRcRevenue: new Map([['a', 0]]),                        orderRc: undefined, bucketExists: allRcsExist, tips: 4.44, gratuity: 2.22 },
      { checkRcRevenue: new Map(),                                  orderRc: 'a', bucketExists: allRcsExist, tips: 6, gratuity: 1.5 },
      { checkRcRevenue: new Map(),                                  orderRc: 'a', bucketExists: noRcsExist, tips: 6, gratuity: 1.5 },
    ]
    for (const input of cases) {
      const r = splitTipAcrossRcs(input)
      expect(sum(r.perRc) + r.unattributed).toBeCloseTo(input.tips + input.gratuity, 2)
    }
  })
})
