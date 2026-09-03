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

type Call = { url: string; method: string; body: Record<string, unknown>; index: number }

const okRes = (body: Record<string, unknown> = {}) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response
const errRes = (status: number) =>
  ({ ok: false, status, json: async () => ({ error: `HTTP ${status}` }) }) as unknown as Response

/**
 * Like `mockFetch`, but the caller decides each response — return a Response,
 * or throw to simulate a dead network.
 */
function mockFetchWith(respond: (call: Call) => Response) {
  const calls: Call[] = []
  const fn = vi.fn(async (url: string, init: { method: string; body: string }) => {
    const call: Call = { url, method: init.method, body: JSON.parse(init.body), index: calls.length }
    calls.push(call)
    return respond(call)
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

// THE SEGMENT RULE (see the comment above `keyOf` in prep-offline.ts). `post`
// rebuilds the kitchen's list from `isOnList` as it stands when the request
// lands, and clears postedAt for everything not in it — so an isOnList write
// made BEFORE a post must reach the server before that post, and one made after
// must stay after. Collapsing them together emits the survivor at the LAST
// occurrence's position, which is on the wrong side of the post.
describe('prep offline queue — isOnList writes never collapse across a post', () => {
  beforeEach(() => { installLocalStorage(); clearQueue() })

  it('keeps an isOnList toggle that preceded a post, so the post is built from the draft the chef had', () => {
    // Chef adds Aioli to the draft, posts, then thinks better of it and removes it.
    enqueueMutation({ type: 'isOnList_toggle', itemId: 'aioli', isOnList: true })
    enqueueMutation({ type: 'post', itemId: '', revenueCenterId: 'rc-1' })
    enqueueMutation({ type: 'isOnList_toggle', itemId: 'aioli', isOnList: false })

    const out = deduplicateQueue(loadQueue())

    expect(out.map(m => [m.type, m.isOnList])).toEqual([
      ['isOnList_toggle', true],
      ['post', undefined],
      ['isOnList_toggle', false],
    ])
  })

  it('keeps an isOnList toggle that TOOK an item off before a post, so the post cannot put it back', () => {
    // The mirror: dropped, the post would see isOnList:true and send a cook to
    // prep something the chef deliberately pulled.
    enqueueMutation({ type: 'isOnList_toggle', itemId: 'aioli', isOnList: false })
    enqueueMutation({ type: 'post', itemId: '', revenueCenterId: 'rc-1' })
    enqueueMutation({ type: 'isOnList_toggle', itemId: 'aioli', isOnList: true })

    const out = deduplicateQueue(loadQueue())

    expect(out.map(m => [m.type, m.isOnList])).toEqual([
      ['isOnList_toggle', false],
      ['post', undefined],
      ['isOnList_toggle', true],
    ])
  })

  it('keeps a remove_item that preceded a post separate from the restore that followed it', () => {
    enqueueMutation({ type: 'remove_item', itemId: 'aioli', revenueCenterId: 'rc-1' })
    enqueueMutation({ type: 'post', itemId: '', revenueCenterId: 'rc-1' })
    enqueueMutation({ type: 'remove_item', itemId: 'aioli', revenueCenterId: 'rc-1', restore: true })

    const out = deduplicateQueue(loadQueue())

    expect(out.map(m => [m.type, m.restore ?? false])).toEqual([
      ['remove_item', false],
      ['post', false],
      ['remove_item', true],
    ])
  })

  it('still collapses two posts around one removal down to that removal and the last post', () => {
    // The third row of the table: already correct before the segment rule, and
    // it has to stay correct. The removal sits in segment 1 either way, and the
    // two posts share a key because they share a revenue center.
    enqueueMutation({ type: 'post', itemId: '', revenueCenterId: 'rc-1' })
    enqueueMutation({ type: 'remove_item', itemId: 'aioli', revenueCenterId: 'rc-1' })
    enqueueMutation({ type: 'post', itemId: '', revenueCenterId: 'rc-1' })

    const out = deduplicateQueue(loadQueue())

    expect(out.map(m => m.type)).toEqual(['remove_item', 'post'])
  })

  it('flushes a pre-post isOnList toggle to the server BEFORE the post itself', async () => {
    const calls = mockFetch()
    enqueueMutation({ type: 'isOnList_toggle', itemId: 'aioli', isOnList: true })
    enqueueMutation({ type: 'post', itemId: '', revenueCenterId: 'rc-1' })
    enqueueMutation({ type: 'isOnList_toggle', itemId: 'aioli', isOnList: false })

    await flushQueue()

    expect(calls.map(c => c.url)).toEqual([
      '/api/prep/items/aioli',
      '/api/prep/plan/post',
      '/api/prep/items/aioli',
    ])
    expect(calls[0].body).toEqual({ isOnList: true })
    expect(calls[2].body).toEqual({ isOnList: false })
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

  it('round-trips the plan post header alongside the revenue center it belongs to', () => {
    const post = { id: 'p1', postedAt: '2026-09-02T10:00:00.000Z', postedByName: 'Chef', itemCount: 3, activeMinutes: 90, dirty: false } as PrepPostInfo
    savePlanCache(post, 'rc-1')
    const cached = loadPlanCache()
    expect(cached?.post).toEqual(post)
    expect(cached?.revenueCenterId).toBe('rc-1')
  })

  it('round-trips a null post', () => {
    savePlanCache(null, 'rc-1')
    expect(loadPlanCache()?.post).toBeNull()
  })

  it('round-trips a null revenue center (no RC active)', () => {
    savePlanCache(null, null)
    expect(loadPlanCache()?.revenueCenterId).toBeNull()
  })

  it('normalizes a pre-upgrade cache entry with no revenueCenterId field to null, not a match for any RC', () => {
    localStorage.setItem('prep_plan_v1', JSON.stringify({ post: null, ts: Date.now() }))
    expect(loadPlanCache()?.revenueCenterId).toBeNull()
  })
})

describe('prep offline queue — a failed request is never counted as synced', () => {
  beforeEach(() => { installLocalStorage(); clearQueue() })

  it('counts a 404 from remove-item as failed, not synced', async () => {
    // The route 404s and writes NOTHING when the item belongs to another
    // revenue center — the case that silently left the job on the To Do.
    mockFetchWith(() => errRes(404))
    enqueueMutation({ type: 'remove_item', itemId: 'item-1', revenueCenterId: 'rc-1' })

    expect(await flushQueue()).toEqual({ synced: 0, failed: 1, kept: 0 })
  })

  it('counts a 400 from plan/post as failed', async () => {
    mockFetchWith(() => errRes(400))   // "Nothing on the list to post"
    enqueueMutation({ type: 'post', itemId: '', revenueCenterId: 'rc-1' })

    expect(await flushQueue()).toEqual({ synced: 0, failed: 1, kept: 0 })
  })

  it('counts a 403 on the draft_edit PUT as failed', async () => {
    mockFetchWith(() => errRes(403))   // non-LEAD editing plan fields
    enqueueMutation(draftEdit('item-1', { requiredQty: 4 }, 'log-real'))

    expect(await flushQueue()).toEqual({ synced: 0, failed: 1, kept: 0 })
  })

  it('marks the mutation failed and skips the PUT when the log create fails', async () => {
    // ensureLogId returns { id: null } — proceeding would PUT to /undefined.
    const calls = mockFetchWith(() => errRes(400))
    enqueueMutation({ type: 'status', itemId: 'item-1', logId: '_opt_item-1', status: 'DONE', actualQty: 3, revenueCenterId: 'rc-1' })

    expect(await flushQueue()).toEqual({ synced: 0, failed: 1, kept: 0 })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/prep/logs')
  })

  it('marks it failed when a 2xx create comes back without an id', async () => {
    const calls = mockFetchWith(() => okRes({}))
    enqueueMutation(draftEdit('item-1', { requiredQty: 4 }, null))

    expect(await flushQueue()).toEqual({ synced: 0, failed: 1, kept: 0 })
    expect(calls).toHaveLength(1)
    expect(loadQueue()).toHaveLength(0)   // a bad contract will not fix itself
  })
})

describe('prep offline queue — retry vs drop', () => {
  beforeEach(() => { installLocalStorage(); clearQueue() })

  it('drops a 4xx from the queue rather than retrying it forever', async () => {
    mockFetchWith(() => errRes(403))
    enqueueMutation({ type: 'post', itemId: '', revenueCenterId: 'rc-1' })

    await flushQueue()

    expect(loadQueue()).toHaveLength(0)
  })

  it('keeps a 5xx for the next flush, reported as kept rather than failed', async () => {
    mockFetchWith(() => errRes(503))
    enqueueMutation({ type: 'remove_item', itemId: 'item-1', revenueCenterId: 'rc-1' })

    const res = await flushQueue()

    // This is the case Fix 2 exists for: work that is safely queued for retry
    // must not be reported the same way as work that was permanently dropped.
    expect(res).toEqual({ synced: 0, failed: 0, kept: 1 })
    const left = loadQueue()
    expect(left).toHaveLength(1)
    expect(left[0].type).toBe('remove_item')
  })

  it('keeps the un-attempted remainder when the network drops mid-flush, and never attempts them', async () => {
    // First mutation lands, then the connection dies. The two behind it were
    // never attempted and must not be wiped.
    const calls = mockFetchWith(call => {
      if (call.index === 0) return okRes({ id: 'srv-1' })
      throw new TypeError('Failed to fetch')
    })
    enqueueMutation({ type: 'priority', itemId: 'a', priority: 'PASS' })
    enqueueMutation({ type: 'remove_item', itemId: 'b', revenueCenterId: 'rc-1' })
    enqueueMutation({ type: 'post', itemId: '', revenueCenterId: 'rc-1' })

    const res = await flushQueue()

    expect(res.synced).toBe(1)
    expect(loadQueue().map(m => m.type)).toEqual(['remove_item', 'post'])
    // Pins that the flush actually STOPPED at the transient failure instead of
    // attempting (and failing) the remaining queued mutations too.
    expect(calls).toHaveLength(2)
  })

  it('reports a permanent drop and a kept retry separately in the same flush', async () => {
    mockFetchWith(call => (call.index === 0 ? errRes(404) : errRes(503)))
    enqueueMutation({ type: 'remove_item', itemId: 'a', revenueCenterId: 'rc-1' })
    enqueueMutation({ type: 'priority', itemId: 'b', priority: 'PASS' })

    const res = await flushQueue()

    expect(res).toEqual({ synced: 0, failed: 1, kept: 1 })
  })

  it('keeps a 401 for the next flush instead of dropping the queue — a lapsed session is not a decision about the mutation', async () => {
    mockFetchWith(() => errRes(401))
    enqueueMutation({ type: 'remove_item', itemId: 'item-1', revenueCenterId: 'rc-1' })

    const res = await flushQueue()

    expect(res).toEqual({ synced: 0, failed: 0, kept: 1 })
    expect(loadQueue()).toHaveLength(1)
  })

  it('keeps a 429 for the next flush — a rate limit is not a decision about the mutation', async () => {
    mockFetchWith(() => errRes(429))
    enqueueMutation({ type: 'post', itemId: '', revenueCenterId: 'rc-1' })

    const res = await flushQueue()

    expect(res).toEqual({ synced: 0, failed: 0, kept: 1 })
    expect(loadQueue()).toHaveLength(1)
  })

  it('keeps a 408 for the next flush — a timeout is not a decision about the mutation', async () => {
    mockFetchWith(() => errRes(408))
    enqueueMutation({ type: 'isOnList_toggle', itemId: 'item-1', isOnList: true })

    const res = await flushQueue()

    expect(res).toEqual({ synced: 0, failed: 0, kept: 1 })
    expect(loadQueue()).toHaveLength(1)
  })

  it('drops a persistently transient mutation after MAX_ATTEMPTS instead of retrying it forever', async () => {
    mockFetchWith(() => errRes(503))
    enqueueMutation({ type: 'remove_item', itemId: 'a', revenueCenterId: 'rc-1' })

    let res: Awaited<ReturnType<typeof flushQueue>> | undefined
    for (let i = 0; i < 5; i++) {
      res = await flushQueue()
    }

    expect(res).toEqual({ synced: 0, failed: 1, kept: 0 })
    expect(loadQueue()).toHaveLength(0)   // a dead endpoint no longer blocks the queue forever
  })

  it('carries the accumulated attempt count into a merged draft_edit survivor, so a new same-item edit does not reset the cap', async () => {
    // Flush 1: the edit fails transiently 4 times, so attempts climbs to 4
    // (one below MAX_ATTEMPTS) and is written back into the queue.
    mockFetchWith(() => errRes(503))
    enqueueMutation(draftEdit('item-1', { requiredQty: 4 }, 'log-real'))
    for (let i = 0; i < 4; i++) await flushQueue()
    expect(loadQueue()).toHaveLength(1)
    expect(loadQueue()[0].attempts).toBe(4)

    // Still offline, the chef edits the note on the SAME item — a brand new
    // raw entry with no attempts of its own is appended.
    enqueueMutation(draftEdit('item-1', { note: 'x' }, 'log-real'))
    expect(loadQueue()).toHaveLength(2)

    // Flush 5: dedup merges the patch, but the survivor must still carry the
    // accumulated attempts forward (4 -> 5) and hit the cap, dropping it —
    // not silently resetting to 1 and retrying forever.
    const res = await flushQueue()

    expect(res).toEqual({ synced: 0, failed: 1, kept: 0 })
    expect(loadQueue()).toHaveLength(0)
  })

  it('carries the accumulated attempt count into a last-wins survivor (isOnList_toggle), so a repeat toggle does not reset the cap', async () => {
    mockFetchWith(() => errRes(503))
    enqueueMutation({ type: 'isOnList_toggle', itemId: 'item-1', isOnList: true })
    for (let i = 0; i < 4; i++) await flushQueue()
    expect(loadQueue()).toHaveLength(1)
    expect(loadQueue()[0].attempts).toBe(4)

    // A new raw entry for the same item, still offline.
    enqueueMutation({ type: 'isOnList_toggle', itemId: 'item-1', isOnList: false })
    expect(loadQueue()).toHaveLength(2)

    const res = await flushQueue()

    expect(res).toEqual({ synced: 0, failed: 1, kept: 0 })
    expect(loadQueue()).toHaveLength(0)
  })

  it('does not run a second flush while one is already in flight', async () => {
    let resolveFirst!: (r: Response) => void
    const fn = vi.fn(() => new Promise<Response>(resolve => { resolveFirst = resolve }))
    ;(globalThis as unknown as { fetch: typeof fn }).fetch = fn
    enqueueMutation({ type: 'priority', itemId: 'a', priority: 'PASS' })

    const first = flushQueue()
    const second = await flushQueue()   // fires while the first is still awaiting fetch

    expect(second).toEqual({ synced: 0, failed: 0, kept: 0 })

    resolveFirst(okRes({ id: 'srv-1' }))
    expect(await first).toEqual({ synced: 1, failed: 0, kept: 0 })
  })

  it('retries the merged survivor, not the individual edits it came from', async () => {
    mockFetchWith(() => { throw new TypeError('Failed to fetch') })
    enqueueMutation(draftEdit('item-1', { requiredQty: 4 }, 'log-real'))
    enqueueMutation(draftEdit('item-1', { note: 'double batch' }, 'log-real'))

    await flushQueue()

    const left = loadQueue()
    expect(left).toHaveLength(1)
    expect(left[0].patch).toEqual({ requiredQty: 4, note: 'double batch' })
  })

  it('keeps flushing past a permanent failure', async () => {
    const calls = mockFetchWith(call => (call.index === 0 ? errRes(404) : okRes({ id: 'srv-1' })))
    enqueueMutation({ type: 'remove_item', itemId: 'a', revenueCenterId: 'rc-1' })
    enqueueMutation({ type: 'post', itemId: '', revenueCenterId: 'rc-1' })

    const res = await flushQueue()

    expect(res).toEqual({ synced: 1, failed: 1, kept: 0 })
    expect(calls).toHaveLength(2)
    expect(loadQueue()).toHaveLength(0)
  })
})

describe('prep offline queue — work enqueued during a flush', () => {
  beforeEach(() => { installLocalStorage(); clearQueue() })

  it('does not wipe a mutation the chef enqueued while the flush was in flight', async () => {
    mockFetchWith(call => {
      // The planner enqueues a draft_edit while the first request is awaiting.
      if (call.index === 0) enqueueMutation(draftEdit('item-2', { requiredQty: 7 }, 'log-2'))
      return okRes({ id: 'srv-1' })
    })
    enqueueMutation({ type: 'priority', itemId: 'a', priority: 'PASS' })

    const res = await flushQueue()

    expect(res).toEqual({ synced: 1, failed: 0, kept: 0 })
    const left = loadQueue()
    expect(left).toHaveLength(1)
    expect(left[0].itemId).toBe('item-2')
    expect(left[0].patch).toEqual({ requiredQty: 7 })
  })

  it('keeps both the retryable survivor and the mid-flush addition', async () => {
    mockFetchWith(call => {
      if (call.index === 0) {
        enqueueMutation(draftEdit('item-2', { note: 'later' }, 'log-2'))
        return errRes(500)
      }
      return okRes({ id: 'srv-1' })
    })
    enqueueMutation({ type: 'remove_item', itemId: 'a', revenueCenterId: 'rc-1' })

    await flushQueue()

    expect(loadQueue().map(m => m.itemId)).toEqual(['a', 'item-2'])
  })
})

describe('prep offline queue — merged draft_edit identity fields', () => {
  beforeEach(() => { installLocalStorage(); clearQueue() })

  it('inherits the LAST edit’s logId and revenueCenterId', () => {
    enqueueMutation(draftEdit('item-1', { requiredQty: 4 }, 'log-real'))
    enqueueMutation({ ...draftEdit('item-1', { note: 'n' }, null), revenueCenterId: 'rc-9' })

    const out = deduplicateQueue(loadQueue())

    expect(out).toHaveLength(1)
    expect(out[0].logId).toBeNull()
    expect(out[0].revenueCenterId).toBe('rc-9')
  })

  it('so a real-id-then-null pair takes the create path — POST /api/prep/logs upserts', async () => {
    const calls = mockFetchWith(() => okRes({ id: 'srv-77' }))
    enqueueMutation(draftEdit('item-1', { requiredQty: 4 }, 'log-real'))
    enqueueMutation(draftEdit('item-1', { note: 'double batch' }, null))

    const res = await flushQueue()

    expect(res).toEqual({ synced: 1, failed: 0, kept: 0 })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/prep/logs')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].body).toEqual({
      prepItemId: 'item-1', revenueCenterId: 'rc-1',
      requiredQty: 4, note: 'double batch',
    })
  })
})
