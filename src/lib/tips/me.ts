/**
 * ONE person's view of ONE payout.
 *
 * THIS FILE IS A DISCLOSURE BOUNDARY. `TipPeriod.snapshot` holds every cook's
 * pay, the sales series, and the pool totals; this is the only thing that turns
 * it into something a STAFF user may see. The transform therefore CONSTRUCTS A
 * NEW OBJECT field by field. Never spread a record or a SplitPerson here, and
 * never "remove" fields from a copy — a field added to SplitPerson later would
 * ride straight through a spread into a cook's phone. The key-whitelist test in
 * __tests__/me.test.ts is what keeps this honest.
 *
 * Pure and I/O-free so `npm test` covers it directly, like engine/audit/period.
 */
import { cappedAway, effectiveHours } from './engine'
import { payoutsInOrder, readSnapshot } from './snapshot'
import type { SplitPerson } from './types'

/** Most recent periods served to a staff user — a year of fortnights. */
export const MY_PAYOUT_LIMIT = 26

export interface MyPayoutDay {
  label: string
  /** Hours actually paid on — clipped by this person's cap. */
  hours: number
  /** Hours as clocked, so a cap is explicable rather than mysterious. */
  rawHours: number
  capped: boolean
  /** Reward multiplier. 1 = none. */
  boost: number
  /** Hours came from a manual adjustment rather than the clock file. */
  edited: boolean
  amount: number
}

export interface MyPayout {
  periodId: string
  startDate: string
  endDate: string
  paidAt: string
  paidByName: string | null
  /** BEING_CORRECTED when the period was reopened after this payout. */
  status: 'PAID' | 'BEING_CORRECTED'
  roleName: string
  multiplier: number
  dailyHourCap: number | null
  hoursTotal: number
  /** Exact dollars earned. */
  tip: number
  /** Rounded cash actually handed over. */
  envelopeCents: number
  perHour: number
  days: MyPayoutDay[]
}

export interface ProjectMyPayoutInput {
  periodId: string
  startDate: string
  endDate: string
  /** The raw `TipPeriod.snapshot` column. Decoded here via readSnapshot. */
  snapshotRaw: unknown
  cookId: string
}

const num = (v: unknown, fallback = 0): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

export function projectMyPayout({
  periodId, startDate, endDate, snapshotRaw, cookId,
}: ProjectMyPayoutInput): MyPayout | null {
  // Always through readSnapshot — a legacy flat snapshot must migrate to v1
  // before anything reads it, and an unrecognisable blob must read as "no
  // payout" rather than being presented as one.
  const snap = readSnapshot(snapshotRaw)
  if (!snap) return null

  // The LAST payout actually made, whether or not it is still in force. A
  // reopened period has current: null but the cook is still holding the cash;
  // reading `current` alone would erase that payout from their phone.
  const all = payoutsInOrder(snap)
  const record = all[all.length - 1]
  if (!record) return null

  const me = record.split?.people?.find(p => p.cookId === cookId)
  if (!me) return null

  // A cap only applies when it is greater than zero — same rule as
  // effectiveHours, which this delegates the actual clipping to.
  const rawCap = num(me.dailyHourCap, 0)
  const cap = rawCap > 0 ? rawCap : null

  const labels = Array.isArray(record.dayLabels) ? record.dayLabels : []
  const days: MyPayoutDay[] = labels.map((label, d) => {
    const rawHours = num(me.hours?.[d])
    const hours = effectiveHours(me as SplitPerson, d)
    return {
      label: String(label),
      hours,
      rawHours,
      capped: cappedAway(me as SplitPerson, d) > 0,
      boost: num(me.boosts?.[d], 1),
      edited: me.edited?.[d] === true,
      amount: num(me.daily?.[d]),
    }
  })

  const hoursTotal = num(me.hoursTotal)
  const tip = num(me.tip)

  return {
    periodId,
    startDate,
    endDate,
    paidAt: String(record.paidAt),
    paidByName: record.paidByName ?? null,
    status: snap.current ? 'PAID' : 'BEING_CORRECTED',
    roleName: String(me.roleName ?? ''),
    multiplier: num(me.multiplier, 1),
    dailyHourCap: cap,
    hoursTotal,
    tip,
    envelopeCents: num(me.envelopeCents),
    // Zero hours must read as $0.00/h, never Infinity or NaN.
    perHour: hoursTotal > 0 ? Math.round((tip / hoursTotal) * 100) / 100 : 0,
    days,
  }
}
