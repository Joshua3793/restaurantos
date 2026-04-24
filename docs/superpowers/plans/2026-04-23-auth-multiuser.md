# Authentication & Multi-User Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Supabase Auth-based login, invite-only registration, and role-based access control (Admin / Manager / Staff) so multiple users can securely share the Fergie's OS database.

**Architecture:** Supabase Auth manages sessions and email invites. A `User` table in Prisma (keyed by Supabase Auth UUID) stores each user's role and active status. Next.js middleware reads session + role from Supabase `user_metadata` (no DB query needed at edge) to block unauthenticated requests and enforce route-level role restrictions. Sensitive API routes call `requireSession()` from `src/lib/auth.ts` to get the full Prisma user and enforce role minimums. The CONTROLA AI chat history is scoped per user via a `userId` FK on `ChatConversation`.

**Tech Stack:** `@supabase/supabase-js`, `@supabase/ssr`, Next.js 14 App Router middleware, Prisma, React Context (`UserContext`).

---

## File Map

| File | Status | Purpose |
|---|---|---|
| `src/lib/supabase/server.ts` | Create | Supabase SSR client for Route Handlers + Server Components |
| `src/lib/supabase/client.ts` | Create | Supabase browser client for Client Components |
| `src/lib/supabase/admin.ts` | Create | Supabase admin client (service role key) for invites + user updates |
| `src/lib/auth.ts` | Create | `requireSession(minRole?)` helper used in API routes |
| `src/middleware.ts` | Create | Session check + role-based route blocking for all requests |
| `src/contexts/UserContext.tsx` | Create | React context providing `{ user, role }` to client components |
| `src/app/login/page.tsx` | Create | Email + password login form |
| `src/app/auth/callback/route.ts` | Create | OTP verification handler (invite + password reset tokens) |
| `src/app/auth/set-password/page.tsx` | Create | New users set password after invite; also used for password reset |
| `src/app/api/me/route.ts` | Create | Returns current user profile `{ id, email, name, role }` |
| `src/app/api/settings/users/route.ts` | Create | `GET` list + `POST` invite |
| `src/app/api/settings/users/[id]/route.ts` | Create | `PATCH` role/name, `DELETE` deactivate |
| `src/app/settings/users/page.tsx` | Create | Admin-only user management UI |
| `prisma/schema.prisma` | Modify | Add `User` model, `Role` enum, `userId` on `ChatConversation` |
| `src/app/layout.tsx` | Modify | Wrap app in `UserProvider` |
| `src/app/settings/layout.tsx` | Modify | Add Team group + Users link to sidebar |
| `src/components/Navigation.tsx` | Modify | Hide Settings nav entry for non-ADMIN users |
| `src/app/api/chat/conversations/route.ts` | Modify | Scope conversations to `userId` |
| `src/app/api/chat/conversations/[id]/route.ts` | Modify | Scope GET/DELETE to owner |
| `src/app/api/chat/conversations/[id]/messages/route.ts` | Modify | Auth-gate |
| `src/app/api/chat/route.ts` | Modify | Auth-gate streaming handler |
| `src/app/api/invoices/sessions/[id]/approve/route.ts` | Modify | Require MANAGER min role |
| `src/app/api/reports/*/route.ts` (5 files) | Modify | Require MANAGER min role |
| `src/app/api/digest/route.ts` | Modify | Require ADMIN min role |

---

## Task 1: Install Supabase Packages + Create Clients

**Files:**
- Create: `src/lib/supabase/server.ts`
- Create: `src/lib/supabase/client.ts`
- Create: `src/lib/supabase/admin.ts`

- [ ] **Step 1: Install packages**

```bash
cd "/Users/joshua/Desktop/Fergie's OS"
npm install @supabase/supabase-js @supabase/ssr
```

Expected output: `added N packages` with no errors.

- [ ] **Step 2: Add env vars to `.env`**

Open `.env` and append these three lines (leave values blank for now — they must be filled in from the Supabase project dashboard under Project Settings → API):

```bash
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
```

- [ ] **Step 3: Create the Supabase SSR server client**

```typescript
// src/lib/supabase/server.ts
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export function createClient() {
  const cookieStore = cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Ignored: called from a Server Component that cannot set cookies.
            // Middleware refreshes the session, so this is safe to ignore.
          }
        },
      },
    }
  )
}
```

- [ ] **Step 4: Create the Supabase browser client**

```typescript
// src/lib/supabase/client.ts
import { createBrowserClient } from '@supabase/ssr'

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}
```

