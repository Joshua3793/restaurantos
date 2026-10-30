'use client'
import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import type { EffectiveEntry } from '@/lib/access-model'
import { createClient } from '@/lib/supabase/client'
import { PIN_REMOVED_URL, shouldReturnToPin } from '@/lib/pin/session-lost'

export type UserRole = 'OWNER' | 'ADMIN' | 'MANAGER' | 'LEAD' | 'STAFF'

// Re-exported for callers that import EffectiveEntry from here — access-model.ts
// (deliberately client-safe, no `server-only`) is the one authoritative
// definition; its `clearance` is typed as Prisma's `Role`, which is
// structurally identical to the UserRole union above.
export type { EffectiveEntry }

const EMPTY_ACCESS: EffectiveEntry[] = []

export interface CurrentUser {
  id: string
  email: string
  name: string | null
  role: UserRole
  effectiveAccess?: EffectiveEntry[]
}

interface UserContextValue {
  user: CurrentUser | null
  role: UserRole | null
  effectiveAccess: EffectiveEntry[]
  /** Clearance that applies at one RC, or null when out of reach. */
  clearanceAt: (rcId: string) => UserRole | null
  loading: boolean
  reload: () => Promise<void>
}

const UserContext = createContext<UserContextValue>({
  user: null,
  role: null,
  effectiveAccess: [],
  clearanceAt: () => null,
  loading: true,
  reload: async () => {},
})

export function UserProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [loading, setLoading] = useState(true)

  const leaving = useRef(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/me')
      if (res.ok) {
        const data: CurrentUser = await res.json()
        setUser(data)
      } else {
        setUser(null)
        if (res.status === 401 && !leaving.current) {
          const body: unknown = await res.json().catch(() => null)
          if (shouldReturnToPin(res.status, body, window.location.pathname)) {
            // A PIN login whose phone was removed: the Supabase session still
            // works but every API refuses it. End it on THIS phone only (a
            // global sign-out would also sign out the cook's other OK'd
            // phones), then send them to the PIN screen to ask again.
            leaving.current = true
            try {
              await createClient().auth.signOut({ scope: 'local' })
            } catch {
              // Signed out or not, the PIN screen is the way back in.
            }
            window.location.assign(PIN_REMOVED_URL)
            return
          }
        }
      }
    } catch {
      setUser(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const effectiveAccess = user?.effectiveAccess ?? EMPTY_ACCESS
  const clearanceAt = useCallback(
    (rcId: string) => effectiveAccess.find(e => e.rcId === rcId)?.clearance ?? null,
    [effectiveAccess],
  )

  return (
    <UserContext.Provider
      value={{ user, role: user?.role ?? null, effectiveAccess, clearanceAt, loading, reload: load }}
    >
      {children}
    </UserContext.Provider>
  )
}

export const useUser = () => useContext(UserContext)
