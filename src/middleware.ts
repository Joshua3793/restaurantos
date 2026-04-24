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

  // Deactivated users → redirect to login
  // Use !== true (not === false) so a missing isActive key is also treated as
  // blocked — e.g. the first admin created manually without setting metadata.
  if (user.user_metadata?.isActive !== true) {
    return NextResponse.redirect(new URL('/login?error=deactivated', request.url))
  }

  // Role-based route restrictions (read from user_metadata — no DB query needed)
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
     * - /api/* routes — API routes return JSON; requireSession() handles auth there.
     *   Without this exclusion, unauthenticated fetch() calls from the login page
     *   would receive an HTML redirect instead of a JSON 401, breaking the client.
     */
    '/((?!_next/static|_next/image|favicon\\.ico|api/|.*\\..*).*)',
  ],
}
