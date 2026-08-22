'use client'
import { useState } from 'react'
import type { Role } from '@prisma/client'
import { X, Loader2, Check } from 'lucide-react'
import { assignableLevels, ROLE_DESCRIPTIONS, ROLE_LABELS } from '@/lib/roles'
import AssignmentEditor, { type AssignmentDraft } from '@/components/people/AssignmentEditor'
import { displayName } from '@/lib/people'
import type { PeopleHubPayload } from '@/app/setup/users/page'
import { Field, SectionLabel, WarningNote, inputClass } from './kit'

interface Props {
  payload: PeopleHubPayload
  actorRole: Role
  onClose: () => void
  onCreated: () => void
}

const ZERO_ASSIGNMENT_ERROR =
  'Assign at least one location or revenue center — a person with no assignments has no access.'

/**
 * A half this modal has ALREADY committed on the server. Module scope, not a
 * nested definition: the modal is full of text inputs and a component defined
 * in the body remounts on every keystroke.
 *
 * It replaces the whole card — checkbox included — so the committed half has no
 * control left to toggle. The checkbox is what made the duplicate reachable.
 */
function CommittedHalf({ title, body }: { title: string; body: string }) {
  return (
    <div className="border border-line rounded-[10px] px-4 py-3 flex gap-2.5 bg-bg-2">
      <Check size={14} className="shrink-0 text-green-text mt-0.5" />
      <span>
        <b className="block text-[13px] text-ink">{title}</b>
        <span className="block text-[11.5px] text-ink-3 leading-relaxed">{body}</span>
      </span>
    </div>
  )
}

