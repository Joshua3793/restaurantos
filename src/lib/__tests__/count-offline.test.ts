import { describe, it, expect, beforeEach, vi } from 'vitest'
import { enqueueCountMutation, flushCountQueue, loadCountQueue, clearCountQueue, dropQueuedStateForLine } from '../count-offline'

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

/** Capture the PATCH bodies flushCountQueue sends. */
function mockFetch() {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const fn = vi.fn(async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response
  })
  ;(globalThis as unknown as { fetch: typeof fn }).fetch = fn
  return calls
}

describe('count offline queue — selected UOM', () => {
  beforeEach(() => {
    installLocalStorage()
    clearCountQueue()
  })

  it('sends the unit the qty was entered in, not the line default', async () => {
    const calls = mockFetch()
    enqueueCountMutation({ sessionId: 's1', lineId: 'l1', type: 'count', qty: 4, uom: 'kg' })

    await flushCountQueue()

    expect(calls).toHaveLength(1)
    expect(calls[0].body).toMatchObject({ countedQty: 4, selectedUom: 'kg' })
  })

  it('syncs a UOM change made offline on a line that was never counted', async () => {
    const calls = mockFetch()
    enqueueCountMutation({ sessionId: 's1', lineId: 'l1', type: 'uom', uom: 'kg' })

    await flushCountQueue()

    expect(calls).toHaveLength(1)
    expect(calls[0].body).toEqual({ selectedUom: 'kg' })
  })

  it('a later UOM change never clobbers a queued count for the same line', async () => {
    const calls = mockFetch()
    enqueueCountMutation({ sessionId: 's1', lineId: 'l1', type: 'count', qty: 4, uom: 'kg' })
    enqueueCountMutation({ sessionId: 's1', lineId: 'l1', type: 'uom', uom: 'g' })

    await flushCountQueue()

    // Both survive dedup: state mutations (count/skip) and uom changes are separate keys.
    expect(calls.map(c => c.body)).toEqual([
      { countedQty: 4, selectedUom: 'kg' },
      { selectedUom: 'g' },
    ])
  })

  it('still dedups repeated counts on the same line to the last one', async () => {
    const calls = mockFetch()
    enqueueCountMutation({ sessionId: 's1', lineId: 'l1', type: 'count', qty: 1, uom: 'kg' })
    enqueueCountMutation({ sessionId: 's1', lineId: 'l1', type: 'count', qty: 9, uom: 'kg' })

    await flushCountQueue()

    expect(calls).toHaveLength(1)
    expect(calls[0].body).toMatchObject({ countedQty: 9 })
  })

  it('a mixed-unit count carries its entries and needs no selectedUom', async () => {
    const calls = mockFetch()
    enqueueCountMutation({
      sessionId: 's1', lineId: 'l1', type: 'count', qty: 2, uom: 'kg',
      entries: [{ unit: 'kg', qty: 2 }, { unit: 'g', qty: 500 }],
    })

    await flushCountQueue()

    expect(calls[0].body).toEqual({ entries: [{ unit: 'kg', qty: 2 }, { unit: 'g', qty: 500 }] })
  })

  it('resets the line to uncounted when the unit change invalidated a count', async () => {
    const calls = mockFetch()
    enqueueCountMutation({ sessionId: 's1', lineId: 'l1', type: 'uom', uom: 'kg', clearsCount: true })

    await flushCountQueue()

    expect(calls[0].body).toEqual({ selectedUom: 'kg', skipped: false })
  })

  it('dropQueuedStateForLine removes a superseded count but keeps uom changes', () => {
    enqueueCountMutation({ sessionId: 's1', lineId: 'l1', type: 'count', qty: 4, uom: 'case' })
    enqueueCountMutation({ sessionId: 's1', lineId: 'l2', type: 'count', qty: 7, uom: 'kg' })
    enqueueCountMutation({ sessionId: 's1', lineId: 'l1', type: 'uom', uom: 'kg', clearsCount: true })

    expect(dropQueuedStateForLine('l1')).toBe(2)

    const q = loadCountQueue()
    // l1's stale count is gone; its uom change and the untouched l2 count survive.
    expect(q.map(m => [m.lineId, m.type])).toEqual([['l2', 'count'], ['l1', 'uom']])
  })

  it('a cleared line that is re-counted offline still syncs clear-then-count in order', async () => {
    const calls = mockFetch()
    enqueueCountMutation({ sessionId: 's1', lineId: 'l1', type: 'count', qty: 4, uom: 'case' })
    dropQueuedStateForLine('l1')
    enqueueCountMutation({ sessionId: 's1', lineId: 'l1', type: 'uom', uom: 'kg', clearsCount: true })
    enqueueCountMutation({ sessionId: 's1', lineId: 'l1', type: 'count', qty: 9, uom: 'kg' })

    await flushCountQueue()

    expect(calls.map(c => c.body)).toEqual([
      { selectedUom: 'kg', skipped: false },
      { countedQty: 9, selectedUom: 'kg' },
    ])
  })

  it('keeps a failed uom mutation queued for retry', async () => {
    ;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response)
    enqueueCountMutation({ sessionId: 's1', lineId: 'l1', type: 'uom', uom: 'kg' })

    const { synced, failed } = await flushCountQueue()

    expect(synced).toBe(0)
    expect(failed).toBe(1)
    expect(loadCountQueue()).toHaveLength(1)
  })

  it('keeps a 5xx mutation queued but DROPS a 4xx one and surfaces its message', async () => {
    // A 400 is the server refusing the mutation (e.g. the item's units changed under
    // the count). Retrying can never succeed — it used to replay every few seconds
    // forever, silently. It must leave the queue and come back as `rejected`.
    ;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async (url: string) => (
      String(url).includes('/lines/bad')
        ? { ok: false, status: 400, json: async () => ({ error: 'Invalid count unit', message: '"portion" is not a valid count unit for this item' }) }
        : { ok: false, status: 503, json: async () => ({}) }
    ) as unknown as Response)
    enqueueCountMutation({ sessionId: 's1', lineId: 'bad',  type: 'count', qty: 30, uom: 'portion' })
    enqueueCountMutation({ sessionId: 's1', lineId: 'flaky', type: 'count', qty: 4, uom: 'kg' })

    const { synced, failed, rejected } = await flushCountQueue()

    expect(synced).toBe(0)
    expect(failed).toBe(1)
    expect(rejected).toEqual([{ lineId: 'bad', message: '"portion" is not a valid count unit for this item' }])
    // Only the 5xx mutation survives for the next flush.
    expect(loadCountQueue().map(m => m.lineId)).toEqual(['flaky'])
  })

  it('a rejected count does not resurrect on the next flush', async () => {
    ;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => (
      { ok: false, status: 400, json: async () => ({ error: 'nope' }) }
    ) as unknown as Response)
    enqueueCountMutation({ sessionId: 's1', lineId: 'l1', type: 'count', qty: 30, uom: 'portion' })

    await flushCountQueue()
    const second = await flushCountQueue()

    expect(second.rejected).toEqual([])
    expect(loadCountQueue()).toHaveLength(0)
  })
})
