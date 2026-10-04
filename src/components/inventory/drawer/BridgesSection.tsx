'use client'
import { levelBaseUnits, type PackLink } from '@/lib/item-model'

/** Pack chain readout — how one purchase unit breaks down to the base unit. A grid cell. */
export function PackChainReadout({ chain, baseUnit }: { chain: PackLink[]; baseUnit: string }) {
  const lv = levelBaseUnits(chain)
  return (
    <div className="bg-paper border border-line rounded-[10px] p-3 col-span-2">
      <div className="font-mono text-[10px] text-ink-3 uppercase tracking-[0.04em] mb-1.5">Pack chain</div>
      <div className="space-y-1">
        {chain.map((link, i) => (
          <div key={i} className="flex items-center justify-between text-[12px]">
            <span className="font-medium text-ink">1 {link.unit}</span>
            <span className="font-mono text-ink-3 tabular-nums">
              = {Number(link.per).toLocaleString()} {i === chain.length - 1 ? baseUnit : chain[i + 1]?.unit}
              <span className="text-ink-4"> &nbsp;({(lv[link.unit] ?? 0).toLocaleString()} {baseUnit})</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** The way into "Change how it's measured" without entering Edit
 *  (MANAGER+; a recipe-made item is measured by its recipe). A grid cell. */
export function BridgesSection({ canEdit, isRecipe, onRemeasure }: {
  canEdit: boolean
  isRecipe: boolean
  onRemeasure: () => void
}) {
  if (!canEdit || isRecipe) return null
  return (
    <div className="col-span-2 -mt-1.5 text-right">
      <button
        type="button" onClick={onRemeasure}
        className="text-[12px] text-ink-3 underline underline-offset-2 hover:text-ink-2"
      >
        Change how it&rsquo;s measured
      </button>
    </div>
  )
}