- [ ] **Step 5: Create the Supabase admin client**

This file uses the service role key and must never be imported in client components.

```typescript
// src/lib/supabase/admin.ts
import { createClient } from '@supabase/supabase-js'

// Server-only. Uses the service role key which bypasses Row Level Security.
// Never import this in client components or expose to the browser.
export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
)
```

- [ ] **Step 6: Verify build**

```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npm run build 2>&1 | tail -5
```

Expected: `✓ Compiled` with no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/supabase/ package.json package-lock.json
git commit -m "feat: add Supabase SSR, browser, and admin clients"
```

---

## Task 2: Schema Migration

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add `Role` enum and `User` model to schema**

Open `prisma/schema.prisma`. After the `datasource db` block (around line 9), add:

```prisma
enum Role {
  ADMIN
  MANAGER
  STAFF
}

model User {
  id                String             @id // matches Supabase Auth user UUID
  email             String             @unique
  name              String?
  role              Role               @default(STAFF)
  isActive          Boolean            @default(true)
  createdAt         DateTime           @default(now())
  updatedAt         DateTime           @updatedAt
  chatConversations ChatConversation[]
}
```

- [ ] **Step 2: Add `userId` to `ChatConversation`**

Find the `ChatConversation` model (near the bottom of the schema) and replace it with:

```prisma
model ChatConversation {
  id        String        @id @default(cuid())
  userId    String?
  user      User?         @relation(fields: [userId], references: [id], onDelete: SetNull)
  title     String
  createdAt DateTime      @default(now())
  updatedAt DateTime      @updatedAt
  messages  ChatMessage[]
}
```

`userId` is nullable (`String?`) so existing conversations don't break. New conversations created after auth is in place will always have a `userId`.

- [ ] **Step 3: Run migration**

```bash
cd "/Users/joshua/Desktop/Fergie's OS"
npx prisma migrate dev --name add_user_auth
```

Expected: `The following migration(s) have been created and applied` with no errors.

- [ ] **Step 4: Regenerate Prisma client**

```bash
npx prisma generate
```

- [ ] **Step 5: Verify build**

```bash
npm run build 2>&1 | tail -5
```

Expected: `✓ Compiled` — the new `Role` enum and `User` type are now available via `@prisma/client`.

- [ ] **Step 6: Commit**

```bash
git add prisma/
git commit -m "feat: add User model, Role enum, and ChatConversation.userId"
```

---

## Task 3: Auth Helper (`requireSession`)

**Files:**
- Create: `src/lib/auth.ts`

This helper is called at the top of any API route that needs the current user or a role check.

- [ ] **Step 1: Create `src/lib/auth.ts`**

```typescript
// src/lib/auth.ts
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { prisma } from '@/lib/prisma'
import { Role, User } from '@prisma/client'

export class AuthError extends Error {
  constructor(
    public readonly status: 401 | 403,
    message: string,
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

// Role strength order — ADMIN > MANAGER > STAFF
const ROLE_RANK: Record<Role, number> = {
  STAFF: 0,
  MANAGER: 1,
  ADMIN: 2,
}

/**
 * Verifies the current request has a valid Supabase session and returns the
 * corresponding Prisma User. Throws AuthError(401) if unauthenticated,
 * AuthError(403) if the user is inactive or below minRole.
 *
 * Usage in a Route Handler:
 *   import { requireSession, AuthError } from '@/lib/auth'
 *
 *   export async function POST(req: NextRequest) {
 *     let user: User
 *     try { user = await requireSession('MANAGER') }
 *     catch (e) {
 *       if (e instanceof AuthError)
 *         return NextResponse.json({ error: e.message }, { status: e.status })
 *       throw e
 *     }
 *     // ... handler logic using user.id, user.role, etc.
 *   }
 */
export async function requireSession(minRole?: Role): Promise<User> {
  const cookieStore = cookies()

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {}
        },
      },
    }
  )

  const {
    data: { user: authUser },
  } = await supabase.auth.getUser()

  if (!authUser) {
    throw new AuthError(401, 'Unauthorized')
  }

  const user = await prisma.user.findUnique({ where: { id: authUser.id } })

  if (!user || !user.isActive) {
    throw new AuthError(403, 'Account is inactive or not found')
  }

  if (minRole !== undefined && ROLE_RANK[user.role] < ROLE_RANK[minRole]) {
    throw new AuthError(403, 'Insufficient permissions')
  }

  return user
}
```

- [ ] **Step 2: Verify build**

```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npm run build 2>&1 | tail -5
```

Expected: `✓ Compiled` with no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/auth.ts
git commit -m "feat: add requireSession() auth helper"
```

