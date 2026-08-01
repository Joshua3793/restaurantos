/** DTOs shared by the tip engine, the audit, and the API payload. */
import type { AuditResult, PunchRow } from './audit'

export interface TipRoleDef {
  id: string
  name: string
  multiplier: number
  sortOrder: number
}

export interface TipPerson {
  cookId: string
  name: string
  lastName: string | null
  clockId: string | null
  wage: number | null
  roleId: string | null
  onPool: boolean
  /**
   * This person's contracted daily hour cap. Hours clocked above it on any one
   * day are not paid tips. A cap must be greater than zero to apply — null,
   * zero, and negative values are all treated as uncapped. Per-person, never
   * house-wide.
   */
  dailyHourCap: number | null
  /** Source hours per day — clocked, or the manual override where `edited` is true. */
  hours: number[]
  /** Reward multiplier per day. 1 = none. */
  boosts: number[]
  /** True on days whose hours came from a manual adjustment rather than the clock file. */
  edited: boolean[]
}

export interface Denom {
  /** Face value in cents. */
  v: number
  /** Display label, e.g. "$20", "25¢". */
  l: string
  on: boolean
}

/** What the pool rate is a percentage of. */
export type PoolBasis = 'NET_SALES' | 'TIPS_COLLECTED'

export interface SplitInput {
  /**
   * The per-day amount the pool rate applies to — daily net sales when the
   * basis is NET_SALES, daily customer tips when it is TIPS_COLLECTED. The
   * engine deliberately does not know which: the caller resolves the basis.
   */
  basis: number[]
  poolRatePct: number
  roundingStepCents: number
  roles: TipRoleDef[]
  people: TipPerson[]
}

export interface SplitPerson extends TipPerson {
  multiplier: number
  roleName: string
  /** Capped hours summed across the period. */
  hoursTotal: number
  /** hours × role multiplier × reward boost, summed. */
  weighted: number
  /** Exact tip dollars per day. */
  daily: number[]
  /** Exact tip dollars for the period. */
  tip: number
  /** Rounded cash envelope, in cents. */
  envelopeCents: number
}

export interface SplitResult {
  /** Day pool dollars — basis × rate, floored at 0 per day (see computeSplit). */
  pools: number[]
  /**
   * Σ pools. NOT the same as `distributedTotal`: a day with a basis but no
   * crew on the pool contributes to `poolTotal` but pays nobody, so that
   * day's money never reaches `distributedTotal`. Callers that need the
   * undistributed amount compute `poolTotal - distributedTotal` themselves.
   */
  poolTotal: number
  /**
   * Σ people[].tip — the money actually owed to people. This, not
   * `poolTotal`, is what envelope rounding targets: rounding against
   * `poolTotal` would hand money nobody earned to whoever's left standing.
   */
  distributedTotal: number
  /** Weighted hours on shift per day. */
  weightedByDay: number[]
  /** Head count on shift per day. */
  crewByDay: number[]
  /** Only people on the pool with hours > 0, sorted tips high → low. */
  people: SplitPerson[]
  hoursTotal: number
  weightedTotal: number
  envelopeTotalCents: number
}

export interface Breakdown {
  parts: Array<Denom & { n: number }>
  /** Cents that could not be made from the enabled denominations. */
  remainder: number
}

export type SortKey =
  | 'name' | 'role' | 'hours' | 'weighted' | 'rate' | 'share' | 'tip' | 'env'

/**
 * ONE payout — the complete, frozen record of a single disbursement of cash.
 *
 * Everything needed to reprint the envelopes and the payroll CSV exactly as
 * they were handed out is in here, including WHO authorised it: `paidByName`
 * lives inside the record, not only on the mutable `TipPeriod.paidByName`
 * column, because reopening a period nulls that column and one reopen would
 * otherwise permanently erase the authoriser.
 *
 * `split.people[]` already carries each person's RESOLVED dailyHourCap,
 * roleId, roleName and multiplier as of this payout, so a later Cook/TipRole
 * edit cannot restate what somebody was actually paid on.
 */
