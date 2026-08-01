'use client'
import { useState } from 'react'
import type { AuditResult, FindingAction } from '@/lib/tips/audit'
import type { SortKey, SplitPerson, SplitResult, TipRoleDef } from '@/lib/tips/types'
import { DEFAULT_SORT_DIR, effectiveHours, sortPeople } from '@/lib/tips/engine'
import { DayStrip, DayStripLegend, MethodNote, RoleSelect, initials, money } from './kit'

const COLUMNS: Array<{ key: SortKey | 'strip'; label: string; right?: boolean }> = [
  { key: 'name', label: 'Team member' },
  { key: 'role', label: 'Role weight' },
  { key: 'strip', label: '' },
  { key: 'hours', label: 'Hours', right: true },
  { key: 'weighted', label: 'Weighted', right: true },
  { key: 'rate', label: '$ / h', right: true },
  { key: 'share', label: 'Share', right: true },
  { key: 'tip', label: 'Tips', right: true },
  { key: 'env', label: 'Envelope', right: true },
]

const GRID = '1.35fr 112px 178px 60px 74px 66px 92px 96px 100px'

/** "8h × 12 · 10h × 6 · uncapped × 3" — the crew's contracted shift lengths. */
function capSummary(people: SplitPerson[]): string {
  if (!people.length) return '—'
  const counts = new Map<string, number>()
  for (const p of people) {
    const key = p.dailyHourCap == null ? 'uncapped' : `${p.dailyHourCap}h`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => (a[0] === 'uncapped' ? 1 : b[0] === 'uncapped' ? -1 : parseFloat(a[0]) - parseFloat(b[0])))
    .map(([k, n]) => `${k} × ${n}`)
    .join(' · ')
}

export interface SplitTabProps {
  split: SplitResult
  audit: AuditResult
  roles: TipRoleDef[]
  dayLabels: string[]
  rewardTiers: number[]
  readOnly: boolean
  onRoleChange: (cookId: string, roleId: string) => void
  /** Per-person contracted shift cap. Null clears it (uncapped). */
  onCapChange: (cookId: string, cap: number | null) => void
  onHoursChange: (cookId: string, dayIndex: number, hours: number) => void
  onBoostChange: (cookId: string, dayIndex: number, boost: number) => void
  onClearAdjustments: (cookId: string) => void
  onFix: (action: FindingAction) => void
  onGoto: (tab: string) => void
}

