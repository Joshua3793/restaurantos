/**
 * TipRole DTO mapper. Lives here (not in the route file) because Next.js App
 * Router route.ts files may only export HTTP method handlers and the small
 * config allow-list — any other export fails the route-type check at build
 * time. Both `src/app/api/tips/roles/route.ts` and
 * `src/app/api/tips/roles/[id]/route.ts` import from here.
 */
import 'server-only'
import type { TipRole } from '@prisma/client'

export const toRoleDto = (r: TipRole) => ({
  id: r.id, name: r.name, multiplier: Number(r.multiplier), sortOrder: r.sortOrder,
})
