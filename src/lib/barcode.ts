// Barcode shape rules shared by the scanner sheets and the link route.

/** What a barcode may look like once trimmed: 6–32 letters, digits or dashes. */
export const BARCODE_RE = /^[0-9A-Za-z-]{6,32}$/

/** Trimmed code, or null when it is not a usable barcode. */
export function normalizeBarcode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const code = raw.trim()
  return BARCODE_RE.test(code) ? code : null
}

/**
 * The spellings one printed barcode can arrive in. A UPC-A (12 digits) is the
 * same code as the EAN-13 with a leading 0 — phone decoders and handheld
 * scanners disagree on which they report, so a lookup tries both.
 */
export function barcodeVariants(code: string): string[] {
  const c = code.trim()
  const out = [c]
  if (/^\d{12}$/.test(c)) out.push(`0${c}`)
  else if (/^0\d{12}$/.test(c)) out.push(c.slice(1))
  return out
}
