'use client'
// Smart Prep — the prep list: every prep item, by category (the view cooks use
// most) or by step. Filters: Everything · To make · Par to fix · No par set.
// In the Step view at-par rows fold into one line per group.
import { useState } from 'react'
import type { PrepItemRich } from '@/components/prep/types'
import { planGroups, START_TODAY_KEY, PLAN_URG_META, type PlanDayContext } from '@/lib/prep-plan'
import {
  prepListSections, rowKind, matchesFilter, filterCounts, parFlag, type PrepFilter,
} from '@/lib/prep-smart'
import { PrepRow } from './PrepRow'
import { HiddenGroup } from './HiddenGroup'
import type { PlannerHandlers } from './PlannerDesktop'

export type PrepView = 'CATEGORY' | 'STEP'

const FILTERS: Array<[PrepFilter, string]> = [['ALL', 'Everything'], ['MAKE', 'To make'], ['FIX', 'Par to fix'], ['NOPAR', 'No par set']]
const SHORT: Record<PrepFilter, string> = { ALL: 'All', MAKE: 'To make', FIX: 'Fix', NOPAR: 'No par' }

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-')
/** "Sauces & Dressings" → "Sauces" for the shortcut row. */
const shortCat = (s: string) => s.split(/[ &,]/)[0] || s

export function FilterChips({ filter, onFilter, counts, compact }: {
  filter: PrepFilter; onFilter: (f: PrepFilter) => void; counts: Record<PrepFilter, number>; compact?: boolean
}) {
  const list = compact ? FILTERS.filter(([k]) => k !== 'NOPAR') : FILTERS
  return (
    <>
      {list.map(([k, label]) => {
        const on = filter === k
        const warn = k === 'FIX' && counts.FIX > 0 && !on
        return (
          <button key={k} type="button" onClick={() => onFilter(k)} aria-pressed={on}
            className={`inline-flex items-center gap-1.5 shrink-0 whitespace-nowrap ${compact ? 'min-h-[44px]' : 'min-h-[36px]'} px-3 rounded-full border text-[13px] font-medium ${on ? 'bg-ink border-ink text-paper' : warn ? 'bg-gold-soft border-[#fcd34d] text-gold-2' : 'bg-paper border-line text-ink-2'}`}>
            {compact ? SHORT[k] : label}
            <span className={`font-mono text-[11.5px] font-semibold ${on ? 'text-line-2' : warn ? 'text-gold-2' : 'text-ink-3'}`}>{counts[k]}</span>
          </button>
        )
      })}
    </>
  )
}

export function ViewSwitch({ view, onView }: { view: PrepView; onView: (v: PrepView) => void }) {
  return (
    <span className="inline-flex shrink-0 border border-line rounded-full bg-paper p-[2px]">
      {(['CATEGORY', 'STEP'] as const).map(v => (
        <button key={v} type="button" onClick={() => onView(v)} aria-pressed={view === v}
          className={`min-h-[32px] px-3 rounded-full text-[13px] font-semibold ${view === v ? 'bg-ink text-paper' : 'text-ink-3'}`}>
          {v === 'CATEGORY' ? 'Category' : 'Step'}
        </button>
      ))}
    </span>
  )
}

function SectionHead({ label, sub, dot, id }: { label: string; sub: string; dot?: string; id?: string }) {
  return (
    <div id={id} className="flex items-baseline gap-2 px-4 pt-3.5 pb-1.5 scroll-mt-2">
      {dot && <span className={`w-2 h-2 rounded-full self-center ${dot}`} />}
      <span className="text-[13.5px] font-semibold text-ink">{label}</span>
      <span className="text-[12.5px] text-ink-3">{sub}</span>
    </div>
  )
}

