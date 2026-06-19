'use client'
import { X } from 'lucide-react'
import { DIMENSION_BASE, type Dimension, type PackLink, type Pricing } from '@/lib/item-model'

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

const inputCls =
  'w-full border border-line rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-gold'

/** Count-unit options: chain level names + same-dimension units, deduped. */
export function countUnitOptions(dimension: Dimension, chain: PackLink[]): string[] {
  return [...new Set([...chain.map(l => l.unit), ...DIM_UNITS[dimension]])]
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

export function PackChainEditor({ chain, baseUnit, onChange }: {
  chain: PackLink[]
  baseUnit: string
  onChange: (chain: PackLink[]) => void
}) {
  const setLink = (i: number, patch: Partial<PackLink>) =>
    onChange(chain.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
  const removeLink = (i: number) => onChange(chain.filter((_, idx) => idx !== i))
  const addLink = () => onChange([...chain, { unit: 'unit', per: 1 }])

  return (
    <div className="space-y-2">
      <label className="block text-xs font-medium text-ink-3">Pack chain <span className="text-ink-4 normal-case font-normal">(outer → inner)</span></label>
      {chain.map((link, i) => {
        const isLeaf = i === chain.length - 1
        return (
          <div key={i} className="flex items-center gap-2">
            <input
              value={link.unit}
              onChange={e => setLink(i, { unit: e.target.value })}
              placeholder="unit"
              className="flex-1 border border-line rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-gold"
            />
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
