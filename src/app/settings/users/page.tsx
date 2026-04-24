'use client'
import { useState, useEffect, useCallback } from 'react'
import { Users, Send, AlertCircle, CheckCircle, Trash2 } from 'lucide-react'
import { useUser } from '@/contexts/UserContext'

type UserRole = 'ADMIN' | 'MANAGER' | 'STAFF'

interface TeamUser {
  id: string
  email: string
  name: string | null
  role: UserRole
  isActive: boolean
  createdAt: string
}

const ROLE_LABELS: Record<UserRole, string> = {
  ADMIN: 'Admin',
  MANAGER: 'Manager',
  STAFF: 'Staff',
}

const ROLE_COLORS: Record<UserRole, string> = {
  ADMIN: 'bg-purple-100 text-purple-700',
  MANAGER: 'bg-blue-100 text-blue-700',
  STAFF: 'bg-gray-100 text-gray-600',
}

export default function UsersSettingsPage() {
  const { user: currentUser } = useUser()
  const [users, setUsers] = useState<TeamUser[]>([])
  const [loading, setLoading] = useState(true)

  // Invite form state
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<UserRole>('STAFF')
  const [inviteName, setInviteName] = useState('')
  const [inviting, setInviting] = useState(false)
  const [inviteResult, setInviteResult] = useState<{ ok: boolean; message: string } | null>(null)

  const loadUsers = useCallback(async () => {
    const res = await fetch('/api/settings/users')
    if (res.ok) setUsers(await res.json())
    setLoading(false)
  }, [])

  useEffect(() => { loadUsers() }, [loadUsers])

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
        loadUsers()
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
    await fetch(`/api/settings/users/${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: newRole }),
    })
    setUsers(prev => prev.map(u => u.id === userId ? { ...u, role: newRole } : u))
  }

  const handleDeactivate = async (userId: string) => {
    if (!confirm('Deactivate this user? They will be signed out immediately.')) return
    await fetch(`/api/settings/users/${userId}`, { method: 'DELETE' })
    setUsers(prev => prev.map(u => u.id === userId ? { ...u, isActive: false } : u))
  }

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Page header — desktop only */}
      <div className="hidden md:block border-b border-gray-100 pb-4">
        <h2 className="text-lg font-semibold text-gray-900">Team</h2>
        <p className="text-sm text-gray-500 mt-0.5">Manage users and invite new team members</p>
      </div>

      {/* Invite card */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-50">
          <div className="w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center shrink-0">
            <Send size={15} className="text-blue-600" />
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-900">Invite a Team Member</p>
            <p className="text-xs text-gray-400">They'll receive an email to set up their account</p>
          </div>
        </div>

        <form onSubmit={handleInvite} className="px-5 py-4 space-y-3">
          <div className="flex gap-2">
            <input
              type="text"
              value={inviteName}
              onChange={e => setInviteName(e.target.value)}
              placeholder="Name (optional)"
              className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="flex gap-2">
            <input
              type="email"
              value={inviteEmail}
              onChange={e => setInviteEmail(e.target.value)}
              placeholder="Email address"
              required
              className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <select
              value={inviteRole}
              onChange={e => setInviteRole(e.target.value as UserRole)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
            >
              <option value="STAFF">Staff</option>
              <option value="MANAGER">Manager</option>
              <option value="ADMIN">Admin</option>
            </select>
            <button
              type="submit"
              disabled={inviting}
              className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap transition-colors"
            >
              <Send size={13} />
              {inviting ? 'Sending…' : 'Send Invite'}
            </button>
          </div>
          {inviteResult && (
            <div className={`flex items-center gap-2 p-2.5 rounded-lg text-xs ${inviteResult.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
              {inviteResult.ok ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
              {inviteResult.message}
            </div>
          )}
        </form>
      </div>

      {/* Team list */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-50">
          <div className="w-8 h-8 bg-gray-100 rounded-lg flex items-center justify-center shrink-0">
            <Users size={15} className="text-gray-600" />
          </div>
          <p className="text-sm font-semibold text-gray-900">Team Members</p>
        </div>

        {loading ? (
          <div className="px-5 py-8 text-sm text-gray-400 text-center">Loading…</div>
        ) : (
          <div className="divide-y divide-gray-50">
            {users.map(u => {
              const isMe = u.id === currentUser?.id
              return (
                <div key={u.id} className={`flex items-center gap-3 px-5 py-3.5 ${!u.isActive ? 'opacity-50' : ''}`}>
                  {/* Avatar */}
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center shrink-0">
                    <span className="text-white text-xs font-semibold">
                      {(u.name ?? u.email)[0].toUpperCase()}
                    </span>
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p className="text-sm font-medium text-gray-900 truncate">
                        {u.name ?? u.email}
                      </p>
                      {isMe && (
                        <span className="text-[10px] font-semibold bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded-full">
                          You
                        </span>
                      )}
                      {!u.isActive && (
                        <span className="text-[10px] font-semibold bg-red-100 text-red-500 px-1.5 py-0.5 rounded-full">
                          Inactive
                        </span>
                      )}
                      {u.isActive && !u.name && (
                        <span className="text-[10px] font-semibold bg-amber-100 text-amber-600 px-1.5 py-0.5 rounded-full">
                          Pending
                        </span>
                      )}
                    </div>
                    {u.name && (
                      <p className="text-xs text-gray-400 truncate">{u.email}</p>
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
                      className={`text-xs font-medium px-2 py-1 rounded-full border-0 cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500 ${ROLE_COLORS[u.role]} disabled:cursor-default`}
                    >
                      <option value="STAFF">Staff</option>
                      <option value="MANAGER">Manager</option>
                      <option value="ADMIN">Admin</option>
                    </select>
                  )}

                  {/* Deactivate button */}
                  {!isMe && u.isActive && (
                    <button
                      onClick={() => handleDeactivate(u.id)}
                      title="Deactivate user"
                      className="p-1.5 rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50 transition-all"
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
    </div>
  )
}
