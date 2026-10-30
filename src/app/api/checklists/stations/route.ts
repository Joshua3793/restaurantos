import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession } from '@/lib/auth'
import { assertRcWritable, isRcInScope } from '@/lib/rc-scope'
import { seedStationsIfEmpty } from '@/lib/checklists/seed'
import { DEFAULT_STATION_COLOR, isPaletteColor, parseName } from '@/lib/checklists/item-input'
import type { CategoryTree, EditStation, EditView } from '@/lib/checklists/edit-format'
import { ITEM_SELECT, caught, fail, readBody, toEditItem } from '@/lib/checklists/edit-server'

export const dynamic = 'force-dynamic'

/**
 * GET ?rcId= — the editor's view of a kitchen: every active station with its
 * active categories and jobs per phase, plus the Temps units a job can point at
 * (this kitchen's and the shared ones). Seeds the starter stations on first open.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await requireSession('MANAGER')
    const rcId = req.nextUrl.searchParams.get('rcId')
    if (!rcId) return fail(400, 'rcId required')
    if (!(await isRcInScope(user, rcId))) return fail(403, 'Revenue center is outside your access.')

    await seedStationsIfEmpty(rcId)

    const [rows, units] = await Promise.all([
      prisma.checklistStation.findMany({
        where: { revenueCenterId: rcId, isActive: true },
        orderBy: { sortOrder: 'asc' },
        select: {
          id: true, name: true, color: true, isShared: true, isActive: true,
          categories: {
            where: { isActive: true },
            orderBy: { sortOrder: 'asc' },
            select: {
              id: true, name: true, phase: true,
              items: { where: { isActive: true }, orderBy: { sortOrder: 'asc' }, select: ITEM_SELECT },
            },
          },
        },
      }),
      prisma.tempUnit.findMany({
        where: { isActive: true, OR: [{ revenueCenterId: rcId }, { revenueCenterId: null }] },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: { id: true, name: true, safeMin: true, safeMax: true },
      }),
    ])

    const stations: EditStation[] = rows.map(s => {
      const tree = (phase: 'OPEN' | 'CLOSE'): CategoryTree[] =>
        s.categories.filter(c => c.phase === phase).map(c => ({ id: c.id, name: c.name, items: c.items.map(toEditItem) }))
      return {
        id: s.id, name: s.name, color: s.color, isShared: s.isShared, isActive: s.isActive,
        phases: { OPEN: tree('OPEN'), CLOSE: tree('CLOSE') },
      }
    })
    const tempUnits = units.map(u => ({
      id: u.id, name: u.name,
      safeMin: u.safeMin == null ? null : Number(u.safeMin),
      safeMax: u.safeMax == null ? null : Number(u.safeMax),
    }))
    const body: EditView = { stations, tempUnits }
    return NextResponse.json(body)
  } catch (e) {
    return caught(e, 'GET /api/checklists/stations', 'Failed to load the lists')
  }
}

/** POST { rcId, name, color? } — a new station at the end of the kitchen's list. Never shared. */
export async function POST(req: NextRequest) {
  try {
    const user = await requireSession('MANAGER')
    const b = await readBody(req)
    const rcId = typeof b.rcId === 'string' ? b.rcId : ''
    if (!rcId) return fail(400, 'rcId required')
    await assertRcWritable(user, rcId)

    const n = parseName(b.name, 'Give the station a name')
    if (!n.ok) return fail(400, n.error)
    if (b.color !== undefined && !isPaletteColor(b.color)) return fail(400, 'Pick one of the colours')
    const color = isPaletteColor(b.color) ? b.color : DEFAULT_STATION_COLOR

    // A brand-new kitchen gets its starter stations (and its one shared list) first.
    await seedStationsIfEmpty(rcId)

    const clash = await prisma.checklistStation.findFirst({
      where: { revenueCenterId: rcId, isActive: true, name: { equals: n.name, mode: 'insensitive' } },
      select: { id: true },
    })
    if (clash) return fail(409, `There's already a station called ${n.name}`)

    const max = await prisma.checklistStation.aggregate({ where: { revenueCenterId: rcId }, _max: { sortOrder: true } })
    const s = await prisma.checklistStation.create({
      data: { revenueCenterId: rcId, name: n.name, color, isShared: false, sortOrder: (max._max.sortOrder ?? -1) + 1 },
      select: { id: true, name: true, color: true, isShared: true, isActive: true },
    })
    const station: EditStation = { ...s, phases: { OPEN: [], CLOSE: [] } }
    return NextResponse.json({ station }, { status: 201 })
  } catch (e) {
    return caught(e, 'POST /api/checklists/stations')
  }
}