---

## Task 4: Next.js Middleware

**Files:**
- Create: `src/middleware.ts`

Middleware runs on every request before the page renders. It uses `@supabase/ssr` directly (no Prisma — Edge runtime). Role info is read from Supabase `user_metadata` (set when inviting/updating users).

- [ ] **Step 1: Create `src/middleware.ts`**

```typescript
// src/middleware.ts
import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

// Routes that never require authentication
const PUBLIC_PREFIXES = ['/login', '/auth']

// Routes that require ADMIN role
const ADMIN_PREFIXES = ['/settings']

// Routes that require MANAGER or ADMIN role
const MANAGER_PREFIXES = ['/reports']

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Always allow public routes
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next()
  }

  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          // Forward cookies to both the request and response so the SSR
          // client can refresh the session token transparently.
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // Refresh session (rotates token if needed) and get the user
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // Not authenticated → redirect to login
  if (!user) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  // Deactivated users (isActive stored in user_metadata) → redirect to login
  if (user.user_metadata?.isActive === false) {
    return NextResponse.redirect(new URL('/login?error=deactivated', request.url))
  }

  // Role-based route restrictions
  const role = (user.user_metadata?.role as string | undefined) ?? 'STAFF'

  if (ADMIN_PREFIXES.some((p) => pathname.startsWith(p)) && role !== 'ADMIN') {
    return NextResponse.redirect(new URL('/', request.url))
  }

  if (
    MANAGER_PREFIXES.some((p) => pathname.startsWith(p)) &&
    role !== 'MANAGER' &&
    role !== 'ADMIN'
  ) {
    return NextResponse.redirect(new URL('/', request.url))
  }

  return response
}

export const config = {
  matcher: [
    /*
     * Match all request paths EXCEPT:
     * - _next/static (static files)
     * - _next/image (image optimisation)
     * - favicon.ico
     * - Files with extensions (images, fonts, etc.)
     * - /api/* routes (API routes return JSON; requireSession() handles auth there)
     *
     * Excluding /api/* is critical: without it, unauthenticated fetch() calls
     * from the login page (e.g. UserContext calling /api/me) would receive an
     * HTML redirect to /login instead of a JSON 401, breaking the client.
     */
    '/((?!_next/static|_next/image|favicon\\.ico|api/|.*\\..*).*)',
  ],
}
```

- [ ] **Step 2: Verify build**

```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npm run build 2>&1 | tail -5
```

Expected: `✓ Compiled` with no errors.

- [ ] **Step 3: Commit**

```bash
git add src/middleware.ts
git commit -m "feat: add Next.js middleware for session + role-based route protection"
```

---

## Task 5: Auth Pages (Login, Callback, Set-Password)

**Files:**
- Create: `src/app/login/page.tsx`
- Create: `src/app/auth/callback/route.ts`
- Create: `src/app/auth/set-password/page.tsx`

- [ ] **Step 1: Create the login page**

