import { describe, it, expect } from 'vitest'
import { cookSequence, cursorOf, waitClock, nextAction, stepMoveFields, applyStepToItem, checkStepMove, moveTime, fmtDur, type CookItem } from '../prep-steps'
import type { MethodStep } from '../recipe-method'

// First six steps of the real Sourdough Bread method.
const SOURDOUGH: MethodStep[] = [
  { key: 's1', text: 'Mix flour and water', phase: 'Autolyse', minutes: 5, wait: { minutes: 30, note: 'loosely covered' } },
  { key: 's2', text: 'Add the starter', phase: 'Mix', minutes: 5 },
  { key: 's3', text: 'Add the salt', minutes: 5 },
  { key: 's4', text: 'Window-pane test', minutes: 3 },
  { key: 's5', text: 'Stretch and fold', phase: 'Bulk Ferment', minutes: 2, wait: { minutes: 30 } },
  { key: 's6', text: '1st coil fold', minutes: 1 },
]
// Smoked Pork Belly shape: b is a 0-minute step whose wait merges into a's wait.
const PORK: MethodStep[] = [
  { key: 'a', text: 'Cure', minutes: 5, wait: { minutes: 1440 } },
  { key: 'b', text: 'Temper', wait: { minutes: 30 } },
  { key: 'c', text: 'Smoke', minutes: 10, wait: { minutes: 165 } },
  { key: 'd', text: 'Wrap', minutes: 10 },
]
const PLAIN: MethodStep[] = [
  { key: 'p1', text: 'Chop' },
  { key: 'p2', text: 'Mix' },
  { key: 'p3', text: 'Store' },
]

const T0 = Date.UTC(2026, 10, 16, 18, 0) // "10:00"
const at = (min: number) => T0 + min * 60_000
const iso = (min: number) => new Date(at(min)).toISOString()
const seq = () => cookSequence(SOURDOUGH) as CookItem[]
const waitItem = (s: CookItem[], key: string) => s.find(i => i.key === key) as CookItem & { kind: 'WAIT' }

describe('cookSequence — a method flattened into single steps and waits', () => {
  it('puts each wait right after its step, with the chain convention key', () => {
    expect(seq().map(i => i.key)).toEqual(['s1', 's1:wait', 's2', 's3', 's4', 's5', 's5:wait', 's6'])
  })
  it('carries the phase down and numbers the steps', () => {
    const s = seq()
    expect(s[2].phase).toBe('Mix')
    expect(s[3].phase).toBe('Mix')
    expect(s[3]).toMatchObject({ kind: 'STEP', number: 3, minutes: 5 })
    expect(s[6].phase).toBe('Bulk Ferment')
  })
  it('maps each item to the chain block it belongs to', () => {
    const s = seq()
    expect(s[0].chainIndex).toBe(0)
    expect(s[1].chainIndex).toBe(1)
    expect(s[2].chainIndex).toBe(2)
    expect(s[5].chainIndex).toBe(2)
    expect(s[6].chainIndex).toBe(3)
    expect(s[7].chainIndex).toBe(4)
    expect(s[6].chainKey).toBe('s5:wait')
  })
  it('a merged wait keeps its own minutes; its step sits in the PASSIVE block', () => {
    const s = cookSequence(PORK) as CookItem[]
    const b = s.find(i => i.key === 'b')!
    const bw = waitItem(s, 'b:wait')
    expect(b.chainIndex).toBe(1)
    expect(bw.chainIndex).toBe(1)
    expect(bw.minutes).toBe(30)
  })
  it('an untimed method still steps, with no chain', () => {
    const s = cookSequence(PLAIN) as CookItem[]
    expect(s.map(i => i.kind)).toEqual(['STEP', 'STEP', 'STEP'])
    expect(s.every(i => i.chainIndex === null && i.chainKey === null)).toBe(true)
  })
  it('no method → null', () => {
    expect(cookSequence([])).toBeNull()
    expect(cookSequence(null)).toBeNull()
  })
})

