# Authentication & Multi-User Access Design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add invite-based authentication and role-based access control to Fergie's OS so multiple users can securely share the same database.

**Architecture:** Supabase Auth handles sessions, invites, and password management. A `User` table in Prisma stores each user's role and links to their Supabase Auth UUID. Next.js middleware enforces authentication on every route, with role checks at both the middleware and API layers.

**Tech Stack:** Supabase Auth (`@supabase/ssr`, `@supabase/supabase-js`), Next.js 14 App Router middleware, Prisma, React Context for client-side role access.

---

## Data Model

### New `User` table

```prisma
model User {
  id                String             @id  // matches Supabase Auth user UUID
  email             String             @unique
  name              String?
  role              Role               @default(STAFF)
  isActive          Boolean            @default(true)
  createdAt         DateTime           @default(now())
  updatedAt         DateTime           @updatedAt
  chatConversations ChatConversation[]
}

enum Role {
  ADMIN
  MANAGER
  STAFF
}
```

### Modified `ChatConversation` table

Add `userId` (foreign key → `User`) so chat history is scoped per person. Existing conversations without a user are orphaned and can be cleared during migration.

### Multi-tenant readiness

No `Organization` model is added now. When multi-tenancy is needed, the migration adds `organizationId` to `User` and all data tables. Nothing in this design blocks that.

---

## Role Permission Matrix

| Action / Module | ADMIN | MANAGER | STAFF |
|---|---|---|---|
| Inventory (view & edit) | ✅ | ✅ | ✅ |
| Invoices (upload & scan) | ✅ | ✅ | ✅ |
| Invoices (approve) | ✅ | ✅ | ❌ |
| Reports & food cost | ✅ | ✅ | ❌ |
| Price alerts (acknowledge) | ✅ | ✅ | ❌ |
| Count, Prep, Wastage, Sales | ✅ | ✅ | ✅ |
| Settings & Revenue Centers | ✅ | ❌ | ❌ |
| User management (invite/remove) | ✅ | ❌ | ❌ |
| AI Chat (own history only) | ✅ | ✅ | ✅ |

Future extensibility: the `Role` enum can be replaced with a `Permission[]` join table when per-user custom permissions are needed (no structural rewrite required).

---

## Auth Flow

### Login
- Route: `/login` — email + password form
- On submit: call Supabase Auth `signInWithPassword()`
- Session JWT stored in `httpOnly` cookie via `@supabase/ssr`
- On success: redirect to `/`

### Invite flow
1. Admin opens **Settings → Users → Invite User**, enters email + selects role
2. App calls Supabase `inviteUserByEmail()` — Supabase sends the invite email automatically
3. A `User` row is created in Prisma immediately with `isActive: false` and the chosen role
4. New user clicks the link → `/auth/accept-invite` → sets password
5. On first authenticated request, middleware detects the Prisma `User` row exists and sets `isActive: true`
6. User is redirected to the app dashboard

### Password reset
- "Forgot password" link on `/login` → Supabase sends reset email
- User clicks link → `/auth/reset-password` → enters new password → Supabase updates credentials
- No custom email infrastructure needed

### Session lifecycle
- `@supabase/ssr` refreshes the JWT cookie automatically on each middleware run
- Logout: call `supabase.auth.signOut()` → cookie cleared → redirect to `/login`
- Deactivated users (`isActive: false`): middleware checks this flag and signs them out even if their JWT is still valid

---

## Route Protection

### `src/middleware.ts`

Runs on every request (except `_next/static`, `_next/image`, `favicon.ico`).

**Public routes** (no session required):
- `/login`
- `/auth/*`

**Authenticated routes** (any valid session):
- Everything else → no session → redirect to `/login`

**Role-restricted routes** (checked in middleware):
- `/settings/*` → ADMIN only → others redirected to `/`
- `/reports/*` → ADMIN or MANAGER → STAFF redirected to `/`

### `src/lib/auth.ts` — `requireSession()`

Helper used at the top of every API route handler:

```ts
export async function requireSession(
  req: NextRequest,
  minRole?: Role
): Promise<{ user: User }>
```

