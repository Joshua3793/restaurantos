import { describe, it, expect } from 'vitest'
import { canDiscardFromInbox } from '@/lib/invoices/inbox-items'

const NOW = Date.parse('2026-11-23T12:00:00Z')
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()
const s = (status: string, createdMinAgo: number, scanItems = 0, parentSessionId: string | null = null) => ({
  status: status as never, createdAt: ago(createdMinAgo), parentSessionId,
  _count: { scanItems, priceAlerts: 0, recipeAlerts: 0 },
})

describe('canDiscardFromInbox', () => {
  it('an upload stuck for a month with nothing in it can be deleted', () => {
    expect(canDiscardFromInbox(s('UPLOADING', 60 * 24 * 31), NOW)).toBe(true)
  })
  it('an upload still in its first two minutes cannot', () => {
    expect(canDiscardFromInbox(s('UPLOADING', 1), NOW)).toBe(false)
  })
  it('a failed scan with no lines can be deleted; one with lines stays a manager call', () => {
    expect(canDiscardFromInbox(s('ERROR', 30), NOW)).toBe(true)
    expect(canDiscardFromInbox(s('ERROR', 30, 4), NOW)).toBe(false)
  })
  it('an unsorted batch can be discarded (unchanged)', () => {
    expect(canDiscardFromInbox(s('GROUPING', 0), NOW)).toBe(true)
  })
  it('work in flight or waiting for review is never offered', () => {
    for (const st of ['PROCESSING', 'APPROVING', 'REVIEW', 'APPROVED']) {
      expect(canDiscardFromInbox(s(st, 600), NOW)).toBe(false)
    }
  })
  it('an RC copy never goes alone', () => {
    expect(canDiscardFromInbox(s('ERROR', 30, 0, 'parent'), NOW)).toBe(false)
  })
})
