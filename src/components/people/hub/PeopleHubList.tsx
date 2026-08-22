'use client'
import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import type { Person } from '@/lib/people'
import type { LocationNode } from '@/components/people/people-utils'
import PersonListRow from './PersonListRow'
import { applyFilter, groupPeople, HUB_FILTERS, type HubFilter } from './hub-utils'

interface Props {
  people: Person[]
  locations: LocationNode[]
  selectedKey: string | null
  currentUserId: string | null
  onSelect: (p: Person) => void
  onReorder: (ordered: Person[], moved: Person, direction: 'up' | 'down') => void
}

export default function PeopleHubList({
  people, locations, selectedKey, currentUserId, onSelect, onReorder,
}: Props) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<HubFilter>('all')

  const visible = useMemo(() => applyFilter(people, filter, query), [people, filter, query])
  const groups = useMemo(
    () => (filter === 'roster' ? null : groupPeople(visible, locations)),
    [visible, locations, filter],
  )

  const move = (p: Person, direction: 'up' | 'down') => onReorder(visible, p, direction)

  const row = (p: Person, index: number, list: Person[]) => (
    <PersonListRow
      key={p.key}
      person={p}
      selected={p.key === selectedKey}
      isMe={!!currentUserId && p.login?.id === currentUserId}
      showReorder={filter === 'roster'}
      canMoveUp={index > 0}
      canMoveDown={index < list.length - 1}
      onSelect={onSelect}
      onMove={move}
    />
  )

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 py-2.5 border-b border-line space-y-2">
        <div className="flex items-center gap-2 bg-bg border border-line rounded-[9px] px-2.5 py-1.5">
          <Search size={13} className="text-ink-4" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search name, email, clock #…"
            className="flex-1 min-w-0 text-[12.5px] bg-transparent outline-none placeholder:text-ink-4"
          />
        </div>
        <div className="flex gap-1 overflow-x-auto">
          {HUB_FILTERS.map(f => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`shrink-0 text-[11px] font-medium px-2.5 py-1 rounded-full ${
                filter === f.id ? 'bg-ink text-white' : 'bg-bg-2 text-ink-3 hover:bg-line'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {visible.length === 0 ? (
          <p className="px-4 py-8 text-center text-[12.5px] text-ink-4">Nobody matches that.</p>
        ) : groups ? (
          groups.map(g => (
            <div key={g.id}>
              <div className="px-3 py-1.5 bg-bg border-b border-bg-2 flex items-center justify-between">
                <span className="text-[10px] font-mono uppercase tracking-[0.1em] text-ink-4">{g.label}</span>
                {g.kind === 'unassigned' && (
                  <span className="text-[9px] text-gold-2">sees all RCs</span>
                )}
              </div>
              {g.people.map((p, i) => row(p, i, g.people))}
            </div>
          ))
        ) : (
          visible.map((p, i) => row(p, i, visible))
        )}
      </div>
    </div>
  )
}
