import { describe, it, expect } from 'vitest'
import {
  resolveActive, resolvePassive, resolvePassiveNote, startByMinutes,
  runState, minutesBetween, fmtClock, fmtDuration, stepFor, scaleRound, scaleQtyLabel,
} from '../prep-runsheet'

const rec = (a: number|null, p: number|null, n: string|null) => ({ activeMinutes: a, passiveMinutes: p, passiveNote: n })

describe('effective times: override wins, else recipe, else null', () => {
  it('uses recipe when no override', () => {
    const i = { activeMinutesOverride: null, passiveMinutesOverride: null, passiveNoteOverride: null, linkedRecipe: rec(45, 30, 'cool') }
    expect(resolveActive(i)).toBe(45)
    expect(resolvePassive(i)).toBe(30)
    expect(resolvePassiveNote(i)).toBe('cool')
  })
  it('override wins over recipe', () => {
    const i = { activeMinutesOverride: 20, passiveMinutesOverride: 0, passiveNoteOverride: 'oven', linkedRecipe: rec(45, 30, 'cool') }
    expect(resolveActive(i)).toBe(20)
    expect(resolvePassive(i)).toBe(0)
    expect(resolvePassiveNote(i)).toBe('oven')
  })
  it('null when neither', () => {
    const i = { activeMinutesOverride: null, passiveMinutesOverride: null, passiveNoteOverride: null, linkedRecipe: null }
    expect(resolveActive(i)).toBeNull()
    expect(resolvePassive(i)).toBeNull()
  })
})

describe('startByMinutes', () => {
  it('service − active − passive', () => {
    expect(startByMinutes(690, 45, 30)).toBe(615) // 11:30 − 75m = 10:15
  })
  it('treats null active/passive as 0', () => {
    expect(startByMinutes(690, null, null)).toBe(690)
  })
  it('null service → null', () => {
    expect(startByMinutes(null, 45, 30)).toBeNull()
  })
})

describe('runState', () => {
  it('blocked wins regardless of time', () => {
    expect(runState({ startBy: 100, blockedReason: 'anchovies short' }, 90)).toBe('blocked')
  })
  it('overdue when startBy already passed', () => {
    expect(runState({ startBy: 500, blockedReason: null }, 510)).toBe('overdue')
  })
  it('soon within 60m', () => {
    expect(runState({ startBy: 540, blockedReason: null }, 510)).toBe('soon')
  })
  it('later beyond 60m', () => {
    expect(runState({ startBy: 700, blockedReason: null }, 510)).toBe('later')
  })
  it('null startBy → later', () => {
    expect(runState({ startBy: null, blockedReason: null }, 510)).toBe('later')
  })
})

describe('formatting', () => {
  it('fmtClock pads', () => { expect(fmtClock(615)).toBe('10:15'); expect(fmtClock(90)).toBe('01:30') })
  it('fmtDuration', () => { expect(fmtDuration(45)).toBe('45m'); expect(fmtDuration(80)).toBe('1h20'); expect(fmtDuration(120)).toBe('2h') })
  it('minutesBetween floors to minutes', () => { expect(minutesBetween(0, 90_000)).toBe(1) })
})

describe('batch scaling', () => {
  it('stepFor by unit', () => { expect(stepFor('kg')).toBe(0.5); expect(stepFor('ea')).toBe(5); expect(stepFor('g')).toBe(50) })
  it('scaleRound kg ≥10 → nearest 0.5', () => { expect(scaleRound(12.3, 'kg')).toBe(12.5) })
  it('scaleRound kg <10 → nearest 0.01', () => { expect(scaleRound(1.234, 'kg')).toBe(1.23) })
  it('scaleRound ea → integer', () => { expect(scaleRound(49.6, 'ea')).toBe(50) })
  it('scaleRound g ≥100 → nearest 5', () => { expect(scaleRound(123, 'g')).toBe(125) })
  it('scaleRound g <100 → integer', () => { expect(scaleRound(61.4, 'g')).toBe(61) })
  it('scaleQtyLabel trims trailing zero for kg', () => { expect(scaleQtyLabel(1.2, 2, 'kg')).toBe('2.4 kg') })
  it('scaleQtyLabel integer units', () => { expect(scaleQtyLabel(60, 2, 'g')).toBe('120 g') })
})
