import { describe, it, expect } from 'vitest'
import { stationsClosed, computeProgress, isLiveCloseRun, closeGateFrom, type CloseRunInfo } from '@/lib/eod-close'

describe('stationsClosed', () => {
  it('leaves the shared station out and is not ready while one is open', () => {
    expect(stationsClosed([
      { isShared: true, status: 'OPEN' },
      { isShared: false, status: 'SIGNED' },
      { isShared: false, status: 'OPEN' },
    ])).toEqual({ signed: 1, total: 2, ready: false })
  })

  it('is ready when every station run is signed', () => {
    expect(stationsClosed([
      { isShared: false, status: 'SIGNED' },
      { isShared: false, status: 'SIGNED' },
      { isShared: true, status: 'OPEN' },
    ])).toEqual({ signed: 2, total: 2, ready: true })
  })

  it('is ready when no station has a closing run', () => {
    expect(stationsClosed([])).toEqual({ signed: 0, total: 0, ready: true })
    expect(stationsClosed([{ isShared: true, status: 'OPEN' }])).toEqual({ signed: 0, total: 0, ready: true })
  })
})

const run = (over: Partial<CloseRunInfo>): CloseRunInfo => ({
  isShared: false, status: 'OPEN', lineCount: 10, crewCount: 1, handledCount: 0, blockerCount: 0, blockersLeft: 0, ...over,
})

describe('isLiveCloseRun', () => {
  it('drops a run with no lines (nothing applied tonight — it could never sign off)', () => {
    expect(isLiveCloseRun({ lineCount: 0, crewCount: 2, handledCount: 0 })).toBe(false)
  })

  it('drops an abandoned pick: nobody on it and nothing ticked', () => {
    expect(isLiveCloseRun({ lineCount: 8, crewCount: 0, handledCount: 0 })).toBe(false)
  })

  it('keeps a run someone is on, or one with ticked work after the crew left', () => {
    expect(isLiveCloseRun({ lineCount: 8, crewCount: 1, handledCount: 0 })).toBe(true)
    expect(isLiveCloseRun({ lineCount: 8, crewCount: 0, handledCount: 3 })).toBe(true)
  })
})

describe('closeGateFrom', () => {
  it('leaves empty and abandoned runs out of the station count', () => {
    const g = closeGateFrom([
      run({ status: 'SIGNED' }),                       // Fry, signed
      run({ lineCount: 0 }),                           // Pastry: nothing applied tonight
      run({ crewCount: 0, handledCount: 0 }),          // Grill: picked, then switched to Fry
    ])
    expect(g).toMatchObject({ signed: 1, total: 1, ready: true })
  })

  it('counts the whole-kitchen closing blockers (e.g. gas off)', () => {
    const g = closeGateFrom([
      run({ status: 'SIGNED' }),
      run({ isShared: true, crewCount: 0, blockerCount: 3, blockersLeft: 2 }),
    ])
    expect(g).toEqual({ signed: 1, total: 1, ready: true, sharedBlockersTotal: 3, sharedBlockersLeft: 2 })
  })
})

describe('computeProgress (the end-of-day gate)', () => {
  const gate = (signed: number, total: number, sharedTotal = 0, sharedLeft = 0) => ({
    signed, total, ready: signed === total, sharedBlockersTotal: sharedTotal, sharedBlockersLeft: sharedLeft,
  })

  it('needs temps AND every station signed', () => {
    const p = computeProgress(gate(1, 2), { total: 3, ready: true })
    expect(p).toEqual({
      done: 2, total: 3, blockers: 1, ready: false, tempsReady: true, hasTempUnits: true,
      stationsSigned: 1, stationsTotal: 2, sharedBlockersLeft: 0,
    })
  })

  it('blocks on temps even when every station is signed', () => {
    const p = computeProgress(gate(2, 2), { total: 3, ready: false })
    expect(p).toMatchObject({ done: 2, total: 3, blockers: 1, ready: false })
  })

  it('blocks on whole-kitchen closing blockers left', () => {
    const p = computeProgress(gate(2, 2, 3, 1), { total: 3, ready: true })
    expect(p).toMatchObject({ done: 5, total: 6, blockers: 1, ready: false, sharedBlockersLeft: 1 })
    expect(computeProgress(gate(2, 2, 3, 0), { total: 3, ready: true }).ready).toBe(true)
  })

  it('is ready with no temp units and no closing runs', () => {
    const p = computeProgress(gate(0, 0), { total: 0, ready: true })
    expect(p).toMatchObject({ done: 0, total: 0, blockers: 0, ready: true, hasTempUnits: false })
  })
})
