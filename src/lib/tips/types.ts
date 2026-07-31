/** DTOs shared by the tip engine, the audit, and the API payload. */

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
   * day are not paid tips. Null = uncapped. Per-person, never house-wide.
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
  /** Day pool dollars — basis × rate. */
  pools: number[]
  poolTotal: number
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