export function SplitTab(props: SplitTabProps) {
  const { split, audit, roles, dayLabels, readOnly } = props
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'tip', dir: -1 })
  const [open, setOpen] = useState<string | null>(null)

  const rows = sortPeople(split.people, sort.key, sort.dir)
  const toggleSort = (key: SortKey) =>
    setSort(s => (s.key === key ? { key, dir: (-s.dir) as 1 | -1 } : { key, dir: DEFAULT_SORT_DIR[key] }))

  const alerts = audit.findings.filter(f => f.severity !== 'info').slice(0, 3)
  const rewardedDays = split.people.reduce((a, p) => a + p.boosts.filter(b => b > 1).length, 0)
  // distributedTotal, not poolTotal: this is the money people are actually
  // being paid, divided by the hours they actually worked. poolTotal can
  // include a day's pool that nobody was on shift to earn — using it here
  // would inflate the average against hours that never earned that money.
  const avgRate = split.hoursTotal ? split.distributedTotal / split.hoursTotal : 0

  return (
    <div>
      {alerts.length > 0 && (
        <div className="flex flex-col gap-px bg-line border border-line rounded-md overflow-hidden mb-3.5">
          {alerts.map(f => (
            <div key={f.id} className={`grid grid-cols-[auto_1fr_auto] gap-[11px] items-center px-3.5 py-2.5 text-[13px] ${f.severity === 'error' ? 'bg-[#fffafa]' : 'bg-paper'}`}>
              <span className={`w-[17px] h-[17px] rounded-full grid place-items-center text-[11px] font-bold text-paper shrink-0 ${f.severity === 'error' ? 'bg-red' : 'bg-gold'}`}>!</span>
              <span><b className="font-semibold">{f.title}</b> — {f.detail}</span>
              <button onClick={() => props.onGoto('checks')} className="font-mono text-[10.5px] text-ink-3 hover:text-gold-2">
                Review {audit.counts.error + audit.counts.warn} checks →
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-[1fr_auto_auto] gap-2.5 items-center mb-3.5">
        <div className="flex items-center gap-4 min-w-0">
          <span className="font-mono text-[10.5px] text-ink-3 whitespace-nowrap">CLICK A ROW FOR THE DAY DETAIL</span>
          <DayStripLegend />
        </div>
        {/* Caps are contract terms per person, so this is a read-out, not a
            control: "8h × 12 · 10h × 6 · uncapped × 3". Editing happens on the
            person (open a row) or in Tip settings. */}
        <span className="font-mono text-[11px] text-ink-3" title="Contracted shift caps across the crew">
          SHIFT CAPS {capSummary(split.people)}
        </span>
        <button
          onClick={() => split.people.forEach(p => props.onClearAdjustments(p.cookId))}
          disabled={readOnly}
          className="px-2.5 py-1.5 rounded text-[13px] font-medium text-ink-3 hover:bg-bg-2 hover:text-ink disabled:opacity-40"
        >
          Reset edits
        </button>
      </div>

      <div className="bg-paper border border-line rounded-xl overflow-hidden">
        <div className="grid items-center px-[18px] py-[11px] bg-bg-2 border-b border-line font-mono text-[10.5px] text-ink-3 tracking-[0.02em] uppercase" style={{ gridTemplateColumns: GRID }}>
          {COLUMNS.map(col =>
            col.key === 'strip' ? (
              <span key="strip" className="grid" style={{ gridTemplateColumns: `repeat(${dayLabels.length}, 1fr)` }}>
                {dayLabels.map(l => (
                  <span key={l} className="text-center text-[9px] tracking-normal" title={l}>
                    {l.charAt(0)}<br />{l.replace(/\D+/g, '')}
                  </span>
                ))}
              </span>
            ) : (
              <span
                key={col.key}
                onClick={() => toggleSort(col.key as SortKey)}
                className={`inline-flex items-center gap-1 cursor-pointer select-none rounded px-1 -mx-1 hover:text-ink hover:bg-line ${col.right ? 'justify-end' : ''} ${sort.key === col.key ? 'text-ink font-semibold' : ''}`}
              >
                {col.label}
                <i className="not-italic text-[7px] text-gold-2 leading-none">
                  {sort.key === col.key ? (sort.dir === 1 ? '▲' : '▼') : ''}
                </i>
              </span>
            ),
          )}
        </div>

        {rows.map(p => {
          const isOpen = open === p.cookId
          // distributedTotal, not poolTotal: shares are of the money that is
          // actually being handed out. Dividing by poolTotal on a period with
          // an orphan day pool (basis but nobody on shift) would make the
          // rows sum to under 100%, contradicting the footer's hard 100%.
          const share = split.distributedTotal ? (p.tip / split.distributedTotal) * 100 : 0
          return (
            <div key={p.cookId}>
              <div
                onClick={() => setOpen(isOpen ? null : p.cookId)}
                className={`grid items-center px-[18px] py-[11px] border-b border-line text-[13.5px] cursor-pointer ${isOpen ? 'bg-bg-2' : 'hover:bg-bg'}`}
                style={{ gridTemplateColumns: GRID }}
              >
                <span className="flex items-center gap-2.5 min-w-0">
                  <span className="w-7 h-7 rounded-full bg-bg-2 border border-line grid place-items-center font-mono text-[10px] font-semibold text-ink-2 shrink-0">{initials(p.name)}</span>
                  <span className="font-medium leading-tight">
                    {p.name}
                    <small className="block font-mono text-[9.5px] text-ink-4 font-normal mt-px">
                      #{p.clockId ?? '—'}{p.wage != null ? ` · $${p.wage}/h` : ''}
                    </small>
                  </span>
                  <span className={`ml-auto text-ink-4 text-[9px] transition-transform ${isOpen ? 'rotate-90 text-gold-2' : ''}`}>▶</span>
                </span>
                <span>
                  <RoleSelect value={p.roleId} roles={roles} onChange={id => props.onRoleChange(p.cookId, id)} />
                </span>
                <DayStrip person={p} dayLabels={dayLabels} />
                <span className="font-mono text-[12.5px] text-right text-ink-3">{p.hoursTotal.toFixed(1)}</span>
                <span className="font-mono text-[12.5px] text-right text-ink-3">{p.weighted.toFixed(1)}</span>
                <span className="font-mono text-[12.5px] text-right text-ink">{p.hoursTotal ? '$' + (p.tip / p.hoursTotal).toFixed(2) : '—'}</span>
                <span className="flex items-center gap-2 justify-end">
                  <span className="w-[30px] h-1.5 rounded-full bg-bg-2 overflow-hidden">
                    <span className="block h-full bg-ink rounded-full" style={{ width: `${Math.min(100, (share / 13) * 100)}%` }} />
                  </span>
                  <span className="font-mono text-[12.5px] text-ink-3">{share.toFixed(1)}%</span>
                </span>
                <span className="font-mono text-[13px] font-semibold text-right text-ink">{money(p.tip)}</span>
                <span className="font-mono text-[12.5px] text-right text-gold-2 font-semibold">{money(p.envelopeCents / 100)}</span>
              </div>
              {isOpen && <PersonDetail {...props} person={p} />}
            </div>
          )
        })}

        <div className="grid items-center px-[18px] py-3 bg-bg-2 border-t border-line font-mono text-[12px] font-semibold" style={{ gridTemplateColumns: GRID }}>
          <span className="text-[10.5px] text-ink-3 uppercase tracking-[0.02em] font-medium">{split.people.length} people</span>
          <span />
          <span className="text-[10.5px] text-ink-3 uppercase tracking-[0.02em] font-medium text-center">
            {rewardedDays} rewarded days
          </span>
          <span className="text-right">{split.hoursTotal.toFixed(1)}</span>
          <span className="text-right">{split.weightedTotal.toFixed(1)}</span>
          <span className="text-right">${avgRate.toFixed(2)}</span>
          <span className="text-right">100%</span>
          <span className="text-right">{money(split.distributedTotal)}</span>
          <span className="text-right text-gold-2">{money(split.envelopeTotalCents / 100)}</span>
        </div>
      </div>

      <MethodNote>
        <b>How the split works:</b> each day, the pool rate of that day&rsquo;s basis forms the day
        pool. It&rsquo;s divided by the weighted hours worked that day (hours × role weight × any day
        reward), so people who work the busy days earn more per hour. The daily shares are then
        summed per person — checked to the cent on the Checks tab.
      </MethodNote>
    </div>
  )
}

/** The expanded per-person panel: two weeks of editable day cards. */
function PersonDetail({
  person, dayLabels, rewardTiers, readOnly,
  onHoursChange, onBoostChange, onClearAdjustments, onCapChange,
}: SplitTabProps & { person: SplitPerson }) {
  const cap = person.dailyHourCap
  const tiers = [1, ...rewardTiers]
  const rewarded = person.boosts.filter(b => b > 1).length
  const weeks: number[][] = []
  for (let i = 0; i < dayLabels.length; i += 7) {
    weeks.push(Array.from({ length: Math.min(7, dayLabels.length - i) }, (_, k) => i + k))
  }

  return (
    <div className="bg-[#fbfbfa] border-b border-line px-[18px] pt-4 pb-[18px]" onClick={e => e.stopPropagation()}>
      <div className="flex items-end justify-between gap-5 mb-3.5">
        <div className="flex gap-[26px]">
          {[
            ['Days worked', `${person.hours.filter((_, d) => effectiveHours(person, d) > 0).length} / ${dayLabels.length}`, false],
            ['Hours', person.hoursTotal.toFixed(2), false],
            ['Weighted', person.weighted.toFixed(2), false],
            ['Rewarded days', String(rewarded), rewarded > 0],
            ['Tips', money(person.tip), true],
            ['Per hour', person.hoursTotal ? money(person.tip / person.hoursTotal) : '—', false],
          ].map(([label, value, gold]) => (
            <span key={label as string} className="flex flex-col gap-[3px]">
              <span className="font-mono text-[9.5px] text-ink-3 tracking-[0.03em] uppercase">{label}</span>
              <span className={`font-mono text-[15px] font-semibold ${gold ? 'text-gold-2' : 'text-ink'}`}>{value}</span>
            </span>
          ))}
        </div>
        <div className="flex items-center gap-3">
          {/* The cap is this person's contract term — edited where their hours are. */}
          <label className="inline-flex items-center gap-1.5 font-mono text-[10px] text-ink-3 uppercase tracking-[0.03em]">
            Shift cap
            <span className="inline-flex items-center gap-[3px] font-mono text-[11px] text-ink-4 border border-line rounded-md px-2 py-1 bg-paper focus-within:border-gold">
              <input
                type="number" step="0.5" min="1" max="24" placeholder="none"
                defaultValue={cap ?? ''} disabled={readOnly}
                onBlur={e => {
                  const v = parseFloat(e.target.value)
                  onCapChange(person.cookId, isFinite(v) && v > 0 ? v : null)
                }}
                className="w-12 font-mono text-[12.5px] font-semibold bg-transparent border-none outline-none text-right text-ink [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
              />
              h
            </span>
          </label>
          {rewarded > 0 && !readOnly && (
            <button onClick={() => onClearAdjustments(person.cookId)} className="px-2.5 py-1.5 rounded text-[13px] font-medium text-ink-3 hover:bg-bg-2 hover:text-ink">
              Clear rewards
            </button>
          )}
        </div>
      </div>

      {weeks.map((week, wi) => (
        <div key={wi}>
          <p className="font-mono text-[9.5px] text-ink-3 tracking-[0.06em] uppercase mb-[7px] flex items-center gap-2 after:content-[''] after:flex-1 after:h-px after:bg-line">
            Week {wi + 1}
          </p>
          <div className="grid grid-cols-7 gap-2 mb-3.5">
            {week.map(d => {
              const raw = person.hours[d] ?? 0
              const h = effectiveHours(person, d)
              const boost = person.boosts[d] ?? 1
              const capped = cap != null && raw > cap
              // Same two signals as the day strip, at card scale: a gold rail
              // for a rewarded day, a red rail for a capped one, and BOTH rails
              // when the day is both — never one hiding the other.
              const frame = h <= 0
                ? 'bg-transparent border-dashed border-line'
                : capped && boost > 1 ? 'border-red bg-[#fffdf6]'
                : capped ? 'border-red bg-paper'
                : boost > 1 ? 'border-gold bg-[#fffdf6]'
                : 'border-line bg-paper'
              return (
                <div key={d} className={`relative overflow-hidden rounded p-[9px_10px_10px] flex flex-col gap-[7px] border ${frame}`}>
                  {(boost > 1 || capped) && (
                    <span className="absolute inset-y-0 left-0 w-[3px] flex flex-col" aria-hidden>
                      {boost > 1 && <span className="flex-1 bg-gold" />}
                      {capped && <span className="flex-1 bg-red" />}
                    </span>
                  )}
                  <div className="flex items-baseline justify-between">
                    <span className={`font-mono text-[9.5px] tracking-[0.04em] uppercase ${capped ? 'text-red-text font-semibold' : boost > 1 ? 'text-gold-2 font-semibold' : 'text-ink-3'}`}>{dayLabels[d]}</span>
                    <span className={`font-mono text-[10px] ${boost > 1 ? 'text-gold-2' : 'text-ink-4'}`}>{h > 0 ? money(person.daily[d]) : '—'}</span>
                  </div>
                  <div className="flex items-center gap-[5px]">
                    <input
                      type="number" step="0.25" min="0" max="16" defaultValue={raw}
                      disabled={readOnly}
                      onBlur={e => {
                        const v = parseFloat(e.target.value)
                        onHoursChange(person.cookId, d, isFinite(v) && v >= 0 ? v : 0)
                      }}
                      className="w-full font-mono text-[14px] font-semibold border border-line rounded-md px-[7px] py-[5px] outline-none focus:border-gold text-ink bg-paper [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                    />
                    <span className="font-mono text-[10px] text-ink-4">h</span>
                  </div>
                  {capped && <span className="font-mono text-[9px] text-red-text">capped from {raw}h to {cap}h</span>}
                  <div className="flex gap-[3px]">
                    {tiers.map(t => (
                      <button
                        key={t}
                        disabled={readOnly}
                        onClick={() => onBoostChange(person.cookId, d, boost === t ? 1 : t)}
                        className={`flex-1 font-mono text-[9.5px] py-1 text-center rounded-[5px] border ${boost === t ? 'bg-gold border-gold text-paper font-semibold' : 'bg-paper border-line text-ink-3 hover:border-gold hover:text-gold-2'}`}
                      >
                        {t === 1 ? '—' : `×${t}`}
                      </button>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
