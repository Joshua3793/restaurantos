// The note an approved invoice carries (InvoiceSession.errorMessage) when some
// of its lines did not go through the normal way. Pure, plain English.
// (plan 2026-10-05 item-backbone-5-invoice-accuracy, Task 3.)

export interface NoteLine {
  /** The invoice's own wording for the line. */
  description: string
  /** The product it was received into, when there is one. */
  itemName: string | null
  /** The decision's message (approve-outcome) — its advice is dropped here. */
  message: string
}

const ADVICE = 'or receive the stock and keep the old price'

/**
 * A decision message as a clause for the note: the "fix it, or receive…" advice
 * dropped (the invoice is already approved), "— check the unit" dropped, the
 * remaining sentences joined with "and", no closing full stop.
 */
export function noteReason(message: string): string {
  const sentences = message
    .replace(/\s+—\s+check the unit\./g, '.')
    // A sentence ends at a full stop followed by a space (amounts like "1.81 kg" have none).
    .split(/(?<=\.)\s+/)
    .map(s => s.trim())
    .filter(s => s && !s.includes(ADVICE))
    .map(s => s.replace(/\.$/, ''))
  const lower = (s: string) => s.replace(/^(This|Price) /, (_m, w: string) => `${w.toLowerCase()} `)
  return sentences.map(lower).join(' and ')
}

const plural = (n: number) => (n === 1 ? '' : 's')
const entry = (l: NoteLine) => `${l.itemName?.trim() || l.description} — ${noteReason(l.message)}`

export function buildApproveNote(a: {
  /** Lines received with their price left as it was (the reviewer's choice, or a late change). */
  receivedWithoutPrice: NoteLine[]
  /** Priced lines that could not be received at all (only reachable when data moved mid-approval). */
  skippedPrice: NoteLine[]
  /** Create-new lines whose product was not created, each reason as approve wrote it. */
  skippedCreateNew: string[]
  createNewNameRefused: boolean
}): string | null {
  const parts: string[] = []

  const r = a.receivedWithoutPrice.length
  if (r > 0) {
    parts.push(
      `${r} line${plural(r)} ${r === 1 ? 'was' : 'were'} received without a price change: ` +
      `${a.receivedWithoutPrice.map(entry).join('; ')}. ` +
      (r === 1 ? 'The stock is in; the price was left as it was.' : 'The stock is in; the prices were left as they were.'),
    )
  }

  const s = a.skippedPrice.length
  if (s > 0) {
    parts.push(
      `${s} line${plural(s)} ${s === 1 ? 'was not received and its price was' : 'were not received and their prices were'} not changed: ` +
      `${a.skippedPrice.map(entry).join('; ')}.`,
    )
  }

  const n = a.skippedCreateNew.length
  if (n > 0) {
    // Each reason may end in its own full stop (the hints do) — strip it so the
    // joined sentence ends in exactly one. The session is APPROVED and nothing
    // returns an approved invoice to review, so the only way to create the
    // product is to delete the invoice and scan it again.
    const reasons = a.skippedCreateNew.map(x => x.replace(/[.\s]+$/, ''))
    parts.push(
      `${n} new product${plural(n)} ${n === 1 ? 'was' : 'were'} not created — ${reasons.join('; ')}. ` +
      (a.createNewNameRefused
        ? 'Delete this invoice and scan it again with a plain name.'
        : `Delete this invoice and scan it again to create ${n === 1 ? 'it' : 'them'}.`),
    )
  }

  return parts.length > 0 ? parts.join(' ') : null
}
