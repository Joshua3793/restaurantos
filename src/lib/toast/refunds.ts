/**
 * Refund accounting for the Toast sales sync.
 *
 * Toast's own net sales are `gross − discounts − refunds`. Discounts need no
 * work here: `selection.price` is already post-discount. Refunds do, and they
 * arrive in two shapes that have to be handled together or the total is wrong:
 *
 *  1. **Line-level** — `selection.refundDetails`. The selection is NOT voided
 *     and keeps its full `price`, so without an explicit subtraction the line
 *     reads as full revenue.
 *  2. **Payment-level** — `check.payments[].refund`, with nothing on any live
 *     selection to show for it. Toast books these as a negative net-sales line
 *     under the "Custom Amount Refunds" sales category. Reading only shape 1
 *     misses them entirely.
 *
 * The two overlap: a normal line refund ALSO shows up as a payment refund for
 * the same transaction, so naively adding both double-counts it. The fix is to
 * settle each refund transaction separately — a payment refund covers net sales
 * plus tax, so whatever its selections already explain (`refundAmount +
 * taxRefundAmount`) is subtracted, and only the remainder is genuinely
 * unattributed.
 *
 * Verified against `SalesSummary_2026-07-26_2026-08-08.xlsx`: this reproduces
 * Toast's "Sales refunds" line to the cent on all 14 days ($302.93 = $224.50
 * line-level + $78.43 unattributed).
 */

import type { ToastCheck } from '@/lib/toast/client'

export interface CheckRefunds {
  /**
   * Selection guid → net-sales amount to subtract from that line. Only LIVE
   * selections appear: a voided selection was never counted as revenue, so
   * deducting its refund would subtract it twice.
   */
  bySelection: Map<string, number>
  /**
   * Refunded net sales no live selection accounts for. Belongs to the check as
   * a whole, so the caller attributes it at order level.
   */
  unattributed: number
}

/** Floating-point noise guard — Toast amounts are cents. */
function isMeaningful(n: number): boolean {
  return Math.abs(n) >= 0.005
}

/**
 * Splits a check's refunds into per-selection deductions and a leftover the
 * selections don't explain. PURE — no database, no network.
 *
 * Pass a check only if it is neither voided nor deleted; a voided check has no
 * revenue to refund in the first place.
 */
export function checkRefunds(check: ToastCheck): CheckRefunds {
  const bySelection = new Map<string, number>()

  // What each refund transaction is already explained by, from the line side.
  // Voided selections count toward the explanation (they justify part of the
  // payment refund) but never toward `bySelection`.
  const explained = new Map<string, number>()

  for (const sel of check.selections ?? []) {
    const rd = sel.refundDetails
    if (!rd) continue

    const net = rd.refundAmount ?? 0
    const tax = rd.taxRefundAmount ?? 0
    const txGuid = rd.refundTransaction?.guid ?? ''
    explained.set(txGuid, (explained.get(txGuid) ?? 0) + net + tax)

    if (sel.voided || sel.deferred) continue
    if (isMeaningful(net)) bySelection.set(sel.guid, (bySelection.get(sel.guid) ?? 0) + net)
  }

  let unattributed = 0
  for (const payment of check.payments ?? []) {
    const refund = payment.refund
    if (!refund) continue

    const txGuid = refund.refundTransaction?.guid ?? ''
    // Clamped at zero: over-explanation means the lines already cover the whole
    // refund, never that revenue should be added back.
    const remainder = (refund.refundAmount ?? 0) - (explained.get(txGuid) ?? 0)
    if (isMeaningful(remainder) && remainder > 0) unattributed += remainder
  }

  return { bySelection, unattributed }
}
