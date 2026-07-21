'use client'
import { useEffect, useState } from 'react'
import { ROLE_LABELS } from '@/lib/roles'
import { initials, relativeTime } from './people-utils'

interface AuditEvent {
  id: string
  actorName: string | null
  actorEmail: string
  action: string
  targetName: string | null
  targetEmail: string
  detail: Record<string, unknown> | null
  createdAt: string
}

const VERB: Record<string, string> = {
  INVITED: 'invited',
  REINVITED: 're-invited',
  INVITE_REVOKED: 'revoked the invite for',
  CLEARANCE_CHANGED: 'changed',
  ASSIGNMENT_ADDED: 'gave access to',
  ASSIGNMENT_REMOVED: 'removed access from',
  OVERRIDE_SET: 'added an override for',
  OVERRIDE_CLEARED: 'cleared an override for',
  DEACTIVATED: 'deactivated',
  REACTIVATED: 'reactivated',
  REMOVED: 'permanently removed',
}

/** Renders a role value with its label when it's a known role; falls back to
 *  the raw string otherwise (audit `detail` is untyped JSON, so a role field
 *  could in principle hold something else). */
function roleLabel(value: string | null | undefined): string {
  if (!value) return ''
  return (ROLE_LABELS as Partial<Record<string, string>>)[value] ?? value
}

function describe(e: AuditEvent): string {
  const d = (e.detail ?? {}) as Record<string, string | null>
  const place = d.rcName ?? d.locationName ?? null
  switch (e.action) {
    case 'CLEARANCE_CHANGED': return `from ${roleLabel(d.from)} → ${roleLabel(d.to)}`
    case 'INVITED':
    case 'REINVITED': return d.to ? `as ${roleLabel(d.to)}` : ''
    case 'OVERRIDE_SET': return place ? `${roleLabel(d.to)} at ${place}` : roleLabel(d.to)
    case 'OVERRIDE_CLEARED': return place ? `back to inherited at ${place}` : 'back to inherited'
    case 'ASSIGNMENT_ADDED':
    case 'ASSIGNMENT_REMOVED': return place ?? ''
    case 'DEACTIVATED': return 'revoked all access'
    default: return ''
  }
}

export default function AccessAuditPanel({ refreshKey }: { refreshKey: number }) {
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [days, setDays] = useState(30)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/settings/access-audit?days=${days}`, { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : { events: [] }))
      .then(d => { if (!cancelled) setEvents(d.events ?? []) })
      .catch(() => { if (!cancelled) setEvents([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [days, refreshKey])

  return (
    <div className="bg-paper border border-line rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-line">
        <h2 className="font-fraunces text-base font-semibold text-ink">Access audit</h2>
        <select
          value={days}
          onChange={e => setDays(Number(e.target.value))}
          className="text-[11px] font-mono text-ink-3 border border-line rounded-lg px-2.5 py-1 bg-paper"
        >
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={3650}>All time</option>
        </select>
      </div>

      {loading && <p className="px-5 py-6 text-[13px] text-ink-4">Loading…</p>}

      {!loading && events.length === 0 && (
        <p className="px-5 py-6 text-[13px] text-ink-4">
          No access changes in this window.
        </p>
      )}

      {events.map(e => (
        <div key={e.id} className="flex items-start gap-3 px-5 py-3 border-t border-bg-2">
          <span className="shrink-0 w-7 h-7 rounded-full bg-bg-2 grid place-items-center text-[10.5px] font-semibold text-ink-2 mt-0.5">
            {initials(e.actorName ?? e.actorEmail)}
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-[12.5px] leading-relaxed text-ink-2">
              <b className="text-ink">{e.actorName ?? e.actorEmail}</b>{' '}
              <span className="text-ink-3">{VERB[e.action] ?? e.action}</span>{' '}
              <b className="text-ink">{e.targetName ?? e.targetEmail}</b>
            </p>
            {describe(e) && <p className="text-[11.5px] text-ink-4 mt-0.5">{describe(e)}</p>}
          </div>
          <span className="shrink-0 text-[11px] text-ink-4 whitespace-nowrap">
            {relativeTime(e.createdAt)}
          </span>
        </div>
      ))}
    </div>
  )
}
