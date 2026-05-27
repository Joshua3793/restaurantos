import { ReactNode } from 'react'

interface PageHeaderProps {
  title: string
  meta?: string
  right?: ReactNode
  cost?: {
    value: number | null
    label?: string
  }
}

export function PageHeader({ title, meta, right, cost }: PageHeaderProps) {
  return (
    <div className="flex items-end justify-between gap-4 px-4 py-3">
      <div>
        <h1 className="text-[28px] font-semibold tracking-[-0.035em] leading-[1.05] text-ink">
          {title}
        </h1>
        {(meta || cost) && (
          <div className="flex items-center gap-3 mt-1">
            {meta && (
              <p className="font-mono text-[10.5px] uppercase tracking-wider text-ink-3">{meta}</p>
            )}
            {cost && cost.value !== null && (
              <span className="font-mono text-[10.5px] bg-gold-soft text-gold-2 px-2 py-0.5 rounded-full">
                {cost.label ?? 'FOOD COST'} {cost.value.toFixed(1)}%
              </span>
            )}
          </div>
        )}
      </div>
      {right && <div className="shrink-0">{right}</div>}
    </div>
  )
}
