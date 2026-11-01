// Server-only: the temp units a kitchen sees, optionally with one day's
// readings. Shared by GET /api/temps/units and the Inbox system sync.
import 'server-only'
import { prisma } from '@/lib/prisma'

const num = (v: unknown) => (v == null ? null : Number(v))

// Serialize a unit (+ optional readings) with Decimal → number coercion.
export function serializeUnit(u: {
  id: string; name: string; type: string
  safeMin: unknown; safeMax: unknown
  revenueCenterId: string | null; sortOrder: number
  readings?: { id: string; time: string; temp: unknown }[]
}) {
  return {
    id: u.id,
    name: u.name,
    type: u.type,
    safeMin: num(u.safeMin),
    safeMax: num(u.safeMax),
    revenueCenterId: u.revenueCenterId,
    sortOrder: u.sortOrder,
    ...(u.readings
      ? { readings: u.readings.map(r => ({ id: r.id, time: r.time, temp: Number(r.temp) })) }
      : {}),
  }
}

export type TempUnitView = ReturnType<typeof serializeUnit>

/**
 * Active units visible to these revenue centers (their own + shared/null), in
 * display order. `rcIds` null = every unit. With `date`, each unit carries
 * that day's readings, oldest first.
 */
export async function loadTempUnits(rcIds: string[] | null, date: string | null): Promise<TempUnitView[]> {
  const units = await prisma.tempUnit.findMany({
    where: {
      isActive: true,
      ...(rcIds ? { OR: [{ revenueCenterId: { in: rcIds } }, { revenueCenterId: null }] } : {}),
    },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    include: date
      ? { readings: { where: { logDate: date }, orderBy: { time: 'asc' } } }
      : undefined,
  })
  return units.map(serializeUnit)
}
