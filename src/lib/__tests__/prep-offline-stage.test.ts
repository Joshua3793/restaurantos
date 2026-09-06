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

const stage = (itemId: string, stageIndex: number, logId: string | null = 'log-1'): Omit<OfflineMutation, 'id' | 'ts'> =>
  ({ type: 'stage', itemId, logId, stageIndex, revenueCenterId: 'rc-1' })

describe('prep offline queue — stage moves', () => {
  beforeEach(() => { installLocalStorage(); clearQueue() })

  it('keeps only the LAST stage move per item (Next, Next, Back → the Back)', () => {
    enqueueMutation(stage('i1', 1))
    enqueueMutation(stage('i1', 2))
    enqueueMutation(stage('i1', 1))
    enqueueMutation(stage('i2', 1))
    const out = deduplicateQueue(loadQueue())
    expect(out.map(m => [m.itemId, m.stageIndex])).toEqual([['i1', 1], ['i2', 1]])
  })

  it('does not collapse a stage move into a status write for the same item', () => {
    enqueueMutation({ type: 'status', itemId: 'i1', logId: 'log-1', status: 'IN_PROGRESS', revenueCenterId: 'rc-1' })
    enqueueMutation(stage('i1', 1))
    expect(deduplicateQueue(loadQueue()).map(m => m.type)).toEqual(['status', 'stage'])
  })

  it('PUTs the stage index straight to a real log id', async () => {
    const calls = mockFetch()
    enqueueMutation(stage('i1', 2))
    const r = await flushQueue()
    expect(r).toEqual({ synced: 1, failed: 0, kept: 0 })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ url: '/api/prep/logs/log-1', method: 'PUT', body: { stageIndex: 2 } })
    expect(loadQueue()).toEqual([])
  })

  it('creates the log first when the client only ever had an optimistic id', async () => {
    const calls = mockFetch('srv-9')
    enqueueMutation(stage('i1', 1, '_opt_i1'))
    await flushQueue()
    expect(calls.map(c => [c.method, c.url])).toEqual([['POST', '/api/prep/logs'], ['PUT', '/api/prep/logs/srv-9']])
    expect(calls[1].body).toEqual({ stageIndex: 1 })
  })
})
