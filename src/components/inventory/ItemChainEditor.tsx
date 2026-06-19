'use client'
import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { DIMENSION_BASE, type Dimension, type PackLink, type Pricing } from '@/lib/item-model'
import { getUnitConv } from '@/lib/utils'

// ─── Shared pack-chain item editor ───────────────────────────────────────────
// Single source of truth for the dimension / pack-chain / pricing controls used
// by the inventory add modal, the inventory item drawer, and the invoice
// "create new product" modal. Keeping one copy guarantees the three forms stay
// visually and behaviourally identical and on the same backbone.
//
// Defined at module scope (never inside a render body) so inputs don't remount
// and lose focus on each keystroke — see CLAUDE.md "Client components".

export const DIM_UNITS: Record<Dimension, string[]> = {
  MASS:   ['g', 'kg', 'lb', 'oz'],
  VOLUME: ['ml', 'l', 'fl oz', 'cup'],
  COUNT:  ['each'],
}

// Packaging / container labels selectable for a pack-chain level. A level name is
// really just a label that resolves to base units via the chain's `per`, but
// offering a curated dropdown (instead of free text) keeps entries consistent and
// typo-free — and mirrors the app's container-unit taxonomy (uom.ts CONTAINER_UNITS).
export const LEVEL_UNITS: string[] = [
  'case', 'box', 'carton', 'flat', 'crate', 'pallet',
  'pack', 'bag', 'tray', 'clamshell', 'sleeve', 'bundle', 'dozen',
  'jug', 'bottle', 'can', 'jar', 'tub', 'tin',
  'each',
]

const inputCls =
  'w-full border border-line rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-gold'

/** Count-unit options: chain level names + same-dimension units, deduped. */
export function countUnitOptions(dimension: Dimension, chain: PackLink[]): string[] {
  return [...new Set([...chain.map(l => l.unit), ...DIM_UNITS[dimension]])]
}

/** Eligible units for a pack-chain level: packaging labels + same-dimension
 *  measured units, plus the current value so editing an existing chain never
 *  silently drops a label that isn't in the curated list. */
export function levelUnitOptions(dimension: Dimension, current?: string): string[] {
  return [...new Set([...LEVEL_UNITS, ...DIM_UNITS[dimension], ...(current ? [current] : [])])]
}

export function DimensionToggle({ dimension, onChange }: {
  dimension: Dimension
  onChange: (d: Dimension) => void
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-ink-3 mb-1">Dimension</label>
      <div className="flex gap-2 p-1 bg-bg-2 rounded-xl">
        {(['MASS', 'VOLUME', 'COUNT'] as Dimension[]).map(d => (
          <button
            key={d}
            type="button"
            onClick={() => onChange(d)}
            className={`flex-1 py-2 rounded-lg text-xs font-medium transition-all ${
              dimension === d ? 'bg-white text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2'
            }`}
          >
            {d === 'MASS' ? 'Weight' : d === 'VOLUME' ? 'Volume' : 'Count'}
          </button>
        ))}
      </div>
      <p className="text-[10px] text-ink-4 mt-1">Base unit: <span className="font-mono">{DIMENSION_BASE[dimension]}</span></p>
    </div>
  )
}

// Format a number for display without floating-point noise (e.g. 4.99999→5).
const fmtQty = (n: number): string =>
  Number.isFinite(n) ? String(parseFloat(n.toFixed(6))) : '0'

/**
 * Leaf-level size input for MASS/VOLUME items. The chain stores the leaf `per` in
 * base units (g/ml), but the user enters the size in whatever unit is natural
 * (e.g. "5 lb") and the system converts to base. Picking a unit re-expresses the
 * same base quantity (view conversion); typing a number sets it in the chosen unit.
 */
function LeafSizeInput({ perBase, dimension, onChange }: {
  perBase: number
  dimension: Dimension
  onChange: (perBase: number) => void
}) {
  const [unit, setUnit] = useState<string>(DIMENSION_BASE[dimension])
  const [qty, setQty] = useState<string>(() => fmtQty(perBase / getUnitConv(DIMENSION_BASE[dimension])))

  // Keep the chosen unit valid when the dimension changes; reset to that base.
  useEffect(() => {
    if (!DIM_UNITS[dimension].includes(unit)) {
      const b = DIMENSION_BASE[dimension]
      setUnit(b)
      setQty(fmtQty(perBase / getUnitConv(b)))
    }
  }, [dimension]) // eslint-disable-line react-hooks/exhaustive-deps

  // Resync the displayed qty when perBase changes from outside (seed / edit-open)
  // and no longer matches what's typed — but never clobber active typing.
  useEffect(() => {
    const shown = (parseFloat(qty) || 0) * getUnitConv(unit)
    if (Math.abs(shown - perBase) > Math.max(1e-6, Math.abs(perBase) * 1e-6)) {
      setQty(fmtQty(perBase / getUnitConv(unit)))
    }
  }, [perBase]) // eslint-disable-line react-hooks/exhaustive-deps

  const onQty = (s: string) => { setQty(s); onChange((parseFloat(s) || 0) * getUnitConv(unit)) }
  const onUnit = (u: string) => { setUnit(u); setQty(fmtQty(perBase / getUnitConv(u))) } // view conversion, base unchanged

  return (
    <div className="flex items-center">
      <input
        type="number"
        step="any"
        min="0"
        value={qty}
        onChange={e => onQty(e.target.value)}
        className="w-20 border border-line rounded-l-lg px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-gold border-r-0"
      />
      <select
        value={unit}
        onChange={e => onUnit(e.target.value)}
        title="Entered in this unit; stored as base"
        className="border border-line rounded-r-lg pl-2 pr-1 py-2 text-sm text-ink-2 bg-bg focus:outline-none focus:ring-2 focus:ring-gold"
      >
        {DIM_UNITS[dimension].map(u => <option key={u} value={u}>{u}</option>)}
      </select>
    </div>
  )
}

