'use client'
import { createContext, useContext, useState, useEffect, useCallback } from 'react'

export type UserRole = 'OWNER' | 'ADMIN' | 'MANAGER' | 'LEAD' | 'STAFF'

export interface EffectiveEntry {
  rcId: string
  rcName: string
  locationId: string
  locationName: string
  clearance: UserRole
  source: 'inherited' | 'override'
}

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

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/me')
      if (res.ok) {
        const data: CurrentUser = await res.json()
        setUser(data)
      } else {
        setUser(null)
      }
    } catch {
      setUser(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const effectiveAccess = user?.effectiveAccess ?? []
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