```tsx
// src/app/login/page.tsx
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { ChefHat } from 'lucide-react'

export default function LoginPage() {
  const [mode, setMode] = useState<'login' | 'forgot'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    const supabase = createClient()
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      setError(error.message)
      setLoading(false)
    } else {
      router.push('/')
      router.refresh()
    }
  }

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    const supabase = createClient()
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/auth/set-password`,
    })
    setLoading(false)
    if (error) {
      setError(error.message)
    } else {
      setMessage('Check your email for a password reset link.')
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 w-full max-w-sm">
        <div className="flex items-center gap-2 mb-8">
          <div className="w-9 h-9 bg-blue-600 rounded-xl flex items-center justify-center">
            <ChefHat size={18} className="text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-gray-900 leading-tight">CONTROLA OS</h1>
            <p className="text-xs text-gray-400">Restaurant back-office</p>
          </div>
        </div>

        {mode === 'login' ? (
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 text-white py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
            <button
              type="button"
              onClick={() => { setMode('forgot'); setError('') }}
              className="w-full text-xs text-gray-400 hover:text-gray-600 text-center pt-1"
            >
              Forgot password?
            </button>
          </form>
        ) : (
          <form onSubmit={handleForgot} className="space-y-4">
            <p className="text-sm text-gray-600">
              Enter your email and we'll send a password reset link.
            </p>
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            {message && <p className="text-sm text-green-600">{message}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 text-white py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {loading ? 'Sending…' : 'Send reset link'}
            </button>
            <button
              type="button"
              onClick={() => { setMode('login'); setError(''); setMessage('') }}
              className="w-full text-xs text-gray-400 hover:text-gray-600 text-center pt-1"
            >
              Back to sign in
            </button>
          </form>
        )}

        <p className="text-xs text-center text-gray-400 mt-6">
          Don't have an account? Ask your admin for an invite.
        </p>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Create the auth callback route**

This server Route Handler handles two token types:
- `invite` — new user accepted invite email
- `recovery` — user clicked password reset email

```typescript
// src/app/auth/callback/route.ts
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const token_hash = searchParams.get('token_hash')
  const type = searchParams.get('type') as 'invite' | 'recovery' | null
  const next = searchParams.get('next') ?? '/'

  if (!token_hash || !type) {
    return NextResponse.redirect(new URL('/login?error=invalid_link', origin))
  }

  const cookieStore = cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {}
        },
      },
    }
  )

  const { error } = await supabase.auth.verifyOtp({ token_hash, type })

  if (error) {
    return NextResponse.redirect(new URL('/login?error=invalid_link', origin))
  }

  // For invites: activate the Prisma User row
  if (type === 'invite') {
    const {
      data: { user: authUser },
    } = await supabase.auth.getUser()

    if (authUser) {
      await prisma.user.update({
        where: { id: authUser.id },
        data: { isActive: true },
      }).catch(() => {
        // User row may not exist yet if invite was sent before DB row was created — safe to ignore
      })
    }

    return NextResponse.redirect(new URL('/auth/set-password', origin))
  }

  // For recovery (password reset): go to next or set-password
  return NextResponse.redirect(new URL(next, origin))
}
```

- [ ] **Step 3: Create the set-password page**

Used after accepting an invite and after clicking a password reset link.

```tsx
// src/app/auth/set-password/page.tsx
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { ChefHat, CheckCircle } from 'lucide-react'

export default function SetPasswordPage() {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }
    setLoading(true)
    setError('')
    const supabase = createClient()
    const { error } = await supabase.auth.updateUser({ password })
    setLoading(false)
    if (error) {
      setError(error.message)
    } else {
      setDone(true)
      setTimeout(() => router.push('/'), 1500)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 w-full max-w-sm">
        <div className="flex items-center gap-2 mb-8">
          <div className="w-9 h-9 bg-blue-600 rounded-xl flex items-center justify-center">
            <ChefHat size={18} className="text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-gray-900 leading-tight">Set your password</h1>
            <p className="text-xs text-gray-400">Choose a password to secure your account</p>
          </div>
        </div>

        {done ? (
          <div className="flex items-center gap-2 text-green-600 text-sm">
            <CheckCircle size={16} />
            Password set! Redirecting…
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
                New Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
                Confirm Password
              </label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                autoComplete="new-password"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 text-white py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {loading ? 'Saving…' : 'Set password'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Verify build**

```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npm run build 2>&1 | tail -8
```

Expected: `✓ Compiled` with routes `/login`, `/auth/callback`, `/auth/set-password` in the output.

- [ ] **Step 5: Commit**

```bash
git add src/app/login/ src/app/auth/
git commit -m "feat: add login, auth callback, and set-password pages"
```

---

## Task 6: UserContext, `/api/me`, Layout + Navigation Updates

**Files:**
- Create: `src/contexts/UserContext.tsx`
- Create: `src/app/api/me/route.ts`
- Modify: `src/app/layout.tsx`
- Modify: `src/components/Navigation.tsx`

- [ ] **Step 1: Create `/api/me`**

```typescript
// src/app/api/me/route.ts
import { NextResponse } from 'next/server'
import { requireSession, AuthError } from '@/lib/auth'

export async function GET() {
  try {
    const user = await requireSession()
    return NextResponse.json({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    })
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
}
```

- [ ] **Step 2: Create `UserContext`**

```tsx
// src/contexts/UserContext.tsx
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
```

- [ ] **Step 3: Wrap `src/app/layout.tsx` with `UserProvider`**

Replace the entire file with:

```tsx
// src/app/layout.tsx
import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { Navigation } from '@/components/Navigation'
import { MobileRcBar } from '@/components/navigation/MobileRcBar'
import { GlobalSearch } from '@/components/GlobalSearch'
import { RcProvider } from '@/contexts/RevenueCenterContext'
import { UserProvider } from '@/contexts/UserContext'
import { AiChat } from '@/components/AiChat'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'CONTROLA OS',
  description: 'Restaurant Management System for Fergie\'s Kitchen',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <UserProvider>
          <RcProvider>
            <Navigation />
            <MobileRcBar />
            <GlobalSearch />
            <main className="md:ml-56 pb-20 md:pb-0 pt-10 md:pt-0 min-h-screen bg-gray-50">
              <div className="p-4 md:p-6 max-w-7xl mx-auto">
                {children}
              </div>
            </main>
            <AiChat />
          </RcProvider>
        </UserProvider>
      </body>
    </html>
  )
}
```

- [ ] **Step 4: Hide Settings nav item for non-ADMIN users**

Open `src/components/Navigation.tsx`. Make these three targeted edits:

**Edit 1** — Add `useUser` import after the existing context imports (around line 13):

```typescript
import { useUser } from '@/contexts/UserContext'
```

**Edit 2** — The file exports a `Navigation` function which renders inner components. Find the inner component that renders desktop sidebar links (it maps over `navItems`). That component uses `usePathname`. Add `useUser` next to it and filter the items:

Locate the line pattern:
```typescript
const pathname = usePathname()
```

Add immediately after it (inside whichever inner component renders `navItems`):
```typescript
const { role } = useUser()
const visibleNavItems = navItems.filter(item =>
  item.href !== '/settings' || role === 'ADMIN'
)
```

Then replace every occurrence of `navItems.map(` (in the desktop sidebar) with `visibleNavItems.map(`.

**Edit 3** — Find the component that renders the mobile More drawer (it maps over `mobileMore`). Add inside it:

```typescript
const { role } = useUser()
const visibleMobileMore = mobileMore.filter(item =>
  item.href !== '/settings' || role === 'ADMIN'
)
```

Replace `mobileMore.map(` in that component with `visibleMobileMore.map(`.

> **Note:** The Navigation.tsx file defines multiple inner components at module scope. Each component that renders a nav list needs its own `useUser()` call — hooks cannot be shared across component boundaries.

- [ ] **Step 5: Verify build**

```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npm run build 2>&1 | tail -8
```

Expected: `✓ Compiled` with no errors.

- [ ] **Step 6: Commit**

```bash
git add src/contexts/UserContext.tsx src/app/api/me/ src/app/layout.tsx src/components/Navigation.tsx
git commit -m "feat: add UserContext, /api/me, and role-based nav visibility"
```

---

## Task 7: Auth-Gate Sensitive API Routes + Scope Chat to User

**Files:**
- Modify: `src/app/api/chat/conversations/route.ts`
- Modify: `src/app/api/chat/conversations/[id]/route.ts`
- Modify: `src/app/api/chat/conversations/[id]/messages/route.ts`
- Modify: `src/app/api/chat/route.ts`
- Modify: `src/app/api/invoices/sessions/[id]/approve/route.ts`
- Modify: `src/app/api/reports/dashboard/route.ts`
- Modify: `src/app/api/reports/analytics/route.ts`
- Modify: `src/app/api/reports/cogs/route.ts`
- Modify: `src/app/api/reports/cogs-from-counts/route.ts`
- Modify: `src/app/api/reports/theoretical-usage/route.ts`
- Modify: `src/app/api/digest/route.ts`

The pattern is the same for every route. At the top of each handler function, add:

```typescript
import { requireSession, AuthError } from '@/lib/auth'

// Inside the handler:
let user
try { user = await requireSession('MANAGER') } // or 'ADMIN', or no arg
catch (e) {
  if (e instanceof AuthError)
    return NextResponse.json({ error: e.message }, { status: e.status })
  throw e
}
```

- [ ] **Step 1: Update chat conversations list + create**

Replace `src/app/api/chat/conversations/route.ts` entirely:

```typescript
// src/app/api/chat/conversations/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

// GET — list conversations for the current user
export async function GET() {
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const conversations = await prisma.chatConversation.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: 'desc' },
    include: { _count: { select: { messages: true } } },
    take: 50,
  })
  return NextResponse.json(conversations)
}

// POST — create a new conversation for the current user
export async function POST(req: NextRequest) {
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const { title } = await req.json()
  const conversation = await prisma.chatConversation.create({
    data: {
      userId: user.id,
      title: title?.trim()?.slice(0, 80) || 'New conversation',
    },
  })
  return NextResponse.json(conversation, { status: 201 })
}
```

- [ ] **Step 2: Update conversation GET/DELETE (scope to owner)**

Replace `src/app/api/chat/conversations/[id]/route.ts` entirely:

```typescript
// src/app/api/chat/conversations/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const conversation = await prisma.chatConversation.findFirst({
    where: { id: params.id, userId: user.id },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  })
  if (!conversation) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(conversation)
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  // Only delete if the conversation belongs to this user
  await prisma.chatConversation.deleteMany({ where: { id: params.id, userId: user.id } })
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 3: Auth-gate messages endpoint**

