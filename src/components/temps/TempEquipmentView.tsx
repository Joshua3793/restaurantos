'use client'
import { TEMP_GROUPS, groupOf, computeUnitSeries, type TempUnit, type HistoryReading } from './temp-utils'
import { TempUnitChart } from './TempUnitChart'

export function TempEquipmentView({
  units,
  history,
  histUnit,
}: {
  units: TempUnit[]
  history: HistoryReading[]
  histUnit?: string
}) {
  const shown = units.filter(u => !histUnit || u.id === histUnit)
  const groups = TEMP_GROUPS.map(g => ({
    ...g,
    units: shown.filter(u => groupOf(u.type) === g.key),
  })).filter(g => g.units.length > 0)

  if (shown.length === 0) {
    return <div className="text-center py-[60px] font-mono text-[11px] text-ink-4">NO UNITS</div>
  }

  return (
    <div className="space-y-6">
      {groups.map(g => (
        <div key={g.key}>
          <p className="font-mono text-[10px] text-ink-3 uppercase tracking-[0.04em] mb-2.5 px-0.5">{g.title}</p>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {g.units.map(u => (
              <TempUnitChart key={u.id} series={computeUnitSeries(history, u)} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
