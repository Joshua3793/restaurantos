import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { PREP_CATEGORIES as DEFAULT_CATEGORIES, PREP_STATIONS as DEFAULT_STATIONS } from '@/lib/prep-utils'

export async function GET() {
  try {
    // Upsert the singleton row if it doesn't exist yet, then return it.
    const settings = await prisma.prepSettings.upsert({
      where:  { id: 'singleton' },
      update: {},
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

    // Categories are managed exclusively by sync-from-recipes (they mirror
    // Recipe Book PREP categories). Only stations are user-editable here.
    const stations: string[] = Array.isArray(body.stations)
      ? body.stations.map(String).filter(Boolean)
      : DEFAULT_STATIONS

    if (stations.length === 0) {
      return NextResponse.json({ error: 'Stations list cannot be empty' }, { status: 400 })
    }

    const updated = await prisma.prepSettings.upsert({
      where:  { id: 'singleton' },
      update: { stations },
      create: { id: 'singleton', categories: DEFAULT_CATEGORIES, stations },
    })

    return NextResponse.json({ categories: updated.categories, stations: updated.stations })
  } catch (err) {
    console.error('[prep/settings PUT]', err)
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
