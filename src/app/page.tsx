import { redirect } from 'next/navigation'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export const dynamic = 'force-dynamic'

/**
 * v2 root route — role-based landing.
 *  Admin / Manager → /pass  (the daily-briefing landing)
 *  Staff          → /count  (counters jump straight to the canonical mobile flow)
 *
 * Unauthenticated traffic is already redirected to /login by middleware.
 */
export default async function RootPage() {
  const cookieStore = cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll() { /* no-op — root route doesn't refresh tokens */ },
      },
    },
  )

  const { data: { user } } = await supabase.auth.getUser()
  const role = (user?.user_metadata?.role as string | undefined) ?? 'STAFF'

  redirect(role === 'STAFF' ? '/count' : '/pass')
}
