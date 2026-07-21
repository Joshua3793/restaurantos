'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { UserPlus, Loader2, Smile } from 'lucide-react'
import { useUser } from '@/contexts/UserContext'
import PeopleList from '@/components/people/PeopleList'
import InviteModal from '@/components/people/InviteModal'
import PersonDetailPanel from '@/components/people/PersonDetailPanel'
import AccessAuditPanel from '@/components/people/AccessAuditPanel'
import type { LocationNode, Person } from '@/components/people/people-utils'

export default function PeopleAndAccessPage() {
  const { user } = useUser()
  const [people, setPeople] = useState<Person[]>([])
  const [locations, setLocations] = useState<LocationNode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [loadFailed, setLoadFailed] = useState(false)
  const [inviting, setInviting] = useState(false)
  const [selected, setSelected] = useState<Person | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  // Returns the freshly-fetched people list on success, or null on failure —
  // callers that need to re-sync against current data (see refresh() below)
  // must not assume `people` state has updated yet by the time they run.
  const load = useCallback(async (): Promise<Person[] | null> => {
    setError('')
    try {
      const res = await fetch('/api/settings/users', { cache: 'no-store' })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Failed (${res.status})`)
      const data = await res.json()
      const users: Person[] = data.users ?? []
      setPeople(users)
      setLocations(data.locations ?? [])
      setLoadFailed(false)
      return users
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load people')
      setLoadFailed(true)
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Re-syncs the open detail panel's `selected` person from the freshly
  // fetched list — otherwise Deactivate/Reactivate leaves the panel holding
  // the stale `person` prop it was opened with. Cleared entirely if the
  // person is no longer in the list (e.g. removed).
  const refresh = useCallback(async () => {
    const users = await load()
    setRefreshKey(k => k + 1)
    if (users) {
      setSelected(prev => (prev ? users.find(u => u.id === prev.id) ?? null : prev))
    }
  }, [load])

  const resend = async (p: Person) => {
    setError('')
    const res = await fetch(`/api/settings/users/${p.id}/resend`, { method: 'POST' })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      setError(body.error ?? `Failed to resend invite (${res.status})`)
      return
    }
    refresh()
  }
  const revoke = async (p: Person) => {
    setError('')
    const res = await fetch(`/api/settings/users/${p.id}`, { method: 'DELETE' })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      setError(body.error ?? `Failed to revoke invite (${res.status})`)
      return
    }
    refresh()
  }

  const pendingCount = people.filter(p => p.isPending).length
  const actorRole = user?.role ?? 'STAFF'

  if (loading) {
    return (
      <div className="p-6 flex items-center gap-2 text-ink-4">
        <Loader2 size={15} className="animate-spin" /> Loading people…
      </div>
    )
  }

  // T5 — empty state. Only genuine when the load actually succeeded: a failed
  // load also leaves `people` at [], and without the loadFailed guard that
  // reads as "this team is empty" underneath the error banner instead of
  // "we couldn't load your team".
  const isEmpty = !loadFailed && people.filter(p => p.id !== user?.id).length === 0

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="bg-paper border border-line rounded-xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-5 border-b border-line">
          <div>
            <h1 className="font-fraunces text-xl font-semibold text-ink">People &amp; Access</h1>
            <p className="text-[12.5px] text-ink-3 mt-0.5">
              {people.length} {people.length === 1 ? 'person' : 'people'} · {locations.length}{' '}
              {locations.length === 1 ? 'location' : 'locations'}
              {pendingCount > 0 && ` · ${pendingCount} pending invite${pendingCount > 1 ? 's' : ''}`}
            </p>
          </div>
          <button
            onClick={() => setInviting(true)}
            className="flex items-center gap-2 bg-ink text-white px-4 py-2.5 rounded-[10px] text-[13px] font-medium hover:bg-ink-2"
          >
            <UserPlus size={14} className="text-gold" /> Invite people
          </button>
        </div>

        {error && (
          <div className="px-5 py-3 bg-red-soft border-b border-line flex items-center justify-between gap-3">
            <p className="text-[12.5px] text-red-text">{error}</p>
            {loadFailed && (
              <button
                onClick={() => load()}
                className="shrink-0 text-[11.5px] font-semibold text-red-text underline hover:no-underline"
              >
                Retry
              </button>
            )}
          </div>
        )}

        {isEmpty ? (
          <div className="px-8 py-12 text-center">
            <div className="w-[60px] h-[60px] rounded-2xl bg-bg border border-line grid place-items-center mx-auto mb-5 text-ink-4">
              <Smile size={26} />
            </div>
            <h2 className="font-fraunces text-[19px] font-semibold text-ink mb-1.5">
              It&apos;s just you so far
            </h2>
            <p className="text-[13px] text-ink-3 leading-relaxed max-w-[300px] mx-auto mb-5">
              You&apos;re the <b>{actorRole === 'OWNER' ? 'Owner' : 'Admin'}</b>. Invite your managers
              and staff, and assign each of them to a location or revenue center.
            </p>
            <button
              onClick={() => setInviting(true)}
              className="px-5 py-2.5 rounded-[10px] bg-ink text-white font-semibold text-[13.5px]"
            >
              <span className="text-gold">+</span> Invite your first teammate
            </button>
            {locations.length === 0 && (
              <p className="mt-4 text-[11.5px] text-ink-4">
                No locations yet?{' '}
                <Link href="/setup/revenue-centers" className="text-gold-2 font-medium">
                  Set up a location first →
                </Link>
              </p>
            )}
          </div>
        ) : loadFailed && people.length === 0 ? (
          <div className="px-8 py-10 text-center">
            <p className="text-[13px] text-ink-3 mb-4">
              We couldn&apos;t load your team. Nothing shown below is a real count.
            </p>
            <button
              onClick={() => load()}
              className="px-4 py-2 rounded-[10px] border border-line text-[13px] font-medium text-ink-2 hover:bg-bg"
            >
              Retry
            </button>
          </div>
        ) : (
          <PeopleList
            people={people}
            locations={locations}
            currentUserId={user?.id ?? null}
            onOpenPerson={setSelected}
            onResend={resend}
            onRevoke={revoke}
          />
        )}
      </div>

      <AccessAuditPanel refreshKey={refreshKey} />

      {inviting && (
        <InviteModal
          locations={locations}
          actorRole={actorRole}
          onClose={() => setInviting(false)}
          onInvited={refresh}
        />
      )}

      {selected && (
        <PersonDetailPanel
          person={selected}
          locations={locations}
          actorRole={actorRole}
          isMe={selected.id === user?.id}
          onClose={() => setSelected(null)}
          onChanged={refresh}
        />
      )}
    </div>
  )
}
