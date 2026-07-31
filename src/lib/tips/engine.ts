/**
 * Tip split engine — PURE. No DOM, no Prisma, no server-only imports: the page
 * re-runs this on every keystroke as the manager drags the pool rate.
 *
 * Method (identical to the BOH tips sheet the mock reproduces):
 *   1. day pool      = that day's basis × pool rate  (basis = net sales OR tips collected)
 *   2. weighted hrs  = Σ over people of (capped hours × role multiplier × reward boost)
 *   3. person's day  = day pool × their weighted hours ÷ the day's weighted hours
 *   4. period tip    = Σ of their daily shares
 * Working the busy days therefore earns more per hour, which is the whole point.
 */
import type {
  Breakdown, Denom, SortKey, SplitInput, SplitPerson, SplitResult, TipPerson, TipRoleDef,
} from './types'

const FALLBACK_ROLE: TipRoleDef = { id: '', name: '—', multiplier: 1, sortOrder: 999 }

export function roleOf(person: TipPerson, roles: TipRoleDef[]): TipRoleDef {
  return roles.find(r => r.id === person.roleId) ?? FALLBACK_ROLE
}

/**
 * Hours actually paid on a day — the raw clocked hours, clamped by THIS
 * PERSON'S contracted cap. There is deliberately no house-wide cap argument:
 * a 10 h-agreement cook and an 8 h-agreement cook are capped differently on
 * the same shift, so the cap can only live on the person.
 *
 * A cap of null, zero, or negative is treated as uncapped — only a cap
 * greater than zero actually clips hours.
 */
export function effectiveHours(person: TipPerson, day: number): number {
  const raw = person.hours[day] ?? 0
  const cap = person.dailyHourCap
  return cap != null && cap > 0 ? Math.min(raw, cap) : raw
}

/** Hours clipped off one person's day by their own cap. 0 when uncapped. */
export function cappedAway(person: TipPerson, day: number): number {
  return (person.hours[day] ?? 0) - effectiveHours(person, day)
}

export function computeSplit(input: SplitInput): SplitResult {
  const { basis, poolRatePct, roundingStepCents, roles, people } = input
  const dayCount = basis.length

  // A refund-heavy day can push `basis` negative (e.g. a same-day refund
  // washing out net sales). Floor each day's pool at zero: a bad day cannot
  // create a negative tip obligation for the people who worked it. The
  // negative basis itself is a manager-facing signal surfaced elsewhere
  // (the audit), not something netted out of anyone's pay here.
  const pools = basis.map(b => Math.max(0, (b * poolRatePct) / 100))
  const poolTotal = pools.reduce((a, b) => a + b, 0)

  const active = people.filter(p => p.onPool)
  const weightedByDay: number[] = []
  const crewByDay: number[] = []
  for (let d = 0; d < dayCount; d++) {
    let w = 0
    let crew = 0
    for (const p of active) {
      const h = effectiveHours(p, d)
      if (h > 0) crew++
      w += h * roleOf(p, roles).multiplier * (p.boosts[d] ?? 1)
    }
    weightedByDay.push(w)
    crewByDay.push(crew)
  }

  const computed: SplitPerson[] = people.map(p => {
    const role = roleOf(p, roles)
    const daily: number[] = []
    let hoursTotal = 0
    let weighted = 0
    let tip = 0
    for (let d = 0; d < dayCount; d++) {
      const h = p.onPool ? effectiveHours(p, d) : 0
      const w = h * role.multiplier * (p.boosts[d] ?? 1)
      hoursTotal += h
      weighted += w
      const share = weightedByDay[d] > 0 ? (pools[d] * w) / weightedByDay[d] : 0
      daily.push(share)
      tip += share
    }
    return {
      ...p,
      multiplier: role.multiplier,
      roleName: role.name,
      hoursTotal, weighted, daily, tip,
      envelopeCents: 0,
    }
  }).filter(p => p.onPool && p.hoursTotal > 0)

  // The money actually owed to people — distinct from poolTotal, which can
  // include day pools nobody on the roster was on shift to earn. See
  // SplitResult.distributedTotal.
  const distributedTotal = computed.reduce((a, p) => a + p.tip, 0)

  computed.sort((a, b) => b.tip - a.tip || a.cookId.localeCompare(b.cookId))
  assignEnvelopes(computed, distributedTotal, roundingStepCents)

  return {
    pools, poolTotal, distributedTotal, weightedByDay, crewByDay,
    people: computed,
    hoursTotal: computed.reduce((a, p) => a + p.hoursTotal, 0),
    weightedTotal: computed.reduce((a, p) => a + p.weighted, 0),
    envelopeTotalCents: computed.reduce((a, p) => a + p.envelopeCents, 0),
  }
}

