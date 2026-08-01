/**
 * Tip payout reconciliation — PURE.
 *
 * Proves where every clocked hour went and flags anything that would make the
 * payout wrong. The ledger must close: clocked = paid + every deduction. If it
 * does not, the period is not safe to pay.
 *
 * Ported from the design's tips-audit.js. The mock's duplicate-employee-code
 * check is NOT ported — Cook.clockId carries a unique index, so two roster rows
 * cannot share a code.
 */
import { cappedAway, effectiveHours } from './engine'
import type { PoolBasis, SplitResult, TipPerson, TipRoleDef } from './types'

export interface PunchRow {
  clockId: string
  firstName: string
  lastName: string
  position: string
  department: string
  dayIndex: number
  hours: number
  status: string
  note: string | null
}

export type Severity = 'error' | 'warn' | 'info'

export interface FindingAction {
  label: string
  kind: 'addPerson' | 'ignoreCode' | 'onPool' | 'setCode' | 'goto'
  arg: string
  ghost?: boolean
}

export interface Finding {
  severity: Severity
  id: string
  title: string
  detail: string
  actions?: FindingAction[]
  /**
   * Hours or dollars at stake — used only to rank findings of equal
   * severity. Exception: `malformed` and `malformed-roster` pass a row/value
   * COUNT here instead, since an unreadable row has no hours or dollars to
   * report — the count is still a reasonable severity-within-error ranking
   * (more unreadable rows outranks fewer), just not the same unit as every
   * other finding's `amount`.
   */
  amount?: number
}

export interface LedgerRow {
  label: string
  value: number
  note?: string
  lead?: boolean
  subtotal?: boolean
  bad?: boolean
  warn?: boolean
  muted?: boolean
  closed?: boolean
}

export interface AuditInput {
  dayLabels: string[]
  /** The per-day amount the rate was applied to (net sales OR tips collected). */
  basis: number[]
  /** Which of the two `basis` is. Only changes the wording of the findings. */
  poolBasis: PoolBasis
  /**
   * Daily customer tips. `null` on a day the app has no tip data for.
   *
   * MUST be resolved over the SAME revenue-center scope as `basis`. The
   * `overdraw` error — "the kitchen is owed more than customers left" — is a
   * comparison of two figures drawn from different queries, and it is only
   * sound while both cover the same scope. Feed it tips from a wider scope
   * than the basis and a real overdraw hides; feed it a narrower one and the
   * audit blocks a legitimate payroll run. The caller resolves both from a
   * single scoped resolver for exactly this reason.
   */
  tipsCollected: Array<number | null>
  roles: TipRoleDef[]
  people: TipPerson[]
  punches: PunchRow[]
  split: SplitResult
  roundingStepCents: number
  poolDepartments: string[]
  ignoredClockIds: string[]
  /**
   * The reward multipliers configured in Tip settings, used only to tell a
   * boost the house sanctioned from one that was typed wrong. Omitted or
   * empty means "cannot tell" — every boost is then reported as info.
   */
  rewardTiers?: number[]
  /**
   * Day indexes the configured scope produced no usable BASIS figure for —
   * no SalesEntry row at all when the basis is NET_SALES, or a row with a null
   * `tipsCollected` when it is TIPS_COLLECTED. Always a blocking error: a day
   * with no data is not the same as a day that took nothing.
   */
  missingBasisDays: number[]
  /**
   * How many revenue centers in the CONFIGURED sales scope the person looking
   * at this period cannot otherwise read.
   *
   * Warning, never an error. The basis is deliberately summed over the whole
   * configured scope for everybody — that is what stops the frozen payout from
   * depending on who clicked Pay (see resolveSalesScopeRcIds) — so a narrower
   * caller is not seeing wrong numbers, only numbers they cannot audit at
   * source. Blocking on it would stop a scoped manager paying a correct
   * period; saying nothing would leave them unable to explain the total.
   */
  outOfScopeRcCount?: number
}

export interface AuditResult {
  ledger: LedgerRow[]
  findings: Finding[]
  counts: {
    error: number
    warn: number
    info: number
    shifts: number
    eligible: number
    inPool: number
    unexplained: number
    /** Clocked kitchen hours that are being left out of the payout entirely. */
    missingHours: number
    /**
     * Σ over on-pool roster members of the per-DAY gap between the hours they
     * clocked and the hours the split is paying them, counting only days no
     * manual edit accounts for. The house-wide `manual` figure nets a missing
     * shift against somebody else's extra one; this does not. Non-zero means
     * at least one person is being paid the wrong hours.
     */
    unreconciledHours: number
    lostPeople: string[]
  }
}

