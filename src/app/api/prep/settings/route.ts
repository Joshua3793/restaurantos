import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { PREP_CATEGORIES as DEFAULT_CATEGORIES, PREP_STATIONS as DEFAULT_STATIONS } from '@/lib/prep-utils'

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
    // findUnique + INSERT with no array params — safe with pgBouncer.
    let settings = await prisma.prepSettings.findUnique({ where: { id: 'singleton' } })
    if (!settings) {
      const cats = toPgTextArray(DEFAULT_CATEGORIES)
      const sta  = toPgTextArray(DEFAULT_STATIONS)
      await prisma.$executeRawUnsafe(`
        INSERT INTO "PrepSettings" (id, categories, stations, "updatedAt")
        VALUES ('singleton', '${cats}'::text[], '${sta}'::text[], NOW())
        ON CONFLICT (id) DO NOTHING
      `)
      settings = await prisma.prepSettings.findUnique({ where: { id: 'singleton' } })
    }
    if (!settings) throw new Error('Could not create singleton row')
    return NextResponse.json({ categories: settings.categories, stations: settings.stations })
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

    // Fetch existing categories to preserve them in the upsert.
    const existing = await prisma.prepSettings.findUnique({ where: { id: 'singleton' } })
    const cats = toPgTextArray(existing?.categories ?? DEFAULT_CATEGORIES)
    const sta  = toPgTextArray(stations)

    // $executeRawUnsafe embeds values as literals → no parameterised binding
    // → works reliably with pgBouncer transaction mode (no prepared statements).
    await prisma.$executeRawUnsafe(`
      INSERT INTO "PrepSettings" (id, categories, stations, "updatedAt")
      VALUES ('singleton', '${cats}'::text[], '${sta}'::text[], NOW())
      ON CONFLICT (id) DO UPDATE
        SET stations   = '${sta}'::text[],
            "updatedAt" = NOW()
    `)

    const updated = await prisma.prepSettings.findUnique({ where: { id: 'singleton' } })
    return NextResponse.json({
      categories: updated?.categories ?? existing?.categories ?? DEFAULT_CATEGORIES,
      stations:   updated?.stations   ?? stations,
    })
  } catch (err) {
    console.error('[prep/settings PUT]', err)
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
