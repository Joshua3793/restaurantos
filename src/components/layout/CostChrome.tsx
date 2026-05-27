'use client'
/**
 * Dark live food-cost % strip — Principle 01 of Controla OS.
 * Phase 1: structural placeholder with hardcoded values.
 * Phase 2: wires to /api/insights/cost-chrome with real data + audit drawer.
 *
 * Mount via the app layout on routes that touch recipes/menu/invoices/count.
 */

interface CostChromeProps {
  /** Hide on routes that don't relate to the spine (Pass + Insights override). */
  variant?: 'default' | 'compact'
}

export function CostChrome({ variant: _variant = 'default' }: CostChromeProps) {
  // TODO Phase 2: fetch live values from /api/insights/cost-chrome
  // const { data } = useSWR('/api/insights/cost-chrome', fetcher, { refreshInterval: 60_000 })
  const placeholder = {
    foodCostPct: null as number | null,
    targetPct: 27.0,
    variance7d: null as number | null,
    onHand: null as number | null,
    lastInvoiceAgo: null as string | null,
    sourceItemCount: null as number | null,
  }

  const fcClass = placeholder.foodCostPct === null
    ? ''
    : placeholder.foodCostPct < placeholder.targetPct
      ? 'text-green-400'
      : placeholder.foodCostPct < placeholder.targetPct + 2
        ? 'text-amber-300'
        : 'text-red-300'

  const fmtMoney = (n: number | null) => n === null ? '—' : (n < 0 ? '−' : '') + '$' + Math.abs(n).toLocaleString()
  const fmtPct = (n: number | null) => n === null ? '—' : `${n.toFixed(1)}%`

  return (
    <div className="hidden md:flex bg-ink text-paper px-8 py-[10px] items-center gap-6 border-b border-ink">
      <CCItem label="Food cost · live" value={fmtPct(placeholder.foodCostPct)} valueClass={fcClass} />
      <CCDivider />
      <CCItem label="Target" value={fmtPct(placeholder.targetPct)} />
      <CCDivider />
      <CCItem
        label="7d variance"
        value={fmtMoney(placeholder.variance7d)}
        valueClass={placeholder.variance7d !== null && placeholder.variance7d < 0 ? 'text-red-300' : ''}
      />
      <CCDivider />
      <CCItem label="On hand" value={fmtMoney(placeholder.onHand)} />
      <div className="flex-1" />
      <span className="font-mono text-[10.5px] text-zinc-500">
        computed from{' '}
        <button className="text-gold border-b border-dashed border-gold/60 hover:text-gold/80 transition-colors" title="Open spine audit (Phase 2)">
          pricePerBaseUnit
        </button>
        {placeholder.lastInvoiceAgo && (
          <> · last invoice {placeholder.lastInvoiceAgo}</>
        )}
      </span>
    </div>
  )
}

function CCItem({ label, value, valueClass = '' }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="font-mono text-[10px] text-zinc-500 uppercase tracking-[0.02em]">{label}</span>
      <span className={`font-mono text-[14px] font-semibold tracking-[-0.01em] ${valueClass || 'text-paper'}`}>
        {value}
      </span>
    </div>
  )
}

function CCDivider() {
  return <div className="w-px h-[14px] bg-zinc-800" />
}
