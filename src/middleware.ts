import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import type { Role } from '@prisma/client'
import { atLeast, ROLE_RANK } from '@/lib/roles'
import { requiredClearance } from '@/lib/route-access'

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
  ['/reports/theoretical-usage','/variance'],
  ['/reports/signals',         '/signals'],
  ['/cost',                    '/reports'],
]

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl

  // Always allow public routes
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next()
  }

  // v2 IA redirects — fire BEFORE auth so external bookmarks land in the right place,
  // then the new URL goes through auth as usual.
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
    return NextResponse.redirect(new URL('/login', request.url))
  }

  // Deactivated users → redirect to login
  // Use !== true (not === false) so a missing isActive key is also treated as
  // blocked — e.g. the first admin created manually without setting metadata.
  if (user.user_metadata?.isActive !== true) {
    return NextResponse.redirect(new URL('/login?error=deactivated', request.url))
  }

  // Role-based route restrictions (read from user_metadata — no DB query needed)
  // Unknown / missing metadata falls back to STAFF, the least privileged level.
  const rawRole = user.user_metadata?.role as string | undefined
  const role: Role =
    rawRole && Object.prototype.hasOwnProperty.call(ROLE_RANK, rawRole)
      ? (rawRole as Role)
      : 'STAFF'

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
    return NextResponse.rewrite(url)
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
