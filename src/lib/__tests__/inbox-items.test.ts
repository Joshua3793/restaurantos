import { describe, it, expect } from 'vitest'
import { batchSummary, toInboxItems } from '@/lib/invoices/inbox-items'
import type { SessionSummary } from '@/components/invoices/types'

function session(over: Partial<SessionSummary>): SessionSummary {
  return {
    id: 's1', status: 'GROUPING', supplierName: null, invoiceDate: null, invoiceNumber: null, total: null,
    files: [{ id: 'a', fileName: 'a.jpg', ocrStatus: 'PENDING' }, { id: 'b', fileName: 'b.jpg', ocrStatus: 'PENDING' }],
    createdAt: new Date().toISOString(),
    _count: { scanItems: 0, priceAlerts: 0, recipeAlerts: 0 },
    ...over,
  }
}

describe('batchSummary', () => {
  it('counts photos from files and invoices from the draft', () => {
    expect(batchSummary(session({ groupingDraft: { groups: [{}, {}, {}] } }))).toEqual({ photos: 2, invoices: 3 })
  })
  it('reports invoices as null before the batch has been opened (no draft)', () => {
    expect(batchSummary(session({}))).toEqual({ photos: 2, invoices: null })
    expect(batchSummary(session({ groupingDraft: null }))).toEqual({ photos: 2, invoices: null })
  })
})

describe('toInboxItems — a batch is its own kind', () => {
  it('renders a GROUPING session as a batch, not an invoice', () => {
    const [it0] = toInboxItems([session({ groupingDraft: { groups: [{}, {}] } })], [])
    expect(it0.kind).toBe('batch')
    expect(it0.icon).toBe('batch')
    expect(it0.tone).toBe('blue')
    expect(it0.title).toBe('Photo batch')
    expect(it0.meta).toBe('2 PHOTOS · 2 INVOICES FOUND')
    expect(it0.badge).toBe('Unsorted')
    expect(it0.needsAction).toBe(true)
  })
  it('says "not sorted yet" instead of a count before the first open', () => {
    const [it0] = toInboxItems([session({})], [])
    expect(it0.meta).toBe('2 PHOTOS · NOT SORTED YET')
  })
})
