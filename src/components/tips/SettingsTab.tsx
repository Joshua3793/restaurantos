'use client'
import { useState } from 'react'
import type { SplitResult, TipPeriodPayload, TipRoleDef } from '@/lib/tips/types'
import { RoleSelect, initials, money } from './kit'

export interface TipSettingsDto {
  poolBasis: 'NET_SALES' | 'TIPS_COLLECTED'
  includeAutoGratuity: boolean
  poolRatePct: number
  /** Prefill for new roster rows only — the live cap is per person, on Cook.dailyHourCap. */
  defaultDailyHourCap: number | null
  rewardTiers: number[]
  roundingStepCents: number
  periodDays: number
  periodStartDow: number
  salesSourceMode: 'LOCATION' | 'RC'
  salesLocationId: string | null
  salesRcIds: string[]
  poolRevenueCenterId: string | null
  salesScopeLabel: string
}

export interface LookupOption { id: string; name: string; locationId?: string }

const GRID = 'minmax(180px,1.4fr) 68px 78px 74px 100px 50px 74px 48px 26px'

/**
 * THE SETTINGS TAB IS NEVER READ-ONLY, not even while the open period is PAID.
 *
 * Everything on it — the roster, the roles and their multipliers, the pool
 * rules and the sales scope — is HOUSE CONFIGURATION, not part of any one
 * period's split. Paying a period must freeze THAT PERIOD's split, which it
 * does: the payout snapshot carries each person's resolved cap, role, weight
 * and dollars at the moment cash went out (see lib/tips/types.ts), so a later
 * edit here cannot restate what anybody was actually paid.
 *
 * This tab used to take `readOnly = status === 'PAID'` from the page. Combined
 * with the page only ever opening one period, paying the first fortnight froze
 * the entire configuration with no way forward. The period-scoped edits —
 * hours, boosts, rate, basis, cap, rounding, imports, pay — are the ones that
 * freeze, and they still do, each behind the page's own `periodReadOnly`.
 */
