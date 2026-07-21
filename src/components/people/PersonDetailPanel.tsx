'use client'
import { useState } from 'react'
import type { Role } from '@prisma/client'
import { X, Loader2, Pause, Trash2 } from 'lucide-react'
import { assignableLevels, atLeast, ROLE_LABELS, ROLE_COLORS, ROLE_DOT, ROLE_DESCRIPTIONS } from '@/lib/roles'
import { resolveEffective, type EffectiveEntry, type RcNode } from '@/lib/access-model'
import AssignmentEditor, { type AssignmentDraft } from './AssignmentEditor'
import { initials, summarizeAccess, type LocationNode, type Person } from './people-utils'

interface Props {
  person: Person
  locations: LocationNode[]
  actorRole: Role
  isMe: boolean
  onClose: () => void
  onChanged: () => void
}

/**
 * Live preview of effective access as the admin edits.
 *
 * Calls the SAME resolveEffective() the server uses (src/lib/access-model.ts is
 * the pure half, importable from a client component) so the preview can never
 * disagree with what actually gets enforced.
 */
function effectivePreview(
  drafts: AssignmentDraft[], primary: Role, locations: LocationNode[],
): EffectiveEntry[] {
  const rcs: RcNode[] = locations.flatMap(l =>
    l.revenueCenters.map(rc => ({
      id: rc.id, name: rc.name, locationId: l.id, locationName: l.name,
    })),
  )
  return resolveEffective(primary, drafts, rcs)
}