- Reads Supabase session from request cookies
- Looks up `User` row in Prisma by Supabase Auth UUID
- Returns `{ user }` on success
- Throws `401` if no session
- Throws `403` if `user.isActive === false`
- Throws `403` if `user.role` does not meet `minRole`

### API route enforcement

| Endpoint | Min role |
|---|---|
| `POST /api/invoices/sessions/[id]/approve` | MANAGER |
| `GET /api/reports/*` | MANAGER |
| `POST /api/digest` | ADMIN |
| `DELETE /api/chat/conversations/[id]` | owner (userId match) |
| All `/api/settings/*` and user management APIs | ADMIN |
| All other API routes | authenticated (any role) |

---

## Client-Side Role Access

### `GET /api/me`

Returns the current user's profile:
```json
{ "id": "...", "email": "...", "name": "...", "role": "MANAGER" }
```

### `UserContext` (`src/contexts/UserContext.tsx`)

Fetches `/api/me` once at app load (in the root layout). Provides `{ user, role }` to all client components. Used to:
- Hide nav items the user can't access (e.g. Settings hidden for STAFF and MANAGER)
- Disable action buttons (e.g. Approve Invoice button not rendered for STAFF)
- Show "You" badge on the user's own row in the Users table

UI hiding is a UX convenience only — the API layer is the real enforcement boundary.

---

## User Management UI

### `/settings/users` (ADMIN only)

**Invite panel** (top of page):
- Email input + role selector (Admin / Manager / Staff) + "Send Invite" button
- On submit: calls `POST /api/settings/users/invite`
- Shows success confirmation or error inline

**User table:**
| Column | Notes |
|---|---|
| Name / Email | Name shown if set, email always shown |
| Role | Dropdown — change saves immediately via `PATCH /api/settings/users/[id]` |
| Status | Active / Pending (invite not yet accepted) / Inactive |
| Actions | Deactivate (sets `isActive: false`, invalidates Supabase session) / Re-invite |

**Rules:**
- Logged-in admin's own row: role dropdown and deactivate button are disabled (prevent self-lockout)
- Deactivation does not delete the user or their data — full audit trail preserved
- Re-invite resends the Supabase invite email for pending users

### Settings sidebar update

Add a **Team** group to the sidebar with a single entry: **Users** → `/settings/users`.

---

## New Files

| File | Purpose |
|---|---|
| `src/middleware.ts` | Session check + role-based route blocking |
| `src/lib/auth.ts` | `requireSession()` helper for API routes |
| `src/lib/supabase/server.ts` | Supabase SSR client for server components & API routes |
| `src/lib/supabase/client.ts` | Supabase browser client for client components |
| `src/contexts/UserContext.tsx` | React context providing current user + role |
| `src/app/login/page.tsx` | Login page (email + password) |
| `src/app/auth/accept-invite/page.tsx` | New user sets password after invite |
| `src/app/auth/reset-password/page.tsx` | Password reset landing page |
| `src/app/settings/users/page.tsx` | User management UI (ADMIN only) |
| `src/app/api/me/route.ts` | Returns current user profile |
| `src/app/api/settings/users/route.ts` | List users + send invite |
| `src/app/api/settings/users/[id]/route.ts` | Update role, deactivate, re-invite |

## Modified Files

| File | Change |
|---|---|
| `prisma/schema.prisma` | Add `User` model, `Role` enum, `userId` on `ChatConversation` |
| `src/app/layout.tsx` | Wrap app in `UserProvider` |
| `src/app/settings/layout.tsx` | Add Team group + Users link to sidebar |
| `src/components/Navigation.tsx` | Hide Settings nav item for non-ADMIN |
| All existing API routes | Add `requireSession()` call at top of each handler |

---

## Environment Variables

Add to `.env`:
```
NEXT_PUBLIC_SUPABASE_URL=       # from Supabase project settings
NEXT_PUBLIC_SUPABASE_ANON_KEY=  # from Supabase project settings
SUPABASE_SERVICE_ROLE_KEY=      # for server-side admin operations (invite, deactivate)
```
