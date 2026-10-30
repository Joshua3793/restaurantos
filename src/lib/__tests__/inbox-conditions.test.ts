import { describe, it, expect } from 'vitest'
import {
  collectConditions, loadedFamilies, ownsItem, familyOf, clearNote, keyDate, CLEAR_NOTES,
  type ConditionsInput, type TempUnitIn, type PrepItemIn,
} from '@/lib/inbox/conditions'
import { canSee } from '@/lib/inbox/rules'

const NOW = new Date('2026-10-30T16:00:00Z') // 09:00 Pacific, Friday
const DATE = '2026-10-30'
const base = (o: Partial<ConditionsInput> = {}): ConditionsInput => ({ rcId: 'rcA', now: NOW, date: DATE, ...o })

const unit = (o: Partial<TempUnitIn> = {}): TempUnitIn => ({
  id: 'u1', name: 'Walk-in', type: 'FRIDGE', safeMin: 0, safeMax: 4, revenueCenterId: 'rcA', readings: [], ...o,
})
const prep = (o: Partial<PrepItemIn> = {}): PrepItemIn => ({
  id: 'p1', name: 'Aioli', unit: 'l', onHand: 0.5, parLevel: 2, priority: '911',
  assignedCook: null, todayLog: null, revenueCenterId: 'rcA', ...o,
})

describe('collectConditions — temps', () => {
  it('a cold unit whose latest reading is out of range → temp-bad, Food safety, NOW', () => {
    const [c] = collectConditions(base({ temps: [unit({ readings: [{ time: '08:00', temp: 6.5 }] })] }))
    expect(c).toMatchObject({
      sourceKey: 'temp-bad:u1:2026-10-30', tagBuiltIn: 'FOOD_SAFETY', severity: 'NOW',
      title: 'Walk-in at 6.5°C', place: 'Walk-in', href: '/temps', managerOnly: false, revenueCenterId: 'rcA',
    })
  })

  it('a cold unit logged in range → no condition', () => {
    expect(collectConditions(base({ temps: [unit({ readings: [{ time: '08:00', temp: 3 }] })] }))).toEqual([])
  })

  it('a later in-range reading clears the bad one (latest wins)', () => {
    const readings = [{ time: '07:00', temp: 7 }, { time: '08:00', temp: 3 }]
    expect(collectConditions(base({ temps: [unit({ readings })] }))).toEqual([])
  })

  it('cold units not logged today → one temp-missing for the kitchen, Food safety, NOW', () => {
    const conds = collectConditions(base({
      temps: [unit(), unit({ id: 'u2', name: 'Freezer', type: 'FREEZER', revenueCenterId: null }),
        unit({ id: 'u3', name: 'Bain', type: 'HOT' })],
    }))
    expect(conds).toHaveLength(1)
    expect(conds[0]).toMatchObject({
      sourceKey: 'temp-missing:rcA:2026-10-30', tagBuiltIn: 'FOOD_SAFETY', severity: 'NOW',
      title: "Today's temps not logged", body: 'Walk-in, Freezer', revenueCenterId: 'rcA',
    })
  })

  it('a shared unit reading bad files on the whole house (null kitchen)', () => {
    const [c] = collectConditions(base({ temps: [unit({ revenueCenterId: null, readings: [{ time: '08:00', temp: 9 }] })] }))
    expect(c.revenueCenterId).toBeNull()
  })

  it('no kitchen → no temp-missing', () => {
    expect(collectConditions(base({ rcId: null, temps: [unit()] }))).toEqual([])
  })
})

describe('collectConditions — stations', () => {
  const stations = (list: NonNullable<ConditionsInput['stations']>['list'], phase: 'OPEN' | 'CLOSE' = 'OPEN') =>
    base({ stations: { phase, businessDate: DATE, list } })

  it('OPEN phase, jobs today, no run → station-open, Checklists, NOW, place = station', () => {
    const [c] = collectConditions(stations([{ id: 's1', name: 'Grill', revenueCenterId: 'rcA', hasRun: false, jobCount: 6 }]))
    expect(c).toMatchObject({
      sourceKey: 'station-open:s1:2026-10-30', tagBuiltIn: 'CHECKLISTS', severity: 'NOW',
      title: "Grill hasn't started opening", place: 'Grill', href: '/checklist/today', revenueCenterId: 'rcA',
    })
  })

  it('a station with 0 applicable jobs → no condition', () => {
    expect(collectConditions(stations([{ id: 's1', name: 'Grill', revenueCenterId: 'rcA', hasRun: false, jobCount: 0 }]))).toEqual([])
  })

  it('a station that has started → no condition; nor in the CLOSE phase', () => {
    expect(collectConditions(stations([{ id: 's1', name: 'Grill', revenueCenterId: 'rcA', hasRun: true, jobCount: 6 }]))).toEqual([])
    expect(collectConditions(stations([{ id: 's1', name: 'Grill', revenueCenterId: 'rcA', hasRun: false, jobCount: 6 }], 'CLOSE'))).toEqual([])
  })
})

