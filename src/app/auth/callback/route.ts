import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextRequest, NextResponse } from 'next/server'
import type { EmailOtpType } from '@supabase/supabase-js'
import { prisma } from '@/lib/prisma'

// A route handler that reads the request URL is already dynamic, but make it
// explicit so it is never statically optimised.
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const token_hash = searchParams.get('token_hash')
  const type = searchParams.get('type') as EmailOtpType | null
  const code = searchParams.get('code')
  const rawNext = searchParams.get('next') ?? '/'
  // Prevent open redirect: only allow relative paths
  const next = rawNext.startsWith('/') ? rawNext : '/'

  // Buffer the cookies Supabase emits while verifying. Cookies mutated via
  // next/headers cookies() are NOT reliably applied to an explicit
  // NextResponse.redirect(), which dropped the session Set-Cookie headers and
  // caused "Auth session missing" on the set-password page. We collect them
  // here and attach them to the final redirect response below.
  const pendingCookies: { name: string; value: string; options: CookieOptions }[] = []

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => { pendingCookies.push(...cookiesToSet) },
      },
    }
  )

  // Two verification paths:
  //  - token_hash + type → verifyOtp (used by invite / recovery email links
  //    whose template emits {{ .TokenHash }}). Self-contained, no PKCE cookie.
  //  - code → exchangeCodeForSession (PKCE flow for browser-initiated links).
  let verified = false
  if (token_hash && type) {
    const { error } = await supabase.auth.verifyOtp({ token_hash, type })
    verified = !error
  } else if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    verified = !error
  }

  if (!verified) {
    return NextResponse.redirect(new URL('/login?error=invalid_link', origin))
  }

  // Activate the user's Prisma row (invites land here with isActive: false).
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser()

  if (authUser) {
    await prisma.user.update({
      where: { id: authUser.id },
      data: { isActive: true },
    }).catch(() => {
      // User row may not exist yet — safe to ignore
    })
  }

  // Invites and password recoveries both need the user to set a password.
  const destination =
    type === 'invite' || type === 'recovery' || next === '/auth/set-password'
      ? '/auth/set-password'
      : next

  const response = NextResponse.redirect(new URL(destination, origin))
  for (const { name, value, options } of pendingCookies) {
    response.cookies.set(name, value, options)
  }
  return response
}
