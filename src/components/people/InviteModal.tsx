'use client'
import { useState } from 'react'
import type { Role } from '@prisma/client'
import { X, Loader2 } from 'lucide-react'
import { assignableLevels, ROLE_LABELS, ROLE_DOT, ROLE_DESCRIPTIONS } from '@/lib/roles'
import AssignmentEditor, { type AssignmentDraft } from './AssignmentEditor'
import type { LocationNode } from './people-utils'

interface Props {
  locations: LocationNode[]
  actorRole: Role
  onClose: () => void
  onInvited: () => void
}

export default function InviteModal({ locations, actorRole, onClose, onInvited }: Props) {
  const levels = assignableLevels(actorRole)
  const [emails, setEmails] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [clearance, setClearance] = useState<Role>(levels.includes('STAFF') ? 'STAFF' : levels[0])
  const [assignments, setAssignments] = useState<AssignmentDraft[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const commitDraft = () => {
    const value = draft.trim().toLowerCase()
    if (value && !emails.includes(value)) setEmails([...emails, value])
    setDraft('')
  }

  const submit = async () => {
    setError('')
    const all = draft.trim() ? [...emails, draft.trim().toLowerCase()] : emails
    if (all.length === 0) { setError('Add at least one email address.'); return }
    if (assignments.length === 0) {
      setError('Assign at least one location or revenue center — a person with no assignments has no access.')
      return
    }
    setSaving(true)
    const res = await fetch('/api/settings/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emails: all, clearance, assignments }),
    })
    const body = await res.json().catch(() => ({}))
    setSaving(false)
    if (!res.ok) { setError(body.error ?? 'Failed to send invite'); return }
    const failed = (body.results ?? []).filter((r: { status: string }) => r.status === 'failed')
    if (failed.length) {
      setError(failed.map((f: { email: string; error: string }) => `${f.email}: ${f.error}`).join('; '))
      return
    }
    onInvited()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-ink/40" onClick={onClose} />
      <div className="relative bg-paper rounded-xl border border-line shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <h2 className="font-fraunces text-[17px] font-semibold text-ink">Invite people</h2>
          <button onClick={onClose} className="text-ink-4 hover:text-ink-2"><X size={16} /></button>
        </div>

        <div className="px-5 py-5 space-y-5">
          {/* emails */}
          <div>
            <label className="block text-[10px] font-mono uppercase tracking-[0.12em] text-ink-4 mb-1.5">
              Email addresses
            </label>
            <div className="flex flex-wrap gap-1.5 p-2 border border-line rounded-[10px]">
              {emails.map(e => (
                <span key={e} className="inline-flex items-center gap-1.5 bg-bg-2 rounded-sm px-2 py-1 text-[12.5px]">
                  {e}
                  <button onClick={() => setEmails(emails.filter(x => x !== e))} className="text-ink-4 hover:text-red">
                    <X size={11} />
                  </button>
                </span>
              ))}
              <input
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commitDraft() }
                }}
                onBlur={commitDraft}
                placeholder={emails.length ? 'add another…' : 'name@restaurant.com'}
                className="flex-1 min-w-[140px] text-[13px] px-1 py-1 outline-none placeholder:text-ink-4"
              />
            </div>
          </div>

          {/* clearance */}
          <div>
            <label className="block text-[10px] font-mono uppercase tracking-[0.12em] text-ink-4 mb-2">
              Primary clearance
            </label>
            <div className="grid grid-cols-4 gap-1.5">
              {levels.map(r => (
                <button
                  key={r}
                  onClick={() => setClearance(r)}
                  className={`text-center py-2.5 px-1 rounded-[9px] border transition-colors ${
                    clearance === r
                      ? 'border-[1.5px] border-gold bg-gold-soft/40'
                      : 'border-line hover:bg-bg'
                  }`}
                >
                  <span className={`block w-4 h-4 rounded-sm mx-auto mb-1.5 ${ROLE_DOT[r]}`} />
                  <span className={`text-[10.5px] ${clearance === r ? 'text-gold-2 font-semibold' : 'text-ink-3'}`}>
                    {ROLE_LABELS[r]}
                  </span>
                </button>
              ))}
            </div>
            <p className="mt-2 text-[11.5px] text-ink-4 leading-relaxed">{ROLE_DESCRIPTIONS[clearance]}</p>
          </div>

          {/* assignments */}
          <div>
            <label className="block text-[10px] font-mono uppercase tracking-[0.12em] text-ink-4 mb-2">
              Where do they work?
            </label>
            <AssignmentEditor
              locations={locations}
              value={assignments}
              primaryClearance={clearance}
              actorRole={actorRole}
              onChange={setAssignments}
            />
          </div>

          {error && (
            <div className="flex gap-2 px-3 py-2.5 bg-red-soft border border-red/20 rounded-[10px]">
              <span className="text-red-text">⚠</span>
              <p className="text-[12.5px] text-red-text leading-relaxed">{error}</p>
            </div>
          )}

          <button
            onClick={submit}
            disabled={saving}
            className="w-full py-3 rounded-[10px] bg-ink text-white font-semibold text-sm disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            Send invite →
          </button>
        </div>
      </div>
    </div>
  )
}
