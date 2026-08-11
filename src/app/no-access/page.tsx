import type { Role } from '@prisma/client'
import { ROLE_RANK } from '@/lib/roles'
import { navLabelFor } from '@/lib/nav-items'
import { NoAccessCard } from '@/components/access/NoAccessCard'

// Reached by a middleware rewrite, never by a redirect — the browser URL stays
// on the page the user asked for. Must be dynamic: the rendered content depends
// on the ?from and ?need params middleware attaches per request.
export const dynamic = 'force-dynamic'

function asRole(value: string | string[] | undefined): Role | null {
  if (typeof value !== 'string') return null
  return Object.prototype.hasOwnProperty.call(ROLE_RANK, value) ? (value as Role) : null
}

export default function NoAccessPage({
  searchParams,
}: {
  searchParams: { from?: string | string[]; need?: string | string[] }
}) {
  const from = typeof searchParams.from === 'string' ? searchParams.from : null
  return (
    <NoAccessCard
      pageLabel={from ? navLabelFor(from) : null}
      need={asRole(searchParams.need)}
    />
  )
}
