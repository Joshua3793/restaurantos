import { describe, it, expect } from 'vitest'
import { cardRows, keepRow, lineOrder, sectionsFor } from '@/lib/checklists/list-layout'

const line = (id: string, categoryName: string, isBlocker = false, status: 'TODO' | 'DONE' | 'FLAGGED' = 'TODO') =>
  ({ id, categoryName, isBlocker, status })

const grill = {
  status: 'OPEN',
  lines: [line('g1', 'Equipment'), line('g2', 'Mise', true), line('g3', 'Mise', false, 'DONE'), line('g4', 'Equipment', false, 'FLAGGED')],
}
const kitchen = { status: 'OPEN', lines: [line('k1', 'Safety', true, 'DONE'), line('k2', 'Safety')] }

describe('sectionsFor', () => {
  it('puts blockers first with a LEFT count, then categories in line order', () => {
    const s = sectionsFor(cardRows(grill, 0, null), 'OPEN')
    expect(s.map(x => x.label)).toEqual(['BEFORE DOORS · 1 LEFT', 'EQUIPMENT', 'MISE'])
    expect(s.map(x => x.count)).toEqual(['0/1', '1/2', '1/1'])
  })

  it('says BEFORE YOU LEAVE when closing, and drops the count once blockers are handled', () => {
    const s = sectionsFor(cardRows({ status: 'OPEN', lines: [line('a', 'X', true, 'DONE')] }, 0, null), 'CLOSE')
    expect(s[0]).toMatchObject({ label: 'BEFORE YOU LEAVE', urgent: false })
  })
})

describe('cardRows', () => {
  it('merges the whole-kitchen lines into the first card only, marked shared', () => {
    expect(cardRows(grill, 0, kitchen).filter(r => r.shared).map(r => r.line.id)).toEqual(['k1', 'k2'])
    expect(cardRows(grill, 1, kitchen).some(r => r.shared)).toBe(false)
  })

  it('locks the rows of a signed run', () => {
    expect(cardRows({ ...grill, status: 'SIGNED' }, 0, null).every(r => r.locked)).toBe(true)
  })
})

describe('keepRow', () => {
  it('Left keeps only jobs still to do; Done keeps ticked and flagged', () => {
    expect([keepRow('left', { status: 'TODO' }), keepRow('left', { status: 'FLAGGED' })]).toEqual([true, false])
    expect([keepRow('done', { status: 'DONE' }), keepRow('done', { status: 'FLAGGED' }), keepRow('done', { status: 'TODO' })]).toEqual([true, true, false])
  })
})

describe('lineOrder', () => {
  it('walks the list the way it is drawn: blockers, then categories, kitchen lines in the first card', () => {
    expect(lineOrder([grill], kitchen, 'OPEN')).toEqual(['g2', 'k1', 'g1', 'g4', 'g3', 'k2'])
  })

  it('applies the filter', () => {
    expect(lineOrder([grill], kitchen, 'OPEN', 'left')).toEqual(['g2', 'g1', 'k2'])
  })

  it('uses the whole-kitchen run on its own when no station is picked', () => {
    expect(lineOrder([], kitchen, 'OPEN')).toEqual(['k1', 'k2'])
    expect(lineOrder([], null, 'OPEN')).toEqual([])
  })
})
