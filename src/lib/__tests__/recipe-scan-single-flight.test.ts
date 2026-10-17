import { describe, it, expect } from 'vitest'
import { singleFlight, type FlightStep } from '../recipe-scan/single-flight'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

describe('singleFlight', () => {
  it('never runs two sends at once and sends the newest copy after the first settles', async () => {
    let copy = 1
    const sent: number[] = []
    let active = 0
    let maxActive = 0
    const gates: ReturnType<typeof deferred>[] = []
    const sf = singleFlight(async (): Promise<FlightStep> => {
      active++; maxActive = Math.max(maxActive, active)
      sent.push(copy)
      const g = deferred(); gates.push(g)
      await g.promise
      active--
      return 'done'
    })

    const first = sf.trigger()
    copy = 2
    const second = sf.trigger()          // during the flight: only marks again
    copy = 3
    sf.trigger()
    expect(second).toBe(first)
    expect(sf.againRequested()).toBe(true)
    expect(sent).toEqual([1])

    gates[0].resolve()
    await Promise.resolve(); await Promise.resolve()
    expect(sent).toEqual([1, 3])         // one follow-up, with the latest copy
    gates[1].resolve()
    await first
    expect(maxActive).toBe(1)
    expect(sf.current()).toBeNull()
  })

  it('a stop ends the run even if a trigger arrived; the next trigger starts a new one', async () => {
    let calls = 0
    const g = deferred()
    const sf = singleFlight(async () => { calls++; if (calls === 1) await g.promise; return calls === 1 ? 'stop' : 'done' })
    const p = sf.trigger()
    sf.trigger()
    g.resolve()
    await p
    expect(calls).toBe(1)
    await sf.trigger()
    expect(calls).toBe(2)
  })

  it('a send that throws clears the flight so the next trigger runs', async () => {
    let calls = 0
    const sf = singleFlight(async () => { calls++; if (calls === 1) throw new Error('x'); return 'done' })
    await expect(sf.trigger()).rejects.toThrow('x')
    expect(sf.current()).toBeNull()
    await sf.trigger()
    expect(calls).toBe(2)
  })
})
