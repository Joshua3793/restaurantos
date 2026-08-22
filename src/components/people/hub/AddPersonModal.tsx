'use client'
import { useState } from 'react'
import type { Role } from '@prisma/client'
import { X, Loader2 } from 'lucide-react'
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
  const normalizedEmail = email.trim().toLowerCase()
  const duplicate = wantsLogin && normalizedEmail
    ? payload.people.find(p => p.login && p.login.email.trim().toLowerCase() === normalizedEmail)
    : undefined
  const duplicateMessage = duplicate
    ? `${displayName(duplicate)} already has an account with this email. Open their row to add a roster row or change their access instead of creating a second one.`
    : ''

  const submit = async () => {
    setError(''); setWarning('')
    if (!name.trim()) { setError('Give this person a name.'); return }
    if (!wantsLogin && !wantsRoster) {
      setError('Give this person an app login, a kitchen roster row, or both.'); return
    }
    if (wantsLogin) {
      if (!email.trim()) { setError('Add an email address for the app login.'); return }
      if (duplicate) { setError(duplicateMessage); return }
      if (assignments.length === 0) { setError(ZERO_ASSIGNMENT_ERROR); return }
    }
    setSaving(true)
    try {
      const res = await fetch('/api/settings/people', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          ...(wantsLogin ? { login: { email: email.trim().toLowerCase(), clearance, assignments } } : {}),
          ...(wantsRoster ? {
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

      // A partial create is a REAL, valid outcome: the roster row is committed
      // and only the invite failed. Report it and keep the modal open so the
      // admin sees what happened rather than a silent half-success.
      if (body.invite && body.invite.status !== 'invited'
        && body.invite.status !== 'reinvited' && body.invite.status !== 'reactivated') {
        onCreated()
        setWarning(
          body.cookId
            ? `Added to the kitchen roster, but the invite failed: ${body.invite.error}. Retry from their Identity tab.`
            : `The invite failed: ${body.invite.error}`,
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

          {/* login half */}
          <div className="border border-line rounded-[10px] overflow-hidden">
            <label className="flex items-center gap-2.5 px-4 py-3 cursor-pointer">
              <input type="checkbox" checked={wantsLogin} onChange={e => setWantsLogin(e.target.checked)} className="accent-gold" />
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
                  {duplicate && (
                    <p className="mt-1.5 text-[11.5px] text-red-text leading-relaxed">{duplicateMessage}</p>
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

          {/* roster half */}
          <div className="border border-line rounded-[10px] overflow-hidden">
            <label className="flex items-center gap-2.5 px-4 py-3 cursor-pointer">
              <input type="checkbox" checked={wantsRoster} onChange={e => setWantsRoster(e.target.checked)} className="accent-gold" />
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

          {error && (
            <div className="flex gap-2 px-3 py-2.5 bg-red-soft border border-line rounded-[10px]">
              <span className="text-red-text">⚠</span>
              <p className="text-[12.5px] text-red-text leading-relaxed">{error}</p>
            </div>
          )}
          {warning && <WarningNote>{warning}</WarningNote>}

          <button
            onClick={submit}
            disabled={saving}
            className="w-full py-3 rounded-[10px] bg-ink text-white font-semibold text-sm disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            Add person
          </button>
        </div>
      </div>
    </div>
  )
}
