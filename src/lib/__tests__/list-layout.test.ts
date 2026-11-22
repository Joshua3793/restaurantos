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
  it('keeps every job in its category, categories in line order — blockers are not pulled out', () => {
    const s = sectionsFor(cardRows(grill, 0, null), 'OPEN')
    expect(s.map(x => x.label)).toEqual(['EQUIPMENT', 'MISE'])
    expect(s.map(x => x.count)).toEqual(['1/2', '1/2'])
    expect(s[1].rows.map(r => r.line.id)).toEqual(['g2', 'g3'])
  })

  it('turns a category red only while it holds a blocker still to do', () => {
    const s = sectionsFor(cardRows(grill, 0, null), 'OPEN')
    expect(s.map(x => x.urgent)).toEqual([false, true])
    const done = sectionsFor(cardRows({ status: 'OPEN', lines: [line('a', 'X', true, 'DONE')] }, 0, null), 'CLOSE')
    expect(done[0]).toMatchObject({ label: 'X', urgent: false })
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
  it('walks the list the way it is drawn: categories in line order, kitchen lines in the first card', () => {
    expect(lineOrder([grill], kitchen, 'OPEN')).toEqual(['g1', 'g4', 'g2', 'g3', 'k1', 'k2'])
  })

  it('applies the filter', () => {
    expect(lineOrder([grill], kitchen, 'OPEN', 'left')).toEqual(['g1', 'g2', 'k2'])
  })

  it('uses the whole-kitchen run on its own when no station is picked', () => {
    expect(lineOrder([], kitchen, 'OPEN')).toEqual(['k1', 'k2'])
    expect(lineOrder([], null, 'OPEN')).toEqual([])
  })
})
