'use client'
import type { Person } from './people-utils'
import { atLeast, ROLE_COLORS, ROLE_LABELS } from '@/lib/roles'
import { initials, chipLabel, chipClearance } from './people-utils'

interface Props {
  person: Person
  isMe: boolean
  onOpen: (p: Person) => void
}

export default function PersonRow({ person, isMe, onOpen }: Props) {
  const unassigned = person.assignments.length === 0 && !atLeast(person.role, 'ADMIN')

  return (
    <button
      onClick={() => onOpen(person)}
      className={`w-full flex items-center gap-3 px-5 py-3 border-t border-bg-2 text-left hover:bg-bg transition-colors ${
        !person.isActive ? 'opacity-50' : ''
      }`}
    >
      <span className="shrink-0 w-9 h-9 rounded-full bg-gradient-to-br from-gold to-gold-2 grid place-items-center text-white text-xs font-semibold">
        {initials(person.name ?? person.email)}
      </span>

      <span className="shrink-0 w-[150px]">
        <span className="flex items-center gap-1.5">
          <span className="text-[13.5px] font-medium text-ink truncate">
            {person.name ?? person.email}
          </span>
          {isMe && (
            <span className="text-[9px] font-semibold bg-bg-2 text-ink-3 px-1.5 py-0.5 rounded-full">
              You
            </span>
          )}
        </span>
        <span className="block text-[11px] text-ink-4 truncate">{person.email}</span>
      </span>

      <span
        className={`shrink-0 w-24 text-center text-xs font-semibold px-2.5 py-1 rounded-full ${ROLE_COLORS[person.role]}`}
      >
        {ROLE_LABELS[person.role]}
      </span>

      <span className="flex-1 flex flex-wrap gap-1.5">
        {unassigned ? (
          <span className="text-[11px] bg-gold-soft text-gold-2 px-2 py-0.5 rounded-full">
            No assignments — sees all revenue centers
          </span>
        ) : atLeast(person.role, 'ADMIN') ? (
          <span className="text-[11px] bg-bg-2 text-ink-3 px-2 py-0.5 rounded-full">
            All locations
          </span>
        ) : (
          person.assignments.map(a => (
            <span
              key={a.id}
              className={`text-[11px] px-2 py-0.5 rounded-full ${
                a.clearance ? 'bg-gold-soft text-gold-2' : 'bg-bg-2 text-ink-3'
              }`}
              title={a.clearance ? `Override: ${ROLE_LABELS[chipClearance(person, a)]}` : 'Inherited'}
            >
              {chipLabel(person, a)}
            </span>
          ))
        )}
      </span>

      <span className="text-ink-4 text-[15px] px-1">⋯</span>
    </button>
  )
}
