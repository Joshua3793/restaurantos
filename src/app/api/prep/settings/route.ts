import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

const DEFAULT_CATEGORIES = [
  'MISC', 'SAUCE', 'DRESSING', 'PROTEIN', 'BAKED',
  'GARNISH', 'BASE', 'PICKLED', 'DAIRY',
]
const DEFAULT_STATIONS = ['Cold', 'Hot', 'Pastry', 'Butchery', 'Garde Manger']

export async function GET() {
  try {
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
    const categories: string[] = Array.isArray(body.categories) ? body.categories.map(String) : DEFAULT_CATEGORIES
    const stations:   string[] = Array.isArray(body.stations)   ? body.stations.map(String)   : DEFAULT_STATIONS

    if (categories.length === 0 || stations.length === 0) {
      return NextResponse.json({ error: 'Lists cannot be empty' }, { status: 400 })
    }

    const settings = await prisma.prepSettings.upsert({
      where:  { id: 'singleton' },
      update: { categories, stations },
      create: { id: 'singleton', categories, stations },
    })
    return NextResponse.json({ categories: settings.categories, stations: settings.stations })
  } catch (err) {
    console.error('[prep/settings PUT]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
