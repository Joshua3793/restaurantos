import { describe, it, expect } from 'vitest'
import { stationStatus, sortStations, type StationTone } from '../checklists/station-status'

const L = (status: 'TODO' | 'DONE' | 'FLAGGED', isBlocker = false) => ({ status, isBlocker })

describe('stationStatus', () => {
  it('no run is NOT STARTED, red', () => {
    expect(stationStatus({ isShared: false, run: null, phase: 'OPEN' })).toEqual({ label: 'NOT STARTED', tone: 'red' })
  })

  it('no run is NOT STARTED for a shared station too', () => {
    expect(stationStatus({ isShared: true, run: null, phase: 'CLOSE' })).toEqual({ label: 'NOT STARTED', tone: 'red' })
  })

  it('no run and jobs that apply today is NOT STARTED, red', () => {
    expect(stationStatus({ isShared: false, run: null, phase: 'OPEN', jobCount: 4 })).toEqual({ label: 'NOT STARTED', tone: 'red' })
  })

  it('no run and no job applies today is NOTHING TODAY, grey (shared too)', () => {
    expect(stationStatus({ isShared: false, run: null, phase: 'CLOSE', jobCount: 0 })).toEqual({ label: 'NOTHING TODAY', tone: 'grey' })
    expect(stationStatus({ isShared: true, run: null, phase: 'OPEN', jobCount: 0 })).toEqual({ label: 'NOTHING TODAY', tone: 'grey' })
  })

  it('a run is judged on its lines, whatever the job count', () => {
    expect(stationStatus({ isShared: false, run: { status: 'OPEN', lines: [L('TODO')] }, phase: 'OPEN', jobCount: 0 }))
      .toEqual({ label: 'IN PROGRESS', tone: 'grey' })
  })

  it('a signed run is DONE, green, even with jobs left', () => {
    expect(stationStatus({ isShared: false, run: { status: 'SIGNED', lines: [L('TODO', true)] }, phase: 'OPEN' }))
      .toEqual({ label: 'DONE', tone: 'green' })
  })

  it('a shared run with every line handled is DONE, green', () => {
    expect(stationStatus({ isShared: true, run: { status: 'OPEN', lines: [L('DONE'), L('FLAGGED')] }, phase: 'OPEN' }))
      .toEqual({ label: 'DONE', tone: 'green' })
  })

  it('a shared run with a line left is not done', () => {
    expect(stationStatus({ isShared: true, run: { status: 'OPEN', lines: [L('DONE'), L('TODO')] }, phase: 'OPEN' }))
      .toEqual({ label: 'IN PROGRESS', tone: 'grey' })
  })

  it('a non-shared run with every line done but not signed is still IN PROGRESS', () => {
    expect(stationStatus({ isShared: false, run: { status: 'OPEN', lines: [L('DONE'), L('DONE')] }, phase: 'OPEN' }))
      .toEqual({ label: 'IN PROGRESS', tone: 'grey' })
  })

  it('blockers left before doors, gold', () => {
    const lines = [L('TODO', true), L('TODO', true), L('TODO', true), L('DONE', true), L('TODO')]
    expect(stationStatus({ isShared: false, run: { status: 'OPEN', lines }, phase: 'OPEN' }))
      .toEqual({ label: '3 BEFORE DOORS', tone: 'gold' })
  })

  it('blockers left while closing, gold', () => {
    expect(stationStatus({ isShared: false, run: { status: 'OPEN', lines: [L('TODO', true)] }, phase: 'CLOSE' }))
      .toEqual({ label: '1 BEFORE YOU LEAVE', tone: 'gold' })
  })

  it('blockers outrank flags', () => {
    expect(stationStatus({ isShared: false, run: { status: 'OPEN', lines: [L('TODO', true), L('FLAGGED')] }, phase: 'OPEN' }))
      .toEqual({ label: '1 BEFORE DOORS', tone: 'gold' })
  })

  it('flags with no blockers left, gold', () => {
    expect(stationStatus({ isShared: false, run: { status: 'OPEN', lines: [L('FLAGGED'), L('FLAGGED'), L('TODO')] }, phase: 'OPEN' }))
      .toEqual({ label: '2 FLAGGED', tone: 'gold' })
  })

  it('anything else is IN PROGRESS, grey', () => {
    expect(stationStatus({ isShared: false, run: { status: 'OPEN', lines: [L('DONE'), L('TODO')] }, phase: 'CLOSE' }))
      .toEqual({ label: 'IN PROGRESS', tone: 'grey' })
  })

  it('an empty open run is IN PROGRESS', () => {
    expect(stationStatus({ isShared: false, run: { status: 'OPEN', lines: [] }, phase: 'OPEN' }))
      .toEqual({ label: 'IN PROGRESS', tone: 'grey' })
  })
})

describe('sortStations', () => {
  const s = (id: string, tone: StationTone, isShared = false) => ({ id, isShared, status: { label: '', tone } })

  it('orders red, gold, green, grey and keeps the given order inside a tone', () => {
    const out = sortStations([s('a', 'grey'), s('b', 'green'), s('c', 'gold'), s('d', 'red'), s('e', 'gold'), s('f', 'red')])
    expect(out.map(x => x.id)).toEqual(['d', 'f', 'c', 'e', 'b', 'a'])
  })

  it('puts the shared station last within its tone', () => {
    const out = sortStations([s('w', 'green', true), s('x', 'green'), s('y', 'red', true), s('z', 'red')])
    expect(out.map(x => x.id)).toEqual(['z', 'y', 'x', 'w'])
  })

  it('does not change the input', () => {
    const input = [s('a', 'green'), s('b', 'red')]
    sortStations(input)
    expect(input.map(x => x.id)).toEqual(['a', 'b'])
  })
})
