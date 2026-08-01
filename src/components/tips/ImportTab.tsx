'use client'
import { useRef, useState } from 'react'
import type { TipPeriodPayload } from '@/lib/tips/types'
import { MethodNote } from './kit'

type Kind = 'sales' | 'clocks'
type UnparsedRow = { row: number; clockId?: string; raw?: unknown }
type Status = { tone: 'idle' | 'ok' | 'err'; message: string; unparsed?: UnparsedRow[] }

export function ImportTab({
  periodId, period, readOnly, onImported,
}: {
  periodId: string
  period: TipPeriodPayload['period']
  readOnly: boolean
  onImported: () => void
}) {
  const [status, setStatus] = useState<Record<Kind, Status>>({
    sales: { tone: 'idle', message: '' },
    clocks: { tone: 'idle', message: '' },
  })
  const [dragging, setDragging] = useState<Kind | null>(null)

  const upload = async (kind: Kind, file: File) => {
    setStatus(s => ({ ...s, [kind]: { tone: 'idle', message: `Reading ${file.name}…` } }))
    const body = new FormData()
    body.append('file', file)
    body.append('kind', kind)
    const res = await fetch(`/api/tips/periods/${periodId}/import`, { method: 'POST', body })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      // The route throws manager-readable messages for a bad date, an
      // ambiguous tips column, or a workbook that doesn't overlap the period —
      // render that verbatim rather than a generic failure string.
      setStatus(s => ({ ...s, [kind]: { tone: 'err', message: json.error ?? 'That workbook could not be read.' } }))
      return
    }
    const sum = json.summary ?? {}
    const unparsed: UnparsedRow[] = sum.unparsedRows ?? []
    setStatus(s => ({
      ...s,
      [kind]: {
        tone: 'ok',
        message: kind === 'sales'
          ? `Read ${sum.days} days · $${Number(sum.total).toLocaleString('en-CA', { minimumFractionDigits: 2 })} net sales`
          : `Read ${sum.shifts} shifts · ${sum.hours} h · ${sum.people} people` +
            (sum.strangers ? ` · ${sum.strangers} not on the roster — see Checks` : '') +
            (sum.outside ? ` · ${sum.outside} dated outside the period` : ''),
        unparsed,
      },
    }))
    onImported()
  }

  return (
    <div>
      <div className="grid grid-cols-2 gap-4">
        <DropCard
          kind="sales"
          title="Sales summary"
          pill={period.salesFileName ? 'OVERRIDING THE APP' : 'USING APP SALES'}
          pillTone={period.salesFileName ? 'warn' : 'ok'}
          sub="SalesSummary_….xlsx — reads the “Sales by day” sheet. Only needed for days the app has no sales for."
          status={status.sales}
          dragging={dragging === 'sales'}
          readOnly={readOnly}
          onDragState={d => setDragging(d ? 'sales' : null)}
          onFile={f => void upload('sales', f)}
        />
        <DropCard
          kind="clocks"
          title="Clocks summary"
          pill={period.clockFileName ? 'IMPORTED' : 'NOT IMPORTED'}
          pillTone={period.clockFileName ? 'ok' : 'warn'}
          sub="Clocks Summary_….xlsx — every punch, matched to the roster by Clock ID."
          status={status.clocks}
          dragging={dragging === 'clocks'}
          readOnly={readOnly}
          onDragState={d => setDragging(d ? 'clocks' : null)}
          onFile={f => void upload('clocks', f)}
        />
      </div>

      <MethodNote>
        <b>Hours are matched to people by Clock ID, never by name</b>, so a spelling change in the POS
        cannot silently drop somebody. Anything that does not match lands on the Checks tab before it
        can affect a payout. Re-importing the clocks workbook replaces every punch in this period and
        clears the exclusion list.
      </MethodNote>
    </div>
  )
}

function DropCard({
  kind, title, pill, pillTone, sub, status, dragging, readOnly, onDragState, onFile,
}: {
  kind: Kind
  title: string
  pill: string
  pillTone: 'ok' | 'warn'
  sub: string
  status: Status
  dragging: boolean
  readOnly: boolean
  onDragState: (dragging: boolean) => void
  onFile: (file: File) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const ok = status.tone === 'ok'
  const unparsedCount = status.unparsed?.length ?? 0

  return (
    <div className="bg-paper border border-line rounded-xl p-5">
      <h3 className="text-[15px] font-semibold tracking-[-0.015em] mb-0.5">
        {title}
        <span className={`ml-1.5 font-mono text-[10px] uppercase px-2.5 py-[3px] rounded-full font-medium ${pillTone === 'ok' ? 'bg-green-soft text-green-text' : 'bg-gold-soft text-gold-2'}`}>{pill}</span>
      </h3>
      <p className="font-mono text-[10.5px] text-ink-3 mb-3.5">{sub}</p>
      <button
        type="button"
        disabled={readOnly}
        onClick={() => input.current?.click()}
        onDragOver={e => { if (readOnly) return; e.preventDefault(); onDragState(true) }}
        onDragLeave={() => onDragState(false)}
        onDrop={e => {
          e.preventDefault(); onDragState(false)
          if (readOnly) return
          const f = e.dataTransfer.files?.[0]
          if (f) onFile(f)
        }}
        className={`w-full flex flex-col items-center justify-center gap-[5px] min-h-[132px] rounded border border-dashed p-4 text-center transition-colors disabled:opacity-50 ${
          ok ? 'border-solid border-green bg-[#f7fdf9]' : dragging ? 'border-gold bg-[#fffdf6]' : 'border-line-2 bg-bg hover:border-gold hover:bg-[#fffdf6]'
        }`}
      >
        <span className={ok ? 'text-green-text' : dragging ? 'text-gold-2' : 'text-ink-4'}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M9 15h6M9 18h4" />
          </svg>
        </span>
        <span className="text-[13px] font-medium tracking-[-0.01em]">Drop the {kind === 'sales' ? 'sales' : 'clocks'} workbook</span>
        <span className="font-mono text-[10px] text-ink-4">or click to choose · .xlsx</span>
      </button>
      <input ref={input} type="file" accept=".xlsx" hidden onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f) }} />
      {status.message && (
        <p className={`mt-2.5 font-mono text-[10.5px] ${status.tone === 'ok' ? 'text-green-text' : status.tone === 'err' ? 'text-red-text' : 'text-ink-3'}`}>
          {status.message}
        </p>
      )}
      {/* Rows with a valid date/Clock ID but an unreadable figure are dropped
          silently by the parser — this is the last place a human catches them,
          so they must never be swallowed by a plain success message. */}
      {unparsedCount > 0 && (
        <div className="mt-2.5 rounded border border-gold bg-gold-soft px-2.5 py-2 font-mono text-[10px] text-gold-2 leading-[1.6]">
          <b className="font-semibold">
            {unparsedCount} row{unparsedCount === 1 ? '' : 's'} could not be read and {unparsedCount === 1 ? 'was' : 'were'} skipped:
          </b>{' '}
          {status.unparsed!.slice(0, 6)
            .map(u => `row ${u.row}${u.clockId ? ` (#${u.clockId})` : ''}${u.raw != null && u.raw !== '' ? ` “${String(u.raw)}”` : ''}`)
            .join(', ')}
          {unparsedCount > 6 ? ` +${unparsedCount - 6} more` : ''}
        </div>
      )}
    </div>
  )
}
