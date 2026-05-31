import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

/**
 * v2 root route → /today.
 *
 * /today is the mobile home (role-adaptive). On desktop it bounces by role
 * (MANAGER/ADMIN → /pass, STAFF → /count), preserving the previous behaviour.
 *
 * Unauthenticated traffic is already redirected to /login by middleware.
 */
export default async function RootPage() {
  redirect('/today')
}
