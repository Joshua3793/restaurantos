'use client'
import type { Dispatch, SetStateAction } from 'react'
import { ClipboardCheck } from 'lucide-react'
import { formatPricePerBase } from '@/lib/utils'
import { DIMENSION_BASE, pricePerBaseUnit, basePerUnit, type Pricing } from '@/lib/item-model'
import { resolveCountUom } from '@/lib/count-uom'
import {
  DIM_UNITS, countUnitOptions, DimensionToggle, PackChainEditor, PricingEditor,
} from '@/components/inventory/ItemChainEditor'
import { AllergenToggles } from '@/components/AllergenBadges'
import type { RevenueCenter } from '@/contexts/RevenueCenterContext'
import { measureWord } from '@/lib/remeasure-copy'
import { lookupDensity } from '@/lib/density'
import { Combobox } from '../Combobox'
import { displayStock, itemChainDims, type EditForm, type InventoryItem } from './types'

type Named = { id: string; name: string }

/** The edit-mode body of the drawer. The name field and Save/Cancel live in the
 *  header; the save itself (allow-list PUT + `/pricing` PATCH + R7 bridge confirm +
 *  STALE handling) lives in the shell. */
export function ItemEditForm({
  item, editForm, setEditForm, categories, onCategoriesChange,
  storageAreas, onStorageAreasChange, canEdit, activeRc, onCount, onRemeasure,
}: {
  item: InventoryItem
  editForm: EditForm
  setEditForm: Dispatch<SetStateAction<EditForm>>
  categories: Named[]
  onCategoriesChange: (cats: Named[]) => void
  storageAreas: Named[]
  onStorageAreasChange: (areas: Named[]) => void
  canEdit: boolean
  activeRc: RevenueCenter | null
  onCount: () => void
  onRemeasure: () => void
}) {
  return (
    <div className="p-4 space-y-4">
      {/* Active */}
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={editForm.isActive}
          onChange={e => setEditForm(f => ({ ...f, isActive: e.target.checked }))}
          className="w-4 h-4 rounded border-line-2 text-gold focus:ring-gold"
        />
        <span className="text-sm font-medium text-ink-2">Active</span>
        <span className="text-xs text-ink-4">&mdash; uncheck to exclude from inventory totals</span>
      </label>

      {/* Not stocked (recipe-only) */}
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={!editForm.isStocked}
          onChange={e => setEditForm(f => ({ ...f, isStocked: !e.target.checked }))}
          className="w-4 h-4 rounded border-line-2 text-gold focus:ring-gold"
        />
        <span className="text-sm font-medium text-ink-2">Not stocked (recipe-only)</span>
        <span className="text-xs text-ink-4">&mdash; e.g. tap water; usable in recipes at $0, hidden from counts &amp; purchasing</span>
      </label>

      {/* Category */}
      <div>
        <label className="block text-xs font-medium text-ink-3 mb-1">Category</label>
        <Combobox
          items={categories.map(c => ({ id: c.name, name: c.name }))}
          value={editForm.category}
          placeholder="Type to search categories…"
          onSelect={(_, name) => setEditForm(f => ({ ...f, category: name }))}
          onAddNew={async (name) => {
            const res = await fetch('/api/categories', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name }),
            })
            const cat = await res.json()
            fetch('/api/categories').then(r => r.json()).then(onCategoriesChange)
            return { id: cat.name, name: cat.name }
          }}
        />
      </div>

      {/* Supplier — read-only: an item's supplier IS its main (primary)
          supplier box, so it changes only by making another box main
          in the supplier boxes section below. */}
      <div>
        <label className="block text-xs font-medium text-ink-3 mb-1">Supplier</label>
        <div className="w-full border border-line rounded-lg px-3 py-2 text-sm text-ink-2 bg-bg">{item.supplier?.name ?? '—'}</div>
        <p className="mt-1 text-xs text-ink-4">From its main supplier box — make another box main to change it.</p>
      </div>

      {/* Storage Area */}
      <div>
        <label className="block text-xs font-medium text-ink-3 mb-1">Storage Area</label>
        <Combobox
          items={storageAreas}
          value={editForm.storageAreaName}
          placeholder="Type to search storage areas…"
          onSelect={(id, name) => setEditForm(f => ({ ...f, storageAreaId: id, storageAreaName: name }))}
          onAddNew={async (name) => {
            const res = await fetch('/api/storage-areas', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name }),
            })
            const area = await res.json()
            fetch('/api/storage-areas').then(r => r.json()).then(onStorageAreasChange)
            return { id: area.id, name: area.name }
          }}
        />
      </div>

      {item.recipe && (
        <div className="bg-blue-soft border border-blue-soft rounded-lg px-3 py-2 text-xs text-blue-text flex items-start gap-2">
          <span className="text-blue mt-0.5">⟳</span>
          <span>Made from the recipe <strong>{item.recipe.name}</strong>: its name, allergens, count unit and price are set there.</span>
        </div>
      )}

      {/* R3 — with a supplier box the price and pack live on the box. */}
      {!item.recipe && (item.offerCount ?? 0) > 0 && (
        <p className="text-xs text-ink-3 bg-bg-2 rounded-lg px-3 py-2">Price and pack come from its supplier boxes — close Edit to see them.</p>
      )}

      {/* Pricing chain — only an item with no recipe and no supplier box
          owns its price. Pricing mode first (top-level choice), then
          dimension, then chain. */}
      {!item.recipe && (item.offerCount ?? 0) === 0 && (
        <div className="space-y-3">
          <PricingEditor
            dimension={editForm.dimension}
            pricing={editForm.pricing}
            onChange={pricing => setEditForm(f => ({ ...f, pricing }))}
          />

          {/* R4 — the measure is locked once counts, deliveries or recipes use it. */}
          {item.hasHistory ? (
            <div className="text-xs text-ink-3 space-y-1.5">
              <p>Measured by {measureWord(editForm.dimension)} — locked because it has counts, deliveries or recipes.</p>
              {canEdit && !item.recipe && (
                <button
                  type="button" onClick={onRemeasure}
                  className="px-2.5 py-1 border border-line rounded-[8px] text-[12px] font-medium text-ink-2 hover:border-ink-3 transition-colors"
                >
                  Change how it&rsquo;s measured
                </button>
              )}
            </div>
          ) : (
            <DimensionToggle
              dimension={editForm.dimension}
              onChange={d => setEditForm(f => {
                // Switching dimension invalidates pricing rateUnit + may invalidate countUnit.
                const pricing: Pricing = f.pricing.mode === 'RATE'
                  ? { mode: 'RATE', rate: f.pricing.rate, rateUnit: DIM_UNITS[d][0] }
                  : f.pricing
                const opts = countUnitOptions(d, f.chain)
                return { ...f, dimension: d, pricing, countUnit: opts.includes(f.countUnit) ? f.countUnit : opts[0] }
              })}
            />
          )}

          <PackChainEditor
            chain={editForm.chain}
            baseUnit={DIMENSION_BASE[editForm.dimension]}
            dimension={editForm.dimension}
            onChange={chain => setEditForm(f => {
              const opts = countUnitOptions(f.dimension, chain)
              return { ...f, chain, countUnit: opts.includes(f.countUnit) ? f.countUnit : opts[0] }
            })}
          />
        </div>
      )}

      {/* Count↔weight bridge — "1 each = N g/ml". On a COUNT item it's
          the per-each weight; on a measured item it's how much one
          countable each weighs (so count invoices/recipes convert). */}
      <div>
        <label className="block text-xs font-medium text-ink-3 mb-1">
          {editForm.dimension === 'COUNT' ? 'Weight / volume per unit' : 'Weight per each (for count invoices)'}{' '}
          <span className="font-normal text-ink-4">(optional)</span>
        </label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={editForm.eachMeasureQty ?? ''}
            onChange={e => setEditForm(f => ({ ...f, eachMeasureQty: e.target.value === '' ? null : Number(e.target.value) }))}
            placeholder="e.g. 1100"
            className="flex-1 border border-line rounded-l-lg px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-gold border-r-0"
          />
          <select
            value={editForm.eachMeasureUnit}
            onChange={e => setEditForm(f => ({ ...f, eachMeasureUnit: e.target.value }))}
            className="border border-line rounded-r-lg pl-2 pr-1 py-2 text-sm text-ink-2 bg-bg focus:outline-none focus:ring-2 focus:ring-gold"
          >
            {/* a stored unit outside g/ml (e.g. lb) stays selectable, or a click would silently swap it */}
            {editForm.eachMeasureUnit && !['g', 'ml'].includes(editForm.eachMeasureUnit) && (
              <option value={editForm.eachMeasureUnit}>{editForm.eachMeasureUnit}</option>
            )}
            <option value="g">g</option>
            <option value="ml">ml</option>
          </select>
        </div>
        <p className="text-[10.5px] text-ink-4 mt-1">
          {editForm.dimension === 'COUNT'
            ? 'Lets weight-format invoices receive as units and weight-based recipes cost correctly.'
            : 'Lets count-format invoices (e.g. "70 each") be received and costed against this item.'}
        </p>
      </div>

      {/* Density bridge — weight↔volume conversion for measured items */}
      {editForm.dimension !== 'COUNT' && (
        <div>
          <label className="block text-xs font-medium text-ink-3 mb-1">
            Density (weight ↔ volume bridge) <span className="font-normal text-ink-4">(optional)</span>
          </label>
          <div className="flex items-center gap-2">
            <span className="text-sm text-ink-2">1 ml =</span>
            <input
              type="number" inputMode="decimal" min="0" step="any"
              value={editForm.densityGPerMl ?? ''}
              onChange={e => setEditForm(f => ({ ...f, densityGPerMl: e.target.value === '' ? null : Number(e.target.value) }))}
              placeholder={String(lookupDensity(editForm.itemName ?? '').gPerMl)}
              className="flex-1 border border-line rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-gold"
            />
            <span className="text-sm text-ink-3">g</span>
          </div>
          <p className="text-[10.5px] text-ink-4 mt-1">
            Lets a weight invoice ($/kg) price this {editForm.dimension === 'VOLUME' ? 'volume' : 'weight'} item across weight↔volume at the right density. Blank = the library default ({lookupDensity(editForm.itemName ?? '').gPerMl} g/ml, an estimate) is used until you set it here.
          </p>
        </div>
      )}

      {/* Count unit + stock. R2 — stock is read-only here: it changes
          only through a count (or receipts, wastage, transfers). */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-ink-3 mb-1">Count unit</label>
          <select value={editForm.countUnit} onChange={e => setEditForm(f => ({ ...f, countUnit: e.target.value }))}
            disabled={!!item.recipe}
            className="w-full border border-line rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-gold bg-white disabled:bg-bg disabled:text-ink-3">
            {/* a stored count unit outside the options stays selectable, or the select would swap it */}
            {!countUnitOptions(editForm.dimension, editForm.chain).includes(editForm.countUnit) && (
              <option value={editForm.countUnit}>{editForm.countUnit}</option>
            )}
            {countUnitOptions(editForm.dimension, editForm.chain).map(u => <option key={u} value={u}>{u}</option>)}
          </select>
        </div>
        <div>
          <div className="block text-xs font-medium text-ink-3 mb-1">Stock</div>
          <div className="flex items-center gap-2">
            <span className="flex-1 min-w-0 text-sm text-ink-2 py-2 truncate">
              On hand: {parseFloat(displayStock(item).toFixed(2)).toLocaleString()} {resolveCountUom(itemChainDims(item)) || item.baseUnit}
            </span>
            <button
              type="button"
              onClick={onCount}
              disabled={!activeRc}
              title={activeRc ? `Count it now (${activeRc.name})` : 'Pick a revenue center to count'}
              className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 border border-line text-[12px] font-medium text-ink-2 rounded-[8px] hover:border-ink-3 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ClipboardCheck size={12} /> Count now
            </button>
          </div>
        </div>
      </div>

      {/* Barcode */}
      <div>
        <label className="block text-xs font-medium text-ink-3 mb-1">Barcode</label>
        <input
          type="text"
          value={editForm.barcode ?? ''}
          onChange={e => setEditForm(f => ({ ...f, barcode: e.target.value || null }))}
          placeholder="Scan or type barcode"
          className="w-full border border-line rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-gold"
        />
      </div>

      {/* Allergens */}
      <div>
        <label className="block text-xs font-medium text-ink-3 mb-2">Allergens (Health Canada Big 9)</label>
        <AllergenToggles
          disabled={!!item.recipe}
          active={new Set(editForm.allergens)}
          onToggle={key => setEditForm(f => ({
            ...f,
            allergens: f.allergens.includes(key)
              ? f.allergens.filter(x => x !== key)
              : [...f.allergens, key],
          }))}
        />
      </div>

      {/* Live preview */}
      {(() => {
        const isPrep = !!item.recipe
        const ci = {
          dimension: editForm.dimension,
          baseUnit: DIMENSION_BASE[editForm.dimension],
          packChain: editForm.chain,
          pricing: editForm.pricing,
          countUnit: editForm.countUnit,
          // Bridges — without them a bridged RATE (e.g. $/lb on an `each`
          // item) previews at $0 even though it prices fine once saved.
          eachMeasure: editForm.eachMeasureQty != null
            ? { qty: editForm.eachMeasureQty, unit: editForm.eachMeasureUnit }
            : null,
          densityGPerMl: editForm.densityGPerMl,
        }
        const ppbu = isPrep ? Number(item.pricePerBaseUnit ?? 0) : pricePerBaseUnit(ci)
        const perCount = basePerUnit(ci, editForm.countUnit)
        return (
          <div className={`rounded-lg p-3 space-y-1.5 ${isPrep ? 'bg-blue-soft' : 'bg-gold-soft'}`}>
            <div className={`text-xs font-semibold uppercase tracking-wide ${isPrep ? 'text-blue-text' : 'text-gold-2'}`}>
              {isPrep ? 'Recipe-derived cost' : 'Live preview'}
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className={`text-xs ${isPrep ? 'text-blue' : 'text-gold-2'}`}>Price:</span>
              <span className={`text-lg font-bold ${isPrep ? 'text-blue-text' : 'text-gold-2'}`}>{formatPricePerBase(ppbu, ci.baseUnit)}</span>
            </div>
            <div className={`text-xs ${isPrep ? 'text-blue' : 'text-gold-2'}`}>
              1 {editForm.countUnit} = {perCount.toLocaleString()} {ci.baseUnit}
            </div>
          </div>
        )
      })()}
    </div>
  )
}
