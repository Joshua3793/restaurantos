import { describe, it, expect } from 'vitest'
import { closingLede } from '@/lib/checklists/lede'

describe('closingLede', () => {
  it('keeps the sign-off wording when nothing is whole-kitchen', () => {
    expect(closingLede(3, 0, 'Grill')).toEqual({ count: '3 things', tail: ' left before you can sign off Grill.' })
  })
  it('counts own + whole-kitchen jobs and says how many are the station’s', () => {
    expect(closingLede(3, 3, 'Grill')).toEqual({ count: '6 things', tail: ' left before you leave — 3 are Grill’s.' })
  })
  it('uses singular forms', () => {
    expect(closingLede(1, 0, 'Grill').count).toBe('1 thing')
    expect(closingLede(1, 1, 'Grill').tail).toBe(' left before you leave — 1 is Grill’s.')
  })
  it('handles only whole-kitchen jobs left', () => {
    expect(closingLede(0, 2, 'Grill')).toEqual({ count: '2 things', tail: ' left before you leave — all are whole-kitchen jobs.' })
    expect(closingLede(0, 1, 'Grill')).toEqual({ count: '1 thing', tail: ' left before you leave — it is a whole-kitchen job.' })
  })
})