describe('collectConditions — closing left unsigned', () => {
  it('close-unsigned:<runId>, Checklists, TODAY', () => {
    const [c] = collectConditions(base({
      closeRuns: [{ id: 'r9', stationName: 'Pastry', revenueCenterId: 'rcA', businessDate: '2026-10-29' }],
    }))
    expect(c).toMatchObject({
      sourceKey: 'close-unsigned:r9', tagBuiltIn: 'CHECKLISTS', severity: 'TODAY',
      title: "Pastry closing wasn't signed off", body: 'Closing list for Thu 29 Oct', place: 'Pastry',
    })
  })
})

describe('collectConditions — prep', () => {
  it('critical prep nobody is on → prep:<id>:<date>, Prep, NOW, the start-page wording', () => {
    const [c] = collectConditions(base({ prep: [prep()] }))
    expect(c).toMatchObject({
      sourceKey: 'prep:p1:2026-10-30', tagBuiltIn: 'PREP', severity: 'NOW',
      title: 'Aioli — 0.5 l left', body: 'Not on the To Do', href: '/prep', revenueCenterId: 'rcA',
    })
  })

  it('assigned, in progress, done or not critical → no condition', () => {
    expect(collectConditions(base({ prep: [
      prep({ id: 'a', assignedCook: { name: 'Ana' } }),
      prep({ id: 'b', todayLog: { status: 'IN_PROGRESS' } }),
      prep({ id: 'c', todayLog: { status: 'DONE' } }),
      prep({ id: 'd', priority: 'NEEDED_TODAY' }),
    ] }))).toEqual([])
  })
})

describe('collectConditions — money', () => {
  it('an UP price alert → price:<id>, Money, TODAY, manager-only, whole house', () => {
    const [c] = collectConditions(base({ priceAlerts: [
      { id: 'pa1', changePct: '12.4', direction: 'UP', itemName: 'Goats Cheese', supplierName: 'Sysco' },
      { id: 'pa2', changePct: '-5', direction: 'DOWN', itemName: 'Butter', supplierName: 'Sysco' },
    ] }))
    expect(c).toMatchObject({
      sourceKey: 'price:pa1', tagBuiltIn: 'MONEY', severity: 'TODAY',
      title: 'Goats Cheese up 12% at Sysco', href: '/invoices', managerOnly: true, revenueCenterId: null,
    })
  })

  it('a money condition is hidden from a LEAD (managerOnly true), shown to a MANAGER', () => {
    const conds = collectConditions(base({
      priceAlerts: [{ id: 'pa1', changePct: 8, direction: 'UP', itemName: 'Brie', supplierName: null }],
      invoices: { awaiting: 2 },
    }))
    expect(conds.map(c => c.managerOnly)).toEqual([true, true])
    for (const c of conds) {
      expect(canSee('LEAD', c)).toBe(false)
      expect(canSee('MANAGER', c)).toBe(true)
    }
    expect(conds[0].title).toBe('Brie up 8%')
  })

  it('invoices waiting → invoices:<rcId>, Money, TODAY, "<n> invoices to approve"', () => {
    const [c] = collectConditions(base({ invoices: { awaiting: 3 } }))
    expect(c).toMatchObject({
      sourceKey: 'invoices:rcA', tagBuiltIn: 'MONEY', severity: 'TODAY',
      title: '3 invoices to approve', href: '/invoices', managerOnly: true, revenueCenterId: 'rcA',
    })
    expect(collectConditions(base({ invoices: { awaiting: 0 } }))).toEqual([])
  })
})

describe('collectConditions — count', () => {
  it('older than 4 days → count-stale:<rcId>, Stock, FYI', () => {
    const [c] = collectConditions(base({ count: { days: 6 } }))
    expect(c).toMatchObject({
      sourceKey: 'count-stale:rcA', tagBuiltIn: 'STOCK', severity: 'FYI',
      title: 'Last count was 6 days ago', href: '/count', managerOnly: false,
    })
  })

  it('4 days or fewer, or never counted → no condition', () => {
    expect(collectConditions(base({ count: { days: 4 } }))).toEqual([])
    expect(collectConditions(base({ count: { days: null } }))).toEqual([])
  })
})

describe('collectConditions — phones', () => {
  const phone = (o: Record<string, unknown> = {}) => ({
    id: 'd1', name: 'Sam Lee', pairCode: '4821', status: 'PENDING',
    createdAt: new Date(NOW.getTime() - 60 * 60_000), blocked: false, ...o,
  })

  it('a pending phone → phone:<id>, Team, TODAY, manager-only, "Code <pair>"', () => {
    const [c] = collectConditions(base({ phones: [phone()] }))
    expect(c).toMatchObject({
      sourceKey: 'phone:d1', tagBuiltIn: 'TEAM', severity: 'TODAY',
      title: "Sam Lee's phone wants your OK", body: 'Code 4821', href: '/checklist/crew',
      managerOnly: true, revenueCenterId: null,
    })
  })

  it('a stale phone (over 24 h) → no condition; nor a blocked or handled one', () => {
    expect(collectConditions(base({ phones: [
      phone({ createdAt: new Date(NOW.getTime() - 25 * 3600_000) }),
      phone({ id: 'd2', blocked: true }),
      phone({ id: 'd3', status: 'APPROVED' }),
    ] }))).toEqual([])
  })
})