export function PrepListPane({
  items, hidden, view, filter, onFilter, ctx, nowMin, ord, locked, canFixPar, showJump, compact = false, handlers, idPrefix,
}: {
  items: PrepItemRich[]
  hidden: PrepItemRich[]
  view: PrepView
  filter: PrepFilter
  onFilter: (f: PrepFilter) => void
  ctx: PlanDayContext | null
  nowMin: number
  ord: (t: PrepItemRich) => number
  locked: boolean
  canFixPar: boolean
  /** the category shortcut row (computer only) */
  showJump: boolean
  compact?: boolean
  handlers: Pick<PlannerHandlers, 'onOpen' | 'onAdd' | 'onRemove' | 'onFixPar'>
  /** keeps anchor ids unique while both renderers are mounted */
  idPrefix: string
}) {
  const [openFolds, setOpenFolds] = useState<Set<string>>(new Set())
  const shown = items.filter(t => matchesFilter(t, filter, ctx, nowMin))
  const row = (t: PrepItemRich) => (
    <PrepRow key={t.id} item={t} kind={rowKind(t, ctx, nowMin)} ctx={ctx} nowMin={nowMin} locked={locked}
      canFixPar={canFixPar} compact={compact}
      onOpen={handlers.onOpen} onAdd={handlers.onAdd} onRemove={handlers.onRemove} onFixPar={handlers.onFixPar} />
  )

  let body: React.ReactNode
  if (!shown.length) {
    body = <div className="py-12 text-center text-[13px] text-ink-3">{filter === 'ALL' ? 'No items match' : 'Nothing here right now'}</div>
  } else if (view === 'CATEGORY') {
    const secs = prepListSections(shown, { ctx, nowMin, ord })
    body = (
      <>
        {showJump && secs.length > 1 && (
          <div className="flex flex-wrap gap-0.5 px-3 py-2 border-b border-line text-[12.5px]">
            {secs.map(s => (
              <button key={s.key} type="button"
                onClick={() => document.getElementById(`${idPrefix}cat-${slug(s.key)}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })}
                className="min-h-[30px] px-2 rounded-[7px] text-ink-2 font-medium whitespace-nowrap hover:bg-bg-2">
                {shortCat(s.label)} <span className="font-mono text-[11.5px] text-ink-3">{s.rows.length}</span>
              </button>
            ))}
          </div>
        )}
        {secs.map(s => {
          const bits = [`${s.rows.length}`]
          if (s.toMake) bits.push(`${s.toMake} to make`)
          if (s.flagged) bits.push(`${s.flagged} need a par`)
          if (s.listed) bits.push(`${s.listed} on your list`)
          if (s.cooking) bits.push(`${s.cooking} cooking`)
          return (
            <div key={s.key}>
              <SectionHead id={`${idPrefix}cat-${slug(s.key)}`} label={s.label} sub={bits.join(' · ')} />
              {s.rows.map(row)}
            </div>
          )
        })}
      </>
    )
  } else {
    const flagged = shown.filter(t => parFlag(t) !== null && !t.isOnList && !t.pipeline)
    const rest = shown.filter(t => !flagged.includes(t))
    const groups = planGroups(rest, 'urgency', { ord, startToday: { ctx, nowMin } })
    body = (
      <>
        {groups.map(g => {
          const atPar = g.rows.filter(t => rowKind(t, ctx, nowMin) === 'ATPAR')
          const lead = g.rows.filter(t => !atPar.includes(t))
          const open = openFolds.has(g.key)
          const m = g.urg ? PLAN_URG_META[g.urg] : null
          return (
            <div key={g.key}>
              <SectionHead label={g.key === START_TODAY_KEY ? g.label : (m?.label ?? g.label)}
                sub={`${g.rows.length}${lead.length ? ` · ${lead.length} to act on` : ''}`}
                dot={g.key === START_TODAY_KEY ? 'bg-blue' : m?.dotClass} />
              {lead.map(row)}
              {open && atPar.map(row)}
              {atPar.length > 0 && (
                <button type="button"
                  onClick={() => setOpenFolds(prev => { const n = new Set(prev); if (n.has(g.key)) n.delete(g.key); else n.add(g.key); return n })}
                  className="flex items-center gap-2 w-full min-h-[40px] px-4 border-t border-dashed border-line-2 text-[12.5px] text-ink-3 text-left">
                  {open ? 'Hide' : '+'} <b className="font-semibold text-ink-2">{atPar.length} at par</b>
                  {!open && <span className="truncate">— {atPar.slice(0, 3).map(t => t.name).join(', ')}{atPar.length > 3 ? '…' : ''}</span>}
                  <span className="ml-auto font-semibold text-ink-2">{open ? '' : 'Show'}</span>
                </button>
              )}
            </div>
          )
        })}
        {flagged.length > 0 && (
          <div>
            <SectionHead label="Par to fix" sub={`${flagged.length} · never suggested until fixed`} dot="bg-red" />
            {flagged.map(row)}
          </div>
        )}
      </>
    )
  }

  return (
    <>
      {body}
      <div className="px-3 pb-3">
        <HiddenGroup hidden={hidden} locked={locked} onOpen={handlers.onOpen} />
      </div>
    </>
  )
}

export { filterCounts }
