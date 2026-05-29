# Fergie's OS — Feature Components — recipes, inventory, prep, suppliers, wastage

Recipe/menu shared components, inventory drawers, prep, suppliers, wastage charts.


---

## `src/components/recipes/shared.tsx`

```tsx
'use client'
// ─── Shared types, helpers and components used by both Recipe Book and Menu pages ───
import { useEffect, useState, useCallback, useRef, memo } from 'react'
import { createPortal } from 'react-dom'
import { formatCurrency, formatUnitPrice, formatQtyUnit, calcPricePerBaseUnit, deriveBaseUnit, PACK_UOMS, compatibleCountUnits, getUnitDimension } from '@/lib/utils'
import { UOM_GROUPS, getUnitGroup, convertQty } from '@/lib/uom'
import {
  Plus, X, ChefHat, BookOpen, UtensilsCrossed, Search, MoreHorizontal,
  ArrowLeft, ChevronDown, ChevronUp, Pencil, Check, Trash2, Copy,
  Link2, Package, ExternalLink, Printer, Star, Share2,
} from 'lucide-react'
import { AllergenBadges } from '@/components/AllergenBadges'
import { InventoryItemDrawer } from '@/components/inventory/InventoryItemDrawer'
import { EditorDrawer } from '@/components/layout/EditorDrawer'

// ─── Markdown renderer (bold + italic only) ───────────────────────────────────
function renderMarkdown(text: string) {
  return text.split('\n').map((line, li, lines) => {
    const parts = line.split(/(\*\*[\s\S]+?\*\*|\*[^*]+?\*|_[^_]+?_)/)
    const nodes = parts.map((part, i) => {
      if (/^\*\*[\s\S]+?\*\*$/.test(part)) return <strong key={i}>{part.slice(2, -2)}</strong>
      if (/^\*[^*]+?\*$/.test(part) || /^_[^_]+?_$/.test(part)) return <em key={i}>{part.slice(1, -1)}</em>
      return part
    })
    return <span key={li}>{nodes}{li < lines.length - 1 && <br />}</span>
  })
}

// ─── Types ────────────────────────────────────────────────────────────────────
export interface RecipeCategory {
  id: string
  name: string
  type: string
  color: string | null
  sortOrder: number
  revenueCenterId: string | null
  _count?: { recipes: number }
}

export interface IngredientWithCost {
  id: string
  sortOrder: number
  qtyBase: number
  unit: string
  notes: string | null
  recipePercent: number | null
  inventoryItemId: string | null
  linkedRecipeId: string | null
  ingredientName: string
  ingredientType: 'inventory' | 'recipe'
  pricePerBaseUnit: number
  lineCost: number
  ingredientBaseUnit: string
}

export interface Recipe {
  id: string
  name: string
  type: string
  categoryId: string
  categoryName: string
  categoryColor: string | null
  inventoryItemId: string | null
  revenueCenterId: string | null
  baseYieldQty: number
  yieldUnit: string
  portionSize: number | null
  portionUnit: string | null
  menuPrice: number | null
  isActive: boolean
  notes: string | null
  createdAt: string
  updatedAt: string
  ingredients: IngredientWithCost[]
  totalCost: number
  costPerPortion: number | null
  foodCostPct: number | null
  usedInCount?: number
  usedInRecipes?: Array<{ id: string; name: string; type: string }>
  allergens?: string[]
  baseIngredientId: string | null
}

/** Compute baker's percentages relative to a base (reference) ingredient.
 *  Weight and volume both included; volume uses 1 ml = 1 g approximation.
 *  Count / each ingredients are excluded (return null). */
function computeAutoPercents(
  ingredients: IngredientWithCost[],
  baseIngId: string
): Record<string, number | null> {
  const base = ingredients.find(i => i.id === baseIngId)
  if (!base) {
    console.warn('[baker%] base ingredient not found in list, id=', baseIngId, 'ids=', ingredients.map(i => i.id))
    return {}
  }
  const toGrams = (qty: number, unit: string | null | undefined): number | null => {
    if (!unit) return null
    const group = getUnitGroup(unit)
    if (group === 'Weight') return convertQty(qty, unit, 'g')
    if (group === 'Volume') return convertQty(qty, unit, 'ml') // 1 ml ≈ 1 g
    return null
  }
  const baseGrams = toGrams(Number(base.qtyBase), base.unit)
  console.log('[baker%] base=', base.ingredientName, 'unit=', JSON.stringify(base.unit), 'qtyBase=', base.qtyBase, 'baseGrams=', baseGrams)
  if (baseGrams === null || baseGrams <= 0) return {}
  return Object.fromEntries(
    ingredients.map(ing => {
      if (ing.id === baseIngId) return [ing.id, 100]
      const grams = toGrams(Number(ing.qtyBase), ing.unit)
      return [ing.id, grams === null ? null : Math.round((grams / baseGrams) * 1000) / 10]
    })
  )
}

interface IngredientSearchResult {
  type: 'inventory' | 'recipe'
  id: string
  name: string
  unit: string
  pricePerBaseUnit: number
  category: string
}

// ─── Constants ────────────────────────────────────────────────────────────────
const SCALE_PRESETS = [0.5, 1, 2, 3, 5, 10]
const FOOD_COST_GREEN = 28
const FOOD_COST_AMBER = 35

export const CATEGORY_PALETTE = [
  '#ef4444','#f97316','#eab308','#22c55e',
  '#14b8a6','#3b82f6','#8b5cf6','#ec4899',
]

// ─── Helpers ─────────────────────────────────────────────────────────────────
export function foodCostClass(pct: number | null): string {
  if (pct === null) return 'text-gray-500'
  if (pct < FOOD_COST_GREEN) return 'text-green-600'
  if (pct <= FOOD_COST_AMBER) return 'text-amber-500'
  return 'text-red-600'
}

export function catDot(color: string | null) {
  return (
    <span
      className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
      style={{ background: color ?? '#94a3b8' }}
    />
  )
}

// ─── InventoryItemDetail (minimal shape from GET /api/inventory/:id) ──────────
interface InventoryItemDetail {
  id: string; itemName: string; category: string
  supplierId: string | null; storageAreaId: string | null
  purchaseUnit: string; qtyPerPurchaseUnit: number
  purchasePrice: number; baseUnit: string
  packSize: number; packUOM: string; countUOM: string
  conversionFactor: number; pricePerBaseUnit: number
  stockOnHand: number; abbreviation: string | null; isActive: boolean
  recipe: { id: string; name: string } | null
}

// ─── InlineEdit ───────────────────────────────────────────────────────────────
export function InlineEdit({ value, onSave, className = '' }: { value: string; onSave: (v: string) => void; className?: string }) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { setVal(value) }, [value])
  useEffect(() => { if (editing) inputRef.current?.focus() }, [editing])

  const save = () => { setEditing(false); if (val.trim() && val !== value) onSave(val.trim()) }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={val}
        onChange={e => setVal(e.target.value)}
        onBlur={save}
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setVal(value); setEditing(false) } }}
        className={`border-b border-gold outline-none bg-transparent ${className}`}
      />
    )
  }
  return (
    <span onClick={() => setEditing(true)} className={`cursor-pointer hover:text-gold group ${className}`}>
      {value} <Pencil size={11} className="inline opacity-0 group-hover:opacity-40 ml-1" />
    </span>
  )
}

// ─── BulkActionBar ────────────────────────────────────────────────────────────
export function BulkActionBar({ count, onDeactivate, onDelete, onClear }: {
  count: number
  onDeactivate: () => void
  onDelete: () => void
  onClear: () => void
}) {
  return (
    <div className="fixed bottom-24 md:bottom-8 left-1/2 -translate-x-1/2 z-50 flex items-center gap-1 bg-ink text-paper rounded-[14px] shadow-2xl px-2 py-2 text-[13px]">
      <span className="px-3 font-mono text-[12px] font-semibold tabular-nums"><span className="text-gold">{count}</span> selected</span>
      <div className="w-px h-5 bg-white/15 mx-1" />
      <button
        onClick={onDeactivate}
        className="px-3 py-1.5 rounded-[10px] text-paper hover:bg-white/10 transition-colors font-medium"
      >
        Deactivate
      </button>
      <button
        onClick={onDelete}
        className="px-3 py-1.5 rounded-[10px] text-red-400 hover:bg-white/10 transition-colors font-medium"
      >
        Delete
      </button>
      <div className="w-px h-5 bg-white/15 mx-1" />
      <button
        onClick={onClear}
        className="px-2 py-1.5 rounded-[10px] text-ink-4 hover:text-paper hover:bg-white/10 transition-colors"
        title="Clear selection"
      >
        <X size={14} />
      </button>
    </div>
  )
}

// ─── RecipeCard ───────────────────────────────────────────────────────────────
export function RecipeCard({ recipe, onOpen, onToggle, onDuplicate, onDelete, isSelected, onSelect }: {
  recipe: Recipe
  onOpen: () => void
  onToggle: () => void
  onDuplicate: () => void
  onDelete?: () => void
  isSelected?: boolean
  onSelect?: () => void
}) {
  const [showMore, setShowMore] = useState(false)
  const [showPrint, setShowPrint] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)
  const moreButtonRef = useRef<HTMLButtonElement>(null)
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setShowMore(false)
        setConfirmDelete(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const openMore = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!showMore && moreButtonRef.current) {
      const rect = moreButtonRef.current.getBoundingClientRect()
      setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right })
    }
    setShowMore(s => !s)
  }

  const isMenu = recipe.type === 'MENU'
  const inactive = !recipe.isActive

  return (
    <div
      className="flex items-center gap-3 px-4 py-3 border-b border-line last:border-b-0 bg-paper hover:bg-bg-2/40 transition-colors cursor-pointer"
      onClick={onOpen}
    >
      {/* ── Selection checkbox (only when bulk-select is active) ── */}
      {onSelect && (
        <button
          onClick={e => { e.stopPropagation(); onSelect() }}
          className={`shrink-0 w-4 h-4 rounded-[4px] border-[1.5px] flex items-center justify-center transition-colors ${
            isSelected
              ? 'border-ink bg-ink'
              : 'border-line-2 hover:border-ink-3 bg-paper'
          }`}
        >
          {isSelected && <Check size={10} className="text-paper" strokeWidth={3} />}
        </button>
      )}

      {/* ── Faded content — everything except the more menu ── */}
      <div className={`flex items-center gap-3 flex-1 min-w-0 ${inactive ? 'opacity-50' : ''}`}>
        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: recipe.categoryColor ?? '#a1a1aa' }} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-ink text-[13.5px] tracking-[-0.01em]">{recipe.name}</span>
            {inactive && <span className="font-mono text-[10px] bg-bg-2 text-ink-3 px-1.5 py-0.5 rounded-full uppercase tracking-[0.04em]">Off</span>}
          </div>
          {/* Yield subtitle */}
          <div className="font-mono text-[11px] text-ink-3 mt-1 flex items-center gap-1.5">
            {!isMenu ? (
              <>
                <span>Yields <span className="text-ink-2 font-medium">{formatQtyUnit(recipe.baseYieldQty, recipe.yieldUnit)}</span></span>
                {recipe.portionSize && recipe.portionUnit && recipe.portionSize > 0 && (
                  <>
                    <span className="text-ink-4">·</span>
                    <span>
                      <span className="text-ink-2 font-medium">
                        {Math.round(recipe.baseYieldQty / recipe.portionSize)}
                      </span> × {formatQtyUnit(recipe.portionSize, recipe.portionUnit)} portions
                    </span>
                  </>
                )}
                {recipe.usedInCount !== undefined && recipe.usedInCount > 0 && (
                  <>
                    <span className="text-ink-4">·</span>
                    <span className="text-green-text font-medium" style={{ color: '#166534' }}>used in {recipe.usedInCount} {recipe.usedInCount === 1 ? 'dish' : 'dishes'}</span>
                  </>
                )}
              </>
            ) : (
              <>
                {recipe.portionSize && recipe.portionUnit ? (
                  <span>Per portion: <span className="text-ink-2 font-medium">{formatQtyUnit(recipe.portionSize, recipe.portionUnit)}</span></span>
                ) : (
                  <span>Yield: <span className="text-ink-2 font-medium">{formatQtyUnit(recipe.baseYieldQty, recipe.yieldUnit)}</span></span>
                )}
              </>
            )}
          </div>
          {recipe.allergens && recipe.allergens.length > 0 && (
            <div className="mt-1">
              <AllergenBadges allergens={recipe.allergens} size="xs" />
            </div>
          )}
        </div>

        {!isMenu && (
          <div className="hidden sm:flex flex-col items-end gap-0.5 text-right shrink-0">
            <span className="font-mono text-[13.5px] text-ink tracking-[-0.01em]">{formatCurrency(recipe.totalCost)}</span>
            <span className="font-mono text-[10.5px] text-ink-3">
              {recipe.baseYieldQty > 0 ? <><span className="text-ink-2 font-medium">{formatUnitPrice(recipe.totalCost / recipe.baseYieldQty)}</span> / {recipe.yieldUnit}</> : '—'}
            </span>
          </div>
        )}

        {isMenu && (() => {
          const fcPct = recipe.menuPrice ? (recipe.totalCost / recipe.menuPrice) * 100 : null
          const fcFill = fcPct === null
            ? 'bg-ink-4'
            : fcPct < FOOD_COST_GREEN
              ? 'bg-green-500'
              : fcPct <= FOOD_COST_AMBER
                ? 'bg-gold'
                : 'bg-red-500'
          return (
            <div className="hidden sm:flex flex-col items-end gap-1 text-right shrink-0">
              <div className="font-mono text-[13px] text-ink tracking-[-0.01em] flex items-center gap-1.5">
                <span className="text-ink-3">{formatCurrency(recipe.totalCost)}</span>
                <span className="text-ink-4">·</span>
                <span>{recipe.menuPrice !== null ? formatCurrency(recipe.menuPrice) : '—'}</span>
              </div>
              <span className={`font-mono text-[11px] font-medium ${foodCostClass(fcPct)}`}>
                {fcPct !== null ? `${fcPct.toFixed(1)}% food cost` : '—'}
              </span>
              {fcPct !== null && (
                <div className="relative h-1 w-24 bg-bg-2 rounded-full overflow-hidden">
                  <div className={`h-full rounded-full ${fcFill}`} style={{ width: `${Math.min(100, fcPct)}%` }} />
                  <div className="absolute top-[-2px] w-px h-2.5 bg-ink" style={{ left: `${FOOD_COST_GREEN}%` }} />
                </div>
              )}
            </div>
          )
        })()}

        <button
          onClick={e => { e.stopPropagation(); onToggle() }}
          className={`relative inline-flex h-[18px] w-[30px] shrink-0 cursor-pointer rounded-full transition-colors duration-200 focus:outline-none ${recipe.isActive ? 'bg-green-500' : 'bg-line-2'}`}
        >
          <span className={`pointer-events-none absolute top-[2px] inline-block h-[14px] w-[14px] rounded-full bg-paper shadow ring-0 transition-transform duration-200 ${recipe.isActive ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
        </button>

        {/* Print Card — always visible */}
        <button
          onClick={e => { e.stopPropagation(); setShowPrint(true) }}
          title="Print recipe card"
          className="p-1.5 rounded-[7px] text-ink-4 hover:text-ink hover:bg-bg-2 transition-colors shrink-0"
        >
          <Printer size={14} />
        </button>
      </div>

      {/* ── More menu (Duplicate + Delete only) ── */}
      <div className="relative shrink-0" ref={moreRef} onClick={e => e.stopPropagation()}>
        <button ref={moreButtonRef} onClick={openMore} className="p-1.5 rounded-[7px] text-ink-4 hover:text-ink hover:bg-bg-2 transition-colors">
          <MoreHorizontal size={14} />
        </button>
      </div>
      {showMore && menuPos && typeof document !== 'undefined' && createPortal(
        <div
          ref={moreRef}
          style={{ position: 'fixed', top: menuPos.top, right: menuPos.right, zIndex: 9999 }}
          className="bg-paper rounded-[10px] shadow-lg border border-line py-1 w-36"
          onClick={e => e.stopPropagation()}
        >
          <button onClick={() => { onDuplicate(); setShowMore(false) }} className="w-full px-3 py-2 text-[13px] text-left text-ink-2 hover:bg-bg-2 flex items-center gap-2">
            <Copy size={13} /> Duplicate
          </button>
          {onDelete && (
            <>
              <div className="border-t border-line my-1" />
              {confirmDelete ? (
                <div className="px-3 py-2">
                  <p className="text-[11px] text-ink-3 mb-2">Delete permanently?</p>
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => { setShowMore(false); setConfirmDelete(false); onDelete() }}
                      className="flex-1 px-2 py-1 bg-red-600 text-paper text-[11px] rounded-[6px] hover:bg-red-700"
                    >Delete</button>
                    <button
                      onClick={() => setConfirmDelete(false)}
                      className="flex-1 px-2 py-1 border border-line text-ink-2 text-[11px] rounded-[6px] hover:bg-bg-2"
                    >Cancel</button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmDelete(true)}
                  className="w-full px-3 py-2 text-[13px] text-left text-red-600 hover:bg-red-50 flex items-center gap-2"
                >
                  <Trash2 size={13} /> Delete
                </button>
              )}
            </>
          )}
        </div>,
        document.body
      )}
      {showPrint && typeof document !== 'undefined' && createPortal(
        <RecipePrintModal recipe={recipe} onClose={() => setShowPrint(false)} />,
        document.body
      )}
    </div>
  )
}