describe('cursorOf — where the job is', () => {
  it('reads the saved step', () => {
    expect(cursorOf(seq(), { stepKey: 's4' })).toBe(4)
  })
  it('cursorOf falls back to the stage block (jobs in flight before this shipped)', () => {
    expect(cursorOf(seq(), { stageIndex: 2 })).toBe(2)
  })
  it('cursorOf ignores an unknown stepKey (recipe edited mid-job)', () => {
    expect(cursorOf(seq(), { stepKey: 'gone', stageIndex: 2 })).toBe(2)
    expect(cursorOf(seq(), { stepKey: 'gone' })).toBe(0)
    expect(cursorOf(seq(), null)).toBe(0)
  })
})

describe('waitClock — the wait timer', () => {
  const w = () => waitItem(seq(), 's1:wait')
  it('counts down while resting', () => {
    expect(waitClock(w(), { stepEnteredAt: iso(0) }, at(12))).toMatchObject({ readyAtMs: at(30), leftMin: 18, state: 'resting' })
  })
  it('is ready at the time, overdue an hour past it', () => {
    expect(waitClock(w(), { stepEnteredAt: iso(0) }, at(31))!.state).toBe('ready')
    expect(waitClock(w(), { stepEnteredAt: iso(0) }, at(91))!.state).toBe('overdue')
  })
  it('null without a start time', () => {
    expect(waitClock(w(), {}, at(5))).toBeNull()
  })
})

describe('nextAction — what the Next button says', () => {
  const s = seq()
  it('same phase → Next step', () => {
    expect(nextAction(s, 2, null)).toEqual({ kind: 'work', to: 3, label: 'Next step', sub: 'Hands-on · 5 min' })
  })
  it('new phase → Next: <phase>', () => {
    expect(nextAction(s, 4, null)).toMatchObject({ kind: 'work', label: 'Next: Bulk Ferment', sub: 'Hands-on · 2 min' })
  })
  it('next is a wait → Start wait', () => {
    expect(nextAction(s, 5, null)).toEqual({ kind: 'wait', to: 6, label: 'Start wait: Bulk Ferment', sub: '30 min wait' })
  })
  it('in a wait, still resting → held', () => {
    const clock = waitClock(waitItem(s, 's5:wait'), { stepEnteredAt: iso(0) }, at(12))
    expect(nextAction(s, 6, clock)).toEqual({ kind: 'held', to: 7, label: 'Resting · 18 min left', sub: 'Ready early? Open to move on' })
  })
  it('in a wait, timer out → ready', () => {
    const clock = waitClock(waitItem(s, 's5:wait'), { stepEnteredAt: iso(0) }, at(40))
    expect(nextAction(s, 6, clock)).toEqual({ kind: 'ready', to: 7, label: 'Next step', sub: 'Hands-on · 1 min' })
  })
  it('last step → Log yield', () => {
    expect(nextAction(s, 7, null)).toMatchObject({ kind: 'log', to: null, label: 'Log yield' })
  })
  it('a 0-minute step says just Hands-on', () => {
    expect(nextAction(cookSequence(PLAIN)!, 0, null).sub).toBe('Hands-on')
  })
})

describe('stepMoveFields — the one cursor move both server and client apply', () => {
  it('inside a block: only the cursor moves', () => {
    const f = stepMoveFields(seq(), { stepKey: 's2', stageIndex: 2 }, 's3', iso(0))
    expect(f).toEqual({ stepKey: 's3', stepEnteredAt: iso(0) })
  })
  it('into a new block: the chain follows, history recorded', () => {
    const f = stepMoveFields(seq(), { stepKey: 's5', stageIndex: 2, stageHistory: [] }, 's5:wait', iso(0), 'cook1')!
    expect(f.stageIndex).toBe(3)
    expect(f.stageEnteredAt).toBe(iso(0))
    expect(f.stageHistory).toEqual([{ index: 3, key: 's5:wait', enteredAt: iso(0), byCookId: 'cook1' }])
  })
  it('unknown step → null', () => {
    expect(stepMoveFields(seq(), {}, 'nope', iso(0))).toBeNull()
  })
  it('untimed method: cursor only', () => {
    expect(stepMoveFields(cookSequence(PLAIN)!, {}, 'p2', iso(0))).toEqual({ stepKey: 'p2', stepEnteredAt: iso(0) })
  })
})

