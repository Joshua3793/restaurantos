import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  enqueueMutation, loadQueue, clearQueue, deduplicateQueue, flushQueue,
  savePrepCache, loadPrepCache, savePlanCache, loadPlanCache,
  type OfflineMutation,
} from '../prep-offline'
import type { PrepItemRich, PrepPostInfo } from '@/components/prep/types'

// Minimal localStorage stand-in — the suite runs in node, not jsdom.
function installLocalStorage() {
  const store = new Map<string, string>()
  ;(globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size },
  } as Storage
}

/** Capture the request bodies flushQueue sends, in order. */
function mockFetch(logId = 'srv-log-1') {
  const calls: { url: string; method: string; body: Record<string, unknown> }[] = []
  const fn = vi.fn(async (url: string, init: { method: string; body: string }) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body) })
    return { ok: true, status: 200, json: async () => ({ id: logId }) } as unknown as Response
  })
  ;(globalThis as unknown as { fetch: typeof fn }).fetch = fn
  return calls
}

/** A draft_edit entry as the page would enqueue it. */
function draftEdit(itemId: string, patch: Record<string, unknown>, logId: string | null = 'log-1') {
  return { type: 'draft_edit' as const, itemId, logId, revenueCenterId: 'rc-1', patch }
}

describe('prep offline queue — draft_edit merging', () => {
  beforeEach(() => { installLocalStorage(); clearQueue() })

  it('merges patches for one item field-by-field instead of keeping only the last', () => {
    enqueueMutation(draftEdit('item-1', { requiredQty: 4 }))
    enqueueMutation(draftEdit('item-1', { note: 'double batch' }))

    const out = deduplicateQueue(loadQueue())

    expect(out).toHaveLength(1)
    expect(out[0].patch).toEqual({ requiredQty: 4, note: 'double batch' })
  })

  it('lets a later edit of the same field win', () => {
    enqueueMutation(draftEdit('item-1', { requiredQty: 4 }))
    enqueueMutation(draftEdit('item-1', { requiredQty: 6 }))

    const out = deduplicateQueue(loadQueue())

    expect(out).toHaveLength(1)
    expect(out[0].patch).toEqual({ requiredQty: 6 })
  })

  it('keeps different items separate', () => {
    enqueueMutation(draftEdit('item-1', { requiredQty: 4 }))
    enqueueMutation(draftEdit('item-2', { requiredQty: 9 }))

    const out = deduplicateQueue(loadQueue())

    expect(out.map(m => m.itemId)).toEqual(['item-1', 'item-2'])
  })

  it('does not merge across a post — edits after a post stay after it', () => {
    enqueueMutation(draftEdit('item-1', { requiredQty: 4 }))
    enqueueMutation({ type: 'post', itemId: '', revenueCenterId: 'rc-1' })
    enqueueMutation(draftEdit('item-1', { requiredQty: 9 }))

    const out = deduplicateQueue(loadQueue())

    expect(out.map(m => m.type)).toEqual(['draft_edit', 'post', 'draft_edit'])
    expect(out[0].patch).toEqual({ requiredQty: 4 })
    expect(out[2].patch).toEqual({ requiredQty: 9 })
  })

  it('orders a merged edit before the post that follows it', () => {
    enqueueMutation(draftEdit('item-1', { requiredQty: 4 }))
    enqueueMutation(draftEdit('item-1', { note: 'sub the herbs' }))
    enqueueMutation({ type: 'post', itemId: '', revenueCenterId: 'rc-1' })

    const out = deduplicateQueue(loadQueue())

    expect(out.map(m => m.type)).toEqual(['draft_edit', 'post'])
  })
})

describe('prep offline queue — post and remove_item', () => {
  beforeEach(() => { installLocalStorage(); clearQueue() })

  it('keeps only the last post per revenue center', () => {
    enqueueMutation({ type: 'post', itemId: '', revenueCenterId: 'rc-1' })
    enqueueMutation({ type: 'post', itemId: '', revenueCenterId: 'rc-1' })
    enqueueMutation({ type: 'post', itemId: '', revenueCenterId: 'rc-2' })

    const out = deduplicateQueue(loadQueue())

    expect(out).toHaveLength(2)
    expect(out.map(m => m.revenueCenterId)).toEqual(['rc-1', 'rc-2'])
  })

  it('keeps only the last remove_item per item, so remove-then-undo cancels out', () => {
    enqueueMutation({ type: 'remove_item', itemId: 'item-1', revenueCenterId: 'rc-1' })
    enqueueMutation({ type: 'remove_item', itemId: 'item-1', revenueCenterId: 'rc-1', restore: true })

    const out = deduplicateQueue(loadQueue())

    expect(out).toHaveLength(1)
    expect(out[0].restore).toBe(true)
  })

  it('flushes a remove_item to the remove-item route', async () => {
    const calls = mockFetch()
    enqueueMutation({ type: 'remove_item', itemId: 'item-1', revenueCenterId: 'rc-1' })

    await flushQueue()

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/prep/plan/remove-item')
    expect(calls[0].body).toEqual({ revenueCenterId: 'rc-1', prepItemId: 'item-1', restore: false })
  })

  it('flushes a post to the plan post route', async () => {
    const calls = mockFetch()
    enqueueMutation({ type: 'post', itemId: '', revenueCenterId: 'rc-1' })

    await flushQueue()

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/prep/plan/post')
    expect(calls[0].body).toEqual({ revenueCenterId: 'rc-1' })
  })
})

