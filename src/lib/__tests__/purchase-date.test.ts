import { describe, it, expect } from 'vitest'
import { parseInvoiceDate, resolvePurchaseDate } from '@/lib/purchase-date'
import { displayDayKey } from '@/lib/prep-day'

const approvedAt = new Date('2026-08-20T18:30:00.000Z')
const createdAt  = new Date('2026-08-19T22:05:00.000Z')

describe('parseInvoiceDate', () => {
  it('reads a YYYY-MM-DD string as UTC midnight — the day-marker convention', () => {
    expect(parseInvoiceDate('2026-08-14')!.toISOString()).toBe('2026-08-14T00:00:00.000Z')
  })

  it('returns null for missing or unparseable input rather than an Invalid Date', () => {
    expect(parseInvoiceDate(null)).toBeNull()
    expect(parseInvoiceDate('')).toBeNull()
    expect(parseInvoiceDate('not a date')).toBeNull()
  })
})

describe('resolvePurchaseDate', () => {
  it('prefers the invoice date — a June invoice keyed in August still counts to June', () => {
    const d = resolvePurchaseDate('2026-06-10', approvedAt, createdAt)
    expect(displayDayKey(d)).toBe('2026-06-10')
  })

  it('falls back to approval time, then creation time, when the OCR date is unusable', () => {
    expect(resolvePurchaseDate(null, approvedAt, createdAt)).toEqual(approvedAt)
    expect(resolvePurchaseDate('garbage', approvedAt, createdAt)).toEqual(approvedAt)
    expect(resolvePurchaseDate(null, null, createdAt)).toEqual(createdAt)
  })

  it('re-resolves when a misread OCR date is corrected', () => {
    // The live case: an invoice OCR'd as 6 Oct, two months in the future. Editing the
    // invoice date has to move purchaseDate with it, or every spend, COGS and
    // theoretical-stock reader keeps windowing on the wrong day.
    const wrong = resolvePurchaseDate('2026-10-06', approvedAt, createdAt)
    expect(displayDayKey(wrong)).toBe('2026-10-06')
    const fixed = resolvePurchaseDate('2026-06-10', approvedAt, createdAt)
    expect(displayDayKey(fixed)).toBe('2026-06-10')
  })

  it('never returns null, so an approved session always has a received date', () => {
    expect(resolvePurchaseDate(null, null, null)).toBeInstanceOf(Date)
  })
})
