import { describe, it, expect } from 'vitest'
import { applyLine } from '@/lib/checklists/apply-line'

const who = { id: 'u1', name: 'Sam Lee' }
const now = new Date('2026-10-29T17:30:00Z')
const tick = { answer: 'TICK' as const, safeMin: null, safeMax: null }
const temp = { answer: 'TEMP' as const, safeMin: 0, safeMax: 4 }
const num = { answer: 'NUMBER' as const, safeMin: null, safeMax: 4 }

describe('applyLine', () => {
  it('tick on a TICK line is DONE with who and when', () => {
    expect(applyLine(tick, { action: 'tick' }, who, now)).toEqual({
      data: expect.objectContaining({
        status: 'DONE', doneById: 'u1', doneByName: 'Sam Lee', doneAt: now,
        flagReason: null, flagNote: null, resolvedById: null, resolvedByName: null, resolvedAt: null,
      }),
    })
  })

  it('tick on NUMBER or TEMP asks for a reading', () => {
    expect(applyLine(num, { action: 'tick' }, who, now)).toEqual({ error: 'Enter a reading', status: 400 })
    expect(applyLine(temp, { action: 'tick' }, who, now)).toEqual({ error: 'Enter a reading', status: 400 })
  })

  it('untick resets the line', () => {
    const r = applyLine(num, { action: 'untick' }, who, now)
    expect(r).toEqual({
      data: expect.objectContaining({
        status: 'TODO', value: null, flagReason: null, flagNote: null,
        doneById: null, doneByName: null, doneAt: null,
        resolvedById: null, resolvedByName: null, resolvedAt: null,
      }),
    })
  })

  it('value out of range is FLAGGED OUT_OF_RANGE and keeps the value', () => {
    const r = applyLine(num, { action: 'value', raw: '5' }, who, now)
    expect(r).toEqual({
      data: expect.objectContaining({ status: 'FLAGGED', flagReason: 'OUT_OF_RANGE', value: 5, doneById: 'u1' }),
    })
  })

  it('value in range is DONE (comma decimal accepted)', () => {
    const r = applyLine(num, { action: 'value', raw: '3,5' }, who, now)
    expect(r).toEqual({
      data: expect.objectContaining({ status: 'DONE', value: 3.5, flagReason: null, doneByName: 'Sam Lee' }),
    })
  })

  it('value below safeMin is flagged', () => {
    const r = applyLine(temp, { action: 'value', raw: '-1' }, who, now)
    expect(r).toEqual({ data: expect.objectContaining({ status: 'FLAGGED', flagReason: 'OUT_OF_RANGE', value: -1 }) })
  })

  it('value that is not a number is a 400', () => {
    expect(applyLine(num, { action: 'value', raw: 'abc' }, who, now)).toEqual({ error: 'Enter a number', status: 400 })
    expect(applyLine(num, { action: 'value', raw: '' }, who, now)).toEqual({ error: 'Enter a number', status: 400 })
  })

  it('value on a TICK line is rejected', () => {
    expect(applyLine(tick, { action: 'value', raw: '3' }, who, now)).toEqual({ error: 'This job has no reading', status: 400 })
  })

  it('flag stores reason, trimmed note, who and when', () => {
    const r = applyLine(tick, { action: 'flag', reason: 'BROKEN', note: '  guard cracked  ' }, who, now)
    expect(r).toEqual({
      data: expect.objectContaining({
        status: 'FLAGGED', value: null, flagReason: 'BROKEN', flagNote: 'guard cracked',
        doneById: 'u1', doneByName: 'Sam Lee', doneAt: now,
        resolvedById: null, resolvedAt: null,
      }),
    })
  })

  it('flag with an empty note stores null', () => {
    const r = applyLine(tick, { action: 'flag', reason: 'RAN_OUT', note: '   ' }, who, now)
    expect(r).toEqual({ data: expect.objectContaining({ flagNote: null }) })
  })

  it('flag needs BROKEN, RAN_OUT or OTHER', () => {
    for (const reason of ['OUT_OF_RANGE', 'nope', undefined]) {
      expect(applyLine(tick, { action: 'flag', reason } as never, who, now)).toEqual({ error: 'Pick a reason', status: 400 })
    }
  })

  it('flag note over 300 characters is a 400', () => {
    const r = applyLine(tick, { action: 'flag', reason: 'OTHER', note: 'x'.repeat(301) }, who, now)
    expect(r).toMatchObject({ status: 400 })
    expect(applyLine(tick, { action: 'flag', reason: 'OTHER', note: 'x'.repeat(300) }, who, now)).toHaveProperty('data')
  })

  it('unknown action is a 400', () => {
    expect(applyLine(tick, { action: 'zap' } as never, who, now)).toEqual({ error: 'Unknown action', status: 400 })
  })
})