export function SettingsTab({
  payload, split, settings, locations, revenueCenters,
  onSaveSettings, onSaveRole, onAddRole, onDeleteRole, onSaveRoster, onAddEmployee,
}: {
  payload: TipPeriodPayload
  split: SplitResult
  settings: TipSettingsDto
  locations: LookupOption[]
  revenueCenters: LookupOption[]
  onSaveSettings: (patch: Partial<TipSettingsDto>) => void
  onSaveRole: (id: string, patch: { name?: string; multiplier?: number }) => void
  onAddRole: () => void
  onDeleteRole: (id: string) => void
  onSaveRoster: (cookId: string, patch: Record<string, unknown>) => void
  onAddEmployee: () => void
}) {
  const tipBy = new Map(split.people.map(p => [p.cookId, p]))
  const usage = new Map<string, number>()
  payload.roster.forEach(p => { if (p.roleId) usage.set(p.roleId, (usage.get(p.roleId) ?? 0) + 1) })
  const poolRc = revenueCenters.find(rc => rc.id === payload.period.revenueCenterId)

  return (
    <div className="grid grid-cols-[1fr_330px] gap-5 items-start">
      {/* ── roster ─────────────────────────────────────────────────────────── */}
      <div>
        <div className="grid grid-cols-[1fr_auto] gap-2.5 items-center mb-3.5">
          <div className="font-mono text-[10.5px] text-ink-3">
            {payload.roster.length} PEOPLE ON THE ROSTER · {payload.roster.filter(p => !p.onPool).length} OFF POOL
          </div>
          <button onClick={onAddEmployee} className="inline-flex items-center gap-[7px] px-3.5 py-[9px] rounded border border-line bg-paper text-[13px] font-medium text-ink-2 hover:border-ink-3">
            <span className="text-ink-3">＋</span>Add employee
          </button>
        </div>

        <div className="bg-paper border border-line rounded-xl overflow-hidden">
          <div className="grid items-center gap-2 px-[18px] py-[11px] bg-bg-2 border-b border-line font-mono text-[10.5px] text-ink-3 uppercase tracking-[0.02em]" style={{ gridTemplateColumns: GRID }}>
            <span>Employee</span><span>Code</span><span>Wage</span>
            <span title="Contracted shift length — hours above it are not paid tips">Cap</span>
            <span>Role</span>
            <span className="text-right">Hours</span><span className="text-right">Tips</span>
            <span className="text-center">On pool</span><span />
          </div>
          {payload.roster.map(p => {
            const t = tipBy.get(p.cookId)
            return (
              <div key={p.cookId} className={`grid items-center gap-2 px-[18px] py-2 border-b border-line last:border-b-0 text-[13.5px] ${p.onPool ? '' : 'bg-[#fbfbfa]'}`} style={{ gridTemplateColumns: GRID }}>
                <span className="flex items-center gap-2 min-w-0">
                  <span className={`w-7 h-7 rounded-full bg-bg-2 border border-line grid place-items-center font-mono text-[10px] font-semibold text-ink-2 shrink-0 ${p.onPool ? '' : 'opacity-50'}`}>{initials(p.name)}</span>
                  <span className="grid gap-px min-w-0 flex-1">
                    <span className="text-[13px] font-medium truncate">{p.name}</span>
                    <input
                      defaultValue={p.lastName ?? ''} placeholder="Surname"
                      onBlur={e => onSaveRoster(p.cookId, { lastName: e.target.value })}
                      className="font-mono text-[10px] text-ink-3 bg-transparent border border-transparent rounded-md px-[7px] py-0.5 outline-none hover:border-line focus:border-gold focus:bg-paper"
                    />
                  </span>
                </span>
                <input
                  defaultValue={p.clockId ?? ''} placeholder="—"
                  onBlur={e => onSaveRoster(p.cookId, { clockId: e.target.value })}
                  className="font-mono text-[11.5px] text-ink-3 bg-transparent border border-transparent rounded-md px-[7px] py-[5px] outline-none w-full min-w-0 hover:border-line focus:border-gold focus:bg-paper"
                />
                <span className="flex items-center gap-px font-mono text-[11px] text-ink-4">
                  $<input
                    type="number" step="0.25" min="0" defaultValue={p.wage ?? ''}
                    onBlur={e => onSaveRoster(p.cookId, { wage: e.target.value === '' ? null : e.target.value })}
                    className="w-[42px] font-mono text-[12px] text-right bg-transparent border border-transparent rounded-md px-1 py-[5px] outline-none text-ink hover:border-line focus:border-gold focus:bg-paper [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                  /><em className="not-italic">/h</em>
                </span>
                {/* Contracted shift length — this person's alone. Blank means uncapped. */}
                <span className="flex items-center gap-px font-mono text-[11px] text-ink-4">
                  <input
                    type="number" step="0.5" min="1" max="24" placeholder="—"
                    defaultValue={p.dailyHourCap ?? ''}
                    onBlur={e => onSaveRoster(p.cookId, { dailyHourCap: e.target.value === '' ? null : e.target.value })}
                    className="w-[42px] font-mono text-[12px] text-right bg-transparent border border-transparent rounded-md px-1 py-[5px] outline-none text-ink hover:border-line focus:border-gold focus:bg-paper [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                  /><em className="not-italic">h</em>
                </span>
                <RoleSelect value={p.roleId} roles={payload.roles} onChange={id => onSaveRoster(p.cookId, { tipRoleId: id })} className="w-full" />
                <span className="font-mono text-[12.5px] text-right text-ink-3">{t ? `${t.hoursTotal.toFixed(1)} h` : '—'}</span>
                <span className={`font-mono text-[12.5px] text-right ${t ? 'text-gold-2 font-semibold' : 'text-ink-4'}`}>{t ? money(t.tip) : '—'}</span>
                <span className="flex justify-center">
                  <button
                    onClick={() => onSaveRoster(p.cookId, { onTipPool: !p.onPool })}
                    title="On the tip pool"
                    className={`w-[30px] h-[18px] rounded-full relative shrink-0 ${p.onPool ? 'bg-green' : 'bg-line-2'}`}
                  >
                    <span className={`absolute top-0.5 w-3.5 h-3.5 bg-paper rounded-full shadow-sm transition-all ${p.onPool ? 'left-3.5' : 'left-0.5'}`} />
                  </button>
                </span>
                <span />
              </div>
            )
          })}
        </div>
        <div className="mt-[18px] font-mono text-[10.5px] text-ink-3 flex justify-between">
          <span>Codes match the POS employee number · wage is reference only, it never affects the split</span>
          <span>Cap = contracted shift length, blank = uncapped · toggle off to keep someone on the roster but out of the pool</span>
        </div>
      </div>

      {/* ── rail ───────────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3.5">
        {/* THE SALES SCOPE PICKER — deliberately independent of the crew's own RC. */}
        <div className="bg-paper border border-line rounded-xl p-5">
          <h3 className="text-[15px] font-semibold tracking-[-0.015em] mb-0.5">Which sales fund this pool</h3>
          <p className="font-mono text-[10.5px] text-ink-3 mb-3.5">
            deliberately separate from the crew&rsquo;s own revenue center · sets both the sales and the tips the pool reads
          </p>

          <div className="rounded-md bg-bg-2 px-3 py-2.5 mb-3.5 text-[12.5px] text-ink-2 leading-[1.5]">
            Tips for <b className="font-semibold text-ink">{poolRc?.name ?? payload.period.revenueCenterName}</b>.
            Pool funded by <b className="font-semibold text-gold-2">{settings.salesScopeLabel}</b>,
            sized as <b className="font-semibold text-ink">{settings.poolRatePct}% of {settings.poolBasis === 'TIPS_COLLECTED' ? 'the tips collected' : 'net sales'}</b>.
          </div>

          <div className="flex items-center justify-between gap-2.5 py-[9px] border-b border-line">
            <span className="text-[13px] text-ink-2">Scope<small className="block font-mono text-[9.5px] text-ink-4 mt-0.5">where the funding sales come from</small></span>
            <select
              value={settings.salesSourceMode}
              onChange={e => onSaveSettings({ salesSourceMode: e.target.value as 'LOCATION' | 'RC' })}
              className="font-mono text-[11px] border border-line bg-paper rounded px-2.5 py-1.5 text-ink-2 cursor-pointer outline-none hover:border-ink-3"
            >
              <option value="LOCATION">A whole location</option>
              <option value="RC">Chosen revenue centers</option>
            </select>
          </div>

          {settings.salesSourceMode === 'LOCATION' ? (
            <div className="flex items-center justify-between gap-2.5 py-[9px] border-b border-line">
              <span className="text-[13px] text-ink-2">Location<small className="block font-mono text-[9.5px] text-ink-4 mt-0.5">every active RC underneath it</small></span>
              <select
                value={settings.salesLocationId ?? ''}
                onChange={e => onSaveSettings({ salesLocationId: e.target.value || null })}
                className="font-mono text-[11px] border border-line bg-paper rounded px-2.5 py-1.5 text-ink-2 cursor-pointer outline-none hover:border-ink-3 max-w-[170px]"
              >
                <option value="">— pick a location</option>
                {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
          ) : (
            <div className="py-[9px] border-b border-line">
              <span className="text-[13px] text-ink-2 block mb-2">Revenue centers<small className="block font-mono text-[9.5px] text-ink-4 mt-0.5">tick every one whose sales fund the pool</small></span>
              <div className="flex flex-col gap-1 max-h-[180px] overflow-y-auto">
                {revenueCenters.map(rc => {
                  const on = settings.salesRcIds.includes(rc.id)
                  return (
                    <label key={rc.id} className="flex items-center gap-2 text-[12.5px] text-ink-2 cursor-pointer">
                      <input
                        type="checkbox" checked={on}
                        onChange={() => onSaveSettings({
                          salesRcIds: on ? settings.salesRcIds.filter(id => id !== rc.id) : [...settings.salesRcIds, rc.id],
                        })}
                        className="accent-gold"
                      />
                      {rc.name}
                    </label>
                  )
                })}
              </div>
            </div>
          )}

          <div className="flex items-center justify-between gap-2.5 py-[9px]">
            <span className="text-[13px] text-ink-2">Crew&rsquo;s revenue center<small className="block font-mono text-[9.5px] text-ink-4 mt-0.5">where new periods are opened — independent of scope above</small></span>
            <select
              value={settings.poolRevenueCenterId ?? ''}
              onChange={e => onSaveSettings({ poolRevenueCenterId: e.target.value || null })}
              className="font-mono text-[11px] border border-line bg-paper rounded px-2.5 py-1.5 text-ink-2 cursor-pointer outline-none hover:border-ink-3 max-w-[170px]"
            >
              <option value="">— pick a revenue center</option>
              {revenueCenters.map(rc => <option key={rc.id} value={rc.id}>{rc.name}</option>)}
            </select>
          </div>
        </div>

        {/* roles & multipliers */}
        <div className="bg-paper border border-line rounded-xl p-5">
          <h3 className="text-[15px] font-semibold tracking-[-0.015em] mb-0.5">Roles &amp; multipliers</h3>
          <p className="font-mono text-[10.5px] text-ink-3 mb-3.5">every hour is weighted by the person&rsquo;s role before the day pool is divided</p>
          {payload.roles.map((r: TipRoleDef) => (
            <div key={r.id} className="grid grid-cols-[1fr_76px_26px_24px] gap-2 items-center py-[5px] border-b border-line last:border-b-0">
              <input
                defaultValue={r.name} placeholder="Role name"
                onBlur={e => onSaveRole(r.id, { name: e.target.value })}
                className="text-[13px] bg-transparent border border-transparent rounded-md px-[7px] py-[5px] outline-none hover:border-line focus:border-gold focus:bg-paper"
              />
              <span className="flex items-center gap-0.5 font-mono text-[11px] text-ink-4 border border-line rounded-md px-1.5 py-[3px] bg-paper focus-within:border-gold">
                ×<input
                  type="number" step="0.05" min="0" max="5" defaultValue={r.multiplier}
                  onBlur={e => {
                    // Never send NaN: JSON.stringify turns it into `null`, and
                    // a role weighted at ×0 pays everybody on it nothing. An
                    // unreadable box reverts to the stored multiplier instead.
                    const v = parseFloat(e.target.value)
                    if (!isFinite(v)) { e.target.value = String(r.multiplier); return }
                    if (v === r.multiplier) return
                    onSaveRole(r.id, { multiplier: v })
                  }}
                  className="w-full font-mono text-[12px] font-semibold bg-transparent border-none outline-none text-right text-ink [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                />
              </span>
              <span className="font-mono text-[10.5px] text-ink-4 text-right">{usage.get(r.id) ?? 0}</span>
              <button
                onClick={() => onDeleteRole(r.id)} disabled={payload.roles.length < 2} title="Delete role"
                className="w-6 h-6 rounded-md text-ink-4 text-[15px] leading-none grid place-items-center hover:bg-red-soft hover:text-red-text disabled:opacity-30"
              >×</button>
            </div>
          ))}
          <div className="flex justify-between items-center mt-3 gap-2.5">
            <span className="font-mono text-[10.5px] text-ink-4">
              {payload.roles.length} roles · {payload.roster.filter(p => p.onPool).length} on pool
            </span>
            <button onClick={onAddRole} className="font-mono text-[10.5px] text-ink-3 border border-dashed border-line-2 rounded-full px-2.5 py-1 hover:border-gold hover:text-gold-2">
              ＋ Add role
            </button>
          </div>
        </div>

        {/* pool rules */}
        <div className="bg-paper border border-line rounded-xl p-5">
          <h3 className="text-[15px] font-semibold tracking-[-0.015em] mb-0.5">Pool rules</h3>
          <p className="font-mono text-[10.5px] text-ink-3 mb-3.5">defaults applied to every new period</p>

          {/* THE POOL BASIS. Front of house keeps the customer's tips; the
              kitchen pool is a withdrawal from that pot. This picks how the
              withdrawal is sized — off sales, or off the pot itself. */}
          <div className="flex items-center justify-between gap-2.5 py-[9px] border-b border-line">
            <span className="text-[13px] text-ink-2">
              Pool basis
              <small className="block font-mono text-[9.5px] text-ink-4 mt-0.5">what the rate is a percentage of</small>
            </span>
            <select
              value={settings.poolBasis}
              onChange={e => onSaveSettings({ poolBasis: e.target.value as TipSettingsDto['poolBasis'] })}
              className="font-mono text-[11px] border border-line bg-paper rounded px-2.5 py-1.5 text-ink-2 cursor-pointer outline-none hover:border-ink-3"
            >
              <option value="NET_SALES">Net sales</option>
              <option value="TIPS_COLLECTED">Tips collected</option>
            </select>
          </div>
          <p className="font-mono text-[9.5px] text-ink-4 leading-[1.5] pb-2 border-b border-line">
            {settings.poolBasis === 'TIPS_COLLECTED'
              ? 'The kitchen takes this share of the tips customers actually left. The tip-out can never outrun the pot.'
              : 'The kitchen pool is sized off sales and drawn out of the front-of-house tip pot. Watch the tip-out % on the Split tab — a slow tipping week can leave the pool larger than the pot.'}
          </p>

          <div className="flex items-center justify-between gap-2.5 py-[9px] border-b border-line">
            <span className="text-[13px] text-ink-2">
              Auto-gratuity counts as tips
              <small className="block font-mono text-[9.5px] text-ink-4 mt-0.5">service charges flagged as gratuity in Toast</small>
            </span>
            <button
              onClick={() => onSaveSettings({ includeAutoGratuity: !settings.includeAutoGratuity })}
              className={`w-[30px] h-[18px] rounded-full relative shrink-0 ${settings.includeAutoGratuity ? 'bg-green' : 'bg-line-2'}`}
              aria-label="Count auto-gratuity as tips"
            >
              <span className={`absolute top-0.5 w-3.5 h-3.5 bg-paper rounded-full shadow-sm transition-all ${settings.includeAutoGratuity ? 'left-3.5' : 'left-0.5'}`} />
            </button>
          </div>

          <NumberRow
            label="Pool rate"
            hint={settings.poolBasis === 'TIPS_COLLECTED' ? 'share of the tip pot' : 'share of net sales'}
            suffix="%"
            value={settings.poolRatePct} step={0.5} min={0}
            max={settings.poolBasis === 'TIPS_COLLECTED' ? 100 : 15}
            onCommit={v => onSaveSettings({ poolRatePct: v ?? 0 })}
          />
          <NumberRow
            label="Default shift cap"
            hint="prefill for new people only — each person's cap lives on their own roster row"
            suffix="h"
            value={settings.defaultDailyHourCap} step={0.5} min={1} max={16}
            onCommit={v => onSaveSettings({ defaultDailyHourCap: v })}
          />
          <RewardTiers tiers={settings.rewardTiers} onChange={t => onSaveSettings({ rewardTiers: t })} />
        </div>
      </div>
    </div>
  )
}

function NumberRow({
  label, hint, suffix, value, step, min, max, onCommit,
}: {
  label: string; hint: string; suffix: string
  value: number | null; step: number; min: number; max: number
  onCommit: (v: number | null) => void
}) {
  return (
    <div className="flex items-center justify-between gap-2.5 py-[9px] border-b border-line last:border-b-0">
      <span className="text-[13px] text-ink-2">{label}<small className="block font-mono text-[9.5px] text-ink-4 mt-0.5">{hint}</small></span>
      <span className="inline-flex items-center gap-[3px] font-mono text-[11px] text-ink-4 border border-line rounded-md px-2 py-1 bg-paper focus-within:border-gold">
        <input
          type="number" step={step} min={min} max={max} defaultValue={value ?? ''} placeholder="—"
          onBlur={e => {
            const v = parseFloat(e.target.value)
            onCommit(isFinite(v) ? v : null)
          }}
          className="w-11 font-mono text-[12.5px] font-semibold bg-transparent border-none outline-none text-right text-ink [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
        />
        {suffix}
      </span>
    </div>
  )
}

function RewardTiers({
  tiers, onChange,
}: { tiers: number[]; onChange: (tiers: number[]) => void }) {
  const [draft, setDraft] = useState(tiers)
  const commit = (next: number[]) => {
    const clean = [...new Set(next.filter(n => isFinite(n) && n > 1))].sort((a, b) => a - b)
    setDraft(clean); onChange(clean)
  }
  return (
    <div className="flex flex-col items-start gap-2 py-[9px]">
      <span className="text-[13px] text-ink-2">Reward multipliers<small className="block font-mono text-[9.5px] text-ink-4 mt-0.5">offered on each day in the person detail</small></span>
      <span className="flex flex-wrap gap-1.5 items-center">
        {draft.map((t, i) => (
          <span key={i} className="inline-flex items-center gap-px font-mono text-[11px] text-gold-2 bg-gold-soft rounded-full pl-[9px] pr-[5px] py-[3px] font-semibold">
            ×<input
              type="number" step="0.05" min="1" max="5" defaultValue={t}
              onBlur={e => commit(draft.map((v, k) => (k === i ? parseFloat(e.target.value) : v)))}
              className="w-[34px] font-mono text-[11.5px] font-semibold bg-transparent border-none outline-none text-gold-2 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
            />
            <button onClick={() => commit(draft.filter((_, k) => k !== i))} className="w-4 h-4 text-[12px] leading-none grid place-items-center rounded hover:bg-paper/70">×</button>
          </span>
        ))}
      </span>
      <button
        disabled={draft.length >= 5}
        onClick={() => commit([...draft, Math.round((Math.max(1, ...draft) + 0.25) * 100) / 100])}
        className="font-mono text-[10.5px] text-ink-3 border border-dashed border-line-2 rounded-full px-2.5 py-1 hover:border-gold hover:text-gold-2 disabled:opacity-40"
      >
        ＋ Add tier
      </button>
    </div>
  )
}
