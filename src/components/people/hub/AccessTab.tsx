'use client'
import type { Role } from '@prisma/client'
import { assignableLevels, atLeast, ROLE_COLORS, ROLE_DESCRIPTIONS, ROLE_DOT, ROLE_LABELS } from '@/lib/roles'
import { resolveEffective, type EffectiveEntry, type RcNode } from '@/lib/access-model'
import AssignmentEditor, { type AssignmentDraft } from '@/components/people/AssignmentEditor'
import type { LocationNode } from '@/components/people/people-utils'
import type { Person } from '@/lib/people'
import type { PeopleHubPayload } from '@/app/setup/users/page'
import { EmptyTab, SectionLabel, WarningNote, useSave } from './kit'
import { useState } from 'react'

/**
 * Live preview of effective access as the admin edits. Calls the SAME
 * resolveEffective() the server uses (src/lib/access-model.ts is the pure half,
 * importable from a client component) so the preview can never disagree with
 * what actually gets enforced.
 */
function effectivePreview(
  drafts: AssignmentDraft[], primary: Role, locations: LocationNode[],
): EffectiveEntry[] {
  const rcs: RcNode[] = locations.flatMap(l =>
    l.revenueCenters.map(rc => ({ id: rc.id, name: rc.name, locationId: l.id, locationName: l.name })),
  )
  return resolveEffective(primary, drafts, rcs)
}

interface Props {
  person: Person
  payload: PeopleHubPayload
  actorRole: Role
  isMe: boolean
  /** `nextKey` re-selects a person whose key changed (link/unlink). */
  onChanged: (nextKey?: string) => void
}

export default function AccessTab({ person, payload, actorRole, isMe, onChanged }: Props) {
  const login = person.login
  const [clearance, setClearance] = useState<Role>(login?.role ?? 'STAFF')
  const [drafts, setDrafts] = useState<AssignmentDraft[]>(
    (login?.assignments ?? []).map(a => ({
      locationId: a.revenueCenterId ? null : a.locationId,
      revenueCenterId: a.revenueCenterId,
      clearance: a.clearance,
    })),
  )
  const { busy, error, warning, save, Spinner } = useSave(onChanged)

  if (!login) {
    return (
      <EmptyTab
        title="No app login"
        body="This person is on the kitchen roster but cannot sign in. Link or invite an account on the Identity tab to give them access."
      />
    )
  }

  const isOwner = login.role === 'OWNER'
  const locked = isOwner || isMe
  const preview = effectivePreview(drafts, clearance, payload.locations)
  // src/lib/access.ts short-circuits OWNER/ADMIN to every revenue center
  // regardless of assignments — mirror that here, keyed off the SELECTED
  // clearance so the preview updates live as an admin edits.
  const previewIsGlobal = atLeast(clearance, 'ADMIN')

  const submit = () => save(async () => {
    if (clearance !== login.role) {
      const r = await fetch(`/api/settings/users/${login.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clearance }),
      })
      if (!r.ok) return r
    }
    return fetch(`/api/settings/users/${login.id}/assignments`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignments: drafts }),
    })
  })

  return (
    <div className="px-5 py-5 space-y-5">
      {isOwner && (
        <p className="text-[12.5px] text-ink-3 bg-bg-2 rounded-[10px] px-3 py-2.5 leading-relaxed">
          The owner’s login has access everywhere and its clearance cannot be changed.
        </p>
      )}
      {isMe && !isOwner && (
        <p className="text-[12.5px] text-ink-3 bg-bg-2 rounded-[10px] px-3 py-2.5 leading-relaxed">
          This is your own account. Ask another admin to change your clearance or assignments.
        </p>
      )}

      <div>
        <div className="flex items-center justify-between">
          <SectionLabel>Primary clearance</SectionLabel>
          {locked ? (
            <span className={`text-[12.5px] font-semibold px-3 py-1 rounded-full ${ROLE_COLORS[login.role]}`}>
              {ROLE_LABELS[login.role]}
            </span>
          ) : (
            <select
              value={clearance}
              onChange={e => setClearance(e.target.value as Role)}
              className={`text-[12.5px] font-semibold px-3 py-1 rounded-full border-0 cursor-pointer focus:outline-none focus:ring-2 focus:ring-gold ${ROLE_COLORS[clearance]}`}
            >
              {assignableLevels(actorRole).map(r => (
                <option key={r} value={r}>{ROLE_LABELS[r]}</option>
              ))}
            </select>
          )}
        </div>
        <p className="mt-2 text-[11.5px] text-ink-4 leading-relaxed">
          {ROLE_DESCRIPTIONS[locked ? login.role : clearance]}
        </p>
      </div>

      {!isOwner && (
        <div>
          <SectionLabel>Assignments</SectionLabel>
          <AssignmentEditor
            locations={payload.locations}
            value={drafts}
            primaryClearance={clearance}
            actorRole={actorRole}
            onChange={setDrafts}
          />
        </div>
      )}

      {!isOwner && (
        <div className="px-4 py-3.5 bg-bg border border-line rounded-lg">
          <SectionLabel>Effective access</SectionLabel>
          {previewIsGlobal ? (
            <p className="text-[12px] text-gold-2">
              {ROLE_LABELS[clearance]} clearance reaches every revenue center regardless of assignments.
            </p>
          ) : preview.length === 0 ? (
            <p className="text-[12px] text-gold-2">
              No assignments — this person currently sees all revenue centers.
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {preview.map(e => (
                <div key={e.rcId} className="flex items-center gap-2 text-[12px]">
                  <span className={`w-2 h-2 rounded-full ${ROLE_DOT[e.clearance]}`} />
                  <span className="text-ink-2">{e.rcName}</span>
                  <span className="text-ink-4">·</span>
                  <b className="text-ink">{ROLE_LABELS[e.clearance]}</b>
                  {e.source === 'override' && <span className="text-[10px] font-mono text-gold-2">override</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="flex gap-2 px-3 py-2.5 bg-red-soft border border-line rounded-[10px]">
          <span className="text-red-text">⚠</span>
          <p className="text-[12.5px] text-red-text leading-relaxed">{error}</p>
        </div>
      )}
      {warning && <WarningNote>{warning}</WarningNote>}

      {!locked && (
        <button
          onClick={submit}
          disabled={busy}
          className="w-full py-3 rounded-[10px] bg-ink text-white font-semibold text-sm disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {Spinner} Save access
        </button>
      )}
    </div>
  )
}
