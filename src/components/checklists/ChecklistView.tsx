'use client'
import type { RunView } from '@/lib/checklists/runs'
import type { Handover, StationCard } from '@/lib/checklists/cook-view'
import { runProgress, type Phase } from '@/lib/checklists/rules'
import { LineRow, firstName, type RowLine } from './LineRow'

// The cook's list: a progress card, then one card per picked station. The
// whole-kitchen run's lines are merged into the first card with a KITCHEN pill.
// A lead with no station picked gets the whole-kitchen run as its own card.
// Each card: blockers first ("BEFORE DOORS" / "BEFORE YOU LEAVE"), then each
// category in line order.

type Row = { line: RowLine; shared: boolean; locked: boolean }
type Section = { key: string; label: string; urgent: boolean; count: string; rows: Row[] }

const handled = (rows: Row[]) => rows.filter(r => r.line.status !== 'TODO').length

function sectionsFor(rows: Row[], phase: Phase): Section[] {
  const out: Section[] = []
  const blockers = rows.filter(r => r.line.isBlocker)
  if (blockers.length > 0) {
    const left = blockers.filter(r => r.line.status === 'TODO').length
    const base = phase === 'OPEN' ? 'BEFORE DOORS' : 'BEFORE YOU LEAVE'
    out.push({
      key: '__blockers',
      label: left > 0 ? `${base} · ${left} LEFT` : base,
      urgent: left > 0,
      count: `${handled(blockers)}/${blockers.length}`,
      rows: blockers,
    })
  }
  const byCat = new Map<string, Row[]>()
  for (const r of rows) {
    if (r.line.isBlocker) continue
    const name = r.line.categoryName.trim()
    const list = byCat.get(name)
    if (list) list.push(r)
    else byCat.set(name, [r])
  }
  for (const [name, list] of Array.from(byCat)) {
    out.push({
      key: `cat:${name}`,
      label: (name || 'Other jobs').toUpperCase(),
      urgent: false,
      count: `${handled(list)}/${list.length}`,
      rows: list,
    })
  }
  return out
}