At the top of `src/app/api/chat/conversations/[id]/messages/route.ts`, add the import and guard. Replace the file entirely:

```typescript
// src/app/api/chat/conversations/[id]/messages/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const messages: { role: string; content: string }[] = await req.json()
  await prisma.chatMessage.createMany({
    data: messages.map(m => ({ conversationId: params.id, role: m.role, content: m.content })),
  })
  await prisma.chatConversation.update({
    where: { id: params.id },
    data: { updatedAt: new Date() },
  })
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 4: Auth-gate the chat streaming route**

In `src/app/api/chat/route.ts`, add the auth guard at the top of the `POST` handler. Find the `export async function POST` line and insert before the `try` block:

```typescript
import { requireSession, AuthError } from '@/lib/auth'

// Inside POST, before the existing try block:
try { await requireSession() }
catch (e) {
  if (e instanceof AuthError) return new Response(e.message, { status: e.status })
  throw e
}
```

- [ ] **Step 5: Auth-gate invoice approve (MANAGER)**

In `src/app/api/invoices/sessions/[id]/approve/route.ts`, add at the top of the `POST` handler (before `const body = await req.json()`):

```typescript
import { requireSession, AuthError } from '@/lib/auth'

// Inside POST, first lines:
let currentUser
try { currentUser = await requireSession('MANAGER') }
catch (e) {
  if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
  throw e
}
```

Then replace the `approvedBy` line:

```typescript
// Replace: const approvedBy: string = body.approvedBy || 'Manager'
// With:
const approvedBy: string = currentUser.name ?? currentUser.email
```

- [ ] **Step 6: Auth-gate all 5 reports routes (MANAGER)**

For each of these 5 files, add the same guard at the top of their `GET` handler:

Files: `src/app/api/reports/dashboard/route.ts`, `src/app/api/reports/analytics/route.ts`, `src/app/api/reports/cogs/route.ts`, `src/app/api/reports/cogs-from-counts/route.ts`, `src/app/api/reports/theoretical-usage/route.ts`

Add this import at the top of each file:
```typescript
import { requireSession, AuthError } from '@/lib/auth'
```

Add this block as the first lines inside each `GET` handler:
```typescript
try { await requireSession('MANAGER') }
catch (e) {
  if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
  throw e
}
```

- [ ] **Step 7: Auth-gate digest (ADMIN)**

In `src/app/api/digest/route.ts`, add at the top of the `POST` handler (before `const body = await req.json()`):

```typescript
import { requireSession, AuthError } from '@/lib/auth'

