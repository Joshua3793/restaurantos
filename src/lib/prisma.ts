import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

const log: ('error')[] = process.env.NODE_ENV === 'development' ? ['error'] : []

/**
 * The app talks to Postgres through node-postgres (the `pg` driver adapter), not
 * Prisma's built-in engine connection.
 *
 * Why: DATABASE_URL is Supabase's transaction-mode pooler. With `?pgbouncer=true`
 * the built-in connection wraps EVERY query in BEGIN · DEALLOCATE ALL · query ·
 * COMMIT — four round trips for one read — because it may not reuse named prepared
 * statements through the pooler. `pg` sends unnamed statements, which the pooler
 * handles natively, so each query is one round trip (measured: a simple read
 * 239 ms → 43 ms from outside the region; a 3-level include 654 → 272 ms).
 *
 * - `pgbouncer` is a Prisma-only URL flag; it is stripped so `pg` doesn't pass
 *   it to the server.
 * - TLS: `pg` connects in plain text unless told otherwise. `rejectUnauthorized:
 *   false` keeps today's protection exactly — encrypted, certificate not pinned
 *   (Prisma's default `sslmode=prefer`); Supabase's CA is not a public root.
 * - Kill switch: PRISMA_DRIVER=engine falls back to the built-in connection.
 */
function createClient(): PrismaClient {
  const url = process.env.DATABASE_URL
  if (process.env.PRISMA_DRIVER === 'engine' || !url) return new PrismaClient({ log })
  const u = new URL(url)
  u.searchParams.delete('pgbouncer')
  const pool = new Pool({
    connectionString: u.toString(),
    ssl: { rejectUnauthorized: false },
    // Same per-instance ceiling the built-in connection used (2 vCPU × 2 + 1),
    // so the pooler sees no more client connections than before.
    max: 5,
    // Fail a query fast instead of hanging when the pooler can't be reached,
    // and drop idle sockets before the pooler or a frozen instance does.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
  })
  // An idle socket the pooler closes surfaces as a pool 'error' event; with no
  // listener Node treats it as uncaught and kills the instance. The pool already
  // discards that client — just record it.
  pool.on('error', err => { console.error('[prisma pg pool] idle client error:', err.message) })
  return new PrismaClient({ adapter: new PrismaPg(pool), log })
}

export const prisma = globalForPrisma.prisma ?? createClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
