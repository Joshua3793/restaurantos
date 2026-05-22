import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { PREP_CATEGORIES as DEFAULT_CATEGORIES, PREP_STATIONS as DEFAULT_STATIONS } from '@/lib/prep-utils'

// CRITICAL: the GET handler below takes no `request` arg and uses no dynamic
// APIs, so Next.js would statically prerender this route at build time. A
// statically-prerendered route handler serves ONLY GET (as a cached file) —
// every other method (PUT/POST/…) returns 405 Method Not Allowed. That was the
// real cause of "Failed to save": the PUT handler never executed in production.
// force-dynamic keeps the route a live serverless function for all methods.
export const dynamic = 'force-dynamic'

/**
 * Serialise a JS string array to a PostgreSQL text-array literal.
 * e.g. ['Grill', 'Cold'] → '{"Grill","Cold"}'
 *
 * Used with $executeRawUnsafe so the value is embedded as a literal
 * (no parameterised binding → no prepared-statement restrictions → safe
 * with pgBouncer in transaction mode).
 */
function toPgTextArray(arr: string[]): string {
  const elements = arr.map(s =>
    '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
  )
  // Escape single quotes so the literal is safe inside a SQL single-quoted string
  // e.g. "Chef's Table" → the ' must become '' at the SQL level
  return ('{' + elements.join(',') + '}').replace(/'/g, "''")
}

export async function GET() {
  try {
    // Use only $queryRawUnsafe / $executeRawUnsafe — no ORM queries — so
    // pgBouncer transaction mode never sees named prepared statements.
    const rows = await prisma.$queryRawUnsafe<Array<{ categories: string[]; stations: string[] }>>(
      `SELECT categories, stations FROM "PrepSettings" WHERE id = 'singleton' LIMIT 1`
    )

    if (rows.length === 0) {
      const cats = toPgTextArray(DEFAULT_CATEGORIES)
      const sta  = toPgTextArray(DEFAULT_STATIONS)
      await prisma.$executeRawUnsafe(`
        INSERT INTO "PrepSettings" (id, categories, stations, "updatedAt")
        VALUES ('singleton', '${cats}'::text[], '${sta}'::text[], NOW())
        ON CONFLICT (id) DO NOTHING
      `)
      return NextResponse.json({
        categories: DEFAULT_CATEGORIES.filter(Boolean),
        stations:   DEFAULT_STATIONS.filter(Boolean),
      })
    }

    return NextResponse.json({
      categories: (rows[0].categories ?? []).filter(Boolean),
      stations:   (rows[0].stations   ?? []).filter(Boolean),
    })
  } catch (err) {
    console.error('[prep/settings GET]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json()

    // Categories are managed exclusively by sync-from-recipes.
    // Only stations are user-editable; preserve existing categories.
    const stations: string[] = Array.isArray(body.stations)
      ? body.stations.map(String).filter(Boolean)
      : DEFAULT_STATIONS

    if (stations.length === 0) {
      return NextResponse.json({ error: 'Stations list cannot be empty' }, { status: 400 })
    }

    // Fetch existing categories via raw SQL — no ORM, no prepared statements.
    const existing = await prisma.$queryRawUnsafe<Array<{ categories: string[] }>>(
      `SELECT categories FROM "PrepSettings" WHERE id = 'singleton' LIMIT 1`
    )
    const cats = toPgTextArray(
      existing.length > 0 && (existing[0].categories?.length ?? 0) > 0
        ? existing[0].categories
        : DEFAULT_CATEGORIES
    )
    const sta = toPgTextArray(stations)

    // $executeRawUnsafe embeds values as literals → no parameterised binding
    // → works reliably with pgBouncer transaction mode (no prepared statements).
    await prisma.$executeRawUnsafe(`
      INSERT INTO "PrepSettings" (id, categories, stations, "updatedAt")
      VALUES ('singleton', '${cats}'::text[], '${sta}'::text[], NOW())
      ON CONFLICT (id) DO UPDATE
        SET stations   = '${sta}'::text[],
            "updatedAt" = NOW()
    `)

    const updated = await prisma.$queryRawUnsafe<Array<{ categories: string[]; stations: string[] }>>(
      `SELECT categories, stations FROM "PrepSettings" WHERE id = 'singleton' LIMIT 1`
    )
    return NextResponse.json({
      categories: (updated[0]?.categories ?? existing[0]?.categories ?? DEFAULT_CATEGORIES).filter(Boolean),
      stations:   (updated[0]?.stations   ?? stations).filter(Boolean),
    })
  } catch (err) {
    console.error('[prep/settings PUT]', err)
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