// Inside POST, first lines:
try { await requireSession('ADMIN') }
catch (e) {
  if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
  throw e
}
```

- [ ] **Step 8: Verify build**

```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npm run build 2>&1 | tail -8
```

Expected: `✓ Compiled` with no TypeScript errors across all modified routes.

- [ ] **Step 9: Commit**

```bash
git add src/app/api/chat/ src/app/api/invoices/sessions/ src/app/api/reports/ src/app/api/digest/
git commit -m "feat: auth-gate sensitive API routes and scope chat history to user"
```

---

## Task 8: User Management API

**Files:**
- Create: `src/app/api/settings/users/route.ts`
- Create: `src/app/api/settings/users/[id]/route.ts`

- [ ] **Step 1: Create `src/app/api/settings/users/route.ts`**

```typescript
// src/app/api/settings/users/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { Role } from '@prisma/client'

const VALID_ROLES: Role[] = ['ADMIN', 'MANAGER', 'STAFF']

// GET — list all users (ADMIN only)
export async function GET() {
  try { await requireSession('ADMIN') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'asc' },
    select: { id: true, email: true, name: true, role: true, isActive: true, createdAt: true },
  })
  return NextResponse.json(users)
}

// POST — invite a new user (ADMIN only)
// Body: { email: string, role: 'ADMIN' | 'MANAGER' | 'STAFF', name?: string }
export async function POST(req: NextRequest) {
  let admin
  try { admin = await requireSession('ADMIN') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const body = await req.json().catch(() => ({}))
  const { email, role, name } = body as { email?: string; role?: string; name?: string }

  if (!email?.trim()) {
    return NextResponse.json({ error: 'email is required' }, { status: 400 })
  }
  if (!role || !VALID_ROLES.includes(role as Role)) {
    return NextResponse.json({ error: 'role must be ADMIN, MANAGER, or STAFF' }, { status: 400 })
  }
  if (admin.email === email.trim()) {
    return NextResponse.json({ error: 'Cannot invite yourself' }, { status: 400 })
  }

  // Send invite via Supabase — creates Auth user + sends email
  const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email.trim(), {
    data: { role, isActive: true, name: name?.trim() ?? null },
    redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback`,
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }

  // Create the Prisma User row using the Supabase Auth UUID
  const user = await prisma.user.upsert({
    where: { id: data.user.id },
    create: {
      id: data.user.id,
      email: email.trim(),
      name: name?.trim() ?? null,
      role: role as Role,
      isActive: false, // will be set to true when they accept the invite
    },
    update: {
      role: role as Role,
      name: name?.trim() ?? null,
      isActive: false,
    },
  })

  return NextResponse.json(user, { status: 201 })
}
```

- [ ] **Step 2: Create `src/app/api/settings/users/[id]/route.ts`**

```typescript
// src/app/api/settings/users/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { Role } from '@prisma/client'

const VALID_ROLES: Role[] = ['ADMIN', 'MANAGER', 'STAFF']

// PATCH — update role or name (ADMIN only)
// Body: { role?: Role, name?: string }
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  let admin
  try { admin = await requireSession('ADMIN') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  if (admin.id === params.id) {
    return NextResponse.json({ error: 'Cannot modify your own account' }, { status: 400 })
  }

  const body = await req.json().catch(() => ({}))
  const { role, name } = body as { role?: string; name?: string }

  if (role && !VALID_ROLES.includes(role as Role)) {
    return NextResponse.json({ error: 'Invalid role' }, { status: 400 })
  }

  const updateData: { role?: Role; name?: string } = {}
  if (role) updateData.role = role as Role
  if (name !== undefined) updateData.name = name.trim() || null

  // Update Prisma
  const user = await prisma.user.update({
    where: { id: params.id },
    data: updateData,
  }).catch(() => null)

  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  // Sync role to Supabase user_metadata so middleware picks it up immediately
  if (role) {
    await supabaseAdmin.auth.admin.updateUserById(params.id, {
      user_metadata: { role },
    })
  }

  return NextResponse.json({ id: user.id, email: user.email, name: user.name, role: user.role })
}

// DELETE — deactivate a user (ADMIN only)
// Sets isActive: false in Prisma and user_metadata.isActive: false in Supabase
// so middleware redirects them to /login on their next request.
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  let admin
  try { admin = await requireSession('ADMIN') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  if (admin.id === params.id) {
    return NextResponse.json({ error: 'Cannot deactivate your own account' }, { status: 400 })
  }

  await prisma.user.update({
    where: { id: params.id },
    data: { isActive: false },
  }).catch(() => null)

  // Mark isActive: false in Supabase user_metadata — middleware will redirect them out
  await supabaseAdmin.auth.admin.updateUserById(params.id, {
    user_metadata: { isActive: false },
  })

  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 3: Verify build**

```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npm run build 2>&1 | tail -8
```

Expected: `✓ Compiled` with `/api/settings/users` and `/api/settings/users/[id]` in the route list.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/settings/
git commit -m "feat: add user management API (invite, list, update role, deactivate)"
```

---

## Task 9: User Management UI + Settings Layout Update

**Files:**
- Create: `src/app/settings/users/page.tsx`
- Modify: `src/app/settings/layout.tsx`

- [ ] **Step 1: Create the Users settings page**

```tsx
// src/app/settings/users/page.tsx
'use client'
import { useState, useEffect, useCallback } from 'react'
import { Users, Send, AlertCircle, CheckCircle, MoreHorizontal, Trash2 } from 'lucide-react'
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
```

- [ ] **Step 2: Add Team group to settings sidebar**

Replace `src/app/settings/layout.tsx` entirely:

```tsx
// src/app/settings/layout.tsx
'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Settings, Layers, ChevronRight, Users } from 'lucide-react'

const sections = [
  {
    group: 'General',
    items: [
      { href: '/settings', label: 'General', icon: Settings, description: 'Email digest and notifications' },
    ],
  },
  {
    group: 'Management',
    items: [
      { href: '/settings/revenue-centers', label: 'Revenue Centers', icon: Layers, description: 'Manage profit centers and allocations' },
    ],
  },
  {
    group: 'Team',
    items: [
      { href: '/settings/users', label: 'Users', icon: Users, description: 'Invite and manage team members' },
    ],
  },
]

function SidebarNav() {
  const pathname = usePathname()

  return (
    <aside className="hidden md:block w-56 shrink-0">
      <h1 className="text-xl font-bold text-gray-900 mb-6 px-3">Settings</h1>
      <nav className="space-y-4">
        {sections.map(({ group, items }) => (
          <div key={group}>
            <p className="px-3 mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400">{group}</p>
            <div className="space-y-0.5">
              {items.map(({ href, label, icon: Icon }) => {
                const active = pathname === href
                return (
                  <Link
                    key={href}
                    href={href}
                    className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                      active
                        ? 'bg-blue-50 text-blue-700'
                        : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                    }`}
                  >
                    <Icon size={16} className={active ? 'text-blue-600' : 'text-gray-400'} />
                    {label}
                  </Link>
                )
              })}
            </div>
          </div>
        ))}
      </nav>
    </aside>
  )
}

