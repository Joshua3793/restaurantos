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
import { cappedAway, effectiveHours, roleOf } from './engine'
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
  /** Hours or dollars at stake — used only to rank findings of equal severity. */
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
  /** Daily net sales — always supplied, even when the basis is TIPS_COLLECTED. */
  sales: number[]
  /** Daily customer tips. `null` on a day the app has no tip data for. */
  tipsCollected: Array<number | null>
  roles: TipRoleDef[]
  people: TipPerson[]
  punches: PunchRow[]
  split: SplitResult
  roundingStepCents: number
  poolDepartments: string[]
  ignoredClockIds: string[]
  /**
   * Day indexes the configured scope produced no usable BASIS figure for —
   * no SalesEntry row at all when the basis is NET_SALES, or a row with a null
   * `tipsCollected` when it is TIPS_COLLECTED. Always a blocking error: a day
   * with no data is not the same as a day that took nothing.
   */
  missingBasisDays: number[]
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
    lostPeople: string[]
  }
}

const r2 = (n: number) => Math.round(n * 100) / 100
const hrs = (n: number) => `${r2(n).toFixed(2)} h`
const money = (n: number) =>
  '$' + n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`

export function auditPeriod(input: AuditInput): AuditResult {
  const {
    dayLabels, basis, poolBasis, sales, tipsCollected, roles, people: roster, punches, split,
    roundingStepCents, poolDepartments, ignoredClockIds, missingBasisDays,
  } = input
  const basisNoun = poolBasis === 'TIPS_COLLECTED' ? 'tips collected' : 'net sales'
  const dayCount = dayLabels.length
  const findings: Finding[] = []
  const add = (
    severity: Severity, id: string, title: string, detail: string,
    actions?: FindingAction[], amount?: number,
  ) => { findings.push({ severity, id, title, detail, actions, amount }) }

  const byCode = new Map<string, { p: TipPerson; i: number }>()
  roster.forEach((p, i) => { if (p.clockId) byCode.set(String(p.clockId), { p, i }) })

  // ── bucket every punch ────────────────────────────────────────────────────
  const bucket = { dept: 0, period: 0, unapproved: 0, unknown: 0, ignored: 0, offpool: 0 }
  const unknown = new Map<string, { code: string; name: string; last: string; pos: string; h: number; n: number }>()
  const offpool = new Map<string, { code: string; name: string; cookId: string; h: number; n: number }>()
  const unapproved = new Map<string, { code: string; name: string; last: string; h: number; n: number }>()
  let eligible = 0
  let shifts = 0

  for (const r of punches) {
    const code = String(r.clockId)
    const h = r.hours
    if (poolDepartments.length && !poolDepartments.includes(r.department)) { bucket.dept = r2(bucket.dept + h); continue }
    if (r.dayIndex < 0 || r.dayIndex >= dayCount) { bucket.period = r2(bucket.period + h); continue }
    if (!/approved/i.test(r.status || '')) {
      bucket.unapproved = r2(bucket.unapproved + h)
      const u = unapproved.get(code) ?? { code, name: r.firstName, last: r.lastName, h: 0, n: 0 }
      u.h = r2(u.h + h); u.n++; unapproved.set(code, u)
      continue
    }
    const match = byCode.get(code)
    if (!match) {
      if (ignoredClockIds.includes(code)) { bucket.ignored = r2(bucket.ignored + h); continue }
      bucket.unknown = r2(bucket.unknown + h)
      const u = unknown.get(code) ?? { code, name: r.firstName, last: r.lastName, pos: r.position, h: 0, n: 0 }
      u.h = r2(u.h + h); u.n++; unknown.set(code, u)
      continue
    }
    if (!match.p.onPool) {
      bucket.offpool = r2(bucket.offpool + h)
      const u = offpool.get(code) ?? { code, name: match.p.name, cookId: match.p.cookId, h: 0, n: 0 }
      u.h = r2(u.h + h); u.n++; offpool.set(code, u)
      continue
    }
    eligible = r2(eligible + h)
    shifts++
  }

  // ── the ledger ────────────────────────────────────────────────────────────
  const pooled = roster.filter(p => p.onPool)
  const rawHours = r2(pooled.reduce((a, p) => a + p.hours.reduce((x, y) => x + y, 0), 0))
  const capAdj = r2(pooled.reduce(
    (a, p) => a + p.hours.reduce((x, _y, d) => x + cappedAway(p, d), 0), 0))
  const manual = r2(rawHours - eligible)
  const inPool = r2(rawHours - capAdj)
  const splitHours = r2(split.hoursTotal)
  const unexplained = r2(inPool - splitHours)
  const lost = r2(bucket.unknown + bucket.unapproved)

  const ledger: LedgerRow[] = [
    { label: 'Clocked in the hours file', value: r2(punches.reduce((a, r) => a + r.hours, 0)), lead: true, note: plural(punches.length, 'shift') },
    { label: 'Other department', value: -bucket.dept, muted: !bucket.dept },
    { label: 'Dated outside the period', value: -bucket.period, muted: !bucket.period },
    { label: 'Not approved', value: -bucket.unapproved, bad: bucket.unapproved > 0, muted: !bucket.unapproved },
    { label: 'Not on the tip roster', value: -bucket.unknown, bad: bucket.unknown > 0, muted: !bucket.unknown, note: bucket.unknown ? people(unknown.size) : undefined },
    { label: 'Excluded on purpose', value: -bucket.ignored, muted: !bucket.ignored },
    { label: 'Taken off the pool', value: -bucket.offpool, warn: bucket.offpool > 0, muted: !bucket.offpool },
    { label: 'Eligible hours', value: eligible, subtotal: true },
    { label: 'Manual edits on the split', value: manual, warn: Math.abs(manual) > 0.005, muted: Math.abs(manual) < 0.005 },
    { label: 'Removed by shift caps', value: -capAdj, warn: capAdj > 0, muted: !capAdj },
    { label: 'Paid in this pool', value: inPool, lead: true, closed: Math.abs(unexplained) < 0.005 && lost < 0.005, bad: lost >= 0.005 },
  ]

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

  // ── the same person under two codes ───────────────────────────────────────
  const byLast = new Map<string, { p: TipPerson; i: number }>()
  roster.forEach((p, i) => {
    const key = (p.lastName ?? '').toLowerCase()
    if (key && !byLast.has(key)) byLast.set(key, { p, i })
  })
  ;[...unknown.values()].forEach(u => {
    const hit = byLast.get((u.last ?? '').toLowerCase())
    if (hit && !hit.p.hours.some(h => h > 0)) {
      add('warn', `code-${u.code}`,
        `Two codes for ${hit.p.name} ${hit.p.lastName}?`,
        `The roster has ${hit.p.name} ${hit.p.lastName} on code #${hit.p.clockId ?? '—'}, but the clock file shows ${u.name} ${u.last} on #${u.code} with ${hrs(u.h)}. One of them is wrong.`,
        [{ label: `Use #${u.code}`, kind: 'setCode', arg: `${hit.p.cookId}:${u.code}` }])
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
        'There were sales that day but no eligible hours on the clock, so that day pool cannot be handed out.')
    }
  })
  if (missingBasisDays.length) {
    add('error', 'nobasis', `${plural(missingBasisDays.length, 'day')} have no ${basisNoun} in the app`,
      `${missingBasisDays.map(d => dayLabels[d]).join(', ')} produced no pool because the configured scope has no ${basisNoun} for them. ` +
      (poolBasis === 'TIPS_COLLECTED'
        ? 'Re-run the Toast sync for those days, or import the sales workbook to override.'
        : 'Sync or enter those days, or import the sales workbook to override.'),
      [{ label: 'Open Import data', kind: 'goto', arg: 'import' }])
  }
  const zeroDays = basis.map((v, d) => (v <= 0 ? d : -1)).filter(d => d >= 0 && !missingBasisDays.includes(d))
  if (zeroDays.length) {
    add('warn', 'zerobasis', `${plural(zeroDays.length, 'day')} with no ${basisNoun}`,
      `${zeroDays.map(d => dayLabels[d]).join(', ')} produced no pool. Check the scope if the kitchen was open.`)
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
  } else if (poolBasis === 'NET_SALES') {
    add('info', 'notips', 'No tip data for this period',
      'The pool is sized off sales, so the payout is unaffected — but without tip totals the split cannot show what share of the front-of-house pot the kitchen is taking. Re-run the Toast sync to capture it.')
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
      `Envelopes round to ${roundingStepCents >= 100 ? '$' + roundingStepCents / 100 : roundingStepCents + '¢'}. ${drift > 0 ? 'The float covers the difference.' : 'The remainder carries into the next period.'}`)
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
      lostPeople: [...unknown.values(), ...unapproved.values()]
        .sort((a, b) => b.h - a.h)
        .map(u => `${u.name} ${u.last}`),
    },
  }
}
