// Pure decision for the invoice drawer's "saving / save failed" chip. Pulled
// out of InvoiceReviewDrawer.tsx so the aggregation rule is testable without
// React: a batch of PATCHes (flushPendingEdits' Promise.all) used to have EACH
// call set the chip itself, so whichever call resolved LAST won the race — a
// later-resolving success silently erased an earlier failure's indicator even
// though that earlier edit never reached the server.

export type SaveStatus = 'idle' | 'saving' | 'error'

/** Aggregates one flush batch's PATCH results into ONE save status. Error wins:
 *  if ANY patch in the batch failed, the batch reports 'error' even when every
 *  other patch in the same Promise.all succeeded. */
export function aggregateSaveResult(results: boolean[]): 'idle' | 'error' {
  return results.every(Boolean) ? 'idle' : 'error'
}
