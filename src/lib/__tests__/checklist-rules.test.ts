import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/prisma', () => ({ prisma: {} }))

import { businessDateLocal } from '@/lib/eod-close'
import {
  shiftBusinessDate, defaultPhase, DAY_BITS, EVERY_DAY, dayBitFor, appliesOn,
  parseReading, inRange, runProgress, canSignOff, sharedRunComplete, daysLabel,
} from '../checklists/rules'

describe('shiftBusinessDate', () => {
  it('CLOSE after midnight belongs to the previous day', () => {
    expect(shiftBusinessDate('CLOSE', new Date('2026-10-30T07:40:00Z'))).toBe('2026-10-29')
  })
  it('OPEN uses the Pacific date', () => {
    expect(shiftBusinessDate('OPEN', new Date('2026-10-30T07:40:00Z'))).toBe('2026-10-30')
  })
  it('CLOSE in the evening stays on the same day', () => {
    expect(shiftBusinessDate('CLOSE', new Date('2026-10-30T05:30:00Z'))).toBe('2026-10-29')
  })
})

describe('shiftBusinessDate extras', () => {
  it('OPEN matches businessDateLocal', () => {
    const d = new Date('2026-10-30T07:40:00Z')
    expect(shiftBusinessDate('OPEN', d)).toBe(businessDateLocal(d))
  })
  it('CLOSE across the fall-back DST night', () => {
    expect(shiftBusinessDate('CLOSE', new Date('2026-11-01T07:40:00Z'))).toBe('2026-10-31')
  })
})

describe('defaultPhase', () => {
  it('is CLOSE at 00:30 Pacific (closing shift)', () => {
    expect(defaultPhase(new Date('2026-10-30T07:30:00Z'))).toBe('CLOSE')
  })
  it('is OPEN from 05:00 Pacific', () => {
    expect(defaultPhase(new Date('2026-10-30T12:00:00Z'))).toBe('OPEN')
  })
  it('is OPEN before 14:00 Pacific', () => {
    expect(defaultPhase(new Date('2026-10-29T20:59:00Z'))).toBe('OPEN')
  })
  it('is CLOSE from 14:00 Pacific', () => {
    expect(defaultPhase(new Date('2026-10-29T21:00:00Z'))).toBe('CLOSE')
  })
})

describe('weekday rules', () => {
  it('dayBitFor reads the weekday from the date string', () => {
    expect(dayBitFor('2026-10-29')).toBe(DAY_BITS.THU)
    expect(dayBitFor('2026-11-01')).toBe(DAY_BITS.SUN)
  })
  it('appliesOn', () => {
    expect(appliesOn(4, '2026-10-28')).toBe(true)
    expect(appliesOn(4, '2026-10-29')).toBe(false)
    expect(appliesOn(127, '2026-10-29')).toBe(true)
    expect(EVERY_DAY).toBe(127)
  })
})

describe('parseReading', () => {
  it('parses numbers', () => {
    expect(parseReading('3,5')).toBe(3.5)
    expect(parseReading(' 4 ')).toBe(4)
    expect(parseReading('-18')).toBe(-18)
  })
  it('rejects junk', () => {
    expect(parseReading('')).toBeNull()
    expect(parseReading('abc')).toBeNull()
  })
})

describe('inRange', () => {
  it('checks both bounds, either may be null', () => {
    expect(inRange(4, 0, 4)).toBe(true)
    expect(inRange(4.1, 0, 4)).toBe(false)
    expect(inRange(-20, null, -18)).toBe(true)
    expect(inRange(5, null, null)).toBe(true)
  })
})

describe('progress', () => {
  it('runProgress counts handled, done, flagged, blockers left', () => {
    expect(runProgress([
      { status: 'DONE', isBlocker: true },
      { status: 'FLAGGED', isBlocker: true },
      { status: 'TODO', isBlocker: true },
      { status: 'TODO', isBlocker: false },
    ])).toEqual({ handled: 2, total: 4, done: 1, flagged: 1, blockersLeft: 1 })
  })
  it('canSignOff', () => {
    expect(canSignOff([{ status: 'FLAGGED', isBlocker: true }, { status: 'TODO', isBlocker: false }])).toBe(true)
    expect(canSignOff([])).toBe(false)
  })
  it('sharedRunComplete', () => {
    expect(sharedRunComplete([{ status: 'DONE', isBlocker: false }, { status: 'FLAGGED', isBlocker: true }])).toBe(true)
    expect(sharedRunComplete([])).toBe(false)
    expect(sharedRunComplete([{ status: 'TODO', isBlocker: false }])).toBe(false)
  })
})

describe('daysLabel', () => {
  it('labels day masks', () => {
    expect(daysLabel(127)).toBe('')
    expect(daysLabel(4)).toBe('WED ONLY')
    expect(daysLabel(9)).toBe('MON · THU')
    expect(daysLabel(31)).toBe('WEEKDAYS')
    expect(daysLabel(96)).toBe('WEEKENDS')
  })
})
