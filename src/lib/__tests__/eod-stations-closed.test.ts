import { describe, it, expect } from 'vitest'
import { stationsClosed, computeProgress } from '@/lib/eod-close'

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

describe('computeProgress (the end-of-day gate)', () => {
  it('needs temps AND every station signed', () => {
    const p = computeProgress({ signed: 1, total: 2, ready: false }, { total: 3, ready: true })
    expect(p).toEqual({
      done: 2, total: 3, blockers: 1, ready: false, tempsReady: true, hasTempUnits: true,
      stationsSigned: 1, stationsTotal: 2,
    })
  })

  it('blocks on temps even when every station is signed', () => {
    const p = computeProgress({ signed: 2, total: 2, ready: true }, { total: 3, ready: false })
    expect(p).toMatchObject({ done: 2, total: 3, blockers: 1, ready: false })
  })

  it('is ready with no temp units and no closing runs', () => {
    const p = computeProgress({ signed: 0, total: 0, ready: true }, { total: 0, ready: true })
    expect(p).toMatchObject({ done: 0, total: 0, blockers: 0, ready: true, hasTempUnits: false })
  })
})
