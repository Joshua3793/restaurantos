'use client'
// Smart Prep — the suggestions pane body, shared by the desktop and mobile
// planners. Each group shows only the rows with something to do; everything
// at par (nothing to make, not on the list) folds into ONE closed "At par" row
// at the bottom — 38 of 57 rows were "at par" and buried the ones to make.
// Search still reaches them: a search that matches only at-par items opens it.
import { useState } from 'react'
import { ChevronDown, ChevronUp, CheckCircle2 } from 'lucide-react'
import type { PrepItemRich } from '@/components/prep/types'
import type { Cook } from '@/components/prep/runsheet/assignee'
import { planGroups, START_TODAY_KEY, type PlanDayContext } from '@/lib/prep-plan'
import { GroupHead } from './atoms'
import { SuggestionRow, suggestionQty } from './SuggestionRow'
import { HiddenGroup } from './HiddenGroup'

export function SuggestionList({ items, hidden, groupBy, stations, cooks, ord, ctx, nowMin, locked, searching = false, onOpen, onAdd, onRemove }: {
  items: PrepItemRich[]
  hidden: PrepItemRich[]
  groupBy: 'urgency' | 'station' | 'category'
  stations: string[]
  cooks: Cook[]
  ord: (t: PrepItemRich) => number
  ctx: PlanDayContext | null
  nowMin: number
  locked: boolean
  /** A search is narrowing the pool — the at-par rows then show inline. */
  searching?: boolean
  onOpen: (item: PrepItemRich) => void
  onAdd: (item: PrepItemRich) => void
  onRemove: (item: PrepItemRich) => void
}) {
  const [parOpen, setParOpen] = useState(false)
  const groups = planGroups(items, groupBy, { stations, crew: cooks, ord, startToday: { ctx, nowMin } })
  const atPar: PrepItemRich[] = []
  const shown = groups
    .map(g => {
      const longLead = g.key === START_TODAY_KEY
      const rows = g.rows.filter(t => {
        const fold = !searching && !t.isOnList && suggestionQty(t, longLead) <= 0
        if (fold) atPar.push(t)
        return !fold
      })
      return { ...g, rows, longLead }
    })
    .filter(g => g.rows.length > 0)

  return (
    <>
      {shown.map(g => (
        <div key={g.key}>
          <GroupHead g={g} count={g.rows.length} />
          <div className="flex flex-col gap-1.5">
            {g.rows.map(t => (
              <SuggestionRow key={t.id} item={t} locked={locked} longLead={g.longLead} onOpen={onOpen} onAdd={onAdd} onRemove={onRemove} />
            ))}
          </div>
        </div>
      ))}
      {atPar.length > 0 && (
        <div className="mt-4">
          <button type="button" onClick={() => setParOpen(o => !o)}
            className="flex items-center gap-2 w-full bg-paper border border-line rounded-[9px] px-3 py-2.5 text-left hover:border-line-2">
            <CheckCircle2 size={14} className="text-green shrink-0" />
            <span className="flex-1 min-w-0">
              <span className="block text-[12.5px] font-semibold text-ink">At par · {atPar.length}</span>
              <span className="block font-mono text-[9.5px] text-ink-4">Nothing to make — open to add one anyway</span>
            </span>
            {parOpen ? <ChevronUp size={14} className="text-ink-4" /> : <ChevronDown size={14} className="text-ink-4" />}
          </button>
          {parOpen && (
            <div className="flex flex-col gap-1.5 mt-1.5">
              {[...atPar].sort((a, b) => a.name.localeCompare(b.name)).map(t => (
                <SuggestionRow key={t.id} item={t} locked={locked} onOpen={onOpen} onAdd={onAdd} onRemove={onRemove} />
              ))}
            </div>
          )}
        </div>
      )}
      <HiddenGroup hidden={hidden} locked={locked} onOpen={onOpen} />
    </>
  )
}
