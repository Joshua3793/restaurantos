'use client'
import { useState } from 'react'
import type { Role } from '@prisma/client'
import { Pause, Trash2, Link2, ChefHat, Mail } from 'lucide-react'
import type { Person } from '@/lib/people'
import { personWarnings, rosterFullName } from '@/lib/people'
import type { PeopleHubPayload } from '@/app/setup/users/page'
import { Field, SectionLabel, WarningNote, inputClass, useSave } from './kit'

interface Props {
  person: Person
  payload: PeopleHubPayload
  actorRole: Role
  isMe: boolean
  onChanged: () => void
  onCleared: () => void
}

export default function IdentityTab({ person, payload, isMe, onChanged, onCleared }: Props) {
  const { busy, error, warning, save, Spinner } = useSave(onChanged)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [linkTarget, setLinkTarget] = useState('')

  const isOwner = person.login?.role === 'OWNER'
  const locked = isOwner || isMe
  const warnings = personWarnings(person)

  // Active logins with no roster row of their own — the only valid link targets.
  const linkable = payload.people
    .filter(p => p.login && p.login.isActive && !p.login.isPending && !p.roster)
    .map(p => p.login!)

  const patchUser = (patch: Record<string, unknown>) =>
    save(() => fetch(`/api/settings/users/${person.login!.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    }))

  const patchCook = (patch: Record<string, unknown>) =>
    save(() => fetch(`/api/prep/cooks/${person.roster!.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    }))

  const linkLogin = (userId: string) =>
    save(() => fetch(`/api/tips/roster/${person.roster!.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: userId || null }),
    }))

  const addRoster = () =>
    save(async () => {
      // Cook.name is the SHORT FIRST NAME on prep run-sheet chips; the surname
      // lives in Cook.lastName. POST /api/prep/cooks has no lastName field, so
      // it is sent in the follow-up link PATCH below — same split as
      // POST /api/settings/people uses when it creates a roster row from a
      // full name. Skipping this drops the surname: the tip payout CSV export
      // (src/app/api/tips/periods/[id]/export/route.ts) emits name and
      // lastName as separate columns, so the person would export with a blank
      // surname.
      const source = person.login!.name ?? person.login!.email
      const [firstName, ...restOfName] = source.split(/\s+/)
      const lastName = restOfName.join(' ') || null

      const res = await fetch('/api/prep/cooks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: firstName,
          initials: source.slice(0, 2).toUpperCase(),
        }),
      })
      if (!res.ok) return res
      const cook = await res.json()
      // The link is a separate, deliberate step — /api/prep/cooks never sets it.
      return fetch(`/api/tips/roster/${cook.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: person.login!.id, lastName }),
      })
    })

  return (
    <div className="px-5 py-5 space-y-5">
      {isOwner && (
        <p className="text-[12.5px] text-ink-3 bg-bg-2 rounded-[10px] px-3 py-2.5 leading-relaxed">
          The owner has access everywhere and cannot be changed, deactivated, or removed.
        </p>
      )}
      {isMe && !isOwner && (
        <p className="text-[12.5px] text-ink-3 bg-bg-2 rounded-[10px] px-3 py-2.5 leading-relaxed">
          This is your own account. Ask another admin to change your clearance or status.
        </p>
      )}

      {warnings.map(w => <WarningNote key={w.code}>{w.message}</WarningNote>)}

      {/* names — shown side by side, never synced to each other */}
      <div className="grid gap-4 sm:grid-cols-2">
        {person.login && (
          <Field label="Account name" hint="Shown across the app and on the sign-in record.">
            <input
              defaultValue={person.login.name ?? ''}
              disabled={locked || busy}
              onBlur={e => e.target.value !== (person.login!.name ?? '') && patchUser({ name: e.target.value })}
              className={inputClass}
            />
          </Field>
        )}
        {person.roster && (
          <>
            <Field label="Roster name" hint="First name only — this is what shows on prep run-sheet chips.">
              <input
                defaultValue={person.roster.name}
                disabled={busy}
                onBlur={e => e.target.value.trim() && e.target.value !== person.roster!.name && patchCook({ name: e.target.value })}
                className={inputClass}
              />
            </Field>
            <Field label="Last name">
              <input
                defaultValue={person.roster.lastName ?? ''}
                disabled={busy}
                onBlur={e => e.target.value !== (person.roster!.lastName ?? '') &&
                  save(() => fetch(`/api/tips/roster/${person.roster!.id}`, {
                    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ lastName: e.target.value }),
                  }))}
                className={inputClass}
              />
            </Field>
            <Field label="Initials" hint="Avatar token on prep chips. Up to 3 characters.">
              <input
                defaultValue={person.roster.initials}
                disabled={busy}
                onBlur={e => e.target.value.trim() && e.target.value.toUpperCase() !== person.roster!.initials &&
                  patchCook({ initials: e.target.value })}
                className={`${inputClass} uppercase`}
              />
            </Field>
          </>
        )}
        {person.login && (
          <Field label="Email" hint="Read-only — this is the sign-in key.">
            <input value={person.login.email} readOnly className={`${inputClass} bg-bg text-ink-3`} />
          </Field>
        )}
      </div>

      {/* the link control — the point of the hub */}
      <div className="border border-line rounded-[10px] px-4 py-3.5 space-y-2.5">
        <SectionLabel>App login ↔ kitchen roster</SectionLabel>
        {person.login && person.roster ? (
          <p className="flex items-center gap-2 text-[12.5px] text-ink-2">
            <Link2 size={14} className="text-green-text" />
            Linked — <b>{person.login.email}</b> is <b>{rosterFullName(person.roster)}</b> on the roster.
          </p>
        ) : person.roster ? (
          <>
            <p className="text-[12.5px] text-ink-3 leading-relaxed">
              On the roster, but has no app login. Link an existing account — never guessed from a name.
            </p>
            <div className="flex gap-2">
              <select
                value={linkTarget}
                onChange={e => setLinkTarget(e.target.value)}
                disabled={busy}
                className={`${inputClass} flex-1`}
              >
                <option value="">Choose an account…</option>
                {linkable.map(u => (
                  <option key={u.id} value={u.id}>{u.name ?? u.email} — {u.email}</option>
                ))}
              </select>
              <button
                onClick={() => linkTarget && linkLogin(linkTarget)}
                disabled={busy || !linkTarget}
                className="px-3.5 py-2 rounded-lg bg-ink text-white text-[12.5px] font-semibold disabled:opacity-50"
              >
                Link
              </button>
            </div>
            {linkable.length === 0 && (
              <p className="flex items-center gap-1.5 text-[11.5px] text-ink-4">
                <Mail size={12} /> No unlinked accounts. Invite one with “Add person”.
              </p>
            )}
          </>
        ) : (
          <>
            <p className="text-[12.5px] text-ink-3 leading-relaxed">
              Has a login but is not on the kitchen roster — they cannot be assigned prep or paid tips.
            </p>
            <button
              onClick={addRoster}
              disabled={busy}
              className="flex items-center gap-2 px-3.5 py-2 rounded-lg border border-line text-[12.5px] font-medium text-ink-2 hover:bg-bg disabled:opacity-50"
            >
              <ChefHat size={14} className="text-gold-2" /> Put them on the kitchen roster
            </button>
          </>
        )}
        {person.login && person.roster && (
          <button
            onClick={() => linkLogin('')}
            disabled={busy}
            className="text-[11.5px] text-ink-4 underline hover:no-underline disabled:opacity-50"
          >
            Unlink
          </button>
        )}
      </div>

      {error && (
        <div className="flex gap-2 px-3 py-2.5 bg-red-soft border border-line rounded-[10px]">
          <span className="text-red-text">⚠</span>
          <p className="text-[12.5px] text-red-text leading-relaxed">{error}</p>
        </div>
      )}
      {warning && <WarningNote>{warning}</WarningNote>}

      {/* revoke access */}
      {!locked && (
        <div className="pt-2 border-t border-bg-2 space-y-2">
          <p className="text-[11px] text-ink-4 pt-3">Two ways to revoke access — pick by whether they might return.</p>

          {person.login && (
            <button
              onClick={() => patchUser({ isActive: !person.login!.isActive })}
              disabled={busy}
              className="w-full flex items-start gap-3 text-left border border-line rounded-lg px-3.5 py-3 hover:bg-bg disabled:opacity-50"
            >
              <Pause size={15} className="text-gold-2 mt-0.5 shrink-0" />
              <span className="flex-1">
                <span className="flex items-center justify-between">
                  <b className="text-[13px] text-ink">{person.login.isActive ? 'Deactivate login' : 'Reactivate login'}</b>
                  <span className="text-[10px] font-mono text-green-text bg-green-soft px-2 py-0.5 rounded-full">reversible</span>
                </span>
                <span className="block text-[12px] text-ink-3 leading-relaxed mt-0.5">
                  {person.login.isActive
                    ? 'Loses access immediately. Account, assignments & history kept.'
                    : 'Restores access with their existing assignments.'}
                </span>
              </span>
            </button>
          )}

          {person.roster && (
            <button
              onClick={() => patchCook({ isActive: !person.roster!.isActive })}
              disabled={busy}
              className="w-full flex items-start gap-3 text-left border border-line rounded-lg px-3.5 py-3 hover:bg-bg disabled:opacity-50"
            >
              <ChefHat size={15} className="text-gold-2 mt-0.5 shrink-0" />
              <span className="flex-1">
                <span className="flex items-center justify-between">
                  <b className="text-[13px] text-ink">
                    {person.roster.isActive ? 'Take off the kitchen roster' : 'Put back on the kitchen roster'}
                  </b>
                  <span className="text-[10px] font-mono text-green-text bg-green-soft px-2 py-0.5 rounded-full">reversible</span>
                </span>
                <span className="block text-[12px] text-ink-3 leading-relaxed mt-0.5">
                  {person.roster.isActive
                    ? 'Disappears from prep assignment lists. Tip history is kept.'
                    : 'Reappears on prep assignment lists.'}
                </span>
              </span>
            </button>
          )}

          {confirmRemove ? (
            <div className="border border-red bg-red-soft rounded-lg px-3.5 py-3 space-y-2.5">
              <div className="flex items-start gap-3">
                <Trash2 size={15} className="text-red-text mt-0.5 shrink-0" />
                <span className="flex-1">
                  <b className="block text-[13px] text-red-text">Remove permanently?</b>
                  <span className="block text-[12px] text-ink-3 leading-relaxed mt-0.5">
                    {person.login
                      ? 'Deletes the account and all assignments. Activity stays in the audit log.'
                      : 'Deletes the roster row. Past prep assignments stop resolving to a name.'}
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
                  onClick={() => save(
                    () => person.login
                      ? fetch(`/api/settings/users/${person.login.id}`, { method: 'DELETE' })
                      : fetch(`/api/prep/cooks/${person.roster!.id}`, { method: 'DELETE' }),
                    onCleared,
                  )}
                  disabled={busy}
                  className="flex-1 py-2 rounded-lg bg-red text-white text-[12.5px] font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {Spinner} Confirm remove
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setConfirmRemove(true)}
              disabled={busy}
              className="w-full flex items-center justify-between gap-3 border border-red/30 rounded-lg px-3.5 py-3 hover:bg-red-soft/40 disabled:opacity-50"
            >
              <span className="flex items-center gap-3">
                <Trash2 size={15} className="text-red-text" />
                <b className="text-[13px] text-red-text">Remove permanently</b>
              </span>
              <span className="text-[10px] font-mono text-red-text bg-red-soft px-2 py-0.5 rounded-full">cannot undo</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
