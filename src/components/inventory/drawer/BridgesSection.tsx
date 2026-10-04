'use client'
import { levelBaseUnits, type PackLink } from '@/lib/item-model'
import { bridgeSentence } from '@/lib/drawer-copy'
import { SectionTitle } from './SectionTitle'
import type { InventoryItem } from './types'

/** A pack that is just the base unit ("1 each = 1 each") says nothing. */
const packWorthSaying = (chain: PackLink[], baseUnit: string) =>
  chain.length > 1 || (chain.length === 1 && chain[0].unit !== baseUnit)

/** How one pack breaks down to the base unit: "1 case = 6 bag (6,000 g)". */
function PackLines({ chain, baseUnit }: { chain: PackLink[]; baseUnit: string }) {
  if (!packWorthSaying(chain, baseUnit)) return null
  const lv = levelBaseUnits(chain)
  return (
    <div className="space-y-1">
      {chain.map((link, i) => (
        <div key={i} className="flex items-center justify-between gap-3 text-[12.5px]">
          <span className="text-ink">
            1 {link.unit} = {Number(link.per).toLocaleString()} {i === chain.length - 1 ? baseUnit : chain[i + 1]?.unit}
          </span>
          {i < chain.length - 1 && (
            <span className="font-mono text-[11px] text-ink-4 tabular-nums shrink-0">
              {(lv[link.unit] ?? 0).toLocaleString()} {baseUnit}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

/** How the item converts: its pack, its bridges ("1 each = 85 g · used by 3
 *  recipes", "1 ml weighs 1.03 g"), and the way into "Change how it's
 *  measured" (MANAGER+; a recipe-made item is measured by its recipe). No
 *  bridge → says when one is needed, and a manager can jump to it in Edit. */
export function BridgesSection({ item, chain, baseUnit, canEdit, onRemeasure, onEditBridge }: {
  item: InventoryItem
  chain: PackLink[]
  baseUnit: string
  canEdit: boolean
  onRemeasure: () => void
  /** Opens Edit scrolled to the "1 each = ? g" field. */
  onEditBridge: () => void
}) {
  const isRecipe = !!item.recipe
  const bridges = bridgeSentence(
    {
      eachQty: item.eachMeasureQty != null ? Number(item.eachMeasureQty) : null,
      eachUnit: item.eachMeasureUnit ?? null,
      densityGPerMl: item.densityGPerMl != null ? Number(item.densityGPerMl) : null,
    },
    item.bridgeUsedBy?.length ?? 0,
  )
  const rule = packWorthSaying(chain, baseUnit) ? 'border-t border-line pt-2 ' : ''
  // A recipe-made item with a plain unit and no bridge has nothing to say here.
  if (isRecipe && !rule && bridges.length === 0) return null
  return (
    <div className="space-y-2">
      <SectionTitle>How it converts</SectionTitle>
      <div className="bg-paper border border-line rounded-[10px] p-3 space-y-2">
        <PackLines chain={chain} baseUnit={baseUnit} />
        {bridges.length > 0 ? (
          <div className={`${rule}space-y-1`}>
            {bridges.map(b => <div key={b} className="text-[12.5px] text-ink">{b}</div>)}
          </div>
        ) : !isRecipe && (
          <div className={`${rule}text-[12px] text-ink-3 leading-snug`}>
            No bridge — add one if this item is bought by weight but counted.
            {canEdit && (
              <>
                {' '}
                <button
                  type="button" onClick={onEditBridge}
                  className="text-gold-2 font-medium hover:text-gold underline underline-offset-2"
                >
                  Add it in Edit
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {canEdit && !isRecipe && (
        <div className="text-right">
          <button
            type="button" onClick={onRemeasure}
            className="text-[12px] text-ink-3 underline underline-offset-2 hover:text-ink-2"
          >
            Change how it&rsquo;s measured
          </button>
        </div>
      )}
    </div>
  )
}
