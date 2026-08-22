'use client'
import { useState } from 'react'
import type { Role } from '@prisma/client'
import type { Person } from '@/lib/people'
import { displayName } from '@/lib/people'
import type { PeopleHubPayload } from '@/app/setup/users/page'
import { initialsFor } from './hub-utils'
import IdentityTab from './IdentityTab'
import AccessTab from './AccessTab'
import PrepTab from './PrepTab'
import TipsTab from './TipsTab'

export type TabId = 'identity' | 'access' | 'prep' | 'tips'

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'identity', label: 'Identity' },
  { id: 'access', label: 'Access' },
  { id: 'prep', label: 'Prep' },
  { id: 'tips', label: 'Tips' },
]

interface Props {
  person: Person
  payload: PeopleHubPayload
  actorRole: Role
  isMe: boolean
  /** `nextKey` re-selects a person whose key changed (link/unlink). */
  onChanged: (nextKey?: string) => void
  /** `notice` is surfaced by the PAGE — this pane is unmounted by the call. */
  onCleared: (notice?: string) => void
}

export default function PersonDetail({ person, payload, actorRole, isMe, onChanged, onCleared }: Props) {
  const [tab, setTab] = useState<TabId>('identity')

  // A tab that does not apply stays VISIBLE but dimmed, with an empty state
  // inside — hiding it would reshuffle the strip as you arrow down the list.
  const applies: Record<TabId, boolean> = {
    identity: true,
    access: !!person.login,
    prep: !!person.roster,
    tips: !!person.roster,
  }

  const status = person.login?.isPending
    ? { label: 'Pending invite', cls: 'bg-gold-soft text-gold-2' }
    : person.login && !person.login.isActive
      ? { label: 'Inactive', cls: 'bg-bg-2 text-ink-3' }
      : !person.login && person.roster && !person.roster.isActive
        ? { label: 'Off roster', cls: 'bg-bg-2 text-ink-3' }
        : { label: 'Active', cls: 'bg-green-soft text-green-text' }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-line">
        <span className="shrink-0 w-11 h-11 rounded-full bg-gradient-to-br from-gold to-gold-2 grid place-items-center text-white font-semibold">
          {initialsFor(person)}
        </span>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-[15px] text-ink truncate">{displayName(person)}</div>
          <div className="text-xs text-ink-4 truncate">
            {person.login?.email ?? (person.roster?.clockId ? `Clock #${person.roster.clockId}` : 'No app login')}
          </div>
        </div>
        <span className={`shrink-0 text-[10px] font-semibold px-2.5 py-1 rounded-full ${status.cls}`}>
          {status.label}
        </span>
      </div>

      <div className="flex gap-1 px-3 pt-2 border-b border-line">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            // Applicability drives the dim INDEPENDENTLY of selection —
            // folding it into the non-active branch made a non-applicable tab
            // look perfectly normal the moment you clicked it, which is
            // precisely when the reader needs to know it does not apply.
            className={`px-3 py-2 text-[12.5px] font-medium border-b-2 -mb-px ${
              tab === t.id ? 'border-gold' : 'border-transparent hover:text-ink-2'
            } ${applies[t.id] ? (tab === t.id ? 'text-ink' : 'text-ink-3') : 'text-ink-4'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {tab === 'identity' && (
          <IdentityTab
            person={person}
            payload={payload}
            actorRole={actorRole}
            isMe={isMe}
            onChanged={onChanged}
            onCleared={onCleared}
          />
        )}
        {tab === 'access' && (
          <AccessTab
            person={person}
            payload={payload}
            actorRole={actorRole}
            isMe={isMe}
            onChanged={onChanged}
          />
        )}
        {tab === 'prep' && <PrepTab person={person} payload={payload} onChanged={onChanged} />}
        {tab === 'tips' && <TipsTab person={person} payload={payload} onChanged={onChanged} />}
      </div>
    </div>
  )
}
