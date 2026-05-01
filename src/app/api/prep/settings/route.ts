import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { PREP_CATEGORIES as DEFAULT_CATEGORIES, PREP_STATIONS as DEFAULT_STATIONS } from '@/lib/prep-utils'

export async function GET() {
  try {
    let settings = await prisma.prepSettings.findUnique({ where: { id: 'singleton' } })
    if (!settings) {
      // Use raw INSERT to avoid any pgbouncer array-handling issues on first create
      await prisma.$executeRaw`
        INSERT INTO "PrepSettings" (id, categories, stations, "updatedAt")
        VALUES ('singleton', ${DEFAULT_CATEGORIES}, ${DEFAULT_STATIONS}, NOW())
        ON CONFLICT (id) DO NOTHING
      `
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
    const categories: string[] = Array.isArray(body.categories) ? body.categories.map(String) : DEFAULT_CATEGORIES
    const stations:   string[] = Array.isArray(body.stations)   ? body.stations.map(String)   : DEFAULT_STATIONS

    if (categories.length === 0 || stations.length === 0) {
      return NextResponse.json({ error: 'Lists cannot be empty' }, { status: 400 })
    }

    // Raw SQL bypasses Prisma's array serialisation, which can fail
    // with pgBouncer in transaction mode (prepared-statement restrictions).
    await prisma.$executeRaw`
      INSERT INTO "PrepSettings" (id, categories, stations, "updatedAt")
      VALUES ('singleton', ${categories}, ${stations}, NOW())
      ON CONFLICT (id) DO UPDATE
        SET categories = EXCLUDED.categories,
            stations   = EXCLUDED.stations,
            "updatedAt" = NOW()
    `

    return NextResponse.json({ categories, stations })
  } catch (err) {
    console.error('[prep/settings PUT]', err)
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