function MobileSettingsIndex() {
  return (
    <div className="md:hidden">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Settings</h1>
      <div className="space-y-5">
        {sections.map(({ group, items }) => (
          <div key={group}>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-2 px-1">{group}</p>
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm divide-y divide-gray-50">
              {items.map(({ href, label, icon: Icon, description }) => (
                <Link
                  key={href}
                  href={href}
                  className="flex items-center gap-3 px-4 py-3.5 hover:bg-gray-50 transition-colors first:rounded-t-xl last:rounded-b-xl"
                >
                  <div className="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
                    <Icon size={16} className="text-gray-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900">{label}</p>
                    <p className="text-xs text-gray-400 truncate">{description}</p>
                  </div>
                  <ChevronRight size={16} className="text-gray-300 shrink-0" />
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const isRoot = pathname === '/settings'

  return (
    <div className="max-w-5xl mx-auto">
      <div className="hidden md:flex gap-10">
        <SidebarNav />
        <div className="flex-1 min-w-0 pt-1">{children}</div>
      </div>
      <div className="md:hidden">
        {isRoot ? (
          <MobileSettingsIndex />
        ) : (
          <div>
            <Link href="/settings" className="inline-flex items-center gap-1 text-sm text-blue-600 mb-4">
              <ChevronRight size={14} className="rotate-180" />
              Settings
            </Link>
            {children}
          </div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Verify build**

```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npm run build 2>&1 | tail -10
```

Expected: `✓ Compiled` with `/settings/users` visible in the route list.

- [ ] **Step 4: Commit**

```bash
git add src/app/settings/
git commit -m "feat: add user management UI and Team section to settings sidebar"
```

---

## Final Verification Checklist

Before calling this done, verify the following manually with the dev server running:

- [ ] `npm run dev` starts without errors
- [ ] Visiting `http://localhost:3000` redirects to `/login` (middleware working)
- [ ] Supabase env vars are filled in (get from Supabase Dashboard → Project Settings → API)
- [ ] In Supabase Dashboard → Auth → URL Configuration: set **Site URL** to `http://localhost:3000` and add `http://localhost:3000/auth/callback` to **Redirect URLs**
- [ ] Create the first Admin user manually in Supabase Dashboard → Auth → Users → "Add user" (use email + password, then set `user_metadata = { "role": "ADMIN", "isActive": true }` in the user editor)
- [ ] In Prisma: run `npx prisma studio` and create a matching `User` row with the same UUID, `role: ADMIN`, `isActive: true`
- [ ] Log in with that first admin user — should reach the dashboard
- [ ] Visit `/settings/users` — should see the Users page with invite form
- [ ] Send a test invite to a second email — verify the invite email arrives

> **Note on first Admin user:** There is a chicken-and-egg problem: the invite API requires an ADMIN, but there are no users yet. The first admin must be created manually in both Supabase Auth and Prisma. After that, all subsequent users can be invited through the UI.

---

## Environment Setup Summary

These values must be in `.env` before the auth system works:

```
NEXT_PUBLIC_SUPABASE_URL=https://your-project-id.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

Get `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` from: Supabase Dashboard → Project Settings → API → Project URL and anon/public key.

Get `SUPABASE_SERVICE_ROLE_KEY` from: Supabase Dashboard → Project Settings → API → service_role key (keep this secret — server-only).
