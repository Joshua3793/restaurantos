import { describe, it, expect } from 'vitest'
import {
  resolveActive, resolvePassive, resolvePassiveNote,
  runState, minutesBetween, fmtClock, fmtMins, stepFor, scaleRound, scaleQtyLabel,
  dayOffset, fmtStartBy, fmtQty, stepFactor, postedWhenLabel,
} from '../prep-runsheet'

const rec = (a: number|null, p: number|null, n: string|null) => ({ activeMinutes: a, passiveMinutes: p, passiveNote: n })

describe('effective times: the method, else the recipe columns, else null', () => {
  it('reads the recipe columns when there is no method', () => {
    const i = { linkedRecipe: rec(45, 30, 'cool') }
    expect(resolveActive(i)).toBe(45)
    expect(resolvePassive(i)).toBe(30)
    expect(resolvePassiveNote(i)).toBe('cool')
  })
  it('a method with waits beats the columns', () => {
    const method = [
      { key: 'a', text: 'Mix', minutes: 15, wait: { minutes: 120 } },
      { key: 'b', text: 'Portion', minutes: 4 },
    ]
    const i = { linkedRecipe: { ...rec(180, 0, null), method } }
    expect(resolveActive(i)).toBe(19)
    expect(resolvePassive(i)).toBe(120)
  })
  it('null when there is no recipe', () => {
    expect(resolveActive({ linkedRecipe: null })).toBeNull()
    expect(resolvePassive({ linkedRecipe: null })).toBeNull()
    expect(resolvePassiveNote({ linkedRecipe: null })).toBeNull()
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

  // A 48h prep counted back from a 09:00 service lands at minute -2340. The naive
  // formatter rendered "-39:00"; it must wrap to a real clock face instead.
  it('fmtClock wraps negative and >24h values into a valid clock', () => {
    expect(fmtClock(-2340)).toBe('09:00')   // 09:00 service − 48h ⇒ 09:00, two days back
    expect(fmtClock(-15)).toBe('23:45')
    expect(fmtClock(1440)).toBe('00:00')
    expect(fmtClock(1500)).toBe('01:00')
  })

  it('dayOffset counts whole days outside today', () => {
    expect(dayOffset(540)).toBe(0)
    expect(dayOffset(-15)).toBe(-1)
    expect(dayOffset(-2340)).toBe(-2)
    expect(dayOffset(1500)).toBe(1)
  })

  it('fmtStartBy appends the day only when it is not today', () => {
    expect(fmtStartBy(465)).toBe('07:45')        // same day — no suffix
    expect(fmtStartBy(-15)).toBe('23:45 −1d')
    expect(fmtStartBy(-2340)).toBe('09:00 −2d')  // the 48h brisket: start 09:00, two days out
  })
  it('fmtMins', () => { expect(fmtMins(45)).toBe('45m'); expect(fmtMins(80)).toBe('1h20'); expect(fmtMins(120)).toBe('2h') })
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
  it('treats the canonical lowercase litre token like L in every helper', () => {
    expect(stepFor('l')).toBe(0.5)
    expect(scaleRound(12.3, 'l')).toBe(12.5)
    expect(scaleQtyLabel(1.2, 2, 'l')).toBe('2.4 l')
  })
})

describe('fmtQty', () => {
  it('shows one decimal for a fractional kg or L', () => {
    expect(fmtQty(2.5, 'kg')).toBe('2.5 kg')
    expect(fmtQty(1.25, 'L')).toBe('1.3 L')
  })

  it('drops the decimal for a whole kg or L', () => {
    expect(fmtQty(3, 'kg')).toBe('3 kg')
    expect(fmtQty(4, 'L')).toBe('4 L')
  })

  it('rounds every other unit to a whole number', () => {
    expect(fmtQty(2.5, 'each')).toBe('3 each')
    expect(fmtQty(2.4, 'each')).toBe('2 each')
    expect(fmtQty(1250.7, 'g')).toBe('1251 g')
  })

  it('survives a Decimal that reached the client as a string (a cached pre-fix payload)', () => {
    // "11.6" % 1 !== 0 → the old code called "11.6".toFixed and blanked the run sheet.
    expect(fmtQty('11.6', 'kg')).toBe('11.6 kg')
    expect(fmtQty('35', 'kg')).toBe('35 kg')
    expect(fmtQty('72', 'each')).toBe('72 each')
  })

  it('treats the canonical lowercase litre token like L', () => {
    expect(fmtQty(2.75, 'l')).toBe('2.8 l')
    expect(fmtQty(1.375, 'l')).toBe('1.4 l')
    expect(fmtQty(6, 'l')).toBe('6 l')
  })
})

describe('stepFactor', () => {
  it('regression: a noisy float just above 0.75 still steps down to 0.5', () => {
    expect(stepFactor(0.7500000000000001, -1, 0.25, 5)).toBe(0.5)
  })

  it('regression: a noisy float still steps up from its snapped grid point', () => {
    // 0.7500000000000001 snaps to 0.75, so `+` must land on the NEXT quarter, 1.0 —
    // not stay stuck at 0.75 the way the buggy floor/ceil-without-snap did.
    expect(stepFactor(0.7500000000000001, 1, 0.25, 5)).toBe(1)
  })

  it('on-grid stepping up', () => {
    expect(stepFactor(1.25, 1, 0.25, 5)).toBe(1.5)
  })

  it('on-grid stepping down', () => {
    expect(stepFactor(1.25, -1, 0.25, 5)).toBe(1)
  })

  it('genuinely off-grid: + lands on the neighbouring quarter, not round-then-step', () => {
    // From 1.13, the correct neighbour is 1.25. A round-then-step implementation
    // would first round 1.13 to 1.25 and then add a further 0.25, landing on 1.5 — wrong.
    expect(stepFactor(1.13, 1, 0.25, 5)).toBe(1.25)
  })

  it('genuinely off-grid: - lands on the neighbouring quarter below', () => {
    expect(stepFactor(1.13, -1, 0.25, 5)).toBe(1)
  })

  it('clamps at the max bound', () => {
    expect(stepFactor(5, 1, 0.25, 5)).toBe(5)
  })

  it('clamps at the min bound', () => {
    expect(stepFactor(0.25, -1, 0.25, 5)).toBe(0.25)
  })
})

describe('postedWhenLabel: the time, plus WHICH day the list was posted for', () => {
  // 2026-09-14T20:17 local. The time part is rendered by toLocaleTimeString in
  // the test runner's zone, so assert on the day suffix and use a regex for the time.
  const postedAt = new Date(2026, 8, 14, 20, 17).toISOString()
  it('a list for today is just the time', () => {
    expect(postedWhenLabel(postedAt, '2026-09-14T00:00:00.000Z', '2026-09-14')).toMatch(/^\d{1,2}:\d{2} [AP]M$/)
  })
  it('a list for yesterday says yesterday', () => {
    expect(postedWhenLabel(postedAt, '2026-09-13T00:00:00.000Z', '2026-09-14')).toMatch(/^\d{1,2}:\d{2} [AP]M yesterday$/)
  })
  it('an older list carries its date', () => {
    expect(postedWhenLabel(postedAt, '2026-09-11T00:00:00.000Z', '2026-09-14')).toMatch(/^\d{1,2}:\d{2} [AP]M Sep 11$/)
  })
  it('no listDate falls back to the bare time', () => {
    expect(postedWhenLabel(postedAt, null, '2026-09-14')).toMatch(/^\d{1,2}:\d{2} [AP]M$/)
  })
  it('yesterday across a month boundary', () => {
    expect(postedWhenLabel(postedAt, '2026-09-30T00:00:00.000Z', '2026-10-01')).toMatch(/^\d{1,2}:\d{2} [AP]M yesterday$/)
  })
})
