'use client'
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, ReferenceArea, CartesianGrid,
} from 'recharts'
import { TEMP_TYPES, rangeText, fmtTemp, type UnitSeries } from './temp-utils'

export function TempUnitChart({ series }: { series: UnitSeries }) {
  const { unit, points } = series
  const color = TEMP_TYPES[unit.type].color

  // y-domain padded around the data AND the safe bounds so the band is visible.
  // reduce (not Math.min(...spread)) to stay safe on long history windows.
  const temps = points.map(p => p.temp)
  const lo = [...temps, unit.safeMin ?? Infinity, unit.safeMax ?? Infinity].reduce((a, b) => (b < a ? b : a), Infinity)
  const hi = [...temps, unit.safeMin ?? -Infinity, unit.safeMax ?? -Infinity].reduce((a, b) => (b > a ? b : a), -Infinity)
  const pad = Math.max(1, (hi - lo) * 0.15)
  const domain: [number, number] = points.length ? [Math.floor(lo - pad), Math.ceil(hi + pad)] : [0, 10]
  const bandY1 = unit.safeMin ?? domain[0]
  // One-sided range (e.g. hot-hold ≥63°C, no max): band extends to the chart
  // ceiling — i.e. "safe = at/above the minimum", per the food-safety spec.
  const bandY2 = unit.safeMax ?? domain[1]

  return (
    <div className="bg-paper border border-line rounded-xl p-3.5">
      <div className="flex items-baseline gap-2 mb-2">
        <b className="text-[13.5px] tracking-[-0.01em]">{unit.name}</b>
        <span className="font-mono text-[10px] text-ink-3">{TEMP_TYPES[unit.type].label} · {rangeText(unit)}</span>
      </div>

      {points.length === 0 ? (
        <div className="font-mono text-[10.5px] text-ink-4 text-center py-8">NO READINGS IN RANGE</div>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={150}>
            <LineChart data={points} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f4f4f5" />
              <ReferenceArea y1={bandY1} y2={bandY2} fill="#22c55e" fillOpacity={0.1} stroke="none" />
              <XAxis dataKey="label" tick={{ fontSize: 9 }} interval="preserveStartEnd" minTickGap={28} />
              <YAxis domain={domain} tick={{ fontSize: 9 }} width={34} unit="°" allowDecimals={false} />
              <Tooltip
                formatter={(v: unknown) => [`${fmtTemp(Number(v))}°C`, 'Temp']}
                contentStyle={{ fontSize: 12, borderRadius: 8 }}
              />
              <Line
                type="monotone"
                dataKey="temp"
                stroke={color}
                strokeWidth={1.6}
                isAnimationActive={false}
                dot={(props: Record<string, unknown>) => {
                  const i = (props.index as number | undefined) ?? 0
                  const bad = points[i]?.safe === false
                  return (
                    <circle
                      key={i}
                      cx={props.cx as number | undefined}
                      cy={props.cy as number | undefined}
                      r={bad ? 3.2 : 2}
                      fill={bad ? '#dc2626' : color}
                      stroke="none"
                    />
                  )
                }}
                activeDot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>

          <div className="flex gap-1.5 mt-2 flex-wrap">
            <Chip>min {fmtTemp(series.min)}°</Chip>
            <Chip>max {fmtTemp(series.max)}°</Chip>
            <Chip>avg {fmtTemp(series.avg)}°</Chip>
            {series.outCount > 0 ? (
              <Chip tone="bad">{series.outCount} out of range</Chip>
            ) : (
              <Chip tone="ok">all OK</Chip>
            )}
            <Chip>{series.pct}% OK</Chip>
          </div>
        </>
      )}
    </div>
  )
}

function Chip({ children, tone }: { children: React.ReactNode; tone?: 'ok' | 'bad' }) {
  const cls =
    tone === 'bad'
      ? 'bg-red-soft text-red-text'
      : tone === 'ok'
        ? 'bg-green-soft text-green-text'
        : 'bg-bg-2 text-ink-3'
  return <span className={`font-mono text-[9.5px] px-2 py-[3px] rounded-full ${cls}`}>{children}</span>
}
