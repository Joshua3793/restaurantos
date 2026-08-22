'use client'
import { ChefHat, ChevronUp, ChevronDown, AlertTriangle } from 'lucide-react'
import { ROLE_COLORS, ROLE_LABELS } from '@/lib/roles'
import { displayName, personWarnings, type Person } from '@/lib/people'
import { initialsFor } from './hub-utils'

interface Props {
  person: Person
  selected: boolean
  isMe: boolean
  /** Reorder handles appear only in the Roster view, where sortOrder is meaningful. */
  showReorder: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  onSelect: (p: Person) => void
  onMove: (p: Person, direction: 'up' | 'down') => void
}

export default function PersonListRow({
  person, selected, isMe, showReorder, canMoveUp, canMoveDown, onSelect, onMove,
}: Props) {
  const dimmed =
    (person.login && !person.login.isActive && !person.login.isPending) ||
    (!person.login && person.roster && !person.roster.isActive)
  const warnings = personWarnings(person)
  const secondary = person.login?.email
    ?? [person.roster?.clockId ? `Clock #${person.roster.clockId}` : null, person.roster?.homeStation]
      .filter(Boolean).join(' · ')

  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 border-b border-bg-2 last:border-b-0 ${
        selected ? 'bg-gold-soft' : 'hover:bg-bg'
      } ${dimmed ? 'opacity-50' : ''}`}
    >
      <button onClick={() => onSelect(person)} className="flex-1 min-w-0 flex items-center gap-2.5 text-left">
        <span className="shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-gold to-gold-2 grid place-items-center text-white text-[11px] font-semibold">
          {initialsFor(person)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="text-[13px] font-medium text-ink truncate">{displayName(person)}</span>
            {isMe && (
              <span className="shrink-0 text-[9px] font-semibold bg-bg-2 text-ink-3 px-1.5 py-0.5 rounded-full">You</span>
            )}
            {person.roster && <ChefHat size={11} className="shrink-0 text-ink-4" />}
          </span>
          <span className="block text-[11px] text-ink-4 truncate">{secondary}</span>
        </span>
        <span className="shrink-0 flex flex-col items-end gap-1">
          {person.login?.isPending ? (
            <span className="text-[9px] font-semibold px-2 py-0.5 rounded-full bg-gold-soft text-gold-2">Pending</span>
          ) : person.login ? (
            <span className={`text-[9px] font-semibold px-2 py-0.5 rounded-full ${ROLE_COLORS[person.login.role]}`}>
              {ROLE_LABELS[person.login.role]}
            </span>
          ) : null}
          {person.roster && !person.roster.onTipPool && (
            <span className="text-[9px] font-mono px-2 py-0.5 rounded-full bg-bg-2 text-ink-3">off pool</span>
          )}
          {warnings.length > 0 && <AlertTriangle size={11} className="text-gold-2" />}
        </span>
      </button>

      {showReorder && (
        <span className="shrink-0 flex flex-col">
          <button
            onClick={() => onMove(person, 'up')}
            disabled={!canMoveUp}
            aria-label={`Move ${displayName(person)} earlier in the run sheet`}
            className="text-ink-4 hover:text-ink-2 disabled:opacity-25"
          >
            <ChevronUp size={13} />
          </button>
          <button
            onClick={() => onMove(person, 'down')}
            disabled={!canMoveDown}
            aria-label={`Move ${displayName(person)} later in the run sheet`}
            className="text-ink-4 hover:text-ink-2 disabled:opacity-25"
          >
            <ChevronDown size={13} />
          </button>
        </span>
      )}
    </div>
  )
}