export default function PersonDetailPanel({
  person, locations, actorRole, isMe, onClose, onChanged,
}: Props) {
  const isOwner = person.role === 'OWNER'
  const [clearance, setClearance] = useState<Role>(person.role)
  const [drafts, setDrafts] = useState<AssignmentDraft[]>(
    person.assignments.map(a => ({
      locationId: a.revenueCenterId ? null : a.locationId,
      revenueCenterId: a.revenueCenterId,
      clearance: a.clearance,
    })),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmRemove, setConfirmRemove] = useState(false)

  const locked = isOwner || isMe
  const preview = effectivePreview(drafts, clearance, locations)
  // src/lib/access.ts short-circuits OWNER/ADMIN to every revenue center
  // regardless of assignments — resolveEffective()'s per-RC preview would
  // otherwise contradict the row's "All locations" summary for these two
  // clearances. Mirror that short-circuit here, keyed off the currently
  // selected clearance (not just person.role) so the preview updates live as
  // an admin edits.
  const previewIsGlobal = atLeast(clearance, 'ADMIN')

  const call = async (fn: () => Promise<Response>, ok?: () => void) => {
    setError(''); setBusy(true)
    try {
      const res = await fn()
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { setError(body.error ?? 'Something went wrong'); return }
      ok?.(); onChanged()
    } catch (e) {
      // A network rejection (offline, DNS blip) throws before any response
      // exists — without this catch, `busy` would stay true forever with no
      // escape short of closing and reopening the panel.
      setError(e instanceof Error ? e.message : 'Network error — could not reach the server')
    } finally {
      setBusy(false)
    }
  }

  const save = () =>
    call(async () => {
      if (clearance !== person.role) {
        const r = await fetch(`/api/settings/users/${person.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clearance }),
        })
        if (!r.ok) return r
      }
      return fetch(`/api/settings/users/${person.id}/assignments`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignments: drafts }),
      })
    }, onClose)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-ink/40" onClick={onClose} />
      <div className="relative bg-paper rounded-xl border border-line shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        {/* header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-line">
          <span className="shrink-0 w-11 h-11 rounded-full bg-gradient-to-br from-gold to-gold-2 grid place-items-center text-white font-semibold">
            {initials(person.name ?? person.email)}
          </span>
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-[15px] text-ink truncate">
              {person.name ?? person.email}
            </div>
            <div className="text-xs text-ink-4 truncate">{person.email}</div>
          </div>
          <span
            className={`text-[10px] font-semibold px-2.5 py-1 rounded-full ${
              person.isActive ? 'bg-green-soft text-green-text' : 'bg-bg-2 text-ink-3'
            }`}
          >
            {person.isActive ? 'Active' : 'Inactive'}
          </span>
          <button onClick={onClose} aria-label="Close" className="text-ink-4 hover:text-ink-2 ml-1"><X size={16} /></button>
        </div>

        <div className="px-5 py-4 space-y-5">
          {isOwner && (
            <p className="text-[12.5px] text-ink-3 bg-bg-2 rounded-[10px] px-3 py-2.5 leading-relaxed">
              The owner has access everywhere and cannot be changed, deactivated, or removed.
            </p>
          )}

          {/* primary clearance */}
          <div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono uppercase tracking-[0.1em] text-ink-4">
                Primary clearance
              </span>
              {locked ? (
                <span className={`text-[12.5px] font-semibold px-3 py-1 rounded-full ${ROLE_COLORS[person.role]}`}>
                  {ROLE_LABELS[person.role]}
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
              {ROLE_DESCRIPTIONS[locked ? person.role : clearance]}
            </p>
          </div>

          {/* assignments */}
          {!isOwner && (
            <div>
              <span className="block text-[10px] font-mono uppercase tracking-[0.1em] text-ink-4 mb-2">
                Assignments
              </span>
              <AssignmentEditor
                locations={locations}
                value={drafts}
                primaryClearance={clearance}
                actorRole={actorRole}
                onChange={setDrafts}
              />
            </div>
          )}

          {/* effective access */}
          {!isOwner && (
            <div className="px-4 py-3.5 bg-bg border border-line rounded-lg">
              <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-ink-4 mb-2.5">
                Effective access
              </div>
              {previewIsGlobal ? (
                <p className="text-[12px] text-gold-2">
                  {summarizeAccess({ ...person, role: clearance })} — {ROLE_LABELS[clearance]} clearance reaches every revenue center regardless of assignments.
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
                      {e.source === 'override' && (
                        <span className="text-[10px] font-mono text-gold-2">override</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="flex gap-2 px-3 py-2.5 bg-red-soft border border-red/20 rounded-[10px]">
              <span className="text-red-text">⚠</span>
              <p className="text-[12.5px] text-red-text leading-relaxed">{error}</p>
            </div>
          )}

          {!locked && (
            <button
              onClick={save}
              disabled={busy}
              className="w-full py-3 rounded-[10px] bg-ink text-white font-semibold text-sm disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {busy && <Loader2 size={14} className="animate-spin" />}
              Save changes
            </button>
          )}

          {/* T4 — deactivate vs remove */}
          {!locked && (
            <div className="pt-2 border-t border-bg-2 space-y-2">
              <p className="text-[11px] text-ink-4 pt-3">
                Two ways to revoke access — pick by whether they might return.
              </p>

              <button
                onClick={() =>
                  call(() =>
                    fetch(`/api/settings/users/${person.id}`, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ isActive: !person.isActive }),
                    }),
                  )
                }
                disabled={busy}
                className="w-full flex items-start gap-3 text-left border border-line rounded-lg px-3.5 py-3 hover:bg-bg disabled:opacity-50"
              >
                <Pause size={15} className="text-gold-2 mt-0.5 shrink-0" />
                <span className="flex-1">
                  <span className="flex items-center justify-between">
                    <b className="text-[13px] text-ink">
                      {person.isActive ? 'Deactivate' : 'Reactivate'}
                    </b>
                    <span className="text-[10px] font-mono text-green-text bg-green-soft px-2 py-0.5 rounded-full">
                      reversible
                    </span>
                  </span>
                  <span className="block text-[12px] text-ink-3 leading-relaxed mt-0.5">
                    {person.isActive
                      ? 'Loses access immediately. Account, assignments & history kept — reactivate anytime.'
                      : 'Restores access with their existing assignments.'}
                  </span>
                </span>
              </button>

              {confirmRemove ? (
                <div className="border border-red bg-red-soft rounded-lg px-3.5 py-3 space-y-2.5">
                  <div className="flex items-start gap-3">
                    <Trash2 size={15} className="text-red-text mt-0.5 shrink-0" />
                    <span className="flex-1">
                      <span className="flex items-center justify-between">
                        <b className="text-[13px] text-red-text">Remove permanently?</b>
                        <span className="text-[10px] font-mono text-red-text bg-red-soft px-2 py-0.5 rounded-full">
                          cannot undo
                        </span>
                      </span>
                      <span className="block text-[12px] text-ink-3 leading-relaxed mt-0.5">
                        Deletes the account and all assignments. Activity stays in the audit log.
                      </span>
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setConfirmRemove(false)}
                      disabled={busy}
                      className="flex-1 py-2 rounded-lg border border-line text-[12.5px] font-medium text-ink-2 hover:bg-bg disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() =>
                        call(() => fetch(`/api/settings/users/${person.id}`, { method: 'DELETE' }), onClose)
                      }
                      disabled={busy}
                      className="flex-1 py-2 rounded-lg bg-red text-white text-[12.5px] font-semibold disabled:opacity-50"
                    >
                      Confirm remove
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmRemove(true)}
                  disabled={busy}
                  className="w-full flex items-start gap-3 text-left border border-red/30 rounded-lg px-3.5 py-3 hover:bg-red-soft/40 disabled:opacity-50"
                >
                  <Trash2 size={15} className="text-red-text mt-0.5 shrink-0" />
                  <span className="flex-1">
                    <span className="flex items-center justify-between">
                      <b className="text-[13px] text-red-text">Remove permanently</b>
                      <span className="text-[10px] font-mono text-red-text bg-red-soft px-2 py-0.5 rounded-full">
                        cannot undo
                      </span>
                    </span>
                    <span className="block text-[12px] text-ink-3 leading-relaxed mt-0.5">
                      Deletes the account and all assignments. Activity stays in the audit log.
                    </span>
                  </span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
