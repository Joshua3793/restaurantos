/**
 * One-time, idempotent clearance backfill. Run AFTER the code is deployed.
 *
 * USAGE
 *   npx tsx scripts/migrate-clearance.ts            # dry run (default, read-only, safe to re-run anytime)
 *   npx tsx scripts/migrate-clearance.ts --apply    # perform it (mutates Prisma + Supabase)
 *
 * Requires a `.env` at the repo root (or a symlink to one) with DATABASE_URL,
 * DIRECT_URL, NEXT_PUBLIC_SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY. Always
 * run the dry run first and read its output before passing --apply.
 *
 * 1. Promote the oldest active ADMIN to OWNER in BOTH stores (Prisma +
 *    Supabase user_metadata). No-op when an OWNER already exists.
 * 2. Grandfather every non-Owner/non-Admin user with zero UserScope rows:
 *    one row per active Location, clearance = null (inherit).
 *
 * Re-running is safe: both steps check current state first.
 */

// Load .env explicitly, before anything below reads process.env. `tsx` does
// not auto-load `.env` files on its own (there is no dotenv/loadEnvFile
// logic in its CLI), and this script must not depend on some *other*
// import in the graph incidentally populating process.env as a side effect
// of its own unrelated env resolution (e.g. Prisma resolving DATABASE_URL
// for the datasource) — that's undocumented, version-dependent behavior,
// not a contract, and it happens to cover Prisma's own vars but nothing
// guarantees it covers the Supabase vars this script also needs below. Do
// not remove this call thinking it's redundant — it is the only reliable,
// explicit source of these vars for this script.
try {
  process.loadEnvFile()
} catch (err) {
  console.error(
    '\nFailed to load .env — this script needs one at the repo root ' +
      '(DATABASE_URL, DIRECT_URL, NEXT_PUBLIC_SUPABASE_URL, ' +
      'SUPABASE_SERVICE_ROLE_KEY) to run.\n' +
      `Underlying error: ${err instanceof Error ? err.message : String(err)}\n`,
  )
  process.exit(1)
}

import { PrismaClient } from '@prisma/client'
import { createClient } from '@supabase/supabase-js'

const prisma = new PrismaClient()
const APPLY = process.argv.includes('--apply')
const log = (...a: unknown[]) => console.log(APPLY ? '[apply]' : '[dry-run]', ...a)

async function main() {
  // ── 1. Owner ────────────────────────────────────────────────────────────
  const existingOwner = await prisma.user.findFirst({ where: { role: 'OWNER' } })
  if (existingOwner) {
    log(`Owner already set: ${existingOwner.email} — skipping promotion.`)
  } else {
    const candidate = await prisma.user.findFirst({
      where: { role: 'ADMIN', isActive: true },
      orderBy: { createdAt: 'asc' },
    })
    if (!candidate) {
      log('No active ADMIN found — no owner to promote.')
    } else {
      log(`Promote to OWNER: ${candidate.email} (created ${candidate.createdAt.toISOString()})`)
      if (APPLY) {
        const supabase = createClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!,
          { auth: { autoRefreshToken: false, persistSession: false } },
        )
        // Supabase first: if it fails we have not yet touched Prisma, so the
        // two stores cannot diverge.
        const { error } = await supabase.auth.admin.updateUserById(candidate.id, {
          user_metadata: { role: 'OWNER', isActive: true, name: candidate.name },
        })
        if (error) throw new Error(`Supabase metadata update failed: ${error.message}`)
        await prisma.user.update({ where: { id: candidate.id }, data: { role: 'OWNER' } })
        log('Owner promoted in both stores.')
      }
    }
  }

  // ── 2. Grandfather assignments ──────────────────────────────────────────
  const locations = await prisma.location.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
  })
  if (locations.length === 0) {
    log('No active locations — nothing to grandfather.')
  } else {
    const unassigned = await prisma.user.findMany({
      where: {
        role: { in: ['MANAGER', 'LEAD', 'STAFF'] },
        scopes: { none: {} },
      },
      select: { id: true, email: true, role: true },
    })
    log(
      `${unassigned.length} user(s) with no assignments → ` +
      `${unassigned.length * locations.length} row(s) across ${locations.length} location(s).`,
    )
    for (const u of unassigned) log(`  · ${u.email} (${u.role})`)

    if (APPLY && unassigned.length > 0) {
      await prisma.userScope.createMany({
        data: unassigned.flatMap(u =>
          locations.map(l => ({ userId: u.id, locationId: l.id, clearance: null })),
        ),
        skipDuplicates: true,
      })
      log('Grandfather rows written.')
    }
  }

  if (!APPLY) log('\nNothing was changed. Re-run with --apply to perform it.')
}

main()
  .catch(e => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
