/**
 * One-time, idempotent: copy every login's `{role,isActive}` from the Prisma
 * User row into Supabase `app_metadata`, which is what the page gate
 * (src/middleware.ts via src/lib/auth-access.ts) reads now. Until a login has
 * it, middleware treats it as switched off — so run this BEFORE the
 * app_metadata page gate goes live. The old code ignores these keys, so
 * running it early is harmless.
 *
 * USAGE
 *   npx tsx scripts/backfill-auth-app-metadata.ts            # dry run (default, read-only)
 *   npx tsx scripts/backfill-auth-app-metadata.ts --apply    # write app_metadata (live Supabase)
 *
 * Requires a `.env` at the repo root with DATABASE_URL, NEXT_PUBLIC_SUPABASE_URL
 * and SUPABASE_SERVICE_ROLE_KEY. Prisma is the source of truth (requireSession
 * reads it). An auth user with no Prisma row gets `isActive: false`. Supabase
 * merges app_metadata key by key, so `provider` and `pinCookId` are kept.
 * Nothing is written to Prisma or to user_metadata.
 */

// tsx does not load .env by itself — see scripts/migrate-clearance.ts.
try {
  process.loadEnvFile()
} catch (err) {
  console.error(
    '\nFailed to load .env — this script needs one at the repo root ' +
      '(DATABASE_URL, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).\n' +
      `Underlying error: ${err instanceof Error ? err.message : String(err)}\n`,
  )
  process.exit(1)
}

import { PrismaClient } from '@prisma/client'
import { createClient, type SupabaseClient, type User as AuthUser } from '@supabase/supabase-js'
import { accessAppMetadata, accessMetadataInSync } from '@/lib/auth-access'

const prisma = new PrismaClient()
const APPLY = process.argv.includes('--apply')
const log = (...a: unknown[]) => console.log(APPLY ? '[apply]' : '[dry-run]', ...a)

async function allAuthUsers(admin: SupabaseClient): Promise<AuthUser[]> {
  const out: AuthUser[] = []
  const perPage = 1000
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage })
    if (error) throw error
    out.push(...data.users)
    if (data.users.length < perPage) break
  }
  return out
}

async function main() {
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const users = await allAuthUsers(admin)
  const rows = await prisma.user.findMany({
    where: { id: { in: users.map((u) => u.id) } },
    select: { id: true, role: true, isActive: true },
  })
  const byId = new Map(rows.map((r) => [r.id, r]))

  let inSync = 0
  let written = 0
  let failed = 0
  for (const u of users) {
    const row = byId.get(u.id) ?? null
    if (accessMetadataInSync(u.app_metadata, row)) {
      inSync++
      continue
    }
    const next = row ? accessAppMetadata(row) : { isActive: false }
    const before = { role: u.app_metadata?.role, isActive: u.app_metadata?.isActive }
    log(`${u.email ?? u.id}: ${JSON.stringify(before)} → ${JSON.stringify(next)}${row ? '' : ' (no app user row)'}`)
    if (!APPLY) continue
    const { error } = await admin.auth.admin.updateUserById(u.id, { app_metadata: next })
    if (error) {
      failed++
      console.error(`  ✗ ${u.email ?? u.id}: ${error.message}`)
    } else {
      written++
    }
  }

  log(`${users.length} logins: ${inSync} already in sync, ${APPLY ? `${written} written, ${failed} failed` : `${users.length - inSync} to write`}`)
  if (failed) process.exitCode = 1
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
