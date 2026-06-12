'use client'
import { useEffect, useState } from 'react'
import { Utensils } from 'lucide-react'
import { PageHead } from '@/components/layout/PageHead'
import { ReportsSubnav } from '../ReportsSubnav'
import { formatCurrency } from '@/lib/utils'

interface Dish {
  recipeId: string; name: string; qtySold: number
  menuPrice: number | null; costPerPortion: number | null; margin: number | null
  foodCostPct: number | null
  quadrant: 'STAR' | 'PLOWHORSE' | 'PUZZLE' | 'DOG' | null
}
interface Resp { days: number; medianPopularity: number; medianMargin: number; dishes: Dish[] }

const QUADRANT_META: Record<string, { label: string; cls: string }> = {
  STAR:      { label: '⭐ Stars',      cls: 'text-green' },
  PLOWHORSE: { label: '🐴 Plowhorses', cls: 'text-ink' },
  PUZZLE:    { label: '❓ Puzzles',    cls: 'text-gold-2' },
  DOG:       { label: '🐶 Dogs',       cls: 'text-red-text' },
}

export default function MenuEngineeringPage() {
  const [data, setData] = useState<Resp | null>(null)
  const [days, setDays] = useState<30 | 60 | 90>(30)

  useEffect(() => {
    fetch(`/api/reports/menu-engineering?days=${days}`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null).then(j => j && setData(j))
  }, [days])

  const groups: Array<keyof typeof QUADRANT_META> = ['STAR', 'PLOWHORSE', 'PUZZLE', 'DOG']

  return (
    <div>
      <PageHead
        crumbs={<><Utensils size={12} /> INSIGHTS / REPORTS / MENU</>}
        title="Menu Engineering"
        sub={data ? <>Last <b>{data.days}d</b> · {data.dishes.length} dishes · split at median popularity <b>{data.medianPopularity}</b> / margin <b>{formatCurrency(data.medianMargin)}</b></> : <>Loading…</>} />
      <ReportsSubnav />

      <div className="flex gap-2 mb-4">
        {([30, 60, 90] as const).map(d => (
          <button key={d} onClick={() => setDays(d)}
            className={`px-3 py-1 rounded-md font-mono text-[12px] border ${days === d ? 'bg-ink text-paper border-ink' : 'border-line text-ink-3'}`}>
            {d}d
          </button>
        ))}
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        {groups.map(q => {
          const items = (data?.dishes ?? []).filter(d => d.quadrant === q)
          return (
            <div key={q} className="rounded-[12px] border border-line bg-paper p-4">
              <div className={`font-mono text-[12px] mb-3 ${QUADRANT_META[q].cls}`}>{QUADRANT_META[q].label} · {items.length}</div>
              <div className="space-y-2">
                {items.map(d => (
                  <div key={d.recipeId} className="flex items-center justify-between text-[13px]">
                    <span className="text-ink truncate mr-2">{d.name}</span>
                    <span className="font-mono text-[11px] text-ink-3 whitespace-nowrap">
                      ×{d.qtySold} · {d.margin != null ? formatCurrency(d.margin) : '—'} margin
                    </span>
                  </div>
                ))}
                {items.length === 0 && <div className="text-ink-4 text-[12px]">none</div>}
              </div>
            </div>
          )
        })}
      </div>

      {(data?.dishes ?? []).some(d => d.quadrant === null) && (
        <div className="mt-4 font-mono text-[11px] text-ink-4">
          {(data?.dishes ?? []).filter(d => d.quadrant === null).length} dish(es) hidden — no menu price or cost set.
        </div>
      )}
    </div>
  )
}
