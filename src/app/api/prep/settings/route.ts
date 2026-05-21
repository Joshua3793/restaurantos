import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { PREP_CATEGORIES as DEFAULT_CATEGORIES, PREP_STATIONS as DEFAULT_STATIONS } from '@/lib/prep-utils'

export async function GET() {
  try {
    // Upsert the singleton row if it doesn't exist yet, then return it.
    // Using the ORM upsert (not $executeRaw) so Prisma handles String[]
    // serialisation correctly with pgBouncer (?pgbouncer=true in DATABASE_URL).
    const settings = await prisma.prepSettings.upsert({
      where:  { id: 'singleton' },
      update: {},   // already exists — no changes
      create: { id: 'singleton', categories: DEFAULT_CATEGORIES, stations: DEFAULT_STATIONS },
    })
    return NextResponse.json({ categories: settings.categories, stations: settings.stations })
  } catch (err) {
    console.error('[prep/settings GET]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json()
    const categories: string[] = Array.isArray(body.categories) ? body.categories.map(String) : DEFAULT_CATEGORIES
    const stations:   string[] = Array.isArray(body.stations)   ? body.stations.map(String)   : DEFAULT_STATIONS

    if (categories.length === 0 || stations.length === 0) {
      return NextResponse.json({ error: 'Lists cannot be empty' }, { status: 400 })
    }

    // Use the Prisma ORM upsert — it serialises String[] fields correctly
    // with pgBouncer when ?pgbouncer=true is present in DATABASE_URL.
    // (The previous $executeRaw approach used parameterised queries which
    //  pgBouncer in transaction mode can reject as prepared statements.)
    await prisma.prepSettings.upsert({
      where:  { id: 'singleton' },
      update: { categories, stations },
      create: { id: 'singleton', categories, stations },
    })

    return NextResponse.json({ categories, stations })
  } catch (err) {
    console.error('[prep/settings PUT]', err)
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
