'use client'
import type { AuditResult, FindingAction } from '@/lib/tips/audit'
import type { SplitResult, TipPeriodPayload } from '@/lib/tips/types'
import { hoursLabel, money, signedHours } from './kit'

export function ChecksTab({
  audit, split, period, punchTotal, scopeLabel, readOnly, onFix,
}: {
  audit: AuditResult
  split: SplitResult
  period: TipPeriodPayload['period']
  punchTotal: number
  scopeLabel: string
  readOnly: boolean
  onFix: (action: FindingAction) => void
}) {
  const { counts } = audit

  return (
    <div className="grid grid-cols-[1fr_350px] gap-5 items-start">
      <div>
        <div className="font-mono text-[10.5px] text-ink-3 mb-2.5">
          {counts.error || counts.warn
            ? [counts.error ? `${counts.error} TO FIX` : '', counts.warn ? `${counts.warn} TO REVIEW` : ''].filter(Boolean).join(' · ')
            : 'NOTHING TO FIX'}
          {' · '}{counts.shifts} SHIFTS MATCHED · {hoursLabel(counts.inPool)} PAID
          {counts.missingHours >= 0.005 && (
            <span className="text-red-text"> · {hoursLabel(counts.missingHours)} UNACCOUNTED</span>
          )}
        </div>

        {/* Rendered generically off Finding[] — every severity and every
            FindingAction.kind the audit can produce, with no id enumerated
            here. New finding ids (hours-<code>, deptexcluded, negbasis,
            boost-offtier, …) need no changes on this side. */}
        {audit.findings.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 py-12 px-5 bg-paper border border-line rounded-xl text-center">
            <span className="w-[34px] h-[34px] rounded-full bg-green-soft text-green-text grid place-items-center text-[15px] font-bold mb-0.5">✓</span>
            <span className="text-[15px] font-semibold tracking-[-0.02em]">Everything reconciles</span>
            <span className="font-mono text-[10.5px] text-ink-3">
              {counts.shifts} shifts · {hoursLabel(counts.inPool)} · {money(split.poolTotal)} distributed to the cent
            </span>
          </div>
        ) : (
          audit.findings.map(f => (
            <div
              key={f.id}
              className={`grid grid-cols-[auto_1fr_auto] gap-[13px] items-start bg-paper border border-line rounded-md px-4 py-3.5 mb-2.5 border-l-[3px] ${
                f.severity === 'error' ? 'border-l-red' : f.severity === 'warn' ? 'border-l-gold' : 'border-l-line-2'
              }`}
            >
              <span className={`w-[18px] h-[18px] rounded-full grid place-items-center text-[11px] font-bold text-paper mt-px ${
                f.severity === 'error' ? 'bg-red' : f.severity === 'warn' ? 'bg-gold' : 'bg-ink-4'
              }`}>
                {f.severity === 'info' ? 'i' : '!'}
              </span>
              <span>
                <span className="block text-[13.5px] font-semibold tracking-[-0.012em] mb-[3px]">{f.title}</span>
                <span className="block text-[12.5px] text-ink-3 leading-[1.5] text-pretty">{f.detail}</span>
              </span>
              <span className="flex gap-1.5 items-center shrink-0">
                {(f.actions ?? []).map(a => (
                  <button
                    key={a.label}
                    disabled={readOnly && a.kind !== 'goto'}
                    onClick={() => onFix(a)}
                    className={`px-[11px] py-1.5 rounded text-[12px] font-medium whitespace-nowrap border disabled:opacity-40 ${
                      a.ghost ? 'border-transparent text-ink-3 hover:bg-bg-2 hover:text-ink' : 'border-line bg-paper text-ink-2 hover:border-ink-3'
                    }`}
                  >
                    {a.label}
                  </button>
                ))}
              </span>
            </div>
          ))
        )}
      </div>

      <div className="flex flex-col gap-3.5">
        <div className="bg-paper border border-line rounded-xl p-5">
          <h3 className="text-[15px] font-semibold tracking-[-0.015em] mb-0.5">Hours reconciliation</h3>
          <p className="font-mono text-[10.5px] text-ink-3 mb-3.5">every hour on the clock file, and where it went</p>
          {audit.ledger.map(row => (
            <div
              key={row.label}
              className={`grid grid-cols-[1fr_auto] gap-2.5 items-baseline py-1.5 text-[12.5px] ${
                row.lead ? 'font-semibold text-ink' : row.subtotal ? 'font-medium border-t border-line mt-1 pt-[9px]' : 'text-ink-2'
              } ${row.muted ? 'text-ink-4' : ''} ${
                row.closed !== undefined ? 'border-t border-ink mt-1.5 pt-2.5' : ''
              }`}
            >
              <span>
                {row.label}
                {row.note && <small className="block font-mono text-[9.5px] text-ink-4 mt-px">{row.note}</small>}
              </span>
              <span className={`font-mono text-[12.5px] ${row.lead ? 'font-semibold text-[14px]' : ''} ${
                row.bad ? 'text-red-text font-semibold' : row.warn ? 'text-gold-2 font-semibold' : row.muted ? 'text-ink-4' : 'text-ink'
              }`}>
                {row.lead || row.subtotal ? hoursLabel(row.value) : signedHours(row.value)}
                {row.closed === true && <span className="text-green-text font-mono text-[10px] ml-1.5">✓</span>}
              </span>
            </div>
          ))}
          <div className="mt-3 px-3 py-2.5 rounded bg-bg-2 font-mono text-[10.5px] text-ink-3 leading-[1.6] [&_b]:text-ink [&_b]:font-semibold">
            {counts.missingHours >= 0.005 ? (
              <>
                <b>{hoursLabel(counts.missingHours)} of clocked kitchen labour is being left out</b> —{' '}
                {counts.lostPeople.slice(0, 3).join(', ')}
                {counts.lostPeople.length > 3 ? ` +${counts.lostPeople.length - 3} more` : ''}. Settle that before paying this period.
              </>
            ) : Math.abs(counts.unexplained) >= 0.005 ? (
              <><b>{hoursLabel(Math.abs(counts.unexplained))} unexplained</b> — do not pay this period until it closes.</>
            ) : counts.unreconciledHours >= 0.005 ? (
              <><b>{hoursLabel(counts.unreconciledHours)} paid on the wrong day</b> for one or more people — see the findings above.</>
            ) : (
              <>Every hour on the clock file is either paid or accounted for above. <b>Nothing is missing.</b></>
            )}
          </div>
        </div>

        <div className="bg-paper border border-line rounded-xl p-5">
          <h3 className="text-[15px] font-semibold tracking-[-0.015em] mb-0.5">Source files</h3>
          <p className="font-mono text-[10.5px] text-ink-3 mb-3.5">what this period was calculated from</p>
          {[
            {
              name: period.clockFileName ?? 'No clocks workbook imported',
              meta: period.clockFileName
                ? `${counts.shifts} matched shifts · ${hoursLabel(punchTotal)} on file · ${period.clockImportedAt?.slice(0, 16).replace('T', ' ') ?? ''}`
                : 'Hours must be typed by hand until one is imported',
            },
            {
              name: period.salesFileName ?? `Sales from the app · ${scopeLabel}`,
              meta: period.salesFileName
                ? `Overriding the app · ${period.salesImportedAt?.slice(0, 16).replace('T', ' ') ?? ''}`
                : 'Live SalesEntry rows, Toast-wins de-duplicated',
            },
            { name: 'Matched by Clock ID', meta: 'names are never used to match hours to people' },
          ].map(row => (
            <div key={row.name} className="grid grid-cols-[auto_1fr] gap-2.5 py-2 border-b border-line last:border-b-0 items-start">
              <span className="text-ink-4 mt-px">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></svg>
              </span>
              <span>
                <span className="font-mono text-[10.5px] text-ink break-all leading-[1.45] block">{row.name}</span>
                <small className="font-mono text-[9.5px] text-ink-4 mt-0.5 block">{row.meta}</small>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
