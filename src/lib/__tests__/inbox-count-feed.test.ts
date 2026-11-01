import { describe, it, expect, vi, afterEach } from 'vitest'
import { subscribeInboxCount, refreshInboxCount } from '../inbox-count-feed'

// A fetch whose responses the test releases by hand, so we can see ordering.
function controlledFetch() {
  const pending: Array<(count: number) => void> = []
  const urls: string[] = []
  const fn = vi.fn((url: string) => {
    urls.push(url)
    return new Promise(resolve => {
      pending.push(count => resolve({ ok: true, json: async () => ({ count }) }))
    })
  })
  return { fn, pending, urls }
}
const tick = () => new Promise(r => setTimeout(r, 0))

afterEach(() => { vi.unstubAllGlobals() })

describe('inbox count feed', () => {
  it('shares one request between listeners of the same kitchen', async () => {
    const f = controlledFetch()
    vi.stubGlobal('fetch', f.fn)
    const a = vi.fn(), b = vi.fn()
    const offA = subscribeInboxCount('rc-share', a)
    const offB = subscribeInboxCount('rc-share', b)
    expect(f.fn).toHaveBeenCalledTimes(1)
    f.pending[0](3)
    await tick()
    expect(a).toHaveBeenCalledWith(3)
    expect(b).toHaveBeenCalledWith(3)
    offA(); offB()
  })

  it('a refresh after a change waits for the poll in the air and asks again', async () => {
    const f = controlledFetch()
    vi.stubGlobal('fetch', f.fn)
    const seen = vi.fn()
    const off = subscribeInboxCount('rc-force', seen)
    expect(f.fn).toHaveBeenCalledTimes(1) // the poll, still in the air

    const forced = refreshInboxCount('rc-force')
    await tick()
    expect(f.fn).toHaveBeenCalledTimes(1) // not started yet: waiting for the poll
    f.pending[0](2) // the stale answer
    await tick()
    expect(f.fn).toHaveBeenCalledTimes(2) // now it asks again
    f.pending[1](1) // the fresh answer, after SEEN was written
    await forced
    expect(seen).toHaveBeenLastCalledWith(1)
    off()
  })

  it('a refresh with nobody listening does nothing', async () => {
    const f = controlledFetch()
    vi.stubGlobal('fetch', f.fn)
    await refreshInboxCount('rc-nobody')
    expect(f.fn).not.toHaveBeenCalled()
  })
})