// ─── RecipePrintModal ─────────────────────────────────────────────────────────
function RecipePrintModal({ recipe, onClose }: { recipe: Recipe; onClose: () => void }) {
  const [scale, setScale] = useState(1)

  const scaledIngredients = recipe.ingredients.map(ing => ({
    ...ing,
    qtyBase: ing.qtyBase * scale,
    lineCost: ing.lineCost * scale,
  }))
  const scaledTotalCost = recipe.totalCost * scale
  const scaledYield = recipe.baseYieldQty * scale

  const handlePrint = () => window.print()

  return (
    <div className="fixed inset-0 z-[200] flex items-start justify-center p-4 overflow-y-auto print:p-0 print:inset-0 print:z-auto" onClick={e => e.stopPropagation()}>
      <div className="absolute inset-0 bg-black/50 print:hidden" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-2xl my-8 print:shadow-none print:rounded-none print:my-0 print:max-w-full">

        {/* Screen-only toolbar */}
        <div className="flex items-center justify-between p-4 border-b border-gray-100 print:hidden">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-gray-700">Scale:</span>
            {[0.5, 1, 2, 3, 5, 10].map(s => (
              <button
                key={s}
                onClick={() => setScale(s)}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${scale === s ? 'bg-gold text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
              >
                {s === 1 ? '×1 (base)' : `×${s}`}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handlePrint} className="flex items-center gap-2 bg-gold text-white px-3 py-1.5 rounded-lg text-sm hover:bg-[#a88930]">
              <Printer size={14} /> Print
            </button>
            <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Print card content */}
        <div className="p-8 print:p-6 font-sans">
          {/* Header */}
          <div className="flex items-start justify-between mb-6 pb-4 border-b-2 border-gray-900">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">{recipe.name}</h1>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-sm text-gray-500">{recipe.categoryName}</span>
                <span className="text-gray-300">·</span>
                <span className="text-sm font-medium text-gray-700">
                  {recipe.type === 'MENU' ? 'Menu Item' : 'Prep Recipe'}
                </span>
              </div>
            </div>
            <div className="text-right text-sm text-gray-500">
              <div className="text-xs uppercase tracking-wide font-semibold text-gray-400 mb-1">Yield</div>
              <div className="text-xl font-bold text-gray-900">
                {formatQtyUnit(scaledYield, recipe.yieldUnit)}
              </div>
              {recipe.portionSize && recipe.portionUnit && (
                <div className="text-xs text-gray-500 mt-0.5">
                  {formatQtyUnit(recipe.portionSize * scale, recipe.portionUnit)} / portion
                </div>
              )}
            </div>
          </div>

          {/* Ingredients */}
          <div className="mb-6">
            <h2 className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-3">Ingredients</h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left pb-1.5 font-semibold text-gray-600">Item</th>
                  <th className="text-right pb-1.5 font-semibold text-gray-600">Qty</th>
                  <th className="text-right pb-1.5 font-semibold text-gray-600">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {scaledIngredients.map(ing => (
                  <tr key={ing.id}>
                    <td className="py-1.5 text-gray-800">{ing.ingredientName}</td>
                    <td className="py-1.5 text-right text-gray-600">
                      {formatQtyUnit(ing.qtyBase, ing.unit)}
                    </td>
                    <td className="py-1.5 text-right text-gray-600">{formatCurrency(ing.lineCost)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-gray-900">
                  <td className="pt-2 font-bold text-gray-900">Total</td>
                  <td />
                  <td className="pt-2 text-right font-bold text-gray-900">{formatCurrency(scaledTotalCost)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Cost summary row */}
          <div className="grid grid-cols-3 gap-4 mb-6 bg-gray-50 rounded-xl p-4">
            <div className="text-center">
              <div className="text-xs font-semibold uppercase tracking-wide text-gray-400">Batch Cost</div>
              <div className="text-lg font-bold text-gray-900 mt-0.5">{formatCurrency(scaledTotalCost)}</div>
            </div>
            {recipe.costPerPortion !== null && (
              <div className="text-center border-l border-gray-200">
                <div className="text-xs font-semibold uppercase tracking-wide text-gray-400">Cost / Portion</div>
                <div className="text-lg font-bold text-gray-900 mt-0.5">{formatCurrency(recipe.costPerPortion)}</div>
              </div>
            )}
            {recipe.menuPrice !== null && (
              <div className="text-center border-l border-gray-200">
                <div className="text-xs font-semibold uppercase tracking-wide text-gray-400">Food Cost %</div>
                <div className={`text-lg font-bold mt-0.5 ${foodCostClass(recipe.foodCostPct)}`}>
                  {recipe.foodCostPct !== null ? `${recipe.foodCostPct.toFixed(1)}%` : '—'}
                </div>
              </div>
            )}
          </div>

          {/* Method notes */}
          {recipe.notes && (
            <div>
              <h2 className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-2">Method</h2>
              <p className="text-sm text-gray-700 leading-relaxed">{renderMarkdown(recipe.notes)}</p>
            </div>
          )}

          {/* Footer */}
          <div className="mt-8 pt-4 border-t border-gray-200 flex justify-between text-xs text-gray-400 print:block">
            <span>Fergie&rsquo;s Kitchen · CONTROLA OS</span>
            <span>Printed {new Date().toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' })}</span>
          </div>
        </div>
      </div>

      {/* Print styles */}
      <style>{`
        @media print {
          body > * { display: none !important; }
          .fixed.z-\\[200\\] { display: block !important; position: static !important; background: white; }
          .fixed.z-\\[200\\] .absolute { display: none !important; }
        }
      `}</style>
    </div>
  )
}

// ─── InventoryQuickEdit ───────────────────────────────────────────────────────
function InventoryQuickEdit({ inventoryItemId, onClose, onSaved }: {
  inventoryItemId: string
  onClose: () => void
  onSaved: () => void
}) {
  const [item, setItem]   = useState<InventoryItemDetail | null>(null)
  const [saving, setSaving] = useState(false)
  const [form, setForm]   = useState({
    purchasePrice: '0', qtyPerPurchaseUnit: '1',
    packSize: '1', packUOM: 'each', countUOM: 'each', stockOnHand: '0',
  })

  useEffect(() => {
    fetch(`/api/inventory/${inventoryItemId}`).then(r => r.json()).then((data: InventoryItemDetail) => {
      setItem(data)
      setForm({
        purchasePrice:      String(data.purchasePrice),
        qtyPerPurchaseUnit: String(data.qtyPerPurchaseUnit),
        packSize:           String(data.packSize ?? 1),
        packUOM:            data.packUOM ?? 'each',
        countUOM:           data.countUOM ?? 'each',
        stockOnHand:        String(data.stockOnHand),
      })
    })
  }, [inventoryItemId])

  const field = (key: string, label: string, node: React.ReactNode) => (
    <div>
      <label className="block text-[11px] font-medium text-gray-500 mb-1">{label}</label>
      {node}
    </div>
  )
  const numInput = (key: keyof typeof form, placeholder?: string) => (
    <input type="number" step="any" value={form[key]} placeholder={placeholder}
      onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
      className="w-full border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold" />
  )

  const handleSave = async () => {
    if (!item) return
    setSaving(true)
    await fetch(`/api/inventory/${inventoryItemId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        itemName:           item.itemName,
        category:           item.category,
        supplierId:         item.supplierId,
        storageAreaId:      item.storageAreaId,
        purchaseUnit:       item.purchaseUnit,
        abbreviation:       item.abbreviation,
        isActive:           item.isActive,
        purchasePrice:      form.purchasePrice,
        qtyPerPurchaseUnit: form.qtyPerPurchaseUnit,
        packSize:           form.packSize,
        packUOM:            form.packUOM,
        countUOM:           form.countUOM,
        stockOnHand:        form.stockOnHand,
      }),
    })
    setSaving(false)
    onSaved()
  }

  // Live preview of pricePerBaseUnit
  const pp   = parseFloat(form.purchasePrice)  || 0
  const qty  = parseFloat(form.qtyPerPurchaseUnit) || 1
  const ps   = parseFloat(form.packSize)        || 1
  const pu   = form.packUOM
  const isPrep  = !!item?.recipe
  const ppbu = isPrep
    ? (item ? item.pricePerBaseUnit : 0)
    : calcPricePerBaseUnit(pp, qty, 'each', null, ps, pu)
  const bu   = isPrep ? (item?.baseUnit ?? 'each') : deriveBaseUnit('each', pu)

  const inputCls = 'w-full border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold'
  const selectCls = inputCls + ' bg-white'

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div
        className="relative bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 pt-5 pb-4 border-b border-gray-100">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="font-semibold text-gray-900 truncate">{item?.itemName ?? '…'}</h3>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="text-[11px] text-gray-400">{item?.category}</span>
                {isPrep && (
                  <span className="text-[10px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded-full font-medium">
                    Recipe-managed
                  </span>
                )}
              </div>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 shrink-0 mt-0.5">
              <X size={16} />
            </button>
          </div>
          {isPrep && item?.recipe && (
            <p className="mt-2 text-xs text-purple-600 bg-purple-50 rounded-lg px-3 py-2">
              Price is set by recipe <strong>{item.recipe.name}</strong>. Only stock and count unit are editable here.
            </p>
          )}
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-3">
          {!isPrep && (
            <>
              <div className="grid grid-cols-2 gap-2">
                {field('purchasePrice', 'Purchase Price ($)', numInput('purchasePrice'))}
                {field('qtyPerPurchaseUnit', 'Qty per Case', numInput('qtyPerPurchaseUnit'))}
              </div>
              <div className="grid grid-cols-2 gap-2">
                {field('packSize', 'Pack Size', numInput('packSize', 'e.g. 480'))}
                {field('packUOM', 'Pack UOM',
                  <select value={form.packUOM} onChange={e => setForm(f => ({ ...f, packUOM: e.target.value }))} className={selectCls}>
                    {PACK_UOMS.map(u => <option key={u}>{u}</option>)}
                  </select>
                )}
              </div>
            </>
          )}

          <div className="grid grid-cols-2 gap-2">
            {field('countUOM', isPrep
              ? `Count UOM (${getUnitDimension(item?.baseUnit ?? 'each')}-compatible)`
              : 'Count UOM',
              <select value={form.countUOM} onChange={e => setForm(f => ({ ...f, countUOM: e.target.value }))} className={selectCls}>
                {(isPrep && item
                  ? compatibleCountUnits(item.baseUnit)
                  : ['each','pkg','case','kg','lb','g','l','ml','oz']
                ).map(u => <option key={u}>{u}</option>)}
              </select>
            )}
            {field('stockOnHand', `Stock On Hand (${form.countUOM})`, numInput('stockOnHand'))}
          </div>

          {/* Cost preview */}
          <div className={`rounded-xl p-3 ${isPrep ? 'bg-purple-50' : 'bg-gold/10'}`}>
            <div className={`text-[11px] font-semibold uppercase tracking-wide mb-1 ${isPrep ? 'text-purple-600' : 'text-gold'}`}>
              {isPrep ? 'Recipe-derived cost' : 'Cost preview'}
            </div>
            <div className={`text-xl font-bold ${isPrep ? 'text-purple-700' : 'text-gold'}`}>
              {formatUnitPrice(ppbu)}<span className="text-sm font-normal ml-1">/ {bu}</span>
            </div>
            {!isPrep && (
              <div className="text-[11px] text-blue-500 mt-0.5">
                ${pp.toFixed(2)} ÷ ({qty} × {ps} {pu})
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 pb-5 flex gap-2">
          <button onClick={onClose} className="flex-1 border border-gray-200 rounded-xl py-2 text-sm text-gray-700 hover:bg-gray-50">
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving || !item}
            className="flex-1 bg-gold text-white rounded-xl py-2 text-sm font-medium hover:bg-[#a88930] disabled:opacity-50">
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── IngredientRow ────────────────────────────────────────────────────────────
const IngredientRow = memo(function IngredientRow({ ing, scaleFactor, canMoveUp, canMoveDown, onUpdate, onDelete, onMoveUp, onMoveDown, onSubstitute, onInventoryClick, isBase, baseIsSet, autoPercent, onSetBase }: {
  ing: IngredientWithCost
  scaleFactor: number
  canMoveUp: boolean
  canMoveDown: boolean
  onUpdate: (ingId: string, data: Record<string, unknown>) => void
  onDelete: (ingId: string) => void
  onMoveUp: () => void
  onMoveDown: () => void
  onSubstitute: (ingId: string, item: IngredientSearchResult) => void
  onInventoryClick?: (inventoryItemId: string) => void
  isBase: boolean
  baseIsSet: boolean
  autoPercent: number | null
  onSetBase: () => void
}) {
  const [editingQty, setEditingQty] = useState(ing.qtyBase === 0)
  const [editingPct, setEditingPct] = useState(false)
  const [qty, setQty] = useState(ing.qtyBase === 0 ? '' : String(ing.qtyBase))
  const [unit, setUnit] = useState(ing.unit)
  const [pct, setPct] = useState(ing.recipePercent !== null ? String(ing.recipePercent) : '')

  // Substitute-mode state (inline search)
  const [substituting, setSubstituting] = useState(false)
  const [subQ, setSubQ] = useState('')
  const [subResults, setSubResults] = useState<IngredientSearchResult[]>([])
  const subTimer = useRef<ReturnType<typeof setTimeout>>()
  const subInputRef = useRef<HTMLInputElement>(null)
  const subRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setQty(ing.qtyBase === 0 ? '' : String(ing.qtyBase)) }, [ing.qtyBase])
  useEffect(() => { setUnit(ing.unit) }, [ing.unit])
  useEffect(() => { setPct(ing.recipePercent !== null ? String(ing.recipePercent) : '') }, [ing.recipePercent])

  // Auto-focus search input when substituting mode opens
  useEffect(() => { if (substituting) subInputRef.current?.focus() }, [substituting])

  // Close substitute dropdown on outside click
  useEffect(() => {
    if (!substituting) return
    const handler = (e: MouseEvent) => {
      if (subRef.current && !subRef.current.contains(e.target as Node)) {
        setSubstituting(false); setSubQ(''); setSubResults([])
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [substituting])

  const doSubSearch = async (q: string) => {
    if (!q.trim()) { setSubResults([]); return }
    const data: IngredientSearchResult[] = await fetch(`/api/recipes/search-ingredients?q=${encodeURIComponent(q)}`).then(r => r.json())
    setSubResults(data)
  }

  const pickSubstitute = (item: IngredientSearchResult) => {
    setSubstituting(false); setSubQ(''); setSubResults([])
    onSubstitute(ing.id, item)
  }

  const saveQty = () => { setEditingQty(false); if (qty !== String(ing.qtyBase)) onUpdate(ing.id, { qtyBase: qty, unit }) }
  const saveUnit = (newUnit: string) => { setUnit(newUnit); onUpdate(ing.id, { qtyBase: qty, unit: newUnit }) }
  const savePct = () => {
    setEditingPct(false)
    const parsed = pct === '' ? null : parseFloat(pct)
    if (parsed !== ing.recipePercent) onUpdate(ing.id, { recipePercent: parsed })
  }

  const allKnownUnits = UOM_GROUPS.flatMap(g => g.units.map(u => u.label))
  const unitInList = allKnownUnits.includes(unit)
  const displayQty  = ing.qtyBase * scaleFactor
  const displayCost = ing.lineCost * scaleFactor

  // Only show units that are compatible with the ingredient's inventory base unit.
  const baseUnitGroup = getUnitGroup(ing.ingredientBaseUnit)
  const compatibleGroups = baseUnitGroup
    ? UOM_GROUPS.filter(g => g.label === baseUnitGroup)
    : UOM_GROUPS

  const needsQty = ing.ingredientType === 'inventory' && (!ing.qtyBase || ing.qtyBase === 0)
  const pctValue = isBase ? 100 : (baseIsSet ? autoPercent : (ing.recipePercent ?? null))
  const pctBarColor = isBase ? 'bg-gold' : 'bg-ink'

  return (
    <div className={`border-t border-line ${needsQty ? 'bg-gold-soft/40' : ''}`}>
      <div className="grid grid-cols-12 gap-2 px-3 py-2.5 items-center hover:bg-bg/60 group">
        <div className="col-span-1 flex flex-col items-center">
          <button onClick={onMoveUp} disabled={!canMoveUp} className="text-ink-4 hover:text-ink-2 disabled:opacity-0 leading-none transition-colors"><ChevronUp size={13} /></button>
          <button onClick={onMoveDown} disabled={!canMoveDown} className="text-ink-4 hover:text-ink-2 disabled:opacity-0 leading-none transition-colors"><ChevronDown size={13} /></button>
        </div>

        <div className="col-span-3 flex items-center gap-1.5 min-w-0">
          <button
            onClick={onSetBase}
            title={isBase ? "Remove baker's % reference" : "Set as 100% reference for baker's percentages"}
            className={`shrink-0 leading-none transition-colors ${
              isBase ? 'text-gold-2' : 'text-ink-4/50 hover:text-gold-2 group-hover:text-ink-4'
            }`}
          >
            <Star size={10} fill={isBase ? 'currentColor' : 'none'} />
          </button>
          <span className={`w-5 h-5 rounded-[5px] border border-line flex items-center justify-center shrink-0 ${
            ing.ingredientType === 'recipe' ? 'bg-green-soft text-gold-2' : 'bg-bg-2 text-ink-3'
          }`} title={ing.ingredientType === 'recipe' ? 'Sub-recipe' : 'Inventory item'}>
            {ing.ingredientType === 'recipe'
              ? <ChefHat size={11} />
              : <Package size={11} />
            }
          </span>
          <div className="min-w-0 flex items-center gap-1.5 flex-wrap">
            {ing.ingredientType === 'inventory' && ing.inventoryItemId && onInventoryClick ? (
              <button
                onClick={() => onInventoryClick(ing.inventoryItemId!)}
                className="text-[13px] text-ink line-clamp-2 break-words leading-snug text-left hover:text-gold-2 hover:underline underline-offset-2 transition-colors"
                title="Open inventory item"
              >
                {ing.ingredientName}
              </button>
            ) : (
              <span className="text-[13px] text-ink line-clamp-2 break-words leading-snug">{ing.ingredientName}</span>
            )}
            {ing.ingredientType === 'recipe' && (
              <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.04em] text-gold-2 bg-green-soft px-1.5 py-0.5 rounded-[4px]">Recipe</span>
            )}
            {needsQty && (
              <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.04em] text-gold-2 bg-gold-soft px-1.5 py-0.5 rounded-[4px]">Needs qty</span>
            )}
          </div>
        </div>

        <div className="col-span-1 text-center">
          {baseIsSet ? (
            <div className="flex flex-col items-center gap-0.5">
              {isBase ? (
                <span className="font-mono text-[11px] font-bold text-gold-2">100%</span>
              ) : autoPercent !== null ? (
                <span className="font-mono text-[11px] font-semibold text-ink-2">{autoPercent}%</span>
              ) : (
                <span className="text-[11px] text-ink-4" title="Count ingredient — no baker's % for each/piece/serve">—</span>
              )}
              {pctValue !== null && (
                <div className="w-full h-[3px] bg-bg-2 rounded-full overflow-hidden">
                  <div className={`h-full rounded-full ${pctBarColor}`} style={{ width: `${Math.min(100, pctValue)}%` }} />
                </div>
              )}
            </div>
          ) : editingPct ? (
            <input type="number" value={pct} onChange={e => setPct(e.target.value)} onBlur={savePct}
              onKeyDown={e => e.key === 'Enter' && savePct()} placeholder="0"
              className="w-full text-center border border-gold rounded px-0.5 py-0.5 text-xs text-ink focus:outline-none" autoFocus />
          ) : (
            <span onClick={() => setEditingPct(true)} className={`font-mono text-[11px] cursor-pointer rounded px-0.5 ${
              ing.recipePercent !== null ? 'font-semibold text-ink-2 hover:text-ink' : 'text-ink-4 hover:text-ink-3'
            }`}>
              {ing.recipePercent !== null ? `${ing.recipePercent}%` : '—'}
            </span>
          )}
        </div>

        <div className="col-span-2 text-right">
          {editingQty ? (
            <input type="number" value={qty} onChange={e => setQty(e.target.value)} onBlur={saveQty}
              onKeyDown={e => e.key === 'Enter' && saveQty()}
              className={`w-full text-right border rounded px-1 py-0.5 text-sm text-ink focus:outline-none ${needsQty ? 'border-gold' : 'border-gold'}`} autoFocus />
          ) : (
            <span onClick={() => setEditingQty(true)} className={`font-mono text-[13px] cursor-pointer hover:text-gold-2 ${needsQty ? 'text-gold-2' : 'text-ink'}`}>
              {Number(displayQty.toFixed(3)).toString()}
            </span>
          )}
        </div>

        <div className="col-span-2">
          <select value={unitInList ? unit : '__custom__'} onChange={e => { if (e.target.value !== '__custom__') saveUnit(e.target.value) }}
            className="w-full border border-line rounded px-1 py-0.5 font-mono text-[11px] text-ink-2 bg-paper focus:outline-none focus:ring-1 focus:ring-gold">
            {!unitInList && <option value="__custom__">{unit}</option>}
            {compatibleGroups.map(group => (
              <optgroup key={group.label} label={group.label}>
                {group.units.map(u => <option key={u.label} value={u.label}>{u.label}</option>)}
              </optgroup>
            ))}
          </select>
        </div>

        <div className="col-span-2 text-right font-mono text-[13px] font-medium text-ink">{formatCurrency(displayCost)}</div>

        <div className="col-span-1 flex items-center justify-end gap-1">
          <button
            onClick={() => setSubstituting(s => !s)}
            title="Substitute ingredient"
            className={`transition-colors ${substituting ? 'text-blue-500' : 'text-gray-300 hover:text-blue-500'}`}
          >
            <Pencil size={12} />
          </button>
          <button onClick={() => onDelete(ing.id)} className="text-gray-300 hover:text-red-500"><Trash2 size={12} /></button>
        </div>
      </div>

      {/* Inline substitute search */}
      {substituting && (
        <div ref={subRef} className="relative px-3 pb-2">
          <div className="flex items-center gap-2 border border-blue-300 rounded-lg px-2 py-1.5 bg-blue-50">
            <Search size={13} className="text-blue-400 shrink-0" />
            <input
              ref={subInputRef}
              value={subQ}
              onChange={e => {
                setSubQ(e.target.value)
                clearTimeout(subTimer.current)
                subTimer.current = setTimeout(() => doSubSearch(e.target.value), 300)
              }}
              onKeyDown={e => { if (e.key === 'Escape') { setSubstituting(false); setSubQ(''); setSubResults([]) } }}
              placeholder={`Replace "${ing.ingredientName}" with…`}
              className="flex-1 text-sm text-gray-700 placeholder-gray-400 outline-none bg-transparent"
            />
            <button onClick={() => { setSubstituting(false); setSubQ(''); setSubResults([]) }} className="text-gray-400 hover:text-gray-600">
              <X size={13} />
            </button>
          </div>
          {subResults.length > 0 && (
            <div className="absolute left-3 right-3 top-full mt-1 bg-white border border-gray-200 rounded-xl shadow-xl z-50 max-h-52 overflow-y-auto">
              {subResults.map(item => (
                <button key={`${item.type}-${item.id}`} onClick={() => pickSubstitute(item)}
                  className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-gray-50 text-left text-sm">
                  {item.type === 'recipe' ? <ChefHat size={13} className="text-emerald-600 shrink-0" /> : <Package size={13} className="text-blue-500 shrink-0" />}
                  <span className="flex-1 text-gray-800">{item.name}</span>
                  <span className="text-xs text-gray-400">{item.unit}</span>
                  <span className="text-xs text-gray-500">{formatCurrency(item.pricePerBaseUnit)}/{item.unit}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded ${item.type === 'recipe' ? 'bg-emerald-50 text-emerald-600' : 'bg-gold/10 text-gold'}`}>
                    {item.type === 'recipe' ? 'PREP' : item.category}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
})

// ─── RecipePanel ──────────────────────────────────────────────────────────────
export function RecipePanel({ recipeId, categories, onClose, onUpdated }: {
  recipeId: string
  categories: RecipeCategory[]
  onClose: () => void
  onUpdated: () => void
}) {
  const [recipe, setRecipe] = useState<Recipe | null>(null)
  const [scaleFactor, setScaleFactor] = useState(1)
  const [customScale, setCustomScale] = useState('')
  const [searchQ, setSearchQ] = useState('')
  const [searchResults, setSearchResults] = useState<IngredientSearchResult[]>([])
  const [showSearch, setShowSearch] = useState(false)
  const [showNotes, setShowNotes] = useState(false)
  const [showPrint, setShowPrint] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showSaveScale, setShowSaveScale] = useState(false)
  const [newScaleName, setNewScaleName] = useState('')
  const [quickEditItemId, setQuickEditItemId] = useState<string | null>(null)
  const searchRef = useRef<HTMLDivElement>(null)
  const searchTimer = useRef<ReturnType<typeof setTimeout>>()
  const dirtyRef = useRef(false)
  const searchCache = useRef<Map<string, IngredientSearchResult[]>>(new Map())

  const load = useCallback(async () => {
    const data = await fetch(`/api/recipes/${recipeId}`).then(r => r.json())
    setRecipe(data)
  }, [recipeId])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) setShowSearch(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) { setSearchResults([]); return }
    const cached = searchCache.current.get(q)
    if (cached) { setSearchResults(cached); return }
    const data: IngredientSearchResult[] = await fetch(`/api/recipes/search-ingredients?q=${encodeURIComponent(q)}`).then(r => r.json())
    searchCache.current.set(q, data)
    setSearchResults(data)
  }, [])

  const patchRecipe = async (data: Record<string, unknown>) => {
    setSaving(true)
    try {
      const res = await fetch(`/api/recipes/${recipeId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      if (res.ok) {
        const updated = await res.json()
        setRecipe(updated)
        dirtyRef.current = true
      }
    } finally {
      setSaving(false)
    }
  }

  const setBaseIngredient = (ingId: string) => {
    const newBaseId = recipe?.baseIngredientId === ingId ? null : ingId
    patchRecipe({ baseIngredientId: newBaseId })
  }

  const addIngredient = async (item: IngredientSearchResult) => {
    // Close search immediately — don't wait for server
    setShowSearch(false); setSearchQ(''); setSearchResults([])

    // Optimistically add ingredient with a temp ID so it appears instantly
    const tempId = `temp-${Date.now()}`
    setRecipe(prev => {
      if (!prev) return prev
      const newIng: IngredientWithCost = {
        id: tempId,
        sortOrder: (prev.ingredients.at(-1)?.sortOrder ?? -1) + 1,
        qtyBase: 0,
        unit: item.unit,
        notes: null,
        recipePercent: null,
        inventoryItemId: item.type === 'inventory' ? item.id : null,
        linkedRecipeId: item.type === 'recipe' ? item.id : null,
        ingredientName: item.name,
        ingredientType: item.type,
        pricePerBaseUnit: item.pricePerBaseUnit,
        lineCost: 0,
        ingredientBaseUnit: item.unit,
      }
      return { ...prev, ingredients: [...prev.ingredients, newIng] }
    })

    // POST in background — reconcile temp ID with real ID on success
    const res = await fetch(`/api/recipes/${recipeId}/ingredients`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inventoryItemId: item.type === 'inventory' ? item.id : null, linkedRecipeId: item.type === 'recipe' ? item.id : null, qtyBase: 0, unit: item.unit }),
    })
    if (res.ok) {
      const { id: realId } = await res.json()
      setRecipe(prev => {
        if (!prev) return prev
        return { ...prev, ingredients: prev.ingredients.map(i => i.id === tempId ? { ...i, id: realId } : i) }
      })
      dirtyRef.current = true
    } else {
      // POST failed — remove the temp ingredient
      setRecipe(prev => {
        if (!prev) return prev
        return { ...prev, ingredients: prev.ingredients.filter(i => i.id !== tempId) }
      })
    }
  }

  const updateIngredient = useCallback(async (ingId: string, data: Record<string, unknown>) => {
    const newQtyBase = data.qtyBase !== undefined ? Number(data.qtyBase) : undefined
    const newUnit = data.unit !== undefined ? String(data.unit) : undefined

    // Optimistic update: immediately reflect qty/unit/cost changes in the UI
    if (newQtyBase !== undefined || newUnit !== undefined) {
      setRecipe(prev => {
        if (!prev) return prev
        const updatedIngredients = prev.ingredients.map(ing => {
          if (ing.id !== ingId) return ing
          const qtyBase = newQtyBase ?? ing.qtyBase
          const unit = newUnit ?? ing.unit
          const converted = convertQty(qtyBase, unit, ing.ingredientBaseUnit)
          const lineCost = (converted !== null ? converted : qtyBase) * ing.pricePerBaseUnit
          return { ...ing, qtyBase, unit, lineCost }
        })
        const totalCost = updatedIngredients.reduce((sum, i) => sum + i.lineCost, 0)
        return { ...prev, ingredients: updatedIngredients, totalCost }
      })
    }

    const res = await fetch(`/api/recipes/${recipeId}/ingredients/${ingId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
    if (res.ok) dirtyRef.current = true
  }, [recipeId])

  const deleteIngredient = useCallback(async (ingId: string) => {
    // Optimistic: remove immediately so the UI feels instant
    setRecipe(prev => {
      if (!prev) return prev
      const updatedIngredients = prev.ingredients.filter(i => i.id !== ingId)
      const totalCost = updatedIngredients.reduce((sum, i) => sum + i.lineCost, 0)
      return { ...prev, ingredients: updatedIngredients, totalCost }
    })
    dirtyRef.current = true

    const res = await fetch(`/api/recipes/${recipeId}/ingredients/${ingId}`, { method: 'DELETE' })
    if (res.ok) dirtyRef.current = true
  }, [recipeId])

  const substituteIngredient = useCallback(async (ingId: string, item: IngredientSearchResult) => {
    // Optimistic: update name, type, and zero the cost (server will recalculate)
    setRecipe(prev => {
      if (!prev) return prev
      const updatedIngredients = prev.ingredients.map(ing => {
        if (ing.id !== ingId) return ing
        return {
          ...ing,
          ingredientName: item.name,
          ingredientType: item.type,
          inventoryItemId: item.type === 'inventory' ? item.id : null,
          linkedRecipeId: item.type === 'recipe' ? item.id : null,
          pricePerBaseUnit: item.pricePerBaseUnit,
          ingredientBaseUnit: item.unit,
          lineCost: 0,
        }
      })
      const totalCost = updatedIngredients.reduce((sum, i) => sum + i.lineCost, 0)
      return { ...prev, ingredients: updatedIngredients, totalCost }
    })

    const body = item.type === 'inventory'
      ? { inventoryItemId: item.id }
      : { linkedRecipeId: item.id }

    const res = await fetch(`/api/recipes/${recipeId}/ingredients/${ingId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.ok) {
      dirtyRef.current = true
      // Reload to get accurate cost after substitution
      await load()
    }
  }, [recipeId, load])

  const handleClose = () => {
    onUpdated()
    onClose()
  }

  const saveScale = async () => {
    if (!newScaleName.trim()) return
    await fetch(`/api/recipes/${recipeId}/save-scale`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ newName: newScaleName, factor: scaleFactor }) })
    setShowSaveScale(false); setNewScaleName(''); onUpdated()
  }

  if (!recipe) return (
    <EditorDrawer onClose={() => { onUpdated(); onClose() }} titleBar={<div className="flex-1 font-mono text-[11px] text-ink-3 uppercase tracking-[0.04em]">Loading…</div>}>
      <div className="flex-1 flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gold" />
      </div>
    </EditorDrawer>
  )

  const sf = scaleFactor
  const isMenu = recipe.type === 'MENU'
  const scaledTotal = recipe.totalCost * sf
  const baseCostPerUnit = recipe.baseYieldQty > 0 ? recipe.totalCost / recipe.baseYieldQty : 0

  // Baker's % — auto-compute ratios relative to the marked base ingredient
  const baseIngId = recipe.baseIngredientId ?? null
  const autoPercents = baseIngId ? computeAutoPercents(recipe.ingredients, baseIngId) : {}
  const baseIsSet = baseIngId !== null && Object.keys(autoPercents).length > 0
  const baseIngName = baseIsSet ? recipe.ingredients.find(i => i.id === baseIngId)?.ingredientName : null
  const menuFoodCostPct = isMenu && recipe.menuPrice ? (recipe.totalCost / recipe.menuPrice) * 100 : null
  const margin = recipe.menuPrice !== null ? recipe.menuPrice - recipe.totalCost : null

  // ── Title bar slot for <EditorDrawer> ──────────────────────────────────────
  const titleBar = (
    <>
      <div className="flex-1 min-w-0">
        <InlineEdit value={recipe.name} onSave={name => patchRecipe({ name })} className="text-[20px] font-semibold text-ink tracking-[-0.03em] leading-tight" />
        <div className="flex items-center gap-2 mt-1.5">
          {isMenu ? (
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-gold-2 bg-gold-soft px-2 py-0.5 rounded-full flex items-center gap-1">
              <UtensilsCrossed size={10} /> Menu
            </span>
          ) : (
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-green-700 bg-green-50 px-2 py-0.5 rounded-full flex items-center gap-1">
              <BookOpen size={10} /> Recipe
            </span>
          )}
          {recipe.inventoryItemId && (
            <a href={`/inventory?highlight=${recipe.inventoryItemId}`}
              className="font-mono text-[10px] uppercase tracking-[0.06em] bg-bg-2 text-ink-3 px-2 py-0.5 rounded-full flex items-center gap-1 hover:text-ink-2 transition-colors"
              onClick={e => e.stopPropagation()}
              title="View in Inventory">
              <Link2 size={9} /> Synced <ExternalLink size={8} />
            </a>
          )}
        </div>
      </div>
      {saving && <div className="w-1.5 h-1.5 rounded-full bg-gold animate-pulse" />}
      <button onClick={() => patchRecipe({ isActive: !recipe.isActive })}
        className={`relative inline-flex h-[22px] w-9 shrink-0 cursor-pointer rounded-full transition-colors duration-200 focus:outline-none ${recipe.isActive ? 'bg-green-500' : 'bg-line-2'}`}>
        <span className={`pointer-events-none absolute top-[2px] inline-block h-[18px] w-[18px] rounded-full bg-paper shadow ring-0 transition-transform duration-200 ${recipe.isActive ? 'translate-x-[16px]' : 'translate-x-[2px]'}`} />
      </button>
      <button onClick={() => setShowPrint(true)} title="Print recipe card"
        className="p-1.5 rounded-[7px] text-ink-3 hover:text-ink hover:bg-bg-2 transition-colors">
        <Printer size={16} />
      </button>
    </>
  )

  // ── Cost strip slot ────────────────────────────────────────────────────────
  const costStrip = recipe.totalCost > 0 ? (
            <div className="bg-ink px-5 py-3.5 flex items-center gap-1 text-[11.5px] overflow-x-auto">
              {isMenu ? (
                <>
                  <div className="flex flex-col shrink-0">
                    <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-4">Cost</span>
                    <span className="font-mono text-[16px] font-semibold text-paper leading-tight">{formatCurrency(recipe.totalCost)}</span>
                  </div>
                  <div className="w-px h-9 bg-zinc-800 mx-4 shrink-0" />
                  <div className="flex flex-col shrink-0">
                    <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-4">Price</span>
                    <span className="font-mono text-[16px] font-semibold text-paper leading-tight">{recipe.menuPrice !== null ? formatCurrency(recipe.menuPrice) : <span className="text-zinc-600 italic">unset</span>}</span>
                  </div>
                  <div className="w-px h-9 bg-zinc-800 mx-4 shrink-0" />
                  <div className="flex flex-col shrink-0">
                    <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-4">Food cost</span>
                    <span className={`font-mono text-[16px] font-bold leading-tight ${menuFoodCostPct !== null ? (menuFoodCostPct < FOOD_COST_GREEN ? 'text-green-400' : menuFoodCostPct <= FOOD_COST_AMBER ? 'text-gold' : 'text-red-400') : 'text-zinc-600'}`}>
                      {menuFoodCostPct !== null ? `${menuFoodCostPct.toFixed(1)}%` : '—'}
                    </span>
                  </div>
                  {margin !== null && (
                    <>
                      <div className="w-px h-9 bg-zinc-800 mx-4 shrink-0" />
                      <div className="flex flex-col shrink-0">
                        <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-4">Margin</span>
                        <span className={`font-mono text-[16px] font-semibold leading-tight ${margin >= 0 ? 'text-green-400' : 'text-red-400'}`}>{formatCurrency(margin)}</span>
                      </div>
                    </>
                  )}
                  {menuFoodCostPct !== null && (
                    <div className="ml-auto relative h-1.5 w-32 bg-zinc-800 rounded-full overflow-hidden shrink-0">
                      <div
                        className={`h-full rounded-full ${menuFoodCostPct < FOOD_COST_GREEN ? 'bg-green-500' : menuFoodCostPct <= FOOD_COST_AMBER ? 'bg-gold' : 'bg-red-500'}`}
                        style={{ width: `${Math.min(100, menuFoodCostPct)}%` }}
                      />
                      <div className="absolute top-[-3px] w-px h-3.5 bg-gold" style={{ left: `${FOOD_COST_GREEN}%` }} />
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="flex flex-col shrink-0">
                    <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-4">Batch</span>
                    <span className="font-mono text-[16px] font-semibold text-paper leading-tight">{formatCurrency(recipe.totalCost)}</span>
                  </div>
                  <div className="w-px h-9 bg-zinc-800 mx-4 shrink-0" />
                  <div className="flex flex-col shrink-0">
                    <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-4">Per {recipe.yieldUnit}</span>
                    <span className="font-mono text-[16px] font-semibold text-paper leading-tight">
                      {recipe.baseYieldQty > 0 ? formatCurrency(recipe.totalCost / recipe.baseYieldQty) : '—'}
                    </span>
                  </div>
                  {recipe.costPerPortion !== null && (
                    <>
                      <div className="w-px h-9 bg-zinc-800 mx-4 shrink-0" />
                      <div className="flex flex-col shrink-0">
                        <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-4">Per portion</span>
                        <span className="font-mono text-[16px] font-semibold text-paper leading-tight">{formatCurrency(recipe.costPerPortion)}</span>
                      </div>
                    </>
                  )}
                  {recipe.usedInCount !== undefined && recipe.usedInCount > 0 && (
                    <>
                      <div className="w-px h-9 bg-zinc-800 mx-4 shrink-0" />
                      <div className="flex flex-col shrink-0">
                        <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-4">Used in</span>
                        <span className="font-mono text-[16px] font-semibold text-green-400 leading-tight">{recipe.usedInCount} {recipe.usedInCount === 1 ? 'dish' : 'dishes'}</span>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
  ) : null

  return (
    <>
    <EditorDrawer onClose={handleClose} titleBar={titleBar} costStrip={costStrip}>
      <div className="p-5 space-y-5">

          {/* Dependency banner — PREP recipes used by other recipes */}
          {!isMenu && recipe.usedInRecipes && recipe.usedInRecipes.length > 0 && (
            <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl p-3">
              <Share2 size={14} className="text-amber-500 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-amber-800 mb-1.5">
                  Used in {recipe.usedInRecipes.length} {recipe.usedInRecipes.length === 1 ? 'recipe' : 'recipes'} — ingredient changes here will reprice them
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {recipe.usedInRecipes.map(r => (
                    <span key={r.id} className="text-[11px] bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full flex items-center gap-1">
                      {r.type === 'MENU' ? <UtensilsCrossed size={8} /> : <BookOpen size={8} />}
                      {r.name}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="font-mono text-[10.5px] uppercase tracking-[0.04em] text-ink-3 block mb-1.5">Category</label>
              <select value={recipe.categoryId} onChange={e => patchRecipe({ categoryId: e.target.value })}
                className="w-full border border-line rounded-[10px] px-3 py-2 text-sm text-ink bg-paper focus:outline-none focus:ring-2 focus:ring-gold">
                {categories.filter(c => c.type === recipe.type).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="font-mono text-[10.5px] uppercase tracking-[0.04em] text-ink-3 block mb-1.5">
                {isMenu ? 'Portions per batch' : 'Base Yield'}
                {!isMenu && (() => { const f = formatQtyUnit(recipe.baseYieldQty, recipe.yieldUnit); const raw = `${recipe.baseYieldQty} ${recipe.yieldUnit}`; return f !== raw ? <span className="ml-1 normal-case text-ink-4 tracking-normal"> = {f}</span> : null })()}
              </label>
              <div className="flex gap-1">
                <input type="number" min="0" step="0.01" defaultValue={recipe.baseYieldQty} onBlur={e => patchRecipe({ baseYieldQty: e.target.value })}
                  className="flex-1 border border-line rounded-[10px] px-2 py-2 font-mono text-sm text-ink bg-paper focus:outline-none focus:ring-2 focus:ring-gold" />
                <select
                  value={recipe.yieldUnit}
                  onChange={e => patchRecipe({ yieldUnit: e.target.value })}
                  className="w-24 border border-line rounded-[10px] px-2 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-gold bg-paper"
                >
                  {(isMenu
                    ? ['portion', 'portions', 'serving', 'servings', 'each', 'piece', 'pieces', 'plate', 'bowl']
                    : ['g', 'kg', 'ml', 'L', 'each', 'oz', 'lb', 'portion', 'portions', 'batch', 'cup', 'tray']
                  ).map(u => <option key={u} value={u}>{u}</option>)}
                  {/* Allow the existing value even if not in the list */}
                  {!(isMenu
                    ? ['portion', 'portions', 'serving', 'servings', 'each', 'piece', 'pieces', 'plate', 'bowl']
                    : ['g', 'kg', 'ml', 'L', 'each', 'oz', 'lb', 'portion', 'portions', 'batch', 'cup', 'tray']
                  ).includes(recipe.yieldUnit) && (
                    <option value={recipe.yieldUnit}>{recipe.yieldUnit}</option>
                  )}
                </select>
              </div>
              <p className="font-mono text-[10.5px] text-ink-4 mt-1.5 tracking-[0.01em]">
                {isMenu
                  ? 'How many portions this recipe produces (usually 1)'
                  : 'Total quantity produced by this recipe'}
              </p>
            </div>
            <div>
              <label className="font-mono text-[10.5px] uppercase tracking-[0.04em] text-ink-3 block mb-1.5">
                Menu Price {!isMenu && <span className="text-gold-2/60 normal-case tracking-normal">(optional)</span>}
              </label>
              <div className="relative">
                <span className="absolute left-3 top-2 text-ink-4 text-sm font-mono">$</span>
                <input type="number" min="0" step="0.01" defaultValue={recipe.menuPrice ?? ''} placeholder="0.00"
                  onBlur={e => patchRecipe({ menuPrice: e.target.value || null })}
                  className="w-full border border-line rounded-[10px] pl-7 pr-3 py-2 font-mono text-sm text-ink bg-paper focus:outline-none focus:ring-2 focus:ring-gold" />
              </div>
            </div>

            {!isMenu && (
              <div>
                <label className="font-mono text-[10.5px] uppercase tracking-[0.04em] text-ink-3 block mb-1.5">
                  Portion size <span className="text-gold-2/60 normal-case tracking-normal">(optional)</span>
                </label>
                <div className="flex gap-1">
                  <input
                    type="number" min="0" step="any"
                    defaultValue={recipe.portionSize ?? ''}
                    placeholder="e.g. 50"
                    onBlur={e => patchRecipe({ portionSize: e.target.value || null, portionUnit: recipe.portionUnit ?? recipe.yieldUnit })}
                    className="flex-1 border border-line rounded-[10px] px-2 py-2 font-mono text-sm text-ink bg-paper focus:outline-none focus:ring-2 focus:ring-gold"
                  />
                  <select
                    value={recipe.portionUnit ?? recipe.yieldUnit}
                    onChange={e => patchRecipe({ portionUnit: e.target.value, portionSize: recipe.portionSize ?? null })}
                    className="w-24 border border-line rounded-[10px] px-2 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-gold bg-paper"
                  >
                    {['g', 'kg', 'ml', 'L', 'each', 'oz', 'lb', 'portion', 'portions', 'batch', 'cup', 'tray'].map(u => (
                      <option key={u} value={u}>{u}</option>
                    ))}
                    {!['g', 'kg', 'ml', 'L', 'each', 'oz', 'lb', 'portion', 'portions', 'batch', 'cup', 'tray'].includes(recipe.portionUnit ?? recipe.yieldUnit) && (
                      <option value={recipe.portionUnit ?? recipe.yieldUnit}>{recipe.portionUnit ?? recipe.yieldUnit}</option>
                    )}
                  </select>
                </div>
                <p className="font-mono text-[10.5px] text-ink-4 mt-1.5 tracking-[0.01em]">Amount used per dish — sets cost per portion</p>
              </div>
            )}
          </div>

          {recipe.allergens && recipe.allergens.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Allergens</span>
              <AllergenBadges allergens={recipe.allergens} size="sm" />
            </div>
          )}

          <div>
            <button onClick={() => setShowNotes(s => !s)} className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700">
              {showNotes ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              Notes {recipe.notes && <span className="text-blue-500">•</span>}
            </button>
            {showNotes && (
              <div className="mt-2 space-y-2">
                {recipe.notes && (
                  <div className="text-sm text-gray-700 leading-relaxed px-3 py-2 bg-gray-50 rounded-lg">
                    {renderMarkdown(recipe.notes)}
                  </div>
                )}
                <textarea defaultValue={recipe.notes ?? ''} onBlur={e => patchRecipe({ notes: e.target.value || null })} rows={3}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold resize-none"
                  placeholder="Recipe notes, storage instructions…" />
              </div>
            )}
          </div>

          {!isMenu && (
            <div className="bg-paper border border-line rounded-[12px] p-5">
              <div className="flex items-center justify-between mb-3">
                <span className="font-mono text-[10.5px] uppercase tracking-[0.04em] text-ink-3">Scale Recipe</span>
                {sf !== 1 && (
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-ink-2"><span className="text-gold-2">×</span>{sf}</span>
                    <button onClick={() => { setShowSaveScale(s => !s); setNewScaleName(`${recipe.name} ×${sf}`) }}
                      className="font-mono text-[10.5px] uppercase tracking-[0.04em] bg-ink text-paper px-2.5 py-1 rounded-[7px] hover:bg-ink-2">Save as new</button>
                  </div>
                )}
              </div>
              <div className="flex gap-1.5 flex-wrap mb-3">
                {SCALE_PRESETS.map(p => (
                  <button key={p} onClick={() => { setScaleFactor(p); setCustomScale('') }}
                    className={`px-3 py-1.5 rounded-[8px] font-mono text-[12px] font-medium transition-colors ${sf === p ? 'bg-ink text-paper' : 'bg-paper border border-line text-ink-2 hover:border-ink-4'}`}>
                    <span className={sf === p ? 'text-gold' : 'text-ink-4'}>×</span>{p}
                  </button>
                ))}
              </div>
              <input type="range" min="0.25" max="10" step="0.25" value={sf}
                onChange={e => { setScaleFactor(parseFloat(e.target.value)); setCustomScale('') }}
                className="w-full accent-ink mb-3" />
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10.5px] uppercase tracking-[0.04em] text-ink-3">Custom</span>
                <input type="number" min="0.1" step="0.1" value={customScale} onChange={e => setCustomScale(e.target.value)}
                  onBlur={() => { const v = parseFloat(customScale); if (!isNaN(v) && v > 0) setScaleFactor(v) }}
                  placeholder="e.g. 2.5"
                  className="w-20 border border-line rounded-[7px] px-2 py-1 font-mono text-[12px] text-ink bg-paper focus:outline-none focus:ring-1 focus:ring-gold" />
                <span className="font-mono text-[11px] text-ink-4">×</span>
                <span className="ml-auto font-mono text-[11px] text-ink-3">
                  Current batch: <span className="text-ink-2">{Number((recipe.baseYieldQty * sf).toFixed(3))} {recipe.yieldUnit}</span> · <span className="text-ink-2">{formatCurrency(recipe.totalCost * sf)}</span>
                </span>
              </div>
              {showSaveScale && (
                <div className="mt-3 flex gap-2">
                  <input value={newScaleName} onChange={e => setNewScaleName(e.target.value)} placeholder="New recipe name…"
                    className="flex-1 border border-line rounded-[8px] px-3 py-1.5 text-sm text-ink bg-paper focus:outline-none focus:ring-2 focus:ring-gold" />
                  <button onClick={saveScale} className="bg-ink text-paper px-3 py-1.5 rounded-[8px] text-sm hover:bg-ink-2">Save</button>
                  <button onClick={() => setShowSaveScale(false)} className="p-1.5 text-ink-4 hover:text-ink-2"><X size={14} /></button>
                </div>
              )}
            </div>
          )}

          <div>
            <div className="text-sm font-semibold text-gray-700 mb-2">
              Ingredients {sf !== 1 && <span className="text-blue-500 font-normal text-xs ml-1">scaled ×{sf}</span>}
            </div>
            {baseIsSet && baseIngName && (
              <div className="flex items-center gap-1.5 mb-2 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-1.5 text-xs text-amber-700">
                <Star size={10} className="fill-amber-500 text-amber-500 shrink-0" />
                <span>Baker&apos;s %: relative to <span className="font-semibold">{baseIngName}</span> (100%) — volume treated as 1 ml = 1 g</span>
              </div>
            )}
            {!baseIsSet && (
              <div className="flex items-center gap-1.5 mb-2 text-xs text-gray-400">
                <Star size={10} className="shrink-0" />
                <span>Click <Star size={9} className="inline" /> on any ingredient to set it as the baker&apos;s 100% reference</span>
              </div>
            )}
            <div className="border border-gray-100 rounded-t-xl overflow-hidden">
              <div className="grid grid-cols-12 gap-2 px-3 py-2 bg-gray-50 text-xs font-medium text-gray-500">
                <div className="col-span-4">Ingredient</div>
                <div className="col-span-1 text-center" title={baseIsSet && baseIngName ? `Baker's % relative to ${baseIngName}` : 'Baker\'s %'}>%</div>
                <div className="col-span-2 text-right">Qty</div>
                <div className="col-span-2">Unit</div>
                <div className="col-span-2 text-right">Line cost</div>
                <div className="col-span-1" />
              </div>
              {recipe.ingredients.length === 0 && <div className="text-center py-6 text-gray-400 text-sm">No ingredients yet</div>}
              {recipe.ingredients.map((ing, idx) => (
                <IngredientRow key={ing.id} ing={ing} scaleFactor={sf}
                  canMoveUp={idx > 0} canMoveDown={idx < recipe.ingredients.length - 1}
                  onUpdate={updateIngredient}
                  onDelete={deleteIngredient}
                  onInventoryClick={id => setQuickEditItemId(id)}
                  isBase={baseIngId === ing.id}
                  baseIsSet={baseIsSet}
                  autoPercent={autoPercents[ing.id] ?? null}
                  onSetBase={() => setBaseIngredient(ing.id)}
                  onMoveUp={() => {
                    const prev = recipe.ingredients[idx - 1]
                    // Optimistic: swap immediately
                    setRecipe(r => {
                      if (!r) return r
                      const ings = [...r.ingredients]
                      ;[ings[idx - 1], ings[idx]] = [ings[idx], ings[idx - 1]]
                      return { ...r, ingredients: ings }
                    })
                    // Persist sort orders in background
                    updateIngredient(ing.id, { sortOrder: prev.sortOrder })
                    updateIngredient(prev.id, { sortOrder: ing.sortOrder })
                  }}
                  onMoveDown={() => {
                    const next = recipe.ingredients[idx + 1]
                    // Optimistic: swap immediately
                    setRecipe(r => {
                      if (!r) return r
                      const ings = [...r.ingredients]
                      ;[ings[idx], ings[idx + 1]] = [ings[idx + 1], ings[idx]]
                      return { ...r, ingredients: ings }
                    })
                    // Persist sort orders in background
                    updateIngredient(ing.id, { sortOrder: next.sortOrder })
                    updateIngredient(next.id, { sortOrder: ing.sortOrder })
                  }}
                  onSubstitute={substituteIngredient}
                />
              ))}
            </div>
            <div className="relative border border-gray-100 border-t-0 rounded-b-xl px-3 py-2 bg-white" ref={searchRef}>
              <div className="flex items-center gap-2">
                <Search size={14} className="text-gray-400 shrink-0" />
                <input value={searchQ} onChange={e => {
                  setSearchQ(e.target.value)
                  clearTimeout(searchTimer.current)
                  searchTimer.current = setTimeout(() => { doSearch(e.target.value); setShowSearch(true) }, 400)
                }}
                  onFocus={() => { if (searchResults.length > 0) setShowSearch(true) }}
                  placeholder="+ Add ingredient — search inventory or recipes…"
                  className="flex-1 text-sm text-gray-700 placeholder-gray-400 outline-none bg-transparent py-1" />
              </div>
              {showSearch && searchResults.length > 0 && (
                <div className="absolute left-0 right-0 top-full mt-1 bg-white border border-gray-200 rounded-xl shadow-xl z-50 max-h-64 overflow-y-auto">
                  {searchResults.map(item => (
                    <button key={`${item.type}-${item.id}`} onClick={() => addIngredient(item)}
                      className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-gray-50 text-left text-sm">
                      {item.type === 'recipe' ? <ChefHat size={13} className="text-emerald-600 shrink-0" /> : <Package size={13} className="text-blue-500 shrink-0" />}
                      <span className="flex-1 text-gray-800">{item.name}</span>
                      <span className="text-xs text-gray-400">{item.unit}</span>
                      <span className="text-xs text-gray-500">{formatCurrency(item.pricePerBaseUnit)}/{item.unit}</span>
                      <span className={`text-xs px-1.5 py-0.5 rounded ${item.type === 'recipe' ? 'bg-emerald-50 text-emerald-600' : 'bg-gold/10 text-gold'}`}>
                        {item.type === 'recipe' ? 'PREP' : item.category}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="bg-gray-50 rounded-xl p-4 space-y-2">
            {!isMenu ? (
              <>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">Total recipe cost</span>
                  <span className="font-bold text-gray-900">{formatCurrency(scaledTotal)}{sf !== 1 && <span className="text-xs text-blue-500 ml-1">at ×{sf}</span>}</span>
                </div>
                <div className="flex justify-between text-sm items-center">
                  <span className="text-gray-600">Cost per {recipe.yieldUnit}</span>
                  <span className="font-semibold text-gray-800">{formatUnitPrice(baseCostPerUnit)}<span className="text-gray-400 text-xs ml-0.5">/{recipe.yieldUnit}</span></span>
                </div>
                {recipe.portionSize && recipe.portionSize > 0 && (() => {
                  const portionUnit = recipe.portionUnit ?? recipe.yieldUnit
                  const portionQty = Number(recipe.portionSize)
                  const portionCost = recipe.costPerPortion !== null ? recipe.costPerPortion * sf : baseCostPerUnit * portionQty * sf
                  const portionsPerBatch = recipe.baseYieldQty > 0 && portionQty > 0 ? Math.floor(recipe.baseYieldQty / portionQty) : null
                  return (
                    <>
                      <div className="border-t border-gray-200 pt-2 mt-1 flex justify-between text-sm items-center">
                        <span className="text-gray-600">Cost per {portionQty}{portionUnit} portion</span>
                        <span className="font-semibold text-indigo-700">{formatCurrency(portionCost)}</span>
                      </div>
                      {portionsPerBatch !== null && (
                        <div className="flex justify-between text-xs text-gray-400">
                          <span>Portions per batch</span>
                          <span>{portionsPerBatch} × {portionQty}{portionUnit}</span>
                        </div>
                      )}
                    </>
                  )
                })()}
              </>
            ) : (
              <>
                <div className="flex justify-between text-sm"><span className="text-gray-600">Base Cost</span><span className="font-bold text-gray-900">{formatCurrency(recipe.totalCost)}</span></div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">Menu price</span>
                  <span className="font-semibold text-gray-800">{recipe.menuPrice !== null ? formatCurrency(recipe.menuPrice) : '—'}</span>
                </div>
                <div className="flex justify-between text-sm items-center">
                  <span className="text-gray-600">Food cost %</span>
                  <span className={`font-bold text-base ${foodCostClass(menuFoodCostPct)}`}>{menuFoodCostPct !== null ? `${menuFoodCostPct.toFixed(1)}%` : '—'}</span>
                </div>
                {margin !== null && (
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">Margin / dish</span>
                    <span className={`font-semibold ${margin >= 0 ? 'text-green-700' : 'text-red-600'}`}>{formatCurrency(margin)}</span>
                  </div>
                )}
                {recipe.menuPrice !== null && (
                  <div className="pt-2">
                    <div className="relative h-2 bg-bg-2 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${foodCostClass(menuFoodCostPct).replace('text-', 'bg-')}`}
                        style={{ width: `${Math.min(100, (recipe.totalCost / recipe.menuPrice) * 100)}%` }} />
                      <div className="absolute top-[-3px] w-px h-3.5 bg-ink" style={{ left: `${FOOD_COST_GREEN}%` }} />
                    </div>
                    <div className="flex justify-between font-mono text-[10px] uppercase tracking-[0.04em] text-ink-4 mt-1.5">
                      <span>Cost <span className="text-ink-3">{formatCurrency(recipe.totalCost)}</span></span>
                      <span className="text-gold-2">Target {FOOD_COST_GREEN}% = {formatCurrency(recipe.menuPrice * FOOD_COST_GREEN / 100)}</span>
                      <span>Price <span className="text-ink-3">{formatCurrency(recipe.menuPrice)}</span></span>
                    </div>
                  </div>
                )}
              </>
            )}
            {recipe.inventoryItemId && (
              <div className="flex items-center gap-1.5 text-xs text-emerald-600 pt-1 border-t border-gray-200">
                <Link2 size={11} />
                <span>Synced to Inventory · PREPD item auto-updated on ingredient changes</span>
              </div>
            )}
          </div>
        </div>
    </EditorDrawer>

    {showPrint && typeof document !== 'undefined' && createPortal(
      <RecipePrintModal recipe={recipe} onClose={() => setShowPrint(false)} />,
      document.body
    )}

    {quickEditItemId && (
      <InventoryItemDrawer
        itemId={quickEditItemId}
        zClassName="z-[70]"
        initialEditMode
        onClose={() => setQuickEditItemId(null)}
        onUpdated={() => load()}
      />
    )}
    </>
  )
}

// ─── PrepRecipeModal — editable popup for PREP sub-recipe ingredients ─────────
function PrepRecipeModal({ linkedRecipeId, onClose, onUpdated }: { linkedRecipeId: string; onClose: () => void; onUpdated: () => void }) {
  const [recipe, setRecipe] = useState<Recipe | null>(null)
  const [searchQ, setSearchQ] = useState('')
  const [searchResults, setSearchResults] = useState<IngredientSearchResult[]>([])
  const [showSearch, setShowSearch] = useState(false)
  const searchRef = useRef<HTMLDivElement>(null)
  const searchTimer = useRef<ReturnType<typeof setTimeout>>()
  const searchCache = useRef<Map<string, IngredientSearchResult[]>>(new Map())

  const load = useCallback(async () => {
    const data = await fetch(`/api/recipes/${linkedRecipeId}`).then(r => r.json())
    setRecipe(data)
  }, [linkedRecipeId])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) setShowSearch(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) { setSearchResults([]); return }
    const cached = searchCache.current.get(q)
    if (cached) { setSearchResults(cached); return }
    const data: IngredientSearchResult[] = await fetch(`/api/recipes/search-ingredients?q=${encodeURIComponent(q)}`).then(r => r.json())
    searchCache.current.set(q, data)
    setSearchResults(data)
  }, [])

  const addIngredient = async (item: IngredientSearchResult) => {
    await fetch(`/api/recipes/${linkedRecipeId}/ingredients`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inventoryItemId: item.type === 'inventory' ? item.id : null, linkedRecipeId: item.type === 'recipe' ? item.id : null, qtyBase: 0, unit: item.unit }),
    })
    await load(); onUpdated(); setShowSearch(false); setSearchQ(''); setSearchResults([])
  }

  const updateIngredient = async (ingId: string, data: Record<string, unknown>) => {
    await fetch(`/api/recipes/${linkedRecipeId}/ingredients/${ingId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
    await load(); onUpdated()
  }

  const deleteIngredient = async (ingId: string) => {
    await fetch(`/api/recipes/${linkedRecipeId}/ingredients/${ingId}`, { method: 'DELETE' })
    await load(); onUpdated()
  }

  const costPerUnit = recipe && recipe.baseYieldQty > 0 ? recipe.totalCost / recipe.baseYieldQty : 0

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="px-5 pt-5 pb-4 border-b border-gray-100 flex items-start justify-between gap-2 shrink-0">
          <div>
            <div className="flex items-center gap-2">
              <ChefHat size={15} className="text-emerald-600" />
              <h3 className="font-semibold text-gray-900">{recipe?.name ?? '…'}</h3>
            </div>
            <span className="text-[11px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-full font-medium">PREP Recipe</span>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 mt-0.5 shrink-0"><X size={16} /></button>
        </div>

        {!recipe ? (
          <div className="flex justify-center py-10"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-gold" /></div>
        ) : (
          <>
            {/* Stats */}
            <div className="px-5 py-3 grid grid-cols-3 gap-2 shrink-0 border-b border-gray-50">
              <div className="bg-gray-50 rounded-lg px-3 py-2 text-center">
                <div className="text-[10px] text-gray-400 uppercase tracking-wide">Total Cost</div>
                <div className="font-semibold text-gray-800 text-sm">{formatCurrency(recipe.totalCost)}</div>
              </div>
              <div className="bg-gray-50 rounded-lg px-3 py-2 text-center">
                <div className="text-[10px] text-gray-400 uppercase tracking-wide">Yield</div>
                <div className="font-semibold text-gray-800 text-sm">{formatQtyUnit(recipe.baseYieldQty, recipe.yieldUnit)}</div>
              </div>
              <div className="bg-gold/10 rounded-lg px-3 py-2 text-center">
                <div className="text-[10px] text-gold/70 uppercase tracking-wide">Cost/{recipe.yieldUnit}</div>
                <div className="font-semibold text-gold text-sm">{formatUnitPrice(costPerUnit)}</div>
              </div>
            </div>

            {/* Ingredients */}
            <div className="overflow-y-auto flex-1">
              {/* Column headers */}
              <div className="grid grid-cols-12 gap-2 px-4 py-2 text-[10px] font-medium text-gray-400 uppercase tracking-wide bg-gray-50 border-b border-gray-100">
                <div className="col-span-5">Ingredient</div>
                <div className="col-span-2 text-right">Qty</div>
                <div className="col-span-2">Unit</div>
                <div className="col-span-2 text-right">Cost</div>
                <div className="col-span-1" />
              </div>

              {recipe.ingredients.length === 0 && (
                <div className="text-center py-8 text-gray-400 text-sm">No ingredients yet</div>
              )}

              {recipe.ingredients.map(ing => (
                <PrepIngredientRow key={ing.id} ing={ing}
                  onUpdate={data => updateIngredient(ing.id, data)}
                  onDelete={() => deleteIngredient(ing.id)} />
              ))}

              {/* Add ingredient search */}
              <div className="relative px-3 py-2 border-t border-gray-100" ref={searchRef}>
                <div className="flex items-center gap-2">
                  <Search size={13} className="text-gray-400 shrink-0" />
                  <input value={searchQ} onChange={e => {
                    setSearchQ(e.target.value)
                    clearTimeout(searchTimer.current)
                    searchTimer.current = setTimeout(() => { doSearch(e.target.value); setShowSearch(true) }, 400)
                  }}
                    onFocus={() => { if (searchResults.length > 0) setShowSearch(true) }}
                    placeholder="+ Add ingredient…"
                    className="flex-1 text-sm text-gray-700 placeholder-gray-400 outline-none bg-transparent py-1" />
                </div>
                {showSearch && searchResults.length > 0 && (
                  <div className="absolute left-0 right-0 bottom-full mb-1 bg-white border border-gray-200 rounded-xl shadow-xl z-50 max-h-48 overflow-y-auto">
                    {searchResults.map(item => (
                      <button key={`${item.type}-${item.id}`} onClick={() => addIngredient(item)}
                        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 text-left text-sm">
                        {item.type === 'recipe' ? <ChefHat size={12} className="text-emerald-600 shrink-0" /> : <Package size={12} className="text-blue-500 shrink-0" />}
                        <span className="flex-1 text-gray-800">{item.name}</span>
                        <span className="text-xs text-gray-400">{item.unit}</span>
                        <span className={`text-xs px-1.5 py-0.5 rounded ${item.type === 'recipe' ? 'bg-emerald-50 text-emerald-600' : 'bg-gold/10 text-gold'}`}>
                          {item.type === 'recipe' ? 'PREP' : item.category}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Footer */}
            <div className="px-5 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] border-t border-gray-100 shrink-0">
              <button onClick={onClose} className="w-full border border-gray-200 rounded-xl py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors">
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ─── PrepIngredientRow — simple editable row for PrepRecipeModal ───────────────
function PrepIngredientRow({ ing, onUpdate, onDelete }: {
  ing: IngredientWithCost
  onUpdate: (data: Record<string, unknown>) => void
  onDelete: () => void
}) {
  const [qty, setQty] = useState(ing.qtyBase === 0 ? '' : String(ing.qtyBase))
  const [unit, setUnit] = useState(ing.unit)

  useEffect(() => { setQty(ing.qtyBase === 0 ? '' : String(ing.qtyBase)) }, [ing.qtyBase])
  useEffect(() => { setUnit(ing.unit) }, [ing.unit])

  const saveQty = () => { if (qty !== String(ing.qtyBase)) onUpdate({ qtyBase: qty, unit }) }
  const saveUnit = (newUnit: string) => { setUnit(newUnit); onUpdate({ qtyBase: qty, unit: newUnit }) }

  const baseUnitGroup = getUnitGroup(ing.ingredientBaseUnit)
  const compatibleGroups = baseUnitGroup ? UOM_GROUPS.filter(g => g.label === baseUnitGroup) : UOM_GROUPS
  const allKnownUnits = UOM_GROUPS.flatMap(g => g.units.map(u => u.label))
  const unitInList = allKnownUnits.includes(unit)

  return (
    <div className="grid grid-cols-12 gap-2 px-4 py-2 items-center border-t border-gray-50 hover:bg-gray-50 group">
      <div className="col-span-5 flex items-center gap-1.5 min-w-0">
        {ing.ingredientType === 'recipe'
          ? <ChefHat size={11} className="text-emerald-600 shrink-0" />
          : <Package size={11} className="text-blue-500 shrink-0" />}
        <span className="text-sm text-gray-800 truncate">{ing.ingredientName}</span>
      </div>
      <div className="col-span-2">
        <input type="number" value={qty} onChange={e => setQty(e.target.value)} onBlur={saveQty}
          onKeyDown={e => e.key === 'Enter' && saveQty()}
          className="w-full text-right border border-gray-200 rounded px-1 py-0.5 text-sm text-gray-900 focus:outline-none focus:border-blue-300" />
      </div>
      <div className="col-span-2">
        <select value={unitInList ? unit : '__custom__'} onChange={e => { if (e.target.value !== '__custom__') saveUnit(e.target.value) }}
          className="w-full border border-gray-200 rounded px-1 py-0.5 text-xs text-gray-700 bg-white focus:outline-none focus:ring-1 focus:ring-gold">
          {!unitInList && <option value="__custom__">{unit}</option>}
          {compatibleGroups.map(group => (
            <optgroup key={group.label} label={group.label}>
              {group.units.map(u => <option key={u.label} value={u.label}>{u.label}</option>)}
            </optgroup>
          ))}
        </select>
      </div>
      <div className="col-span-2 text-right text-sm font-medium text-gray-700">{formatCurrency(ing.lineCost)}</div>
      <div className="col-span-1 flex justify-end opacity-0 group-hover:opacity-100">
        <button onClick={onDelete} className="text-gray-300 hover:text-red-500"><Trash2 size={13} /></button>
      </div>
    </div>
  )
}

// ─── CategoryManager ──────────────────────────────────────────────────────────
export function CategoryManager({ type, categories, onClose, onUpdated, revenueCenterId }: {
  type: string
  categories: RecipeCategory[]
  onClose: () => void
  onUpdated: () => void
  revenueCenterId?: string | null
}) {
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState(CATEGORY_PALETTE[0])

  const typeCats = categories.filter(c => c.type === type).sort((a, b) => a.sortOrder - b.sortOrder)

  const addCat = async () => {
    if (!newName.trim()) return
    await fetch('/api/recipes/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName, type, color: newColor, revenueCenterId: revenueCenterId ?? null }),
    })
    setNewName(''); setAdding(false); onUpdated()
  }

  const updateCat = async (id: string, data: Record<string, unknown>) => {
    await fetch(`/api/recipes/categories/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
    onUpdated()
  }

  const deleteCat = async (id: string) => {
    const res = await fetch(`/api/recipes/categories/${id}`, { method: 'DELETE' })
    if (!res.ok) { const d = await res.json(); alert(d.error); return }
    onUpdated()
  }

  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 className="font-bold text-gray-900">Manage {type === 'PREP' ? 'Recipe Book' : 'Menu'} Categories</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <div className="overflow-y-auto flex-1 p-4 space-y-2">
          {typeCats.map(cat => (
            <div key={cat.id} className="flex items-center gap-2 group">
              <div className="relative">
                <div className="w-6 h-6 rounded-full cursor-pointer border-2 border-white shadow" style={{ background: cat.color ?? '#94a3b8' }} />
                <input type="color" value={cat.color ?? '#94a3b8'} onChange={e => updateCat(cat.id, { color: e.target.value })}
                  className="absolute inset-0 opacity-0 cursor-pointer w-full h-full" />
              </div>
              <InlineEdit value={cat.name} onSave={name => updateCat(cat.id, { name })} className="flex-1 text-sm text-gray-800" />
              <span className="text-xs text-gray-400">{cat._count?.recipes ?? 0} recipes</span>
              <button onClick={() => deleteCat(cat.id)} disabled={(cat._count?.recipes ?? 0) > 0}
                title={(cat._count?.recipes ?? 0) > 0 ? 'Move recipes first' : 'Delete'}
                className="text-gray-300 hover:text-red-500 disabled:opacity-30 disabled:cursor-not-allowed">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          {adding ? (
            <div className="flex items-center gap-2 mt-2">
              <div className="flex gap-1">
                {CATEGORY_PALETTE.map(c => (
                  <button key={c} onClick={() => setNewColor(c)}
                    className={`w-5 h-5 rounded-full border-2 ${newColor === c ? 'border-gray-600' : 'border-transparent'}`}
                    style={{ background: c }} />
                ))}
              </div>
              <input autoFocus value={newName} onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addCat(); if (e.key === 'Escape') setAdding(false) }}
                placeholder="Category name"
                className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold" />
              <button onClick={addCat} className="text-gold"><Check size={16} /></button>
              <button onClick={() => setAdding(false)} className="text-gray-400"><X size={14} /></button>
            </div>
          ) : (
            <button onClick={() => setAdding(true)} className="flex items-center gap-1.5 text-sm text-gold hover:text-gold mt-2">
              <Plus size={14} /> Add category
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

```


---

## `src/components/inventory/InventoryItemDrawer.tsx`

```tsx
'use client'
import { useEffect, useRef, useState } from 'react'
import { X, Pencil, Loader2 } from 'lucide-react'
import {
  formatCurrency, formatUnitPrice,
  PACK_UOMS, COUNT_UOMS, PURCHASE_UNITS, QTY_UOMS,
  calcPricePerBaseUnit, calcConversionFactor, deriveBaseUnit,
  getUnitDimension, compatibleCountUnits, getUnitConv,
} from '@/lib/utils'
import { convertCountQtyToBase, convertBaseToCountUom, getCountableUoms, resolveCountUom } from '@/lib/count-uom'
import { CategoryBadge } from '@/components/CategoryBadge'
import { StockStatus } from '@/components/StockStatus'
import { RcAllocationPanel } from '@/components/inventory/RcAllocationPanel'
import { AllergenBadges, AllergenToggles } from '@/components/AllergenBadges'
import { useRc } from '@/contexts/RevenueCenterContext'

// ─── Types ────────────────────────────────────────────────────────────────────

type MovementType = 'SALE' | 'WASTAGE' | 'PREP_IN' | 'PREP_OUT' | 'PURCHASE'

interface StockMovement {
  id: string; date: string; type: MovementType
  qty: number; unit: string; description: string
}

interface StockMovementsResponse {
  lastCount: { qty: number; unit: string; date: string | null }
  theoretical: { qty: number; unit: string }
  movements: StockMovement[]
}

interface InventoryItem {
  id: string; itemName: string; category: string
  supplier?: { id: string; name: string } | null
  supplierId?: string | null
  storageArea?: { id: string; name: string } | null
  storageAreaId?: string | null
  purchaseUnit: string; qtyPerPurchaseUnit: number
  purchasePrice: number; baseUnit: string
  packSize: number; packUOM: string; countUOM: string
  conversionFactor: number; pricePerBaseUnit: number
  stockOnHand: number
  allergens?: string[]
  barcode?: string | null
  isActive: boolean
  qtyUOM?: string | null
  innerQty?: number | string | null
  needsReview?: boolean | null
  lastCountDate?: string | null; lastCountQty?: number | null
  recipe?: { id: string; name: string } | null
  priceType?: 'CASE' | 'UOM' | null
}

interface EditForm {
  itemName: string; category: string
  supplierId: string; supplierName: string
  storageAreaId: string; storageAreaName: string
  purchaseUnit: string; qtyPerPurchaseUnit: string
  purchasePrice: string
  packSize: string; packUOM: string; countUOM: string
  qtyUOM: string
  innerQty: string
  stockOnHand: string
  isActive: boolean
  allergens: string[]
  barcode: string | null
  priceType: 'CASE' | 'UOM'
}

interface Props {
  itemId: string
  onClose: () => void
  onUpdated?: () => void
  zClassName?: string
  initialEditMode?: boolean
}

// ─── Purchase description ─────────────────────────────────────────────────────

function normalizePurchaseUnit(raw: string): string {
  if (PURCHASE_UNITS.includes(raw as typeof PURCHASE_UNITS[number])) return raw
  const found = (PURCHASE_UNITS as readonly string[]).find(u => raw.toLowerCase().includes(u))
  return found ?? 'case'
}

function buildPurchaseDescription(
  purchaseUnit: string,
  qty: number,
  qtyUOM: string,
  innerQty: number | null,
  packSize: number,
  packUOM: string,
): string {
  const pu = purchaseUnit || 'unit'
  const weightVol = ['kg', 'g', 'lb', 'oz', 'l', 'ml']
  if (weightVol.includes(qtyUOM)) return `${pu} of ${qty} ${qtyUOM}`
  const hasWeight = packSize > 0 && packUOM && !['each', ''].includes(packUOM)
  if (qtyUOM === 'pack' && innerQty) {
    return hasWeight
      ? `${pu} of ${qty} packs × ${innerQty} × ${packSize}${packUOM}`
      : `${pu} of ${qty} packs × ${innerQty} each`
  }
  return hasWeight
    ? `${pu} of ${qty} × ${packSize}${packUOM} each`
    : `${pu} of ${qty} each`
}

// ─── Combobox (local copy — avoids coupling to inventory page) ────────────────

function Combobox({ items, value, placeholder, onSelect, onAddNew }: {
  items: { id: string; name: string }[]
  value: string
  placeholder?: string
  onSelect: (id: string, name: string) => void
  onAddNew?: (name: string) => Promise<{ id: string; name: string }>
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  const filtered = items.filter(i => i.name.toLowerCase().includes(query.toLowerCase()))
  const exactMatch = items.some(i => i.name.toLowerCase() === query.toLowerCase())
  return (
    <div ref={ref} className="relative">
      <input
        value={open ? query : value}
        onChange={e => setQuery(e.target.value)}
        onFocus={() => { setOpen(true); setQuery('') }}
        placeholder={placeholder}
        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold"
      />
      {open && (
        <div className="absolute z-10 top-full left-0 right-0 bg-white border border-gray-200 rounded-lg shadow-lg mt-1 max-h-48 overflow-y-auto">
          {filtered.map(i => (
            <button key={i.id} type="button"
              className="w-full text-left px-3 py-2 text-sm hover:bg-gold/10"
              onClick={() => { onSelect(i.id, i.name); setOpen(false); setQuery('') }}
            >{i.name}</button>
          ))}
          {!exactMatch && query && onAddNew && (
            <button type="button"
              className="w-full text-left px-3 py-2 text-sm text-gold font-medium hover:bg-gold/10"
              onClick={async () => { const r = await onAddNew(query); onSelect(r.id, r.name); setOpen(false); setQuery('') }}
            >+ Add &quot;{query}&quot;</button>
          )}
          {filtered.length === 0 && !query && <div className="px-3 py-2 text-xs text-gray-400">No options</div>}
        </div>
      )}
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeItem(item: InventoryItem): InventoryItem {
  const dims = { baseUnit: item.baseUnit, purchaseUnit: item.purchaseUnit, qtyPerPurchaseUnit: Number(item.qtyPerPurchaseUnit), qtyUOM: item.qtyUOM ?? 'each', innerQty: item.innerQty != null ? Number(item.innerQty) : null, packSize: Number(item.packSize ?? 1), packUOM: item.packUOM ?? 'each', countUOM: item.countUOM ?? 'each' }
  return { ...item, countUOM: resolveCountUom(dims) }
}

function displayStock(item: InventoryItem): number {
  return convertBaseToCountUom(Number(item.stockOnHand), item.countUOM ?? 'each', {
    baseUnit: item.baseUnit,
    purchaseUnit: item.purchaseUnit,
    qtyPerPurchaseUnit: Number(item.qtyPerPurchaseUnit),
    qtyUOM: item.qtyUOM ?? 'each',
    innerQty: item.innerQty != null ? Number(item.innerQty) : null,
    packSize: Number(item.packSize ?? 1),
    packUOM: item.packUOM ?? 'each',
    countUOM: item.countUOM ?? 'each',
  })
}

// ─── Main component ────────────────────────────────────────────────────────────

export function InventoryItemDrawer({ itemId, onClose, onUpdated, zClassName = 'z-50', initialEditMode = false }: Props) {
  const { revenueCenters } = useRc()
  const defaultRcId = revenueCenters.find(rc => rc.isDefault)?.id ?? null

  const [item, setItem] = useState<InventoryItem | null>(null)
  const [loading, setLoading] = useState(true)
  const [editMode, setEditMode] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editForm, setEditForm] = useState<EditForm>({
    itemName: '', category: '', supplierId: '', supplierName: '',
    storageAreaId: '', storageAreaName: '', purchaseUnit: 'case',
    qtyPerPurchaseUnit: '1', purchasePrice: '0',
    packSize: '', packUOM: 'each', countUOM: 'each',
    qtyUOM: 'each', innerQty: '',
    stockOnHand: '0', isActive: true, allergens: [], barcode: null,
    priceType: 'CASE',
  })
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([])
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([])
  const [storageAreas, setStorageAreas] = useState<{ id: string; name: string }[]>([])
  const [priceHistory, setPriceHistory] = useState<Array<{
    invoiceDate: string; invoiceNumber: string; supplierName: string;
    qtyPurchased: number; unitPrice: number; lineTotal: number
  }>>([])
  const [stockMovements, setStockMovements] = useState<StockMovementsResponse | null>(null)

  useEffect(() => {
    setLoading(true)
    Promise.all([
      fetch(`/api/inventory/${itemId}`).then(r => r.json()),
      fetch('/api/suppliers').then(r => r.json()),
      fetch('/api/categories').then(r => r.json()),
      fetch('/api/storage-areas').then(r => r.json()),
      fetch(`/api/inventory/${itemId}/price-history`).then(r => r.json()).catch(() => []),
      fetch(`/api/inventory/${itemId}/stock-movements`).then(r => r.json()).catch(() => null),
    ]).then(([fetchedItem, sups, cats, areas, ph, sm]) => {
      const normalized = normalizeItem(fetchedItem)
      setItem(normalized)
      setSuppliers(sups)
      setCategories(cats)
      setStorageAreas(areas)
      setPriceHistory(ph)
      setStockMovements(sm)
      setLoading(false)
      if (initialEditMode) {
        setEditForm({
          itemName: normalized.itemName,
          category: normalized.category,
          supplierId: normalized.supplierId || '',
          supplierName: normalized.supplier?.name || '',
          storageAreaId: normalized.storageAreaId || '',
          storageAreaName: normalized.storageArea?.name || '',
          purchaseUnit: normalizePurchaseUnit(normalized.purchaseUnit),
          qtyPerPurchaseUnit: String(normalized.qtyPerPurchaseUnit),
          purchasePrice: String(normalized.purchasePrice),
          packSize: (Number(normalized.packSize ?? 1) === 1 && (normalized.baseUnit === 'each' || ['each', ''].includes(normalized.packUOM ?? 'each'))) ? '' : String(normalized.packSize ?? 1),
          packUOM: normalized.packUOM ?? 'each',
          countUOM: normalized.countUOM ?? 'each',
          qtyUOM: normalized.qtyUOM ?? 'each',
          innerQty: normalized.innerQty != null ? String(normalized.innerQty) : '',
          stockOnHand: String(parseFloat(displayStock(normalized).toFixed(4))),
          isActive: normalized.isActive,
          allergens: normalized.allergens ?? [],
          barcode: normalized.barcode ?? null,
          priceType: normalized.priceType ?? 'CASE',
        })
        setEditMode(true)
      }
    })
  }, [itemId])

  const openEdit = () => {
    if (!item) return
    setEditForm({
      itemName: item.itemName,
      category: item.category,
      supplierId: item.supplierId || '',
      supplierName: item.supplier?.name || '',
      storageAreaId: item.storageAreaId || '',
      storageAreaName: item.storageArea?.name || '',
      purchaseUnit: normalizePurchaseUnit(item.purchaseUnit),
      qtyPerPurchaseUnit: String(item.qtyPerPurchaseUnit),
      purchasePrice: String(item.purchasePrice),
      packSize: (Number(item.packSize ?? 1) === 1 && (item.baseUnit === 'each' || ['each', ''].includes(item.packUOM ?? 'each'))) ? '' : String(item.packSize ?? 1),
      packUOM: item.packUOM ?? 'each',
      countUOM: item.countUOM ?? 'each',
      qtyUOM: item.qtyUOM ?? 'each',
      innerQty: item.innerQty != null ? String(item.innerQty) : '',
      stockOnHand: String(parseFloat(displayStock(item).toFixed(4))),
      isActive: item.isActive,
      allergens: item.allergens ?? [],
      barcode: item.barcode ?? null,
      priceType: item.priceType ?? 'CASE',
    })
    setEditMode(true)
  }

  const handleSave = async () => {
    if (!item) return
    setSaving(true)
    const res = await fetch(`/api/inventory/${item.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        itemName: editForm.itemName,
        category: editForm.category,
        supplierId: editForm.supplierId || null,
        storageAreaId: editForm.storageAreaId || null,
        purchaseUnit: editForm.purchaseUnit,
        qtyPerPurchaseUnit: editForm.priceType === 'UOM' ? '1' : editForm.qtyPerPurchaseUnit,
        purchasePrice: editForm.purchasePrice,
        packSize: editForm.priceType === 'UOM' ? '1' : editForm.packSize,
        packUOM: editForm.packUOM,
        countUOM: editForm.countUOM,
        qtyUOM: editForm.priceType === 'UOM' ? 'each' : editForm.qtyUOM,
        innerQty: editForm.priceType === 'UOM' ? null : (editForm.innerQty ? parseFloat(editForm.innerQty) : null),
        stockOnHand: convertCountQtyToBase(parseFloat(editForm.stockOnHand) || 0, editForm.countUOM, {
          baseUnit: item.baseUnit,
          purchaseUnit: editForm.purchaseUnit,
          qtyPerPurchaseUnit: parseFloat(editForm.qtyPerPurchaseUnit) || 1,
          qtyUOM: editForm.qtyUOM,
          innerQty: editForm.innerQty ? parseFloat(editForm.innerQty) : null,
          packSize: parseFloat(editForm.packSize) || 1,
          packUOM: editForm.packUOM,
          countUOM: editForm.countUOM,
        }),
        isActive: editForm.isActive,
        allergens: editForm.allergens,
        barcode: editForm.barcode,
        priceType: editForm.priceType,
      }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => null)
      alert(err?.error ?? `Save failed (${res.status}). Please try again.`)
      setSaving(false)
      return
    }
    const updated = await res.json()
    setItem(normalizeItem({ ...item, ...updated, supplier: updated.supplier, storageArea: updated.storageArea }))
    setEditMode(false)
    setSaving(false)
    onUpdated?.()
  }

  return (
    <div className={`fixed inset-0 ${zClassName} flex items-end sm:items-stretch sm:justify-end`} onClick={onClose}>
      <div className="absolute inset-0 bg-black/30" />
      <div
        className="relative bg-white w-full sm:max-w-md h-[92vh] sm:h-full overflow-y-auto shadow-xl rounded-t-2xl sm:rounded-none"
        onClick={e => e.stopPropagation()}
      >
        {loading ? (
          <div className="flex items-center justify-center h-48">
            <Loader2 size={24} className="animate-spin text-gray-300" />
          </div>
        ) : !item ? (
          <div className="flex items-center justify-center h-48 text-gray-400 text-sm">Item not found</div>
        ) : (
          <>
            {/* Header */}
            <div
              className="sticky top-0 bg-white border-b border-gray-100 p-4 flex items-center justify-between gap-2"
              style={{ paddingTop: 'calc(1rem + env(safe-area-inset-top, 0px))' }}
            >
              <div className="flex-1 min-w-0">
                {editMode ? (
                  <input
                    value={editForm.itemName}
                    onChange={e => setEditForm(f => ({ ...f, itemName: e.target.value }))}
                    className="w-full font-semibold text-gray-900 border border-gray-200 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                  />
                ) : (
                  <h2 className="font-semibold text-gray-900 truncate">{item.itemName}</h2>
                )}
                {item.storageArea && !editMode && <p className="text-xs text-gray-400">{item.storageArea.name}</p>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {editMode ? (
                  <>
                    <button
                      onClick={handleSave}
                      disabled={saving}
                      className="px-3 py-1.5 bg-gold text-white text-xs rounded-lg hover:bg-[#a88930] disabled:opacity-50 flex items-center gap-1"
                    >
                      {saving && <Loader2 size={10} className="animate-spin" />}
                      Save
                    </button>
                    <button onClick={() => setEditMode(false)} className="px-3 py-1.5 border border-gray-200 text-xs rounded-lg hover:bg-gray-50">Cancel</button>
                  </>
                ) : (
                  <button
                    onClick={openEdit}
                    className="flex items-center gap-1.5 px-3 py-1.5 border border-gray-200 text-xs rounded-lg hover:bg-gray-50"
                  >
                    <Pencil size={12} /> Edit
                  </button>
                )}
                <button onClick={onClose} className="p-2.5 flex items-center justify-center text-gray-400 hover:text-gray-600"><X size={20} /></button>
              </div>
            </div>

            {editMode ? (
              <div className="p-4 space-y-4">
                {/* Active */}
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={editForm.isActive}
                    onChange={e => setEditForm(f => ({ ...f, isActive: e.target.checked }))}
                    className="w-4 h-4 rounded border-gray-300 text-gold focus:ring-gold"
                  />
                  <span className="text-sm font-medium text-gray-700">Active</span>
                  <span className="text-xs text-gray-400">&mdash; uncheck to exclude from inventory totals</span>
                </label>

                {/* Category */}
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Category</label>
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
                      fetch('/api/categories').then(r => r.json()).then(setCategories)
                      return { id: cat.name, name: cat.name }
                    }}
                  />
                </div>

                {/* Supplier */}
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Supplier</label>
                  <Combobox
                    items={suppliers}
                    value={editForm.supplierName}
                    placeholder="Type to search suppliers…"
                    onSelect={(id, name) => setEditForm(f => ({ ...f, supplierId: id, supplierName: name }))}
                    onAddNew={async (name) => {
                      const res = await fetch('/api/suppliers', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name }),
                      })
                      const sup = await res.json()
                      fetch('/api/suppliers').then(r => r.json()).then(setSuppliers)
                      return { id: sup.id, name: sup.name }
                    }}
                  />
                </div>

                {/* Storage Area */}
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Storage Area</label>
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
                      fetch('/api/storage-areas').then(r => r.json()).then(setStorageAreas)
                      return { id: area.id, name: area.name }
                    }}
                  />
                </div>

                {item.recipe && (
                  <div className="bg-purple-50 border border-purple-200 rounded-lg px-3 py-2 text-xs text-purple-700 flex items-start gap-2">
                    <span className="text-purple-400 mt-0.5">⟳</span>
                    <span><strong>Price is managed by recipe:</strong> {item.recipe.name}. Edit the recipe to change costs. You can only change Count UOM and stock fields here.</span>
                  </div>
                )}

                {/* Purchase structure */}
                {!item.recipe && (
                  <div className="space-y-3">
                    {/* Per Case / Per UOM toggle */}
                    <div className="flex gap-2 p-1 bg-gray-100 rounded-xl">
                      {(['CASE', 'UOM'] as const).map(pt => (
                        <button
                          key={pt}
                          type="button"
                          onClick={() => setEditForm(f => ({
                            ...f,
                            priceType: pt,
                            ...(pt === 'UOM' && !['kg','g','lb','oz','l','ml'].includes(f.packUOM) ? { packUOM: 'kg' } : {}),
                          }))}
                          className={`flex-1 py-2 rounded-lg text-xs font-medium transition-all ${
                            editForm.priceType === pt
                              ? 'bg-white text-gray-900 shadow-sm'
                              : 'text-gray-500 hover:text-gray-700'
                          }`}
                        >
                          {pt === 'CASE' ? 'Per Case' : 'Per UOM'}
                        </button>
                      ))}
                    </div>

                    {editForm.priceType === 'CASE' && (
                      <>
                        {/* Row 1: Purchase Unit + Qty/Unit pair */}
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs font-medium text-gray-600 mb-1">Purchase Unit</label>
                            <select value={editForm.purchaseUnit} onChange={e => setEditForm(f => ({ ...f, purchaseUnit: e.target.value }))}
                              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold bg-white">
                              {PURCHASE_UNITS.map(u => <option key={u}>{u}</option>)}
                            </select>
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-600 mb-1">Qty per {editForm.purchaseUnit}</label>
                            <div className="flex">
                              <input type="number" step="any" value={editForm.qtyPerPurchaseUnit}
                                onChange={e => setEditForm(f => ({ ...f, qtyPerPurchaseUnit: e.target.value }))}
                                className="w-full border border-gray-200 rounded-l-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold border-r-0" />
                              <select value={editForm.qtyUOM} onChange={e => setEditForm(f => {
                                  const newQtyUOM = e.target.value
                                  const opts = getCountableUoms({ baseUnit: deriveBaseUnit(newQtyUOM, f.packUOM, parseFloat(f.packSize) || 0), purchaseUnit: f.purchaseUnit, qtyPerPurchaseUnit: parseFloat(f.qtyPerPurchaseUnit) || 1, qtyUOM: newQtyUOM, innerQty: f.innerQty ? parseFloat(f.innerQty) : null, packSize: parseFloat(f.packSize) || 0, packUOM: f.packUOM, countUOM: f.countUOM }).map(u => u.label)
                                  return { ...f, qtyUOM: newQtyUOM, innerQty: newQtyUOM === 'pack' ? f.innerQty : '', countUOM: opts.includes(f.countUOM) ? f.countUOM : opts[0] }
                                })}
                                className="border border-gray-200 rounded-r-lg px-2 py-2 text-sm text-gray-700 bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gold">
                                {QTY_UOMS.map(u => <option key={u}>{u}</option>)}
                              </select>
                            </div>
                          </div>
                        </div>

                        {/* Conditional: pack breakdown when qtyUOM = pack */}
                        {editForm.qtyUOM === 'pack' && (
                          <div className="ml-3 pl-3 border-l-2 border-amber-300 space-y-2">
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <label className="block text-xs font-medium text-gray-600 mb-1">Items per Pack</label>
                                <div className="flex">
                                  <input type="number" step="any" min="1" value={editForm.innerQty}
                                    onChange={e => setEditForm(f => ({ ...f, innerQty: e.target.value }))}
                                    className="w-full border border-gray-200 rounded-l-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold border-r-0" />
                                  <span className="border border-gray-200 rounded-r-lg px-3 py-2 text-sm text-gray-500 bg-gray-50">each</span>
                                </div>
                              </div>
                              <div>
                                <label className="block text-xs font-medium text-gray-600 mb-1">
                                  Weight per Item
                                  <span className="ml-1 text-[10px] font-semibold bg-gray-100 text-gray-400 rounded px-1 py-0.5 normal-case tracking-normal">optional</span>
                                </label>
                                <div className="flex">
                                  <input type="number" step="any" min="0" value={editForm.packSize}
                                    onChange={e => setEditForm(f => ({ ...f, packSize: e.target.value }))}
                                    placeholder="e.g. 100"
                                    className="w-full border border-gray-200 rounded-l-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold border-r-0" />
                                  <select value={editForm.packUOM} onChange={e => setEditForm(f => ({ ...f, packUOM: e.target.value }))}
                                    className="border border-gray-200 rounded-r-lg px-2 py-2 text-sm text-gray-700 bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gold">
                                    {(['g', 'kg', 'ml', 'l', 'lb', 'oz']).map(u => <option key={u}>{u}</option>)}
                                  </select>
                                </div>
                                <p className="text-[10px] text-amber-700 bg-amber-50 rounded px-2 py-1 mt-1">Leave blank → price per each. Fill in → price per g, usable in recipes by weight.</p>
                              </div>
                            </div>
                          </div>
                        )}

                        {/* Conditional: weight per item when qtyUOM = each */}
                        {editForm.qtyUOM === 'each' && (
                          <div className="ml-3 pl-3 border-l-2 border-amber-300">
                            <label className="block text-xs font-medium text-gray-600 mb-1">
                              Weight per Each
                              <span className="ml-1 text-[10px] font-semibold bg-gray-100 text-gray-400 rounded px-1 py-0.5 normal-case tracking-normal">optional</span>
                            </label>
                            <div className="flex">
                              <input type="number" step="any" min="0" value={editForm.packSize}
                                onChange={e => {
                                  const val = e.target.value
                                  // When weight is cleared, reset countUOM to 'each' (weight options disappear)
                                  const newPs = parseFloat(val) || 0
                                  const wasWeight = parseFloat(editForm.packSize) > 0
                                  setEditForm(f => ({
                                    ...f,
                                    packSize: val,
                                    countUOM: wasWeight && newPs <= 0 ? 'each' : f.countUOM,
                                  }))
                                }}
                                placeholder="e.g. 290"
                                className="w-full border border-gray-200 rounded-l-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold border-r-0" />
                              <select value={editForm.packUOM} onChange={e => setEditForm(f => ({ ...f, packUOM: e.target.value }))}
                                className="border border-gray-200 rounded-r-lg px-2 py-2 text-sm text-gray-700 bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gold">
                                {(['g', 'kg', 'ml', 'l', 'lb', 'oz']).map(u => <option key={u}>{u}</option>)}
                              </select>
                            </div>
                            <p className="text-[10px] text-amber-700 bg-amber-50 rounded px-2 py-1 mt-1">Leave blank → price per each. Fill in → price per g, usable in recipes by weight.</p>
                          </div>
                        )}

                        {/* Generated description label */}
                        {(() => {
                          const desc = buildPurchaseDescription(
                            editForm.purchaseUnit,
                            parseFloat(editForm.qtyPerPurchaseUnit) || 0,
                            editForm.qtyUOM,
                            editForm.innerQty ? parseFloat(editForm.innerQty) : null,
                            parseFloat(editForm.packSize) || 0,
                            editForm.packUOM,
                          )
                          return (
                            <p className="text-xs text-gray-400 italic">= {desc}</p>
                          )
                        })()}
                      </>
                    )}

                    {editForm.priceType === 'UOM' && (
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Price Unit</label>
                        <select value={editForm.packUOM} onChange={e => setEditForm(f => ({ ...f, packUOM: e.target.value }))}
                          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold bg-white">
                          {(['kg', 'g', 'lb', 'oz', 'l', 'ml']).map(u => <option key={u}>{u}</option>)}
                        </select>
                        <p className="text-[10px] text-blue-600 bg-blue-50 rounded px-2 py-1 mt-1">Price is entered as cost per {editForm.packUOM} — ideal for produce and bulk items.</p>
                      </div>
                    )}

                    {/* Purchase Price */}
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">
                        {editForm.priceType === 'UOM' ? `Price / ${editForm.packUOM} ($)` : 'Purchase Price ($)'}
                      </label>
                      <input type="number" step="any" value={editForm.purchasePrice}
                        onChange={e => setEditForm(f => ({ ...f, purchasePrice: e.target.value }))}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold" />
                    </div>
                  </div>
                )}

                {/* Stock + Count fields */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      Count UOM
                      {item.recipe && (
                        <span className="ml-1 text-purple-500 font-normal">
                          ({getUnitDimension(item.baseUnit)}-compatible)
                        </span>
                      )}
                    </label>
                    <select value={editForm.countUOM} onChange={e => setEditForm(f => ({ ...f, countUOM: e.target.value }))}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold bg-white">
                      {(() => {
                        const rawPs = parseFloat(editForm.packSize) || 0
                        const hasWpe = rawPs > 0
                        const effPu = hasWpe ? editForm.packUOM : 'each'
                        return getCountableUoms({
                          baseUnit: deriveBaseUnit(editForm.qtyUOM, effPu, rawPs),
                          purchaseUnit: editForm.purchaseUnit,
                          qtyPerPurchaseUnit: parseFloat(editForm.qtyPerPurchaseUnit) || 1,
                          qtyUOM: editForm.qtyUOM,
                          innerQty: editForm.innerQty ? parseFloat(editForm.innerQty) : null,
                          packSize: rawPs,
                          packUOM: effPu,
                          countUOM: editForm.countUOM,
                        }).map(u => <option key={u.label} value={u.label}>{u.label}{u.hint ? ` — ${u.hint}` : ''}</option>)
                      })()}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Stock On Hand ({editForm.countUOM})</label>
                    <input type="number" step="any" value={editForm.stockOnHand}
                      onChange={e => setEditForm(f => ({ ...f, stockOnHand: e.target.value }))}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold" />
                  </div>
                </div>

                {/* Barcode */}
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Barcode</label>
                  <input
                    type="text"
                    value={editForm.barcode ?? ''}
                    onChange={e => setEditForm(f => ({ ...f, barcode: e.target.value || null }))}
                    placeholder="Scan or type barcode"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold"
                  />
                </div>

                {/* Allergens */}
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-2">Allergens (Health Canada Big 9)</label>
                  <AllergenToggles
                    active={new Set(editForm.allergens)}
                    onToggle={key => setEditForm(f => ({
                      ...f,
                      allergens: f.allergens.includes(key)
                        ? f.allergens.filter(x => x !== key)
                        : [...f.allergens, key],
                    }))}
                  />
                </div>

                {/* Auto-calculated preview */}
                {(() => {
                  const isPrep = !!item.recipe
                  const pp     = parseFloat(editForm.purchasePrice) || 0
                  const qty    = parseFloat(editForm.qtyPerPurchaseUnit) || 1
                  const rawPs  = parseFloat(editForm.packSize) || 0
                  const hasWpe = rawPs > 0
                  const ps     = hasWpe ? rawPs : 1                       // 1 for math (avoid ÷0)
                  const pu     = hasWpe ? editForm.packUOM : 'each'       // 'each' when no weight
                  const cu     = editForm.countUOM
                  const qu     = editForm.qtyUOM ?? 'each'
                  const iq     = editForm.innerQty ? parseFloat(editForm.innerQty) : null
                  const bu     = isPrep ? (item.baseUnit ?? deriveBaseUnit(qu, pu)) : deriveBaseUnit(qu, pu, rawPs)
                  const ppbu = isPrep
                    ? parseFloat(String(item.pricePerBaseUnit ?? 0))
                    : calcPricePerBaseUnit(pp, qty, qu, iq, ps, pu, editForm.priceType === 'UOM' ? 'UOM' : 'CASE')
                  const cf = isPrep
                    ? parseFloat(String(item.conversionFactor ?? 1))
                    : calcConversionFactor(cu, qty, qu, iq, ps, pu)
                  return (
                    <div className={`rounded-lg p-3 space-y-1.5 ${isPrep ? 'bg-purple-50' : 'bg-gold/10'}`}>
                      <div className={`text-xs font-semibold uppercase tracking-wide ${isPrep ? 'text-purple-700' : 'text-gold'}`}>
                        {isPrep ? 'Recipe-derived cost' : 'Auto-calculated'}
                      </div>
                      <div className="flex items-baseline gap-1.5">
                        <span className={`text-xs ${isPrep ? 'text-purple-600' : 'text-gold'}`}>Price per {bu}:</span>
                        <span className={`text-lg font-bold ${isPrep ? 'text-purple-700' : 'text-gold'}`}>{formatUnitPrice(ppbu)}</span>
                      </div>
                      <div className="flex items-baseline gap-1.5">
                        <span className={`text-xs ${isPrep ? 'text-purple-600' : 'text-gold'}`}>1 {cu} =</span>
                        <span className={`font-semibold ${isPrep ? 'text-purple-700' : 'text-gold'}`}>{cf.toFixed(4)} {bu}</span>
                      </div>
                      <div className={`text-xs ${isPrep ? 'text-purple-500' : 'text-blue-500'}`}>
                        {(() => {
                          if (isPrep) return `Recipe total ÷ ${ps.toLocaleString()} ${bu} yield = ${formatUnitPrice(ppbu)}/${bu}`
                          if (editForm.priceType === 'UOM') {
                            const conv = getUnitConv(pu)
                            const base = conv > 0 ? pp / conv : 0
                            return `$${pp.toFixed(2)} ÷ conv(${pu}) = $${base.toFixed(4)}/base unit`
                          }
                          if (['kg','g','lb','oz','l','ml'].includes(qu)) return `$${pp.toFixed(2)} ÷ (${qty} ${qu}) = ${formatUnitPrice(ppbu)}/${bu}`
                          if (qu === 'pack' && iq != null) return `$${pp.toFixed(2)} ÷ (${qty} × ${iq} × ${ps} ${pu}) = ${formatUnitPrice(ppbu)}/${bu}`
                          return `$${pp.toFixed(2)} ÷ (${qty} × ${ps} ${pu}) = ${formatUnitPrice(ppbu)}/${bu}`
                        })()}
                      </div>
                    </div>
                  )
                })()}
              </div>
            ) : (
              <div className="p-4 space-y-4">
                <div className="flex items-center gap-2 flex-wrap">
                  <CategoryBadge category={item.category} />
                  <StockStatus stock={displayStock(item)} />
                  {item.allergens && item.allergens.length > 0 && item.allergens.map(a => (
                    <span key={a} className="px-2 py-0.5 rounded-full text-xs bg-orange-100 text-orange-700 font-medium">⚠ {a}</span>
                  ))}
                  {item.isActive
                    ? <span className="px-2 py-0.5 rounded-full text-xs bg-green-100 text-green-700 font-medium">Active</span>
                    : <span className="px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-500">Inactive</span>
                  }
                </div>

                <div className="grid grid-cols-2 gap-3 text-sm">
                  {(() => {
                    const rows: [string, string][] = item.recipe ? [
                      ['Supplier',      item.supplier?.name || '—'],
                      ['Storage Area',  item.storageArea?.name || '—'],
                      ['Linked Recipe', item.recipe.name],
                      ['Yield',         `${parseFloat(String(item.packSize ?? 1)).toLocaleString()} ${item.baseUnit}`],
                      ['Batch Cost',    formatCurrency(parseFloat(String(item.purchasePrice)))],
                      ['Count UOM',     item.countUOM ?? item.baseUnit],
                    ] : [
                      ['Supplier',       item.supplier?.name || '—'],
                      ['Storage Area',   item.storageArea?.name || '—'],
                      ['Purchase',       buildPurchaseDescription(normalizePurchaseUnit(item.purchaseUnit), Number(item.qtyPerPurchaseUnit), item.qtyUOM ?? 'each', item.innerQty != null ? Number(item.innerQty) : null, item.baseUnit === 'each' ? 0 : Number(item.packSize ?? 0), item.packUOM ?? 'each')],
                      ['Purchase Price', formatCurrency(parseFloat(String(item.purchasePrice)))],
                      ['Count UOM',      item.countUOM ?? 'each'],
                      ...(item.barcode ? [['Barcode', item.barcode] as [string, string]] : []),
                    ]
                    return rows.map(([label, value]) => (
                      <div key={label} className="bg-gray-50 rounded-lg p-3">
                        <div className="text-xs text-gray-500">{label}</div>
                        <div className="font-medium text-gray-800 mt-0.5">{value}</div>
                      </div>
                    ))
                  })()}

                  <div className={`rounded-lg p-3 col-span-2 ${item.recipe ? 'bg-purple-50' : 'bg-gold/10'}`}>
                    {item.recipe && (
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <span className="text-[10px] font-bold uppercase tracking-wide bg-purple-200 text-purple-800 px-1.5 py-0.5 rounded-full">Recipe</span>
                        <span className="text-xs text-purple-700 font-medium">{item.recipe.name}</span>
                      </div>
                    )}
                    <div className={`text-xs font-medium ${item.recipe ? 'text-purple-600' : 'text-gold'}`}>
                      Price per {item.baseUnit}
                    </div>
                    <div className={`text-lg font-bold mt-0.5 ${item.recipe ? 'text-purple-700' : 'text-gold'}`}>
                      {formatUnitPrice(parseFloat(String(item.pricePerBaseUnit)))} / {item.baseUnit}
                    </div>
                    <div className={`text-xs mt-1 ${item.recipe ? 'text-purple-500' : 'text-blue-500'}`}>
                      {item.recipe
                        ? <>Recipe total {formatCurrency(parseFloat(String(item.purchasePrice)))} ÷ {parseFloat(String(item.packSize ?? 1)).toLocaleString()} {item.baseUnit} yield</>
                        : <>{formatCurrency(parseFloat(String(item.purchasePrice)))} ÷ ({parseFloat(String(item.qtyPerPurchaseUnit))} × {parseFloat(String(item.packSize ?? 1))} {item.packUOM ?? 'each'})</>
                      }
                      &nbsp;|&nbsp; 1 {item.countUOM ?? 'each'} = {parseFloat(String(item.conversionFactor)).toFixed(4)} {item.baseUnit}
                    </div>
                  </div>
                </div>

                {/* Stock Overview */}
                <div className="space-y-2">
                  <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Stock</div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-gray-50 rounded-lg p-3">
                      <div className="text-xs text-gray-500">Last Count</div>
                      <div className="font-bold text-gray-900 mt-0.5">
                        {stockMovements
                          ? `${stockMovements.lastCount.qty.toFixed(2)} ${stockMovements.lastCount.unit}`
                          : '—'}
                      </div>
                      <div className="text-xs text-gray-400 mt-0.5">
                        {stockMovements?.lastCount.date
                          ? new Date(stockMovements.lastCount.date).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })
                          : 'Never counted'}
                      </div>
                    </div>
                    <div className="bg-blue-50 rounded-lg p-3">
                      <div className="text-xs text-blue-600">Theoretical Stock</div>
                      <div className="font-bold text-blue-800 mt-0.5">
                        {stockMovements
                          ? `${stockMovements.theoretical.qty.toFixed(2)} ${stockMovements.theoretical.unit}`
                          : '—'}
                      </div>
                      <div className="text-xs text-blue-400 mt-0.5">Estimated current</div>
                    </div>
                  </div>

                  {/* Movement Log */}
                  {stockMovements && stockMovements.movements.length > 0 && (
                    <div className="space-y-0.5 mt-1">
                      {stockMovements.movements.slice(0, 12).map(m => {
                        const isPositive = m.qty >= 0
                        const typeConfig: Record<MovementType, { label: string; color: string }> = {
                          SALE:     { label: 'Sale',        color: 'text-red-500' },
                          WASTAGE:  { label: 'Wastage',     color: 'text-orange-500' },
                          PREP_IN:  { label: 'Prep (used)', color: 'text-purple-600' },
                          PREP_OUT: { label: 'Prep (yield)',color: 'text-green-600' },
                          PURCHASE: { label: 'Purchase',    color: 'text-blue-600' },
                        }
                        const cfg = typeConfig[m.type] ?? { label: m.type, color: 'text-gray-600' }
                        return (
                          <div key={m.id} className="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-gray-50 text-xs">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className={`shrink-0 font-medium ${cfg.color}`}>{cfg.label}</span>
                              <span className="text-gray-400 truncate">{m.description}</span>
                            </div>
                            <div className="flex items-center gap-2 shrink-0 ml-2">
                              <span className={`font-semibold ${isPositive ? 'text-green-600' : 'text-red-500'}`}>
                                {isPositive ? '+' : ''}{m.qty.toFixed(2)} {m.unit}
                              </span>
                              <span className="text-gray-400 w-14 text-right">
                                {new Date(m.date).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}
                              </span>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                  {stockMovements && stockMovements.movements.length === 0 && (
                    <div className="text-xs text-gray-400 text-center py-2">No movements recorded</div>
                  )}
                </div>

                {/* RC Allocation Panel */}
                {revenueCenters.length > 1 && (
                  <RcAllocationPanel
                    itemId={item.id}
                    stockOnHand={displayStock(item)}
                    countUOM={item.countUOM || item.baseUnit}
                    defaultRcId={defaultRcId}
                    onPulled={() => {
                      fetch(`/api/inventory/${item.id}`).then(r => r.json()).then(setItem)
                      onUpdated?.()
                    }}
                  />
                )}

                {/* Price History */}
                {priceHistory.length > 0 && (
                  <div className="mt-2">
                    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Price History</div>
                    <div className="space-y-1.5">
                      {priceHistory.map((h, i) => (
                        <div key={i} className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2 text-xs">
                          <div className="min-w-0">
                            <div className="font-medium text-gray-800 truncate">{h.supplierName}</div>
                            <div className="text-gray-400">
                              {new Date(h.invoiceDate).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })}
                              {h.invoiceNumber ? ` · #${h.invoiceNumber}` : ''}
                            </div>
                          </div>
                          <div className="text-right shrink-0 ml-3">
                            <div className="font-semibold text-gray-900">{formatCurrency(h.unitPrice)}</div>
                            <div className="text-gray-400">{formatCurrency(h.lineTotal)} total</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

```


---

## `src/components/inventory/PullModal.tsx`

```tsx
'use client'
import { useState } from 'react'
import { X } from 'lucide-react'
import { rcHex } from '@/lib/rc-colors'

interface RC {
  id: string
  name: string
  color: string
  isDefault: boolean
}

interface ItemMin {
  id: string
  itemName: string
  stockOnHand: number
  countUOM: string
  baseUnit: string
}

interface Props {
  item: ItemMin
  revenueCenters: RC[]
  activeRcId: string | null
  onClose: () => void
  onSuccess: () => void
}

export function PullModal({ item, revenueCenters, activeRcId, onClose, onSuccess }: Props) {
  const nonDefaultRcs = revenueCenters.filter(rc => !rc.isDefault)

  const initialRcId = (() => {
    if (activeRcId && !revenueCenters.find(rc => rc.id === activeRcId)?.isDefault) return activeRcId
    return nonDefaultRcs[0]?.id ?? ''
  })()

  const [rcId, setRcId]     = useState(initialRcId)
  const [qty, setQty]       = useState('')
  const [notes, setNotes]   = useState('')
  const [pulling, setPulling] = useState(false)
  const [error, setError]   = useState('')

  const available = parseFloat(String(item.stockOnHand))
  const countUOM  = item.countUOM || item.baseUnit
  const targetRc  = revenueCenters.find(rc => rc.id === rcId)

  const handlePull = async () => {
    if (!rcId || !qty) return
    const qtyNum = parseFloat(qty)
    if (isNaN(qtyNum) || qtyNum <= 0) { setError('Enter a valid quantity'); return }
    if (qtyNum > available) { setError(`Only ${available.toFixed(2)} ${countUOM} available`); return }

    setPulling(true)
    setError('')
    const res = await fetch('/api/stock-allocations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inventoryItemId: item.id, rcId, quantity: qtyNum, notes: notes || null }),
    })
    setPulling(false)
    if (!res.ok) {
      const d = await res.json()
      setError(d.error || 'Pull failed')
      return
    }
    onSuccess()
  }

  if (nonDefaultRcs.length === 0) return null

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div
        className="relative bg-white w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl shadow-2xl p-5 sm:mx-4"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 className="font-semibold text-gray-900">Pull Stock</h3>
            <p className="text-sm text-gray-500 mt-0.5">{item.itemName}</p>
          </div>
          <button onClick={onClose} className="p-2.5 flex items-center justify-center rounded-lg hover:bg-gray-100">
            <X size={18} className="text-gray-400" />
          </button>
        </div>

        <div className="space-y-3">
          {/* Available stock */}
          <div className="bg-gray-50 rounded-xl px-3 py-2.5 flex items-center justify-between">
            <span className="text-xs text-gray-500">Available (main pool)</span>
            <span className="font-semibold text-gray-900">
              {available.toFixed(2)} <span className="text-xs font-normal text-gray-400">{countUOM}</span>
            </span>
          </div>

          {/* Target RC selector (only if multiple) */}
          {nonDefaultRcs.length > 1 ? (
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1.5">Pull to</label>
              <div className="space-y-1">
                {nonDefaultRcs.map(rc => (
                  <button
                    key={rc.id}
                    onClick={() => setRcId(rc.id)}
                    className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-xl border text-sm transition-colors ${
                      rcId === rc.id
                        ? 'border-blue-300 bg-gold/10 text-blue-800 font-medium'
                        : 'border-gray-200 text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: rcHex(rc.color) }} />
                    {rc.name}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-gray-600">
              <span>Pulling to:</span>
              <span className="flex items-center gap-1.5 font-medium text-gray-900">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: rcHex(nonDefaultRcs[0].color) }} />
                {nonDefaultRcs[0].name}
              </span>
            </div>
          )}

          {/* Qty + UOM */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Quantity</label>
            <div className="flex gap-2">
              <input
                type="number"
                min="0"
                step="any"
                value={qty}
                onChange={e => setQty(e.target.value)}
                placeholder="0"
                autoFocus
                onKeyDown={e => e.key === 'Enter' && handlePull()}
                className="flex-1 border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
              />
              <div className="flex items-center justify-center px-3 bg-gray-100 rounded-xl text-sm font-medium text-gray-600 shrink-0 min-w-[3rem]">
                {countUOM}
              </div>
            </div>
          </div>

          {/* Notes */}
          <input
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Notes (optional)"
            className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none"
          />

          {error && <p className="text-xs text-red-500">{error}</p>}

          <button
            onClick={handlePull}
            disabled={pulling || !qty || !rcId || available <= 0}
            className="w-full py-2.5 bg-gold text-white rounded-xl text-sm font-semibold hover:bg-[#a88930] disabled:opacity-50 transition-colors"
          >
            {pulling ? 'Pulling…' : `Pull to ${targetRc?.name ?? '…'}`}
          </button>
        </div>
      </div>
    </div>
  )
}

```


---

## `src/components/inventory/InventoryImportModal.tsx`

```tsx
'use client'
import { useState } from 'react'
import { X, UploadCloud, Download, CheckCircle2, AlertCircle, Copy } from 'lucide-react'
import type { ImportReport } from '@/lib/inventory-import'

interface Props {
  onClose: () => void
  onImported: () => void
}

type Step = 'upload' | 'preview' | 'done'

export function InventoryImportModal({ onClose, onImported }: Props) {
  const [step, setStep]       = useState<Step>('upload')
  const [file, setFile]       = useState<File | null>(null)
  const [report, setReport]   = useState<ImportReport | null>(null)
  const [createdCount, setCreatedCount] = useState(0)
  const [busy, setBusy]       = useState(false)
  const [error, setError]     = useState<string | null>(null)

  async function runPreview(selected: File) {
    setBusy(true)
    setError(null)
    try {
      const fd = new FormData()
      fd.append('file', selected)
      const res = await fetch('/api/inventory/import/preview', { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Could not read the file'); return }
      setReport(data as ImportReport)
      setStep('preview')
    } catch {
      setError('Network error — try again.')
    } finally {
      setBusy(false)
    }
  }

  async function runImport() {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch('/api/inventory/import', { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Import failed'); return }
      setCreatedCount(data.created ?? 0)
      setStep('done')
    } catch {
      setError('Network error — try again.')
    } finally {
      setBusy(false)
    }
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    setFile(f)
    runPreview(f)
  }

  const statusStyle: Record<string, string> = {
    valid:     'bg-green-50 text-green-700',
    error:     'bg-red-50 text-red-700',
    duplicate: 'bg-amber-50 text-amber-700',
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      role="dialog" aria-modal="true"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-gray-100 shrink-0">
          <div>
            <h2 className="font-semibold text-gray-900">Import Inventory</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              Bulk-add items from a .csv or .xlsx file
            </p>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="p-2.5 flex items-center justify-center text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 flex-1 overflow-y-auto">
          {error && (
            <div className="mb-4 flex items-center gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              <AlertCircle size={15} className="shrink-0" /> {error}
            </div>
          )}

          {step === 'upload' && (
            <div className="space-y-4">
              <a href="/api/inventory/import/template"
                className="flex items-center gap-2 text-sm text-gold hover:underline">
                <Download size={15} /> Download the import template
              </a>
              <p className="text-xs text-gray-500">
                Fill the template, then upload it below. Items import into the
                <span className="font-semibold"> UNASSIGNED</span> category — review
                and assign their category, supplier, and storage area afterward.
              </p>
              <label className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-gray-200 rounded-xl py-10 cursor-pointer hover:border-[#c9a84c] transition-colors">
                <UploadCloud size={28} className="text-gray-300" />
                <span className="text-sm text-gray-500">
                  {busy ? 'Reading file…' : 'Choose a .csv or .xlsx file'}
                </span>
                <input type="file" accept=".csv,.xlsx" className="hidden"
                  disabled={busy} onChange={handleFile} />
              </label>
            </div>
          )}

          {step === 'preview' && report && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2 text-xs font-medium">
                <span className="px-2 py-1 rounded-full bg-green-50 text-green-700">
                  {report.validCount} valid
                </span>
                <span className="px-2 py-1 rounded-full bg-red-50 text-red-700">
                  {report.errorCount} errors
                </span>
                <span className="px-2 py-1 rounded-full bg-amber-50 text-amber-700">
                  {report.duplicateCount} duplicates (skipped)
                </span>
              </div>
              <div className="border border-gray-100 rounded-xl divide-y divide-gray-50 max-h-[45vh] overflow-y-auto">
                {report.rows.map(r => (
                  <div key={r.rowNumber} className="px-3 py-2 flex items-start gap-2 text-sm">
                    <span className="text-gray-300 tabular-nums shrink-0 w-7">
                      {r.rowNumber}
                    </span>
                    <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${statusStyle[r.status]}`}>
                      {r.status}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-gray-800 truncate">{r.itemName || '(no name)'}</div>
                      {r.status === 'error' && (
                        <ul className="text-xs text-red-600 mt-0.5 list-disc pl-4">
                          {r.errors.map((e, i) => <li key={i}>{e}</li>)}
                        </ul>
                      )}
                      {r.status === 'valid' && r.computed && (
                        <div className="text-xs text-gray-400 mt-0.5">
                          {r.computed.pricePerBaseUnit.toFixed(4)} / {r.computed.baseUnit}
                        </div>
                      )}
                      {r.status === 'duplicate' && (
                        <div className="text-xs text-amber-600 mt-0.5 flex items-center gap-1">
                          <Copy size={11} /> Already in inventory — skipped
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {step === 'done' && (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <CheckCircle2 size={40} className="text-green-500" />
              <p className="text-gray-800 font-medium">
                Created {createdCount} item{createdCount !== 1 ? 's' : ''}.
              </p>
              <p className="text-sm text-gray-500 max-w-sm">
                They are in the <span className="font-semibold">UNASSIGNED</span> category —
                review and assign their category, supplier, and storage area.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 p-5 border-t border-gray-100 shrink-0">
          {step === 'preview' && (
            <>
              <button type="button" onClick={() => { setStep('upload'); setReport(null); setFile(null) }}
                disabled={busy}
                className="px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50">
                Back
              </button>
              <button type="button" onClick={runImport}
                disabled={busy || !report || report.validCount === 0}
                className="px-4 py-2 text-sm bg-gold text-white rounded-lg hover:bg-[#a88930] disabled:opacity-50">
                {busy ? 'Importing…' : `Import ${report?.validCount ?? 0} item${report?.validCount === 1 ? '' : 's'}`}
              </button>
            </>
          )}
          {step === 'done' && (
            <button type="button" onClick={() => { onImported(); onClose() }}
              className="px-4 py-2 text-sm bg-gold text-white rounded-lg hover:bg-[#a88930]">
              Done
            </button>
          )}
          {step === 'upload' && (
            <button type="button" onClick={onClose}
              className="px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50">
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

```


---

## `src/components/inventory/RcAllocationPanel.tsx`

```tsx
'use client'
import { useState, useEffect, useCallback } from 'react'
import { ArrowRight, ChevronDown, ChevronUp, Pencil, X, Check } from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { rcHex } from '@/lib/rc-colors'

interface Allocation {
  revenueCenterId: string
  quantity: number
  parLevel:   number | null
  reorderQty: number | null
  revenueCenter: { id: string; name: string; color: string }
}

interface Transfer {
  id: string
  fromRc: { name: string; color: string }
  toRc:   { name: string; color: string }
  quantity: number
  notes: string | null
  createdAt: string
}

interface Props {
  itemId:       string
  stockOnHand:  number
  countUOM:     string
  defaultRcId:  string | null
  onPulled:     () => void
}

export function RcAllocationPanel({ itemId, stockOnHand, countUOM, defaultRcId, onPulled }: Props) {
  const { revenueCenters } = useRc()
  const [allocations, setAllocations] = useState<Allocation[]>([])
  const [transfers, setTransfers]     = useState<Transfer[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [pullRcId, setPullRcId]       = useState<string | null>(null)
  const [pullQty, setPullQty]         = useState('')
  const [pullNotes, setPullNotes]     = useState('')
  const [pulling, setPulling]         = useState(false)
  const [pullError, setPullError]     = useState('')

  const [editParRcId,    setEditParRcId]    = useState<string | null>(null)
  const [editParLevel,   setEditParLevel]   = useState('')
  const [editReorderQty, setEditReorderQty] = useState('')
  const [savingPar,      setSavingPar]      = useState(false)
  const [parError,       setParError]       = useState('')

  const loadData = useCallback(async () => {
    const [allocsRes, transferRes] = await Promise.all([
      fetch(`/api/stock-allocations?itemId=${itemId}`).then(r => r.json()),
      fetch(`/api/stock-transfers?itemId=${itemId}`).then(r => r.json()),
    ])
    setAllocations(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (allocsRes as any[]).map((a: any) => ({
        ...a,
        parLevel:   a.parLevel   !== null && a.parLevel   !== undefined ? Number(a.parLevel)   : null,
        reorderQty: a.reorderQty !== null && a.reorderQty !== undefined ? Number(a.reorderQty) : null,
      }))
    )
    setTransfers(transferRes)
  }, [itemId])

  useEffect(() => { loadData() }, [loadData])

  const handlePull = async (rcId: string) => {
    if (!pullQty) return
    setPulling(true)
    setPullError('')
    const res = await fetch('/api/stock-allocations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inventoryItemId: itemId,
        rcId,
        quantity: parseFloat(pullQty),
        notes: pullNotes || null,
      }),
    })
    setPulling(false)
    if (!res.ok) {
      const d = await res.json()
      setPullError(d.error || 'Pull failed')
      return
    }
    setPullRcId(null)
    setPullQty('')
    setPullNotes('')
    setPullError('')
    loadData()
    onPulled()
  }

  const openParEdit = (rcId: string, alloc: Allocation | undefined) => {
    setPullRcId(null)      // close pull form
    setPullQty('')
    setPullNotes('')
    setPullError('')
    setEditParRcId(rcId)
    setEditParLevel(alloc?.parLevel != null ? String(alloc.parLevel) : '')
    setEditReorderQty(alloc?.reorderQty != null ? String(alloc.reorderQty) : '')
    setParError('')
  }

  const handleSavePar = async (rcId: string) => {
    setSavingPar(true)
    setParError('')
    const res = await fetch('/api/stock-allocations', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inventoryItemId: itemId,
        rcId,
        parLevel:   editParLevel   === '' ? null : Number(editParLevel),
        reorderQty: editReorderQty === '' ? null : Number(editReorderQty),
      }),
    })
    setSavingPar(false)
    if (!res.ok) {
      const d = await res.json()
      setParError(d.error || 'Save failed')
      return
    }
    setEditParRcId(null)
    setEditParLevel('')
    setEditReorderQty('')
    setParError('')
    loadData()
  }

  return (
    <div className="border border-gray-100 rounded-xl overflow-hidden">
      <div className="px-4 py-3 bg-gray-50 border-b border-gray-100">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Stock by Revenue Center</p>
      </div>

      <div className="divide-y divide-gray-50">
        {revenueCenters.map(rc => {
          const isDefaultRc  = rc.id === defaultRcId
          const alloc        = allocations.find(a => a.revenueCenterId === rc.id)
          const qty          = isDefaultRc ? stockOnHand : (alloc ? Number(alloc.quantity) : 0)
          const parLevel     = alloc?.parLevel ?? null
          const isBelowPar   = parLevel !== null && qty < parLevel
          const isEditingPar = editParRcId === rc.id
          const isPulling    = pullRcId === rc.id
          const suggested    = isBelowPar && parLevel !== null ? parLevel - qty : null

          return (
            <div
              key={rc.id}
              className={`px-4 py-3 border-l-2 transition-colors ${isBelowPar ? 'border-amber-400 bg-amber-50/40' : 'border-transparent'}`}
            >
              {/* RC header row */}
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: rcHex(rc.color) }} />
                <span className={`flex-1 text-sm ${isDefaultRc ? 'font-semibold text-gray-900' : 'text-gray-600'}`}>
                  {rc.name}
                  {isDefaultRc && <span className="text-xs text-gray-400 font-normal ml-1">main pool</span>}
                </span>
                <span className="text-sm font-medium text-gray-700">
                  {qty.toFixed(2)} <span className="text-xs text-gray-400">{countUOM}</span>
                  {parLevel !== null && (
                    <span className={`ml-1 text-xs ${isBelowPar ? 'text-amber-600' : 'text-gray-400'}`}>
                      / par {parLevel}
                    </span>
                  )}
                </span>
                {isBelowPar && (
                  <span className="text-xs font-semibold bg-amber-100 text-amber-700 rounded-full px-2 py-0.5 shrink-0">
                    ⚠ Below Par
                  </span>
                )}
                <button
                  onClick={() => isEditingPar ? setEditParRcId(null) : openParEdit(rc.id, alloc)}
                  className="text-xs text-gray-400 hover:text-gray-600 shrink-0 p-1"
                  title={isEditingPar ? 'Cancel' : 'Edit par level'}
                >
                  {isEditingPar ? <X size={12} /> : <Pencil size={12} />}
                </button>
                {!isDefaultRc && (
                  <button
                    onClick={() => {
                      setEditParRcId(null)   // close par edit form
                      setEditParLevel('')
                      setEditReorderQty('')
                      setParError('')
                      setPullRcId(isPulling ? null : rc.id)
                      setPullQty('')
                      setPullNotes('')
                      setPullError('')
                    }}
                    className={`text-xs font-medium flex items-center gap-1 px-2.5 py-1 rounded-lg transition-colors ${
                      isPulling
                        ? 'bg-gold/15 text-gold border border-gold/30'
                        : 'bg-gold/10 text-gold hover:bg-gold/15 border border-blue-100'
                    }`}
                  >
                    Pull <ArrowRight size={11} />
                  </button>
                )}
              </div>

              {/* Below-par suggestion */}
              {isBelowPar && suggested !== null && !isEditingPar && (
                <div className="mt-1.5 ml-4 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
                  📦 Suggested order: <strong>{suggested.toFixed(2)} {countUOM}</strong> (par − current)
                </div>
              )}

              {/* Par edit form */}
              {isEditingPar && (
                <div className="mt-2 ml-4 space-y-2">
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <label className="text-xs text-gray-500 block mb-0.5">Par Level ({countUOM})</label>
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={editParLevel}
                        onChange={e => setEditParLevel(e.target.value)}
                        placeholder="e.g. 10"
                        className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                      />
                    </div>
                    <div className="flex-1">
                      <label className="text-xs text-gray-500 block mb-0.5">Order Qty (auto)</label>
                      <input
                        type="number"
                        min="0.01"
                        step="any"
                        value={editReorderQty}
                        onChange={e => setEditReorderQty(e.target.value)}
                        placeholder="auto"
                        className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                      />
                    </div>
                  </div>
                  {parError && <p className="text-xs text-red-500">{parError}</p>}
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleSavePar(rc.id)}
                      disabled={savingPar}
                      className="flex items-center gap-1 px-3 py-1.5 bg-gold text-white rounded-lg text-xs font-medium hover:bg-[#a88930] disabled:opacity-50"
                    >
                      <Check size={11} /> {savingPar ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      onClick={() => setEditParRcId(null)}
                      className="px-3 py-1.5 text-gray-500 border border-gray-200 rounded-lg text-xs hover:bg-gray-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* Pull form */}
              {isPulling && (
                <div className="mt-3 pl-4 space-y-2">
                  <div className="text-xs text-gray-500">
                    Available: <span className="font-medium text-gray-700">{stockOnHand.toFixed(2)} {countUOM}</span>
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={pullQty}
                      onChange={e => setPullQty(e.target.value)}
                      placeholder="Quantity"
                      className="flex-1 border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                    />
                    <div className="flex items-center justify-center px-2.5 bg-gray-100 rounded-lg text-sm text-gray-600 font-medium shrink-0">
                      {countUOM}
                    </div>
                    <button
                      onClick={() => handlePull(rc.id)}
                      disabled={pulling || !pullQty}
                      className="px-3 py-1.5 bg-gold text-white rounded-lg text-sm font-medium hover:bg-[#a88930] disabled:opacity-50"
                    >
                      {pulling ? '…' : 'Pull'}
                    </button>
                  </div>
                  <input
                    value={pullNotes}
                    onChange={e => setPullNotes(e.target.value)}
                    placeholder="Notes (optional)"
                    className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none"
                  />
                  {pullError && <p className="text-xs text-red-500">{pullError}</p>}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {transfers.length > 0 && (
        <div className="border-t border-gray-100">
          <button
            onClick={() => setShowHistory(h => !h)}
            className="w-full flex items-center gap-1 px-4 py-2 text-xs text-gray-400 hover:text-gray-600"
          >
            {showHistory ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            Transfer history ({transfers.length})
          </button>
          {showHistory && (
            <div className="px-4 pb-3 space-y-1">
              {transfers.slice(0, 10).map(t => (
                <div key={t.id} className="flex items-center gap-1.5 text-xs text-gray-500">
                  <span style={{ color: rcHex(t.fromRc.color) }}>●</span>
                  {t.fromRc.name}
                  <ArrowRight size={10} />
                  <span style={{ color: rcHex(t.toRc.color) }}>●</span>
                  {t.toRc.name}
                  <span className="ml-auto font-medium">{Number(t.quantity).toFixed(2)} {countUOM}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

```


---

## `src/components/prep/PrepKpiStrip.tsx`

```tsx
import { computeWorkloadMinutes, formatMinutes } from '@/lib/prep-utils'
import type { PrepItemRich } from './types'

interface Props {
  items: PrepItemRich[]
  onFilterPriority?: (p: string) => void
}

export function PrepKpiStrip({ items, onFilterPriority }: Props) {
  const total       = items.length
  const isComplete  = (i: PrepItemRich) => i.todayLog?.status === 'DONE' || i.todayLog?.status === 'PARTIAL'
  const critical    = items.filter(i => i.priority === '911'          && !isComplete(i)).length
  const neededToday = items.filter(i => i.priority === 'NEEDED_TODAY' && !isComplete(i)).length
  const done        = items.filter(i => i.todayLog?.status === 'DONE').length
  const blocked     = items.filter(i => i.isBlocked || i.todayLog?.status === 'BLOCKED').length

  const workloadMinutes   = computeWorkloadMinutes(items)
  const formattedWorkload = formatMinutes(workloadMinutes)

  if (total === 0) return null

  if (done === total) {
    return (
      <div className="flex items-center gap-4 text-sm flex-wrap">
        <span className="font-semibold text-green-600">✓ All done!</span>
        <span className="text-gray-400">{done} / {total} done</span>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-4 text-sm flex-wrap">
      <span className="text-gray-500">
        <span className="font-semibold text-gray-800">{total}</span> on list
      </span>
      {critical > 0 && (
        <button
          onClick={() => onFilterPriority?.('911')}
          className={`font-semibold text-red-600 ${onFilterPriority ? 'hover:underline cursor-pointer' : 'cursor-default'}`}
        >
          {critical} × Critical
        </button>
      )}
      {neededToday > 0 && (
        <button
          onClick={() => onFilterPriority?.('NEEDED_TODAY')}
          className={`font-semibold text-orange-600 ${onFilterPriority ? 'hover:underline cursor-pointer' : 'cursor-default'}`}
        >
          {neededToday} needed today
        </button>
      )}
      <span className="text-gray-400">{done} / {total} done</span>
      {workloadMinutes > 0 && (
        <span className="text-gray-500">{formattedWorkload} remaining</span>
      )}
      {blocked > 0 && (
        <span className="text-red-500">{blocked} blocked</span>
      )}
    </div>
  )
}

```


---

## `src/components/prep/PrepDetailPanel.tsx`

```tsx
'use client'
import { useState, useEffect } from 'react'
import { X, BookOpen, CheckCircle, Clock, AlertCircle, RotateCcw, ChevronRight, History } from 'lucide-react'
import { CategoryBadge } from '@/components/CategoryBadge'
import {
  PREP_PRIORITY_META,
  PREP_STATUS_META,
  PREP_PRIORITY_ORDER,
  type PrepPriority,
} from '@/lib/prep-utils'
import type { PrepItemRich, PrepItemDetail } from './types'

interface Props {
  item: PrepItemRich
  onClose: () => void
  onRefresh: () => void
  onEdit: () => void
}

interface HistoryLog {
  id: string
  logDate: string
  status: string
  actualPrepQty: string | number | null
  note: string | null
  assignedTo: string | null
}

const STATUS_SHORT: Record<string, { label: string; cls: string }> = {
  DONE:        { label: 'Done',       cls: 'bg-green-100 text-green-700' },
  PARTIAL:     { label: 'Partial',    cls: 'bg-amber-100 text-amber-700' },
  IN_PROGRESS: { label: 'In Progress',cls: 'bg-gold/15 text-gold' },
  BLOCKED:     { label: 'Blocked',    cls: 'bg-red-100 text-red-700' },
  SKIPPED:     { label: 'Skipped',    cls: 'bg-gray-100 text-gray-500' },
  NOT_STARTED: { label: 'Not Started',cls: 'bg-gray-100 text-gray-400' },
}

function fmtDate(iso: string) {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

export function PrepDetailPanel({ item, onClose, onRefresh, onEdit }: Props) {
  const [detail, setDetail]             = useState<PrepItemDetail | null>(null)
  const [actualQty, setActualQty]       = useState('')
  const [newRevertQty, setNewRevertQty] = useState('')
  const [showRevert, setShowRevert]     = useState(false)
  const [loading, setLoading]           = useState(false)
  const [warning, setWarning]           = useState<string | null>(null)
  const [history, setHistory]           = useState<HistoryLog[]>([])
  const [showHistory, setShowHistory]   = useState(false)

  useEffect(() => {
    fetch(`/api/prep/items/${item.id}`)
      .then(r => r.json())
      .then(setDetail)
  }, [item.id])

  useEffect(() => {
    fetch(`/api/prep/logs?prepItemId=${item.id}&days=14`)
      .then(r => r.json())
      .then((logs: HistoryLog[]) => setHistory(logs.filter(l => l.status !== 'NOT_STARTED')))
  }, [item.id])

  // Pre-fill actualQty from existing log
  useEffect(() => {
    if (item.todayLog?.actualPrepQty) setActualQty(String(item.todayLog.actualPrepQty))
  }, [item.todayLog?.actualPrepQty])

  const priority   = PREP_PRIORITY_META[item.priority]
  const logStatus  = item.todayLog?.status ?? 'NOT_STARTED'
  const statusMeta = PREP_STATUS_META[logStatus]

  async function ensureLog(): Promise<string> {
    if (item.todayLog?.id) return item.todayLog.id
    const log = await fetch('/api/prep/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prepItemId: item.id }),
    }).then(r => r.json())
    return log.id
  }

  async function updateStatus(newStatus: string) {
    const NEEDS_QTY = new Set(['DONE', 'PARTIAL'])
    if (NEEDS_QTY.has(newStatus) && !actualQty) {
      setWarning('Enter actual prep quantity first')
      return
    }
    setLoading(true)
    setWarning(null)
    const logId = await ensureLog()
    const res = await fetch(`/api/prep/logs/${logId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: newStatus,
        ...(actualQty && { actualPrepQty: parseFloat(actualQty) }),
      }),
    }).then(r => r.json())
    if (res.inventoryResult?.warning) setWarning(res.inventoryResult.warning)
    setLoading(false)
    onRefresh()
  }

  async function handleRevert() {
    if (!newRevertQty) return
    setLoading(true)
    await fetch(`/api/prep/logs/${item.todayLog!.id}/revert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newActualPrepQty: parseFloat(newRevertQty) }),
    })
    setShowRevert(false)
    setLoading(false)
    onRefresh()
  }

  async function setPriorityOverride(p: string) {
    await fetch(`/api/prep/items/${item.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manualPriorityOverride: p || null }),
    })
    onRefresh()
  }

  const baseYield = item.linkedRecipe?.baseYieldQty ?? 0
  const yieldUnit = item.linkedRecipe?.yieldUnit ?? item.unit
  const scale = item.unit === 'batch'
    ? parseFloat(actualQty || '0')
    : yieldUnit === item.unit && baseYield > 0
      ? parseFloat(actualQty || '0') / baseYield
      : 1

  return (
    <div
      className="fixed inset-0 z-[60] flex justify-end"
      onMouseDown={(e) => { (e.currentTarget as HTMLElement).dataset.mdown = String(e.target === e.currentTarget) }}
      onClick={(e) => { if (e.target === e.currentTarget && (e.currentTarget as HTMLElement).dataset.mdown === 'true') onClose() }}
    >
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" aria-hidden />
      <div
        className="relative w-full max-w-md bg-bg shadow-2xl h-full overflow-y-auto flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="sticky top-0 z-10 bg-paper p-5 border-b border-line flex items-start justify-between gap-3"
          style={{ paddingTop: 'calc(1.25rem + env(safe-area-inset-top, 0px))' }}
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="font-medium text-ink text-[19px] leading-[1.15] tracking-[-0.02em] truncate">{item.name}</h2>
              <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${priority.badgeClass}`}>
                {priority.label}
              </span>
            </div>
            <div className="flex items-center gap-2 mt-1.5">
              <CategoryBadge category={item.category} />
              {item.station && <span className="font-mono text-[10.5px] text-ink-4 uppercase tracking-[0.02em]">{item.station}</span>}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="shrink-0 w-8 h-8 grid place-items-center rounded-[8px] border border-line text-ink-3 hover:border-ink-4 hover:text-ink-2 transition-colors bg-paper">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 p-5 space-y-5">
          {/* Stock strip */}
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: 'ON HAND',   value: `${item.onHand.toFixed(1)} ${item.unit}`,     color: item.onHand <= 0 ? 'text-red-600' : 'text-ink' },
              { label: 'PAR LEVEL', value: `${item.parLevel.toFixed(1)} ${item.unit}`,   color: 'text-ink' },
              { label: 'MAKE',      value: `${item.suggestedQty.toFixed(1)} ${item.unit}`, color: item.suggestedQty > 0 ? 'text-gold-2' : 'text-ink-4' },
            ].map(c => (
              <div key={c.label} className="bg-paper border border-line rounded-[10px] p-3 text-center">
                <div className="font-mono text-[10px] text-ink-3 tracking-[0.02em] mb-1.5">{c.label}</div>
                <div className={`font-mono text-[15px] font-semibold tabular-nums tracking-[-0.01em] ${c.color}`}>{c.value}</div>
              </div>
            ))}
          </div>

          {/* Status + actions */}
          <div>
            <div className="flex items-center justify-between mb-2.5">
              <span className="font-mono text-[10.5px] font-semibold text-ink-3 uppercase tracking-[0.04em]">Status</span>
              <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${statusMeta.badgeClass}`}>{statusMeta.label}</span>
            </div>

            {/* Actual qty input */}
            <div className="mb-3">
              <label className="block text-[12px] font-medium text-ink-2 mb-1.5">
                Actual qty made <span className="text-ink-4 font-normal">({item.unit}) — required to complete</span>
              </label>
              <input
                type="number" min="0" step="0.1"
                className="w-full bg-paper border border-line rounded-[9px] px-3 py-2.5 text-[13px] text-ink placeholder:text-ink-3 focus:outline-none focus:border-ink-3 transition-colors tracking-[-0.005em]"
                placeholder={`e.g. ${item.suggestedQty.toFixed(1)}`}
                value={actualQty}
                onChange={e => setActualQty(e.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => updateStatus('IN_PROGRESS')} disabled={loading}
                className="flex items-center justify-center gap-1.5 px-3 py-2.5 text-[13px] font-medium border border-[#fcd34d] text-gold-2 bg-gold-soft rounded-[9px] hover:bg-[#fde9c8] transition-colors disabled:opacity-50">
                <Clock size={14} /> Start
              </button>
              <button onClick={() => updateStatus('DONE')} disabled={loading}
                className="flex items-center justify-center gap-1.5 px-3 py-2.5 text-[13px] font-medium bg-ink text-paper rounded-[9px] hover:bg-ink-2 transition-colors disabled:opacity-50">
                <CheckCircle size={14} className="text-green-400" /> Mark done
              </button>
              <button onClick={() => updateStatus('PARTIAL')} disabled={loading}
                className="px-3 py-2.5 text-[13px] font-medium border border-amber-200 text-amber-700 bg-amber-50 rounded-[9px] hover:bg-amber-100 transition-colors disabled:opacity-50">
                Partial
              </button>
              <button onClick={() => updateStatus('BLOCKED')} disabled={loading}
                className="px-3 py-2.5 text-[13px] font-medium border border-red-200 text-red-700 bg-red-50 rounded-[9px] hover:bg-red-100 transition-colors disabled:opacity-50">
                Blocked
              </button>
            </div>

            {warning && (
              <div className="mt-2 flex items-start gap-2 text-[12px] text-amber-700 bg-amber-50 border border-amber-200 rounded-[9px] p-2.5">
                <AlertCircle size={13} className="shrink-0 mt-0.5" /> {warning}
              </div>
            )}

            {item.todayLog?.inventoryAdjusted && (
              <div className="mt-2 flex items-center justify-between text-[12px] text-green-700 bg-green-50 border border-green-200 rounded-[9px] p-2.5">
                <span className="flex items-center gap-1.5"><CheckCircle size={12} /> Inventory updated</span>
                <button onClick={() => setShowRevert(v => !v)} className="underline hover:no-underline font-medium">
                  Correct qty
                </button>
              </div>
            )}

            {showRevert && (
              <div className="mt-2 p-3 bg-paper border border-line rounded-[10px] space-y-2">
                <p className="text-[12px] text-ink-2">Previous qty: <strong className="text-ink">{item.todayLog?.actualPrepQty} {item.unit}</strong>. Enter corrected qty:</p>
                <input type="number" min="0" step="0.1" value={newRevertQty}
                  onChange={e => setNewRevertQty(e.target.value)}
                  className="w-full bg-paper border border-line rounded-[8px] px-2.5 py-1.5 text-[13px] text-ink focus:outline-none focus:border-ink-3 transition-colors" />
                <button onClick={handleRevert} disabled={loading || !newRevertQty}
                  className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-[13px] font-medium bg-ink text-paper rounded-[9px] hover:bg-ink-2 transition-colors disabled:opacity-50">
                  <RotateCcw size={13} /> Revert &amp; reapply
                </button>
              </div>
            )}
          </div>

          {/* Inventory impact preview */}
          {item.linkedRecipe && actualQty && parseFloat(actualQty) > 0 && (
            <div className="bg-gold-soft border border-[#fcd34d] rounded-[10px] p-3 text-[12px] space-y-1">
              <div className="font-mono text-[10.5px] font-semibold text-gold-2 uppercase tracking-[0.02em] mb-1.5">Inventory impact when completed</div>
              {(detail?.ingredients ?? []).filter(i => i.inventoryItemId).map(ing => (
                <div key={ing.id} className="flex justify-between text-[#78350f] tabular-nums">
                  <span>− {(ing.qtyBase * scale).toFixed(2)} {ing.unit} {ing.itemName}</span>
                  <span className={ing.isAvailable === false ? 'text-red-600 font-medium' : ''}>
                    {ing.isAvailable === false ? '⚠ low stock' : ''}
                  </span>
                </div>
              ))}
              {item.linkedRecipe.baseYieldQty && (
                <div className="flex justify-between text-green-700 font-medium border-t border-[#fcd34d] pt-1.5 mt-1.5 tabular-nums">
                  <span>+ {(baseYield * scale).toFixed(2)} {yieldUnit} {item.linkedRecipe.name}</span>
                </div>
              )}
            </div>
          )}

          {/* Ingredient availability */}
          {detail?.ingredients && detail.ingredients.length > 0 && (
            <div>
              <div className="font-mono text-[10.5px] font-semibold text-ink-3 uppercase tracking-[0.04em] mb-2">Ingredients</div>
              <div className="space-y-0.5">
                {detail.ingredients.map(ing => (
                  <div key={ing.id} className="flex items-center justify-between text-[13px] py-1.5 border-b border-line last:border-0">
                    <span className="text-ink-2">{ing.itemName}</span>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-ink-3 text-[11px] tabular-nums">{ing.qtyBase.toFixed(2)} {ing.unit}</span>
                      {ing.isAvailable === true  && <span className="text-green-600 text-[12px]">✓</span>}
                      {ing.isAvailable === false && <span className="text-red-600 text-[11px] font-medium">✗ out</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Linked recipe */}
          {item.linkedRecipe && (
            <div className="flex items-center justify-between p-3 bg-paper border border-line rounded-[10px]">
              <div className="flex items-center gap-2 text-[13px]">
                <BookOpen size={14} className="text-ink-3" />
                <span className="text-ink-2">{item.linkedRecipe.name}</span>
              </div>
              <a href={`/recipes?item=${item.linkedRecipe.id}`} className="text-[12px] text-gold-2 hover:underline flex items-center gap-0.5 font-medium">
                Open recipe <ChevronRight size={12} />
              </a>
            </div>
          )}

          {/* 14-day history */}
          <div>
            <button
              onClick={() => setShowHistory(v => !v)}
              className="flex items-center gap-2 font-mono text-[10.5px] font-semibold text-ink-3 uppercase tracking-[0.04em] w-full"
            >
              <History size={13} />
              Recent history
              <span className="ml-auto text-ink-4 normal-case tracking-normal">{history.length} entries · {showHistory ? '▲' : '▼'}</span>
            </button>

            {showHistory && (
              <div className="mt-2 rounded-[10px] border border-line overflow-hidden">
                {history.length === 0 ? (
                  <p className="text-[12px] text-ink-4 text-center py-4">No activity in the last 14 days</p>
                ) : (
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="bg-bg-2 text-ink-3 font-mono">
                        <th className="text-left px-3 py-2 font-medium text-[10.5px] tracking-[0.02em]">DATE</th>
                        <th className="text-left px-3 py-2 font-medium text-[10.5px] tracking-[0.02em]">STATUS</th>
                        <th className="text-right px-3 py-2 font-medium text-[10.5px] tracking-[0.02em]">QTY MADE</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.map(log => {
                        const meta = STATUS_SHORT[log.status] ?? STATUS_SHORT.NOT_STARTED
                        return (
                          <tr key={log.id} className="border-t border-line">
                            <td className="px-3 py-2 text-ink-2">{fmtDate(log.logDate)}</td>
                            <td className="px-3 py-2">
                              <span className={`px-1.5 py-0.5 rounded-full ${meta.cls}`}>{meta.label}</span>
                            </td>
                            <td className="px-3 py-2 text-right text-ink-2 font-mono tabular-nums">
                              {log.actualPrepQty != null ? `${Number(log.actualPrepQty).toFixed(1)} ${item.unit}` : '—'}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>

          {/* Priority override */}
          <div>
            <div className="font-mono text-[10.5px] font-semibold text-ink-3 uppercase tracking-[0.04em] mb-2">Priority override</div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setPriorityOverride('')}
                className={`px-3 py-1 text-[12px] font-medium rounded-full border transition-colors ${!item.manualPriorityOverride ? 'bg-ink text-paper border-ink' : 'border-line text-ink-2 hover:border-ink-3'}`}
              >
                Auto
              </button>
              {PREP_PRIORITY_ORDER.map(p => (
                <button
                  key={p}
                  onClick={() => setPriorityOverride(p)}
                  className={`px-3 py-1 text-[12px] font-medium rounded-full border transition-colors ${item.manualPriorityOverride === p ? PREP_PRIORITY_META[p as PrepPriority].badgeClass + ' border-current' : 'border-line text-ink-2 hover:border-ink-3'}`}
                >
                  {PREP_PRIORITY_META[p as PrepPriority].label}
                </button>
              ))}
            </div>
          </div>

          {/* Notes */}
          {item.notes && (
            <div className="bg-gold-soft border border-[#fcd34d] rounded-[10px] p-3 text-[13px] text-[#78350f]">
              {item.notes}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="sticky bottom-0 bg-paper p-4 border-t border-line"
          style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))' }}
        >
          <button onClick={onEdit}
            className="w-full px-4 py-2.5 text-[13px] font-medium border border-line text-ink-2 rounded-[9px] hover:border-ink-3 transition-colors bg-paper">
            Edit prep settings
          </button>
        </div>
      </div>
    </div>
  )
}

```


---

## `src/components/prep/PrepItemForm.tsx`

```tsx
'use client'
import { useState, useEffect, useCallback } from 'react'
import { X } from 'lucide-react'
import { PREP_STATIONS, PREP_PRIORITY_META, PREP_PRIORITY_ORDER } from '@/lib/prep-utils'
import type { PrepItemRich } from './types'


interface Recipe { id: string; name: string; yieldUnit: string }

interface Props {
  item?: PrepItemRich | null
  onClose: () => void
  onSaved: () => void
}

const BLANK = {
  name: '', linkedRecipeId: '', linkedInventoryItemId: '',
  category: 'MISC', station: '',
  parLevel: '', unit: 'batch',
  targetToday: '', shelfLifeDays: '', estimatedPrepTime: '', notes: '',
  manualPriorityOverride: '',
}

type TimeUnit = 'min' | 'hr' | 'day'

// Convert stored minutes to display value + best unit
function minutesToDisplay(minutes: number): { value: string; unit: TimeUnit } {
  if (minutes >= 1440 && minutes % 1440 === 0) return { value: String(minutes / 1440), unit: 'day' }
  if (minutes >= 60   && minutes % 60   === 0) return { value: String(minutes / 60),   unit: 'hr'  }
  return { value: String(minutes), unit: 'min' }
}

const TIME_UNIT_TO_MINUTES: Record<TimeUnit, number> = { min: 1, hr: 60, day: 1440 }

export function PrepItemForm({ item, onClose, onSaved }: Props) {
  const [form, setForm]           = useState(BLANK)
  const [prepTimeUnit, setPrepTimeUnit] = useState<TimeUnit>('min')
  const [recipes, setRecipes]     = useState<Recipe[]>([])
  const [saving, setSaving]       = useState(false)
  const [error, setError]         = useState<string | null>(null)
  const [stations, setStations] = useState<string[]>(PREP_STATIONS)

  useEffect(() => {
    fetch('/api/recipes?type=PREP&isActive=true')
      .then(r => r.json())
      .then((data: Recipe[]) => setRecipes(Array.isArray(data) ? data : []))
  }, [])

  useEffect(() => {
    fetch('/api/prep/settings')
      .then(r => { if (!r.ok) throw new Error(); return r.json() })
      .then(data => {
        if (Array.isArray(data.stations)) setStations(data.stations)
      })
      .catch(() => { /* keep defaults on error */ })
  }, [])

  useEffect(() => {
    if (item) {
      setForm({
        name:                  item.name,
        linkedRecipeId:        item.linkedRecipeId        ?? '',
        linkedInventoryItemId: item.linkedInventoryItemId ?? '',
        category:              item.category,
        station:               item.station               ?? '',
        parLevel:              String(item.parLevel),
        unit:                  item.unit,
        targetToday:           item.targetToday != null ? String(item.targetToday) : '',
        shelfLifeDays:         item.shelfLifeDays != null ? String(item.shelfLifeDays) : '',
        estimatedPrepTime:     item.estimatedPrepTime != null ? (() => { const d = minutesToDisplay(item.estimatedPrepTime!); setPrepTimeUnit(d.unit); return d.value })() : '',
        notes:                 item.notes                ?? '',
        manualPriorityOverride: item.manualPriorityOverride ?? '',
      })
    }
  }, [item])

  const set = useCallback((k: keyof typeof BLANK, v: string) => {
    setForm(prev => ({ ...prev, [k]: v }))
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim()) { setError('Name is required'); return }
    setSaving(true)
    setError(null)

    const payload = {
      name:                  form.name.trim(),
      linkedRecipeId:        form.linkedRecipeId        || null,
      linkedInventoryItemId: form.linkedInventoryItemId || null,
      category:              form.category,
      station:               form.station               || null,
      parLevel:              form.parLevel    ? parseFloat(form.parLevel)    : 0,
      unit:                  form.unit,
      targetToday:           form.targetToday  ? parseFloat(form.targetToday)  : null,
      shelfLifeDays:         form.shelfLifeDays ? parseInt(form.shelfLifeDays, 10) : null,
      estimatedPrepTime:     form.estimatedPrepTime ? Math.round(parseFloat(form.estimatedPrepTime) * TIME_UNIT_TO_MINUTES[prepTimeUnit]) : null,
      notes:                 form.notes || null,
      manualPriorityOverride: form.manualPriorityOverride || null,
    }

    const url    = item ? `/api/prep/items/${item.id}` : '/api/prep/items'
    const method = item ? 'PUT' : 'POST'
    const res    = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    if (res.ok) { onSaved(); onClose() }
    else {
      const data = await res.json().catch(() => ({}))
      setError(data.error ?? 'Failed to save')
    }
    setSaving(false)
  }

  const field = (label: string, children: React.ReactNode) => (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      {children}
    </div>
  )
  const inputCls = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold'
  const selCls   = inputCls + ' bg-white'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-gray-100 shrink-0">
          <h2 className="font-semibold text-gray-900">{item ? 'Edit Prep Item' : 'New Prep Item'}</h2>
          <button onClick={onClose} className="p-2.5 flex items-center justify-center text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
          <div className="p-5 space-y-4 flex-1 overflow-y-auto">
          {field('Name *', (
            <input className={inputCls} value={form.name}
              onChange={e => set('name', e.target.value)} placeholder="e.g. Smoked Brisket" required />
          ))}

          {field('Linked Recipe (optional)', (
            <select className={selCls} value={form.linkedRecipeId}
              onChange={e => set('linkedRecipeId', e.target.value)}>
              <option value="">— None —</option>
              {recipes.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          ))}

          {field('Station', (
            <select className={selCls} value={form.station} onChange={e => set('station', e.target.value)}>
              <option value="">— None —</option>
              {stations.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          ))}

          <div className="grid grid-cols-2 gap-3">
            {field('Par Level', (
              <input className={inputCls} type="number" min="0" step="0.1"
                value={form.parLevel} onChange={e => set('parLevel', e.target.value)} placeholder="0" />
            ))}
            {field('Unit', (
              <select className={inputCls + ' bg-white'} value={form.unit} onChange={e => set('unit', e.target.value)}>
                {['batch', 'portion', 'serve', 'each', 'pkg', 'tray', 'kg', 'g', 'lb', 'oz', 'l', 'ml'].map(u => <option key={u}>{u}</option>)}
              </select>
            ))}
          </div>

          <div className="grid grid-cols-3 gap-3">
            {field('Target Today (optional)', (
              <input className={inputCls} type="number" min="0" step="0.1"
                value={form.targetToday} onChange={e => set('targetToday', e.target.value)} placeholder="—" />
            ))}
            {field('Shelf Life (days)', (
              <input className={inputCls} type="number" min="0" step="1"
                value={form.shelfLifeDays} onChange={e => set('shelfLifeDays', e.target.value)} placeholder="—" />
            ))}
            {field('Prep Time', (
              <div className="flex gap-1">
                <input className={inputCls + ' flex-1 min-w-0'} type="number" min="0" step="0.5"
                  value={form.estimatedPrepTime} onChange={e => set('estimatedPrepTime', e.target.value)} placeholder="—" />
                <select
                  className="border border-gray-300 rounded-lg px-2 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gold shrink-0"
                  value={prepTimeUnit}
                  onChange={e => setPrepTimeUnit(e.target.value as TimeUnit)}
                >
                  <option value="min">min</option>
                  <option value="hr">hr</option>
                  <option value="day">day</option>
                </select>
              </div>
            ))}
          </div>

          {field('Manual Priority Override', (
            <select className={selCls} value={form.manualPriorityOverride}
              onChange={e => set('manualPriorityOverride', e.target.value)}>
              <option value="">— Auto (system decides) —</option>
              {PREP_PRIORITY_ORDER.map(p => (
                <option key={p} value={p}>{PREP_PRIORITY_META[p].label}</option>
              ))}
            </select>
          ))}

          {field('Notes', (
            <textarea className={inputCls} rows={2} value={form.notes}
              onChange={e => set('notes', e.target.value)} placeholder="Chef notes..." />
          ))}

          {error && <p className="text-sm text-red-600">{error}</p>}
          </div>

          <div className="flex justify-end gap-2 p-5 border-t border-gray-100 shrink-0">
            <button type="button" onClick={onClose}
              className="px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50">
              Cancel
            </button>
            <button type="submit" disabled={saving}
              className="px-4 py-2 text-sm bg-gold text-white rounded-lg hover:bg-[#a88930] disabled:opacity-50">
              {saving ? 'Saving…' : item ? 'Save Changes' : 'Create Prep Item'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

```


---

## `src/components/prep/PrepItemRow.tsx`

```tsx
'use client'
import { useState, useRef, useEffect } from 'react'
import { X, Check, BookOpen, Play, RotateCcw } from 'lucide-react'
import { PREP_PRIORITY_META } from '@/lib/prep-utils'
import type { PrepItemRich } from './types'
import { RecipeViewModal } from './RecipeViewModal'

interface Props {
  item: PrepItemRich
  onClick: () => void
  onStatusChange: (itemId: string, status: string, actualQty?: number) => void
  onPriorityChange: (itemId: string, priority: string) => void
  onDelete: (itemId: string) => void
  onToggleOnList?: (itemId: string, newValue: boolean) => void
  showReason?: boolean
}

// Priority frames: left border accent + subtle bg tint
const PRIORITY_FRAME: Record<string, { border: string; bg: string }> = {
  '911':          { border: 'border-l-[4px] border-l-red-500',    bg: 'bg-red-50/30'    },
  'NEEDED_TODAY': { border: 'border-l-[4px] border-l-orange-400', bg: 'bg-orange-50/20' },
  'LATER':        { border: 'border-l-[4px] border-l-gray-200',   bg: ''                },
}

const PRIORITY_BADGE: Record<string, string> = {
  '911':          'bg-red-100 text-red-700',
  'NEEDED_TODAY': 'bg-orange-100 text-orange-700',
  'LATER':        'bg-gray-100 text-gray-600',
}

const PRIORITY_LABEL: Record<string, string> = {
  '911':          'Critical',
  'NEEDED_TODAY': 'Needed Today',
  'LATER':        'Later',
}

const PRIORITY_SUGGEST_COLOR: Record<string, string> = {
  '911':          'text-red-600',
  'NEEDED_TODAY': 'text-orange-600',
  'LATER':        'text-green-600',
}

const PRIORITY_BAR_COLOR: Record<string, string> = {
  '911':          'bg-red-400',
  'NEEDED_TODAY': 'bg-orange-400',
  'LATER':        'bg-green-400',
}

export function PrepItemRow({ item, onClick, onStatusChange, onPriorityChange, onDelete, onToggleOnList }: Props) {
  const [confirmingDone, setConfirmingDone] = useState(false)
  const [confirmQty, setConfirmQty]         = useState('')
  const [pendingStatus, setPendingStatus]   = useState<'DONE' | 'PARTIAL'>('DONE')
  const [showRecipe, setShowRecipe]         = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const currentStatus = item.todayLog?.status ?? 'NOT_STARTED'
  const isDone        = currentStatus === 'DONE'
  const isPartial     = currentStatus === 'PARTIAL'
  const isCompleted   = isDone || isPartial
  const isSkipped     = currentStatus === 'SKIPPED'
  const isInProgress  = currentStatus === 'IN_PROGRESS'
  const isBlocked     = currentStatus === 'BLOCKED'

  const priority  = PREP_PRIORITY_META[item.priority]
  const frame     = PRIORITY_FRAME[item.priority] ?? { border: 'border-l-[4px] border-l-transparent', bg: '' }
  const stockPct  = item.parLevel > 0 ? Math.min(100, (item.onHand / item.parLevel) * 100) : 100
  const fmtQty    = (n: number) => n % 1 === 0 ? n.toFixed(0) : n.toFixed(1)

  useEffect(() => {
    if (confirmingDone && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [confirmingDone])

  function openDonePrompt(status: 'DONE' | 'PARTIAL') {
    setPendingStatus(status)
    setConfirmQty(item.suggestedQty > 0 ? item.suggestedQty.toFixed(1) : '')
    setConfirmingDone(true)
  }

  function handleConfirm() {
    const parsed = parseFloat(confirmQty)
    const qty = !isNaN(parsed) && parsed > 0 ? parsed : undefined
    onStatusChange(item.id, pendingStatus, qty)
    setConfirmingDone(false)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') setConfirmingDone(false)
    if (e.key === 'Enter')  handleConfirm()
  }

  // ── Qty entry prompt ──────────────────────────────────────────────────────
  if (confirmingDone) {
    const promptFrame = isDone || pendingStatus === 'DONE'
      ? 'border-l-[4px] border-l-green-500 bg-green-50/30'
      : 'border-l-[4px] border-l-amber-400 bg-amber-50/30'
    return (
      <div className={`px-3 py-3 border-b border-gray-50 ${promptFrame}`}>
        <p className="text-xs text-gray-500 mb-2">
          {pendingStatus === 'DONE' ? 'How much did you make?' : 'How much was partial?'}{' '}
          <span className="text-gray-400">({item.unit})</span>
        </p>
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="number"
            min="0"
            step="0.1"
            value={confirmQty}
            onChange={e => setConfirmQty(e.target.value)}
            onKeyDown={handleKeyDown}
            className="h-9 w-28 rounded-lg border border-gray-300 px-3 text-sm text-center focus:outline-none focus:ring-2 focus:ring-gold"
            placeholder={item.unit}
          />
          <button
            onClick={handleConfirm}
            className={`h-9 px-4 rounded-lg text-white text-sm font-semibold transition-colors ${
              pendingStatus === 'DONE' ? 'bg-green-600 hover:bg-green-700' : 'bg-amber-500 hover:bg-amber-600'
            }`}
          >
            {pendingStatus === 'DONE' ? '✓ Done' : '◐ Partial'}
          </button>
          <button
            onClick={() => setConfirmingDone(false)}
            className="h-9 px-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    )
  }

  // ── Skipped row ──────────────────────────────────────────────────────────
  if (isSkipped) {
    return (
      <div className="border-l-[4px] border-l-gray-200 border-b border-gray-50 opacity-50 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-400 flex-1 line-through truncate">{item.name}</span>
          <span className="text-[10px] text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full shrink-0">Removed</span>
        </div>
        <button
          onClick={() => onStatusChange(item.id, 'NOT_STARTED')}
          className="mt-1.5 text-xs text-gray-500 border border-gray-200 hover:bg-gray-100 px-3 py-1 rounded-lg transition-colors"
        >
          ↩ Restore to list
        </button>
      </div>
    )
  }

  // ── Completed row (Done / Partial) ──────────────────────────────────────
  if (isCompleted) {
    const completedFrame = isDone
      ? 'border-l-[4px] border-l-green-500 bg-green-50/40'
      : 'border-l-[4px] border-l-amber-400 bg-amber-50/40'
    return (
      <>
        <div className={`${completedFrame} border-b border-gray-50 px-3 py-2.5 opacity-70`}>
          <div className="flex items-center gap-2">
            <span className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${isDone ? 'bg-green-600' : 'bg-amber-500'}`}>
              {isDone
                ? <Check size={11} strokeWidth={3} className="text-white" />
                : <span className="text-white text-[10px] font-bold leading-none">◐</span>
              }
            </span>
            <span className={`text-sm font-semibold flex-1 line-through truncate cursor-pointer ${isDone ? 'text-green-900' : 'text-amber-900'}`} onClick={onClick}>
              {item.name}
            </span>
            <span className={`text-xs font-semibold shrink-0 ${isDone ? 'text-green-700' : 'text-amber-700'}`}>
              {isDone ? 'Done' : 'Partial'}
              {item.todayLog?.actualPrepQty != null && (
                <span className="font-normal ml-1">— {item.todayLog.actualPrepQty} {item.unit}</span>
              )}
            </span>
          </div>
          <div className="pl-7 mt-1 flex items-center gap-2">
            <span className={`text-xs ${isDone ? 'text-green-600' : 'text-amber-600'}`}>
              {isDone ? 'Completed this session' : 'Partially completed'}
            </span>
            <button
              onClick={() => onStatusChange(item.id, 'NOT_STARTED')}
              className={`text-xs border px-2.5 py-0.5 rounded-lg transition-colors flex items-center gap-1 ${
                isDone
                  ? 'text-green-600 border-green-200 hover:bg-green-100'
                  : 'text-amber-600 border-amber-200 hover:bg-amber-100'
              }`}
            >
              <RotateCcw size={10} /> Reset
            </button>
          </div>
        </div>
        {showRecipe && item.linkedRecipeId && (
          <RecipeViewModal
            recipeId={item.linkedRecipeId}
            recipeName={item.name}
            suggestedQty={item.suggestedQty > 0 ? item.suggestedQty : undefined}
            yieldUnit={item.unit}
            baseYieldQty={item.linkedRecipe?.baseYieldQty}
            checkedIngredients={new Set()}
            onToggleIngredient={() => {}}
            onClose={() => setShowRecipe(false)}
          />
        )}
      </>
    )
  }

  // ── Blocked row ──────────────────────────────────────────────────────────
  if (isBlocked) {
    return (
      <div className="border-l-[4px] border-l-red-500 bg-red-50/30 border-b border-gray-50 px-3 py-2.5">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-700 shrink-0">Blocked</span>
          <span className="text-sm font-semibold text-gray-800 flex-1 truncate cursor-pointer" onClick={onClick}>{item.name}</span>
        </div>
        {item.blockedReason && <p className="text-xs text-red-600 mb-2">{item.blockedReason}</p>}
        <button
          onClick={() => onStatusChange(item.id, 'IN_PROGRESS')}
          className="text-xs font-medium bg-gold/10 text-gold border border-gold/30 hover:bg-gold/15 px-3 py-1.5 rounded-lg flex items-center gap-1 transition-colors"
        >
          <Play size={10} fill="currentColor" /> Resume
        </button>
      </div>
    )
  }

  // ── Active row (NOT_STARTED / IN_PROGRESS) ──────────────────────────────
  const suggestColor  = PRIORITY_SUGGEST_COLOR[item.priority] ?? 'text-gray-500'
  const barColor      = PRIORITY_BAR_COLOR[item.priority] ?? 'bg-gray-300'
  const badgeClass    = PRIORITY_BADGE[item.priority] ?? 'bg-gray-100 text-gray-600'
  const priorityLabel = item.manualPriorityOverride
    ? PRIORITY_LABEL[item.priority] ?? item.priority
    : PRIORITY_LABEL[item.priority] ?? item.priority

  const suggestionText = item.priority !== 'LATER'
    ? item.suggestedQty > 0
      ? `Make ${fmtQty(item.suggestedQty)} ${item.unit}${item.priority === '911' ? ' — stock depleted' : ' — below par'}`
      : 'Review stock levels'
    : 'At or above par — looking good'

  return (
    <>
      <div className={`${frame.border} ${frame.bg} border-b border-gray-50 px-3 py-2.5`}>
        {/* Header: priority badge + name + status indicator */}
        <div className="flex items-center gap-2 mb-1.5">
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${badgeClass}`}>
            {priorityLabel}
          </span>
          <button onClick={onClick} className="flex-1 min-w-0 text-left hover:opacity-80 transition-opacity">
            <span className="text-sm font-semibold text-gray-800 truncate block">
              {item.name}
              {item.manualPriorityOverride && (
                <span className="ml-1.5 text-[10px] text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded-full font-medium not-italic">✎</span>
              )}
            </span>
          </button>

          {/* Status chip */}
          {isInProgress ? (
            <span className="text-[10px] font-semibold text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full flex items-center gap-1 shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse inline-block" />
              In Progress
            </span>
          ) : (
            <span className="text-[10px] text-gray-400 shrink-0">Not started</span>
          )}

          {/* Recipe icon */}
          {item.linkedRecipeId && (
            <button
              onClick={e => { e.stopPropagation(); setShowRecipe(true) }}
              className="shrink-0 p-1 text-gray-400 hover:text-gold hover:bg-gold/10 rounded-lg transition-colors"
              title="View recipe"
            >
              <BookOpen size={13} />
            </button>
          )}
        </div>

        {/* Stock bar + qty */}
        {item.parLevel > 0 && (
          <div className="flex items-center gap-2 mb-1">
            <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div className={`h-full ${barColor} rounded-full transition-all`} style={{ width: `${stockPct}%` }} />
            </div>
            <span className="text-[11px] text-gray-500 shrink-0 font-medium tabular-nums">
              {fmtQty(item.onHand)} / {fmtQty(item.parLevel)} {item.unit}
            </span>
          </div>
        )}

        {/* Suggestion text */}
        {item.manualPriorityOverride ? (
          <p className={`text-xs mb-2 line-through text-gray-400`}>
            {item.suggestedQty > 0 ? `System → Make ${fmtQty(item.suggestedQty)} ${item.unit}` : 'System → review stock'}
          </p>
        ) : (
          <p className={`text-xs font-medium mb-2 ${item.priority !== 'LATER' ? suggestColor : 'text-green-600'}`}>
            {suggestionText}
          </p>
        )}

        {/* Action buttons */}
        <div className="flex gap-1.5" onClick={e => e.stopPropagation()}>
          {currentStatus === 'NOT_STARTED' && (
            <>
              <button
                onClick={() => onStatusChange(item.id, 'IN_PROGRESS')}
                className="btn-action flex-1 py-1.5 rounded-lg text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100 transition-colors flex items-center justify-center gap-1"
              >
                <Play size={10} fill="currentColor" /> Start
              </button>
              <button
                onClick={() => openDonePrompt('DONE')}
                className="btn-action flex-1 py-1.5 rounded-lg text-xs font-semibold bg-green-50 text-green-700 border border-green-200 hover:bg-green-100 transition-colors flex items-center justify-center gap-1"
              >
                <Check size={10} strokeWidth={3} /> Done
              </button>
              <button
                onClick={() => onStatusChange(item.id, 'SKIPPED')}
                className="btn-action px-3 py-1.5 rounded-lg text-xs text-gray-400 border border-gray-200 hover:bg-gray-50 transition-colors"
                title="Remove from today's list"
              >
                Skip
              </button>
            </>
          )}

          {isInProgress && (
            <>
              <button
                onClick={() => openDonePrompt('DONE')}
                className="btn-action flex-1 py-1.5 rounded-lg text-xs font-semibold bg-green-50 text-green-700 border border-green-200 hover:bg-green-100 transition-colors flex items-center justify-center gap-1"
              >
                <Check size={10} strokeWidth={3} /> Done
              </button>
              <button
                onClick={() => openDonePrompt('PARTIAL')}
                className="btn-action flex-1 py-1.5 rounded-lg text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100 transition-colors"
              >
                ◐ Partial
              </button>
              <button
                onClick={() => onStatusChange(item.id, 'SKIPPED')}
                className="btn-action px-3 py-1.5 rounded-lg text-xs text-gray-400 border border-gray-200 hover:bg-gray-50 transition-colors"
                title="Remove from today's list"
              >
                Skip
              </button>
            </>
          )}
        </div>
      </div>

      {showRecipe && item.linkedRecipeId && (
        <RecipeViewModal
          recipeId={item.linkedRecipeId}
          recipeName={item.name}
          suggestedQty={item.suggestedQty > 0 ? item.suggestedQty : undefined}
          yieldUnit={item.unit}
          baseYieldQty={item.linkedRecipe?.baseYieldQty}
          checkedIngredients={new Set()}
          onToggleIngredient={() => {}}
          onClose={() => setShowRecipe(false)}
        />
      )}
    </>
  )
}

```


---

## `src/components/prep/PrepSettingsModal.tsx`

```tsx
'use client'
import { useState, useEffect } from 'react'
import { X, Plus, Trash2 } from 'lucide-react'

// ── ListEditor lives at module scope so its reference is stable across renders ──
// Defining it inside PrepSettingsModal would cause React to remount it on every
// parent state change (e.g. every keystroke), losing input focus.
function ListEditor({
  label,
  items,
  onUpdate,
  onRemove,
  newValue,
  onNewValueChange,
  onAdd,
  addPlaceholder,
}: {
  label: string
  items: string[]
  onUpdate: (idx: number, val: string) => void
  onRemove: (idx: number) => void
  newValue: string
  onNewValueChange: (v: string) => void
  onAdd: () => void
  addPlaceholder: string
}) {
  const inputCls = 'border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold w-full'
  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-700 mb-2">{label}</h3>
      <div className="space-y-1.5 mb-3">
        {items.map((item, idx) => (
          <div key={idx} className="flex items-center gap-2">
            <input
              className={inputCls}
              value={item}
              onChange={e => onUpdate(idx, e.target.value)}
              onBlur={e => onUpdate(idx, e.target.value.trim())}
            />
            <button
              type="button"
              onClick={() => onRemove(idx)}
              disabled={items.length <= 1}
              className="shrink-0 p-1.5 text-gray-400 hover:text-red-500 disabled:opacity-30 disabled:cursor-not-allowed"
              aria-label="Remove"
              title="Remove"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <input
          className={inputCls}
          value={newValue}
          onChange={e => onNewValueChange(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onAdd() } }}
          placeholder={addPlaceholder}
        />
        <button
          type="button"
          onClick={onAdd}
          disabled={!newValue.trim()}
          className="shrink-0 p-1.5 text-gold hover:text-gold disabled:opacity-30 disabled:cursor-not-allowed"
          aria-label="Add"
          title="Add"
        >
          <Plus size={16} />
        </button>
      </div>
    </div>
  )
}

interface Props {
  onClose: () => void
  onSaved: () => void
}

export function PrepSettingsModal({ onClose, onSaved }: Props) {
  const [stations,   setStations]   = useState<string[]>([])
  const [newStation,  setNewStation]  = useState('')
  const [saving,  setSaving]  = useState(false)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/prep/settings', { signal: controller.signal })
      .then(r => {
        if (!r.ok) throw new Error('Settings fetch failed')
        return r.json()
      })
      .then(data => {
        // Filter out any empty strings that may have crept into the DB
        setStations((data.stations ?? []).filter((s: string) => s.trim() !== ''))
        setLoading(false)
      })
      .catch(err => {
        if (err.name === 'AbortError') return
        setError('Failed to load settings')
        setLoading(false)
      })
    return () => controller.abort()
  }, [])

  async function handleSave() {
    if (stations.length === 0) {
      setError('Stations list must have at least one entry.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/prep/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stations: stations.map(s => s.trim()).filter(Boolean),
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data.error ?? 'Failed to save')
      } else {
        onSaved()
        onClose()
      }
    } catch {
      setError('Network error — try again.')
    } finally {
      setSaving(false)
    }
  }

  function addStation() {
    const v = newStation.trim()
    if (!v || stations.includes(v)) return
    setStations(prev => [...prev, v])
    setNewStation('')
  }

  function removeStation(idx: number) {
    setStations(prev => prev.filter((_, i) => i !== idx))
  }

  function updateStation(idx: number, val: string) {
    setStations(prev => prev.map((s, i) => i === idx ? val : s))
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="prep-settings-title"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-gray-100 shrink-0">
          <div>
            <h2 id="prep-settings-title" className="font-semibold text-gray-900">Prep Settings</h2>
            <p className="text-xs text-gray-400 mt-0.5">Categories come from Recipe Book — only stations are configurable here.</p>
          </div>
          <button onClick={onClose} disabled={saving} aria-label="Close" className="p-2.5 flex items-center justify-center text-gray-400 hover:text-gray-600 disabled:opacity-50">
            <X size={18} />
          </button>
        </div>

        {loading ? (
          <div className="flex justify-center py-12">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-gold" />
          </div>
        ) : (
          <>
            <div className="p-5 space-y-6 flex-1 overflow-y-auto">
              <ListEditor
                label="Stations"
                items={stations}
                onUpdate={updateStation}
                onRemove={removeStation}
                newValue={newStation}
                onNewValueChange={setNewStation}
                onAdd={addStation}
                addPlaceholder="Add station…"
              />

              {error && <p className="text-sm text-red-600">{error}</p>}
            </div>

            <div className="flex justify-end gap-2 p-5 border-t border-gray-100 shrink-0">
              <button type="button" onClick={onClose} disabled={saving}
                className="px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50">
                Cancel
              </button>
              <button type="button" onClick={handleSave} disabled={saving}
                className="px-4 py-2 text-sm bg-gold text-white rounded-lg hover:bg-[#a88930] disabled:opacity-50">
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

```


---

## `src/components/prep/RecipeViewModal.tsx`

```tsx
'use client'
/**
 * RecipeViewModal — read-only recipe card opened from the prep list.
 * Shows all ingredients scaled by a user-controlled multiplier.
 */
import { useEffect, useState } from 'react'
import { X, Minus, Plus, ChefHat, AlertTriangle } from 'lucide-react'

interface Ingredient {
  id: string
  sortOrder: number
  ingredientName: string
  qtyBase: number
  unit: string
  lineCost: number
  notes: string | null
}

interface Recipe {
  id: string
  name: string
  baseYieldQty: number
  yieldUnit: string
  notes: string | null
  allergens: string[]
  totalCost: number
  ingredients: Ingredient[]
}

interface Props {
  recipeId: string
  recipeName: string
  /** Suggested qty from the prep log — used to pre-fill the scale */
  suggestedQty?: number
  yieldUnit?: string
  baseYieldQty?: number
  checkedIngredients: Set<string>
  onToggleIngredient: (id: string) => void
  onClose: () => void
}

export function RecipeViewModal({ recipeId, recipeName, suggestedQty, yieldUnit, baseYieldQty, checkedIngredients, onToggleIngredient, onClose }: Props) {
  const [recipe, setRecipe] = useState<Recipe | null>(null)
  const [loading, setLoading] = useState(true)
  const [scale, setScale] = useState(1)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/recipes/${recipeId}`)
      .then(r => r.json())
      .then((data: Recipe) => {
        setRecipe(data)
        // Pre-fill scale from suggested qty if available
        if (suggestedQty && data.baseYieldQty > 0) {
          const s = Math.max(0.5, Math.round((suggestedQty / data.baseYieldQty) * 2) / 2)
          setScale(s)
        }
      })
      .finally(() => setLoading(false))
  }, [recipeId, suggestedQty])

  const dec = () => setScale(s => Math.max(0.5, Math.round((s - 0.5) * 10) / 10))
  const inc = () => setScale(s => Math.min(20, Math.round((s + 0.5) * 10) / 10))

  const scaledYield = recipe ? (recipe.baseYieldQty * scale) : 0
  const unit = recipe?.yieldUnit ?? yieldUnit ?? ''

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      {/* Sheet */}
      <div className="relative z-10 bg-white w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl flex flex-col max-h-[90dvh] shadow-2xl">

        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-4 border-b border-gray-100">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <ChefHat size={16} className="text-gold shrink-0" />
              <h2 className="text-base font-bold text-gray-900 truncate">{recipe?.name ?? recipeName}</h2>
            </div>
            {recipe && (
              <p className="text-xs text-gray-500">
                Base yield: {recipe.baseYieldQty} {recipe.yieldUnit}
                {recipe.totalCost > 0 && (
                  <span className="ml-2 text-gray-400">· ${recipe.totalCost.toFixed(2)} per batch</span>
                )}
              </p>
            )}
          </div>
          <button onClick={onClose} className="shrink-0 p-2.5 flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg">
            <X size={18} />
          </button>
        </div>

        {/* Scale control */}
        <div className="px-5 py-3 bg-gold/10 border-b border-blue-100 flex items-center gap-4">
          <span className="text-xs font-semibold text-gold uppercase tracking-wide">Making</span>
          <div className="flex items-center gap-2 flex-1">
            <button
              onClick={dec}
              disabled={scale <= 0.5}
              className="w-8 h-8 rounded-full border border-gold/30 bg-white flex items-center justify-center text-gold hover:bg-gold/15 disabled:opacity-40 transition-colors"
            >
              <Minus size={14} />
            </button>

            {/* Slider */}
            <input
              type="range"
              min={0.5}
              max={10}
              step={0.5}
              value={scale}
              onChange={e => setScale(parseFloat(e.target.value))}
              className="flex-1 accent-blue-600"
            />

            <button
              onClick={inc}
              disabled={scale >= 20}
              className="w-8 h-8 rounded-full border border-gold/30 bg-white flex items-center justify-center text-gold hover:bg-gold/15 disabled:opacity-40 transition-colors"
            >
              <Plus size={14} />
            </button>
          </div>
          <div className="text-right shrink-0">
            <div className="text-sm font-bold text-gold">
              {scaledYield % 1 === 0 ? scaledYield.toFixed(0) : scaledYield.toFixed(1)} {unit}
            </div>
            <div className="text-xs text-blue-500">×{scale}</div>
          </div>
        </div>

        {/* Ingredients */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-12">
              <div className="w-8 h-8 rounded-full border-2 border-gold/30 border-t-blue-600 animate-spin" />
            </div>
          ) : recipe ? (
            <>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100">
                    <th className="w-8 px-3 py-2" />
                    <th className="text-left px-2 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">Ingredient</th>
                    <th className="text-right px-5 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {recipe.ingredients.map(ing => {
                    const scaledQty = ing.qtyBase * scale
                    const checked = checkedIngredients.has(ing.id)
                    return (
                      <tr
                        key={ing.id}
                        className={`transition-colors cursor-pointer ${checked ? 'bg-green-50/60' : 'hover:bg-gray-50/50'}`}
                        onClick={() => onToggleIngredient(ing.id)}
                      >
                        <td className="px-3 py-2.5">
                          <div className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${checked ? 'bg-green-500 border-green-500' : 'border-gray-300'}`}>
                            {checked && (
                              <svg viewBox="0 0 12 12" className="w-3 h-3 text-white" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="1.5,6 4.5,9 10.5,3" />
                              </svg>
                            )}
                          </div>
                        </td>
                        <td className="px-2 py-2.5">
                          <div className={`font-medium transition-colors ${checked ? 'text-gray-400 line-through' : 'text-gray-800'}`}>{ing.ingredientName}</div>
                          {ing.notes && <div className="text-xs text-amber-600 mt-0.5">{ing.notes}</div>}
                        </td>
                        <td className="px-5 py-2.5 text-right">
                          <span className={`font-semibold transition-colors ${checked ? 'text-gray-400' : 'text-gray-900'}`}>
                            {scaledQty % 1 === 0 ? scaledQty.toFixed(0) : scaledQty.toFixed(2).replace(/\.?0+$/, '')}
                          </span>
                          <span className="text-gray-500 ml-1">{ing.unit}</span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>

              {/* Cost summary */}
              {recipe.totalCost > 0 && (
                <div className="px-5 py-3 border-t border-gray-100 flex justify-between text-sm">
                  <span className="text-gray-500">Batch cost</span>
                  <span className="font-semibold text-gray-700">${(recipe.totalCost * scale).toFixed(2)}</span>
                </div>
              )}

              {/* Allergens */}
              {recipe.allergens.length > 0 && (
                <div className="px-5 py-3 border-t border-amber-100 bg-amber-50 flex items-start gap-2">
                  <AlertTriangle size={14} className="text-amber-500 mt-0.5 shrink-0" />
                  <div>
                    <span className="text-xs font-semibold text-amber-700">Allergens: </span>
                    <span className="text-xs text-amber-600">{recipe.allergens.join(', ')}</span>
                  </div>
                </div>
              )}

              {/* Notes */}
              {recipe.notes && (
                <div className="px-5 py-3 border-t border-gray-100">
                  <p className="text-xs text-gray-500 font-semibold uppercase tracking-wide mb-1">Notes</p>
                  <p className="text-sm text-gray-700 whitespace-pre-wrap">{recipe.notes}</p>
                </div>
              )}
            </>
          ) : (
            <div className="flex items-center justify-center py-12 text-gray-400 text-sm">Recipe not found</div>
          )}
        </div>
      </div>
    </div>
  )
}

```


---

## `src/components/prep/types.ts`

```ts
import type { PrepPriority } from '@/lib/prep-utils'

export type { PrepPriority }

export type PrepStatus =
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  | 'DONE'
  | 'PARTIAL'
  | 'BLOCKED'
  | 'SKIPPED'

export interface PrepLogData {
  id: string
  prepItemId: string
  logDate: string
  status: PrepStatus
  requiredQty: number | null
  actualPrepQty: number | null
  assignedTo: string | null
  dueTime: string | null
  note: string | null
  blockedReason: string | null
  inventoryAdjusted: boolean
  createdAt: string
  updatedAt: string
}

export interface PrepItemRich {
  id: string
  name: string
  category: string
  station: string | null
  parLevel: number
  unit: string
  minThreshold: number
  targetToday: number | null
  shelfLifeDays: number | null
  estimatedPrepTime: number | null
  notes: string | null
  manualPriorityOverride: string | null
  isActive: boolean
  isOnList: boolean
  linkedRecipeId: string | null
  linkedRecipe: {
    id: string
    name: string
    yieldUnit: string
    baseYieldQty: number
  } | null
  linkedInventoryItemId: string | null
  onHand: number
  priority: PrepPriority
  suggestedQty: number
  isBlocked: boolean
  blockedReason: string | null
  todayLog: PrepLogData | null
  createdAt: string
  updatedAt: string
}

export interface IngredientAvailability {
  id: string
  inventoryItemId: string | null
  itemName: string
  qtyBase: number
  unit: string
  stockOnHand: number | null
  isAvailable: boolean | null
}

export interface PrepItemDetail extends PrepItemRich {
  ingredients: IngredientAvailability[]
}

```


---

## `src/components/suppliers/SupplierList.tsx`

```tsx
'use client'
import { useState } from 'react'
import { SupplierSummary } from './types'
import { formatCurrency } from '@/lib/utils'

interface Props {
  suppliers: SupplierSummary[]
  selectedId: string | null
  onSelect: (id: string) => void
  onAdd: () => void
}

export function SupplierList({ suppliers, selectedId, onSelect, onAdd }: Props) {
  const [search, setSearch] = useState('')

  const filtered = suppliers.filter(s => {
    const q = search.toLowerCase()
    return (
      s.name.toLowerCase().includes(q) ||
      s.aliases?.some(a => a.name.toLowerCase().includes(q))
    )
  })

  // Sort by monthSpend descending
  const sorted = [...filtered].sort((a, b) => b.monthSpend - a.monthSpend)

  const spendLabel = (s: SupplierSummary) => {
    if (s.monthSpend === 0) return '$0 this month'
    const pct = s.prevMonthSpend === 0
      ? null
      : Math.round(((s.monthSpend - s.prevMonthSpend) / s.prevMonthSpend) * 100)
    return `${formatCurrency(s.monthSpend)} this month${pct !== null ? ` · ${pct >= 0 ? '↑' : '↓'}${Math.abs(pct)}%` : ''}`
  }

  const spendColor = (s: SupplierSummary) => {
    if (s.monthSpend === 0) return 'text-gray-400'
    if (s.prevMonthSpend === 0) return 'text-gray-500'
    const pct = ((s.monthSpend - s.prevMonthSpend) / s.prevMonthSpend) * 100
    if (pct >= 15) return 'text-red-500'
    if (pct > 0) return 'text-green-600'
    return 'text-gray-500'
  }

  return (
    <div className="flex flex-col w-full sm:w-[280px] shrink-0 bg-gray-50 border-r border-gray-200 h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-gray-200 shrink-0">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search suppliers…"
          className="flex-1 bg-white border border-gray-200 rounded-lg px-3 py-1.5 text-xs text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gold"
        />
        <button
          onClick={onAdd}
          className="bg-gold text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:bg-[#a88930] shrink-0 transition-colors"
        >
          + Add
        </button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {sorted.length === 0 && (
          <div className="py-12 text-center text-sm text-gray-400">No suppliers found</div>
        )}
        {sorted.map(s => {
          const selected = s.id === selectedId
          return (
            <button
              key={s.id}
              onClick={() => onSelect(s.id)}
              className={`w-full text-left flex border-b border-gray-100 transition-colors overflow-hidden ${
                selected ? 'bg-gold/10' : 'bg-white hover:bg-gray-50'
              }`}
            >
              <div className={`w-1 shrink-0 ${selected ? 'bg-gold/100' : 'bg-transparent'}`} />
              <div className="flex-1 min-w-0 px-3 py-3">
                <p className={`text-sm font-semibold truncate ${selected ? 'text-gold' : 'text-gray-900'}`}>
                  {s.name}
                </p>
                {s.aliases && s.aliases.length > 0 && (
                  <p className="text-xs text-gray-400 truncate mt-0.5 font-mono">
                    {s.aliases[0].name}
                  </p>
                )}
                <p className={`text-xs mt-0.5 font-medium ${spendColor(s)}`}>
                  {spendLabel(s)}
                </p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {s._count.inventory} item{s._count.inventory !== 1 ? 's' : ''} · {s.invoiceCount} invoice{s.invoiceCount !== 1 ? 's' : ''}
                </p>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

```


---

## `src/components/suppliers/SupplierDetail.tsx`

```tsx
// src/components/suppliers/SupplierDetail.tsx
'use client'
import { useEffect, useState, useCallback } from 'react'
import { Pencil, Trash2, Loader2 } from 'lucide-react'
import { SupplierSummary, SupplierIntelligence } from './types'
import { formatCurrency } from '@/lib/utils'

interface Props {
  supplierId: string
  onEdit: (supplier: SupplierSummary) => void
  onDelete: (id: string) => void
  // supplier contact info from the already-loaded list (avoids extra fetch on desktop)
  supplier: SupplierSummary | null
}

function changePctColor(pct: number): string {
  return pct > 0 ? 'text-red-500' : pct < 0 ? 'text-green-600' : 'text-gray-400'
}

export function SupplierDetail({ supplierId, onEdit, onDelete, supplier }: Props) {
  const [intel, setIntel] = useState<SupplierIntelligence | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchIntel = useCallback(async () => {
    setLoading(true)
    const data = await fetch(`/api/suppliers/${supplierId}/intelligence`)
      .then(r => r.ok ? r.json() : null)
      .catch(() => null)
    setIntel(data)
    setLoading(false)
  }, [supplierId])

  useEffect(() => { fetchIntel() }, [fetchIntel])

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-white">
      {/* Dark header */}
      <div className="bg-slate-800 text-white px-5 py-4 shrink-0 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-bold truncate">{supplier?.name ?? '—'}</h2>
          <div className="text-xs text-slate-400 mt-0.5 space-y-0.5">
            {(supplier?.contactName || supplier?.phone || supplier?.email) && (
              <p className="truncate">
                {[supplier?.contactName, supplier?.phone, supplier?.email].filter(Boolean).join(' · ')}
              </p>
            )}
            {(supplier?.orderPlatform || supplier?.cutoffDays || supplier?.deliveryDays) && (
              <p className="truncate">
                {[
                  supplier?.orderPlatform && `Order via: ${supplier.orderPlatform}`,
                  supplier?.cutoffDays && `Cutoff: ${supplier.cutoffDays}`,
                  supplier?.deliveryDays && `Delivery: ${supplier.deliveryDays}`,
                ].filter(Boolean).join(' · ')}
              </p>
            )}
            {supplier?.aliases && supplier.aliases.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {supplier.aliases.map(a => (
                  <span
                    key={a.id}
                    className="px-1.5 py-0.5 rounded bg-slate-700 text-slate-300 font-mono text-[10px]"
                  >
                    {a.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
        {supplier && (
          <div className="flex gap-2 shrink-0">
            <button
              onClick={() => onEdit(supplier)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white/10 hover:bg-white/20 text-white transition-colors"
            >
              <Pencil size={12} /> Edit
            </button>
            <button
              onClick={() => onDelete(supplier.id)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/20 hover:bg-red-500/30 text-red-300 transition-colors"
            >
              <Trash2 size={12} /> Delete
            </button>
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 size={24} className="animate-spin text-gray-300" />
        </div>
      ) : !intel ? (
        <div className="flex-1 flex items-center justify-center text-sm text-gray-400">
          Failed to load intelligence data
        </div>
      ) : (
        <>
          {/* KPI strip */}
          <div className="flex gap-3 px-4 py-3 bg-gray-50 border-b border-gray-200 shrink-0">
            <div className="flex-1 bg-white border border-gray-200 rounded-lg px-3 py-2.5">
              <p className="text-[10px] text-gray-400 uppercase tracking-wide">This Month</p>
              <p className="text-lg font-bold text-gray-900 leading-tight">{formatCurrency(intel.monthSpend)}</p>
              <p className={`text-[10px] font-medium ${changePctColor(intel.monthSpendChangePct)}`}>
                {intel.monthSpendChangePct === 0 ? '— vs last month'
                  : `${intel.monthSpendChangePct > 0 ? '↑' : '↓'} ${Math.abs(intel.monthSpendChangePct)}% vs last month`}
              </p>
            </div>
            <div className="flex-1 bg-white border border-gray-200 rounded-lg px-3 py-2.5">
              <p className="text-[10px] text-gray-400 uppercase tracking-wide">This Year</p>
              <p className="text-lg font-bold text-gray-900 leading-tight">{formatCurrency(intel.yearSpend)}</p>
              <p className="text-[10px] text-gray-400">{intel.yearInvoiceCount} invoice{intel.yearInvoiceCount !== 1 ? 's' : ''} approved</p>
            </div>
            <div className={`flex-1 rounded-lg px-3 py-2.5 border ${intel.priceChanges.length > 0 ? 'bg-amber-50 border-amber-200' : 'bg-white border-gray-200'}`}>
              <p className={`text-[10px] uppercase tracking-wide ${intel.priceChanges.length > 0 ? 'text-amber-700' : 'text-gray-400'}`}>
                Price Changes
              </p>
              <p className={`text-lg font-bold leading-tight ${intel.priceChanges.length > 0 ? 'text-amber-700' : 'text-gray-900'}`}>
                {intel.priceChanges.length} item{intel.priceChanges.length !== 1 ? 's' : ''}
              </p>
              <p className={`text-[10px] ${intel.priceChanges.length > 0 ? 'text-amber-600' : 'text-gray-400'}`}>last 90 days</p>
            </div>
          </div>

          {/* Body: two-column grid */}
          <div className="flex-1 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-gray-100">

            {/* Price Changes */}
            <div className="px-4 py-4">
              <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-3">Price Changes</h3>
              {intel.priceChanges.length === 0 ? (
                <p className="text-sm text-gray-400">No price changes in the last 90 days</p>
              ) : (
                <div className="space-y-2">
                  {intel.priceChanges.map((pc) => (
                    <div key={`${pc.itemName}-${pc.date}`} className="bg-white border border-gray-100 rounded-lg px-3 py-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-gray-900 truncate">{pc.itemName}</span>
                        <span className={`text-xs font-bold shrink-0 ${pc.pctChange > 0 ? 'text-red-500' : 'text-green-600'}`}>
                          {pc.pctChange > 0 ? '↑' : '↓'} {Math.abs(Math.round(pc.pctChange))}%
                        </span>
                      </div>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {formatCurrency(pc.oldPrice)} → <span className="font-semibold text-gray-700">{formatCurrency(pc.newPrice)}</span>
                        {' · '}{pc.date}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Items Supplied */}
            <div className="px-4 py-4">
              <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-3">
                Items Supplied ({intel.items.length})
              </h3>
              {intel.items.length === 0 ? (
                <p className="text-sm text-gray-400">No inventory items linked to this supplier</p>
              ) : (
                <div className="bg-white border border-gray-100 rounded-lg overflow-hidden">
                  <div className="grid grid-cols-[1fr_auto_auto] gap-2 px-3 py-1.5 bg-gray-50 border-b border-gray-100">
                    <span className="text-[10px] font-semibold text-gray-400 uppercase">Item</span>
                    <span className="text-[10px] font-semibold text-gray-400 uppercase">Price</span>
                    <span className="text-[10px] font-semibold text-gray-400 uppercase">Unit</span>
                  </div>
                  {intel.items.map(item => (
                    <div key={item.id} className="grid grid-cols-[1fr_auto_auto] gap-2 px-3 py-2 border-b border-gray-50 last:border-0 items-center">
                      <span className="text-xs text-gray-900 truncate">{item.itemName}</span>
                      <span className="text-xs font-semibold text-gray-700">{formatCurrency(item.pricePerBaseUnit)}</span>
                      <span className="text-[10px] text-gray-400">/{item.baseUnit}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

```


---

## `src/components/suppliers/SupplierFormModal.tsx`

```tsx
'use client'
import { useState, useEffect } from 'react'
import { X, Plus } from 'lucide-react'
import { SupplierForm, SupplierSummary } from './types'

const emptyForm: SupplierForm = {
  name: '', contactName: '', phone: '', email: '',
  orderPlatform: '', cutoffDays: '', deliveryDays: '',
  aliases: [],
}

const fields: { key: keyof Omit<SupplierForm, 'aliases'>; label: string; required?: boolean; placeholder?: string }[] = [
  { key: 'name',          label: 'Company Name',   required: true },
  { key: 'contactName',   label: 'Contact Name' },
  { key: 'phone',         label: 'Phone' },
  { key: 'email',         label: 'Email' },
  { key: 'orderPlatform', label: 'Order Platform', placeholder: 'e.g. Online Portal, Phone, Email' },
  { key: 'cutoffDays',    label: 'Cutoff Days',    placeholder: 'e.g. Monday, Wednesday' },
  { key: 'deliveryDays',  label: 'Delivery Days',  placeholder: 'e.g. Tuesday, Thursday' },
]

interface Props {
  supplier: SupplierSummary | null  // null = add mode
  onClose: () => void
  onSaved: () => void
}

export function SupplierFormModal({ supplier, onClose, onSaved }: Props) {
  const [form, setForm] = useState<SupplierForm>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [newAlias, setNewAlias] = useState('')
  // Track which existing alias IDs to delete (edit mode)
  const [aliasesToDelete, setAliasesToDelete] = useState<string[]>([])

  useEffect(() => {
    if (supplier) {
      setForm({
        name: supplier.name,
        contactName: supplier.contactName ?? '',
        phone: supplier.phone ?? '',
        email: supplier.email ?? '',
        orderPlatform: supplier.orderPlatform ?? '',
        cutoffDays: supplier.cutoffDays ?? '',
        deliveryDays: supplier.deliveryDays ?? '',
        aliases: supplier.aliases?.map(a => a.name) ?? [],
      })
      setAliasesToDelete([])
    } else {
      setForm(emptyForm)
      setAliasesToDelete([])
    }
  }, [supplier])

  const handleAddAlias = () => {
    const trimmed = newAlias.trim()
    if (!trimmed || form.aliases.includes(trimmed)) return
    setForm(prev => ({ ...prev, aliases: [...prev.aliases, trimmed] }))
    setNewAlias('')
  }

  const handleRemoveAlias = (name: string) => {
    setForm(prev => ({ ...prev, aliases: prev.aliases.filter(a => a !== name) }))
    // In edit mode, track existing alias IDs that need to be deleted
    if (supplier) {
      const existing = supplier.aliases?.find(a => a.name === name)
      if (existing) setAliasesToDelete(prev => [...prev, existing.id])
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      const { aliases, ...supplierData } = form

      if (supplier) {
        // Edit: update supplier fields
        await fetch(`/api/suppliers/${supplier.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(supplierData),
        })

        // Delete removed aliases
        await Promise.all(
          aliasesToDelete.map(id =>
            fetch(`/api/suppliers/${supplier.id}/aliases/${id}`, { method: 'DELETE' })
          )
        )

        // Add new aliases (ones not in the original supplier.aliases)
        const originalNames = new Set(supplier.aliases?.map(a => a.name) ?? [])
        const newAliases = aliases.filter(name => !originalNames.has(name))
        await Promise.all(
          newAliases.map(name =>
            fetch(`/api/suppliers/${supplier.id}/aliases`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name }),
            })
          )
        )
      } else {
        // Create: POST with aliases array
        await fetch('/api/suppliers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...supplierData, aliases }),
        })
      }

      onSaved()
      onClose()
    } catch {
      alert('Failed to save supplier. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
      onMouseDown={(e) => { (e.currentTarget as HTMLElement).dataset.mdown = String(e.target === e.currentTarget) }}
      onClick={(e) => { if (e.target === e.currentTarget && (e.currentTarget as HTMLElement).dataset.mdown === 'true') onClose() }}
    >
      <div className="bg-white rounded-2xl w-full max-w-md shadow-xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-6 pb-4 shrink-0">
          <h3 className="text-base font-bold text-gray-900">
            {supplier ? 'Edit Supplier' : 'Add Supplier'}
          </h3>
          <button onClick={onClose} className="p-2.5 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100">
            <X size={16} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
          <div className="space-y-3 px-6 flex-1 overflow-y-auto">
          {fields.map(f => (
            <div key={f.key}>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                {f.label}{f.required && ' *'}
              </label>
              <input
                required={f.required}
                value={form[f.key] as string}
                onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                placeholder={f.placeholder ?? ''}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
              />
            </div>
          ))}

          {/* Invoice Names section */}
          <div className="pt-1">
            <label className="block text-xs font-medium text-gray-600 mb-2">Invoice Names</label>
            <p className="text-xs text-gray-400 mb-2">OCR names from invoices that map to this supplier</p>
            {form.aliases.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {form.aliases.map(name => (
                  <span
                    key={name}
                    className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 rounded-md text-xs font-mono text-gray-700"
                  >
                    {name}
                    <button
                      type="button"
                      onClick={() => handleRemoveAlias(name)}
                      className="text-gray-400 hover:text-red-500 transition-colors"
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <input
                value={newAlias}
                onChange={e => setNewAlias(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddAlias() } }}
                placeholder="Add invoice name…"
                className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold font-mono"
              />
              <button
                type="button"
                onClick={handleAddAlias}
                className="px-3 py-2 bg-gray-100 text-gray-700 rounded-lg text-sm hover:bg-gray-200 transition-colors"
              >
                <Plus size={14} />
              </button>
            </div>
          </div>

          </div>

          <div className="flex gap-2 p-6 pt-4 border-t border-gray-100 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 border border-gray-200 rounded-lg py-2 text-sm hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 bg-gold text-white rounded-lg py-2 text-sm font-semibold hover:bg-[#a88930] disabled:opacity-50"
            >
              {saving ? 'Saving…' : supplier ? 'Save Changes' : 'Add Supplier'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

```


---

## `src/components/suppliers/types.ts`

```ts
// Returned by GET /api/suppliers (augmented)
export interface SupplierAlias {
  id: string
  name: string
}

export interface SupplierSummary {
  id: string
  name: string
  contactName: string | null
  phone: string | null
  email: string | null
  orderPlatform: string | null
  cutoffDays: string | null
  deliveryDays: string | null
  monthSpend: number
  prevMonthSpend: number
  invoiceCount: number
  _count: { inventory: number }
  aliases: SupplierAlias[]
}

// Returned by GET /api/suppliers/[id]/intelligence
export interface PriceChange {
  itemName: string
  oldPrice: number
  newPrice: number
  pctChange: number  // positive = increase
  date: string       // ISO date string
}

export interface SuppliedItem {
  id: string
  itemName: string
  pricePerBaseUnit: number
  baseUnit: string
}

export interface SupplierIntelligence {
  monthSpend: number
  monthSpendChangePct: number
  yearSpend: number
  yearInvoiceCount: number
  lastApprovedAt: string | null
  priceChanges: PriceChange[]
  items: SuppliedItem[]
}

// Form data for add/edit
export interface SupplierForm {
  name: string
  contactName: string
  phone: string
  email: string
  orderPlatform: string
  cutoffDays: string
  deliveryDays: string
  aliases: string[]  // local alias names for the form
}

```


---

## `src/components/wastage/WastageCharts.tsx`

```tsx
'use client'
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
} from 'recharts'
import { formatCurrency } from '@/lib/utils'

const CHART_COLORS = ['#ef4444','#f97316','#eab308','#6b7280','#3b82f6','#a855f7','#22c55e','#9ca3af']

interface Props {
  byReason: { reason: string; cost: number }[]
  byWeek:   { week: string; cost: number }[]
}

export default function WastageCharts({ byReason, byWeek }: Props) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {/* Pie: by reason */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
        <div className="text-sm font-semibold text-gray-700 mb-3">Cost by Reason</div>
        <div className="flex items-center gap-4">
          <ResponsiveContainer width={140} height={140}>
            <PieChart>
              <Pie
                data={byReason}
                dataKey="cost"
                nameKey="reason"
                cx="50%"
                cy="50%"
                innerRadius={38}
                outerRadius={60}
                paddingAngle={2}
              >
                {byReason.map((_, i) => (
                  <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip formatter={(v) => formatCurrency(Number(v))} />
            </PieChart>
          </ResponsiveContainer>
          <div className="flex-1 space-y-1.5 min-w-0">
            {byReason.map((d, i) => (
              <div key={d.reason} className="flex items-center gap-2 text-xs">
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
                <span className="text-gray-600 truncate flex-1">{d.reason}</span>
                <span className="font-semibold text-gray-800 shrink-0">{formatCurrency(d.cost)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Bar: weekly trend */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
        <div className="text-sm font-semibold text-gray-700 mb-3">Weekly Trend</div>
        {byWeek.length > 1 ? (
          <ResponsiveContainer width="100%" height={140}>
            <BarChart data={byWeek} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
              <XAxis dataKey="week" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `$${v}`} />
              <Tooltip formatter={(v) => [formatCurrency(Number(v)), 'Cost']} />
              <Bar dataKey="cost" fill="#ef4444" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-[140px] flex items-center justify-center text-sm text-gray-400">
            Not enough data for trend — expand date range
          </div>
        )}
      </div>
    </div>
  )
}

```
