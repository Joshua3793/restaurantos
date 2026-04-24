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

  // For invites: activate the Prisma User row (set isActive: true)
  if (type === 'invite') {
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

    return NextResponse.redirect(new URL('/auth/set-password', origin))
  }

  // For recovery (password reset)
  return NextResponse.redirect(new URL(next, origin))
}
