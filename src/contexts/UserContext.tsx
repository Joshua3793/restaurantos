'use client'
import { createContext, useContext, useState, useEffect, useCallback } from 'react'

export type UserRole = 'ADMIN' | 'MANAGER' | 'STAFF'

export interface CurrentUser {
  id: string
  email: string
  name: string | null
  role: UserRole
}

interface UserContextValue {
  user: CurrentUser | null
  role: UserRole | null
  loading: boolean
  reload: () => Promise<void>
}

const UserContext = createContext<UserContextValue>({
  user: null,
  role: null,
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

  return (
    <UserContext.Provider value={{ user, role: user?.role ?? null, loading, reload: load }}>
      {children}
    </UserContext.Provider>
  )
}

export const useUser = () => useContext(UserContext)
