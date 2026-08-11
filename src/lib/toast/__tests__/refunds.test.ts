import { describe, it, expect } from 'vitest'
import { checkRefunds } from '@/lib/toast/refunds'
import type { ToastCheck } from '@/lib/toast/client'

/**
 * Fixtures mirror the two refund shapes seen live on 2026-07-31 (see
 * `checkRefunds`' doc comment). Amounts are the real ones so the arithmetic
 * below is the arithmetic that reconciled against Toast's own export.
 */
const TX = 'refund-tx-1'

function check(partial: Partial<ToastCheck>): ToastCheck {
  return { guid: 'check-1', selections: [], payments: [], ...partial }
}

describe('checkRefunds', () => {
  it('deducts nothing from a check with no refunds', () => {
    const result = checkRefunds(
      check({
        selections: [{ guid: 's1', price: 12.5 }],
        payments: [{ guid: 'p1', amount: 13.12 }],
      }),
    )

    expect(result.bySelection.size).toBe(0)
    expect(result.unattributed).toBe(0)
  })

  it('deducts a line-level refund from the selection that carries it', () => {
    const result = checkRefunds(
      check({
        selections: [
          { guid: 's1', price: 12.5, refundDetails: { refundAmount: 12.5, taxRefundAmount: 0.62, refundTransaction: { guid: TX } } },
          { guid: 's2', price: 4 },
        ],
      }),
    )

    expect(result.bySelection.get('s1')).toBe(12.5)
    expect(result.bySelection.has('s2')).toBe(false)
    expect(result.unattributed).toBe(0)
  })

  // The payment refund equals the lines' net + their tax, so the whole refund is
  // already accounted for line-by-line. Counting the payment too would double it.
  it('does not double-count a payment refund the line refunds already cover', () => {
    const result = checkRefunds(
      check({
        selections: [
          { guid: 's1', price: 30.5, refundDetails: { refundAmount: 30.5, taxRefundAmount: 1.52, refundTransaction: { guid: TX } } },
          { guid: 's2', price: 5, refundDetails: { refundAmount: 5, taxRefundAmount: 0.25, refundTransaction: { guid: TX } } },
        ],
        payments: [
          { guid: 'p1', amount: 37.27, refund: { refundAmount: 37.27, tipRefundAmount: 7.45, refundTransaction: { guid: TX } } },
        ],
      }),
    )

    expect(result.bySelection.get('s1')).toBe(30.5)
    expect(result.bySelection.get('s2')).toBe(5)
    expect(result.unattributed).toBeCloseTo(0, 2)
  })

  // Toast books this as a negative "Custom Amount Refunds" net-sales line. No live
  // selection carries it, so only the payment side reveals it.
  it('reports a payment refund no selection accounts for as unattributed', () => {
    const result = checkRefunds(
      check({
        selections: [{ guid: 's1', price: 75.25 }],
        payments: [
          { guid: 'p1', amount: 78.43, refund: { refundAmount: 78.43, tipRefundAmount: 11.76, refundTransaction: { guid: TX } } },
        ],
      }),
    )

    expect(result.bySelection.size).toBe(0)
    expect(result.unattributed).toBeCloseTo(78.43, 2)
  })

  // A voided selection is never counted as revenue, so its refund must not be
  // deducted either — but it still explains part of the payment-level refund.
  it('lets a voided selection explain a payment refund without deducting it twice', () => {
    const result = checkRefunds(
      check({
        selections: [
          { guid: 's1', price: 20, voided: true, refundDetails: { refundAmount: 20, taxRefundAmount: 1, refundTransaction: { guid: TX } } },
        ],
        payments: [
          { guid: 'p1', amount: 21, refund: { refundAmount: 21, refundTransaction: { guid: TX } } },
        ],
      }),
    )

    expect(result.bySelection.has('s1')).toBe(false)
    expect(result.unattributed).toBeCloseTo(0, 2)
  })

  // Two independent refunds on one check must not borrow each other's attribution.
  it('keeps separate refund transactions independent', () => {
    const result = checkRefunds(
      check({
        selections: [
          { guid: 's1', price: 10, refundDetails: { refundAmount: 10, taxRefundAmount: 0.5, refundTransaction: { guid: 'tx-a' } } },
        ],
        payments: [
          { guid: 'p1', amount: 10.5, refund: { refundAmount: 10.5, refundTransaction: { guid: 'tx-a' } } },
          { guid: 'p2', amount: 40, refund: { refundAmount: 40, refundTransaction: { guid: 'tx-b' } } },
        ],
      }),
    )

    expect(result.bySelection.get('s1')).toBe(10)
    expect(result.unattributed).toBeCloseTo(40, 2)
  })

  it('never returns a negative unattributed remainder when lines over-explain a refund', () => {
    const result = checkRefunds(
      check({
        selections: [
          { guid: 's1', price: 10, refundDetails: { refundAmount: 10, taxRefundAmount: 5, refundTransaction: { guid: TX } } },
        ],
        payments: [{ guid: 'p1', amount: 10, refund: { refundAmount: 10, refundTransaction: { guid: TX } } }],
      }),
    )

    expect(result.unattributed).toBe(0)
  })
})