/**
 * Largest-remainder rounding: every envelope is a whole multiple of `step`
 * cents and the envelopes sum EXACTLY to `distributedTotal` (the money
 * actually owed to people — Σ tip) rounded to that step. Deliberately NOT
 * targeted at the whole pool: a day pool nobody on the roster was on shift
 * to earn contributes to `poolTotal` but should not be paid out to whoever
 * else happens to be standing there.
 *
 * Differs from the mock on purpose: tips.js only ever hands units out
 * (`for(...; left>0; left--)`), so when the pool rounds DOWN the envelopes
 * overshoot the target and the float silently covers the difference. Here a
 * negative remainder takes units back, starting from the smallest fraction,
 * cycling the list as many times as it takes — a single descending pass can
 * under-discharge when several candidates in a row are already at 0 units.
 */
function assignEnvelopes(people: SplitPerson[], distributedTotal: number, stepIn: number): void {
  if (!people.length) return
  // A non-positive step has no meaningful "nearest step" — treat it as
  // whole-cent rounding instead of silently dividing by zero into NaN.
  const step = stepIn > 0 ? stepIn : 1
  const units = people.map(p => (p.tip * 100) / step)
  const floors = units.map(Math.floor)
  const target = Math.round((distributedTotal * 100) / step)
  let left = target - floors.reduce((a, b) => a + b, 0)

  const byFraction = units
    .map((u, i) => ({ i, frac: u - Math.floor(u) }))
    .sort((a, b) => b.frac - a.frac || people[a.i].cookId.localeCompare(people[b.i].cookId))

  for (let k = 0; k < byFraction.length && left > 0; k++, left--) floors[byFraction[k].i]++

  // Repeat descending passes until the shortfall is fully discharged or a
  // full pass makes no progress (every remaining candidate is at 0 units —
  // should not happen given target <= Σ floors + people.length, but this is
  // the guard that keeps a violation loud instead of an infinite loop).
  let guardPasses = 0
  while (left < 0 && guardPasses <= byFraction.length) {
    let progressed = false
    for (let k = byFraction.length - 1; k >= 0 && left < 0; k--) {
      const idx = byFraction[k].i
      if (floors[idx] > 0) { floors[idx]--; left++; progressed = true }
    }
    guardPasses++
    if (!progressed) break
  }

  people.forEach((p, i) => { p.envelopeCents = floors[i] * step })
}

/**
 * Greedy note/coin breakdown for one envelope. Consumes `denoms` in the
 * order supplied, not sorted by face value — callers must pass them
 * largest-to-smallest (descending) to get a largest-denomination-first
 * breakdown.
 */
export function breakdown(cents: number, denoms: Denom[]): Breakdown {
  const parts: Breakdown['parts'] = []
  let rem = cents
  for (const d of denoms) {
    if (!d.on) continue
    const n = Math.floor(rem / d.v)
    if (n > 0) { parts.push({ ...d, n }); rem -= n * d.v }
  }
  return { parts, remainder: rem }
}

const SORT_VALUE: Record<SortKey, (p: SplitPerson) => number | string> = {
  name: p => p.name.toLowerCase(),
  role: p => p.multiplier,
  hours: p => p.hoursTotal,
  weighted: p => p.weighted,
  rate: p => (p.hoursTotal ? p.tip / p.hoursTotal : 0),
  share: p => p.tip,
  tip: p => p.tip,
  env: p => p.envelopeCents,
}

/** Default direction per column — names ascend, money descends. */
export const DEFAULT_SORT_DIR: Record<SortKey, 1 | -1> = {
  name: 1, role: -1, hours: -1, weighted: -1, rate: -1, share: -1, tip: -1, env: -1,
}

export function sortPeople(people: SplitPerson[], key: SortKey, dir: 1 | -1): SplitPerson[] {
  const value = SORT_VALUE[key] ?? SORT_VALUE.tip
  return people.slice().sort((a, b) => {
    const va = value(a)
    const vb = value(b)
    if (va < vb) return -dir
    if (va > vb) return dir
    return a.name.localeCompare(b.name)
  })
}