describe('applyStepToItem — the optimistic move the screen shows before the server answers', () => {
  const item = (log: Record<string, unknown> | null) => ({ id: 'i1', linkedRecipe: { method: SOURDOUGH }, todayLog: log as never })
  it('a not-started job goes on the go at that step', () => {
    const out = applyStepToItem(item({ id: 'l1', status: 'NOT_STARTED', startedAt: null }), 's3', iso(0))
    expect(out.todayLog).toMatchObject({ status: 'IN_PROGRESS', startedAt: iso(0), stepKey: 's3', stepEnteredAt: iso(0), stageIndex: 2 })
  })
  it('keeps the first start time', () => {
    const out = applyStepToItem(item({ id: 'l1', status: 'IN_PROGRESS', startedAt: iso(-60), stepKey: 's2', stageIndex: 2 }), 's3', iso(0))
    expect(out.todayLog).toMatchObject({ startedAt: iso(-60), stepKey: 's3', stageIndex: 2 })
  })
  it('an unknown step or no log leaves the item untouched', () => {
    const it1 = item({ id: 'l1', status: 'IN_PROGRESS' })
    expect(applyStepToItem(it1, 'nope', iso(0))).toBe(it1)
    const it2 = item(null)
    expect(applyStepToItem(it2, 's2', iso(0))).toBe(it2)
  })
})

describe('review fixes — jobs mid-wait when the cursor ships', () => {
  const s = seq()
  it('waitClock falls back to the block start for a job started before the cursor existed', () => {
    const c = waitClock(waitItem(s, 's1:wait'), { stageIndex: 1, stageEnteredAt: iso(0) }, at(12))
    expect(c).toMatchObject({ leftMin: 18, state: 'resting' })
  })
  it('a saved step without its own start time does not borrow the block clock', () => {
    expect(waitClock(waitItem(s, 's1:wait'), { stepKey: 's1:wait', stageEnteredAt: iso(0) }, at(12))).toBeNull()
  })
  it('a wait with no clock at all is held, never Log yield', () => {
    expect(nextAction(s, 6, null)).toEqual({ kind: 'held', to: 7, label: 'Resting', sub: 'Ready early? Open to move on' })
  })
})

describe('checkStepMove — a stale screen cannot move a job backwards', () => {
  const s = seq()
  it('ok when the move starts from where the job is', () => {
    expect(checkStepMove(s, { status: 'IN_PROGRESS', stepKey: 's5' }, 's5', 's5:wait')).toBe('ok')
  })
  it('noop when the job is already there (double tap, two devices)', () => {
    expect(checkStepMove(s, { status: 'IN_PROGRESS', stepKey: 's5:wait' }, 's5', 's5:wait')).toBe('noop')
  })
  it('stale when another screen already moved it', () => {
    expect(checkStepMove(s, { status: 'IN_PROGRESS', stepKey: 's5:wait' }, 's2', 's3')).toBe('stale')
  })
  it('stale when the job is already finished', () => {
    expect(checkStepMove(s, { status: 'DONE', stepKey: null }, 's5', 's6')).toBe('stale')
  })
  it('the job\'s place comes from the block for jobs started before the cursor', () => {
    expect(checkStepMove(s, { status: 'IN_PROGRESS', stageIndex: 3 }, 's5:wait', 's6')).toBe('ok')
  })
  it('no from key (an old screen) is allowed', () => {
    expect(checkStepMove(s, { status: 'IN_PROGRESS', stepKey: 's2' }, null, 's3')).toBe('ok')
  })
})

describe('moveTime — an offline tap keeps the time it was tapped', () => {
  it('uses the tap time', () => {
    expect(moveTime(iso(25), iso(0), null)).toBe(iso(0))
  })
  it('never later than now, never before the previous step started', () => {
    expect(moveTime(iso(0), iso(30), null)).toBe(iso(0))
    expect(moveTime(iso(25), iso(0), iso(10))).toBe(iso(10))
  })
  it('now when there is no tap time', () => {
    expect(moveTime(iso(5), undefined, null)).toBe(iso(5))
  })
})

describe('fmtDur — button wording a cook can read at a glance', () => {
  it('spells minutes and hours out', () => {
    expect(fmtDur(5)).toBe('5 min')
    expect(fmtDur(60)).toBe('1 h')
    expect(fmtDur(165)).toBe('2 h 45 min')
    expect(fmtDur(960)).toBe('16 h')
  })
})
