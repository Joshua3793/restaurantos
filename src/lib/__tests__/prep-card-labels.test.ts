import { describe, it, expect } from 'vitest'
import { startBySub } from '../prep-runsheet'
import { postedDeadlineMoved } from '../prep-plan'

describe('startBySub — the start-by column never repeats itself', () => {
  it('late: how late', () => {
    expect(startBySub(600, 690)).toEqual({ text: '1h30 late', late: true })
  })
  it('close: a countdown', () => {
    expect(startBySub(700, 640)).toEqual({ text: 'in 1h', late: false })
  })
  it('far off tomorrow: the day, not a 5h43 countdown', () => {
    expect(startBySub(1440 + 55, 1140)).toEqual({ text: 'tmrw', late: false })
  })
  it('far off today: nothing', () => {
    expect(startBySub(1200, 600)).toEqual({ text: null, late: false })
  })
  it('two days out', () => {
    expect(startBySub(2 * 1440 + 60, 600)).toEqual({ text: '+2d', late: false })
  })
})

describe('postedDeadlineMoved — only a real move is flagged', () => {
  it('the day rolling over is not a move', () => {
    expect(postedDeadlineMoved('TMRW 09:00', '09:00')).toBe(false)
  })
  it('a different clock is a move', () => {
    expect(postedDeadlineMoved('TMRW 09:00', '11:00')).toBe(true)
    expect(postedDeadlineMoved('16:00', 'TMRW 09:00')).toBe(true)
  })
  it('nothing posted is not a move', () => {
    expect(postedDeadlineMoved('11:00', null)).toBe(false)
  })
})
