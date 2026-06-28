'use client'
import { useState, useEffect, useCallback } from 'react'
import { Users, Send, AlertCircle, CheckCircle, Trash2, Shield, MapPin, X } from 'lucide-react'
import { useUser } from '@/contexts/UserContext'
import { rcHex } from '@/lib/rc-colors'

type UserRole = 'ADMIN' | 'MANAGER' | 'STAFF'

interface TeamUser {
  id: string
  email: string
  name: string | null
  role: UserRole
  isActive: boolean
  createdAt: string
}

interface ScopeRcLite { id: string; name: string; color: string; type: string }
interface ScopeLocationLite {
  id: string
  name: string
  color: string
  revenueCenters: ScopeRcLite[]
}
interface UserScopeRow { id: string; locationId: string | null; revenueCenterId: string | null }

const ROLE_LABELS: Record<UserRole, string> = {
  ADMIN: 'Admin',
  MANAGER: 'Manager',
  STAFF: 'Staff',
}

const ROLE_COLORS: Record<UserRole, string> = {
  ADMIN: 'bg-blue-soft text-blue-text',
  MANAGER: 'bg-gold/15 text-gold',
  STAFF: 'bg-bg-2 text-ink-3',
}

/* ──────────────────────────  Per-user scope editor  ─────────────────────────── */

