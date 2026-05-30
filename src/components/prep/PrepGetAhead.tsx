import { PrepItemRich } from '@/components/prep/types'
import { IcPlus } from '@/components/prep/icons'

interface PrepGetAheadProps {
  items: PrepItemRich[]
  onAdd: (item: PrepItemRich) => void
  totalCount?: number
}

function fmt(n: number): string {
  if (n >= 100) return Math.round(n).toLocaleString('en-US')
  const s = n >= 10 ? n.toFixed(1) : n.toFixed(2)
  return s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
}

export default function PrepGetAhead({ items, onAdd, totalCount }: PrepGetAheadProps) {
  if (items.length === 0) return null

  return (
    <div className="mt-[26px]">
      <div className="flex items-center justify-between mb-3">
        <div className="font-mono text-[10.5px] uppercase tracking-[0.05em] text-ink-3 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-green" />
          Get ahead · <b className="text-ink font-semibold">on par now</b>, prep early to stay buffered
        </div>
        <span className="text-[12.5px] font-semibold text-ink-3 hover:text-ink cursor-pointer">
          View all {totalCount ?? items.length} →
        </span>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {items.slice(0, 3).map(item => {
          const onHand = Number(item.onHand)
          const parLevel = Number(item.parLevel)
          const pct = parLevel > 0 ? Math.round((onHand / parLevel - 1) * 100) : 0
          return (
            <div key={item.id} className="bg-paper border border-line rounded-xl px-4 py-3.5 flex flex-col gap-3">
              <div className="flex items-start justify-between gap-2.5">
                <div>
                  <div className="text-sm font-semibold tracking-[-0.015em]">{item.name}</div>
                  <div className="font-mono text-[10.5px] text-ink-3 mt-[3px]">
                    {item.category} · {fmt(onHand)} / {fmt(parLevel)} {item.unit}
                  </div>
                </div>
                {pct > 0 && (
                  <span className="font-mono text-[10px] font-semibold text-green-text bg-green-soft px-[7px] py-[3px] rounded-full">
                    +{pct}%
                  </span>
                )}
              </div>
              <button
                onClick={() => onAdd(item)}
                className="h-[38px] rounded-[9px] border border-line bg-paper text-ink-2 text-[12.5px] font-semibold flex items-center justify-center gap-1.5 hover:border-ink hover:bg-ink hover:text-white group"
              >
                <IcPlus className="w-[13px] h-[13px] text-ink-3 group-hover:text-gold" />
                Add to list
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