describe('which items a sync may clear', () => {
  const everything = base({
    temps: [], stations: { phase: 'OPEN', businessDate: DATE, list: [] }, closeRuns: [], prep: [],
    priceAlerts: [], invoices: { awaiting: 0 }, count: { days: 1 }, phones: [],
  })

  it('a sync that read every source owns all nine families', () => {
    expect(loadedFamilies(everything).size).toBe(9)
  })

  it('never another kitchen’s item', () => {
    const loaded = loadedFamilies(everything)
    expect(ownsItem({ sourceKey: 'invoices:rcB', revenueCenterId: 'rcB' }, 'rcA', loaded)).toBe(false)
    expect(ownsItem({ sourceKey: 'temp-bad:u9:2026-10-30', revenueCenterId: 'rcB' }, 'rcA', loaded)).toBe(false)
    expect(ownsItem({ sourceKey: 'invoices:rcA', revenueCenterId: 'rcA' }, 'rcA', loaded)).toBe(true)
  })

  it('whole-house price and phone items are judged by every sync', () => {
    const loaded = loadedFamilies(everything)
    expect(ownsItem({ sourceKey: 'price:pa1', revenueCenterId: null }, 'rcA', loaded)).toBe(true)
    expect(ownsItem({ sourceKey: 'phone:d1', revenueCenterId: null }, 'rcA', loaded)).toBe(true)
  })

  it('shared temp units and prep (null kitchen) yes; other null-kitchen families no', () => {
    const loaded = loadedFamilies(everything)
    expect(ownsItem({ sourceKey: 'temp-bad:u1:2026-10-30', revenueCenterId: null }, 'rcA', loaded)).toBe(true)
    expect(ownsItem({ sourceKey: 'prep:p1:2026-10-30', revenueCenterId: null }, 'rcA', loaded)).toBe(true)
    expect(ownsItem({ sourceKey: 'invoices:x', revenueCenterId: null }, 'rcA', loaded)).toBe(false)
  })

  it('a source that did not load clears nothing', () => {
    const loaded = loadedFamilies(base({ invoices: { awaiting: 0 } }))
    expect(ownsItem({ sourceKey: 'invoices:rcA', revenueCenterId: 'rcA' }, 'rcA', loaded)).toBe(true)
    expect(ownsItem({ sourceKey: 'count-stale:rcA', revenueCenterId: 'rcA' }, 'rcA', loaded)).toBe(false)
  })

  it('flag and unknown keys are never the system sync’s', () => {
    expect(familyOf('flag:l1')).toBeNull()
    expect(ownsItem({ sourceKey: 'flag:l1', revenueCenterId: 'rcA' }, 'rcA', loadedFamilies(everything))).toBe(false)
  })
})

describe('clearNote — why an absent condition closed its item', () => {
  const open = base({ stations: { phase: 'OPEN', businessDate: DATE, list: [] }, closeRuns: [], closeAged: ['r1'] })

  it('reads the day off a dated key; undated keys have none', () => {
    expect(keyDate('prep:p1:2026-10-29')).toBe('2026-10-29')
    expect(keyDate('invoices:rcA')).toBeNull()
    expect(keyDate('close-unsigned:r1')).toBeNull()
  })

  it('today’s or undated keys that went away: "Cleared itself"', () => {
    expect(clearNote(`temp-bad:u1:${DATE}`, open)).toBe(CLEAR_NOTES.resolved)
    expect(clearNote('invoices:rcA', open)).toBe('Cleared itself')
    expect(clearNote(`station-open:s1:${DATE}`, open)).toBe(CLEAR_NOTES.resolved)
  })

  it('a dated key from an earlier day: "Day ended — not fixed"', () => {
    for (const k of ['temp-bad:u1:2026-10-29', 'temp-missing:rcA:2026-10-29', 'station-open:s1:2026-10-29', 'prep:p1:2026-10-28']) {
      expect(clearNote(k, open)).toBe('Day ended — not fixed')
    }
  })

  it('a station today once the phase is CLOSE: "Opening window ended — never started"', () => {
    const close = base({ stations: { phase: 'CLOSE', businessDate: DATE, list: [] } })
    expect(clearNote(`station-open:s1:${DATE}`, close)).toBe('Opening window ended — never started')
  })

  it('a closing list that aged out unsigned: "Older than 2 days — never signed"; a signed one cleared itself', () => {
    expect(clearNote('close-unsigned:r1', open)).toBe('Older than 2 days — never signed')
    expect(clearNote('close-unsigned:r2', open)).toBe(CLEAR_NOTES.resolved)
  })
})
