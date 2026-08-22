'use client'
import { useCallback, useEffect, useState } from 'react'
import { UserPlus, Loader2, ArrowLeft } from 'lucide-react'
import { useUser } from '@/contexts/UserContext'
import type { Person } from '@/lib/people'
import type { LocationNode } from '@/components/people/people-utils'
import PeopleHubList from '@/components/people/hub/PeopleHubList'
import PersonDetail from '@/components/people/hub/PersonDetail'
import { reorderPatches } from '@/components/people/hub/hub-utils'
import AccessAuditPanel from '@/components/people/AccessAuditPanel'

export interface TipRoleOption {
  id: string
  name: string
  multiplier: number
  sortOrder: number
}

export interface PeopleHubPayload {
  people: Person[]
  locations: LocationNode[]
  tipRoles: TipRoleOption[]
  stations: string[]
}

export default function PeopleHubPage() {
  const { user } = useUser()
  const [data, setData] = useState<PeopleHubPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  // Lives on the PAGE, not in the detail pane, so it survives the pane
  // unmounting — a delete clears the selection, and a warning rendered inside
  // the pane would be destroyed before it ever painted.
  const [notice, setNotice] = useState('')

  const load = useCallback(async (): Promise<PeopleHubPayload | null> => {
    setError('')
    try {
      const res = await fetch('/api/settings/people', { cache: 'no-store' })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Failed (${res.status})`)
      const body: PeopleHubPayload = await res.json()
      setData(body)
      return body
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load people')
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  /**
   * Reload and re-settle the selection in ONE pass.
   *
   * `nextKey` is how a link/unlink keeps the pane open: `Person.key` is
   * `cook:<cookId>` while unlinked and `<userId>` once linked, so after a
   * successful link the old key matches nobody and the pane would collapse to
   * the empty state (on mobile, bounce back to the list) exactly when the
   * hub's headline action succeeds. Applying the new key against the freshly
   * loaded body — rather than setting it before the fetch resolves — means the
   * selection is never momentarily unresolvable.
   */
  const refresh = useCallback(async (nextKey?: string) => {
    const body = await load()
    setRefreshKey(k => k + 1)
    // Clear the selection if that person is gone (removed), otherwise the
    // detail pane keeps rendering a row that no longer exists.
    if (body) setSelectedKey(prev => {
      const want = nextKey ?? prev
      return want && body.people.some(p => p.key === want) ? want : null
    })
  }, [load])

  /**
   * Run-sheet reorder. The index maths run over the FULL roster (see
   * `reorderPatches`) — never the filtered/searched view, which would renumber
   * matched cooks to 0,1,… and collide with cooks who are off-screen.
   */
  const reorder = async (moved: Person, direction: 'up' | 'down') => {
    const patches = reorderPatches((data?.people ?? []).filter(p => p.roster), moved, direction)
    if (patches.length === 0) return

    try {
      const results = await Promise.all(patches.map(({ cookId, sortOrder }) =>
        fetch(`/api/prep/cooks/${cookId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sortOrder }),
        }),
      ))
      if (results.some(r => !r.ok)) setError('Failed to reorder')
    } catch {
      // A thrown fetch (offline, DNS) must surface the same banner as a non-ok
      // response — otherwise it is a silent unhandled rejection.
      setError('Failed to reorder')
    }
    await refresh()
  }

  if (loading) {
    return (
      <div className="p-6 flex items-center gap-2 text-ink-4">
        <Loader2 size={15} className="animate-spin" /> Loading people…
      </div>
    )
  }

  const people = data?.people ?? []
  const selected = people.find(p => p.key === selectedKey) ?? null
  const rosterCount = people.filter(p => p.roster).length
  const loginCount = people.filter(p => p.login).length

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="font-fraunces text-xl font-semibold text-ink">People</h1>
          <p className="text-[12.5px] text-ink-3 mt-0.5">
            {people.length} {people.length === 1 ? 'person' : 'people'} · {loginCount} with a login · {rosterCount} on the roster
          </p>
        </div>
        <button
          onClick={() => { /* wired in Task 10 */ }}
          className="flex items-center gap-2 bg-ink text-white px-4 py-2.5 rounded-[10px] text-[13px] font-medium hover:bg-ink-2"
        >
          <UserPlus size={14} className="text-gold" /> Add person
        </button>
      </div>

      {error && (
        <div className="px-4 py-3 bg-red-soft border border-line rounded-[10px] flex items-center justify-between gap-3">
          <p className="text-[12.5px] text-red-text">{error}</p>
          <button onClick={() => load()} className="shrink-0 text-[11.5px] font-semibold text-red-text underline hover:no-underline">
            Retry
          </button>
        </div>
      )}

      {notice && (
        <div className="px-4 py-3 bg-gold-soft rounded-[10px] flex items-start justify-between gap-3">
          <p className="text-[12.5px] text-ink-2 leading-relaxed">{notice}</p>
          <button
            onClick={() => setNotice('')}
            className="shrink-0 text-[11.5px] font-semibold text-ink-3 underline hover:no-underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Master–detail. Below md: the list IS the page and selecting swaps to
          the detail — both panes are mounted, CSS decides which is visible. */}
      <div className="bg-paper border border-line rounded-xl overflow-hidden md:flex md:h-[calc(100vh-260px)] md:min-h-[420px]">
        <div className={`md:w-[320px] md:shrink-0 md:border-r md:border-line ${selected ? 'hidden md:block' : 'block'}`}>
          <PeopleHubList
            people={people}
            locations={data?.locations ?? []}
            selectedKey={selectedKey}
            currentUserId={user?.id ?? null}
            onSelect={p => { setNotice(''); setSelectedKey(p.key) }}
            onReorder={reorder}
          />
        </div>

        <div className={`flex-1 min-w-0 ${selected ? 'block' : 'hidden md:block'}`}>
          {selected ? (
            <div className="h-full flex flex-col min-h-0">
              <button
                onClick={() => setSelectedKey(null)}
                className="md:hidden flex items-center gap-1.5 px-4 py-3 border-b border-line text-[12.5px] text-ink-3"
              >
                <ArrowLeft size={14} /> All people
              </button>
              {/* `key` is load-bearing, not a list hint: without it React
                  reuses the pane's state and DOM across a person switch, so an
                  armed "Remove permanently" confirm, a chosen link target, the
                  active tab and every uncontrolled name input carry the
                  PREVIOUS person's values onto the next one. */}
              <PersonDetail
                key={selected.key}
                person={selected}
                payload={data!}
                actorRole={user?.role ?? 'STAFF'}
                isMe={!!user?.id && selected.login?.id === user.id}
                onChanged={refresh}
                onCleared={msg => { setSelectedKey(null); setNotice(msg ?? '') }}
              />
            </div>
          ) : (
            <div className="hidden md:grid h-full place-items-center px-8 text-center">
              <p className="text-[13px] text-ink-4 max-w-[280px] leading-relaxed">
                Select someone to manage their login, access, prep roster and tip payout.
              </p>
            </div>
          )}
        </div>
      </div>

      <AccessAuditPanel refreshKey={refreshKey} />
    </div>
  )
}
