import { describe, it, expect } from 'vitest'
import { batchSummary, toInboxItems, filterByChip, inboxCounts, todaysDeliveries, DEFAULT_CHIP, type Signal } from '@/lib/invoices/inbox-items'
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

describe('a still-reading invoice says so', () => {
  it('shows "Reading invoice…" with the page count, not "Unknown supplier · 0 lines"', () => {
    const [it0] = toInboxItems([session({ status: 'PROCESSING' })], [])
    expect(it0.title).toBe('Reading invoice…')
    expect(it0.meta).toBe('2 PAGES · ABOUT 30 SECONDS')
    expect(it0.needsAction).toBe(false)
  })
  it('a dead upload (no photos) keeps the plain card', () => {
    const [it0] = toInboxItems([session({ status: 'UPLOADING', files: [] })], [])
    expect(it0.title).not.toBe('Sending invoice…')
  })
})

describe('phone chips: Invoices first, alerts kept apart', () => {
  const sig: Signal = {
    id: 'g1', fingerprint: 'f', rule: 'RECIPE_DRIFT', severity: 'warn', title: 'Side Pulled Pork drifted', body: '',
    verbLabel: '', verbHref: '', impactValue: null, itemId: null, recipeId: null, status: 'OPEN', createdAt: new Date().toISOString(),
  }
  const items = toInboxItems([session({ id: 'r', status: 'REVIEW' }), session({ id: 'e', status: 'ERROR' })], [sig])
  it('defaults to Invoices', () => { expect(DEFAULT_CHIP).toBe('invoices') })
  it('Invoices holds every session card (failed scans too) and no alert', () => {
    const vis = filterByChip(items, 'invoices')
    expect(vis.map(i => i.kind)).not.toContain('signal')
    expect(vis).toHaveLength(2)
    expect(inboxCounts(items).invoices).toBe(2)
    expect(inboxCounts(items).prices).toBe(1)
  })
})

describe('todaysDeliveries', () => {
  const now = new Date(2026, 10, 27, 14, 0)
  it('keeps today’s in-progress and approved invoices, newest first; drops batches, errors and old days', () => {
    const list = todaysDeliveries([
      session({ id: 'a', status: 'APPROVED', createdAt: new Date(2026, 10, 27, 9).toISOString() }),
      session({ id: 'b', status: 'REVIEW', createdAt: new Date(2026, 10, 27, 11).toISOString() }),
      session({ id: 'c', status: 'GROUPING', createdAt: new Date(2026, 10, 27, 12).toISOString() }),
      session({ id: 'd', status: 'ERROR', createdAt: new Date(2026, 10, 27, 12).toISOString() }),
      session({ id: 'e', status: 'APPROVED', createdAt: new Date(2026, 10, 20, 9).toISOString() }),
      session({ id: 'f', status: 'APPROVED', createdAt: new Date(2026, 10, 26, 9).toISOString(), invoiceDate: '2026-11-27T00:00:00.000Z' }),
    ], now)
    expect(list.map(s => s.id)).toEqual(['b', 'a', 'f'])
  })
})