function ScopeModal({
  user,
  locations,
  onClose,
}: {
  user: TeamUser
  locations: ScopeLocationLite[]
  onClose: () => void
}) {
  // Selected sets — assigning a whole location vs. individual RCs.
  const [locSel, setLocSel] = useState<Set<string>>(new Set())
  const [rcSel, setRcSel]   = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)
  const [error, setError]     = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/settings/user-scopes?userId=${user.id}`)
        if (!res.ok) throw new Error(`Failed to load scopes (${res.status})`)
        const rows: UserScopeRow[] = await res.json()
        if (cancelled) return
        setLocSel(new Set(rows.filter(r => r.locationId).map(r => r.locationId as string)))
        setRcSel(new Set(rows.filter(r => r.revenueCenterId).map(r => r.revenueCenterId as string)))
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load scopes')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [user.id])

  const toggleLoc = (id: string) => {
    setLocSel(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else {
        next.add(id)
        // Assigning the whole location supersedes its individual RC picks.
        const loc = locations.find(l => l.id === id)
        if (loc) setRcSel(r => {
          const nr = new Set(r)
          loc.revenueCenters.forEach(rc => nr.delete(rc.id))
          return nr
        })
      }
      return next
    })
  }

  const toggleRc = (id: string) => {
    setRcSel(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Effective-access preview (computed client-side):
  //  - ADMIN → all (admin)
  //  - no scopes → all (unscoped)
  //  - else union of (each assigned location's RCs) + (each assigned RC)
  const allRcs = locations.flatMap(l => l.revenueCenters)
  let effective: { label: string; rcNames: string[] }
  if (user.role === 'ADMIN') {
    effective = { label: 'All revenue centers (admin)', rcNames: [] }
  } else if (locSel.size === 0 && rcSel.size === 0) {
    effective = { label: 'All revenue centers (unscoped)', rcNames: [] }
  } else {
    const names = new Set<string>()
    locations.forEach(l => { if (locSel.has(l.id)) l.revenueCenters.forEach(rc => names.add(rc.name)) })
    allRcs.forEach(rc => { if (rcSel.has(rc.id)) names.add(rc.name) })
    effective = { label: '', rcNames: [...names].sort() }
  }

  const handleSave = async () => {
    setSaving(true)
    setError('')
    const scopes = [
      ...[...locSel].map(locationId => ({ locationId })),
      ...[...rcSel].map(revenueCenterId => ({ revenueCenterId })),
    ]
    const res = await fetch('/api/settings/user-scopes', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: user.id, scopes }),
    })
    setSaving(false)
    if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.error || 'Failed to save'); return }
    onClose()
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-50" onClick={onClose} />
      <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4">
        <div className="bg-white w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl shadow-xl max-h-[90vh] overflow-y-auto">
          <div className="sticky top-0 bg-white px-5 pt-5 pb-3 border-b border-line flex items-start justify-between gap-3">
            <div>
              <h3 className="font-semibold text-ink">Revenue-center access</h3>
              <p className="text-xs text-ink-4 mt-0.5">{user.name ?? user.email}</p>
            </div>
            <button onClick={onClose} className="p-1.5 text-ink-4 hover:text-ink-2 rounded-lg">
              <X size={16} />
            </button>
          </div>

          <div className="p-5 space-y-4">
            {user.role === 'ADMIN' && (
              <div className="flex items-start gap-2 p-3 bg-blue-soft rounded-xl text-xs text-blue-text">
                <Shield size={14} className="mt-0.5 shrink-0" />
                <span>Admins always have access to every location and revenue center. Scope assignments are ignored for admins.</span>
              </div>
            )}

            {loading ? (
              <div className="text-sm text-ink-4 py-6 text-center">Loading…</div>
            ) : locations.length === 0 ? (
              <div className="text-sm text-ink-4 py-6 text-center">No locations defined yet.</div>
            ) : (
              <div className="space-y-3">
                {locations.map(loc => {
                  const locOn = locSel.has(loc.id)
                  return (
                    <div key={loc.id} className="border border-line rounded-xl p-3">
                      <label className="flex items-center gap-2.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={locOn}
                          disabled={user.role === 'ADMIN'}
                          onChange={() => toggleLoc(loc.id)}
                          className="rounded border-line-2"
                        />
                        <span className="w-6 h-6 rounded-lg shrink-0 flex items-center justify-center text-white"
                          style={{ backgroundColor: rcHex(loc.color) }}>
                          <MapPin size={12} />
                        </span>
                        <span className="text-sm font-medium text-ink">{loc.name}</span>
                        <span className="text-[11px] text-ink-4">whole location</span>
                      </label>

                      {loc.revenueCenters.length > 0 && (
                        <div className="mt-2 pl-8 space-y-1.5">
                          {loc.revenueCenters.map(rc => (
                            <label key={rc.id} className="flex items-center gap-2 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={locOn || rcSel.has(rc.id)}
                                disabled={locOn || user.role === 'ADMIN'}
                                onChange={() => toggleRc(rc.id)}
                                className="rounded border-line-2"
                              />
                              <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: rcHex(rc.color) }} />
                              <span className="text-sm text-ink-2">{rc.name}</span>
                              <span className="text-[10px] uppercase tracking-wide text-ink-4">
                                {rc.type === 'DRINK' ? 'Drink' : 'Food'}
                              </span>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {/* Effective access preview */}
            <div className="p-3 bg-bg rounded-xl border border-line">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-4 mb-1.5">Effective access</p>
              {effective.label ? (
                <p className="text-sm text-ink-2">{effective.label}</p>
              ) : effective.rcNames.length === 0 ? (
                <p className="text-sm text-ink-4">No revenue centers selected.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {effective.rcNames.map(n => (
                    <span key={n} className="text-xs bg-white border border-line rounded-full px-2 py-0.5 text-ink-2">{n}</span>
                  ))}
                </div>
              )}
            </div>

            {error && <p className="text-xs text-red">{error}</p>}

            <div className="flex gap-2 pt-1 pb-[env(safe-area-inset-bottom)]">
              <button onClick={handleSave} disabled={saving || loading || user.role === 'ADMIN'}
                className="flex-1 py-2.5 bg-ink text-white text-sm font-medium rounded-xl hover:bg-ink disabled:opacity-50">
                {saving ? 'Saving…' : 'Save Access'}
              </button>
              <button onClick={onClose}
                className="px-4 py-2 border border-line rounded-xl text-sm text-ink-3 hover:bg-bg">
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

export default function UsersSettingsPage() {
  const { user: currentUser } = useUser()
  const [users, setUsers] = useState<TeamUser[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [locations, setLocations] = useState<ScopeLocationLite[]>([])
  const [scopeUser, setScopeUser] = useState<TeamUser | null>(null)

  // Invite form state
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<UserRole>('STAFF')
  const [inviteName, setInviteName] = useState('')
  const [inviting, setInviting] = useState(false)
  const [inviteResult, setInviteResult] = useState<{ ok: boolean; message: string } | null>(null)

  const loadUsers = useCallback(async () => {
    setLoadError(null)
    try {
      const res = await fetch('/api/settings/users')
      if (!res.ok) throw new Error(`Failed to load users (${res.status})`)
      setUsers(await res.json())
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load users')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadUsers() }, [loadUsers])

  useEffect(() => {
    fetch('/api/locations')
      .then(r => r.ok ? r.json() : [])
      .then((data: ScopeLocationLite[]) => setLocations(Array.isArray(data) ? data : []))
      .catch(() => { /* non-fatal: scope modal shows "no locations" */ })
  }, [])

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault()
    setInviting(true)
    setInviteResult(null)
    try {
      const res = await fetch('/api/settings/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail, role: inviteRole, name: inviteName || undefined }),
      })
      const data = await res.json()
      if (res.ok) {
        setInviteResult({ ok: true, message: `Invite sent to ${inviteEmail}` })
        setInviteEmail('')
        setInviteName('')
        setInviteRole('STAFF')
        await loadUsers()
      } else {
        setInviteResult({ ok: false, message: data.error ?? 'Failed to send invite' })
      }
    } catch {
      setInviteResult({ ok: false, message: 'Network error' })
    } finally {
      setInviting(false)
    }
  }

  const handleRoleChange = async (userId: string, newRole: UserRole) => {
    const res = await fetch(`/api/settings/users/${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: newRole }),
    })
    if (res.ok) {
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, role: newRole } : u))
    } else {
      // Reload to get accurate state from server
      loadUsers()
    }
  }

  const handleDeactivate = async (userId: string) => {
    if (!confirm('Deactivate this user? They will be signed out immediately.')) return
    const res = await fetch(`/api/settings/users/${userId}`, { method: 'DELETE' })
    if (res.ok) {
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, isActive: false } : u))
    } else {
      loadUsers()
    }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Page header — desktop only */}
      <div className="hidden md:block border-b border-line pb-4">
        <h2 className="text-lg font-semibold text-ink">Team</h2>
        <p className="text-sm text-ink-3 mt-0.5">Manage users and invite new team members</p>
      </div>

      {/* Invite card */}
      <div className="bg-white rounded-xl border border-line shadow-sm overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-line">
          <div className="w-8 h-8 bg-gold/15 rounded-lg flex items-center justify-center shrink-0">
            <Send size={15} className="text-gold" />
          </div>
          <div>
            <p className="text-sm font-semibold text-ink">Invite a Team Member</p>
            <p className="text-xs text-ink-4">They'll receive an email to set up their account</p>
          </div>
        </div>

        <form onSubmit={handleInvite} className="px-5 py-4 space-y-3">
          <div className="flex gap-2">
            <label htmlFor="invite-name" className="sr-only">Name (optional)</label>
            <input
              id="invite-name"
              type="text"
              value={inviteName}
              onChange={e => setInviteName(e.target.value)}
              placeholder="Name (optional)"
              className="flex-1 border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
            />
          </div>
          <div className="flex gap-2">
            <label htmlFor="invite-email" className="sr-only">Email address</label>
            <input
              id="invite-email"
              type="email"
              value={inviteEmail}
              onChange={e => setInviteEmail(e.target.value)}
              placeholder="Email address"
              required
              className="flex-1 border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
            />
            <label htmlFor="invite-role" className="sr-only">Role</label>
            <select
              id="invite-role"
              value={inviteRole}
              onChange={e => setInviteRole(e.target.value as UserRole)}
              className="border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold bg-white"
            >
              <option value="STAFF">Staff</option>
              <option value="MANAGER">Manager</option>
              <option value="ADMIN">Admin</option>
            </select>
            <button
              type="submit"
              disabled={inviting}
              className="flex items-center gap-2 bg-ink text-paper [&_svg]:text-gold px-4 py-2 rounded-lg text-sm font-medium hover:bg-ink-2 disabled:opacity-50 whitespace-nowrap transition-colors"
            >
              <Send size={13} />
              {inviting ? 'Sending…' : 'Send Invite'}
            </button>
          </div>
          {inviteResult && (
            <div className={`flex items-center gap-2 p-2.5 rounded-lg text-xs ${inviteResult.ok ? 'bg-green-soft text-green-text' : 'bg-red-soft text-red-text'}`}>
              {inviteResult.ok ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
              {inviteResult.message}
            </div>
          )}
        </form>
      </div>

      {/* Team list */}
      <div className="bg-white rounded-xl border border-line shadow-sm overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-line">
          <div className="w-8 h-8 bg-bg-2 rounded-lg flex items-center justify-center shrink-0">
            <Users size={15} className="text-ink-3" />
          </div>
          <p className="text-sm font-semibold text-ink">Team Members</p>
        </div>

        {loading ? (
          <div className="px-5 py-8 text-sm text-ink-4 text-center">Loading…</div>
        ) : loadError ? (
          <div className="px-5 py-8 text-sm text-red text-center">{loadError}</div>
        ) : users.length === 0 ? (
          <div className="px-5 py-8 text-sm text-ink-4 text-center">No team members yet</div>
        ) : (
          <div className="divide-y divide-line">
            {users.map(u => {
              const isMe = u.id === currentUser?.id
              return (
                <div key={u.id} className={`flex items-center gap-3 px-5 py-3.5 ${!u.isActive ? 'opacity-50' : ''}`}>
                  {/* Avatar */}
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue to-blue flex items-center justify-center shrink-0">
                    <span className="text-white text-xs font-semibold">
                      {(u.name ?? u.email)[0].toUpperCase()}
                    </span>
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p className="text-sm font-medium text-ink truncate">
                        {u.name ?? u.email}
                      </p>
                      {isMe && (
                        <span className="text-[10px] font-semibold bg-bg-2 text-ink-3 px-1.5 py-0.5 rounded-full">
                          You
                        </span>
                      )}
                      {!u.isActive && (
                        <span className="text-[10px] font-semibold bg-red-soft text-red px-1.5 py-0.5 rounded-full">
                          Inactive
                        </span>
                      )}
                      {/* Pending: isActive but no name — user invited but hasn't set a display name yet.
                          Note: this heuristic cannot distinguish "never accepted invite" from
                          "accepted but skipped name". A dedicated status field would be more precise. */}
                      {u.isActive && !u.name && (
                        <span className="text-[10px] font-semibold bg-gold-soft text-gold px-1.5 py-0.5 rounded-full">
                          Pending
                        </span>
                      )}
                    </div>
                    {u.name && (
                      <p className="text-xs text-ink-4 truncate">{u.email}</p>
                    )}
                  </div>

                  {/* Role badge / selector */}
                  {isMe ? (
                    <span className={`text-xs font-medium px-2 py-1 rounded-full ${ROLE_COLORS[u.role]}`}>
                      {ROLE_LABELS[u.role]}
                    </span>
                  ) : (
                    <select
                      value={u.role}
                      onChange={e => handleRoleChange(u.id, e.target.value as UserRole)}
                      disabled={!u.isActive}
                      className={`text-xs font-medium px-2 py-1 rounded-full border-0 cursor-pointer focus:outline-none focus:ring-2 focus:ring-gold ${ROLE_COLORS[u.role]} disabled:cursor-default`}
                    >
                      <option value="STAFF">Staff</option>
                      <option value="MANAGER">Manager</option>
                      <option value="ADMIN">Admin</option>
                    </select>
                  )}

                  {/* Manage RC access */}
                  <button
                    onClick={() => setScopeUser(u)}
                    title="Manage revenue-center access"
                    className="p-1.5 rounded-lg text-ink-4 hover:text-ink-2 hover:bg-bg-2 transition-all"
                  >
                    <Shield size={14} />
                  </button>

                  {/* Deactivate button */}
                  {!isMe && u.isActive && (
                    <button
                      onClick={() => handleDeactivate(u.id)}
                      title="Deactivate user"
                      className="p-1.5 rounded-lg text-ink-4 hover:text-red hover:bg-red-soft transition-all"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {scopeUser && (
        <ScopeModal
          user={scopeUser}
          locations={locations}
          onClose={() => setScopeUser(null)}
        />
      )}
    </div>
  )
}
