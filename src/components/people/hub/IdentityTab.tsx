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
  /** `nextKey` re-selects a person whose key changed (link/unlink). */
  onChanged: (nextKey?: string) => void
  /** `notice` is surfaced by the PAGE — this pane is unmounted by the call. */
  onCleared: (notice?: string) => void
}

export default function IdentityTab({ person, payload, isMe, onChanged, onCleared }: Props) {
  const { busy, error, warning, setError, save, Spinner } = useSave(onChanged)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [linkTarget, setLinkTarget] = useState('')
  /**
   * Only used when the login carries NO name of its own — see `rosterNameSource`.
   * An invite can be sent without a name, so `User.name` is genuinely null for a
   * pending or freshly-accepted account.
   */
  const [rosterNameDraft, setRosterNameDraft] = useState('')

  const isOwner = person.login?.role === 'OWNER'
  /**
   * The LOGIN half only. PATCH /api/settings/users/[id] rejects a self-edit
   * (400) and an OWNER edit (403), so those controls are disabled up front.
   * The ROSTER half is deliberately NOT covered: PATCH /api/prep/cooks/[id]
   * accepts both, and a chef's run-sheet chip is not an access control.
   */
  const loginLocked = isOwner || isMe
  const warnings = personWarnings(person)

  // Active logins with no roster row of their own — the only valid link targets.
  const linkableLogins = payload.people
    .filter(p => p.login && p.login.isActive && !p.login.isPending && !p.roster)
    .map(p => p.login!)

  // The mirror image: active roster rows with no login of their own. `!p.login`
  // IS the unlinked test — a Cook with a userId is projected onto its login's
  // Person, never as a roster-only one. Same shape of filter as the picker
  // above, so every option offered is one the server will actually accept.
  const linkableRosters = payload.people
    .filter(p => p.roster && p.roster.isActive && !p.login)
    .map(p => p.roster!)

  // PATCH /api/tips/roster/[id] refuses a userId that is not an ACTIVE user
  // (400). Blocking here is what stops a doomed link from stranding a Cook.
  const loginLinkable = !!person.login?.isActive

  /**
   * The name a NEW roster row is built from.
   *
   * `Cook.name` is the short first name printed on prep run-sheet chips and
   * exported as the first-name column of the tip payout CSV; `Cook.lastName` is
   * the surname column. An email address is not a name and must never become
   * either — an invite sent without a name leaves `User.name === null`, and
   * falling back to the email put "mia.chen@example.com" on the chip and in the
   * payroll export. When there is no account name, the admin types one.
   */
  const loginName = person.login?.name?.trim() ?? ''
  const rosterNameSource = loginName || rosterNameDraft.trim()

  const patchUser = (patch: Record<string, unknown>) =>
    save(() => fetch(`/api/settings/users/${person.login!.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    }))

  const patchCook = (patch: Record<string, unknown>) =>
    save(() => fetch(`/api/prep/cooks/${person.roster!.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    }))

  /**
   * Link (or, with an empty id, unlink) this roster row.
   *
   * `nextKey` is the point: `Person.key` is `cook:<cookId>` while unlinked and
   * `<userId>` once linked, so without it a successful link leaves the page
   * hunting for a key nobody has and the pane closes on the admin.
   */
  const linkLogin = (userId: string) =>
    save(
      () => fetch(`/api/tips/roster/${person.roster!.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: userId || null }),
      }),
      { nextKey: userId || person.login?.id || `cook:${person.roster!.id}` },
    )

  /**
   * The same link, driven from the login side. The person's key is already
   * `login.id` and stays `login.id`, so there is no key to carry over.
   *
   * This exists so a login-only person can be attached to the roster row they
   * ALREADY have. Offering only "create a new one" guarantees a duplicate Cook
   * for anyone who was on the roster before they got an account — which splits
   * their prep assignments and puts them on the tip pool twice.
   */
  const linkExistingRoster = (cookId: string) =>
    save(() => fetch(`/api/tips/roster/${cookId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: person.login!.id }),
    }))

  /**
   * Re-send a pending invite.
   *
   * The route re-keys the account: a re-invite mints a NEW Supabase auth UUID
   * and POST /api/settings/users/[id]/resend deletes and recreates the Prisma
   * row on it. So this person's `Person.key` (their user id) changes and the
   * old one resolves to nobody — there is no `nextKey` to pass, because the new
   * id is not in the response. Close the pane deliberately and put the outcome
   * on the PAGE notice, which survives the unmount; a message set in local
   * state here would be destroyed before it painted.
   */
  const resendInvite = () =>
    save(
      () => fetch(`/api/settings/users/${person.login!.id}/resend`, { method: 'POST' }),
      {
        after: routeWarning => onCleared(
          routeWarning
            ?? `A fresh invite is on its way to ${person.login!.email}. Their account record was re-issued, `
              + 'so open them again from the list if you need to change anything.',
        ),
      },
    )

  /**
   * Put a login-only person on the kitchen roster.
   *
   * Routed through POST /api/settings/people, NOT POST /api/prep/cooks. That
   * other route defaults `sortOrder` to 0 — dropping the new cook at the TOP of
   * the prep run sheet, tied with whoever is already there — and leaves
   * `dailyHourCap` null, i.e. UNCAPPED, so the person is paid tips on every
   * hour the clock reports rather than the hours their contract covers.
   * /api/settings/people is the ONE implementation of both defaults
   * (`sortOrder: cook.count()`, `dailyHourCap` from
   * `TipSettings.defaultDailyHourCap`). Same ADMIN gate either way.
   *
   * Only the ROSTER half is sent: this person already has a login, and the two
   * halves are joined by the explicit PATCH below. `initials` is omitted so the
   * shared rule (`deriveInitials`) runs server-side.
   */
  const addRoster = () =>
    save(async () => {
      const fullName = rosterNameSource
      if (!fullName) {
        return new Response(
          JSON.stringify({ error: 'Type this person’s full name before putting them on the kitchen roster.' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        )
      }
      // The server splits the name exactly this way when it builds the Cook.
      // The copy here exists only so the link PATCH can restate lastName and
      // the failure message below can name the row that was created.
      const [firstName, ...restOfName] = fullName.split(/\s+/)
      const lastName = restOfName.join(' ') || null

      const res = await fetch('/api/settings/people', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: fullName, roster: {} }),
      })
      if (!res.ok) return res
      const { cookId } = await res.json() as { cookId: string | null }
      if (!cookId) {
        return new Response(
          JSON.stringify({
            error: 'The server did not return a roster row. Reload the People list and check whether one was '
              + 'created before using this button again.',
          }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        )
      }

      // The link is a separate, deliberate step — /api/settings/people joins
      // the two halves only when it creates BOTH in one request.
      const linked = await fetch(`/api/tips/roster/${cookId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: person.login!.id, lastName }),
      }).catch(() => null)
      if (linked?.ok) return linked

      // From the POST onwards the Cook row is REAL. If the link fails it is an
      // unlinked roster row with no clockId and onTipPool defaulting to true —
      // and nothing on this (login-only) side of the hub would ever show it.
      // Reloading is what makes it visible as a roster-only person; deleting it
      // silently is not an option (this codebase never destroys roster history
      // behind the admin's back), and leaving the admin with a generic error
      // and the same button is how the second duplicate gets minted.
      const reason = linked
        ? (await linked.json().catch(() => ({}))).error ?? `the server returned ${linked.status}`
        : 'the server could not be reached'
      onChanged()
      return new Response(
        JSON.stringify({
          error: `The roster row for "${firstName}" was created, but linking it to this login failed — ${reason}. `
            + 'It is now in the people list as a roster row with no login: open that row to link or remove it. '
            + 'Do not use this button again — it would create a second roster row.',
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      )
    })

  return (
    <div className="px-5 py-5 space-y-5">
      {isOwner && (
        <p className="text-[12.5px] text-ink-3 bg-bg-2 rounded-[10px] px-3 py-2.5 leading-relaxed">
          The owner’s login has access everywhere and cannot be renamed, deactivated, or removed.
          Their kitchen roster details can still be edited.
        </p>
      )}
      {isMe && !isOwner && (
        <p className="text-[12.5px] text-ink-3 bg-bg-2 rounded-[10px] px-3 py-2.5 leading-relaxed">
          This is your own account. Ask another admin to change your account name, clearance or status.
          Your kitchen roster details are yours to edit.
        </p>
      )}

      {warnings.map(w => <WarningNote key={w.code}>{w.message}</WarningNote>)}

      {/* names — shown side by side, never synced to each other */}
      <div className="grid gap-4 sm:grid-cols-2">
        {person.login && (
          <Field label="Account name" hint="Shown across the app and on the sign-in record.">
            <input
              defaultValue={person.login.name ?? ''}
              disabled={loginLocked || busy}
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
                onBlur={e => {
                  const next = e.target.value.trim()
                  if (next === person.roster!.name) return
                  // The route rejects an empty name (400) and the old guard
                  // swallowed the blur entirely, so clearing the field looked
                  // like it had saved. Say so, and put the real value back.
                  if (!next) {
                    setError('Roster name cannot be empty — it is the chip label on the prep run sheet.')
                    e.target.value = person.roster!.name
                    return
                  }
                  patchCook({ name: next })
                }}
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
                // The server truncates to 3 (normalizeInitials). Without this
                // the DOM keeps a 4th character forever, so the stored value
                // never matches what is typed and EVERY blur re-PATCHes.
                maxLength={3}
                defaultValue={person.roster.initials}
                disabled={busy}
                onBlur={e => {
                  const next = e.target.value.trim().toUpperCase()
                  if (next === person.roster!.initials) return
                  if (!next) {
                    setError('Initials cannot be empty — they are the avatar token on prep chips.')
                    e.target.value = person.roster!.initials
                    return
                  }
                  patchCook({ initials: next })
                }}
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

      {/* Pending invite. `isPending` is `!isActive && name === null`
          (GET /api/settings/people): the Prisma row is created inactive at
          invite time and flipped active by /auth/callback on accept, so this is
          an invite that has never been accepted — not a deactivation. Without
          this action the ONLY way to re-send a bounced or expired invite was
          "Invite several people", re-typing their clearance and every
          assignment. POST /api/settings/users/[id]/resend refuses an account
          that already accepted (400 — they should use "Forgot password"). */}
      {person.login?.isPending && (
        <div className="border border-line rounded-[10px] px-4 py-3.5 space-y-2.5">
          <SectionLabel>Invite</SectionLabel>
          <p className="text-[12.5px] text-ink-3 leading-relaxed">
            Invited, but they have not set a password yet. Re-send if the email bounced or the link
            expired — it replaces the pending invite with a fresh one and keeps their clearance and
            assignments exactly as they are.
          </p>
          <button
            onClick={resendInvite}
            disabled={busy}
            className="flex items-center gap-2 px-3.5 py-2 rounded-lg border border-line text-[12.5px] font-medium text-ink-2 hover:bg-bg disabled:opacity-50"
          >
            {Spinner ?? <Mail size={14} className="text-gold-2" />}
            Re-send invite email
          </button>
        </div>
      )}

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
                {linkableLogins.map(u => (
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
            {linkableLogins.length === 0 && (
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
            {!loginLinkable ? (
              <p className="flex items-center gap-1.5 text-[11.5px] text-ink-4">
                <Mail size={12} /> The account must be active before it can hold a roster row.
              </p>
            ) : (
              <>
                {linkableRosters.length > 0 && (
                  <>
                    <div className="flex gap-2">
                      <select
                        value={linkTarget}
                        onChange={e => setLinkTarget(e.target.value)}
                        disabled={busy}
                        className={`${inputClass} flex-1`}
                      >
                        <option value="">Choose an existing roster row…</option>
                        {linkableRosters.map(r => (
                          <option key={r.id} value={r.id}>
                            {rosterFullName(r)}{r.clockId ? ` — Clock #${r.clockId}` : ' — no clock ID'}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => linkTarget && linkExistingRoster(linkTarget)}
                        disabled={busy || !linkTarget}
                        className="px-3.5 py-2 rounded-lg bg-ink text-white text-[12.5px] font-semibold disabled:opacity-50"
                      >
                        Link
                      </button>
                    </div>
                    <p className="text-[11px] text-ink-4 leading-relaxed">
                      If they are already on the roster, link that row. Creating a second one splits their
                      prep assignments and puts them on the tip pool twice.
                    </p>
                  </>
                )}
                {/* No account name to build a roster name from — and the email
                    is NOT a substitute: it would be printed on prep run-sheet
                    chips and exported as this person's first name on the tip
                    payout CSV. Ask, rather than guess. */}
                {!loginName && (
                  <Field
                    label="Roster name"
                    hint="This account has no name on it yet. Type their full name — the first word becomes the chip label on the prep run sheet, the rest becomes their surname on the tip payout export."
                  >
                    <input
                      value={rosterNameDraft}
                      onChange={e => setRosterNameDraft(e.target.value)}
                      placeholder="e.g. Mia Chen"
                      disabled={busy}
                      className={inputClass}
                    />
                  </Field>
                )}
                <button
                  onClick={addRoster}
                  disabled={busy || !rosterNameSource}
                  className="flex items-center gap-2 px-3.5 py-2 rounded-lg border border-line text-[12.5px] font-medium text-ink-2 hover:bg-bg disabled:opacity-50"
                >
                  <ChefHat size={14} className="text-gold-2" />
                  {linkableRosters.length > 0 ? 'Or create a new roster row' : 'Put them on the kitchen roster'}
                </button>
              </>
            )}
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
      {(person.roster || !loginLocked) && (
        <div className="pt-2 border-t border-bg-2 space-y-2">
          <p className="text-[11px] text-ink-4 pt-3">Reversible changes first — permanent removal last.</p>

          {person.login && !loginLocked && (
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

          {/* Shown even for your own row and the owner's: this is the prep run
              sheet, not an access control, and PATCH /api/prep/cooks/[id]
              accepts it. Hiding it left an admin unable to take THEMSELVES off
              the roster at all. */}
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

          {!loginLocked && (confirmRemove ? (
            <div className="border border-red bg-red-soft rounded-lg px-3.5 py-3 space-y-2.5">
              <div className="flex items-start gap-3">
                <Trash2 size={15} className="text-red-text mt-0.5 shrink-0" />
                <span className="flex-1">
                  <b className="block text-[13px] text-red-text">
                    {person.login ? 'Delete this login?' : 'Delete this roster row?'}
                  </b>
                  {/* Says exactly what the route does. DELETE
                      /api/settings/users/[id] removes the User only —
                      Cook.userId is onDelete: SetNull, so the roster row and
                      everything hanging off it survive by design. */}
                  <span className="block text-[12px] text-ink-3 leading-relaxed mt-0.5">
                    {person.login && person.roster
                      ? 'Deletes the login permanently — they can no longer sign in. The kitchen roster row is KEPT, with its wage, clock ID and tip history, and will reappear in this list as a person with no login. Activity stays in the audit log.'
                      : person.login
                        ? 'Deletes the login permanently — they can no longer sign in. Activity stays in the audit log.'
                        : 'Deletes the roster row and its wage, clock ID and tip-pool settings. Past prep assignments stop resolving to a name.'}
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
                    // The delete unmounts this pane, so the route's non-fatal
                    // warning ("Removed, but the audit log entry failed to
                    // write.") is handed to the page — a WarningNote rendered
                    // here would be destroyed before it ever painted.
                    { after: onCleared },
                  )}
                  disabled={busy}
                  className="flex-1 py-2 rounded-lg bg-red text-white text-[12.5px] font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {Spinner} {person.login ? 'Delete login' : 'Delete roster row'}
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
                <b className="text-[13px] text-red-text">
                  {person.login ? 'Delete the login permanently' : 'Delete the roster row permanently'}
                </b>
              </span>
              <span className="text-[10px] font-mono text-red-text bg-red-soft px-2 py-0.5 rounded-full">cannot undo</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