export function PackChainEditor({ chain, baseUnit, dimension, onChange }: {
  chain: PackLink[]
  baseUnit: string
  dimension: Dimension
  onChange: (chain: PackLink[]) => void
}) {
  const setLink = (i: number, patch: Partial<PackLink>) =>
    onChange(chain.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
  const removeLink = (i: number) => onChange(chain.filter((_, idx) => idx !== i))
  const addLink = () => onChange([...chain, { unit: 'each', per: 1 }])

  return (
    <div className="space-y-2">
      <label className="block text-xs font-medium text-ink-3">Pack chain <span className="text-ink-4 normal-case font-normal">(outer → inner)</span></label>
      {chain.map((link, i) => {
        const isLeaf = i === chain.length - 1
        // The innermost level of a weight/volume item carries the base content, so
        // let the user enter it in any same-dimension unit and auto-convert to base.
        const measuredLeaf = isLeaf && dimension !== 'COUNT'
        return (
          <div key={i} className="flex items-center gap-2">
            <select
              value={link.unit}
              onChange={e => setLink(i, { unit: e.target.value })}
              className="flex-1 border border-line rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-gold bg-white"
            >
              {levelUnitOptions(dimension, link.unit).map(u => <option key={u} value={u}>{u}</option>)}
            </select>
            {measuredLeaf ? (
              <LeafSizeInput
                perBase={Number(link.per) || 0}
                dimension={dimension}
                onChange={per => setLink(i, { per })}
              />
            ) : (
              <div className="flex items-center">
                <input
                  type="number"
                  step="any"
                  min="0"
                  value={link.per}
                  onChange={e => setLink(i, { per: parseFloat(e.target.value) || 0 })}
                  className="w-24 border border-line rounded-l-lg px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-gold border-r-0"
                />
                <span className="border border-line rounded-r-lg px-2 py-2 text-sm text-ink-3 bg-bg min-w-[2.5rem] text-center">
                  {isLeaf ? baseUnit : '×'}
                </span>
              </div>
            )}
            <button
              type="button"
              onClick={() => removeLink(i)}
              disabled={chain.length <= 1}
              aria-label="Remove level"
              className="w-8 h-8 shrink-0 grid place-items-center rounded-lg border border-line text-ink-3 hover:border-red-text hover:text-red-text disabled:opacity-30 disabled:hover:border-line disabled:hover:text-ink-3 transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        )
      })}
      <button
        type="button"
        onClick={addLink}
        className="text-xs font-medium text-gold-2 hover:text-gold transition-colors"
      >
        + add level
      </button>
    </div>
  )
}

export function PricingEditor({ dimension, pricing, onChange }: {
  dimension: Dimension
  pricing: Pricing
  onChange: (p: Pricing) => void
}) {
  const setMode = (mode: 'PACK' | 'RATE') => {
    if (mode === pricing.mode) return
    onChange(
      mode === 'PACK'
        ? { mode: 'PACK', purchasePrice: 0 }
        : { mode: 'RATE', rate: 0, rateUnit: DIM_UNITS[dimension][0] },
    )
  }
  return (
    <div className="space-y-3">
      <div className="flex gap-2 p-1 bg-bg-2 rounded-xl">
        {(['PACK', 'RATE'] as const).map(m => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`flex-1 py-2 rounded-lg text-xs font-medium transition-all ${
              pricing.mode === m ? 'bg-white text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2'
            }`}
          >
            {m === 'PACK' ? 'Per pack' : 'Per unit (rate)'}
          </button>
        ))}
      </div>
      {pricing.mode === 'PACK' ? (
        <div>
          <label className="block text-xs font-medium text-ink-3 mb-1">Purchase price ($)</label>
          <input
            type="number"
            step="any"
            value={pricing.purchasePrice}
            onChange={e => onChange({ mode: 'PACK', purchasePrice: parseFloat(e.target.value) || 0 })}
            className={inputCls}
          />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-ink-3 mb-1">Rate ($)</label>
            <input
              type="number"
              step="any"
              value={pricing.rate}
              onChange={e => onChange({ mode: 'RATE', rate: parseFloat(e.target.value) || 0, rateUnit: pricing.rateUnit })}
              className={inputCls}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-3 mb-1">Per</label>
            <select
              value={pricing.rateUnit}
              onChange={e => onChange({ mode: 'RATE', rate: pricing.rate, rateUnit: e.target.value })}
              className={`${inputCls} bg-white`}
            >
              {DIM_UNITS[dimension].map(u => <option key={u}>{u}</option>)}
            </select>
          </div>
        </div>
      )}
    </div>
  )
}