const r2 = (n: number) => Math.round(n * 100) / 100
const hrs = (n: number) => `${r2(n).toFixed(2)} h`
// Sign OUTSIDE the dollar mark: a refund day reads "−$500.00", never "$-500.00".
const money = (n: number) =>
  (n < 0 ? '−$' : '$') +
  Math.abs(n).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`

export function auditPeriod(input: AuditInput): AuditResult {
  const {
    dayLabels, basis, poolBasis, tipsCollected, roles, people: roster, punches, split,
    roundingStepCents, poolDepartments, ignoredClockIds, missingBasisDays,
    rewardTiers = [], outOfScopeRcCount = 0,
  } = input
  const basisNoun = poolBasis === 'TIPS_COLLECTED' ? 'tips collected' : 'net sales'
  const dayCount = dayLabels.length
  const findings: Finding[] = []
  const add = (
    severity: Severity, id: string, title: string, detail: string,
    actions?: FindingAction[], amount?: number,
  ) => { findings.push({ severity, id, title, detail, actions, amount }) }

  const byCode = new Map<string, TipPerson>()
  roster.forEach(p => { if (p.clockId) byCode.set(String(p.clockId), p) })

  // ── bucket every punch ────────────────────────────────────────────────────
  // The tests below are ordered by how much a punch could affect the payout,
  // NOT by how cheap they are to evaluate. Status is judged LAST, because a
  // pending punch only costs somebody money if it would otherwise have been
  // paid: a punch from another department, from outside the period, on an
  // ignored code, from a stranger, or from somebody deliberately off the pool
  // pays nothing whether or not a manager ever approves it. Judging status
  // first raised a blocking `unapproved` error on all five, and made the
  // "Not kitchen" ignore action unable to clear the block it was built for.
  //
  // Every branch continues, so the buckets remain a strict partition of the
  // finite-hours punches and the ledger closes by construction.
  const bucket = { dept: 0, period: 0, unapproved: 0, unknown: 0, ignored: 0, offpool: 0 }
  const unknown = new Map<string, { code: string; name: string; last: string; pos: string; h: number; n: number }>()
  const offpool = new Map<string, { code: string; name: string; cookId: string; h: number; n: number }>()
  const unapproved = new Map<string, { code: string; name: string; last: string; h: number; n: number }>()
  /** Eligible clocked hours per roster code per day — the per-person reconciliation basis. */
  const clockedByCode = new Map<string, number[]>()
  /**
   * Pending hours per roster code per day — lets the per-person reconciliation
   * below net a gap against the person's OWN unapproved punches instead of
   * raising a second, contradictory finding for hours `unapproved-<code>`
   * already explains.
   */
  const unapprovedByCode = new Map<string, number[]>()
  /** Excluded hours per literal department string — names a mis-tagged one. */
  const deptExcluded = new Map<string, number>()
  let eligible = 0
  let shifts = 0
  let malformed = 0
  let counted = 0
  let clockedTotal = 0

  for (const r of punches) {
    const code = String(r.clockId)
    const h = r.hours
    // A blank or "–" cell in a clock export parses to NaN, and every downstream
    // comparison against NaN is false — Math.abs(NaN) >= 0.005 does not fire.
    // Such a row cannot be reconciled at all, so it never enters the ledger.
    if (!Number.isFinite(h) || !Number.isFinite(r.dayIndex)) { malformed++; continue }
    counted++
    clockedTotal = r2(clockedTotal + h)
    if (poolDepartments.length && !poolDepartments.includes(r.department)) {
      bucket.dept = r2(bucket.dept + h)
      deptExcluded.set(r.department, r2((deptExcluded.get(r.department) ?? 0) + h))
      continue
    }
    if (r.dayIndex < 0 || r.dayIndex >= dayCount) { bucket.period = r2(bucket.period + h); continue }
    const match = byCode.get(code)
    // A stale ignore — a code marked "Not kitchen" back when it belonged to
    // nobody, later hired and given that very clockId — must not divert a
    // roster member's punches away from reconciliation. Only a code that is
    // STILL not on the roster can be ignored; once it matches somebody, the
    // ignore is stale and the punch falls through to the normal match path.
    if (!match && ignoredClockIds.includes(code)) { bucket.ignored = r2(bucket.ignored + h); continue }
    if (!match) {
      bucket.unknown = r2(bucket.unknown + h)
      const u = unknown.get(code) ?? { code, name: r.firstName, last: r.lastName, pos: r.position, h: 0, n: 0 }
      u.h = r2(u.h + h); u.n++; unknown.set(code, u)
      continue
    }
    if (!match.onPool) {
      bucket.offpool = r2(bucket.offpool + h)
      const u = offpool.get(code) ?? { code, name: match.name, cookId: match.cookId, h: 0, n: 0 }
      u.h = r2(u.h + h); u.n++; offpool.set(code, u)
      continue
    }
    if (!/approved/i.test(r.status || '')) {
      bucket.unapproved = r2(bucket.unapproved + h)
      const u = unapproved.get(code) ?? { code, name: r.firstName, last: r.lastName, h: 0, n: 0 }
      u.h = r2(u.h + h); u.n++; unapproved.set(code, u)
      const perDay = unapprovedByCode.get(code) ?? new Array<number>(dayCount).fill(0)
      perDay[r.dayIndex] = r2(perDay[r.dayIndex] + h)
      unapprovedByCode.set(code, perDay)
      continue
    }
    eligible = r2(eligible + h)
    shifts++
    const perDay = clockedByCode.get(code) ?? new Array<number>(dayCount).fill(0)
    perDay[r.dayIndex] = r2(perDay[r.dayIndex] + h)
    clockedByCode.set(code, perDay)
  }

  // ── the ledger ────────────────────────────────────────────────────────────
  // A non-finite hours or reward-boost value on the roster (a blank manual
  // edit, a bad import) poisons every downstream sum the same way a
  // malformed punch row does — except nothing upstream of `pooled` screens
  // for it. Left unguarded, `rawHours`/`capAdj` below go NaN outright, and a
  // NaN boost sends `weightedByDay[d]` NaN in the engine, which zeroes
  // (rather than NaN's) every `> 0` gate downstream — so a whole day's pool
  // silently drops out of the payout with no error anywhere in this audit.
  // Screen it here, exactly like the malformed-punch guard above: report it,
  // then neutralize it (0 h / ×1 boost) so nothing below ever computes on a
  // NaN, whatever engine.ts's own guards do or don't catch.
  const malformedRoster: Array<{ name: string; day: number; field: 'hours' | 'boost' }> = []
  const pooled = roster.filter(p => p.onPool).map(p => {
    let dirty = false
    const hours = p.hours.map((h, d) => {
      if (Number.isFinite(h)) return h
      malformedRoster.push({ name: p.name, day: d, field: 'hours' })
      dirty = true
      return 0
    })
    const boosts = p.boosts.map((b, d) => {
      if (b == null || Number.isFinite(b)) return b
      malformedRoster.push({ name: p.name, day: d, field: 'boost' })
      dirty = true
      return 1
    })
    return dirty ? { ...p, hours, boosts } : p
  })
  const rawHours = r2(pooled.reduce((a, p) => a + p.hours.reduce((x, y) => x + y, 0), 0))
  const capAdj = r2(pooled.reduce(
    (a, p) => a + p.hours.reduce((x, _y, d) => x + cappedAway(p, d), 0), 0))
  const manual = r2(rawHours - eligible)
  const inPool = r2(rawHours - capAdj)
  const splitHours = r2(split.hoursTotal)
  const unexplained = r2(inPool - splitHours)
  const lost = r2(bucket.unknown + bucket.unapproved)

  const ledger: LedgerRow[] = [
    // Malformed rows are excluded from both the total and the shift count:
    // they carry no number to account for, and are reported as `malformed`.
    { label: 'Clocked in the hours file', value: clockedTotal, lead: true, note: plural(counted, 'shift') },
    { label: 'Other department', value: -bucket.dept, muted: !bucket.dept },
    { label: 'Dated outside the period', value: -bucket.period, muted: !bucket.period },
    { label: 'Not approved', value: -bucket.unapproved, bad: bucket.unapproved > 0, muted: !bucket.unapproved },
    { label: 'Not on the tip roster', value: -bucket.unknown, bad: bucket.unknown > 0, muted: !bucket.unknown, note: bucket.unknown ? people(unknown.size) : undefined },
    { label: 'Excluded on purpose', value: -bucket.ignored, muted: !bucket.ignored },
    { label: 'Taken off the pool', value: -bucket.offpool, warn: bucket.offpool > 0, muted: !bucket.offpool },
    { label: 'Eligible hours', value: eligible, subtotal: true },
    { label: 'Manual edits on the split', value: manual, warn: Math.abs(manual) >= 0.005, muted: Math.abs(manual) < 0.005 },
    { label: 'Removed by shift caps', value: -capAdj, warn: capAdj > 0, muted: !capAdj },
    { label: 'Paid in this pool', value: inPool, lead: true, closed: Math.abs(unexplained) < 0.005 && lost < 0.005, bad: lost >= 0.005 },
  ]

  // ── rows the hours file could not be read from ────────────────────────────
  if (malformed > 0) {
    add('error', 'malformed', `${plural(malformed, 'shift')} could not be read`,
      `${malformed === 1 ? 'One row' : `${malformed} rows`} in the hours file has no usable hours or date — an empty or “–” cell, most likely. ${malformed === 1 ? 'It is' : 'They are'} not in the ledger and nobody is paid for ${malformed === 1 ? 'it' : 'them'}. Fix the row in the POS and re-import.`,
      [{ label: 'Open Import data', kind: 'goto', arg: 'import' }], malformed)
  }

  // ── roster values the split could not compute on ──────────────────────────
  if (malformedRoster.length) {
    const names = [...new Set(malformedRoster.map(m => m.name))]
    add('error', 'malformed-roster', `${plural(malformedRoster.length, 'roster value')} could not be read`,
      `${people(names.length)} — ${names.join(', ')} — ${names.length === 1 ? 'has' : 'have'} an hours or reward-boost value on the roster that is not a number: blank, “–”, or a bad manual edit. Treated as 0 h / ×1 until fixed, so nothing below is computed on a broken number, but that day is not being paid correctly either way. Fix the value in Tip settings.`,
      [{ label: 'Open Tip settings', kind: 'goto', arg: 'settings' }], malformedRoster.length)
  }

  // ── hours that vanished ───────────────────────────────────────────────────
  ;[...unknown.values()].sort((a, b) => b.h - a.h).forEach(u => {
    add('error', `unknown-${u.code}`,
      `${u.name} ${u.last} is not on the tip roster`,
      `${hrs(u.h)} over ${plural(u.n, 'shift')} as ${u.pos} (clock #${u.code}) are being left out of the split.`,
      [
        { label: 'Add to roster', kind: 'addPerson', arg: u.code },
        { label: 'Not kitchen', kind: 'ignoreCode', arg: u.code, ghost: true },
      ], u.h)
  })
  ;[...unapproved.values()].forEach(u => {
    add('error', `unapproved-${u.code}`,
      `${u.name} ${u.last} has unapproved punches`,
      `${plural(u.n, 'shift')} totalling ${hrs(u.h)} are still pending approval and are not paid. Approve them in the POS and re-import.`,
      undefined, u.h)
  })
  ;[...offpool.values()].forEach(u => {
    add('warn', `offpool-${u.code}`,
      `${u.name} worked but is switched off the pool`,
      `${hrs(u.h)} clocked and excluded on purpose. Turn them back on in Tip settings if that is wrong.`,
      [{ label: 'Put back on the pool', kind: 'onPool', arg: u.cookId }], u.h)
  })
  // ── the split against the clock, one person at a time ─────────────────────
  // The house-wide `manual` figure is a residual: Ana's missing eight hours and
  // Bo's phantom eight hours cancel, and a period in which one person is paid
  // nothing for a shift she worked reads as perfectly balanced. Reconciling per
  // person per day is what actually proves nobody's hours were dropped, swapped,
  // or carried over from the last period's roster — for hours that reach this
  // loop at all. It proves nothing about hours excluded earlier in the bucketing
  // pass (a mis-tagged department, say — see `deptexcluded` below): those never
  // reach `pooled`'s per-day comparison, so a gap they create is invisible here
  // by construction, not reconciled away. Days flagged `edited` are the
  // manager's own overrides and are excluded — those are what the house-wide
  // "Manual edits on the split" ledger row exists to report.
  let unreconciledHours = 0
  for (const p of pooled) {
    if (!p.clockId) continue // cannot be matched at all — reported as `nocode`
    const code = String(p.clockId)
    const clocked = clockedByCode.get(code) ?? new Array<number>(dayCount).fill(0)
    const pending = unapprovedByCode.get(code) ?? new Array<number>(dayCount).fill(0)
    let clockedSum = 0
    // Two different split figures, and the difference between them is a shift
    // cap. `splitSum` is what the split RECORDS (raw hours) — the figure the
    // per-day list below diffs against. `paidSum` is what it actually PAYS
    // (post-cap). Reporting only the second next to a day list built from the
    // first made a capped person's finding read as a contradiction: "the split
    // pays 8.00 h — Sun 12 −12.00 h". Both are named below.
    let splitSum = 0
    let paidSum = 0
    let gap = 0
    const days: string[] = []
    for (let d = 0; d < dayCount; d++) {
      if (p.edited[d]) continue
      const c = clocked[d] ?? 0
      const s = p.hours[d] ?? 0
      clockedSum = r2(clockedSum + c)
      splitSum = r2(splitSum + s)
      paidSum = r2(paidSum + effectiveHours(p, d))
      let diff = r2(c - s)
      // The split's own `s` can include hours still pending approval — the
      // SAME hours `unapproved-<code>` already blocks and explains. Net out
      // only the portion this person's own pending punches explain, so the
      // two findings don't tell contradictory stories about one shortfall;
      // any gap beyond what pending hours explain still fires below.
      if (diff < 0 && pending[d] > 0) {
        diff = r2(diff + Math.min(-diff, pending[d]))
      }
      if (Math.abs(diff) < 0.005) continue
      gap = r2(gap + Math.abs(diff))
      days.push(`${dayLabels[d] ?? `day ${d + 1}`} ${diff > 0 ? '+' : '−'}${Math.abs(diff).toFixed(2)} h`)
    }
    if (!days.length) continue
    unreconciledHours = r2(unreconciledHours + gap)
    add('error', `hours-${p.clockId}`,
      `${p.name}’s hours do not match the clock file`,
      `The clock file has ${hrs(clockedSum)} where the split records ${hrs(splitSum)}` +
      (Math.abs(splitSum - paidSum) >= 0.005 ? ` (paying ${hrs(paidSum)} after shift caps)` : '') +
      ` — ${days.slice(0, 4).join(', ')}${days.length > 4 ? ` +${days.length - 4} more` : ''}. ` +
      'Nothing on the split records that change, so somebody is being paid the wrong hours. Re-import the hours file, or record the difference as a manual adjustment if it is deliberate.',
      [{ label: 'Open Import data', kind: 'goto', arg: 'import' }], gap)
  }

  if (Math.abs(unexplained) >= 0.005) {
    add('error', 'unexplained', `${hrs(Math.abs(unexplained))} cannot be traced`,
      `The reconciliation does not close: ${hrs(inPool)} should be in the pool but the split is paying ${hrs(splitHours)}. Re-import the hours file before paying anyone.`,
      undefined, Math.abs(unexplained))
  }
  if (capAdj > 0.005) {
    // Caps are per person, so name who was clipped and by how much — one
    // house-wide number would be unactionable when every contract differs.
    const clipped = pooled
      .map(p => ({
        name: p.name,
        cap: p.dailyHourCap,
        lost: r2(p.hours.reduce((x, _y, d) => x + cappedAway(p, d), 0)),
      }))
      .filter(x => x.lost >= 0.005)
      .sort((a, b) => b.lost - a.lost)
    add('warn', 'cap', `Shift caps removed ${hrs(capAdj)}`,
      clipped.slice(0, 4).map(x => `${x.name} −${x.lost.toFixed(2)} h (${x.cap} h cap)`).join(', ') +
      (clipped.length > 4 ? ` +${clipped.length - 4} more` : '') +
      '. Hours above a person’s contracted shift are not paid tips. Raise their cap in Tip settings to include them.',
      [{ label: 'Open Tip settings', kind: 'goto', arg: 'settings' }], capAdj)
  }

  // ── hours excluded by department ───────────────────────────────────────────
  // `bucket.dept` alone tells nobody anything actionable: an exact,
  // case-sensitive match against `poolDepartments` silently drops a whole
  // department's hours with no flag on the ledger row and no finding. If the
  // roster's own hours[] was derived with that same department filter, the
  // gap this creates never reaches the per-person reconciliation above
  // either — no punch, no roster hour, nothing to diff, so `hours-<code>`
  // stays silent too. The result is a person paid $0 with nothing anywhere
  // pointing at why. Name the excluded department(s) and the hours so a
  // typo (`'BOH'` vs the configured `'Back of House'`) is visible on sight.
  if (deptExcluded.size) {
    const rows = [...deptExcluded.entries()].sort((a, b) => b[1] - a[1])
    const total = r2(rows.reduce((a, [, h]) => a + h, 0))
    const big = total > eligible
    add(big ? 'warn' : 'info', 'deptexcluded', `${plural(deptExcluded.size, 'department')} excluded from the pool`,
      `${rows.map(([d, h]) => `${d} (${hrs(h)})`).join(', ')} — not in the configured pool departments, so those hours never entered the split. ` +
      (big
        ? 'That is more hours than are eligible for this period — check for a mis-tagged or misspelled department name before paying.'
        : 'If one of these should be included, check the department name against Tip settings.'),
      [{ label: 'Open Tip settings', kind: 'goto', arg: 'settings' }])
  }

  // ── the same person under two codes ───────────────────────────────────────
  const byLast = new Map<string, TipPerson>()
  roster.forEach(p => {
    const key = (p.lastName ?? '').toLowerCase()
    if (key && !byLast.has(key)) byLast.set(key, p)
  })
  ;[...unknown.values()].forEach(u => {
    const hit = byLast.get((u.last ?? '').toLowerCase())
    if (hit && !hit.hours.some(h => h > 0)) {
      add('warn', `code-${u.code}`,
        `Two codes for ${hit.name} ${hit.lastName}?`,
        `The roster has ${hit.name} ${hit.lastName} on code #${hit.clockId ?? '—'}, but the clock file shows ${u.name} ${u.last} on #${u.code} with ${hrs(u.h)}. One of them is wrong.`,
        [{ label: `Use #${u.code}`, kind: 'setCode', arg: `${hit.cookId}:${u.code}` }])
    }
  })

  // ── money ─────────────────────────────────────────────────────────────────
  // Compare the split against what was DISTRIBUTABLE, not against the whole
  // pool: a day with a basis but nobody on shift contributes to poolTotal and
  // to nobody's tip, and is reported separately as `orphan-<d>` below. Using
  // poolTotal here would raise a false blocking error on every such period.
  const tipSum = split.people.reduce((a, p) => a + p.tip, 0)
  const distributable = split.pools.reduce((a, pool, d) => a + (split.weightedByDay[d] > 0 ? pool : 0), 0)
  if (Math.abs(tipSum - distributable) >= 0.005) {
    add('error', 'balance', 'The split does not add up',
      `Individual tips total ${money(tipSum)} against ${money(distributable)} of distributable pool — a gap of ${money(Math.abs(tipSum - distributable))}.`)
  }
  split.pools.forEach((pool, d) => {
    if (pool > 0.005 && split.weightedByDay[d] <= 0) {
      add('error', `orphan-${d}`, `${money(pool)} has nobody to pay on ${dayLabels[d]}`,
        'There were sales that day but no eligible hours on the clock, so that day pool cannot be handed out. ' +
        'Import that day’s hours if the kitchen was open, or check the scope if those sales belong somewhere else.',
        [{ label: 'Open Import data', kind: 'goto', arg: 'import' }], pool)
    }
  })
  if (missingBasisDays.length) {
    // "1 day HAS", "2 days HAVE" — the same agreement bug `notips` already
    // carries a fix for one finding over.
    const one = missingBasisDays.length === 1
    add('error', 'nobasis', `${plural(missingBasisDays.length, 'day')} ${one ? 'has' : 'have'} no ${basisNoun} in the app`,
      `${missingBasisDays.map(d => dayLabels[d]).join(', ')} produced no pool because the configured scope has no ${basisNoun} for ${one ? 'it' : 'them'}. ` +
      (poolBasis === 'TIPS_COLLECTED'
        ? `Re-run the Toast sync for ${one ? 'that day' : 'those days'}, or import the sales workbook to override.`
        : `Sync or enter ${one ? 'that day' : 'those days'}, or import the sales workbook to override.`),
      [{ label: 'Open Import data', kind: 'goto', arg: 'import' }])
  }
  // The pool is sized off the WHOLE configured scope for every caller, so a
  // scoped manager's figures are right — they just cannot open the revenue
  // centers behind them. Say so rather than silently narrowing the basis to
  // what they can read, which is what this used to do.
  if (outOfScopeRcCount > 0) {
    const one = outOfScopeRcCount === 1
    add('warn', 'scopenarrow',
      `This pool is funded by ${plural(outOfScopeRcCount, 'revenue center')} outside your access`,
      `The house rule funds this pool from ${basisNoun} across a scope that includes ${plural(outOfScopeRcCount, 'revenue center')} you cannot open. ` +
      `The figures here cover that full scope — they are the same ones anyone else would see, and the same ones a payment freezes — but you cannot check ${one ? 'that revenue center' : 'those revenue centers'} at source. ` +
      'Ask an administrator for access, or have somebody who has it verify the basis before you pay.',
      undefined, outOfScopeRcCount)
  }
  const reported = (d: number) => !missingBasisDays.includes(d)
  const zeroDays = basis.map((v, d) => (v === 0 ? d : -1)).filter(d => d >= 0 && reported(d))
  if (zeroDays.length) {
    add('warn', 'zerobasis', `${plural(zeroDays.length, 'day')} with no ${basisNoun}`,
      `${zeroDays.map(d => dayLabels[d]).join(', ')} produced no pool. Check the scope if the kitchen was open.`)
  }
  // A day that took LESS than nothing is not the same as one that took nothing.
  // computeSplit floors the day pool at zero on purpose — a refund-heavy day
  // cannot create a negative tip obligation — and defers the signal here.
  const negDays = basis.map((v, d) => (v < 0 ? d : -1)).filter(d => d >= 0 && reported(d))
  if (negDays.length) {
    add('warn', 'negbasis', `${plural(negDays.length, 'day')} with negative ${basisNoun}`,
      `${negDays.map(d => `${dayLabels[d]} ${money(basis[d])}`).join(', ')} — refunds outran takings. ` +
      `That day’s pool is floored at zero rather than docked off anyone’s tips, so nobody loses money, but the ${basisNoun} figure is worth checking before you pay.`)
  }

  /* ---- the FOH → BOH tip-out, whatever the basis ---- */
  const tipDays = tipsCollected.filter((t): t is number => t != null)
  if (tipDays.length) {
    const tipPot = r2(tipDays.reduce((a, b) => a + b, 0))
    // What front of house actually hands over is what the cooks receive —
    // distributedTotal — not poolTotal, which can include a day pool nobody
    // was on shift to earn and which therefore never leaves the pot.
    const takeoutPct = tipPot > 0 ? (split.distributedTotal / tipPot) * 100 : 0
    if (poolBasis === 'NET_SALES' && tipDays.length === tipsCollected.length) {
      // Sizing the withdrawal off sales can outrun the pot it is drawn from.
      // That is not a rounding nit — it means FOH cannot fund the tip-out.
      if (split.distributedTotal > tipPot + 0.005) {
        add('error', 'overdraw', 'The BOH pool is larger than the tips customers left',
          `The kitchen is owed ${money(split.distributedTotal)} but only ${money(tipPot)} was collected in tips this period. Front of house cannot fund a ${takeoutPct.toFixed(0)}% tip-out. Lower the pool rate or switch the basis to tips collected.`)
      } else if (takeoutPct > 50) {
        add('warn', 'bigtakeout', `The tip-out is ${takeoutPct.toFixed(0)}% of the tip pot`,
          `${money(split.distributedTotal)} of the ${money(tipPot)} customers left goes to the kitchen, leaving ${money(tipPot - split.distributedTotal)} for front of house. Worth a sanity check against the house agreement.`)
      } else {
        add('info', 'takeout', `The tip-out is ${takeoutPct.toFixed(0)}% of the tip pot`,
          `${money(split.distributedTotal)} to the kitchen, ${money(tipPot - split.distributedTotal)} left for front of house out of ${money(tipPot)} collected.`)
      }
    }
    if (poolBasis === 'TIPS_COLLECTED') {
      add('info', 'takeout', `The tip-out is ${takeoutPct.toFixed(0)}% of the tip pot`,
        `${money(split.distributedTotal)} to the kitchen, ${money(tipPot - split.distributedTotal)} left for front of house out of ${money(tipPot)} collected.`)
    }
  }
  // Every tip-out finding above needs tip data for EVERY day — a pot missing a
  // Saturday understates the coverage the kitchen is taking. Partial data used
  // to fall between the two branches: the tip-out findings were suppressed and
  // `notips` did not fire either, so the manager was told nothing at all.
  const noTipDays = tipsCollected.map((t, d) => (t == null ? d : -1)).filter(d => d >= 0)
  if (poolBasis === 'NET_SALES' && noTipDays.length) {
    const all = noTipDays.length === tipsCollected.length
    add('info', 'notips',
      all ? 'No tip data for this period' : `${plural(noTipDays.length, 'day')} ${noTipDays.length === 1 ? 'has' : 'have'} no tip data`,
      (all ? '' : `${noTipDays.map(d => dayLabels[d]).join(', ')} are missing tip totals. `) +
      'The pool is sized off sales, so the payout is unaffected — but without tip totals ' +
      `${all ? 'the split cannot show' : 'the split cannot reliably show'} what share of the front-of-house pot the kitchen is taking. Re-run the Toast sync to capture ${all ? 'it' : 'them'}.`)
  }

  // Envelopes round against distributedTotal (money actually owed to people),
  // not poolTotal — a day pool nobody was on shift to earn never reaches
  // distributedTotal, so comparing envelopes to poolTotal would read as
  // "under" by that whole amount even when rounding is exact.
  const drift = r2(split.envelopeTotalCents / 100 - split.distributedTotal)
  if (Math.abs(drift) >= 0.005) {
    const perHead = Math.abs(drift) / Math.max(1, split.people.length)
    add(perHead > 0.5 ? 'warn' : 'info', 'drift',
      `Cash rounding is ${drift > 0 ? 'over' : 'under'} by ${money(Math.abs(drift))}`,
      `Envelopes round to ${roundingStepCents >= 100 ? money(roundingStepCents / 100) : roundingStepCents + '¢'}. ${drift > 0 ? 'The float covers the difference.' : 'The remainder carries into the next period.'}`)
  }

  // ── people & roles ────────────────────────────────────────────────────────
  const noRole = pooled.filter(p => !roles.some(r => r.id === p.roleId))
  if (noRole.length) {
    add('error', 'norole', `${people(noRole.length)} have no role`,
      `${noRole.map(p => p.name).join(', ')} are weighted at ×1 by default. Give them a role in Tip settings.`,
      [{ label: 'Open Tip settings', kind: 'goto', arg: 'settings' }])
  }
  const noCode = pooled.filter(p => !p.clockId)
  if (noCode.length) {
    add('warn', 'nocode', `${people(noCode.length)} have no employee code`,
      `${noCode.map(p => p.name).join(', ')} cannot be matched to the clock file, so their hours must be typed by hand.`,
      [{ label: 'Open Tip settings', kind: 'goto', arg: 'settings' }])
  }
  const idle = pooled.filter(p => !p.hours.some(h => h > 0)).map(p => p.name)
  if (idle.length) {
    add('info', 'idle', `${plural(idle.length, 'roster member')} with no hours`,
      `${idle.join(', ')} did not clock in this period and get nothing. They stay on the roster.`)
  }
  // ── reward boosts ─────────────────────────────────────────────────────────
  // A boost multiplies its owner's daily share directly, so it takes money off
  // everybody else on shift that day. A mistyped 5 where 1.5 was meant is
  // invisible in every other check — the ledger still closes, the split still
  // balances — so every boost is enumerated and any value the house has not
  // configured as a tier is called out.
  //
  // Scoped to `pooled` (on-pool, and — via the sanitized `pooled` above —
  // never a non-finite value; those are reported once as `malformed-roster`
  // instead of here), not the full roster: an off-pool person's hours are
  // zeroed by the engine, so their boost multiplies nothing and raises
  // nobody else's share either. Enumerating it off `roster` used to leave a
  // stale boost warning nothing could clear — switching the person back
  // onto the pool (the `offpool` finding's own remedy) is what makes the
  // boost real again, and this check fires fresh once that happens.
  const boosts: Array<{ label: string; tiered: boolean }> = []
  for (const p of pooled) {
    for (let d = 0; d < dayCount; d++) {
      const b = p.boosts[d] ?? 1
      if (b === 1) continue
      boosts.push({
        label: `${p.name} · ${dayLabels[d] ?? `day ${d + 1}`} ×${b}`,
        // No configured tiers means the app cannot tell a sanctioned boost from
        // a typo, so it does not pretend to: everything reads as info.
        tiered: !rewardTiers.length || rewardTiers.some(t => Math.abs(t - b) < 1e-9),
      })
    }
  }
  const listBoosts = (xs: typeof boosts) =>
    xs.slice(0, 6).map(x => x.label).join(', ') + (xs.length > 6 ? ` +${xs.length - 6} more` : '')
  const offTier = boosts.filter(x => !x.tiered)
  const onTier = boosts.filter(x => x.tiered)
  if (onTier.length) {
    add('info', 'boosts', `${plural(onTier.length, 'reward boost')} applied`,
      `${listBoosts(onTier)}. Each one raises that person's share of their day pool and lowers everybody else's.`)
  }
  if (offTier.length) {
    add('warn', 'boost-offtier', `${plural(offTier.length, 'reward boost')} not on a configured tier`,
      `${listBoosts(offTier)}. The configured tiers are ${rewardTiers.map(t => `×${t}`).join(', ')}. ` +
      'A boost off the ladder is usually a typo, and it moves real money away from everyone else on that shift.',
      [{ label: 'Open Tip settings', kind: 'goto', arg: 'settings' }], offTier.length)
  }

  const notes = punches.filter(r => r.note)
  if (notes.length) {
    add('info', 'notes', `${plural(notes.length, 'shift')} carry a manager note`,
      notes.slice(0, 4).map(r => `${r.firstName} · ${dayLabels[r.dayIndex] ?? '—'} · “${r.note}”`).join(' • ') + (notes.length > 4 ? ' • …' : ''))
  }

  const rank: Record<Severity, number> = { error: 0, warn: 1, info: 2 }
  findings.sort((a, b) => rank[a.severity] - rank[b.severity] || (b.amount ?? 0) - (a.amount ?? 0))

  return {
    ledger,
    findings,
    counts: {
      error: findings.filter(f => f.severity === 'error').length,
      warn: findings.filter(f => f.severity === 'warn').length,
      info: findings.filter(f => f.severity === 'info').length,
      shifts, eligible, inPool, unexplained,
      missingHours: lost,
      unreconciledHours,
      lostPeople: [...unknown.values(), ...unapproved.values()]
        .sort((a, b) => b.h - a.h)
        .map(u => `${u.name} ${u.last}`),
    },
  }
}
