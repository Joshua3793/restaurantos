import { describe, it, expect, beforeEach, vi } from 'vitest'
import { enqueueMutation, loadQueue, clearQueue, deduplicateQueue, flushQueue, type OfflineMutation } from '../prep-offline'

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

function mockFetch(logId = 'srv-log-1') {
  const calls: { url: string; method: string; body: Record<string, unknown> }[] = []
  const fn = vi.fn(async (url: string, init: { method: string; body: string }) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body) })
    return { ok: true, status: 200, json: async () => ({ id: logId }) } as unknown as Response
  })
  ;(globalThis as unknown as { fetch: typeof fn }).fetch = fn
  return calls
}

const step = (itemId: string, stepKey: string, logId: string | null = 'log-1'): Omit<OfflineMutation, 'id' | 'ts'> =>
  ({ type: 'step', itemId, logId, stepKey, revenueCenterId: 'rc-1' })

describe('prep offline queue — step moves (Next / Back one step)', () => {
  beforeEach(() => { installLocalStorage(); clearQueue() })

  it('a cursor move is absolute: Next, Next, Back keeps only the Back', () => {
    enqueueMutation(step('i1', 's2'))
    enqueueMutation(step('i1', 's3'))
    enqueueMutation(step('i1', 's2'))
    enqueueMutation(step('i2', 's1:wait'))
    expect(deduplicateQueue(loadQueue()).map(m => [m.itemId, m.stepKey])).toEqual([['i1', 's2'], ['i2', 's1:wait']])
  })

  it('does not collapse a step move into a status write for the same item', () => {
    enqueueMutation({ type: 'status', itemId: 'i1', logId: 'log-1', status: 'IN_PROGRESS', revenueCenterId: 'rc-1' })
    enqueueMutation(step('i1', 's2'))
    expect(deduplicateQueue(loadQueue()).map(m => m.type)).toEqual(['status', 'step'])
  })

  it('replays step moves in order onto a log that never reached the server', async () => {
    const calls = mockFetch('srv-9')
    enqueueMutation(step('i1', 's2', '_opt_i1'))
    enqueueMutation(step('i1', 's2:wait', '_opt_i1'))
    await flushQueue()
    expect(calls.map(c => [c.method, c.url])).toEqual([['POST', '/api/prep/logs'], ['PUT', '/api/prep/logs/srv-9']])
    expect(calls[1].body).toEqual({ stepKey: 's2:wait' })
    expect(loadQueue()).toEqual([])
  })
})
