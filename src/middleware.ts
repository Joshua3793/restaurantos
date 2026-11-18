import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { atLeast } from '@/lib/roles'
import { pageAccess } from '@/lib/auth-access'
import { requiredClearance } from '@/lib/route-access'
import { sessionSignedInAt, signedInBeforeCutoff } from '@/lib/auth-day'

/**
 * Where a signed-out visitor goes: a phone that has asked for (or been OK'd
 * for) PIN sign-in carries the `pin_device` cookie, so it goes straight to the
 * PIN keypad; everyone else gets email and password. The PIN screen links to
 * email sign-in, so a manager on such a phone is one tap away.
 */
function signInPath(request: NextRequest): string {
  const device = request.cookies.get('pin_device')?.value
  return device && /^[A-Za-z0-9_-]{43}$/.test(device) ? '/auth/pin' : '/login'
}

// Routes that never require authentication
const PUBLIC_PREFIXES = ['/login', '/auth']

// v2 redesign: 301 redirects from old URLs to new IA.
// Order: longest match first.
const REDIRECTS: Array<[string, string]> = [
  ['/inventory/count',         '/count'],
  ['/inventory/storage-areas', '/setup/storage-areas'],
  ['/inventory/categories',    '/setup/categories'],
  ['/revenue-centers',         '/setup/revenue-centers'],
  ['/suppliers',               '/setup/suppliers'],
  ['/settings/users',          '/setup/users'],
  ['/settings/revenue-centers','/setup/revenue-centers'],
  ['/settings',                '/setup'],
  ['/setup/kitchen-crew',      '/setup/users'],
  ['/reports/theoretical-usage','/variance'],
  ['/reports/signals',         '/signals'],
  ['/cost',                    '/reports'],
  // Phone sign-ins and alert tags moved into Setup.
  ['/checklist/crew',          '/setup/sign-ins'],
  ['/inbox/tags',              '/setup/alert-tags'],
  // The old kitchen-wide lists were replaced by station checklists.
  ['/setup/open-checklist',    '/checklist/edit'],
  ['/setup/eod-checklist',     '/checklist/edit'],
]

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl

  // Always allow public routes
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next()
  }

  // v2 IA redirects — fire BEFORE auth so external bookmarks land in the right place,
  // then the new URL goes through auth as usual.
  // Pre-shift became the Pass's "Ready for doors" (/today picks the right
  // Pass for the role: managers on a desktop go on to /pass).
  if (pathname === '/preshift' || pathname.startsWith('/preshift/')) {
    return NextResponse.redirect(new URL('/today', request.url), 308)
  }
  // End-of-day became "Close the day" on the closing board.
  if (pathname === '/end-of-day' || pathname.startsWith('/end-of-day/')) {
    return NextResponse.redirect(new URL('/checklist/today?phase=CLOSE', request.url), 308)
  }

  for (const [from, to] of REDIRECTS) {
    if (pathname === from || pathname.startsWith(from + '/')) {
      const rest = pathname.slice(from.length)
      return NextResponse.redirect(new URL(to + rest + search, request.url), 308)
    }
  }

  // LOCAL-DEV ONLY: skip auth entirely when the bypass flag is set. Hard-gated to
  // non-production (NODE_ENV is 'production' on deployed builds), so this can never
  // disable auth in production. requireSession() applies the same bypass for APIs.
  if (process.env.NODE_ENV !== 'production' && process.env.DEV_AUTH_BYPASS === 'true') {
    return NextResponse.next({ request })
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
    return NextResponse.redirect(new URL(signInPath(request), request.url))
  }

  // Everyone is signed out at 02:00 restaurant time so each morning starts
  // with a fresh sign-in. The session's sign-in time rides in the (already
  // verified) access token and survives token refreshes.
  const { data: { session } } = await supabase.auth.getSession()
  if (signedInBeforeCutoff(sessionSignedInAt(session?.access_token, user.last_sign_in_at), new Date())) {
    try {
      // This device only; clears the auth cookies through setAll above.
      await supabase.auth.signOut({ scope: 'local' })
    } catch {
      // Cookies are cleared below whether or not Supabase answered.
    }
    const out = NextResponse.redirect(new URL(signInPath(request), request.url))
    response.cookies.getAll().forEach(cookie => out.cookies.set(cookie))
    for (const { name } of request.cookies.getAll()) {
      if (name.startsWith('sb-') && !out.cookies.get(name)) out.cookies.set(name, '', { path: '/', maxAge: 0 })
    }
    return out
  }

  // Page access comes from app_metadata, which only the service role can
  // write — never user_metadata, which any signed-in user can rewrite from the
  // browser. A missing isActive is blocked (e.g. a login no writer has stamped
  // yet); an unknown role falls back to STAFF; a PIN login caps at LEAD.
  const { active, role } = pageAccess(user)
  if (!active) {
    return NextResponse.redirect(new URL('/login?error=deactivated', request.url))
  }

  // Role-gated route the user cannot reach → RENDER the no-access screen at
  // this URL. Deliberately a rewrite, not a redirect: the address bar keeps
  // reading /pass, back/forward behave, and the user can carry on navigating
  // from the sidebar instead of being flung back to /count with no explanation.
  const need = requiredClearance(pathname)
  if (need && !atLeast(role, need)) {
    const url = request.nextUrl.clone()
    url.pathname = '/no-access'
    url.searchParams.set('from', pathname)
    url.searchParams.set('need', need)
    const blocked = NextResponse.rewrite(url)
    // Carry over any session cookie the Supabase client rotated above. Unlike
    // the redirect this replaced, a rewrite is terminal — there is no follow-up
    // request to re-refresh on, so dropping them here strands the client with a
    // spent refresh token for as long as it stays on a gated URL.
    response.cookies.getAll().forEach(cookie => blocked.cookies.set(cookie))
    return blocked
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
     * - /api/* routes — API routes return JSON; requireSession() handles auth there.
     *   Without this exclusion, unauthenticated fetch() calls from the login page
     *   would receive an HTML redirect instead of a JSON 401, breaking the client.
     */
    '/((?!_next/static|_next/image|favicon\\.ico|api/|.*\\..*).*)',
  ],
}
