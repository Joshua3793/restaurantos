/** Display model for stock: theoretical headline + the real counted anchor. */
export interface StockDisplay {
  theoretical: number
  counted: number | null
  lastCountDate: string | null
}

/** Short label e.g. "1.4 L · counted 2.0 on Jun 8". counted null → theoretical only. */
export function formatStockOnHand(d: StockDisplay, unit: string): string {
  const head = `${Number(d.theoretical).toFixed(2)} ${unit}`
  if (d.counted == null || d.lastCountDate == null) return head
  const date = new Date(d.lastCountDate).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })
  return `${head} · counted ${Number(d.counted).toFixed(2)} on ${date}`
}