describe('prep offline queue — log resolution', () => {
  beforeEach(() => { installLocalStorage(); clearQueue() })

  it('PUTs a draft_edit straight to a real log id', async () => {
    const calls = mockFetch()
    enqueueMutation(draftEdit('item-1', { requiredQty: 4 }, 'log-real'))

    await flushQueue()

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/prep/logs/log-real')
    expect(calls[0].method).toBe('PUT')
    expect(calls[0].body).toEqual({ requiredQty: 4 })
  })

  it('creates the log first when there is no id, carrying the patch in the POST', async () => {
    const calls = mockFetch('srv-99')
    enqueueMutation(draftEdit('item-1', { requiredQty: 4 }, null))

    await flushQueue()

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/prep/logs')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].body).toEqual({ prepItemId: 'item-1', revenueCenterId: 'rc-1', requiredQty: 4 })
  })

  it('treats an _opt_ id as "not on the server yet" rather than PUTting to it', async () => {
    const calls = mockFetch('srv-99')
    enqueueMutation(draftEdit('item-1', { requiredQty: 4 }, '_opt_item-1'))

    await flushQueue()

    expect(calls.map(c => c.url)).not.toContain('/api/prep/logs/_opt_item-1')
    expect(calls[0].url).toBe('/api/prep/logs')
  })

  it('does the same for a status mutation carrying an _opt_ id', async () => {
    const calls = mockFetch('srv-99')
    enqueueMutation({ type: 'status', itemId: 'item-1', logId: '_opt_item-1', status: 'DONE', actualQty: 3, revenueCenterId: 'rc-1' })

    await flushQueue()

    expect(calls[0].url).toBe('/api/prep/logs')
    expect(calls[1].url).toBe('/api/prep/logs/srv-99')
    expect(calls[1].body).toEqual({ status: 'DONE', actualPrepQty: 3 })
  })
})

describe('prep offline queue — existing types still dedupe', () => {
  beforeEach(() => { installLocalStorage(); clearQueue() })

  it('keeps the last isOnList toggle, status and priority per item', () => {
    enqueueMutation({ type: 'isOnList_toggle', itemId: 'a', isOnList: true })
    enqueueMutation({ type: 'isOnList_toggle', itemId: 'a', isOnList: false })
    enqueueMutation({ type: 'priority', itemId: 'a', priority: 'PASS' })
    enqueueMutation({ type: 'priority', itemId: 'a', priority: 'MID' })

    const out = deduplicateQueue(loadQueue())

    expect(out).toHaveLength(2)
    expect(out.find(m => m.type === 'isOnList_toggle')?.isOnList).toBe(false)
    expect(out.find(m => m.type === 'priority')?.priority).toBe('MID')
  })
})

describe('prep caches', () => {
  beforeEach(() => { installLocalStorage() })

  const item = { id: 'i1', name: 'Aioli' } as unknown as PrepItemRich

  it('stamps a fetch time when one is given', () => {
    savePrepCache([item], { fetchedAt: 1_000 })
    expect(loadPrepCache()?.ts).toBe(1_000)
  })

  it('preserves the existing fetch time on an optimistic re-save', () => {
    savePrepCache([item], { fetchedAt: 1_000 })
    savePrepCache([item, { id: 'i2', name: 'Salsa' } as unknown as PrepItemRich])

    const cached = loadPrepCache()
    expect(cached?.ts).toBe(1_000)
    expect(cached?.items).toHaveLength(2)
  })

  it('round-trips the plan post header', () => {
    const post = { id: 'p1', postedAt: '2026-09-02T10:00:00.000Z', postedByName: 'Chef', itemCount: 3, activeMinutes: 90, dirty: false } as PrepPostInfo
    savePlanCache(post)
    expect(loadPlanCache()?.post).toEqual(post)
  })

  it('round-trips a null post', () => {
    savePlanCache(null)
    expect(loadPlanCache()?.post).toBeNull()
  })
})
