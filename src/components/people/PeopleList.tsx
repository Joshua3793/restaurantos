'use client'
import { useMemo, useState } from 'react'
import type { Role } from '@prisma/client'
import { Search, Mail, X } from 'lucide-react'
import { ROLE_LABELS, ROLE_ORDER } from '@/lib/roles'
import PersonRow from './PersonRow'
import { groupByLocation, relativeTime, type LocationNode, type Person } from './people-utils'

interface Props {
  people: Person[]
  locations: LocationNode[]
  currentUserId: string | null
  onOpenPerson: (p: Person) => void
  onResend: (p: Person) => void
  onRevoke: (p: Person) => void
}

export default function PeopleList({
  people, locations, currentUserId, onOpenPerson, onResend, onRevoke,
}: Props) {
  const [query, setQuery] = useState('')
  const [locationFilter, setLocationFilter] = useState<string>('')
  const [levelFilter, setLevelFilter] = useState<string>('')

  const active = people.filter(p => !p.isPending)
  const pending = people.filter(p => p.isPending)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return active.filter(p => {
      if (q && !(p.name ?? '').toLowerCase().includes(q) && !p.email.toLowerCase().includes(q)) {
        return false
      }
      if (levelFilter && p.role !== levelFilter) return false
      if (locationFilter && !p.assignments.some(a => a.locationId === locationFilter)) return false
      return true
    })
  }, [active, query, levelFilter, locationFilter])

  const groups = useMemo(
    () => groupByLocation(filtered, locations),
    [filtered, locations],
  )

  return (
    <>
      {/* filters */}
      <div className="flex items-center gap-2 px-5 py-3 border-b border-bg-2 bg-bg">
        <div className="flex-1 flex items-center gap-2 bg-paper border border-line rounded-[9px] px-3 py-1.5">
          <Search size={13} className="text-ink-4" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search people…"
            className="flex-1 text-[13px] bg-transparent outline-none placeholder:text-ink-4"
          />
        </div>
        <select
          value={locationFilter}
          onChange={e => setLocationFilter(e.target.value)}
          className="text-[11px] font-mono px-3 py-1.5 border border-line rounded-[9px] bg-paper text-ink-2"
        >
          <option value="">All locations</option>
          {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <select
          value={levelFilter}
          onChange={e => setLevelFilter(e.target.value)}
          className="text-[11px] font-mono px-3 py-1.5 border border-line rounded-[9px] bg-paper text-ink-2"
        >
          <option value="">All levels</option>
          {ROLE_ORDER.map(r => <option key={r} value={r}>{ROLE_LABELS[r as Role]}</option>)}
        </select>
      </div>

      {/* grouped people */}
      {groups.map(({ location, people: rows }) => (
        <div key={location?.id ?? 'unassigned'}>
          <div className="flex items-center gap-2.5 px-5 pt-3 pb-2 bg-bg">
            <span
              className="w-5 h-5 rounded grid place-items-center text-white text-[11px]"
              style={{ backgroundColor: location?.color ?? '#a1a1aa' }}
            >
              ⌂
            </span>
            <span className="font-semibold text-[13px] text-ink">
              {location?.name ?? 'No location assigned'}
            </span>
            <span className="text-[10.5px] font-mono text-ink-4">
              {location ? `${location.revenueCenters.length} RCs · ` : ''}
              {rows.length} {rows.length === 1 ? 'person' : 'people'}
            </span>
          </div>
          {rows.map(p => (
            <PersonRow
              key={`${location?.id ?? 'none'}-${p.id}`}
              person={p}
              isMe={p.id === currentUserId}
              onOpen={onOpenPerson}
            />
          ))}
        </div>
      ))}

      {groups.length === 0 && (
        <p className="px-5 py-8 text-center text-[13px] text-ink-4">
          No one matches those filters.
        </p>
      )}

      {/* pending invites */}
      {pending.length > 0 && (
        <>
          <div className="px-5 pt-4 pb-2 bg-bg border-t border-bg-2">
            <span className="text-[10px] font-mono uppercase tracking-[0.1em] text-ink-4">
              Pending invites
            </span>
          </div>
          {pending.map(p => {
            const stale = Date.now() - new Date(p.createdAt).getTime() > 7 * 864e5
            return (
              <div key={p.id} className="flex items-center gap-3 px-5 py-3 border-t border-bg-2">
                <span
                  className={`shrink-0 w-[34px] h-[34px] rounded-full border-[1.5px] border-dashed grid place-items-center ${
                    stale ? 'border-red text-red' : 'border-line-2 text-ink-4'
                  }`}
                >
                  <Mail size={14} />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[13.5px] font-medium text-ink truncate">{p.email}</span>
                    <span
                      className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                        stale ? 'bg-red-soft text-red-text' : 'bg-gold-soft text-gold-2'
                      }`}
                    >
                      {stale ? 'Expired' : 'Pending'}
                    </span>
                  </div>
                  <div className="text-[11.5px] text-ink-4">
                    {ROLE_LABELS[p.role]} · invited {relativeTime(p.createdAt)}
                  </div>
                </div>
                <button
                  onClick={() => onResend(p)}
                  className={`text-[11px] font-mono px-2.5 py-1 rounded-lg ${
                    stale ? 'bg-ink text-white' : 'border border-line text-ink-3 hover:bg-bg'
                  }`}
                >
                  {stale ? 'Re-invite' : 'Resend'}
                </button>
                <button
                  onClick={() => onRevoke(p)}
                  title="Revoke invite"
                  className="text-ink-4 hover:text-red p-1"
                >
                  <X size={14} />
                </button>
              </div>
            )
          })}
        </>
      )}
    </>
  )
}
