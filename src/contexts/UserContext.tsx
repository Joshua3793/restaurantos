'use client'
import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import type { EffectiveEntry } from '@/lib/access-model'
import { createClient } from '@/lib/supabase/client'
import { PIN_REMOVED_URL, shouldReturnToPin } from '@/lib/pin/session-lost'
import { SIGNED_OUT_OVERNIGHT, nextSignOutCutoff } from '@/lib/auth-day'

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
          if (isOvernightSignOut(body, window.location.pathname)) {
            // Past 02:00 on a page left open: end the session on this device
            // and let middleware pick the sign-in screen (PIN or email).
            leaving.current = true
            try {
              await createClient().auth.signOut({ scope: 'local' })
            } catch {
              // Signed out or not, the sign-in screen is the way back in.
            }
            window.location.assign('/')
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

  // A page left open past 02:00 (the till, a phone in a pocket) re-checks the
  // session then, and again whenever it comes back on screen after it —
  // phones pause timers while asleep.
  useEffect(() => {
    let due = nextSignOutCutoff(new Date())
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(check, Math.min(Math.max(due - Date.now(), 0) + 5_000, 2 ** 31 - 1))
    }
    const check = () => {
      if (Date.now() < due) return arm()
      due = nextSignOutCutoff(new Date())
      arm()
      load()
    }
    const onVisible = () => { if (document.visibilityState === 'visible') check() }
    arm()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load])

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

/** A 401 from /api/me meaning "signed out at 02:00", on a page that isn't a sign-in page. */
function isOvernightSignOut(body: unknown, pathname: string): boolean {
  if (pathname === '/login' || pathname.startsWith('/login/') || pathname.startsWith('/auth')) return false
  const error = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined
  return error === SIGNED_OUT_OVERNIGHT
}
