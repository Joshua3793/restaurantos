'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Banknote, Check, ChevronLeft, ChevronRight, Download } from 'lucide-react'
import { PageHead } from '@/components/layout/PageHead'
import { computeSplit } from '@/lib/tips/engine'
import { auditPeriod, type FindingAction } from '@/lib/tips/audit'
import { nextPeriodStart, previousPeriodStart } from '@/lib/tips/period'
import type { TipPeriodPayload } from '@/lib/tips/types'
import { TIP_TABS, money, type TipTabId } from '@/components/tips/kit'
import { SplitTab } from '@/components/tips/SplitTab'
import { DailyPoolsTab } from '@/components/tips/DailyPoolsTab'
import { CashTab } from '@/components/tips/CashTab'
import { ChecksTab } from '@/components/tips/ChecksTab'
import { ImportTab } from '@/components/tips/ImportTab'
import { SettingsTab, type LookupOption, type TipSettingsDto } from '@/components/tips/SettingsTab'

export default function TipsPage() {
  const [payload, setPayload] = useState<TipPeriodPayload | null>(null)
  const [periodId, setPeriodId] = useState<string | null>(null)
  const [tab, setTab] = useState<TipTabId>('split')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [settings, setSettings] = useState<TipSettingsDto | null>(null)
  const [locations, setLocations] = useState<LookupOption[]>([])
  const [revenueCenters, setRevenueCenters] = useState<LookupOption[]>([])

  /* ── load ──────────────────────────────────────────────────────────────── */
  // Returns whether the reload actually succeeded. Callers that reload after
  // a save use this to decide whose error message should survive — see the
  // NOTE above patchPeriod.
  const loadPeriod = useCallback(async (id: string): Promise<boolean> => {
    const res = await fetch(`/api/tips/periods/${id}`, { cache: 'no-store' })
    if (!res.ok) { setError((await res.json()).error ?? 'Could not load the period'); return false }
    setPayload(await res.json())
    setPeriodId(id)
    setError(null)
    return true
  }, [])

  /**
   * Opens the period starting on `startDate` and loads it.
   *
   * POST /api/tips/periods is idempotent on (revenueCenterId, startDate) — it
   * returns the existing row rather than creating a duplicate — so this single
   * call is both "open the next fortnight" and "go back to the one we already
   * paid". The RC is carried over from the period being stepped away from, not
   * re-read from settings, so changing the house's crew RC later cannot make
   * the ‹ › arrows wander onto a different pool's periods.
   */
  const openPeriod = useCallback(async (startDate: string, revenueCenterId?: string) => {
    const res = await fetch('/api/tips/periods', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ startDate, ...(revenueCenterId ? { revenueCenterId } : {}) }),
    })
    if (!res.ok) { setError((await res.json()).error ?? 'Could not open that period'); return }
    const { id } = await res.json()
    await loadPeriod(id)
  }, [loadPeriod])

  const loadSettings = useCallback(async () => {
    const res = await fetch('/api/tips/settings', { cache: 'no-store' })
    if (res.ok) setSettings(await res.json())
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const res = await fetch('/api/tips/periods', { cache: 'no-store' })
      if (!res.ok) { setError((await res.json()).error ?? 'Could not load tip periods'); return }
      const { periods, defaultStartDate } = await res.json()
      if (cancelled) return
      if (periods.length) { void loadPeriod(periods[0].id); return }
      // No period yet — open the current one. Every period after this one is
      // reached with the ‹ › stepper, which opens on demand.
      if (!cancelled) void openPeriod(defaultStartDate)
    })()
    return () => { cancelled = true }
  }, [loadPeriod, openPeriod])

  useEffect(() => {
    void loadSettings()
    ;(async () => {
      const [locRes, rcRes] = await Promise.all([
        fetch('/api/locations', { cache: 'no-store' }),
        fetch('/api/revenue-centers', { cache: 'no-store' }),
      ])
      // Unwrap if either endpoint returns { locations } / { revenueCenters } rather
      // than a bare array — both currently return bare arrays, this is a hedge.
      const unwrap = (j: unknown, key: string): LookupOption[] =>
        Array.isArray(j) ? (j as LookupOption[]) : ((j as Record<string, LookupOption[]>)?.[key] ?? [])
      if (locRes.ok) setLocations(unwrap(await locRes.json(), 'locations'))
      if (rcRes.ok) setRevenueCenters(unwrap(await rcRes.json(), 'revenueCenters'))
    })()
  }, [loadSettings])

  /* ── derive ────────────────────────────────────────────────────────────── */
  const { split, audit } = useMemo(() => {
    if (!payload) return { split: null, audit: null }
    const s = computeSplit({
      basis: payload.basis,
      poolRatePct: payload.period.poolRatePct,
      roundingStepCents: payload.period.roundingStepCents,
      roles: payload.roles,
      people: payload.roster,
    })
    const a = auditPeriod({
      dayLabels: payload.dayLabels,
      basis: payload.basis,
      poolBasis: payload.period.poolBasis,
      tipsCollected: payload.tips.collected,
      roles: payload.roles,
      people: payload.roster,
      punches: payload.punches,
      split: s,
      roundingStepCents: payload.period.roundingStepCents,
      poolDepartments: payload.poolDepartments,
      ignoredClockIds: payload.period.ignoredClockIds,
      missingBasisDays: payload.missingBasisDays,
      rewardTiers: payload.rewardTiers,
      outOfScopeRcCount: payload.sales.outOfScopeRcCount,
    })
    return { split: s, audit: a }
  }, [payload])

  /**
   * ‹ / › — the previous or next window of the SAME length as the one on
   * screen, using the period module's own arithmetic rather than open-coding
   * it here. There is no "latest period" ceiling: stepping forward past the
   * current fortnight opens the next one, which is how a manager gets ahead of
   * a close.
   */
  const stepPeriod = useCallback(async (dir: -1 | 1) => {
    if (!payload) return
    const dayCount = payload.dayLabels.length
    const start = dir < 0
      ? previousPeriodStart(payload.period.startDate, dayCount)
      : nextPeriodStart(payload.period.startDate, dayCount)
    setBusy(true)
    try { await openPeriod(start, payload.period.revenueCenterId) }
    finally { setBusy(false) }
  }, [payload, openPeriod])

  /* ── mutate ────────────────────────────────────────────────────────────── */
  // NOTE on the `errorMessage`-then-`loadPeriod`-then-`setError` ordering below:
  // `loadPeriod` itself calls `setError(null)` on a successful reload, so
  // setting the error BEFORE the reload gets silently wiped the instant the
  // reload resolves — the manager never sees why a save failed (a 409/400
  // reads as "the field just reset itself"). Reloading first and setting the
  // error last fixes both halves of the failure at once: the table still
  // needs to stop showing the value the server rejected (the reload pulls the
  // server's actual state) AND the error must survive the reload that follows it.
  //
  // But the reload can itself fail (GET 500), in which case `loadPeriod` has
  // already set its OWN error ("Could not load the period") and left `payload`
  // at its stale pre-save value — the view is now not just wrong but unknown
  // to be wrong. Unconditionally applying the save's `errorMessage` afterward
  // would stomp that "your view is stale" error with the comparatively minor
  // save failure. So the save error is only applied when the reload itself
  // succeeded; `loadPeriod`'s return value tells us which happened.
  const patchPeriod = useCallback(async (body: Record<string, unknown>) => {
    if (!periodId) return
    setBusy(true)
    const res = await fetch(`/api/tips/periods/${periodId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    const errorMessage = res.ok ? null : ((await res.json()).error ?? 'Could not save')
    const reloaded = await loadPeriod(periodId)
    if (errorMessage && reloaded) setError(errorMessage)
    setBusy(false)
  }, [periodId, loadPeriod])

  const saveSettings = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true)
    const res = await fetch('/api/tips/settings', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    let errorMessage: string | null = null
    if (res.ok) setSettings(await res.json())
    else errorMessage = (await res.json()).error ?? 'Could not save settings'
    const reloaded = periodId ? await loadPeriod(periodId) : true
    if (errorMessage && reloaded) setError(errorMessage)
    setBusy(false)
  }, [periodId, loadPeriod])

  const putAdjustment = useCallback(async (body: Record<string, unknown>) => {
    if (!periodId) return
    setBusy(true)
    const res = await fetch(`/api/tips/periods/${periodId}/adjustments`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    const errorMessage = res.ok ? null : ((await res.json()).error ?? 'Could not save that edit')
    const reloaded = await loadPeriod(periodId)
    if (errorMessage && reloaded) setError(errorMessage)
    setBusy(false)
  }, [periodId, loadPeriod])

  const applyFix = useCallback(async (action: FindingAction) => {
    if (!periodId || !payload) return
    setBusy(true)
    try {
      if (action.kind === 'goto') { setTab(action.arg as TipTabId); return }
      if (action.kind === 'ignoreCode') {
        await patchPeriod({ ignoredClockIds: [...payload.period.ignoredClockIds, action.arg] })
        return
      }
      let errorMessage: string | null = null
      if (action.kind === 'onPool') {
        await fetch(`/api/tips/roster/${action.arg}`, {
          method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ onTipPool: true }),
        })
      }
      if (action.kind === 'setCode') {
        const [cookId, code] = action.arg.split(':')
        await fetch(`/api/tips/roster/${cookId}`, {
          method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clockId: code }),
        })
      }
      if (action.kind === 'addPerson') {
        const punch = payload.punches.find(p => p.clockId === action.arg)
        if (punch) {
          const res = await fetch('/api/tips/roster', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              firstName: punch.firstName, lastName: punch.lastName,
              clockId: punch.clockId, position: punch.position,
            }),
          })
          if (!res.ok) errorMessage = (await res.json()).error ?? 'Could not add that person'
        }
      }
      // See the comment above patchPeriod: setError must come AFTER loadPeriod,
      // or the reload's own setError(null) wipes it out — and only when the
      // reload itself succeeded, or a load failure gets stomped by this error.
      const reloaded = await loadPeriod(periodId)
      if (errorMessage && reloaded) setError(errorMessage)
    } finally { setBusy(false) }
  }, [periodId, payload, patchPeriod, loadPeriod])

  const markPaid = useCallback(async () => {
    if (!periodId || !payload) return
    const reopen = payload.period.status === 'PAID'
    setBusy(true)
    const res = await fetch(`/api/tips/periods/${periodId}/pay`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reopen }),
    })
    const errorMessage = res.ok ? null : ((await res.json()).error ?? 'Could not update the period')
    const reloaded = await loadPeriod(periodId)
    if (errorMessage && reloaded) setError(errorMessage)
    setBusy(false)
  }, [periodId, payload, loadPeriod])

  /* ── render ────────────────────────────────────────────────────────────── */
  if (error && !payload) {
    return <div className="bg-paper border border-line rounded-xl p-12 text-center text-[14px] text-red-text">{error}</div>
  }
  if (!payload || !split || !audit) {
    return <div className="bg-paper border border-line rounded-xl p-12 text-center font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3">Loading tip period…</div>
  }

  // PERIOD-scoped edits only — hours, boosts, rate, basis, rounding, imports.
  // Deliberately NOT passed to the Settings tab: the roster, roles, pool rules
  // and sales scope are house configuration, and freezing them alongside the
  // split left the whole page dead once the first period was paid. What a
  // payment freezes is the payout snapshot, not the house rules.
  const periodReadOnly = payload.period.status === 'PAID'
  const netSales = payload.sales.net.reduce((a, b) => a + b, 0)
  const badge = audit.counts.error || audit.counts.warn || 0
  const onTips = payload.period.poolBasis === 'TIPS_COLLECTED'
  const basisLabel = onTips ? 'tips collected' : 'net sales'
  const basisTotal = onTips ? payload.tips.total : netSales
  // The FOH pot and what the kitchen takes out of it — shown whatever the basis,
  // because that is the number both sides of the pass actually argue about.
  const tipPot = payload.tips.total
  const hasTips = payload.tips.collected.some(v => v != null)
  // distributedTotal, not poolTotal: what the kitchen actually TAKES from the
  // FOH pot is the money that reaches people, not the day-pool math, which can
  // include a day nobody was on shift to earn (that money never leaves the
  // pot). Matches the audit's own "tip-out is X% of the pot" finding.
  const takeoutPct = hasTips && tipPot > 0 ? (split.distributedTotal / tipPot) * 100 : null

  return (
    <div>
      {/* Mobile: a payout run is a desk task — the mock has no phone layout. */}
      <div className="md:hidden bg-paper border border-line rounded-xl p-8 text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3">Desktop only</p>
        <p className="text-[14px] text-ink-2 mt-2">Tip payouts need the full split table. Open Controla OS on a desktop to run the payout.</p>
      </div>

      <div className="hidden md:block">
        {/* dark tip chrome — the page's own strip, not the food-cost spine */}
        <div className="bg-ink text-paper px-8 py-2.5 flex items-center gap-6 -mx-8 -mt-6 mb-6">
          {[
            ['Period', payload.periodLabel.replace(/ · \d{4}$/, '')],
            ['Net sales', money(netSales)],
            ['Tips collected', hasTips ? money(tipPot) : '—'],
            ['Pool rate', `${payload.period.poolRatePct.toFixed(1)}% of ${basisLabel}`],
          ].map(([l, v]) => (
            <span key={l} className="flex items-baseline gap-2">
              <span className="font-mono text-[10px] text-ink-4 uppercase tracking-[0.02em]">{l}</span>
              <span className="font-mono text-[14px] font-semibold">{v}</span>
            </span>
          ))}
          <span className="flex items-baseline gap-2">
            <span className="font-mono text-[10px] text-ink-4 uppercase tracking-[0.02em]">Kitchen pool</span>
            <span className="font-mono text-[14px] font-semibold text-[#86efac]">{money(split.poolTotal)}</span>
          </span>
          <span className="flex-1" />
          <span className="font-mono text-[10.5px] text-ink-3">
            Sales from {payload.sales.scopeLabel}
          </span>
        </div>

        <PageHead
          crumbs={<><Banknote size={13} /> TEAM / TIP PAYOUTS</>}
          title="Kitchen tip pool"
          sub={
            <span className="flex items-center gap-3">
              {/* The period stepper. Without it the page could only ever open
                  ONE period: it created the current one on first load and had
                  no way to reach any other. Each arrow opens (idempotently) or
                  reloads the adjacent window — see stepPeriod. */}
              <span className="inline-flex items-center gap-1">
                <button
                  onClick={() => void stepPeriod(-1)}
                  disabled={busy}
                  aria-label="Previous period"
                  title="Previous period"
                  className="w-6 h-6 grid place-items-center rounded border border-line bg-paper text-ink-3 hover:border-ink-3 hover:text-ink disabled:opacity-40"
                >
                  <ChevronLeft size={13} />
                </button>
                <span className="font-mono text-[11.5px] text-ink">{payload.periodLabel}</span>
                <button
                  onClick={() => void stepPeriod(1)}
                  disabled={busy}
                  aria-label="Next period"
                  title="Next period"
                  className="w-6 h-6 grid place-items-center rounded border border-line bg-paper text-ink-3 hover:border-ink-3 hover:text-ink disabled:opacity-40"
                >
                  <ChevronRight size={13} />
                </button>
              </span>
              <label className="inline-flex items-center gap-1.5 font-mono text-[11px] text-ink-3">
                POOL RATE
                <input
                  type="number" step="0.5" min="0" max="100"
                  value={payload.period.poolRatePct}
                  disabled={periodReadOnly}
                  onChange={e => {
                    const v = parseFloat(e.target.value)
                    if (isFinite(v) && v >= 0) void patchPeriod({ poolRatePct: v })
                  }}
                  className="w-[58px] font-mono text-[12px] text-right border border-line rounded-md px-[7px] py-1 bg-paper text-ink outline-none focus:border-gold [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                />
                % of
                {/* Flipping the basis re-sizes the whole pool, so it is a first-class
                    control here, not buried in settings. Frozen once the period is paid. */}
                <select
                  value={payload.period.poolBasis}
                  disabled={periodReadOnly}
                  onChange={e => void patchPeriod({ poolBasis: e.target.value })}
                  className="font-mono text-[11px] border border-line rounded-md px-1.5 py-1 bg-paper text-ink-2 cursor-pointer outline-none hover:border-ink-3"
                >
                  <option value="NET_SALES">net sales</option>
                  <option value="TIPS_COLLECTED">tips collected</option>
                </select>
              </label>
              <button
                onClick={() => setTab('checks')}
                className={`font-mono text-[10px] uppercase tracking-normal px-2.5 py-[3px] rounded-full inline-flex items-center gap-1.5 font-medium ${audit.counts.error ? 'bg-red-soft text-red-text' : audit.counts.warn ? 'bg-gold-soft text-gold-2' : 'bg-green-soft text-green-text'}`}
              >
                <span className="w-[5px] h-[5px] rounded-full bg-current opacity-70" />
                {audit.counts.error ? `${audit.counts.error} ISSUE${audit.counts.error === 1 ? '' : 'S'}`
                  : audit.counts.warn ? `${audit.counts.warn} WARNING${audit.counts.warn === 1 ? '' : 'S'}`
                  : 'ALL CHECKS PASS'}
              </button>
            </span>
          }
          actions={
            <>
              <a
                href={periodId ? `/api/tips/periods/${periodId}/export` : '#'}
                className="inline-flex items-center gap-[7px] px-3.5 py-[9px] rounded border border-line bg-paper text-[13px] font-medium text-ink-2 hover:border-ink-3"
              >
                <Download size={13} className="text-ink-3" />Export for payroll
              </a>
              <button
                onClick={markPaid}
                disabled={busy}
                className="inline-flex items-center gap-[7px] px-4 py-[9px] rounded bg-ink text-paper text-[13px] font-medium border border-ink hover:bg-ink-2 disabled:opacity-50"
              >
                <Check size={13} className="text-gold" />
                {periodReadOnly ? 'Reopen period' : 'Mark period paid'}
              </button>
            </>
          }
        />

        {error && (
          <div className="mb-4 rounded-md border border-red bg-red-soft px-3.5 py-2.5 text-[13px] text-red-text">{error}</div>
        )}

        <div className="grid gap-3 mb-6" style={{ gridTemplateColumns: '1.4fr 1fr 1fr 1fr' }}>
          <div className="bg-ink text-paper border border-ink rounded-xl px-5 py-[18px] flex flex-col justify-between min-h-[128px]">
            <span className="font-mono text-[10.5px] text-ink-4">TIP POOL · {payload.dayLabels.length} DAYS</span>
            <span className="text-[48px] font-semibold tracking-[-0.045em] leading-none mt-2">
              {money(split.poolTotal).split('.')[0]}
              <sub className="text-[22px] font-medium text-gold align-baseline">.{money(split.poolTotal).split('.')[1]}</sub>
            </span>
            <span className="font-mono text-[11px] text-ink-4 mt-2">
              <b className="text-paper font-medium">{payload.period.poolRatePct.toFixed(1)}%</b> of ${Math.round(basisTotal).toLocaleString('en-CA')} {basisLabel}
            </span>
          </div>
          {[
            // The tip-out card replaces the mock's "team on pool" as the second
            // slot: how much of the FOH pot the kitchen is taking is the number
            // the payout actually gets challenged on.
            takeoutPct != null
              ? ['TIP-OUT TO KITCHEN', `${takeoutPct.toFixed(0)}%`, `${money(tipPot - split.distributedTotal)} left for front of house`]
              : ['TEAM ON POOL', String(split.people.length), `${split.hoursTotal.toFixed(1)} h worked`],
            ['WEIGHTED HOURS', split.weightedTotal.toLocaleString('en-CA', { minimumFractionDigits: 1, maximumFractionDigits: 1 }), `${split.people.length} people · ${split.hoursTotal.toFixed(1)} h`],
            ['AVG TIP RATE', `$${(split.hoursTotal ? split.distributedTotal / split.hoursTotal : 0).toFixed(2)}/h`, 'across all weights'],
          ].map(([label, value, sub]) => (
            <div key={label} className="relative bg-paper border border-line rounded-xl px-5 py-[18px] flex flex-col justify-between min-h-[128px]">
              <span className="absolute top-0 left-0 w-8 h-0.5 bg-gold" />
              <span className="font-mono text-[10.5px] text-ink-3">{label}</span>
              <span className="text-[34px] font-semibold tracking-[-0.04em] leading-none mt-2 whitespace-nowrap">{value}</span>
              <span className="font-mono text-[11px] text-ink-3 mt-2">{sub}</span>
            </div>
          ))}
        </div>

        <nav className="flex items-stretch px-8 bg-paper border-b border-line h-12 -mx-8 mb-6">
          {TIP_TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-[7px] px-[18px] text-[13.5px] font-medium border-b-2 ${tab === t.id ? 'border-gold text-ink' : 'border-transparent text-ink-3 hover:text-ink-2'}`}
            >
              {t.label}
              {t.id === 'checks' && badge > 0 && (
                <i className={`not-italic inline-grid place-items-center min-w-4 h-4 px-1 rounded-full text-paper font-mono text-[9.5px] font-semibold ${audit.counts.error ? 'bg-red' : 'bg-gold'}`}>{badge}</i>
              )}
            </button>
          ))}
        </nav>

        {tab === 'split' && (
          <SplitTab
            split={split} audit={audit} roles={payload.roles}
            dayLabels={payload.dayLabels}
            rewardTiers={payload.rewardTiers} readOnly={periodReadOnly}
            onCapChange={(cookId, cap) => {
              void fetch(`/api/tips/roster/${cookId}`, {
                method: 'PATCH', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ dailyHourCap: cap }),
              }).then(() => { if (periodId) void loadPeriod(periodId) })
            }}
            onRoleChange={(cookId, roleId) => {
              void fetch(`/api/tips/roster/${cookId}`, {
                method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tipRoleId: roleId }),
              }).then(() => { if (periodId) void loadPeriod(periodId) })
            }}
            onHoursChange={(cookId, dayIndex, hours) => void putAdjustment({ cookId, dayIndex, hours })}
            onBoostChange={(cookId, dayIndex, boost) => void putAdjustment({ cookId, dayIndex, boost })}
            onClearAdjustments={cookId => {
              if (!periodId) return
              void fetch(`/api/tips/periods/${periodId}/adjustments?cookId=${cookId}`, { method: 'DELETE' })
                .then(() => loadPeriod(periodId))
            }}
            onFix={applyFix}
            onGoto={t => setTab(t as TipTabId)}
          />
        )}

        {tab === 'days' && (
          <DailyPoolsTab
            split={split}
            sales={payload.sales.net}
            tips={payload.tips.collected}
            dayLabels={payload.dayLabels}
            overriddenDays={onTips ? payload.tips.overriddenDays : payload.sales.overriddenDays}
            missingDays={payload.missingBasisDays}
            salesMissingDays={payload.sales.missingDays}
            basisLabel={basisLabel}
            onTips={onTips}
          />
        )}

        {tab === 'cash' && (
          <CashTab
            split={split}
            denoms={payload.denoms}
            roundingStepCents={payload.period.roundingStepCents}
            readOnly={periodReadOnly}
            onDenomToggle={i => {
              const next = payload.denoms.map((d, k) => (k === i ? { ...d, on: !d.on } : d))
              void saveSettings({ denoms: next })
            }}
            onRoundingChange={cents => void patchPeriod({ roundingStepCents: cents })}
          />
        )}

        {tab === 'checks' && (
          <ChecksTab
            audit={audit} split={split} period={payload.period}
            punchTotal={payload.punchTotal} scopeLabel={payload.sales.scopeLabel}
            readOnly={periodReadOnly} onFix={applyFix}
          />
        )}

        {tab === 'import' && periodId && (
          <ImportTab
            periodId={periodId} period={payload.period} readOnly={periodReadOnly}
            onImported={() => void loadPeriod(periodId)}
          />
        )}

        {tab === 'settings' && settings && (
          <SettingsTab
            payload={payload} split={split} settings={settings}
            locations={locations} revenueCenters={revenueCenters}
            onSaveSettings={patch => void saveSettings(patch as Record<string, unknown>)}
            onSaveRole={(id, patch) => {
              void fetch(`/api/tips/roles/${id}`, {
                method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
              }).then(() => { if (periodId) void loadPeriod(periodId) })
            }}
            onAddRole={() => {
              void fetch('/api/tips/roles', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name: 'New role', multiplier: 1 }),
              }).then(() => { if (periodId) void loadPeriod(periodId) })
            }}
            onDeleteRole={id => {
              void fetch(`/api/tips/roles/${id}`, { method: 'DELETE' })
                .then(async r => (r.ok ? null : ((await r.json()).error ?? 'Could not delete that role')))
                // setError must run AFTER the reload — loadPeriod's own success
                // path calls setError(null), which would otherwise wipe this —
                // and only when the reload itself succeeded, or a load failure
                // gets stomped by this error.
                .then(async errorMessage => {
                  const reloaded = periodId ? await loadPeriod(periodId) : true
                  if (errorMessage && reloaded) setError(errorMessage)
                })
            }}
            onSaveRoster={(cookId, patch) => {
              void fetch(`/api/tips/roster/${cookId}`, {
                method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
              }).then(async r => (r.ok ? null : ((await r.json()).error ?? 'Could not save that change')))
                // setError must run AFTER the reload — loadPeriod's own success
                // path calls setError(null), which would otherwise wipe this.
                // Reloading first also means the picker/field reflects the
                // server's actual (unchanged) value instead of the rejected one.
                // And only when the reload itself succeeded, or a load failure
                // gets stomped by this error.
                .then(async errorMessage => {
                  const reloaded = periodId ? await loadPeriod(periodId) : true
                  if (errorMessage && reloaded) setError(errorMessage)
                })
            }}
            onAddEmployee={() => setError('Add new kitchen staff in Setup → Kitchen crew, then give them a clock ID here.')}
          />
        )}
      </div>
    </div>
  )
}