export function ChecklistView({
  phase,
  mine,
  shared,
  stations,
  handover,
  busyIds,
  onTap,
  onMore,
}: {
  phase: Phase
  mine: RunView[]
  shared: RunView | null
  stations: StationCard[]
  handover: Record<string, Handover>
  /** Lines with a save in flight. */
  busyIds: ReadonlySet<string>
  onTap: (line: RowLine) => void
  onMore: (line: RowLine) => void
}) {
  const stationById = new Map(stations.map(s => [s.id, s]))
  const allLines = [...mine.flatMap(r => r.lines), ...(shared?.lines ?? [])]
  const p = runProgress(allLines)
  const donePct = p.total > 0 ? (p.done / p.total) * 100 : 0
  const flagPct = p.total > 0 ? (p.flagged / p.total) * 100 : 0
  const breakdown = [...mine, ...(shared ? [shared] : [])]
    .filter(r => r.lines.length > 0)
    .map(r => `${r.lines.length} ${(stationById.get(r.stationId)?.name ?? '').toUpperCase()}`)
    .join(' · ')

  return (
    <div className="flex flex-col gap-4">
      <section aria-label="Progress" className="bg-paper border border-line rounded-[14px] px-4 py-3.5 flex flex-col gap-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-mono text-[22px] font-semibold tracking-[-0.03em]">{p.handled} / {p.total}</span>
          {p.flagged > 0
            ? <span className="font-mono text-[10.5px] text-red-text">{p.flagged} FLAGGED</span>
            : <span className="font-mono text-[10.5px] text-ink-3 text-right">{breakdown}</span>}
        </div>
        <div className="h-1.5 bg-bg-2 rounded-full overflow-hidden flex">
          <div className="bg-green" style={{ width: `${donePct}%` }} />
          <div className="bg-red" style={{ width: `${flagPct}%` }} />
        </div>
      </section>

      {mine.map((run, i) => {
        const station = stationById.get(run.stationId)
        const locked = run.status === 'SIGNED'
        const rows: Row[] = run.lines.map(line => ({ line, shared: false, locked }))
        if (i === 0 && shared) {
          const sharedLocked = shared.status === 'SIGNED'
          for (const line of shared.lines) rows.push({ line, shared: true, locked: sharedLocked })
        }
        const note = phase === 'OPEN' ? handover[run.stationId] : undefined
        return (
          <div key={run.id} className="bg-paper border border-line rounded-[14px] overflow-hidden">
            {mine.length > 1 && station && (
              <div className="flex items-center gap-2 px-4 pt-3.5 pb-1">
                <span className="w-2 h-2 rounded-full" style={{ background: station.color }} />
                <span className="text-[14px] font-semibold tracking-[-0.01em]">{station.name}</span>
                {locked && <span className="ml-auto font-mono text-[10px] text-green-text">SIGNED OFF</span>}
              </div>
            )}
            {note && (
              <div className="mx-3 mt-3 rounded-[10px] bg-gold-soft px-3 py-2.5 text-[13.5px] leading-[1.45] text-ink-2">
                <b className="font-semibold text-ink">Last night:</b> {note.note}
                {note.byName && <span className="text-ink-3"> — {firstName(note.byName)}</span>}
              </div>
            )}
            {rows.length === 0 ? (
              <p className="m-0 px-4 py-4 text-[14px] text-ink-3">Nothing on the {station?.name ?? 'station'} list today.</p>
            ) : (
              sectionsFor(rows, phase).map(sec => (
                <div key={sec.key}>
                  <div className="px-4 pt-3.5 pb-1.5 font-mono text-[10px] font-medium tracking-[0.08em] flex justify-between gap-3">
                    <span className={sec.urgent ? 'text-red-text' : 'text-ink-3'}>{sec.label}</span>
                    <span className="text-ink-3">{sec.count}</span>
                  </div>
                  {sec.rows.map(r => (
                    <LineRow key={r.line.id} line={r.line} shared={r.shared} locked={r.locked} busy={busyIds.has(r.line.id)} onTap={onTap} onMore={onMore} />
                  ))}
                </div>
              ))
            )}
          </div>
        )
      })}

      {mine.length === 0 && shared && (() => {
        const station = stationById.get(shared.stationId)
        const locked = shared.status === 'SIGNED'
        const rows: Row[] = shared.lines.map(line => ({ line, shared: false, locked }))
        return (
          <div className="bg-paper border border-line rounded-[14px] overflow-hidden">
            <div className="flex items-center gap-2 px-4 pt-3.5 pb-1">
              {station && <span className="w-2 h-2 rounded-full" style={{ background: station.color }} />}
              <span className="text-[14px] font-semibold tracking-[-0.01em]">{station?.name ?? 'Whole kitchen'}</span>
              {locked && <span className="ml-auto font-mono text-[10px] text-green-text">SIGNED OFF</span>}
            </div>
            {rows.length === 0 ? (
              <p className="m-0 px-4 py-4 text-[14px] text-ink-3">Nothing on the {station?.name ?? 'whole-kitchen'} list today.</p>
            ) : (
              sectionsFor(rows, phase).map(sec => (
                <div key={sec.key}>
                  <div className="px-4 pt-3.5 pb-1.5 font-mono text-[10px] font-medium tracking-[0.08em] flex justify-between gap-3">
                    <span className={sec.urgent ? 'text-red-text' : 'text-ink-3'}>{sec.label}</span>
                    <span className="text-ink-3">{sec.count}</span>
                  </div>
                  {sec.rows.map(r => (
                    <LineRow key={r.line.id} line={r.line} shared={r.shared} locked={r.locked} busy={busyIds.has(r.line.id)} onTap={onTap} onMore={onMore} />
                  ))}
                </div>
              ))
            )}
          </div>
        )
      })()}
    </div>
  )
}
