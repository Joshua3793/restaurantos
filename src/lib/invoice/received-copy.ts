// Plain-language provenance copy for how an invoice line's quantity was received.
// Pure + client-safe — no imports beyond the type it labels.

import type { ReceivedVia } from '@/lib/invoice/line-qty'

/** Shown only when it tells the reader something the pack does not. */
export function receivedViaLabel(via: ReceivedVia): string | null {
  if (via === 'billed-weight' || via === 'rate') return 'billed weight'
  if (via === 'shipped-unit') return 'shipped by weight'
  return null
}

export function receivedNote(r: { via: ReceivedVia; needsBridge: boolean }): string | null {
  return r.needsBridge
    ? 'Billed by weight, but this item has no weight per each — received through its pack instead.'
    : null
}
