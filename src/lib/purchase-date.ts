// src/lib/purchase-date.ts
//
// The single source of truth for the DATE a purchase lands on for reporting.
//
// An invoice's spend is attributed to the invoice's own date — the day the goods
// were received/billed — NOT the day the session happened to be approved in the
// app. A June-dated invoice approved in July must still count toward June's COGS,
// purchasing, and food-cost numbers. Every purchase-spend reader windows on the
// resolved `InvoiceSession.purchaseDate` column, which is computed here at approval
// time (and by the backfill script for historical rows).
//
// `invoiceDate` is a nullable OCR "YYYY-MM-DD" string (see src/lib/invoice-ocr.ts).
// We parse it as UTC midnight — matching both the count-expected.ts received-date
// convention and the UTC-based YYYY-MM-DD windows the COGS report builds, so an
// invoice date maps cleanly onto its calendar-day period. When the string is
// missing or unparseable we fall back to the approval timestamp (then createdAt),
// so purchaseDate is never null for an approved session.

/** Parse an invoice's "YYYY-MM-DD" date string to a Date; null when missing/unparseable. */
export function parseInvoiceDate(s: string | null | undefined): Date | null {
  if (!s) return null
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

/**
 * Resolve the reporting date for a purchase: the invoice's own date, falling back
 * to the approval time, then the session creation time, then now. Never null.
 */
export function resolvePurchaseDate(
  invoiceDate: string | null | undefined,
  approvedAt: Date | null | undefined,
  createdAt?: Date | null | undefined,
): Date {
  return parseInvoiceDate(invoiceDate) ?? approvedAt ?? createdAt ?? new Date()
}
