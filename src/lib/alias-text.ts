// The ONE normaliser for supplier wordings (ItemSupplierAlias.text). The matcher,
// the approve upsert, the merge and the backfill all key aliases through it, so
// two spellings that differ only in case, accents or punctuation are one alias.
// Pure — no imports — so client and server share it.

/** Letters NFKD leaves whole (no base letter + mark), so the strip below would
 *  turn them into a space ("Weißwurst" → "wei wurst"). Folded explicitly,
 *  after lower-casing (ẞ → ß, Æ → æ, …), before the strip. */
const NO_DECOMPOSITION: Record<string, string> = {
  'ß': 'ss', 'æ': 'ae', 'ø': 'o', 'œ': 'oe', 'ð': 'd', 'þ': 'th', 'ł': 'l',
}

/** NFKD → drop accents → lower → fold ß/æ/ø/œ/ð/þ/ł → everything but
 *  [a-z0-9 ] becomes a space → collapse whitespace → trim. '' when blank.
 *  Digits and letters are never split apart: "10LB" and "10 LB" are
 *  deliberately DIFFERENT keys (splitting would also merge codes like
 *  "A10B" / "A 10 B"); a supplier printing both spellings gets two aliases. */
export function normaliseAliasText(s: string | null | undefined): string {
  if (!s) return ''
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // combining marks: "é" → "e", never "e "
    .toLowerCase()
    .replace(/[ßæøœðþł]/g, ch => NO_DECOMPOSITION[ch])
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** An invoice wording typed in as an item name: at least 3 words AND at least
 *  70 % of its letters upper-case (digits and punctuation ignored). Short codes
 *  ("GF BUN") and plain names ("Red Grapes") pass. */
export function isShoutyName(name: string): boolean {
  const words = (name ?? '').split(/[^A-Za-z0-9À-ɏ]+/).filter(Boolean)
  if (words.length < 3) return false
  const letters = (name.match(/\p{L}/gu) ?? [])
  if (letters.length === 0) return false
  const upper = letters.filter(ch => ch !== ch.toLowerCase() && ch === ch.toUpperCase()).length
  return upper / letters.length >= 0.7
}

/** The invoice path's hint: there, the wording really is kept (as the
 *  supplier's own wording, learned at approve). */
export const SHOUTY_HINT = 'That looks like an invoice wording, not a plain name. Give it a plain name (for example "Red Grapes") — the invoice wording is kept as the supplier\'s own.'

/** Every other create path (Add Item, count quick-add): no invoice is in hand,
 *  so nothing is kept — the hint promises nothing about a wording. */
export const SHOUTY_HINT_PLAIN = 'That looks like an invoice wording, not a plain name. Give it a plain name (for example "Red Grapes").'
