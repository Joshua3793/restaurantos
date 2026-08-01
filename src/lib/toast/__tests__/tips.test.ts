import { describe, it, expect } from 'vitest'
import { checkTipTotals } from '@/lib/toast/client'
import type { ToastCheck } from '@/lib/toast/client'

const check = (over: Partial<ToastCheck>): ToastCheck => ({ guid: 'c1', ...over })

describe('checkTipTotals', () => {
  it('sums tipAmount across the check payments', () => {
    const r = checkTipTotals(check({
      payments: [
        { guid: 'p1', amount: 40, tipAmount: 8, type: 'CREDIT', paymentStatus: 'CAPTURED' },
        { guid: 'p2', amount: 20, tipAmount: 3, type: 'CASH' },
      ],
    }), true)
    expect(r.tips).toBe(11)
  })

  it('ignores voided and denied payments', () => {
    const r = checkTipTotals(check({
      payments: [
        { guid: 'p1', amount: 40, tipAmount: 8, type: 'CREDIT', paymentStatus: 'VOIDED' },
        { guid: 'p2', amount: 40, tipAmount: 5, type: 'CREDIT', paymentStatus: 'DENIED' },
        { guid: 'p3', amount: 40, tipAmount: 7, type: 'CREDIT', paymentStatus: 'CAPTURED' },
      ],
    }), true)
    expect(r.tips).toBe(7)
  })

  it('subtracts a refunded tip', () => {
    const r = checkTipTotals(check({
      payments: [{
        guid: 'p1', amount: 40, tipAmount: 10, type: 'CREDIT', paymentStatus: 'CAPTURED',
        refundStatus: 'PARTIAL', refund: { tipRefundAmount: 4 },
      }],
    }), true)
    expect(r.tips).toBe(6)
  })

  it('never returns a negative tip when a refund exceeds the tip', () => {
    const r = checkTipTotals(check({
      payments: [{
        guid: 'p1', amount: 40, tipAmount: 5, type: 'CREDIT', paymentStatus: 'CAPTURED',
        refundStatus: 'FULL', refund: { tipRefundAmount: 9 },
      }],
    }), true)
    expect(r.tips).toBe(0)
  })

  it('reports gratuity service charges separately from payment tips', () => {
    const r = checkTipTotals(check({
      payments: [{ guid: 'p1', amount: 100, tipAmount: 12, type: 'CREDIT', paymentStatus: 'CAPTURED' }],
      appliedServiceCharges: [
        { guid: 's1', name: 'Auto grat 20%', chargeAmount: 20, gratuity: true },
        { guid: 's2', name: 'Booking fee', chargeAmount: 5, gratuity: false },
      ],
    }), true)
    expect(r.tips).toBe(12)
    expect(r.gratuity).toBe(20)
  })

  it('returns zero gratuity when the house does not count auto-grat as tips', () => {
    const r = checkTipTotals(check({
      appliedServiceCharges: [{ guid: 's1', name: 'Auto grat', chargeAmount: 20, gratuity: true }],
    }), false)
    expect(r.gratuity).toBe(0)
  })

  it('is zero for a check with no payments at all', () => {
    expect(checkTipTotals(check({}), true)).toEqual({ tips: 0, gratuity: 0 })
  })
})