export default function AddPersonModal({ payload, actorRole, onClose, onCreated }: Props) {
  const levels = assignableLevels(actorRole)
  const [name, setName] = useState('')
  const [wantsLogin, setWantsLogin] = useState(true)
  const [wantsRoster, setWantsRoster] = useState(false)
  const [email, setEmail] = useState('')
  const [clearance, setClearance] = useState<Role>(levels.includes('STAFF') ? 'STAFF' : levels[0])
  const [assignments, setAssignments] = useState<AssignmentDraft[]>([])
  const [initials, setInitials] = useState('')
  const [homeStation, setHomeStation] = useState('')
  const [clockId, setClockId] = useState('')
  const [tipRoleId, setTipRoleId] = useState('')
  const [onTipPool, setOnTipPool] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [warning, setWarning] = useState('')

  /**
   * What this modal has ALREADY committed, latched from the 201 body.
   *
   * `POST /api/settings/people` creates the Cook FIRST, then invites, then
   * links. A failed invite therefore returns 201 with a REAL cookId and a null
   * userId — the roster row is committed. It has no idempotency key (it only
   * catches a repeat when a clockId was typed, via a 409) and the duplicate-
   * email guard below cannot see the person either, because a failed invite
   * leaves no User row to match. So a second submit with the roster half still
   * in the payload creates a SECOND Cook — which splits that person's prep
   * assignments and puts two rows on the tip pool.
   *
   * The latch is the fix: once a half is committed its id is remembered and
   * that half is never sent again. Retry is still available (the useful thing
   * after a failed invite is retrying the INVITE), it just carries the login
   * half alone. Chosen over a close-only terminal state because every field is
   * already filled in here, and the alternative route — the People page's
   * "Invite several people" — cannot link the invite to this roster row either:
   * PATCH /api/tips/roster/[id] refuses a userId that is not an ACTIVE user, so
   * no client-side path can link a not-yet-accepted invite.
   */
  const [created, setCreated] = useState<{ cookId: string | null; userId: string | null }>({
    cookId: null, userId: null,
  })
  const rosterCommitted = created.cookId !== null
  const loginCommitted = created.userId !== null
  // The ONLY thing that decides what goes in the payload. Unticking and
  // re-ticking a checkbox cannot revive a committed half — and the checkbox
  // itself is gone once committed (`CommittedHalf` replaces the card).
  const sendLogin = wantsLogin && !loginCommitted
  const sendRoster = wantsRoster && !rosterCommitted
  const nothingLeftToSend = !sendLogin && !sendRoster && (rosterCommitted || loginCommitted)
  /**
   * Once anything is committed the two checkboxes freeze at what the first
   * submit asked for. Locking only the COMMITTED half would leave a second way
   * to a stray Cook: reactivate an existing account (login committed, roster
   * never asked for), then tick the roster half and submit — the endpoint only
   * links the two halves when it creates both in ONE request, so that Cook
   * lands unlinked next to the one that account may already have.
   */
  const halvesLocked = rosterCommitted || loginCommitted

  const derivedInitials = (() => {
    const parts = name.trim().split(/\s+/)
    const raw = parts.length >= 2 ? parts[0][0] + parts[1][0] : name.trim().slice(0, 2)
    return raw.toUpperCase().slice(0, 3)
  })()

  // `POST /api/settings/people` reuses the same idempotent invite the bulk
  // path uses: an email that already belongs to an ACCEPTED account gets
  // REACTIVATED in place — its role, name and every UserScope row are
  // overwritten — while this endpoint independently creates a brand new
  // Cook, which then collides with that account's existing Cook.userId link
  // and degrades to a warning. That server behaviour is intentional (it's
  // what makes re-inviting a deactivated person work); the guard belongs
  // here, before the request ever goes out. Recomputed on every keystroke —
  // no debounce needed since `payload.people` is already loaded client-side —
  // so the admin sees it while typing or on blur, not just after they've
  // filled in the rest of the form and hit submit.
  //
  // WHAT IT MUST NOT BLOCK: a NEVER-ACCEPTED invite. `inviteOne` deletes the
  // stale auth user and sends a fresh one — the one case that genuinely is
  // idempotent, and the hub's only re-invite path, since the Identity tab has
  // no resend action at all. Matching on "has a login" blocked it too.
  //
  // WHY NOT `login.isPending`: it is derived as `!isActive && name === null`
  // (GET /api/settings/people), and THIS modal always sends a name, so every
  // invite it creates comes back with `isPending: false` while still pending.
  // Keying on it would keep blocking exactly the people created here. What is
  // actually knowable client-side is `isActive`: only /auth/callback (accept)
  // and a reactivate flip it true, so an active row IS an accepted account —
  // the destructive case, and the one that stays hard-blocked. An INACTIVE row
  // is ambiguous (never-accepted invite vs. deactivated account) and cannot be
  // told apart from the payload, so it is allowed through with a caution
  // instead, and `reactivated` is surfaced as a warning after the fact.
  const normalizedEmail = email.trim().toLowerCase()
  const existing = wantsLogin && normalizedEmail
    ? payload.people.find(p => p.login && p.login.email.trim().toLowerCase() === normalizedEmail)
    : undefined
  // An accepted, live account. Submitting would silently overwrite their role,
  // name and EVERY assignment. Nothing here is worth that — hard block.
  const duplicate = existing?.login?.isActive ? existing : undefined
  // Even for a re-invite, a second Cook for someone already on the roster is
  // the duplicate this whole latch exists to prevent. Block the roster half.
  const rosterDuplicate = sendRoster && existing?.roster ? existing : undefined
  const duplicateMessage = duplicate
    ? `${displayName(duplicate)} already has an active account with this email. Open their row to add a roster row or change their access instead of creating a second one.`
    : rosterDuplicate
      ? `${displayName(rosterDuplicate)} is already on the kitchen roster. Untick the roster half — a second roster row splits their prep assignments and puts them on the tip pool twice.`
      : ''
  // Non-blocking: an inactive match is either a pending invite (re-inviting is
  // correct and expected) or a deactivated account (re-inviting reactivates it
  // in place). Say so, and let the admin decide.
  const inactiveMatchMessage = !duplicate && existing && !existing.login?.isActive
    ? `${displayName(existing)} already has an account with this email that is not active. If their invite is still pending, this sends a fresh one. If they were deactivated, this reactivates them and REPLACES their clearance, name and assignments with what you enter here — to simply switch them back on, use “Reactivate login” on their Identity tab instead.`
    : ''

  const submit = async () => {
    setError(''); setWarning('')
    if (!name.trim()) { setError('Give this person a name.'); return }
    if (!sendLogin && !sendRoster) {
      // Everything asked for is already committed — there is nothing to POST.
      // Re-submitting here is exactly the duplicate this modal must not make.
      if (nothingLeftToSend) { onClose(); return }
      setError('Give this person an app login, a kitchen roster row, or both.'); return
    }
    if (duplicate || rosterDuplicate) { setError(duplicateMessage); return }
    if (sendLogin) {
      if (!email.trim()) { setError('Add an email address for the app login.'); return }
      if (assignments.length === 0) { setError(ZERO_ASSIGNMENT_ERROR); return }
    }
    setSaving(true)
    try {
      const res = await fetch('/api/settings/people', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          ...(sendLogin ? { login: { email: email.trim().toLowerCase(), clearance, assignments } } : {}),
          ...(sendRoster ? {
            roster: {
              initials: initials.trim() || derivedInitials,
              homeStation: homeStation || null,
              clockId: clockId.trim() || null,
              tipRoleId: tipRoleId || null,
              onTipPool,
            },
          } : {}),
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { setError(body.error ?? 'Could not create this person'); return }

      // Latch BEFORE any branch returns. A 201 means each id it carries is a
      // committed row, whatever the invite did — every path out of here must
      // leave those halves unsendable.
      const cookId: string | null = body.cookId ?? created.cookId
      const userId: string | null = body.userId ?? created.userId
      setCreated({ cookId, userId })

      const status: string | undefined = body.invite?.status

      // A partial create is a REAL, valid outcome: the roster row is committed
      // and only the invite failed. Report it and keep the modal open so the
      // admin sees what happened rather than a silent half-success. The retry
      // it invites now sends the LOGIN HALF ONLY — the roster card is already
      // locked, so it cannot mint a second Cook.
      if (status && status !== 'invited' && status !== 'reinvited' && status !== 'reactivated') {
        onCreated()
        setWarning(
          cookId
            ? `Added ${name.trim()} to the kitchen roster, but the invite failed: ${body.invite.error}. The roster row is saved and is already on the People list — fix the email if that was the problem and use “Send invite” below, which retries the invite alone. If it keeps failing, close this and use “Invite several people” on the People page; either way the login has to be joined to the roster row on their Identity tab once they accept it.`
            : `The invite failed: ${body.invite.error}. Nothing was created — “Send invite” retries it.`,
        )
        return
      }

      // `reactivated` is NOT a clean create: the email already belonged to an
      // accepted account, so `inviteOne` reactivated it in place and replaced
      // its role, name and every UserScope row with what was typed here. The
      // guard above makes that unreachable for anyone in the loaded payload,
      // but an account that exists only in Supabase Auth with no Prisma row
      // still lands here — closing on it would hide a re-scope behind what
      // looks like a fresh invite.
      if (status === 'reactivated') {
        onCreated()
        setWarning(
          `${email.trim().toLowerCase()} already had an account, so it was REACTIVATED rather than created: its clearance, name and assignments were replaced with what you entered here. Check their row on the People list — if that was not what you wanted, their previous assignments are gone and must be re-entered.`,
        )
        return
      }
      if (body.warning) { onCreated(); setWarning(body.warning); return }

      onCreated()
      onClose()
    } catch (e) {
      // A network rejection throws before any response exists — without this,
      // `saving` stays true forever with no escape short of reopening.
      setError(e instanceof Error ? e.message : 'Network error — could not reach the server')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-ink/40" onClick={onClose} />
      <div className="relative bg-paper rounded-xl border border-line shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <h2 className="font-fraunces text-[17px] font-semibold text-ink">Add person</h2>
          <button onClick={onClose} aria-label="Close" className="text-ink-4 hover:text-ink-2"><X size={16} /></button>
        </div>

        <div className="px-5 py-5 space-y-5">
          <Field label="Name" hint="Their first name is what shows on prep run-sheet chips.">
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Mia Chen"
              className={inputClass}
            />
          </Field>

          {/* login half — replaced outright once the invite has gone out, so
              there is no checkbox left to re-tick and re-send it. */}
          {loginCommitted ? (
            <CommittedHalf
              title="Invite sent"
              body={`${email.trim().toLowerCase()} has been invited. They set their own password from the email.`}
            />
          ) : (
          <div className="border border-line rounded-[10px] overflow-hidden">
            <label className="flex items-center gap-2.5 px-4 py-3 cursor-pointer">
              <input
                type="checkbox" checked={wantsLogin} disabled={halvesLocked}
                onChange={e => setWantsLogin(e.target.checked)} className="accent-gold"
              />
              <span>
                <b className="block text-[13px] text-ink">Give them an app login</b>
                <span className="block text-[11.5px] text-ink-3">Sends an invite email. They set their own password.</span>
              </span>
            </label>
            {wantsLogin && (
              <div className="px-4 pb-4 space-y-4 border-t border-bg-2 pt-4">
                <Field label="Email">
                  <input
                    type="email" value={email} onChange={e => setEmail(e.target.value)}
                    placeholder="name@example.com" className={inputClass}
                  />
                  {duplicateMessage && (
                    <p className="mt-1.5 text-[11.5px] text-red-text leading-relaxed">{duplicateMessage}</p>
                  )}
                  {inactiveMatchMessage && (
                    <p className="mt-1.5 text-[11.5px] text-ink-3 leading-relaxed">{inactiveMatchMessage}</p>
                  )}
                </Field>
                <Field label="Clearance" hint={ROLE_DESCRIPTIONS[clearance]}>
                  <select value={clearance} onChange={e => setClearance(e.target.value as Role)} className={inputClass}>
                    {levels.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                  </select>
                </Field>
                <div>
                  <SectionLabel>Assignments</SectionLabel>
                  <AssignmentEditor
                    locations={payload.locations}
                    value={assignments}
                    primaryClearance={clearance}
                    actorRole={actorRole}
                    onChange={setAssignments}
                  />
                </div>
              </div>
            )}
          </div>
          )}

          {/* roster half — same treatment. The Cook is committed the moment the
              endpoint returns 201, so this card is the one that MUST NOT be
              resubmittable: a second Cook splits prep assignments and puts two
              rows on the tip pool. */}
          {rosterCommitted ? (
            <CommittedHalf
              title="On the kitchen roster"
              body="The roster row is saved and already shows on the People list. Edit the rest of it from their row."
            />
          ) : (
          <div className="border border-line rounded-[10px] overflow-hidden">
            <label className="flex items-center gap-2.5 px-4 py-3 cursor-pointer">
              <input
                type="checkbox" checked={wantsRoster} disabled={halvesLocked}
                onChange={e => setWantsRoster(e.target.checked)} className="accent-gold"
              />
              <span>
                <b className="block text-[13px] text-ink">Put them on the kitchen roster</b>
                <span className="block text-[11.5px] text-ink-3">Prep assignments and tip payouts.</span>
              </span>
            </label>
            {wantsRoster && (
              <div className="px-4 pb-4 space-y-4 border-t border-bg-2 pt-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Initials">
                    <input
                      value={initials} onChange={e => setInitials(e.target.value.toUpperCase().slice(0, 3))}
                      placeholder={derivedInitials || 'MC'} className={`${inputClass} uppercase`}
                    />
                  </Field>
                  <Field label="Home station">
                    <select value={homeStation} onChange={e => setHomeStation(e.target.value)} className={inputClass}>
                      <option value="">No station</option>
                      {payload.stations.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </Field>
                  <Field label="Clock ID" hint="POS employee number. Hours match on this alone.">
                    <input value={clockId} onChange={e => setClockId(e.target.value)} placeholder="—" className={inputClass} />
                  </Field>
                  <Field label="Tip role">
                    <select value={tipRoleId} onChange={e => setTipRoleId(e.target.value)} className={inputClass}>
                      <option value="">No role</option>
                      {payload.tipRoles.map(r => <option key={r.id} value={r.id}>{r.name} — ×{r.multiplier}</option>)}
                    </select>
                  </Field>
                </div>
                <label className="flex items-center gap-2.5 text-[12.5px] text-ink-2 cursor-pointer">
                  <input type="checkbox" checked={onTipPool} onChange={e => setOnTipPool(e.target.checked)} className="accent-gold" />
                  On the tip pool
                </label>
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

          {/* One button, three jobs. With every requested half committed it is
              a plain Close — submitting again has nothing to send and would
              only risk a duplicate. With the roster committed and the invite
              still owed it retries THAT, alone. */}
          <button
            onClick={nothingLeftToSend ? onClose : submit}
            disabled={saving}
            className="w-full py-3 rounded-[10px] bg-ink text-white font-semibold text-sm disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            {nothingLeftToSend ? 'Done' : rosterCommitted ? 'Send invite' : 'Add person'}
          </button>
        </div>
      </div>
    </div>
  )
}
