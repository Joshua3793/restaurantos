'use client'
// Smart Prep — the suggestions pane body, shared by the desktop and mobile
// planners. Every item stays in its own group (station, category, step) — at-par
// rows (nothing to make, not on the list) are never hidden; they sit after the
// rows to make in the same group and say "at par". The chef asked to see the
// whole category, not a fold at the bottom.
import type { PrepItemRich } from '@/components/prep/types'
import type { Cook } from '@/components/prep/runsheet/assignee'
import { planGroups, START_TODAY_KEY, type PlanDayContext } from '@/lib/prep-plan'
import { GroupHead } from './atoms'
import { SuggestionRow, suggestionQty } from './SuggestionRow'
import { HiddenGroup } from './HiddenGroup'

export function SuggestionList({ items, hidden, groupBy, stations, cooks, ord, ctx, nowMin, locked, onOpen, onAdd, onRemove }: {
  items: PrepItemRich[]
  hidden: PrepItemRich[]
  groupBy: 'urgency' | 'station' | 'category'
  stations: string[]
  cooks: Cook[]
  ord: (t: PrepItemRich) => number
  ctx: PlanDayContext | null
  nowMin: number
  locked: boolean
  onOpen: (item: PrepItemRich) => void
  onAdd: (item: PrepItemRich) => void
  onRemove: (item: PrepItemRich) => void
}) {
  const groups = planGroups(items, groupBy, { stations, crew: cooks, ord, startToday: { ctx, nowMin } })
  const shown = groups
    .map(g => {
      const longLead = g.key === START_TODAY_KEY
      const atPar = (t: PrepItemRich) => !t.isOnList && suggestionQty(t, longLead) <= 0
      // Rows to make first, at-par rows after — each keeps the group's order.
      const rows = [...g.rows.filter(t => !atPar(t)), ...g.rows.filter(atPar)]
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
      <HiddenGroup hidden={hidden} locked={locked} onOpen={onOpen} />
    </>
  )
}