export interface TipPayoutRecord {
  /** 1-based and monotonic for the life of the period. Never reused. */
  seq: number
  /** ISO timestamp of the disbursement. */
  paidAt: string
  /** Who authorised it, captured at pay time. */
  paidByName: string | null
  poolBasis: PoolBasis
  poolRatePct: number
  roundingStepCents: number
  dayLabels: string[]
  basis: number[]
  sales: number[]
  tips: Array<number | null>
  tipTotal: number
  roles: TipRoleDef[]
  split: SplitResult
  audit: AuditResult
}

/**
 * The shape stored in `TipPeriod.snapshot` (a plain Json column — this history
 * is deliberately restructured JSON rather than a schema migration).
 *
 * READ THIS BEFORE KEYING OFF THE COLUMN: `snapshot != null` does NOT mean the
 * period is paid. A reopened period keeps its snapshot — that is the whole
 * point — but with `current: null` and the superseded payout pushed onto
 * `history`. The paid test is `snapshot.current != null`, which is exactly
 * equivalent to `period.status === 'PAID'`.
 *
 * Chronological order is `[...history, current]`: `history` is oldest-first
 * and holds only superseded payouts, `current` is the one in force.
 */
export interface TipPeriodSnapshot {
  /** Shape version. 1 = current/history. A legacy flat snapshot has no `version`. */
  version: 1
  /** The payout in force. Null exactly while the period is DRAFT. */
  current: TipPayoutRecord | null
  /** Superseded payouts, oldest first. Bounded — see `trimmed`. */
  history: TipPayoutRecord[]
  /**
   * How many payouts have been dropped off the FRONT of `history` by the cap.
   * A period paid more times than the cap allows is pathological, but the
   * count (and the resulting gap in `seq`) keeps the record honest instead of
   * silently pretending those payouts never happened.
   */
  trimmed: number
}

export interface TipPeriodSummary {
  id: string
  revenueCenterId: string
  revenueCenterName: string
  startDate: string
  endDate: string
  status: 'DRAFT' | 'PAID'
  paidAt: string | null
  paidByName: string | null
}

/** Everything /tips needs, in one round trip. */
export interface TipPeriodPayload {
  period: TipPeriodSummary & {
    poolBasis: PoolBasis
    poolRatePct: number
    roundingStepCents: number
    ignoredClockIds: string[]
    salesFileName: string | null
    clockFileName: string | null
    salesImportedAt: string | null
    clockImportedAt: string | null
    /**
     * The period's payout history. Non-null as soon as it has EVER been paid,
     * including after a reopen — `snapshot.current` (not `snapshot`) is what
     * tracks status PAID. Always normalized through `readSnapshot`, so a
     * legacy flat snapshot arrives here already migrated to v1.
     */
    snapshot: TipPeriodSnapshot | null
  }
  dayLabels: string[]
  dayDates: string[]
  periodLabel: string
  /** The per-day amount the rate is applied to, after overrides. */
  basis: number[]
  /** Day indexes with no usable basis figure — always a blocking audit error. */
  missingBasisDays: number[]
  sales: {
    net: number[]
    /** Day indexes the configured scope had no SalesEntry row for. */
    missingDays: number[]
    /** Day indexes whose figure came from the imported workbook, not the app. */
    overriddenDays: number[]
    scopeLabel: string
    /**
     * How many revenue centers in the configured scope the caller cannot read.
     * The basis is NOT narrowed to their access (see resolveSalesScopeRcIds);
     * this only drives the `scopenarrow` warning on the Checks tab.
     */
    outOfScopeRcCount: number
  }
  tips: {
    /** Customer tips per day; `null` where the app has no tip data. */
    collected: Array<number | null>
    missingDays: number[]
    overriddenDays: number[]
    /** Sum of the days that DO have data — the FOH pot the pool comes out of. */
    total: number
    /** True when auto-gratuity is being counted as part of the pot. */
    includesAutoGratuity: boolean
  }
  roles: TipRoleDef[]
  /** Every cook, with this period's hours and boosts already resolved. */
  roster: TipPerson[]
  punches: PunchRow[]
  punchTotal: number
  rewardTiers: number[]
  denoms: Denom[]
  poolDepartments: string[]
}
