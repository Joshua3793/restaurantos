import { describe, it, expect } from 'vitest'
import { fmtCount, countGap } from '../count-labels'

describe('fmtCount', () => {
  it('drops the .00', () => {
    expect(fmtCount(18)).toBe('18')
    expect(fmtCount(2.5)).toBe('2.5')
    expect(fmtCount(0.254)).toBe('0.25')
    expect(fmtCount(-0.001)).toBe('0')
  })
})

describe('countGap — variance in units, once', () => {
  it('short', () => expect(countGap(0, 22.3, 'each')).toEqual({ text: '22.3 each short', tone: 'short' }))
  it('over', () => expect(countGap(5, 2, 'case')).toEqual({ text: '3 case over', tone: 'over' }))
  it('on target within 2%', () => expect(countGap(99, 100, 'g')).toEqual({ text: 'on target', tone: 'ok' }))
  it('nothing expected says nothing', () => expect(countGap(3, 0, 'case')).toBeNull())
})
