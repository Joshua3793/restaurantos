# Fergie's OS — Feature Components

Recipes, inventory, prep, suppliers, invoices (v2 review system), wastage.


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

## `src/components/invoices/v2/atoms.tsx`

```tsx
'use client'
// Phase 2 — Atomic UI primitives for the invoice review drawer.
// Each component is self-contained and renders correctly from props alone.

import { Package, Scale, TrendingUp, TrendingDown, ChevronDown, Plus } from 'lucide-react'
import type { RevenueCenter } from '@/contexts/RevenueCenterContext'

// ─── Colour tokens ─────────────────────────────────────────────────────────────
// These approximate the v4 CSS variables using standard Tailwind classes.
// Kept here so every atom draws from the same palette.

const PILL_VARIANTS = {
  warn:    'bg-gold-soft text-gold-2',
  info:    'bg-blue-soft  text-blue-text',
  danger:  'bg-red-soft   text-red-text',
  success: 'bg-green-soft text-green-text',
  neutral: 'bg-bg-2 text-ink-3 border border-line',
} as const

export type PillVariant = keyof typeof PILL_VARIANTS

// ─── ModeIcon ──────────────────────────────────────────────────────────────────
// Bare 20px icon column — no background chip (deliberate, per v4).
// Package (gray) for per-case, Scale (blue) for per-weight.

export function ModeIcon({ mode }: { mode: 'per_case' | 'per_weight' }) {
  if (mode === 'per_weight') {
    return (
      <span
        className="inline-flex items-center justify-center w-[22px] h-6 shrink-0 mt-0.5 text-blue-text"
        title="Priced by weight"
      >
        <Scale size={19} />
      </span>
    )
  }
  return (
    <span
      className="inline-flex items-center justify-center w-[22px] h-6 shrink-0 mt-0.5 text-gray-400"
      title="Priced by case"
    >
      <Package size={19} />
    </span>
  )
}

// ─── Pill ──────────────────────────────────────────────────────────────────────
// Small state label. Used inline in line titles for: mode mismatch, catchweight,
// needs link, math check, format mismatch, etc.

export function Pill({
  variant,
  children,
}: {
  variant: PillVariant
  children: React.ReactNode
}) {
  return (
    <span
      className={`inline-flex items-center gap-[3px] px-[7px] py-[1px] rounded text-[10px] font-medium leading-[1.5] tracking-[0.015em] ${PILL_VARIANTS[variant]}`}
    >
      {children}
    </span>
  )
}

// ─── VariancePill ──────────────────────────────────────────────────────────────
// "↓ 8.5%" or "↑ 4.2%" — green for price drop, red for price rise.

export function VariancePill({
  percent,
  direction,
}: {
  percent: number
  direction: 'up' | 'down'
}) {
  const isUp = direction === 'up'
  return (
    <span
      className={`inline-flex items-center gap-[3px] px-[7px] py-[1px] rounded text-[11px] font-medium ${
        isUp ? 'bg-red-soft text-red-text' : 'bg-green-soft text-green-text'
      }`}
    >
      {isUp ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
      {isUp ? '+' : ''}
      {percent.toFixed(1)}%
    </span>
  )
}

// ─── RcPill ────────────────────────────────────────────────────────────────────
// When assigned: solid chip showing RC name + chevron (opens RC picker on click).
// When unassigned: dashed chip showing "assign RC +" (calls onAssign).

export function RcPill({
  rc,
  onAssign,
  onClick,
}: {
  rc?: RevenueCenter | null
  onAssign?: () => void
  onClick?: () => void
}) {
  if (rc) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="inline-flex items-center gap-1.5 bg-bg border border-line px-2 py-[3px] rounded text-xs text-ink-3 hover:bg-bg-2 transition-colors"
      >
        <span className="text-[10px] text-ink-4 font-medium uppercase tracking-wide">RC</span>
        <span className="font-medium text-ink">{rc.name}</span>
        <ChevronDown size={12} className="text-ink-4" />
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={onAssign}
      className="inline-flex items-center gap-1 border border-dashed border-line-2 px-2 py-[3px] rounded text-xs text-ink-3 hover:border-blue hover:text-blue-text transition-colors"
    >
      <span>assign RC</span>
      <Plus size={11} />
    </button>
  )
}

// ─── ModeToggle ────────────────────────────────────────────────────────────────
// Segmented control inside the Invoice math card header.
// Active "case" → white bg. Active "weight" → blue bg (per v4).

export function ModeToggle({
  mode,
  onChange,
}: {
  mode: 'per_case' | 'per_weight'
  onChange: (m: 'per_case' | 'per_weight') => void
}) {
  return (
    <div className="inline-flex p-[2px] bg-bg-2 border border-line rounded-[6px]">
      <button
        type="button"
        onClick={() => onChange('per_case')}
        className={`px-[11px] py-[3px] text-[11px] rounded font-medium transition-colors ${
          mode === 'per_case'
            ? 'bg-paper text-ink shadow-sm'
            : 'text-ink-3 hover:text-ink-2'
        }`}
      >
        case
      </button>
      <button
        type="button"
        onClick={() => onChange('per_weight')}
        className={`px-[11px] py-[3px] text-[11px] rounded font-medium transition-colors ${
          mode === 'per_weight'
            ? 'bg-blue-soft text-blue-text shadow-sm'
            : 'text-ink-3 hover:text-ink-2'
        }`}
      >
        weight
      </button>
    </div>
  )
}

// ─── IssueBadge ──────────────────────────────────────────────────────────────
// The single coloured pill that labels an .issue block (price / mode / sku /
// supplier). Mock §5: .badge.price → red-soft, .badge.mode → gold-soft,
// .badge.sku → blue-soft. Mono, uppercase, pill.

export type IssueKind = 'price' | 'mode' | 'sku' | 'supplier'

const ISSUE_BADGE: Record<IssueKind, string> = {
  price:    'bg-red-soft text-red-text',
  mode:     'bg-gold-soft text-gold-2',
  sku:      'bg-blue-soft text-blue-text',
  supplier: 'bg-gold-soft text-gold-2',
}

export function IssueBadge({ kind, children }: { kind: IssueKind; children: React.ReactNode }) {
  return (
    <span
      className={`font-mono text-[9.5px] font-semibold uppercase tracking-[0.02em] px-2 py-[3px] rounded-full shrink-0 ${ISSUE_BADGE[kind]}`}
    >
      {children}
    </span>
  )
}

// ─── ActButton ───────────────────────────────────────────────────────────────
// The inline decision button used in .actions rows. Mock §5:
//   .act          → bordered paper, ink-2 text
//   .act.primary  → solid ink, paper text (the recommended decision)
//   .act.danger   → borderless red, hover red-soft
// Optional `kbd` renders the little keycap chip (e.g. the ⌘⏎ on Approve).

export function ActButton({
  variant = 'default',
  onClick,
  children,
  kbd,
  disabled,
  title,
}: {
  variant?: 'default' | 'primary' | 'danger'
  onClick?: () => void
  children: React.ReactNode
  kbd?: string
  disabled?: boolean
  title?: string
}) {
  const base = 'inline-flex items-center gap-1.5 px-3 py-[7px] text-[12px] font-medium rounded-[7px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed'
  const variantCls =
    variant === 'primary'
      ? 'bg-ink text-paper border border-ink hover:bg-ink-2'
      : variant === 'danger'
      ? 'bg-transparent text-red-text border border-transparent hover:bg-red-soft'
      : 'bg-paper text-ink-2 border border-line hover:border-ink-4 hover:text-ink'
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title} className={`${base} ${variantCls}`}>
      {children}
      {kbd && (
        <span className="font-mono text-[9.5px] px-[5px] py-[1px] rounded bg-paper/15 text-bg">{kbd}</span>
      )}
    </button>
  )
}

// ─── LineNumberChip ──────────────────────────────────────────────────────────
// The "01" / "02" index chip at the left of each .line-head. Goes gold on
// attention lines, green on auto-matched, neutral otherwise.

export function LineNumberChip({
  n,
  tone = 'neutral',
}: {
  n: number
  tone?: 'neutral' | 'attention' | 'ok' | 'muted'
}) {
  const toneCls =
    tone === 'attention' ? 'bg-gold-soft text-gold-2'
    : tone === 'ok'       ? 'bg-green-soft text-green-text'
    : tone === 'muted'    ? 'bg-bg-2 text-ink-4'
    :                       'bg-bg-2 text-ink-3'
  return (
    <span className={`font-mono text-[10px] font-semibold w-6 text-center py-[3px] rounded-[5px] ${toneCls}`}>
      {String(n).padStart(2, '0')}
    </span>
  )
}

// ─── Segmented ───────────────────────────────────────────────────────────────
// The All / Issues / Matched control in the review-pane progress header.
// Mock .rv-progress .seg: bg-2 track, active segment goes white-on-paper.

export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: Array<{ value: T; label: string }>
}) {
  return (
    <div className="flex bg-bg-2 rounded-[7px] p-[2px]">
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`font-mono text-[10px] font-semibold uppercase tracking-[0.01em] px-[9px] py-1 rounded-[5px] transition-colors ${
            value === o.value
              ? 'bg-paper text-ink shadow-sm'
              : 'text-ink-3 hover:text-ink-2'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

```


---

## `src/components/invoices/v2/chrome.tsx`

```tsx
'use client'
// Drawer "chrome" — the brand surfaces that frame the review pane:
// cost-impact strip (Principle 01), the totals-tie alert banner, the review
// progress header, and the section dividers.

import { AlertTriangle } from 'lucide-react'
import { Segmented } from './atoms'

// ─── ImpactStrip ───────────────────────────────────────────────────────────────
// "Cost is chrome" — the dark strip directly under the header summarising what
// approving will write. Only metrics we can compute pre-approve are shown.

export interface ImpactMetric {
  label: string
  value: string
  tone?: 'warn' | 'bad' | 'ok'
}

export function ImpactStrip({
  metrics,
  helper,
}: {
  metrics: ImpactMetric[]
  helper?: React.ReactNode
}) {
  const toneCls = (t?: ImpactMetric['tone']) =>
    t === 'warn' ? 'text-[#fcd34d]' : t === 'bad' ? 'text-[#fca5a5]' : t === 'ok' ? 'text-green' : 'text-bg'

  return (
    <div className="flex items-center gap-[18px] bg-ink text-bg px-[22px] py-[9px] overflow-x-auto">
      {metrics.map((m, i) => (
        <div key={m.label} className="flex items-center gap-[18px] shrink-0">
          {i > 0 && <span className="w-px h-3.5 bg-ink-2" />}
          <div className="flex items-baseline gap-2 shrink-0">
            <span className="font-mono text-[10px] uppercase tracking-[0.02em] text-ink-4">{m.label}</span>
            <span className={`font-mono text-[13.5px] font-semibold tabular-nums ${toneCls(m.tone)}`}>{m.value}</span>
          </div>
        </div>
      ))}
      <span className="flex-1" />
      {helper && <span className="font-mono text-[10.5px] text-ink-3 shrink-0">{helper}</span>}
    </div>
  )
}

// ─── AlertBanner ───────────────────────────────────────────────────────────────
// Gold-soft full-width bar. Only rendered for invoice-wide issues (e.g. the
// sum-of-lines / subtotal mismatch).

export function AlertBanner({
  children,
  onIgnore,
  onShowFix,
  showFixLabel = 'Show suggested fix',
}: {
  children: React.ReactNode
  onIgnore?: () => void
  onShowFix?: () => void
  showFixLabel?: string
}) {
  return (
    <div className="flex items-center gap-3 bg-gold-soft border-b border-[#fcd34d]/60 px-[22px] py-[11px] text-[13px] text-gold-2">
      <AlertTriangle size={16} className="text-gold-2 shrink-0" strokeWidth={2.2} />
      <span className="flex-1 min-w-0">{children}</span>
      <div className="flex gap-1.5 shrink-0">
        {onIgnore && (
          <button
            type="button"
            onClick={onIgnore}
            className="font-mono text-[10.5px] font-semibold px-2.5 py-1 rounded-full bg-gold-2/10 text-gold-2 hover:bg-gold-2/20 transition-colors"
          >
            Ignore for now
          </button>
        )}
        {onShowFix && (
          <button
            type="button"
            onClick={onShowFix}
            className="font-mono text-[10.5px] font-semibold px-2.5 py-1 rounded-full bg-gold-2 text-paper hover:bg-gold-2 transition-colors"
          >
            {showFixLabel}
          </button>
        )}
      </div>
    </div>
  )
}

// ─── ReviewProgress ──────────────────────────────────────────────────────────
// "X of N resolved" + gold progress bar + All / Issues / Matched segmented filter.

export type ReviewSegment = 'all' | 'issues' | 'matched'

export function ReviewProgress({
  resolved,
  total,
  segment,
  onSegment,
  counts,
}: {
  resolved: number
  total: number
  segment: ReviewSegment
  onSegment: (s: ReviewSegment) => void
  counts: { all: number; issues: number; matched: number }
}) {
  const pct = total > 0 ? Math.round((resolved / total) * 100) : 100
  return (
    <div className="flex items-center gap-3 px-[22px] py-2.5 bg-paper border-b border-line shrink-0">
      <span className="font-mono text-[11px] font-semibold text-ink-2 shrink-0 tabular-nums">
        {total > 0 ? `${resolved} of ${total} resolved` : 'All matched'}
      </span>
      <div className="flex-1 h-1 rounded-full bg-bg-2 overflow-hidden">
        <div
          className="h-full rounded-full bg-gold transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <Segmented<ReviewSegment>
        value={segment}
        onChange={onSegment}
        options={[
          { value: 'all',     label: `All ${counts.all}` },
          { value: 'issues',  label: `Issues ${counts.issues}` },
          { value: 'matched', label: `Matched ${counts.matched}` },
        ]}
      />
    </div>
  )
}

// ─── SectionDivider ──────────────────────────────────────────────────────────

export function SectionDivider({
  tone,
  label,
  count,
}: {
  tone: 'red' | 'green' | 'neutral'
  label: string
  count?: string
}) {
  const dotCls = tone === 'red' ? 'bg-red' : tone === 'green' ? 'bg-green' : 'bg-ink-4'
  return (
    <div className="flex items-center gap-2.5 pt-2 pb-1 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">
      <span className={`w-1.5 h-1.5 rounded-full ${dotCls}`} />
      <span>{label}</span>
      {count && <span className="text-ink-4 font-medium normal-case tracking-normal">· {count}</span>}
      <span className="flex-1 h-px bg-line" />
    </div>
  )
}

```


---

## `src/components/invoices/v2/card.tsx`

```tsx
'use client'
// LineItemCard — the redesigned per-line review card (Invoice Drawer mock §2/§5).
// Matched lines render as a single collapsed row; attention lines expand into a
// link-row, stacked `.issue` blocks, the invoice-math block, and an optional
// inventory-cost comparison. Reads shared state from DrawerContext.

import { useRef } from 'react'
import { ChevronDown, ExternalLink, Ban, Undo2, Check } from 'lucide-react'
import { useDrawerContext } from './context'
import { LineNumberChip } from './atoms'
import {
  LinkPicker,
  CaseStructureEditor,
  InvoiceMathFields,
  type InventorySearchResult,
} from './composites'
import { ModeIssue, NewSkuIssue, PriceIssue } from './issues'
import {
  derivePricingMode, isCatchweight, hasModeMismatch, hasFormatMismatch,
  hasMathCheck, isUnlinked,
} from '@/lib/invoice/predicates'
import { isBigPriceChange, lineUnresolved } from '@/lib/invoice/resolution'
import { formatPackSummary, formatRateLabel, formatCurrency } from '@/lib/invoice/formatters'
import { computeNormalisedPrices } from '@/lib/invoice/calculations'
import type { ScanItem } from '@/components/invoices/types'

// ─── LineItemCard ──────────────────────────────────────────────────────────────

export function LineItemCard({ lineId, displayNo }: { lineId: string; displayNo: number }) {
  const ctx  = useDrawerContext()
  const item = ctx.getEffectiveLine(lineId)
  const mathRef = useRef<HTMLDivElement>(null)

  const pricingMode = derivePricingMode(item)
  const isOpen      = ctx.expandedLineIds.has(lineId)
  const isFlashing  = ctx.flashingLineIds.has(lineId)
  const isPicking   = ctx.pickingLinkForId === lineId
  const isSkipped   = item.action === 'SKIP'
  const isCreateNew = item.action === 'CREATE_NEW'

  const unlinked       = !isSkipped && isUnlinked(item)
  const modeMismatch   = !isSkipped && hasModeMismatch(item)
  const formatMismatch = !isSkipped && hasFormatMismatch(item)
  const mathCheck      = !isSkipped && hasMathCheck(item)
  const bigPrice       = !isSkipped && isBigPriceChange(item)
  const isAttention    = unlinked || modeMismatch || formatMismatch || mathCheck || bigPrice
  const isCatch        = isCatchweight(item)

  // A line that surfaced an issue but whose decisions are all made now reads as
  // resolved — flips the card from amber attention to green acknowledgment.
  const resolved = isAttention && !lineUnresolved(item, {
    modeWriteback: ctx.modeWritebackItems.has(lineId),
    priceAck:      ctx.acknowledgedPriceLines.has(lineId),
  })

  // data-task for the footer's goToTask() targeting (highest-priority first).
  const dataTask = isSkipped ? undefined
    : unlinked       ? 'link'
    : mathCheck      ? 'math'
    : (modeMismatch || formatMismatch) ? 'mismatch'
    : undefined

  const handleToggle = () => ctx.toggleExpand(lineId)
  const handleChangeLink = () => ctx.startLinkPicker(lineId)

  const handleSelectLink = (result: InventorySearchResult) => {
    ctx.updateLine(lineId, {
      matchedItemId: result.id,
      matchedItem: {
        id: result.id,
        itemName: result.itemName,
        purchaseUnit: result.purchaseUnit,
        purchasePrice: String(result.purchasePrice),
        pricePerBaseUnit: String(result.pricePerBaseUnit),
        baseUnit: result.baseUnit,
        qtyPerPurchaseUnit: String(result.qtyPerPurchaseUnit),
        packSize: String(result.packSize),
        packUOM: result.packUOM,
        priceType: 'CASE',
        qtyUOM: result.packUOM,
        innerQty: null,
      },
      action: 'UPDATE_PRICE',
    })
    ctx.closeLinkPicker()
  }

  const handleMathChange = (patch: Partial<ScanItem>) => ctx.updateLine(lineId, patch)
  const defaultRcId = ctx.revenueCenters.find(r => r.isDefault)?.id ?? ''
  const handleRcChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const picked = ctx.revenueCenters.find(r => r.id === e.target.value) ?? null
    ctx.setLineRc(lineId, picked)
  }

  const total = item.rawLineTotal ? Number(item.rawLineTotal) : null
  const rate  = formatRateLabel(item)

  // ── Charge / skipped line — "Other line items" section ──────────────────────
  if (isSkipped) {
    return (
      <article
        data-line-id={lineId}
        className="flex items-center gap-3 bg-paper border border-line rounded-lg px-4 py-[11px] opacity-70"
      >
        <LineNumberChip n={displayNo} tone="muted" />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] text-ink-3 font-medium truncate">{item.rawDescription || '(no description)'}</div>
          <div className="font-mono text-[10.5px] text-ink-4 mt-0.5 flex items-center gap-1.5 flex-wrap">
            <Ban size={10} /> Skipped — no COGS impact
          </div>
        </div>
        <div className="font-mono text-[13px] font-semibold text-ink-3 tabular-nums shrink-0">
          {total !== null ? formatCurrency(total) : '—'}
        </div>
        <button
          type="button"
          onClick={() => ctx.updateLine(lineId, { action: item.matchedItemId ? 'UPDATE_PRICE' : 'PENDING' })}
          className="font-mono text-[10.5px] font-semibold text-gold border-b border-dashed border-gold/70 hover:text-gold-2 shrink-0 inline-flex items-center gap-1"
        >
          <Undo2 size={11} /> undo
        </button>
      </article>
    )
  }

  // ── Auto-matched, collapsed — single row ────────────────────────────────────
  if (!isOpen) {
    return (
      <article
        data-line-id={lineId}
        data-task={dataTask}
        onClick={handleToggle}
        className={`flex items-center gap-3 bg-paper border rounded-lg px-4 py-[11px] cursor-pointer transition-colors ${
          resolved ? 'border-[#86efac] hover:border-green-text'
          : isAttention ? 'border-[#fcd34d] hover:border-gold'
          : 'border-line hover:border-line-2'
        } ${isFlashing ? 'animate-flash-highlight' : ''}`}
      >
        <LineNumberChip n={displayNo} tone={isAttention && !resolved ? 'attention' : 'ok'} />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] text-ink font-medium truncate">
            {item.rawDescription || '(no description)'}
            <span className="font-mono text-[10.5px] text-ink-4 font-normal ml-2">{formatPackSummary(item)}</span>
          </div>
        </div>
        {resolved && (
          <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.02em] px-2 py-[3px] rounded-full bg-green-soft text-green-text shrink-0 inline-flex items-center gap-1">
            <Check size={10} /> resolved
          </span>
        )}
        {!isAttention && item.matchedItem && (
          <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.02em] px-2 py-[3px] rounded-full bg-green-soft text-green-text shrink-0">
            matched
          </span>
        )}
        <div className="font-mono text-[13px] font-semibold text-ink tabular-nums shrink-0">
          {total !== null ? formatCurrency(total) : '—'}
        </div>
        <ChevronDown size={15} className="text-ink-4 shrink-0" />
      </article>
    )
  }

  // ── Expanded card ────────────────────────────────────────────────────────────
  return (
    <article
      data-line-id={lineId}
      data-task={dataTask}
      className={`bg-paper border rounded-lg overflow-hidden transition-shadow ${
        resolved ? 'border-[#86efac]' : isAttention ? 'border-[#fcd34d]' : 'border-line'
      } ${isOpen ? 'shadow-sm' : ''} ${isFlashing ? 'animate-flash-highlight' : ''}`}
    >
      {/* line-head */}
      <div
        role="button"
        tabIndex={0}
        onClick={handleToggle}
        onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && handleToggle()}
        className="grid grid-cols-[24px_1fr_auto] gap-3 items-start px-4 pt-3.5 pb-3 border-b border-dashed border-line cursor-pointer select-none"
      >
        <LineNumberChip n={displayNo} tone={isAttention ? 'attention' : 'ok'} />
        <div className="min-w-0">
          <div className="text-[14px] font-semibold text-ink leading-[1.3]">
            {item.rawDescription || '(no description)'}
          </div>
          <div className="font-mono text-[10.5px] text-ink-4 mt-[3px] flex items-center gap-1.5 flex-wrap">
            {item.supplierItemCode && (
              <>
                <span>#{item.supplierItemCode}</span>
                <span className="text-line-2">·</span>
              </>
            )}
            <span>{formatPackSummary(item)}</span>
            {isCatch && item.qtyOrdered && (
              <>
                <span className="text-line-2">·</span>
                <span className="text-blue-text">{Number(item.qtyOrdered).toFixed(2)} {item.qtyOrderedUOM ?? item.rateUOM ?? 'lb'} received</span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-start gap-2.5 shrink-0">
          {resolved && (
            <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.02em] px-2 py-[3px] rounded-full bg-green-soft text-green-text inline-flex items-center gap-1 self-center">
              <Check size={10} /> resolved
            </span>
          )}
          <div className="text-right">
            <div className="font-mono text-[16px] font-semibold text-ink tabular-nums leading-none">
              {total !== null ? formatCurrency(total) : '—'}
            </div>
            {rate && <div className="font-mono text-[10.5px] text-ink-4 mt-0.5 tabular-nums">{rate}</div>}
          </div>
          <ChevronDown size={16} className="text-ink-4 mt-1 rotate-180 transition-transform" />
        </div>
      </div>

      {/* link picker (search) */}
      {isPicking ? (
        <div className="px-4 py-2.5 border-b border-dashed border-line">
          <LinkPicker
            defaultQuery={item.rawDescription ?? ''}
            onSelect={handleSelectLink}
            onCreateNew={() => { ctx.closeLinkPicker(); ctx.openCreateNew(item) }}
          />
          <button
            type="button"
            onClick={ctx.closeLinkPicker}
            className="mt-2 text-[11px] text-ink-4 hover:text-ink-2 underline underline-offset-2"
          >
            cancel
          </button>
        </div>
      ) : isCreateNew ? (
        <div className="px-4 py-2.5 flex items-center gap-2.5 text-[12.5px] bg-green-soft border-b border-dashed border-line">
          <span className="inline-flex items-center gap-1.5 font-medium text-green-text">+ new item on approve</span>
          <span className="flex-1" />
          <button onClick={() => ctx.startLinkPicker(lineId)} className="font-mono text-[10.5px] font-semibold text-ink-4 hover:text-gold border-b border-dashed border-line-2">change</button>
        </div>
      ) : item.matchedItem ? (
        <div className="px-4 py-2.5 flex items-center gap-2.5 text-[12.5px] bg-bg border-b border-dashed border-line">
          <span className="font-mono text-[10px] uppercase tracking-[0.04em] text-ink-4">Linked to</span>
          <span className="inline-flex items-center gap-1.5 font-medium text-ink px-2 py-[2px] rounded-md bg-paper border border-line">
            <span className="w-1.5 h-1.5 rounded-full bg-red" />
            {item.matchedItem.itemName}
          </span>
          <span className="flex-1" />
          <button onClick={handleChangeLink} className="font-mono text-[10.5px] font-semibold text-gold hover:text-gold-2 border-b border-dashed border-gold/70">change link</button>
        </div>
      ) : null}

      {/* issue blocks */}
      {!isPicking && (
        <>
          {unlinked && <NewSkuIssue item={item} lineId={lineId} />}
          {modeMismatch && <ModeIssue item={item} lineId={lineId} />}
          {bigPrice && <PriceIssue item={item} lineId={lineId} onFixUom={() => mathRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })} />}
          {formatMismatch && !modeMismatch && (
            <div className="px-4 py-2.5 border-b border-dashed border-line">
              <FormatMismatchNotice item={item} lineId={lineId} />
            </div>
          )}
        </>
      )}

      {/* invoice math */}
      {!isPicking && (
        <>
          {pricingMode === 'per_case' && (
            <div className="px-4 py-2.5 border-b border-dashed border-line">
              <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-4 font-semibold mb-2">Pack structure</div>
              <CaseStructureEditor item={item} onChange={patch => ctx.updateLine(lineId, patch)} />
            </div>
          )}

          <div ref={mathRef} className="px-4 py-2.5 bg-bg border-b border-dashed border-line">
            <InvoiceMathFields
              item={item}
              mode={pricingMode}
              onMode={m => ctx.updateLine(lineId, { pricingMode: m })}
              onChange={handleMathChange}
            />
          </div>

          {/* inventory cost comparison — hidden when the price issue already shows it */}
          {item.matchedItem && !isCreateNew && !bigPrice && (
            <InventoryComparisonCard item={item} />
          )}

          {/* line actions: revenue center + skip */}
          <div className="px-4 py-2.5 flex items-center gap-2" onClick={e => e.stopPropagation()} role="presentation">
            <select
              value={item.revenueCenterId ?? defaultRcId}
              onChange={handleRcChange}
              className="font-mono text-[11px] text-ink-3 bg-bg border border-line rounded px-1.5 py-[3px] hover:bg-bg-2 focus:outline-none focus:ring-1 focus:ring-gold/40 cursor-pointer"
            >
              {ctx.revenueCenters.map(r => (
                <option key={r.id} value={r.id}>{r.name}{r.isDefault ? ' (default)' : ''}</option>
              ))}
            </select>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => ctx.updateLine(lineId, { action: 'SKIP' })}
              title="Skip this line — won't affect COGS"
              className="inline-flex items-center gap-1 font-mono text-[10.5px] text-ink-4 hover:text-ink-2 hover:bg-bg-2 px-2 py-[3px] rounded transition-colors"
            >
              <Ban size={11} /> Skip
            </button>
          </div>
        </>
      )}
    </article>
  )
}

// ─── InventoryComparisonCard ───────────────────────────────────────────────────
// Current linked cost vs. what this invoice would set it to (normalised $/unit).

function InventoryComparisonCard({ item }: { item: ScanItem }) {
  const norm = computeNormalisedPrices(item)

  let prevLabel = '—'
  let nextLabel = '—'
  let pct: number | null = null
  let rateUnit = ''

  if (norm) {
    const factor = norm.baseUnit === 'g' || norm.baseUnit === 'ml' ? 1000 : 1
    rateUnit  = norm.baseUnit === 'g' ? 'kg' : norm.baseUnit === 'ml' ? 'L' : 'each'
    prevLabel = `${formatCurrency(norm.inventoryPPB * factor)}/${rateUnit}`
    nextLabel = `${formatCurrency(norm.invoicePPB * factor)}/${rateUnit}`
    pct       = norm.pctDiff
  } else {
    const prev = item.previousPrice ? Number(item.previousPrice) : null
    const next = item.rawUnitPrice  ? Number(item.rawUnitPrice)  : null
    const bu   = item.matchedItem?.purchaseUnit ?? 'case'
    if (prev !== null) prevLabel = `${formatCurrency(prev)}/${bu}`
    if (next !== null) {
      nextLabel = `${formatCurrency(next)}/${bu}`
      if (prev !== null && prev > 0) pct = Math.round(((next - prev) / prev) * 10000) / 100
    }
  }

  const ctx = useDrawerContext()
  const isBad = pct !== null && pct > 0

  return (
    <div className="px-4 py-2.5 border-b border-dashed border-line">
      <div className="flex items-center justify-between mb-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-4 font-semibold">Inventory comparison</div>
        {item.matchedItem?.id && (
          <button
            type="button"
            onClick={() => ctx.openInventoryEdit(item.matchedItem!.id)}
            className="inline-flex items-center gap-1 font-mono text-[10.5px] text-gold hover:text-gold-2 font-semibold border-b border-dashed border-gold/70"
          >
            Edit <ExternalLink size={11} />
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        <div className="bg-bg border border-line rounded-lg px-3 py-2.5">
          <div className="font-mono text-[9.5px] uppercase tracking-[0.02em] text-ink-4">Current cost</div>
          <div className="font-mono text-[13px] font-semibold text-ink-2 tabular-nums mt-1">{prevLabel}</div>
        </div>
        <div className={`rounded-lg px-3 py-2.5 border ${isBad ? 'border-[#fecaca] bg-red-soft' : 'border-line bg-bg'}`}>
          <div className="font-mono text-[9.5px] uppercase tracking-[0.02em] text-ink-4">Invoice cost</div>
          <div className={`font-mono text-[13px] font-semibold tabular-nums mt-1 ${isBad ? 'text-red-text' : 'text-ink'}`}>
            {nextLabel}
            {pct !== null && Math.abs(pct) >= 0.1 && (
              <span className={`ml-1.5 text-[11px] ${pct > 0 ? 'text-red' : 'text-green-text'}`}>
                {pct > 0 ? '+' : ''}{pct.toFixed(1)}%
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── FormatMismatchNotice ──────────────────────────────────────────────────────
// Shows invoice vs inventory pack format with two resolution actions.

function FormatMismatchNotice({ item, lineId }: { item: ScanItem; lineId: string }) {
  const { updateLine } = useDrawerContext()

  const inv = item.matchedItem
  const invFmt = inv ? `${inv.qtyPerPurchaseUnit} × ${inv.packSize}${inv.packUOM}` : null
  const invoiceFmt = item.invoicePackQty && item.invoicePackSize && item.invoicePackUOM
    ? `${item.invoicePackQty} × ${item.invoicePackSize}${item.invoicePackUOM}`
    : null

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-start gap-2.5">
        <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.02em] px-2 py-[3px] rounded-full bg-blue-soft text-blue-text shrink-0">Format mismatch</span>
        <span className="text-[12.5px] text-ink-2 leading-[1.45]">
          Pack structure on this invoice (<b className="font-semibold text-ink">{invoiceFmt ?? '—'}</b>) doesn&rsquo;t match{' '}
          <b className="font-semibold text-ink">{inv?.itemName ?? 'the stored item'}</b> (<b className="font-semibold text-ink">{invFmt ?? '—'}</b>).
        </span>
      </div>
      <div className="flex gap-1.5 flex-wrap">
        <button
          type="button"
          onClick={() => updateLine(lineId, { formatMismatch: false })}
          className="inline-flex items-center gap-1.5 px-3 py-[7px] text-[12px] font-medium rounded-[7px] bg-ink text-paper hover:bg-ink-2 transition-colors"
        >
          Use invoice format
        </button>
        <button
          type="button"
          onClick={() => {
            if (!inv) return
            updateLine(lineId, {
              formatMismatch: false,
              invoicePackQty:  String(inv.qtyPerPurchaseUnit),
              invoicePackSize: String(inv.packSize),
              invoicePackUOM:  inv.packUOM ?? undefined,
            })
          }}
          className="inline-flex items-center gap-1.5 px-3 py-[7px] text-[12px] font-medium rounded-[7px] bg-paper text-ink-2 border border-line hover:border-ink-4 transition-colors"
        >
          Revert to inventory format
        </button>
      </div>
    </div>
  )
}

```


---

## `src/components/invoices/v2/composites.tsx`

```tsx
'use client'
// Phase 3 — Composite components for the invoice review drawer.
// Each renders correctly given just its props; no drawer-level context required.

import { useState, useRef, useCallback, useEffect } from 'react'
import {
  AlertTriangle, Search, Plus, Check, ArrowRight,
  RotateCcw, ZoomIn, ChevronDown, Link2, Info, X,
} from 'lucide-react'
import type { ScanItem } from '@/components/invoices/types'
import { Pill, VariancePill, ModeToggle } from './atoms'
import { computeLineMath, computeNormalisedPrices } from '@/lib/invoice/calculations'
import { formatCurrency } from '@/lib/invoice/formatters'
import { derivePricingMode } from '@/lib/invoice/predicates'
import { FILTER_LABELS, type FilterKey, type SortMode } from '@/lib/invoice/filters'
import { PACK_UOMS } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface InventorySearchResult {
  id: string
  itemName: string
  abbreviation: string | null
  purchaseUnit: string
  purchasePrice: number
  pricePerBaseUnit: number
  baseUnit: string
  category: string
  qtyPerPurchaseUnit: number
  packSize: number
  packUOM: string
}

export type ReconcileResult = {
  sumOfLines: number
  invoiceSubtotal: number | null
  delta: number
  status: 'match' | 'mismatch' | 'unknown'
  suggestedFixItemId: string | null
  suggestedFixValue: number | null
}

// ─── LineAmounts ──────────────────────────────────────────────────────────────
// Right-side column of each collapsed row. Always shows total; below it shows
// either a rate string OR a math-check warning — never both.

export function LineAmounts({
  total,
  rate,
  warning,
  isOpen,
}: {
  total: number | null
  rate?: string | null
  warning?: string | null
  isOpen?: boolean
}) {
  return (
    <div className="flex items-start gap-2.5 shrink-0">
      <div className="flex flex-col items-end gap-[2px]">
        <div className="text-[15.5px] font-semibold tabular-nums whitespace-nowrap leading-none tracking-[-0.01em]">
          {total !== null ? formatCurrency(total) : '—'}
        </div>
        {warning ? (
          <div className="flex items-center gap-[3px] text-[11px] text-gold-2 tabular-nums">
            <AlertTriangle size={11} />
            maybe {warning}
          </div>
        ) : rate ? (
          <div className="text-[11px] text-ink-4 tabular-nums">{rate}</div>
        ) : null}
      </div>
      <ChevronDown
        size={16}
        className={`text-ink-4 mt-[5px] shrink-0 transition-transform duration-[180ms] ${isOpen ? 'rotate-180' : ''}`}
      />
    </div>
  )
}

// ─── LinkInfoRow ──────────────────────────────────────────────────────────────
// The "linked to …" row shown when a line item is already matched.

export function LinkInfoRow({
  item,
  onChangeClick,
}: {
  item: ScanItem
  onChangeClick: () => void
}) {
  const norm      = computeNormalisedPrices(item)
  // Prefer normalised pct (accounts for mode/format differences) over the raw
  // matcher value which compares per-case prices even for per-weight items.
  const variance  = norm
    ? norm.pctDiff
    : item.priceDiffPct ? Number(item.priceDiffPct) : null

  return (
    <div className="flex items-center gap-[7px] min-w-0 flex-wrap text-[12.5px]">
      <Link2 size={14} className="text-ink-3 shrink-0" />
      <span className="text-ink-3">linked to</span>
      <span className="font-medium text-ink truncate">{item.matchedItem?.itemName}</span>
      <button
        type="button"
        onClick={onChangeClick}
        className="text-[11px] px-2 py-[2px] border border-line rounded text-ink-3 hover:bg-bg hover:text-ink transition-colors"
      >
        change
      </button>
      {variance !== null && Math.abs(variance) >= 0.1 ? (
        <VariancePill percent={Math.abs(variance)} direction={variance > 0 ? 'up' : 'down'} />
      ) : norm ? (
        <span className="text-[11px] text-ink-4 tabular-nums">
          {formatCurrency(norm.invoicePPB)}/{norm.baseUnit} · unchanged
        </span>
      ) : null}
    </div>
  )
}

// ─── LinkPicker ───────────────────────────────────────────────────────────────
// Three-part UI: search input → results list → promoted "create new" option.
// "Create new" is always visible even when matches exist (deliberate).

export function LinkPicker({
  defaultQuery,
  onSelect,
  onCreateNew,
}: {
  defaultQuery: string
  onSelect: (result: InventorySearchResult) => void
  onCreateNew: () => void
}) {
  const [query,   setQuery]   = useState(defaultQuery)
  const [results, setResults] = useState<InventorySearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const runSearch = useCallback((q: string) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (!q.trim()) { setResults([]); return }
    timerRef.current = setTimeout(async () => {
      setLoading(true)
      try {
        const res  = await fetch(`/api/inventory/search?q=${encodeURIComponent(q)}&limit=8`)
        const data = await res.json()
        setResults(data)
      } finally {
        setLoading(false)
      }
    }, 180)
  }, [])

  // Run initial search on mount
  useEffect(() => { runSearch(defaultQuery) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleChange = (v: string) => {
    setQuery(v)
    runSearch(v)
  }

  return (
    <div className="space-y-[5px]">
      {/* Label */}
      <div className="flex items-center gap-1.5 text-[11px] text-ink-3 uppercase tracking-[0.06em] mb-1.5">
        <Search size={13} />
        <span>Link to product</span>
      </div>

      {/* Search input */}
      <div className="flex items-center gap-2 bg-paper border-[1.5px] border-blue rounded px-3 h-9 shadow-[0_0_0_3px_rgba(37,99,172,0.12)]">
        <input
          autoFocus
          value={query}
          onChange={e => handleChange(e.target.value)}
          placeholder="search or create…"
          className="flex-1 text-[13px] bg-transparent border-none outline-none"
        />
        <span className="text-[10px] text-ink-4 px-1.5 py-0.5 bg-bg-2 rounded font-mono">↑↓</span>
      </div>

      {/* Results */}
      {results.length > 0 && (
        <div className="bg-paper border border-line rounded-lg overflow-hidden">
          {results.map((r, i) => (
            <button
              key={r.id}
              type="button"
              onClick={() => onSelect(r)}
              className={`w-full flex items-center gap-3 px-[13px] py-[10px] text-left hover:bg-bg transition-colors ${
                i < results.length - 1 ? 'border-b border-bg-2' : ''
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium text-ink">{r.itemName}</div>
                <div className="text-[11px] text-ink-3 mt-0.5 tabular-nums">
                  {formatCurrency(r.pricePerBaseUnit)}/{r.baseUnit}
                  {r.category ? ` · ${r.category}` : ''}
                </div>
              </div>
              {i === 0 && loading === false && (
                <span className="text-[10.5px] bg-green-soft text-green-text px-[7px] py-[2px] rounded font-medium shrink-0">
                  top match
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Promoted "create new" — always visible */}
      <button
        type="button"
        onClick={onCreateNew}
        className="w-full flex items-center gap-3 px-[13px] py-3 bg-blue-soft/60 border border-blue rounded-lg hover:bg-blue-soft transition-colors"
      >
        <span className="w-[22px] h-[22px] rounded-full bg-blue-text text-paper inline-flex items-center justify-center shrink-0">
          <Plus size={13} />
        </span>
        <div className="flex-1 min-w-0 text-left">
          <div className="text-[11px] text-blue-text uppercase tracking-[0.05em] mb-[2px]">Or create new</div>
          <div className="text-[13px] text-blue-text font-medium truncate">"{defaultQuery}"</div>
        </div>
        <span className="text-[10px] text-blue font-mono px-1.5 py-0.5 bg-blue-soft rounded">⏎</span>
      </button>
    </div>
  )
}

// ─── CaseStructureEditor ──────────────────────────────────────────────────────
// "1 cs → [pkgQty] pkg × [pkgSize] [uom] per pkg"
// Live derived summary: "total per case: 12 L · cost per ml: $0.0046"

export function CaseStructureEditor({
  item,
  onChange,
}: {
  item: ScanItem
  onChange: (patch: Partial<Pick<ScanItem, 'invoicePackQty' | 'invoicePackSize' | 'invoicePackUOM'>>) => void
}) {
  const [pq,   setPq]   = useState(item.invoicePackQty  ? String(Number(item.invoicePackQty))  : '')
  const [ps,   setPs]   = useState(item.invoicePackSize ? String(Number(item.invoicePackSize)) : '')
  const [pUOM, setPUOM] = useState(item.invoicePackUOM  ?? '')

  const totalPerCase = (parseFloat(pq) || 0) * (parseFloat(ps) || 0)
  const unitPrice    = item.rawUnitPrice ? Number(item.rawUnitPrice) : null
  const costPerUnit  = unitPrice && totalPerCase > 0 ? unitPrice / totalPerCase : null

  const flush = (patch: Partial<Pick<ScanItem, 'invoicePackQty' | 'invoicePackSize' | 'invoicePackUOM'>>) => {
    onChange(patch)
  }

  return (
    <div>
      {/* Inline editor row */}
      <div className="flex items-center gap-[7px] text-[13.5px] tabular-nums flex-wrap">
        <span className="text-ink-3">
          {item.rawQty ? `${Number(item.rawQty)} cs` : '1 cs'}
        </span>
        <ArrowRight size={14} className="text-line-2" />
        <input
          type="number"
          step="any"
          min="0"
          value={pq}
          onChange={e => setPq(e.target.value)}
          onBlur={() => flush({ invoicePackQty: pq || null })}
          className="w-[50px] h-8 text-center font-semibold border border-line rounded bg-paper text-sm focus:outline-none focus:border-blue focus:ring-[3px] focus:ring-blue/10"
        />
        <span className="text-ink-3">pkg</span>
        <span className="text-line-2 mx-0.5">×</span>
        <input
          type="number"
          step="any"
          min="0"
          value={ps}
          onChange={e => setPs(e.target.value)}
          onBlur={() => flush({ invoicePackSize: ps || null })}
          className="w-[50px] h-8 text-center font-semibold border border-line rounded bg-paper text-sm focus:outline-none focus:border-blue focus:ring-[3px] focus:ring-blue/10"
        />
        <select
          value={pUOM}
          onChange={e => { setPUOM(e.target.value); flush({ invoicePackUOM: e.target.value || null }) }}
          className="h-8 px-2 border border-line rounded bg-paper text-sm font-medium focus:outline-none focus:border-blue"
        >
          <option value="">—</option>
          {PACK_UOMS.map(u => <option key={u} value={u}>{u}</option>)}
        </select>
        <span className="text-ink-3">per pkg</span>
      </div>

      {/* Derived summary */}
      {totalPerCase > 0 && pUOM && (
        <div className="mt-[9px] pt-[9px] border-t border-dashed border-line text-[11.5px] text-ink-3 flex items-center gap-2 flex-wrap tabular-nums">
          <span className="text-ink-4">total per case:</span>
          <strong className="text-ink">{totalPerCase} {pUOM}</strong>
          {costPerUnit !== null && (
            <>
              <span className="text-line-2">·</span>
              <span className="text-ink-4">cost per {pUOM}:</span>
              <strong className="text-ink">{formatCurrency(costPerUnit)}</strong>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ─── InvoiceMathFields ────────────────────────────────────────────────────────
// Two-column grid of editable pricing fields.
// NO silent auto-recompute — three fields are independent. When they disagree,
// MismatchPanel renders below with three labelled fix actions.

export function InvoiceMathFields({
  item,
  mode,
  onMode,
  onChange,
}: {
  item: ScanItem
  mode: 'per_case' | 'per_weight'
  onMode: (m: 'per_case' | 'per_weight') => void
  onChange: (patch: Partial<Pick<ScanItem,
    'rawQty' | 'rawUnit' | 'rawUnitPrice' | 'rawLineTotal' |
    'totalQty' | 'totalQtyUOM' | 'rate' | 'rateUOM'
  >>) => void
}) {
  // Per-case fields
  const [qty,       setQty]       = useState(item.rawQty          ? String(Number(item.rawQty))          : '')
  const [unitPrice, setUnitPrice] = useState(item.rawUnitPrice    ? String(Number(item.rawUnitPrice))    : '')
  const [lineTotal, setLineTotal] = useState(item.rawLineTotal    ? String(Number(item.rawLineTotal))    : '')
  // Per-weight fields
  const [wQty,      setWQty]      = useState(item.totalQty        ? String(Number(item.totalQty))        : '')
  const [wQtyUOM,   setWQtyUOM]   = useState(item.totalQtyUOM     ?? item.rateUOM ?? 'kg')
  const [rate,      setRate]      = useState(item.rate            ? String(Number(item.rate))            : '')
  const [rateUOM,   setRateUOM]   = useState(item.rateUOM         ?? 'lb')
  const [wTotal,    setWTotal]    = useState(item.rawLineTotal     ? String(Number(item.rawLineTotal))    : '')

  // Track which fields were edited this session (for blue tint)
  const [edited, setEdited] = useState<Set<string>>(new Set())
  const markEdited = (field: string) => setEdited(prev => new Set(prev).add(field))

  // Dismiss-panel state
  const [panelDismissed, setPanelDismissed] = useState(false)

  // Build a ScanItem snapshot from current local state to feed computeLineMath
  const localItem: ScanItem = {
    ...item,
    rawQty:        mode === 'per_case' ? (qty       || null) : item.rawQty,
    rawUnitPrice:  mode === 'per_case' ? (unitPrice || null) : null,
    rawLineTotal:  mode === 'per_case' ? (lineTotal || null) : (wTotal || null),
    totalQty:      mode === 'per_weight' ? (wQty    || null) : item.totalQty,
    totalQtyUOM:   mode === 'per_weight' ? wQtyUOM           : item.totalQtyUOM,
    rate:          mode === 'per_weight' ? (rate    || null) : item.rate,
    rateUOM:       mode === 'per_weight' ? rateUOM           : item.rateUOM,
    pricingMode:   mode,
  }

  const math = computeLineMath(localItem)
  const showPanel = !panelDismissed && math !== null && !math.matches && edited.size > 0

  // Reset dismiss when item changes
  useEffect(() => { setPanelDismissed(false); setEdited(new Set()) }, [item.id])

  const inputBase = 'h-8 border rounded text-sm tabular-nums transition-colors focus:outline-none focus:border-blue focus:ring-[3px] focus:ring-blue/10'
  const editedCls = (field: string) => edited.has(field) ? 'border-blue bg-blue-soft' : 'border-line bg-paper'

  return (
    <div>
      {/* Card header */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10.5px] text-ink-4 uppercase tracking-[0.06em] font-medium">
          Invoice math
        </span>
        <ModeToggle mode={mode} onChange={m => { onMode(m); setPanelDismissed(false); setEdited(new Set()) }} />
      </div>

      {mode === 'per_case' ? (
        <div className="grid grid-cols-2 gap-2.5 text-[12px]">
          {/* Qty shipped */}
          <div>
            <div className="flex items-center justify-between mb-[5px]">
              <span className="text-ink-3 text-[11.5px]">qty shipped</span>
              {edited.has('qty') && <span className="text-[9px] text-blue font-medium uppercase tracking-wide">edited</span>}
            </div>
            <div className="flex gap-1.5">
              <input
                type="number" step="any" min="0"
                value={qty}
                onChange={e => { setQty(e.target.value); markEdited('qty') }}
                onBlur={() => onChange({ rawQty: qty || null })}
                className={`flex-1 px-2 text-center ${inputBase} ${editedCls('qty')}`}
              />
              <select
                className="h-8 px-1.5 border border-line rounded bg-paper text-sm font-medium focus:outline-none"
              >
                <option>cs</option>
              </select>
            </div>
          </div>

          {/* Unit price */}
          <div>
            <div className="flex items-center justify-between mb-[5px]">
              <span className="text-ink-3 text-[11.5px]">unit price</span>
              {edited.has('unitPrice') && <span className="text-[9px] text-blue font-medium uppercase tracking-wide">edited</span>}
            </div>
            <div className={`flex items-center gap-1.5 px-2.5 h-8 border rounded transition-colors ${editedCls('unitPrice')} ${edited.has('unitPrice') ? 'focus-within:border-blue' : 'focus-within:border-blue focus-within:ring-[3px] focus-within:ring-blue/10'}`}>
              <span className="text-ink-4 text-[12.5px]">$</span>
              <input
                type="number" step="any" min="0"
                value={unitPrice}
                onChange={e => { setUnitPrice(e.target.value); markEdited('unitPrice') }}
                onBlur={() => onChange({ rawUnitPrice: unitPrice || null })}
                className="flex-1 bg-transparent border-none outline-none text-sm font-medium tabular-nums"
              />
              <span className="text-ink-4 text-[12.5px]">/ cs</span>
            </div>
          </div>

          {/* Line total — full width */}
          <div className="col-span-2">
            <div className="flex items-center justify-between mb-[5px]">
              <span className="text-ink-3 text-[11.5px]">line total</span>
              {edited.has('lineTotal') && <span className="text-[9px] text-blue font-medium uppercase tracking-wide">edited</span>}
            </div>
            <div className={`flex items-center gap-1.5 px-2.5 h-8 border rounded transition-colors ${editedCls('lineTotal')} focus-within:border-blue focus-within:ring-[3px] focus-within:ring-blue/10`}>
              <span className="text-ink-4 text-[12.5px]">$</span>
              <input
                type="number" step="any" min="0"
                value={lineTotal}
                onChange={e => { setLineTotal(e.target.value); markEdited('lineTotal') }}
                onBlur={() => onChange({ rawLineTotal: lineTotal || null })}
                className="flex-1 bg-transparent border-none outline-none text-sm font-medium tabular-nums"
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2.5 text-[12px]">
          {/* Qty shipped (weight) */}
          <div>
            <div className="flex items-center justify-between mb-[5px]">
              <span className="text-ink-3 text-[11.5px]">qty shipped</span>
              {edited.has('wQty') && <span className="text-[9px] text-blue font-medium uppercase tracking-wide">edited</span>}
            </div>
            <div className="flex gap-1.5">
              <input
                type="number" step="any" min="0"
                value={wQty}
                onChange={e => { setWQty(e.target.value); markEdited('wQty') }}
                onBlur={() => onChange({ totalQty: wQty || null, totalQtyUOM: wQtyUOM })}
                className={`flex-1 px-2 text-center ${inputBase} ${editedCls('wQty')}`}
              />
              <select
                value={wQtyUOM}
                onChange={e => { setWQtyUOM(e.target.value); onChange({ totalQtyUOM: e.target.value }) }}
                className="h-8 px-1.5 border border-line rounded bg-paper text-sm font-medium focus:outline-none"
              >
                {['lb', 'kg', 'g', 'oz'].map(u => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
          </div>

          {/* Rate */}
          <div>
            <div className="flex items-center justify-between mb-[5px]">
              <span className="text-ink-3 text-[11.5px]">rate</span>
              {edited.has('rate') && <span className="text-[9px] text-blue font-medium uppercase tracking-wide">edited</span>}
            </div>
            <div className={`flex items-center gap-1.5 px-2.5 h-8 border rounded transition-colors ${editedCls('rate')} focus-within:border-blue focus-within:ring-[3px] focus-within:ring-blue/10`}>
              <span className="text-ink-4 text-[12.5px]">$</span>
              <input
                type="number" step="any" min="0"
                value={rate}
                onChange={e => { setRate(e.target.value); markEdited('rate') }}
                onBlur={() => onChange({ rate: rate || null, rateUOM })}
                className="flex-1 min-w-0 bg-transparent border-none outline-none text-sm font-medium tabular-nums"
              />
              <span className="text-ink-4 text-[12.5px] shrink-0">/ {rateUOM}</span>
            </div>
          </div>

          {/* Line total */}
          <div className="col-span-2">
            <div className="flex items-center justify-between mb-[5px]">
              <span className="text-ink-3 text-[11.5px]">line total</span>
              {edited.has('wTotal') && <span className="text-[9px] text-blue font-medium uppercase tracking-wide">edited</span>}
            </div>
            <div className={`flex items-center gap-1.5 px-2.5 h-8 border rounded transition-colors ${editedCls('wTotal')} focus-within:border-blue focus-within:ring-[3px] focus-within:ring-blue/10`}>
              <span className="text-ink-4 text-[12.5px]">$</span>
              <input
                type="number" step="any" min="0"
                value={wTotal}
                onChange={e => { setWTotal(e.target.value); markEdited('wTotal') }}
                onBlur={() => onChange({ rawLineTotal: wTotal || null })}
                className="flex-1 bg-transparent border-none outline-none text-sm font-medium tabular-nums"
              />
            </div>
          </div>
        </div>
      )}

      {/* Check row */}
      {math && (
        <div className="mt-[11px] pt-[9px] border-t border-dashed border-line flex items-center justify-between text-[11.5px] tabular-nums">
          <div>
            <span className="text-ink-4">check: </span>
            <span className="text-ink-2 ml-1">
              {mode === 'per_case'
                ? `${qty || '?'} × ${unitPrice ? formatCurrency(Number(unitPrice)) : '?'} = ${formatCurrency(math.computed)}`
                : `${wQty || '?'} × ${rate ? formatCurrency(Number(rate)) : '?'} = ${formatCurrency(math.computed)}`
              }
            </span>
          </div>
          {math.matches ? (
            <span className="flex items-center gap-1 text-green-text font-medium">
              <Check size={12} /> matches invoice
            </span>
          ) : (
            <span className="flex items-center gap-1 text-gold-2">
              <AlertTriangle size={12} /> {formatCurrency(Math.abs(math.delta))} off
            </span>
          )}
        </div>
      )}

      {/* Inline mismatch resolution */}
      {showPanel && math && (
        <MismatchPanel
          computed={math.computed}
          entered={math.entered}
          onAcceptComputed={() => {
            if (mode === 'per_case') {
              setLineTotal(math.computed.toFixed(2))
              onChange({ rawLineTotal: math.computed.toFixed(2) })
            } else {
              setWTotal(math.computed.toFixed(2))
              onChange({ rawLineTotal: math.computed.toFixed(2) })
            }
            setPanelDismissed(true)
          }}
          onRevertPrice={() => {
            if (mode === 'per_case') {
              const q = parseFloat(qty)
              if (q > 0 && math.entered > 0) {
                const reverted = (math.entered / q).toFixed(4)
                setUnitPrice(reverted)
                onChange({ rawUnitPrice: reverted })
              }
            } else {
              const q = parseFloat(wQty)
              if (q > 0 && math.entered > 0) {
                const reverted = (math.entered / q).toFixed(4)
                setRate(reverted)
                onChange({ rate: reverted })
              }
            }
            setPanelDismissed(true)
          }}
          onKeepAsIs={() => setPanelDismissed(true)}
        />
      )}
    </div>
  )
}

// ─── MismatchPanel ────────────────────────────────────────────────────────────
// Amber resolution UI when line math doesn't agree.

export function MismatchPanel({
  computed,
  entered,
  suggestedValue,
  onAcceptComputed,
  onRevertPrice,
  onKeepAsIs,
}: {
  computed: number
  entered: number
  suggestedValue?: number | null   // from reconcileInvoiceTotals (invoice-level suggestion)
  onAcceptComputed: () => void
  onRevertPrice: () => void
  onKeepAsIs: () => void
}) {
  const delta = computed - entered

  return (
    <div className="mt-[11px] bg-gold-soft rounded-lg p-3">
      {/* Header */}
      <div className="flex gap-2 items-start mb-[10px]">
        <AlertTriangle size={15} className="text-gold-2 mt-0.5 shrink-0" />
        <div className="flex-1 text-[12px] text-gold-2">
          <div className="font-semibold mb-1">Line total may be off</div>
          <div className="space-y-0.5 tabular-nums leading-[1.7]">
            <div>scanned line total: <strong>{formatCurrency(entered)}</strong></div>
            <div>computed from fields: <strong>{formatCurrency(computed)}</strong></div>
            <div className="border-t border-[#fcd34d]/60/60 pt-1 mt-1 font-medium">
              Δ <strong>{formatCurrency(Math.abs(delta))}</strong>
              {' '}{delta > 0 ? 'missing' : 'extra'}
            </div>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="text-[11px] text-gold-2 font-medium mb-[7px]">What&apos;s correct?</div>
      <div className="flex gap-1.5 flex-wrap">
        <button
          type="button"
          onClick={onAcceptComputed}
          className="flex items-center gap-1.5 text-[11px] px-[11px] py-[5px] bg-paper border border-gold text-gold-2 rounded hover:bg-gold-soft transition-colors font-medium"
        >
          <ArrowRight size={11} />
          use {formatCurrency(computed)}
        </button>
        <button
          type="button"
          onClick={onRevertPrice}
          className="flex items-center gap-1.5 text-[11px] px-[11px] py-[5px] bg-paper border border-gold text-gold-2 rounded hover:bg-gold-soft transition-colors"
        >
          <RotateCcw size={11} />
          revert price
        </button>
        {suggestedValue !== undefined && suggestedValue !== null && (
          <button
            type="button"
            onClick={onAcceptComputed}
            className="flex items-center gap-1.5 text-[11px] px-[11px] py-[5px] bg-paper border border-gold text-gold-2 rounded hover:bg-gold-soft transition-colors"
          >
            <ZoomIn size={11} />
            view on invoice
          </button>
        )}
      </div>
      <div className="mt-[9px] pt-2 border-t border-[#fcd34d]/60 text-[11px] text-gold-2">
        Or{' '}
        <button
          type="button"
          onClick={onKeepAsIs}
          className="underline underline-offset-2 hover:text-gold-2 transition-colors"
        >
          keep as-is and flag for review
        </button>{' '}
        — discrepancy stays on invoice-level math check.
      </div>
    </div>
  )
}

// ─── ReconcileBanner ──────────────────────────────────────────────────────────
// Subtle amber collapsible banner in the invoice header when sum-of-lines
// doesn't match the OCR'd subtotal.

export function ReconcileBanner({
  reconciliation,
  onRecheck,
}: {
  reconciliation: ReconcileResult
  onRecheck?: () => void
}) {
  const [open, setOpen] = useState(false)

  if (reconciliation.status !== 'mismatch') return null

  const { delta, sumOfLines, invoiceSubtotal } = reconciliation

  return (
    <div className="mt-[13px] bg-gold-soft/80 border-l-2 border-gold-2 rounded-r-lg overflow-hidden">
      {/* Summary row */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-[12px] text-gold-2 hover:bg-gold-soft/50 transition-colors text-left"
      >
        <AlertTriangle size={14} className="text-gold-2 shrink-0" />
        <span className="flex-1">
          <strong>{formatCurrency(Math.abs(delta))} mismatch</strong>
          {' '}— sum of lines doesn&apos;t tie to invoice subtotal.
          {reconciliation.suggestedFixItemId && ' 1 line flagged.'}
        </span>
        <ChevronDown
          size={14}
          className={`text-gold-2 shrink-0 transition-transform duration-[180ms] ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {/* Expanded breakdown */}
      {open && (
        <div className="px-3 pb-3 pt-0 text-[12px] text-gold-2 border-t border-[#fcd34d]/60/50 tabular-nums">
          <div className="space-y-0 leading-[1.9] mt-2">
            <div className="flex justify-between">
              <span>Sum of line items</span>
              <span className="font-medium">{formatCurrency(sumOfLines)}</span>
            </div>
            <div className="flex justify-between">
              <span>Invoice subtotal</span>
              <span className="font-medium">{invoiceSubtotal !== null ? formatCurrency(invoiceSubtotal) : '—'}</span>
            </div>
            <div className="flex justify-between border-t border-[#fcd34d]/60/60 pt-1 mt-1 font-medium">
              <span>Δ {delta > 0 ? 'missing' : 'extra'}</span>
              <span>{formatCurrency(Math.abs(delta))}</span>
            </div>
          </div>
          {onRecheck && (
            <div className="flex justify-end mt-2">
              <button
                type="button"
                onClick={onRecheck}
                className="text-[11px] px-2.5 py-1 border border-gold rounded text-gold-2 hover:bg-gold-soft transition-colors"
              >
                Recheck OCR
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── ChipRow ──────────────────────────────────────────────────────────────────
// Filter chips + sort toggle. Shows up to 4 chips; overflow becomes "+N more".

const CHIP_ORDER: FilterKey[] = ['needsLink', 'mathCheck', 'formatMismatch', 'modeMismatch', 'priceDelta', 'catchweight']
const MAX_VISIBLE_CHIPS = 4

export function ChipRow({
  totalCount,
  counts,
  activeFilters,
  onToggle,
  sortMode,
  onSort,
}: {
  totalCount: number
  counts: Record<FilterKey, number>
  activeFilters: Set<FilterKey>
  onToggle: (k: FilterKey) => void
  sortMode: SortMode
  onSort: (m: SortMode) => void
}) {
  const [overflowOpen, setOverflowOpen] = useState(false)

  const withCounts = CHIP_ORDER.filter(k => counts[k] > 0)
  const visible  = withCounts.slice(0, MAX_VISIBLE_CHIPS)
  const overflow = withCounts.slice(MAX_VISIBLE_CHIPS)

  return (
    <div className="flex items-center gap-1.5 px-[22px] py-[11px] bg-paper border-b border-line flex-nowrap overflow-x-auto">
      {/* All chip */}
      <button
        type="button"
        onClick={() => activeFilters.size > 0 && onToggle(Array.from(activeFilters)[0])}
        className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[12px] border transition-colors whitespace-nowrap ${
          activeFilters.size === 0
            ? 'bg-ink text-paper border-ink font-medium'
            : 'border-line-2 text-ink-2 hover:bg-bg'
        }`}
      >
        All {totalCount}
      </button>

      {/* Filter chips */}
      {visible.map(k => {
        const active = activeFilters.has(k)
        const isWarn   = ['needsLink', 'mathCheck', 'formatMismatch', 'modeMismatch'].includes(k)
        const ringCls  = k === 'needsLink' ? 'bg-red' : isWarn ? 'bg-gold' : 'bg-blue'
        return (
          <button
            key={k}
            type="button"
            onClick={() => onToggle(k)}
            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[12px] border transition-colors whitespace-nowrap ${
              active
                ? 'bg-ink text-paper border-ink font-medium'
                : 'border-line-2 text-ink-2 hover:bg-bg'
            }`}
          >
            {!active && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${ringCls}`} />}
            {FILTER_LABELS[k]} {counts[k]}
          </button>
        )
      })}

      {/* Overflow */}
      {overflow.length > 0 && (
        <div className="relative">
          <button
            type="button"
            onClick={() => setOverflowOpen(o => !o)}
            className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-[12px] border border-dashed border-line-2 text-ink-3 hover:bg-bg whitespace-nowrap"
          >
            +{overflow.length} more
          </button>
          {overflowOpen && (
            <div className="absolute top-full left-0 mt-1 bg-paper border border-line rounded-lg shadow-lg z-10 py-1 min-w-[160px]">
              {overflow.map(k => (
                <button
                  key={k}
                  type="button"
                  onClick={() => { onToggle(k); setOverflowOpen(false) }}
                  className="w-full text-left px-3 py-2 text-[12px] text-ink-2 hover:bg-bg flex items-center justify-between"
                >
                  <span>{FILTER_LABELS[k]}</span>
                  <span className="text-ink-4 ml-4">{counts[k]}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex-1" />

      {/* Sort toggle */}
      <button
        type="button"
        onClick={() => {
          const modes: SortMode[] = ['invoice', 'priceDelta', 'unlinked']
          const next = modes[(modes.indexOf(sortMode) + 1) % modes.length]
          onSort(next)
        }}
        className="inline-flex items-center gap-1 text-[12px] text-ink-3 hover:text-ink transition-colors whitespace-nowrap px-2 py-1 shrink-0"
      >
        <ChevronDown size={12} className="rotate-180" />
        {sortMode === 'invoice' ? 'invoice order' : sortMode === 'priceDelta' ? 'price delta' : 'unlinked first'}
      </button>
    </div>
  )
}

```


---

## `src/components/invoices/v2/issues.tsx`

```tsx
'use client'
// Issue blocks for the redesigned line card. One `.issue` primitive — a coloured
// badge + plain-English description + a row of decision buttons — replaces the
// three different warning languages the old drawer used (mock §1, §3, §7).

import { ArrowRight, Check } from 'lucide-react'
import { IssueBadge, ActButton, VariancePill, type IssueKind } from './atoms'
import { useDrawerContext } from './context'
import { computeNormalisedPrices } from '@/lib/invoice/calculations'
import { formatCurrency } from '@/lib/invoice/formatters'
import { derivePricingMode } from '@/lib/invoice/predicates'
import type { ScanItem } from '@/components/invoices/types'

// ─── IssueShell ────────────────────────────────────────────────────────────────
// Badge + description on one row, actions below. The container border/divider is
// supplied by the card; here we only own the badge/desc/actions stack.

function IssueShell({
  kind,
  label,
  children,
  actions,
  resolved = false,
}: {
  kind: IssueKind
  label: string
  children: React.ReactNode
  actions: React.ReactNode
  /** Decision made — render the block in a green, acknowledged state. */
  resolved?: boolean
}) {
  return (
    <div className={`px-4 py-2.5 border-b border-dashed border-line last:border-b-0 flex flex-col gap-2.5 transition-colors ${resolved ? 'bg-green-soft/40' : ''}`}>
      <div className="flex items-start gap-2.5">
        {resolved ? (
          <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.02em] px-2 py-[3px] rounded-full bg-green-soft text-green-text shrink-0 inline-flex items-center gap-1">
            <Check size={10} /> {label}
          </span>
        ) : (
          <IssueBadge kind={kind}>{label}</IssueBadge>
        )}
        <div className="text-[12.5px] text-ink-2 leading-[1.45] min-w-0">{children}</div>
      </div>
      <div className="flex gap-1.5 flex-wrap pl-0">{actions}</div>
    </div>
  )
}

// ─── ModeIssue ───────────────────────────────────────────────────────────────
// Invoice prices per-weight but the product defaults per-case (or vice versa).
// Two explicit choices: write the mode back to the product, or treat this line
// in the product's mode just for this invoice.

export function ModeIssue({ item, lineId }: { item: ScanItem; lineId: string }) {
  const ctx = useDrawerContext()
  const detected = derivePricingMode(item)
  const detectedLbl = detected === 'per_weight' ? 'per-weight' : 'per-case'
  const productMode = item.matchedItem?.priceType === 'UOM' ? 'per-weight' : 'per-case'
  const writeback = ctx.modeWritebackItems.has(lineId)

  return (
    <IssueShell
      kind="mode"
      label="Mode mismatch"
      resolved={writeback}
      actions={
        <>
          <ActButton
            variant={writeback ? 'primary' : 'default'}
            onClick={() => { if (!writeback) ctx.toggleModeWriteback(lineId) }}
          >
            Switch product to {detectedLbl}
          </ActButton>
          <ActButton
            variant={!writeback ? 'primary' : 'default'}
            onClick={() => {
              if (writeback) ctx.toggleModeWriteback(lineId)
              // Treat this line in the product's mode for this invoice only.
              ctx.updateLine(lineId, { pricingMode: detected === 'per_weight' ? 'per_case' : 'per_weight' })
            }}
          >
            Treat as {productMode} this time
          </ActButton>
        </>
      }
    >
      Invoice is <b className="font-semibold text-ink">{detectedLbl}</b> but{' '}
      <b className="font-semibold text-ink">{item.matchedItem?.itemName}</b> defaults to{' '}
      <b className="font-semibold text-ink">{productMode}</b>. The two unit systems give
      different costs downstream.
    </IssueShell>
  )
}

// ─── NewSkuIssue ───────────────────────────────────────────────────────────────
// The line didn't match any inventory item. Create it, search to link, or skip.

export function NewSkuIssue({ item, lineId }: { item: ScanItem; lineId: string }) {
  const ctx = useDrawerContext()
  return (
    <IssueShell
      kind="sku"
      label="New ingredient"
      actions={
        <>
          <ActButton variant="primary" onClick={() => ctx.openCreateNew(item)}>
            Create &ldquo;{item.rawDescription}&rdquo;
          </ActButton>
          <ActButton onClick={() => ctx.startLinkPicker(lineId)}>Search inventory</ActButton>
          <ActButton variant="danger" onClick={() => ctx.updateLine(lineId, { action: 'SKIP' })}>
            Skip (no inventory write)
          </ActButton>
        </>
      }
    >
      This SKU isn&rsquo;t in your inventory yet. Create it now, or link to an existing item.
    </IssueShell>
  )
}

// ─── PriceCompare ──────────────────────────────────────────────────────────────
// The was → now card. Normalised $/base-unit on both sides + delta pill.

export function PriceCompare({ item }: { item: ScanItem }) {
  const norm = computeNormalisedPrices(item)
  if (!norm) return null
  const factor   = norm.baseUnit === 'g' || norm.baseUnit === 'ml' ? 1000 : 1
  const rateUnit = norm.baseUnit === 'g' ? 'kg' : norm.baseUnit === 'ml' ? 'L' : 'each'
  const prev = norm.inventoryPPB * factor
  const next = norm.invoicePPB * factor
  const pct  = norm.pctDiff

  return (
    <div className="grid grid-cols-[1fr_24px_1fr] gap-2.5 items-center bg-bg border border-line rounded-lg px-3 py-2.5">
      <div className="flex flex-col gap-0.5">
        <span className="font-mono text-[9.5px] uppercase tracking-[0.02em] text-ink-4">Inventory has</span>
        <span className="font-mono text-[13px] font-semibold text-ink tabular-nums">{formatCurrency(prev)} / {rateUnit}</span>
      </div>
      <ArrowRight size={14} className="text-line-2 mx-auto" />
      <div className="flex flex-col gap-0.5">
        <span className="font-mono text-[9.5px] uppercase tracking-[0.02em] text-ink-4">Invoice says</span>
        <span className="font-mono text-[13px] font-semibold text-red-text tabular-nums">{formatCurrency(next)} / {rateUnit}</span>
      </div>
      {Math.abs(pct) >= 0.1 && (
        <div className="col-span-3 flex items-center gap-2 pt-2 border-t border-dashed border-line">
          <VariancePill percent={Math.abs(pct)} direction={pct > 0 ? 'up' : 'down'} />
          <span className="font-mono text-[11px] text-ink-3">re-costs every recipe that uses this ingredient</span>
        </div>
      )}
    </div>
  )
}

// ─── PriceIssue ────────────────────────────────────────────────────────────────
// Big price jump on a linked item. Accept (the spine writes the new price),
// fix a UOM error in the math below, or dispute (skip — no write).

export function PriceIssue({
  item,
  lineId,
  onFixUom,
}: {
  item: ScanItem
  lineId: string
  onFixUom: () => void
}) {
  const ctx = useDrawerContext()
  const acked = ctx.acknowledgedPriceLines.has(lineId)
  const norm = computeNormalisedPrices(item)
  const pct = norm ? norm.pctDiff : (item.priceDiffPct ? Number(item.priceDiffPct) : 0)
  const factor = norm && (norm.baseUnit === 'g' || norm.baseUnit === 'ml') ? 1000 : 1
  const rateUnit = norm ? (norm.baseUnit === 'g' ? 'kg' : norm.baseUnit === 'ml' ? 'L' : 'each') : ''

  return (
    <IssueShell
      kind="price"
      label={`Price ${pct > 0 ? '↑' : '↓'} ${Math.abs(pct).toFixed(0)}%`}
      resolved={acked}
      actions={
        <>
          <ActButton variant={acked ? 'primary' : 'default'} onClick={() => ctx.acknowledgePrice(lineId)}>
            {acked ? 'New price accepted' : 'Accept new price'}
          </ActButton>
          <ActButton onClick={onFixUom}>It&rsquo;s a UOM error → fix</ActButton>
          <ActButton variant="danger" onClick={() => ctx.updateLine(lineId, { action: 'SKIP' })}>
            Dispute
          </ActButton>
        </>
      }
    >
      {norm ? (
        <>
          Was <b className="font-semibold text-ink">{formatCurrency(norm.inventoryPPB * factor)} / {rateUnit}</b>.
          This one bills at <b className="font-semibold text-ink">{formatCurrency(norm.invoicePPB * factor)} / {rateUnit}</b>.
          {Math.abs(pct) > 1000 && ' Almost certainly a UOM mistake — confirm before it re-costs your recipes.'}
        </>
      ) : (
        <>This line&rsquo;s price moved <b className="font-semibold text-ink">{Math.abs(pct).toFixed(1)}%</b> from the last invoice — confirm before approving.</>
      )}
      {norm && <div className="mt-2"><PriceCompare item={item} /></div>}
    </IssueShell>
  )
}

```


---

## `src/components/invoices/v2/InvoiceReviewDrawer.tsx`

```tsx
'use client'
// Phase 5 — InvoiceReviewDrawer: the top-level container.
// Owns all shared state, provides DrawerContext, and renders the drawer panel.

import {
  useState, useEffect, useCallback, useMemo, useRef,
} from 'react'
import { X, Check, Loader2, AlertTriangle, ChevronUp, ChevronDown, TrendingUp, TrendingDown, RotateCcw, Package, BookOpen, Tag, Search } from 'lucide-react'
import { DrawerContext, type DrawerContextValue } from './context'
import { LineItemCard } from './card'
import { type ReconcileResult } from './composites'
import { ActButton, IssueBadge } from './atoms'
import { ImpactStrip, AlertBanner, ReviewProgress, SectionDivider, type ImpactMetric, type ReviewSegment } from './chrome'
import { ImageViewerV2, type BBox } from './ImageViewer'
import { useRc } from '@/contexts/RevenueCenterContext'
import { InventoryItemDrawer } from '@/components/inventory/InventoryItemDrawer'
import type { Session, ScanItem, SessionSummary } from '@/components/invoices/types'
import type { RevenueCenter } from '@/contexts/RevenueCenterContext'
import { reconcileInvoiceTotals } from '@/lib/invoice/calculations'
import {
  type FilterKey, type SortMode,
} from '@/lib/invoice/filters'
import {
  isUnlinked, hasMathCheck, hasModeMismatch, hasFormatMismatch,
} from '@/lib/invoice/predicates'
import { lineUnresolved, isCharge, isBigPriceChange } from '@/lib/invoice/resolution'
import { formatCurrency } from '@/lib/invoice/formatters'
import { PACK_UOMS, PURCHASE_UNITS, calcPricePerBaseUnit } from '@/lib/utils'

// ─── InvoiceHeader ─────────────────────────────────────────────────────────────

function supplierInitials(name: string | null): string {
  if (!name) return '??'
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '??'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

function InvoiceHeader({
  session,
  onClose,
  queuePos,
  onPrev,
  onNext,
}: {
  session: Session
  onClose: () => void
  queuePos: { idx: number; total: number }
  onPrev?: () => void
  onNext?: () => void
}) {
  const total    = session.total    ? Number(session.total)    : null
  const subtotal = session.subtotal ? Number(session.subtotal) : null
  const tax      = session.tax      ? Number(session.tax)      : null
  const itemCount = session.scanItems.filter(i => i.action !== 'SKIP').length

  const metaParts: string[] = []
  if (session.invoiceNumber) metaParts.push(`#${session.invoiceNumber}`)
  if (session.invoiceDate)   metaParts.push(session.invoiceDate)
  metaParts.push(`${itemCount} line${itemCount !== 1 ? 's' : ''}`)

  return (
    <div
      className="grid grid-cols-[32px_1fr_auto_auto] items-center gap-4 px-[22px] py-[16px] bg-paper border-b border-line"
      style={{ paddingTop: 'calc(16px + env(safe-area-inset-top, 0px))' }}
    >
      {/* Close */}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close drawer"
        className="w-8 h-8 grid place-items-center rounded-lg border border-line text-ink-3 hover:border-ink-4 hover:text-ink-2 transition-colors"
      >
        <X size={16} />
      </button>

      {/* Avatar + title + meta */}
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-9 h-9 rounded-[9px] bg-ink text-paper grid place-items-center font-mono text-[12px] font-semibold shrink-0">
          {supplierInitials(session.supplierName)}
        </div>
        <div className="min-w-0">
          <h2 className="font-medium text-[23px] leading-[1.1] tracking-[-0.02em] text-ink truncate">
            {session.supplierName ?? 'Unknown supplier'}
          </h2>
          <div className="font-mono text-[11px] text-ink-4 mt-[3px] flex items-center gap-2 flex-wrap">
            {metaParts.map((p, i) => (
              <span key={p} className="flex items-center gap-2">
                {i > 0 && <span className="text-line-2">·</span>}
                {p}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Total */}
      <div className="text-right pr-1.5">
        <div className="font-mono text-[28px] font-semibold tracking-[-0.02em] text-ink tabular-nums leading-none">
          {total !== null ? formatCurrency(total) : '—'}
        </div>
        {(subtotal !== null || tax !== null) && (
          <div className="font-mono text-[10.5px] text-ink-4 mt-[3px] tabular-nums">
            {subtotal !== null && `sub ${formatCurrency(subtotal)}`}
            {subtotal !== null && tax !== null && ' · '}
            {tax !== null && `tax ${formatCurrency(tax)}`}
          </div>
        )}
      </div>

      {/* Prev / next in queue */}
      <div className="hidden md:flex items-center gap-1">
        <button
          type="button"
          onClick={onPrev}
          disabled={!onPrev}
          aria-label="Previous invoice"
          className="w-7 h-7 grid place-items-center rounded-[7px] border border-line text-ink-4 hover:border-ink-4 hover:text-ink-2 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronUp size={13} className="-rotate-90" />
        </button>
        <span className="font-mono text-[10.5px] text-ink-4 px-1.5 tabular-nums">{queuePos.idx} / {queuePos.total}</span>
        <button
          type="button"
          onClick={onNext}
          disabled={!onNext}
          aria-label="Next invoice"
          className="w-7 h-7 grid place-items-center rounded-[7px] border border-line text-ink-4 hover:border-ink-4 hover:text-ink-2 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronDown size={13} className="-rotate-90" />
        </button>
      </div>
    </div>
  )
}

// ─── DrawerFooter ──────────────────────────────────────────────────────────────
// Commits, doesn't decide (mock §4). Left = a plain-English summary of exactly
// what approving writes; right = Reject + the one ink-on-gold Approve & post.

function DrawerFooter({
  priceWrites,
  newItems,
  supplierLink,
  canApprove,
  disabledReason,
  onApprove,
  onReject,
  saveStatus,
}: {
  priceWrites: number
  newItems: number
  supplierLink: boolean
  canApprove: boolean
  disabledReason: string
  onApprove: () => void
  onReject: () => void
  saveStatus: 'idle' | 'saving' | 'error'
}) {
  const parts: string[] = []
  parts.push(`${priceWrites} price${priceWrites !== 1 ? 's' : ''} to inventory`)
  if (newItems > 0) parts.push(`creates ${newItems} new item${newItems !== 1 ? 's' : ''}`)
  if (supplierLink) parts.push('links 1 supplier')

  return (
    <div
      className="grid grid-cols-[1fr_auto] gap-4 items-center px-[22px] py-3 bg-paper border-t border-line shrink-0"
      style={{ paddingBottom: 'calc(14px + env(safe-area-inset-bottom, 0px))' }}
    >
      <div className="min-w-0">
        <div className="text-[12.5px] text-ink-3 leading-[1.5]">
          Approve writes <b className="text-ink-2 font-medium">{parts.join(', ')}</b>, and re-costs the recipes that use them.
        </div>
        <div className="font-mono text-[10.5px] text-ink-4 mt-[3px] flex items-center gap-2.5">
          <span className="inline-flex items-center gap-1.5"><span className="w-[5px] h-[5px] rounded-full bg-gold" /> Reversible — re-open any time</span>
          {saveStatus === 'saving' && <span className="inline-flex items-center gap-1 text-ink-4"><Loader2 size={11} className="animate-spin" /> saving</span>}
          {saveStatus === 'error'  && <span className="inline-flex items-center gap-1 text-red"><AlertTriangle size={11} /> save failed</span>}
        </div>
      </div>
      <div className="flex gap-2 shrink-0">
        <button
          type="button"
          onClick={onReject}
          className="px-4 py-2.5 text-[13.5px] font-medium text-ink-3 bg-paper border border-line rounded-[9px] hover:border-ink-4 hover:text-ink transition-colors"
        >
          Reject invoice
        </button>
        <button
          type="button"
          onClick={onApprove}
          disabled={!canApprove}
          title={disabledReason}
          className={`inline-flex items-center gap-2 px-[18px] py-2.5 text-[13.5px] font-medium rounded-[9px] transition-colors ${
            canApprove
              ? 'bg-ink text-paper hover:bg-ink-2'
              : 'bg-line text-ink-4 cursor-not-allowed'
          }`}
        >
          <Check size={14} className={canApprove ? 'text-gold' : ''} />
          Approve &amp; post
          <span className="font-mono text-[9.5px] px-1.5 py-0.5 rounded bg-paper/15 text-bg">⌘ ⏎</span>
        </button>
      </div>
    </div>
  )
}

// ─── InvoiceReviewDrawer ───────────────────────────────────────────────────────

export function InvoiceReviewDrawer({
  sessionId,
  onClose,
  onApproveOrReject,
  onNavigate,
  allSessions = [],
}: {
  sessionId: string | null
  onClose: () => void
  onApproveOrReject: () => void
  onNavigate?: (id: string) => void
  allSessions?: SessionSummary[]
}) {
  const { revenueCenters } = useRc()

  // Lock background scroll while the drawer is open — otherwise wheel events over
  // a non-scrolling area of the drawer (PDF pane, header, gaps) chain through to
  // the page behind it. The page's scroll container is <html>, not <body>, so we
  // must lock the documentElement (locking body alone has no effect here).
  useEffect(() => {
    if (sessionId === null) return
    const html = document.documentElement
    const prevHtml = html.style.overflow
    const prevBody = document.body.style.overflow
    html.style.overflow = 'hidden'
    document.body.style.overflow = 'hidden'
    return () => { html.style.overflow = prevHtml; document.body.style.overflow = prevBody }
  }, [sessionId])

  // ── Session data ────────────────────────────────────────────────────────────
  const [session,     setSession]     = useState<Session | null>(null)
  const [loading,     setLoading]     = useState(false)
  const [saveStatus,  setSaveStatus]  = useState<'idle' | 'saving' | 'error'>('idle')
  const [approving,   setApproving]   = useState(false)
  const [approved,    setApproved]    = useState(false)

  // ── Supplier linking ────────────────────────────────────────────────────────
  const [linkedSupplierId,  setLinkedSupplierId]  = useState<string | null>(null)
  const [supplierComboOpen, setSupplierComboOpen] = useState(false)
  const [supplierSearch,    setSupplierSearch]    = useState('')
  const [allSuppliers, setAllSuppliers] = useState<Array<{ id: string; name: string }>>([])

  const loadSuppliers = useCallback(async () => {
    if (allSuppliers.length > 0) return
    try {
      const data = await fetch('/api/suppliers').then(r => r.ok ? r.json() : [])
      setAllSuppliers(Array.isArray(data) ? data : (data.suppliers ?? []))
    } catch {}
  }, [allSuppliers.length])

  const handleLinkSupplier = useCallback(async (supplierId: string) => {
    if (!session) return
    setLinkedSupplierId(supplierId)
    setSupplierComboOpen(false)
    setSupplierSearch('')
    await fetch(`/api/invoices/sessions/${session.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ supplierId }),
    })
  }, [session])

  const fetchSession = useCallback(async (id: string) => {
    setLoading(true)
    try {
      const res  = await fetch(`/api/invoices/sessions/${id}`)
      const data = await res.json()
      setSession(data)
      setLinkedSupplierId(data.supplierId ?? null)
    } finally {
      setLoading(false)
    }
  }, [])

  // Silent refresh — updates session data without showing the loading spinner,
  // so child component state (expanded cards, staged edits) is preserved.
  const refreshSession = useCallback(async (id: string) => {
    try {
      const res  = await fetch(`/api/invoices/sessions/${id}`)
      const data = await res.json()
      setSession(data)
    } catch { /* ignore — stale session data stays on screen */ }
  }, [])

  useEffect(() => {
    if (!sessionId) { setSession(null); return }
    setApproved(false)
    fetchSession(sessionId)
  }, [sessionId, fetchSession])

  // ── UI state ────────────────────────────────────────────────────────────────
  const [editedLines,       setEditedLines]       = useState<Map<string, Partial<ScanItem>>>(new Map())
  const [expandedLineIds,   setExpandedLineIds]   = useState<Set<string>>(new Set())
  const [flashingLineIds,   setFlashingLineIds]   = useState<Set<string>>(new Set())
  const [activeFilters,     setActiveFilters]     = useState<Set<FilterKey>>(new Set())
  const [sortMode,          setSortMode]          = useState<SortMode>('invoice')
  const [pickingLinkForId,  setPickingLinkForId]  = useState<string | null>(null)
  const [modeWritebackItems, setModeWritebackItems] = useState<Set<string>>(new Set())
  const [acknowledgedPriceLines, setAcknowledgedPriceLines] = useState<Set<string>>(new Set())
  const [creatingNewForItem,      setCreatingNewForItem]      = useState<ScanItem | null>(null)
  const [editingInventoryItemId,  setEditingInventoryItemId]  = useState<string | null>(null)
  const [activeBboxItemId,   setActiveBboxItemId]    = useState<string | null>(null)
  const [mobileTab,          setMobileTab]          = useState<'review' | 'image'>('review')
  const [reviewSegment,      setReviewSegment]      = useState<ReviewSegment>('all')
  const [supplierSkipped,    setSupplierSkipped]    = useState(false)
  const [bannerDismissed,    setBannerDismissed]    = useState(false)
  // Snapshot of which lines needed attention at load — the stable denominator
  // for the "X of N resolved" progress bar.
  const [initialAttention,   setInitialAttention]   = useState<{ lineIds: Set<string>; supplier: boolean }>({ lineIds: new Set(), supplier: false })

  // Ref for the scrollable list container
  const listRef = useRef<HTMLDivElement>(null)

  // ── Auto-expand attention items when session first loads ────────────────────
  useEffect(() => {
    if (!session) return
    const toExpand = new Set(
      session.scanItems
        .filter(i => i.action !== 'SKIP' && (isUnlinked(i) || hasMathCheck(i) || hasModeMismatch(i)))
        .map(i => i.id),
    )
    setExpandedLineIds(toExpand)
    setEditedLines(new Map())
    setActiveFilters(new Set())
    setSortMode('invoice')
    setPickingLinkForId(null)
    setModeWritebackItems(new Set())
    setAcknowledgedPriceLines(new Set())
    setActiveBboxItemId(null)
    setMobileTab('review')
    setReviewSegment('all')
    setSupplierSkipped(false)
    setBannerDismissed(false)

    // Snapshot the lines that need a decision at load — the progress denominator.
    const attentionIds = new Set(
      session.scanItems
        .filter(i => i.action !== 'SKIP' && (
          isUnlinked(i) || hasMathCheck(i) || hasModeMismatch(i) || hasFormatMismatch(i) || isBigPriceChange(i)
        ))
        .map(i => i.id),
    )
    setInitialAttention({ lineIds: attentionIds, supplier: !session.supplierId })
  }, [session])

  // ── Computed data ────────────────────────────────────────────────────────────
  const effectiveLines = useMemo(() => {
    if (!session) return []
    return session.scanItems.map(item => {
      const edits = editedLines.get(item.id)
      return edits ? { ...item, ...edits } : item
    })
  }, [session, editedLines])

  const reconciliation = useMemo<ReconcileResult | null>(() => {
    if (!session) return null
    const sub = session.subtotal ? Number(session.subtotal) : null
    const r   = reconcileInvoiceTotals(effectiveLines, sub)
    return r
  }, [session, effectiveLines])

  // Per-line resolution options (mode writeback / price acknowledgement).
  const optsFor = useCallback(
    (id: string) => ({ modeWriteback: modeWritebackItems.has(id), priceAck: acknowledgedPriceLines.has(id) }),
    [modeWritebackItems, acknowledgedPriceLines],
  )

  const lineIsAttention = useCallback((i: ScanItem) =>
    isUnlinked(i) || hasModeMismatch(i) || hasFormatMismatch(i) || hasMathCheck(i) || isBigPriceChange(i),
  [])

  // Group lines into the mock's three sections + per-line invoice numbering.
  const sections = useMemo(() => {
    const active  = effectiveLines.filter(i => !isCharge(i))
    const charges = effectiveLines.filter(i => isCharge(i))
    const ordered        = [...active].sort((a, b) => a.sortOrder - b.sortOrder)
    const orderedCharges = [...charges].sort((a, b) => a.sortOrder - b.sortOrder)
    const displayNo = new Map<string, number>()
    ordered.forEach((i, idx) => displayNo.set(i.id, idx + 1))
    orderedCharges.forEach((i, idx) => displayNo.set(i.id, ordered.length + idx + 1))
    return {
      attention: ordered.filter(lineIsAttention),
      matched:   ordered.filter(i => !lineIsAttention(i)),
      charges:   orderedCharges,
      displayNo,
      activeCount: active.length,
    }
  }, [effectiveLines, lineIsAttention])

  const supplierNeedsLink = !linkedSupplierId && !supplierSkipped

  // Progress bar — stable denominator from the load-time snapshot.
  const progress = useMemo(() => {
    const total = initialAttention.lineIds.size + (initialAttention.supplier ? 1 : 0)
    let resolved = 0
    for (const id of initialAttention.lineIds) {
      const line = effectiveLines.find(l => l.id === id)
      if (!line || isCharge(line) || !lineUnresolved(line, optsFor(id))) resolved++
    }
    if (initialAttention.supplier && (linkedSupplierId || supplierSkipped)) resolved++
    return { total, resolved }
  }, [effectiveLines, initialAttention, optsFor, linkedSupplierId, supplierSkipped])

  // Approve gate — computed over CURRENT state so edits that introduce a new
  // issue re-block approval (the snapshot above only fixes the progress total).
  const currentlyUnresolved =
    sections.attention.filter(i => lineUnresolved(i, optsFor(i.id))).length +
    (supplierNeedsLink && initialAttention.supplier ? 1 : 0)
  const canApprove = currentlyUnresolved === 0
  const disabledReason = canApprove
    ? ''
    : `${currentlyUnresolved} ${currentlyUnresolved === 1 ? 'issue needs' : 'issues need'} a decision`

  // Impact-strip + footer metrics (only what's computable before approve).
  const priceWrites   = effectiveLines.filter(i => i.action !== 'SKIP' && i.matchedItemId).length
  const newItemsCount = effectiveLines.filter(i => i.action === 'CREATE_NEW').length
  const impactMetrics: ImpactMetric[] = [
    { label: 'Inventory writes', value: `${priceWrites} price${priceWrites !== 1 ? 's' : ''}` },
    ...(newItemsCount > 0 ? [{ label: 'New items', value: String(newItemsCount) }] : []),
    {
      label: 'Supplier',
      value: linkedSupplierId ? 'linked' : supplierSkipped ? 'skipped' : 'link pending',
      tone: (linkedSupplierId || supplierSkipped) ? undefined : ('warn' as const),
    },
  ]

  const segmentCounts = { all: sections.activeCount, issues: sections.attention.length, matched: sections.matched.length }

  // ── Review queue navigation (prev/next invoice in the inbox) ────────────────
  const reviewQueueIds = useMemo(
    () => allSessions.filter(s => s.status === 'REVIEW').map(s => s.id),
    [allSessions],
  )
  const queueIdx  = session ? reviewQueueIds.indexOf(session.id) : -1
  const queuePos  = { idx: queueIdx >= 0 ? queueIdx + 1 : 1, total: Math.max(reviewQueueIds.length, 1) }
  const navPrev   = onNavigate && queueIdx > 0 ? () => onNavigate(reviewQueueIds[queueIdx - 1]) : undefined
  const navNext   = onNavigate && queueIdx >= 0 && queueIdx < reviewQueueIds.length - 1
    ? () => onNavigate(reviewQueueIds[queueIdx + 1]) : undefined

  // ── Duplicate detection ─────────────────────────────────────────────────────
  const duplicateSessions = useMemo(() => {
    if (!session?.invoiceNumber) return []
    return allSessions.filter(s =>
      s.id !== session.id && s.invoiceNumber === session.invoiceNumber
    )
  }, [session, allSessions])

  // ── Context helpers ─────────────────────────────────────────────────────────
  const getEffectiveLine = useCallback((id: string): ScanItem => {
    const base  = session?.scanItems.find(i => i.id === id)
    if (!base) throw new Error(`Line ${id} not found`)
    const edits = editedLines.get(id)
    return edits ? { ...base, ...edits } : base
  }, [session, editedLines])

  const getItemRc = useCallback((id: string): RevenueCenter | null => {
    const line = getEffectiveLine(id)
    if (!line.revenueCenterId) return null
    return revenueCenters.find(rc => rc.id === line.revenueCenterId) ?? null
  }, [getEffectiveLine, revenueCenters])

  // ── Line mutations ──────────────────────────────────────────────────────────
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const persistEdit = useCallback(async (id: string, patch: Partial<ScanItem>) => {
    if (!session) return
    setSaveStatus('saving')
    try {
      const res = await fetch(`/api/invoices/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanItemId: id, ...patch }),
      })
      if (!res.ok) setSaveStatus('error')
      else setSaveStatus('idle')
    } catch {
      setSaveStatus('error')
    }
  }, [session])

  const updateLine = useCallback((id: string, patch: Partial<ScanItem>) => {
    setEditedLines(prev => {
      const next = new Map(prev)
      next.set(id, { ...prev.get(id), ...patch })
      return next
    })
    // Debounce the server save by 600ms to batch rapid field edits
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => persistEdit(id, patch), 600)
  }, [persistEdit])

  const clearLineEdits = useCallback((id: string) => {
    setEditedLines(prev => {
      const next = new Map(prev)
      next.delete(id)
      return next
    })
  }, [])

  // ── Expand / collapse ───────────────────────────────────────────────────────
  const toggleExpand = useCallback((id: string, forceOpen?: boolean) => {
    setExpandedLineIds(prev => {
      const next = new Set(prev)
      const willOpen = forceOpen || !next.has(id)
      if (willOpen) next.add(id)
      else next.delete(id)
      // Track which item to highlight in the image viewer
      setActiveBboxItemId(willOpen ? id : null)
      return next
    })
  }, [])

  // Pending scroll target — set by J/K navigation, consumed after expand.
  const scrollPendingRef = useRef<string | null>(null)

  // After expandedLineIds updates, handle pending scroll + flash
  useEffect(() => {
    const lineId = scrollPendingRef.current
    if (!lineId) return
    scrollPendingRef.current = null
    const el = listRef.current?.querySelector(`[data-line-id="${lineId}"]`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setFlashingLineIds(prev => new Set(prev).add(lineId))
    setTimeout(() => {
      setFlashingLineIds(prev => {
        const next = new Set(prev)
        next.delete(lineId)
        return next
      })
    }, 1400)
  }, [expandedLineIds])

  // ── RC assignment ───────────────────────────────────────────────────────────
  const setLineRc = useCallback((id: string, rc: RevenueCenter | null) => {
    updateLine(id, { revenueCenterId: rc?.id ?? null })
  }, [updateLine])

  // ── Filters / sort ──────────────────────────────────────────────────────────
  const toggleFilter = useCallback((k: FilterKey) => {
    setActiveFilters(prev => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }, [])

  // ── Mode writeback ──────────────────────────────────────────────────────────
  const toggleModeWriteback = useCallback((id: string) => {
    setModeWritebackItems(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // ── Price-change acknowledgement ─────────────────────────────────────────────
  const acknowledgePrice = useCallback((id: string) => {
    setAcknowledgedPriceLines(prev => new Set(prev).add(id))
  }, [])

  // ── Approve ─────────────────────────────────────────────────────────────────
  const handleApprove = async () => {
    if (!session) return
    setApproving(true)
    try {
      const res    = await fetch(`/api/invoices/sessions/${session.id}/approve`, { method: 'POST' })
      const result = await res.json()
      if (!res.ok) {
        alert(`Approval failed: ${result.error ?? res.statusText}`)
        return
      }
      setApproved(true)
      onApproveOrReject()
      if (result.queued) onClose()
    } catch {
      alert('Network error — please try again.')
    } finally {
      setApproving(false)
    }
  }

  // ── Reject ──────────────────────────────────────────────────────────────────
  const handleReject = async () => {
    if (!session) return
    const ok = window.confirm('Reject this invoice? It will be marked as rejected and no prices will be updated.')
    if (!ok) return
    await fetch(`/api/invoices/sessions/${session.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'REJECTED' }),
    })
    onApproveOrReject()
    onClose()
  }

  // ── Keyboard model (mock §6): Esc close · ⌘⏎ approve · R reject · J/K nav ────
  const visibleIdsRef = useRef<string[]>([])
  const focusedIdRef  = useRef<string | null>(null)

  const focusLine = useCallback((id: string) => {
    focusedIdRef.current = id
    scrollPendingRef.current = id
    toggleExpand(id, true)
  }, [toggleExpand])

  useEffect(() => {
    const reviewing = !!session && !approved && !approving
      && session.status !== 'APPROVED' && session.status !== 'REJECTED'
    if (!reviewing) return
    // Don't steal keys while a nested modal is open.
    if (creatingNewForItem || editingInventoryItemId) return

    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)

      if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        if (canApprove) handleApprove()
        return
      }
      if (typing) return
      if (e.key === 'r' || e.key === 'R') { e.preventDefault(); handleReject(); return }
      if (e.key === '[' && navPrev) { e.preventDefault(); navPrev(); return }
      if (e.key === ']' && navNext) { e.preventDefault(); navNext(); return }
      if (e.key === 'j' || e.key === 'J' || e.key === 'k' || e.key === 'K' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const ids = visibleIdsRef.current
        if (ids.length === 0) return
        e.preventDefault()
        const down = e.key === 'j' || e.key === 'J' || e.key === 'ArrowDown'
        const cur  = focusedIdRef.current ? ids.indexOf(focusedIdRef.current) : -1
        const next = down
          ? ids[Math.min(cur + 1, ids.length - 1)] ?? ids[0]
          : ids[Math.max(cur - 1, 0)] ?? ids[0]
        focusLine(next)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [session, approved, approving, creatingNewForItem, editingInventoryItemId, canApprove, navPrev, navNext, focusLine, onClose]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the J/K navigation order in sync with what's actually rendered.
  useEffect(() => {
    const ids: string[] = []
    if (reviewSegment !== 'matched') ids.push(...sections.attention.map(i => i.id))
    if (reviewSegment !== 'issues')  ids.push(...sections.matched.map(i => i.id))
    if (reviewSegment === 'all')     ids.push(...sections.charges.map(i => i.id))
    visibleIdsRef.current = ids
  }, [sections, reviewSegment])

  // ── Compute active bbox for the image viewer ────────────────────────────────
  const activeBbox = useMemo<BBox | null>(() => {
    if (!activeBboxItemId) return null
    const line = session?.scanItems.find(i => i.id === activeBboxItemId)
    const edits = editedLines.get(activeBboxItemId)
    const effective = edits ? { ...line, ...edits } : line
    const b = effective?.bbox
    if (!b || typeof b !== 'object') return null
    const bb = b as Record<string, unknown>
    if (
      typeof bb.x !== 'number' || typeof bb.y !== 'number' ||
      typeof bb.w !== 'number' || typeof bb.h !== 'number'
    ) return null
    return { page: typeof bb.page === 'number' ? bb.page : 0, x: bb.x, y: bb.y, w: bb.w, h: bb.h }
  }, [activeBboxItemId, session, editedLines])

  // ── Context value ────────────────────────────────────────────────────────────
  const ctxValue = useMemo<DrawerContextValue>(() => ({
    lines: session?.scanItems ?? [],
    revenueCenters,
    editedLines,
    expandedLineIds,
    flashingLineIds,
    activeFilters,
    sortMode,
    pickingLinkForId,
    modeWritebackItems,
    acknowledgedPriceLines,
    reconciliation,
    getEffectiveLine,
    getItemRc,
    updateLine,
    clearLineEdits,
    toggleExpand,
    setLineRc,
    startLinkPicker: (id) => setPickingLinkForId(id),
    closeLinkPicker: ()   => setPickingLinkForId(null),
    openCreateNew:        (item) => setCreatingNewForItem(item),
    openInventoryEdit:    (id)   => setEditingInventoryItemId(id),
    toggleModeWriteback,
    acknowledgePrice,
    activeBboxItemId,
    toggleFilter,
    setSortMode,
  }), [
    session, revenueCenters, editedLines, expandedLineIds, flashingLineIds,
    activeFilters, sortMode, pickingLinkForId, modeWritebackItems, acknowledgedPriceLines, reconciliation,
    getEffectiveLine, getItemRc, updateLine, clearLineEdits, toggleExpand,
    setLineRc, toggleModeWriteback, acknowledgePrice, activeBboxItemId, toggleFilter,
  ])

  // ── Panel open/close animation ───────────────────────────────────────────────
  const isOpen = sessionId !== null

  return (
    <>
      {/* Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/25 z-40 transition-opacity"
          onClick={onClose}
        />
      )}

      {/* Drawer panel — wider to fit image viewer + review side by side */}
      <div
        className={`fixed inset-y-0 right-0 z-[60] bg-paper shadow-2xl flex flex-col transition-transform duration-300 ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
        style={{
          width: (!approved && session?.status !== 'APPROVED' && session?.status !== 'REJECTED' && session?.files?.length)
            ? '1340px' : '620px',
          maxWidth: '100vw',
        }}
      >
        {loading || !session ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 size={28} className="text-line-2 animate-spin" />
          </div>
        ) : approved || session.status === 'APPROVED' || session.status === 'REJECTED' ? (
          <ApprovedView
            session={session}
            onClose={onClose}
            onReviewAgain={() => {
              setApproved(false)
              onApproveOrReject()
              fetchSession(session.id)
            }}
          />
        ) : (
          <DrawerContext.Provider value={ctxValue}>
            {/* Full-width header */}
            <InvoiceHeader
              session={session}
              onClose={onClose}
              queuePos={queuePos}
              onPrev={navPrev}
              onNext={navNext}
            />

            {/* Cost-chrome impact strip — Principle 01 */}
            <ImpactStrip metrics={impactMetrics} helper="on approve" />

            {/* Invoice-wide banners */}
            {duplicateSessions.length > 0 && !bannerDismissed && (
              <div className="flex items-center gap-3 bg-red-soft border-b border-[#fecaca] px-[22px] py-[11px] text-[13px] text-red-text">
                <AlertTriangle size={16} className="text-red shrink-0" strokeWidth={2.2} />
                <span className="flex-1 min-w-0">
                  <b className="font-semibold">Possible duplicate.</b>{' '}
                  Invoice #{session.invoiceNumber} was already scanned
                  {duplicateSessions[0].supplierName ? ` from ${duplicateSessions[0].supplierName}` : ''}{' '}
                  ({duplicateSessions[0].status.toLowerCase()}). Review carefully.
                </span>
                <button
                  type="button"
                  onClick={() => setBannerDismissed(true)}
                  className="font-mono text-[10.5px] font-semibold px-2.5 py-1 rounded-full bg-red/10 text-red-text hover:bg-red/20 transition-colors shrink-0"
                >
                  Dismiss
                </button>
              </div>
            )}
            {reconciliation?.status === 'mismatch' && !bannerDismissed && (
              <AlertBanner
                onIgnore={() => setBannerDismissed(true)}
                onShowFix={reconciliation.suggestedFixItemId ? () => setActiveBboxItemId(reconciliation.suggestedFixItemId) : undefined}
              >
                <b className="font-semibold">{formatCurrency(Math.abs(reconciliation.delta))} mismatch</b>
                {' '}— sum of lines doesn&rsquo;t tie to the invoice subtotal.
                {reconciliation.suggestedFixItemId && ' One line looks off.'}
              </AlertBanner>
            )}

            {/* Mobile tab bar — only shown on small screens when files exist */}
            {session.files.length > 0 && (
              <div className="md:hidden flex border-b border-line shrink-0">
                <button
                  onClick={() => setMobileTab('review')}
                  className={`flex-1 py-2.5 text-[13px] font-medium transition-colors ${
                    mobileTab === 'review'
                      ? 'text-ink border-b-2 border-ink'
                      : 'text-ink-4'
                  }`}
                >
                  Review items
                </button>
                <button
                  onClick={() => setMobileTab('image')}
                  className={`flex-1 py-2.5 text-[13px] font-medium transition-colors ${
                    mobileTab === 'image'
                      ? 'text-ink border-b-2 border-ink'
                      : 'text-ink-4'
                  }`}
                >
                  Invoice image
                </button>
              </div>
            )}

            {/* Body: image viewer (left) + review panel (right) on desktop;
                    tabs control which panel is visible on mobile */}
            <div className="flex flex-1 min-h-0 overflow-hidden">

              {/* ── Image viewer ───────────────────────────────────────────── */}
              {session.files.length > 0 && (
                <>
                  <div className={mobileTab === 'review' ? 'hidden md:contents' : 'contents'}>
                    <ImageViewerV2
                      files={session.files}
                      activeBbox={activeBbox}
                    />
                  </div>
                  <div className="hidden md:block w-px bg-line shrink-0" />
                </>
              )}

              {/* ── Review panel ───────────────────────────────────────────── */}
              <div className={`flex flex-col flex-1 min-w-0 min-h-0 md:flex-none md:w-[680px] overflow-hidden ${
                session.files.length > 0 && mobileTab === 'image' ? 'hidden md:flex' : 'flex'
              }`}>
                {/* Review progress + segmented filter */}
                <ReviewProgress
                  resolved={progress.resolved}
                  total={progress.total}
                  segment={reviewSegment}
                  onSegment={setReviewSegment}
                  counts={segmentCounts}
                />

                {/* Line item list — grouped by section */}
                <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-[18px] py-3 flex flex-col gap-1.5">
                  {/* Needs your attention */}
                  {(reviewSegment === 'all' || reviewSegment === 'issues') && (sections.attention.length > 0 || supplierNeedsLink) && (
                    <>
                      <SectionDivider
                        tone="red"
                        label="Needs your attention"
                        count={`${sections.attention.length + (supplierNeedsLink ? 1 : 0)} item${sections.attention.length + (supplierNeedsLink ? 1 : 0) !== 1 ? 's' : ''}`}
                      />
                      {supplierNeedsLink && (
                        <SupplierLinkCard
                          supplierName={session.supplierName}
                          comboOpen={supplierComboOpen}
                          suppliers={allSuppliers}
                          search={supplierSearch}
                          onSearch={setSupplierSearch}
                          onOpenCombo={() => { loadSuppliers(); setSupplierComboOpen(v => !v) }}
                          onPick={handleLinkSupplier}
                          onSkip={() => { setSupplierSkipped(true); setSupplierComboOpen(false) }}
                        />
                      )}
                      {sections.attention.map(i => (
                        <LineItemCard key={i.id} lineId={i.id} displayNo={sections.displayNo.get(i.id) ?? 0} />
                      ))}
                    </>
                  )}

                  {/* Auto-matched */}
                  {(reviewSegment === 'all' || reviewSegment === 'matched') && sections.matched.length > 0 && (
                    <>
                      <SectionDivider tone="green" label="Auto-matched" count={`${sections.matched.length} line${sections.matched.length !== 1 ? 's' : ''}`} />
                      {sections.matched.map(i => (
                        <LineItemCard key={i.id} lineId={i.id} displayNo={sections.displayNo.get(i.id) ?? 0} />
                      ))}
                    </>
                  )}

                  {/* Other line items (skipped / non-inventory) */}
                  {reviewSegment === 'all' && sections.charges.length > 0 && (
                    <>
                      <SectionDivider tone="neutral" label="Other line items" count={`${sections.charges.length} not inventory`} />
                      {sections.charges.map(i => (
                        <LineItemCard key={i.id} lineId={i.id} displayNo={sections.displayNo.get(i.id) ?? 0} />
                      ))}
                    </>
                  )}

                  {sections.attention.length === 0 && sections.matched.length === 0 && sections.charges.length === 0 && (
                    <div className="flex items-center justify-center h-32 text-[13px] text-ink-4">No line items.</div>
                  )}
                </div>

                {/* Footer */}
                {!approving ? (
                  <DrawerFooter
                    priceWrites={priceWrites}
                    newItems={newItemsCount}
                    supplierLink={initialAttention.supplier && !!linkedSupplierId}
                    canApprove={canApprove}
                    disabledReason={disabledReason}
                    onApprove={handleApprove}
                    onReject={handleReject}
                    saveStatus={saveStatus}
                  />
                ) : (
                  <div
                    className="border-t border-line px-[18px] py-[13px] flex items-center justify-center gap-3 shrink-0"
                    style={{ paddingBottom: 'calc(13px + env(safe-area-inset-bottom, 0px))' }}
                  >
                    <Loader2 size={16} className="animate-spin text-ink-3" />
                    <span className="text-[13px] text-ink-3">Approving…</span>
                  </div>
                )}
              </div>
            </div>
          </DrawerContext.Provider>
        )}
      </div>

      {/* Inventory item edit — overlays the invoice drawer */}
      {editingInventoryItemId && (
        <InventoryItemDrawer
          itemId={editingInventoryItemId}
          onClose={() => setEditingInventoryItemId(null)}
          onUpdated={() => { if (session) refreshSession(session.id) }}
        />
      )}

      {/* Create new item mini-modal */}
      {creatingNewForItem && (
        <AddNewItemModal
          item={creatingNewForItem}
          sessionId={session?.id ?? ''}
          onSaved={() => {
            if (creatingNewForItem) {
              updateLine(creatingNewForItem.id, {
                action: 'CREATE_NEW',
                isNewItem: true,
                matchedItemId: null,
                matchedItem: null,
              })
            }
            setCreatingNewForItem(null)
            if (session) refreshSession(session.id)
          }}
          onClose={() => setCreatingNewForItem(null)}
        />
      )}
    </>
  )
}

// ─── ApprovedView ──────────────────────────────────────────────────────────────
// Full read-only view for APPROVED / REJECTED sessions.

function ApprovedView({
  session,
  onClose,
  onReviewAgain,
}: {
  session: Session
  onClose: () => void
  onReviewAgain: () => void
}) {
  const [priceAlertsOpen,  setPriceAlertsOpen]  = useState(true)
  const [recipeAlertsOpen, setRecipeAlertsOpen] = useState(true)
  const [reverting,        setReverting]        = useState(false)

  const rejected  = session.status === 'REJECTED'
  const total     = session.total    ? Number(session.total)    : null
  const subtotal  = session.subtotal ? Number(session.subtotal) : null
  const tax       = session.tax      ? Number(session.tax)      : null

  const activeItems   = session.scanItems.filter(i => i.action !== 'SKIP')
  const updatedItems  = session.scanItems.filter(i => i.action === 'UPDATE_PRICE' && i.approved)
  const newItems      = session.scanItems.filter(i => i.isNewItem && i.approved)
  const skippedItems  = session.scanItems.filter(i => i.action === 'SKIP')

  const metaParts: string[] = []
  if (session.invoiceNumber) metaParts.push(`#${session.invoiceNumber}`)
  if (session.invoiceDate)   metaParts.push(session.invoiceDate)
  metaParts.push(`${activeItems.length} line${activeItems.length !== 1 ? 's' : ''}`)

  const handleReviewAgain = async () => {
    setReverting(true)
    try {
      await fetch(`/api/invoices/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'REVIEW' }),
      })
      onReviewAgain()
    } finally {
      setReverting(false)
    }
  }

  return (
    <div className="flex flex-col h-full">

      {/* ── Header ── */}
      <div
        className={`px-[22px] pt-[18px] pb-[16px] border-b border-line ${rejected ? 'bg-paper' : 'bg-gradient-to-r from-green-soft/60 to-white'}`}
        style={{ paddingTop: 'calc(18px + env(safe-area-inset-top, 0px))' }}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5 mb-[5px]">
              <div className={`flex items-center gap-1.5 px-2.5 py-[3px] rounded-full text-[11px] font-semibold ${
                rejected
                  ? 'bg-red-soft text-red-text'
                  : 'bg-green-soft text-green-text'
              }`}>
                {rejected ? <X size={10} /> : <Check size={10} />}
                {rejected ? 'Rejected' : 'Applied'}
              </div>
            </div>
            <h2 className="text-[19px] font-semibold text-ink leading-[1.2] truncate">
              {session.supplierName ?? 'Unknown supplier'}
            </h2>
            <p className="text-[12.5px] text-ink-4 mt-[3px]">{metaParts.join(' · ')}</p>
          </div>

          <div className="text-right shrink-0">
            <div className="text-[24px] font-semibold text-ink leading-none tabular-nums">
              {total !== null ? formatCurrency(total) : '—'}
            </div>
            {(subtotal !== null || tax !== null) && (
              <div className="text-[11.5px] text-ink-4 mt-[4px] tabular-nums">
                {subtotal !== null && `sub ${formatCurrency(subtotal)}`}
                {subtotal !== null && tax !== null && ' · '}
                {tax !== null && `tax ${formatCurrency(tax)}`}
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={onClose}
            className="shrink-0 p-2.5 flex items-center justify-center rounded-lg text-ink-4 hover:text-ink-2 hover:bg-bg-2 transition-colors"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="flex-1 overflow-y-auto">

        {/* Summary stat cards */}
        {!rejected && (
          <div className="px-[18px] pt-[16px] pb-[4px] grid grid-cols-4 gap-3">
            <div className="bg-bg border border-bg-2 rounded-xl p-3 text-center">
              <div className="text-[22px] font-semibold text-ink tabular-nums leading-none">{updatedItems.length}</div>
              <div className="text-[11px] text-ink-4 mt-1">prices updated</div>
            </div>
            <div className="bg-bg border border-bg-2 rounded-xl p-3 text-center">
              <div className="text-[22px] font-semibold text-ink tabular-nums leading-none">{newItems.length}</div>
              <div className="text-[11px] text-ink-4 mt-1">new items</div>
            </div>
            <div className="bg-bg border border-bg-2 rounded-xl p-3 text-center">
              <div className="text-[22px] font-semibold text-ink tabular-nums leading-none">{session.priceAlerts.length}</div>
              <div className="text-[11px] text-ink-4 mt-1">price alerts</div>
            </div>
            <div className="bg-bg border border-bg-2 rounded-xl p-3 text-center">
              <div className="text-[22px] font-semibold text-ink tabular-nums leading-none">{session.recipeAlerts.length}</div>
              <div className="text-[11px] text-ink-4 mt-1">recipe impacts</div>
            </div>
          </div>
        )}

        {/* ── Line items ── */}
        <div className="px-[18px] pt-[16px]">
          <p className="text-[11px] font-semibold text-ink-4 uppercase tracking-wider mb-2">Line items</p>
          <div className="border border-bg-2 rounded-xl overflow-hidden divide-y divide-bg-2">
            {session.scanItems.map(item => {
              const prevPrice = item.previousPrice ? Number(item.previousPrice) : null
              const newPrice  = item.newPrice      ? Number(item.newPrice)      : null
              const diffPct   = item.priceDiffPct  ? Number(item.priceDiffPct)  : null
              const lineTotal = item.rawLineTotal  ? Number(item.rawLineTotal)  : null
              const isSkip    = item.action === 'SKIP'
              const isNew     = item.isNewItem && item.approved
              const isUpdate  = item.action === 'UPDATE_PRICE' && item.approved

              return (
                <div key={item.id} className={`flex items-center gap-3 px-4 py-3 ${isSkip ? 'opacity-40' : ''}`}>
                  {/* Icon */}
                  <div className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${
                    isNew    ? 'bg-green-soft'  :
                    isUpdate ? 'bg-blue-soft'      :
                    isSkip   ? 'bg-bg-2'    : 'bg-bg'
                  }`}>
                    {isNew    ? <Package  size={13} className="text-green-text" /> :
                     isSkip   ? <X        size={13} className="text-ink-4"   /> :
                                <Tag      size={13} className="text-blue"    />}
                  </div>

                  {/* Name + badge */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[13px] font-medium text-ink-2 truncate">
                        {item.matchedItem?.itemName ?? item.rawDescription}
                      </span>
                      {isNew && (
                        <span className="text-[10px] font-semibold px-1.5 py-[1px] rounded bg-green-soft text-green-text">NEW</span>
                      )}
                      {isSkip && (
                        <span className="text-[10px] font-semibold px-1.5 py-[1px] rounded bg-bg-2 text-ink-4">SKIPPED</span>
                      )}
                    </div>
                    {item.rawDescription !== item.matchedItem?.itemName && item.matchedItem && (
                      <div className="text-[11px] text-ink-4 truncate mt-0.5">{item.rawDescription}</div>
                    )}
                  </div>

                  {/* Price change */}
                  {!isSkip && !isNew && prevPrice !== null && newPrice !== null ? (
                    <div className="shrink-0 text-right">
                      <div className="flex items-center gap-1.5 justify-end">
                        <span className="text-[12px] text-ink-4 line-through tabular-nums">{formatCurrency(prevPrice)}</span>
                        <span className="text-[12px] font-medium text-ink-2 tabular-nums">{formatCurrency(newPrice)}</span>
                        {diffPct !== null && (
                          <span className={`text-[11px] font-semibold ${diffPct > 0 ? 'text-red' : 'text-green-text'}`}>
                            {diffPct > 0 ? '+' : ''}{diffPct.toFixed(1)}%
                          </span>
                        )}
                      </div>
                      {lineTotal !== null && (
                        <div className="text-[11px] text-ink-4 mt-0.5 tabular-nums">{formatCurrency(lineTotal)}</div>
                      )}
                    </div>
                  ) : lineTotal !== null ? (
                    <div className="shrink-0 text-[12px] text-ink-3 tabular-nums">{formatCurrency(lineTotal)}</div>
                  ) : null}
                </div>
              )
            })}
          </div>
        </div>

        {/* ── Price alerts ── */}
        {session.priceAlerts.length > 0 && (
          <div className="px-[18px] pt-[16px]">
            <button
              type="button"
              onClick={() => setPriceAlertsOpen(v => !v)}
              className="w-full flex items-center justify-between mb-2 group"
            >
              <p className="text-[11px] font-semibold text-ink-4 uppercase tracking-wider">
                Price alerts ({session.priceAlerts.length})
              </p>
              {priceAlertsOpen
                ? <ChevronUp   size={14} className="text-ink-4 group-hover:text-ink-3" />
                : <ChevronDown size={14} className="text-ink-4 group-hover:text-ink-3" />}
            </button>
            {priceAlertsOpen && (
              <div className="border border-bg-2 rounded-xl overflow-hidden divide-y divide-bg-2">
                {session.priceAlerts.map(alert => {
                  const prev    = Number(alert.previousPrice)
                  const next    = Number(alert.newPrice)
                  const pct     = Number(alert.changePct)
                  const up      = alert.direction === 'UP'
                  return (
                    <div key={alert.id} className="flex items-center gap-3 px-4 py-3">
                      <div className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${up ? 'bg-red-soft' : 'bg-green-soft'}`}>
                        {up
                          ? <TrendingUp   size={13} className="text-red"     />
                          : <TrendingDown size={13} className="text-green-text" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <span className="text-[13px] font-medium text-ink-2">{alert.inventoryItem.itemName}</span>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="flex items-center gap-1.5 justify-end">
                          <span className="text-[12px] text-ink-4 line-through tabular-nums">{formatCurrency(prev)}</span>
                          <span className="text-[12px] font-medium text-ink-2 tabular-nums">{formatCurrency(next)}</span>
                          <span className={`text-[11px] font-semibold ${up ? 'text-red' : 'text-green-text'}`}>
                            {up ? '+' : ''}{pct.toFixed(1)}%
                          </span>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* ── Recipe impacts ── */}
        {session.recipeAlerts.length > 0 && (
          <div className="px-[18px] pt-[16px]">
            <button
              type="button"
              onClick={() => setRecipeAlertsOpen(v => !v)}
              className="w-full flex items-center justify-between mb-2 group"
            >
              <p className="text-[11px] font-semibold text-ink-4 uppercase tracking-wider">
                Recipe impacts ({session.recipeAlerts.length})
              </p>
              {recipeAlertsOpen
                ? <ChevronUp   size={14} className="text-ink-4 group-hover:text-ink-3" />
                : <ChevronDown size={14} className="text-ink-4 group-hover:text-ink-3" />}
            </button>
            {recipeAlertsOpen && (
              <div className="border border-bg-2 rounded-xl overflow-hidden divide-y divide-bg-2">
                {session.recipeAlerts.map(alert => {
                  const prevCost  = Number(alert.previousCost)
                  const newCost   = Number(alert.newCost)
                  const pct       = Number(alert.changePct)
                  const foodCost  = alert.newFoodCostPct ? Number(alert.newFoodCostPct) : null
                  const up        = pct > 0
                  return (
                    <div key={alert.id} className="flex items-center gap-3 px-4 py-3">
                      <div className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${up ? 'bg-orange-50' : 'bg-green-soft'}`}>
                        <BookOpen size={13} className={up ? 'text-orange-500' : 'text-green-text'} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <span className="text-[13px] font-medium text-ink-2">{alert.recipe.name}</span>
                        {foodCost !== null && (
                          <div className="text-[11px] text-ink-4 mt-0.5">food cost {foodCost.toFixed(1)}%</div>
                        )}
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="flex items-center gap-1.5 justify-end">
                          <span className="text-[12px] text-ink-4 line-through tabular-nums">{formatCurrency(prevCost)}</span>
                          <span className="text-[12px] font-medium text-ink-2 tabular-nums">{formatCurrency(newCost)}</span>
                          <span className={`text-[11px] font-semibold ${up ? 'text-orange-500' : 'text-green-text'}`}>
                            {up ? '+' : ''}{pct.toFixed(1)}%
                          </span>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        <div className="h-6" />
      </div>

      {/* ── Footer ── */}
      <div
        className="border-t border-line px-[18px] py-[13px] flex items-center justify-between gap-3 bg-paper"
        style={{ paddingBottom: 'calc(13px + env(safe-area-inset-bottom, 0px))' }}
      >
        {!rejected ? (
          <button
            type="button"
            onClick={handleReviewAgain}
            disabled={reverting}
            className="flex items-center gap-1.5 text-[13px] text-ink-3 hover:text-ink-2 transition-colors disabled:opacity-50"
          >
            {reverting
              ? <Loader2 size={14} className="animate-spin" />
              : <RotateCcw size={14} />}
            Review again
          </button>
        ) : <div />}
        <button
          type="button"
          onClick={onClose}
          className="px-5 py-2 text-[13px] bg-ink text-paper rounded-lg hover:bg-ink-2 transition-colors"
        >
          Close
        </button>
      </div>
    </div>
  )
}

// ─── AddNewItemModal ───────────────────────────────────────────────────────────
// Full form to configure a new inventory item before approve creates it.

function AddNewItemModal({
  item,
  sessionId,
  onSaved,
  onClose,
}: {
  item: ScanItem
  sessionId: string
  onSaved: () => void
  onClose: () => void
}) {
  const [saving,          setSaving]          = useState(false)
  const [categories,      setCategories]      = useState<string[]>([])
  const [itemName,        setItemName]        = useState(item.rawDescription ?? '')
  const [category,        setCategory]        = useState('DRY')
  const [purchaseUnit,    setPurchaseUnit]    = useState(item.rawUnit ?? 'case')
  const [qtyPerPurchase,  setQtyPerPurchase]  = useState(item.invoicePackQty ?? '1')
  const [packSize,        setPackSize]        = useState(item.invoicePackSize ?? '1')
  const [packUOM,         setPackUOM]         = useState(item.invoicePackUOM ?? 'each')
  const [priceType,       setPriceType]       = useState<'CASE' | 'UOM'>(item.pricingMode === 'per_weight' ? 'UOM' : 'CASE')
  const [purchasePrice,   setPurchasePrice]   = useState(item.rate ?? item.rawUnitPrice ?? item.newPrice ?? '')

  useEffect(() => {
    fetch('/api/categories').then(r => r.json()).then((data: { name: string }[]) => {
      setCategories(data.map(c => c.name))
    }).catch(() => {})
  }, [])

  const ppb = (() => {
    const price = Number(purchasePrice)
    const qty   = Number(qtyPerPurchase) || 1
    const ps    = Number(packSize) || 1
    if (!price) return null
    return calcPricePerBaseUnit(price, qty, 'each', null, ps, packUOM, priceType)
  })()

  const handleSave = async () => {
    setSaving(true)
    await fetch(`/api/invoices/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scanItemId:    item.id,
        action:        'CREATE_NEW',
        isNewItem:     true,
        matchedItemId: null,
        newItemData: {
          itemName:           itemName.trim() || item.rawDescription,
          category,
          purchaseUnit,
          qtyPerPurchaseUnit: Number(qtyPerPurchase) || 1,
          packSize:           Number(packSize) || 1,
          packUOM,
          priceType,
          purchasePrice:      Number(purchasePrice) || 0,
          pricePerBaseUnit:   ppb ?? 0,
          baseUnit:           packUOM,
        },
      }),
    })
    setSaving(false)
    onSaved()
  }

  const inputCls = 'w-full border border-line rounded-lg px-3 py-[7px] text-[13px] focus:outline-none focus:ring-2 focus:ring-blue/20 focus:border-blue transition-colors'
  const labelCls = 'block text-[11px] font-medium text-ink-3 mb-[5px] uppercase tracking-wide'

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-[60]" onClick={onClose} />
      <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
        <div className="bg-paper rounded-2xl shadow-xl w-full max-w-md flex flex-col max-h-[90vh]">
          {/* Header */}
          <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-bg-2">
            <div>
              <h3 className="text-[16px] font-semibold text-ink">Create new product</h3>
              <p className="text-[12px] text-ink-4 mt-0.5">These fields will be set when the invoice is approved.</p>
            </div>
            <button type="button" onClick={onClose} className="p-2.5 flex items-center justify-center text-ink-4 hover:text-ink-3 transition-colors">
              <X size={18} />
            </button>
          </div>

          {/* Form */}
          <div className="overflow-y-auto px-6 py-5 space-y-4">
            {/* Item name */}
            <div>
              <label className={labelCls}>Item name</label>
              <input
                type="text"
                value={itemName}
                onChange={e => setItemName(e.target.value)}
                className={inputCls}
                placeholder={item.rawDescription ?? ''}
              />
            </div>

            {/* Category */}
            <div>
              <label className={labelCls}>Category</label>
              <select value={category} onChange={e => setCategory(e.target.value)} className={inputCls}>
                {(categories.length ? categories : ['DRY', 'DAIRY', 'MEAT', 'PRODUCE', 'FROZEN', 'BEVERAGE', 'OTHER']).map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>

            {/* Purchase unit */}
            <div>
              <label className={labelCls}>Purchase unit</label>
              <select value={purchaseUnit} onChange={e => setPurchaseUnit(e.target.value)} className={inputCls}>
                {(PURCHASE_UNITS as readonly string[]).map(u => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>

            {/* Pack structure */}
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className={labelCls}>Pack qty</label>
                <input type="number" min="1" step="1" value={qtyPerPurchase} onChange={e => setQtyPerPurchase(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Pack size</label>
                <input type="number" min="0" step="any" value={packSize} onChange={e => setPackSize(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Pack UOM</label>
                <select value={packUOM} onChange={e => setPackUOM(e.target.value)} className={inputCls}>
                  {(PACK_UOMS as readonly string[]).map(u => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>
            </div>

            {/* Price type */}
            <div>
              <label className={labelCls}>Pricing mode</label>
              <div className="flex rounded-lg border border-line overflow-hidden text-[12px]">
                {(['CASE', 'UOM'] as const).map(pt => (
                  <button
                    key={pt}
                    type="button"
                    onClick={() => setPriceType(pt)}
                    className={`flex-1 py-[7px] font-medium transition-colors ${
                      priceType === pt ? 'bg-ink text-paper' : 'bg-paper text-ink-3 hover:bg-bg'
                    }`}
                  >
                    {pt === 'CASE' ? 'Per case' : 'Per weight / UOM'}
                  </button>
                ))}
              </div>
            </div>

            {/* Purchase price */}
            <div>
              <label className={labelCls}>Purchase price</label>
              <div className="flex items-center border border-line rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-blue/20 focus-within:border-blue transition-colors">
                <span className="px-3 text-ink-4 text-[13px]">$</span>
                <input
                  type="number" min="0" step="any"
                  value={purchasePrice}
                  onChange={e => setPurchasePrice(e.target.value)}
                  className="flex-1 py-[7px] pr-3 text-[13px] bg-transparent border-none outline-none"
                />
              </div>
              {ppb !== null && (
                <p className="text-[11px] text-ink-4 mt-1">
                  = {formatCurrency(ppb)}/{packUOM} per base unit
                </p>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="flex justify-end gap-2 px-6 py-4 border-t border-bg-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-[13px] text-ink-3 border border-line rounded-lg hover:bg-bg transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 text-[13px] font-medium bg-ink text-paper rounded-lg hover:bg-ink-2 disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving…' : 'Save & flag for approval'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

// ─── SupplierLinkCard ────────────────────────────────────────────────────────
// Invoice-wide attention card (mock §2): the supplier isn't in the directory.
// Three explicit decisions — link to existing, create new, or skip.

function SupplierLinkCard({
  supplierName,
  comboOpen,
  suppliers,
  search,
  onSearch,
  onOpenCombo,
  onPick,
  onSkip,
}: {
  supplierName: string | null
  comboOpen: boolean
  suppliers: Array<{ id: string; name: string }>
  search: string
  onSearch: (v: string) => void
  onOpenCombo: () => void
  onPick: (id: string) => void
  onSkip: () => void
}) {
  const filtered = suppliers.filter(s => s.name.toLowerCase().includes(search.toLowerCase()))
  return (
    <article className="bg-gold-soft/40 border border-[#fcd34d] rounded-lg overflow-hidden">
      <div className="px-4 py-3 flex flex-col gap-2.5">
        <div className="flex items-start gap-2.5">
          <IssueBadge kind="supplier">Supplier</IssueBadge>
          <div className="text-[12.5px] text-ink-2 leading-[1.45] min-w-0">
            {supplierName
              ? <><b className="font-semibold text-ink">&ldquo;{supplierName}&rdquo;</b> isn&rsquo;t linked to a supplier in your directory.</>
              : 'No supplier was detected on this invoice.'}
          </div>
        </div>
        <div className="flex gap-1.5 flex-wrap">
          <ActButton variant="primary" onClick={onOpenCombo}>
            <Search size={12} /> Link to existing
          </ActButton>
          <ActButton variant="danger" onClick={onSkip}>Skip for this invoice</ActButton>
        </div>

        {comboOpen && (
          <div className="bg-paper border border-line rounded-lg overflow-hidden">
            <input
              autoFocus
              value={search}
              onChange={e => onSearch(e.target.value)}
              placeholder="Search suppliers…"
              className="w-full px-3 py-2 text-[13px] border-b border-bg-2 focus:outline-none"
            />
            <div className="max-h-44 overflow-y-auto">
              {filtered.map(s => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onPick(s.id)}
                  className="w-full text-left px-3 py-2 text-[13px] hover:bg-gold-soft transition-colors font-medium text-ink"
                >
                  {s.name}
                </button>
              ))}
              {filtered.length === 0 && <p className="px-3 py-3 text-[12px] text-ink-4">No suppliers found</p>}
            </div>
          </div>
        )}
      </div>
    </article>
  )
}

```


---

## `src/components/invoices/v2/InvoiceDrawerV2.tsx`

```tsx
'use client'
// V2 invoice review drawer — mode-aware UI for the redesigned OCR pipeline.
// Mounted alongside v1; users toggle via the `?v=2` URL flag on /invoices.
// When ready we swap the dynamic import in page.tsx and delete v1.
//
// What's different vs v1:
//   - Per-line "math expression" card adapts to per_case vs per_weight
//   - Catchweight shown inline ("3.20 lb (ord 3.00) × $19.89/lb = $63.65")
//   - Filter chips driven by mode-aware predicates (mismatch, catchweight, unknown mode)
//   - Header breakdown: sub · fuel · tax with reconcile indicator
//   - Variance pill computed in the linked product's baseUnit, not packUOM

import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import {
  X, ScanLine, CheckCircle2, AlertTriangle, Loader2,
  Package, Scale, Link2, Unlink, TrendingUp, TrendingDown,
  ChevronDown, ChevronUp, Hash, CalendarDays, AlertCircle, Plus,
} from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import { InvoiceImageViewer } from '../InvoiceDrawer'
import { useRc } from '@/contexts/RevenueCenterContext'
import { rcHex } from '@/lib/rc-colors'
import type { Session, ScanItem, ApproveResult, SessionSummary, PricingMode } from '../types'
import {
  TONE, effectiveMode, productDefaultMode, varianceOf,
  mathTokens, packDescription, headerReconciliation, taxAggregate, feesAggregate,
  isPriceDelta, isCatchweight as isCw, isNeedsLink, isModeMismatch,
  isLowConfidence, isUnknownMode, isCrossCheckFail,
  applyFilter, sortByExceptionsFirst,
  type V2Filter,
} from './selectors'

interface Props {
  sessionId: string | null
  onClose: () => void
  onApproveOrReject: () => void
  allSessions?: SessionSummary[]
}

interface InventorySearchResult {
  id: string; itemName: string; abbreviation: string | null;
  purchaseUnit: string; purchasePrice: number; pricePerBaseUnit: number;
  baseUnit: string; category: string; qtyPerPurchaseUnit: number;
  packSize: number; packUOM: string;
}

function descriptionToKeywords(desc: string): string {
  return desc
    .replace(/\d+\s*[\/x]\s*\d+(?:\.\d+)?\s*(?:l|ml|kg|g|lb|oz)\b/gi, '')
    .replace(/\d+(?:\.\d+)?\s*(?:l|ml|kg|g|lb|oz)\b/gi, '')
    .replace(/[-–—]+/g, ' ').replace(/\s+/g, ' ').trim()
    .split(/\s+/).slice(0, 5).join(' ')
}

// ── Root drawer ───────────────────────────────────────────────────────────────
export function InvoiceDrawerV2({ sessionId, onClose, onApproveOrReject, allSessions = [] }: Props) {
  const [session, setSession] = useState<Session | null>(null)
  const [approveResult, setApproveResult] = useState<ApproveResult | null>(null)
  const [isApproving, setIsApproving] = useState(false)
  const [open, setOpen] = useState(false)
  const [mobileTab, setMobileTab] = useState<'review' | 'image'>('review')
  const [approvedBy, setApprovedBy] = useState(() =>
    typeof window !== 'undefined' ? localStorage.getItem('approvedBy') ?? '' : ''
  )
  const [filter, setFilter] = useState<V2Filter>('all')
  const [sortMode, setSortMode] = useState<'invoice' | 'exceptions'>('invoice')
  const [expandedIds, setExpandedIds] = useState<Record<string, true>>({})
  const { revenueCenters } = useRc()
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchSession = useCallback(async (id: string) => {
    const res = await fetch(`/api/invoices/sessions/${id}`)
    if (!res.ok) return null
    const data: Session = await res.json()
    setSession(data)
    return data
  }, [])

  useEffect(() => {
    if (sessionId) {
      setOpen(true)
      setApproveResult(null)
      fetchSession(sessionId)
    } else {
      setOpen(false)
      const t = setTimeout(() => setSession(null), 200)
      return () => clearTimeout(t)
    }
  }, [sessionId, fetchSession])

  // Poll while processing/approving
  useEffect(() => {
    const should = session?.status === 'PROCESSING' || session?.status === 'UPLOADING' || session?.status === 'APPROVING'
    if (should) {
      pollRef.current = setInterval(async () => {
        const s = await fetchSession(session!.id)
        if (!s || (s.status !== 'PROCESSING' && s.status !== 'UPLOADING' && s.status !== 'APPROVING')) {
          if (pollRef.current) clearInterval(pollRef.current)
        }
      }, 2000)
    } else if (pollRef.current) {
      clearInterval(pollRef.current)
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [session?.status, session?.id, fetchSession])

  // Esc closes drawer. No unsaved-edits prompt yet — all edits PATCH on blur,
  // so by the time the user hits Esc the server state is already in sync.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const patchItem = useCallback(async (itemId: string, updates: Partial<ScanItem>) => {
    if (!session) return
    await fetch(`/api/invoices/sessions/${session.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scanItemId: itemId, ...updates }),
    })
    await fetchSession(session.id)
  }, [session, fetchSession])

  const handleApprove = async () => {
    if (!session) return
    setIsApproving(true)
    try {
      const res = await fetch(`/api/invoices/sessions/${session.id}/approve`, { method: 'POST' })
      const result = await res.json()
      if (!res.ok) { alert(`Approval failed: ${result.error ?? res.statusText}`); return }
      if (result.queued) { onApproveOrReject(); onClose() }
      else { setApproveResult(result); onApproveOrReject() }
    } finally { setIsApproving(false) }
  }

  const handleReject = async () => {
    if (!session) return
    await fetch(`/api/invoices/sessions/${session.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'REJECTED' }),
    })
    onApproveOrReject()
    onClose()
  }

  const isReview = session?.status === 'REVIEW'

  if (!sessionId && !open && !session) return null

  return (
    <>
      {/* Backdrop — desktop only; mobile uses full-screen overlay */}
      <div
        className="hidden sm:block fixed inset-0 z-40 bg-black/40"
        onClick={onClose}
        style={{ opacity: open ? 1 : 0, transition: 'opacity 150ms ease-out' }}
      />

      {/* Desktop drawer */}
      <div
        className={`hidden sm:flex fixed top-0 right-0 h-full z-50 bg-paper shadow-2xl flex-col transition-all duration-150 ease-out ${isReview ? 'w-[960px]' : 'w-[560px]'}`}
        style={{ transform: open ? 'translateX(0)' : 'translateX(100%)' }}
      >
        <DrawerChrome onClose={onClose} title={session ? labelFor(session.status) : 'Loading…'} />
        <div className="flex-1 overflow-hidden flex min-h-0">
          {isReview && session?.files && session.files.length > 0 && (
            <InvoiceImageViewer files={session.files} />
          )}
          <div className={`flex-1 overflow-y-auto flex flex-col ${isReview ? 'border-l border-gray-100' : ''}`}>
            <DrawerBody
              session={session}
              approveResult={approveResult}
              allSessions={allSessions}
              filter={filter} onFilter={setFilter}
              sortMode={sortMode} onSortMode={setSortMode}
              expandedIds={expandedIds} onToggle={(id) => setExpandedIds(p => ({ ...p, [id]: !p[id] ? true : undefined! }))}
              patchItem={patchItem}
              revenueCenters={revenueCenters}
            />
            {isReview && session && (
              <DrawerFooter
                session={session}
                approvedBy={approvedBy}
                onApprovedByChange={(v) => { setApprovedBy(v); localStorage.setItem('approvedBy', v) }}
                onApprove={handleApprove}
                onReject={handleReject}
                isApproving={isApproving}
              />
            )}
          </div>
        </div>
      </div>

      {/* Mobile — full-screen overlay, slides up from bottom */}
      <div
        className="sm:hidden fixed inset-0 z-[60] bg-paper flex flex-col"
        style={{
          transform: open ? 'translateY(0)' : 'translateY(100%)',
          transition: 'transform 200ms ease-out',
          paddingTop: 'env(safe-area-inset-top, 0px)',
        }}
      >
        <DrawerChrome onClose={onClose} title={session ? labelFor(session.status) : 'Loading…'} size="sm" />
        {isReview && session?.files && session.files.length > 0 && (
          <div className="flex border-b border-gray-100 shrink-0">
            <button onClick={() => setMobileTab('review')} className={`flex-1 py-2.5 text-sm font-medium ${mobileTab === 'review' ? 'text-gold border-b-2 border-gold' : 'text-gray-500'}`}>Review</button>
            <button onClick={() => setMobileTab('image')}  className={`flex-1 py-2.5 text-sm font-medium ${mobileTab === 'image'  ? 'text-gold border-b-2 border-gold' : 'text-gray-500'}`}>Invoice Image</button>
          </div>
        )}
        <div className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain">
          {isReview && mobileTab === 'image' && session?.files?.length
            ? <InvoiceImageViewer files={session.files} />
            : <DrawerBody
                session={session}
                approveResult={approveResult}
                allSessions={allSessions}
                filter={filter} onFilter={setFilter}
                sortMode={sortMode} onSortMode={setSortMode}
                expandedIds={expandedIds} onToggle={(id) => setExpandedIds(p => ({ ...p, [id]: !p[id] ? true : undefined! }))}
                patchItem={patchItem}
                revenueCenters={revenueCenters}
              />}
        </div>
        {isReview && session && (
          <DrawerFooter
            session={session}
            approvedBy={approvedBy}
            onApprovedByChange={(v) => { setApprovedBy(v); localStorage.setItem('approvedBy', v) }}
            onApprove={handleApprove}
            onReject={handleReject}
            isApproving={isApproving}
          />
        )}
      </div>
    </>
  )
}

function labelFor(status: string): string {
  if (status === 'PROCESSING' || status === 'UPLOADING') return 'Scanning…'
  if (status === 'APPROVING') return 'Applying invoice…'
  if (status === 'ERROR')     return 'Scan failed'
  if (status === 'REVIEW')    return 'Review invoice'
  return 'Invoice'
}

// ── Drawer chrome ─────────────────────────────────────────────────────────────
function DrawerChrome({ onClose, title, size = 'md' }: { onClose: () => void; title: string; size?: 'sm' | 'md' }) {
  return (
    <div className={`flex items-center justify-between border-b border-gray-100 shrink-0 ${size === 'sm' ? 'px-5 py-3' : 'px-5 py-4'}`}>
      <div className="flex items-center gap-2">
        <ScanLine size={size === 'sm' ? 16 : 18} className="text-gold" />
        <span className={`font-semibold text-gray-900 ${size === 'sm' ? 'text-sm' : ''}`}>{title}</span>
      </div>
      <button onClick={onClose} aria-label="Close" className="p-2.5 flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg">
        <X size={size === 'sm' ? 16 : 18} />
      </button>
    </div>
  )
}

// ── Drawer body — header + chips + lines, or status views ─────────────────────
function DrawerBody({
  session, approveResult, allSessions, filter, onFilter, sortMode, onSortMode,
  expandedIds, onToggle, patchItem, revenueCenters,
}: {
  session: Session | null
  approveResult: ApproveResult | null
  allSessions: SessionSummary[]
  filter: V2Filter
  onFilter: (f: V2Filter) => void
  sortMode: 'invoice' | 'exceptions'
  onSortMode: (m: 'invoice' | 'exceptions') => void
  expandedIds: Record<string, true>
  onToggle: (id: string) => void
  patchItem: (id: string, updates: Partial<ScanItem>) => Promise<void>
  revenueCenters: Array<{ id: string; name: string; color: string }>
}) {
  if (!session) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-[40vh]">
        <Loader2 size={28} className="animate-spin text-gray-300" />
      </div>
    )
  }

  if (approveResult) {
    return (
      <div className="flex-1 p-6 text-center space-y-3">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-green-soft">
          <CheckCircle2 size={28} className="text-green-text" />
        </div>
        <h2 className="text-lg font-semibold text-gray-900">Invoice applied</h2>
        <p className="text-sm text-gray-500">
          {approveResult.itemsUpdated} prices updated · {approveResult.newItemsCreated} new items
        </p>
      </div>
    )
  }

  if (session.status !== 'REVIEW') {
    return (
      <div className="flex-1 p-6 text-center space-y-3">
        <Loader2 size={24} className="animate-spin text-gold mx-auto" />
        <p className="text-sm text-gray-500">{labelFor(session.status)}</p>
        {session.errorMessage && (
          <p className="text-sm text-red bg-red-soft border border-[#fecaca] rounded-xl px-4 py-3 text-left">
            {session.errorMessage}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <DrawerHeader session={session} allSessions={allSessions} />
      <FilterChipsBar
        session={session}
        filter={filter}
        onFilter={onFilter}
        sortMode={sortMode}
        onSortMode={onSortMode}
      />
      <LineItemList
        session={session}
        filter={filter}
        sortMode={sortMode}
        expandedIds={expandedIds}
        onToggle={onToggle}
        patchItem={patchItem}
        revenueCenters={revenueCenters}
      />
    </div>
  )
}

// ── Drawer header ─────────────────────────────────────────────────────────────
function DrawerHeader({ session, allSessions }: { session: Session; allSessions: SessionSummary[] }) {
  const recon = headerReconciliation(session)
  const tax  = taxAggregate(session)
  const fees = feesAggregate(session)
  const sub  = session.subtotal ? Number(session.subtotal) : null
  const ocrTotal = session.total ? Number(session.total) : null

  // When OCR didn't capture the invoice total, sum visible line items as a fallback.
  const scannedTotal = useMemo(() => {
    if (ocrTotal != null) return null // OCR total present — no need for fallback
    let sum = 0
    for (const item of session.scanItems) {
      if (item.action === 'SKIP') continue
      const lt = item.rawLineTotal != null ? Number(item.rawLineTotal) : null
      if (lt != null) sum += lt
    }
    return sum
  }, [ocrTotal, session.scanItems])

  const displayTotal = ocrTotal ?? scannedTotal
  const isComputedTotal = ocrTotal == null && scannedTotal != null

  const dup = session.invoiceNumber
    ? allSessions.find(s => s.id !== session.id && s.invoiceNumber === session.invoiceNumber)
    : null

  return (
    <div className="bg-paper border-b border-gray-100">
      <div className="px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-0.5">Review invoice</p>
            <h2 className="text-[17px] font-medium text-gray-900 leading-tight truncate">
              {session.supplierName || 'Unknown supplier'}
            </h2>
            <div className="flex items-center gap-2 mt-1 text-xs text-gray-500 flex-wrap">
              {session.invoiceNumber && <span className="flex items-center gap-0.5"><Hash size={10} />{session.invoiceNumber}</span>}
              {session.invoiceDate && <span className="flex items-center gap-0.5"><CalendarDays size={10} />{session.invoiceDate}</span>}
              <span>· {session.scanItems.length} line items</span>
            </div>
          </div>
          <div className="text-right shrink-0">
            {displayTotal != null && (
              <div>
                <div className="text-[22px] font-medium text-gray-900 leading-none">{formatCurrency(displayTotal)}</div>
                {isComputedTotal && (
                  <div className="text-[10px] text-gray-400 mt-0.5">scanned total (no OCR total)</div>
                )}
              </div>
            )}
            <div className="flex items-center gap-2 mt-1 text-[11px] text-gray-500 justify-end flex-wrap">
              {sub != null  && <span>sub {formatCurrency(sub)}</span>}
              {fees > 0     && <span>· fuel {formatCurrency(fees)}</span>}
              {tax != null && tax > 0 && <span>· tax {formatCurrency(tax)}</span>}
            </div>
            {!isComputedTotal && recon.match === true && (
              <div role="status" className="mt-1.5 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-green-soft text-green-text border border-green-soft">
                <CheckCircle2 size={9} /> totals reconcile
              </div>
            )}
            {!isComputedTotal && recon.match === false && recon.diff != null && (
              <div role="status" className="mt-1.5 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-gold-soft text-gold-2 border border-[#fcd34d]/60">
                <AlertTriangle size={9} /> totals off by {formatCurrency(Math.abs(recon.diff))}
              </div>
            )}
          </div>
        </div>
      </div>

      {dup && (
        <div className="flex items-start gap-2 px-5 py-2.5 bg-gold-soft border-t border-[#fcd34d]/60">
          <AlertTriangle size={13} className="text-gold mt-0.5 shrink-0" />
          <div className="text-xs text-gold-2">
            <span className="font-semibold">Possible duplicate.</span>{' '}
            Invoice #{session.invoiceNumber} was already scanned
            {dup.invoiceDate ? ` on ${dup.invoiceDate}` : ''}
            {' '}<span className="font-semibold">({dup.status.toLowerCase()})</span>. Review carefully before approving.
          </div>
        </div>
      )}
    </div>
  )
}

// ── Filter chips ──────────────────────────────────────────────────────────────
function FilterChipsBar({
  session, filter, onFilter, sortMode, onSortMode,
}: {
  session: Session
  filter: V2Filter
  onFilter: (f: V2Filter) => void
  sortMode: 'invoice' | 'exceptions'
  onSortMode: (m: 'invoice' | 'exceptions') => void
}) {
  const counts = useMemo(() => ({
    all:          session.scanItems.length,
    price_delta:  session.scanItems.filter(isPriceDelta).length,
    catchweight:  session.scanItems.filter(isCw).length,
    needs_link:   session.scanItems.filter(isNeedsLink).length,
    mismatch:     session.scanItems.filter(isModeMismatch).length,
    low_conf:     session.scanItems.filter(isLowConfidence).length,
    unknown_mode: session.scanItems.filter(isUnknownMode).length,
  }), [session.scanItems])

  const Chip = ({ value, label, tone }: { value: V2Filter; label: string; tone?: 'warning' | 'info' | 'danger' }) => {
    const n = counts[value]
    if (value !== 'all' && n === 0) return null
    const active = filter === value
    const dotClass = tone ? TONE[tone].dot : ''
    return (
      <button
        onClick={() => onFilter(value)}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors border ${
          active ? 'bg-gray-900 text-paper border-gray-900' : 'bg-paper text-gray-600 border-gray-200 hover:bg-gray-50'
        }`}
      >
        {tone && <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />}
        {label}
        <span className={active ? 'text-gray-300' : 'text-gray-400'}>{n}</span>
      </button>
    )
  }

  return (
    <div className="px-3 py-2 flex items-center gap-1.5 flex-wrap border-b border-gray-100 bg-gray-50/50">
      <Chip value="all"          label="All" />
      <Chip value="unknown_mode" label="Unknown mode" tone="danger" />
      <Chip value="needs_link"   label="Needs link"   tone="danger" />
      <Chip value="mismatch"     label="Mismatch"     tone="warning" />
      <Chip value="low_conf"     label="Low conf"     tone="warning" />
      <Chip value="price_delta"  label="Price Δ"      tone="warning" />
      <Chip value="catchweight"  label="Catchweight"  tone="info" />

      <div className="ml-auto flex items-center gap-2.5">
        <button
          onClick={() => onSortMode(sortMode === 'invoice' ? 'exceptions' : 'invoice')}
          className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-700"
        >
          {sortMode === 'invoice' ? '⇣ Invoice order' : '⚠ Exceptions first'}
        </button>
      </div>
    </div>
  )
}

// ── Line item list ────────────────────────────────────────────────────────────
function LineItemList({
  session, filter, sortMode, expandedIds, onToggle, patchItem, revenueCenters,
}: {
  session: Session
  filter: V2Filter
  sortMode: 'invoice' | 'exceptions'
  expandedIds: Record<string, true>
  onToggle: (id: string) => void
  patchItem: (id: string, updates: Partial<ScanItem>) => Promise<void>
  revenueCenters: Array<{ id: string; name: string; color: string }>
}) {
  const filtered = applyFilter(session.scanItems, filter)
  const ordered = sortMode === 'exceptions' ? sortByExceptionsFirst(filtered) : [...filtered].sort((a, b) => a.sortOrder - b.sortOrder)

  if (ordered.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-gray-400">
        No items match this filter.
      </div>
    )
  }

  return (
    <div className="px-3 py-3 space-y-2 bg-gray-50/60">
      {ordered.map(item => (
        <LineItemRow
          key={item.id}
          item={item}
          isExpanded={!!expandedIds[item.id]}
          onToggle={() => onToggle(item.id)}
          patchItem={patchItem}
          revenueCenters={revenueCenters}
        />
      ))}
    </div>
  )
}

// ── Line item row ─────────────────────────────────────────────────────────────
function LineItemRow({
  item, isExpanded, onToggle, patchItem, revenueCenters,
}: {
  item: ScanItem
  isExpanded: boolean
  onToggle: () => void
  patchItem: (id: string, updates: Partial<ScanItem>) => Promise<void>
  revenueCenters: Array<{ id: string; name: string; color: string }>
}) {
  const mode    = effectiveMode(item)
  const tokens  = mathTokens(item)
  const v       = varianceOf(item)
  const pdm     = productDefaultMode(item)
  const linked  = item.matchedItem
  const lineTotal = item.rawLineTotal != null ? Number(item.rawLineTotal) : null

  // Row border tone — danger > warning > neutral
  const borderClass =
    isUnknownMode(item)                      ? 'border-[#fca5a5]' :
    isNeedsLink(item)                        ? 'border-[#fca5a5]' :
    isCrossCheckFail(item)                   ? 'border-[#fca5a5]' :
    isModeMismatch(item)                     ? 'border-[#fcd34d]' :
    isLowConfidence(item)                    ? 'border-[#fcd34d]' :
                                               'border-gray-200'

  return (
    <div className={`bg-paper rounded-xl border ${borderClass} overflow-hidden`}>
      {/* Row header — keyboard-expandable */}
      <button
        onClick={onToggle}
        aria-expanded={isExpanded}
        className="w-full text-left px-3 pt-3 pb-2 flex items-start gap-3 hover:bg-gray-50/60 transition-colors"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm font-medium text-gray-900 truncate">{item.rawDescription}</span>
            {isModeMismatch(item)   && <Pill tone="warning">mode mismatch</Pill>}
            {isCw(item)             && <Pill tone="info">catchweight</Pill>}
            {isLowConfidence(item)  && <Pill tone="warning">low conf</Pill>}
            {isUnknownMode(item)    && <Pill tone="danger">unknown mode</Pill>}
          </div>
          <div className="mt-0.5 text-[11px] text-gray-500 truncate">
            {[
              item.supplierItemCode ? `#${item.supplierItemCode}` : null,
              packDescription(item) || (mode === 'per_case' ? '⚠ no pack format' : null),
              item.lineCategory || null,
            ].filter(Boolean).join(' · ')}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[15px] font-medium text-gray-900">
            {lineTotal != null ? formatCurrency(lineTotal) : '—'}
          </div>
          {isExpanded ? <ChevronUp size={14} className="text-gray-400 inline-block mt-1" /> : <ChevronDown size={14} className="text-gray-400 inline-block mt-1" />}
        </div>
      </button>

      {/* Math expression card */}
      <div className="mx-3 mb-2 bg-gray-50 rounded-lg px-3 py-2 flex items-center gap-3">
        <div className="shrink-0 text-gray-400">
          {mode === 'per_weight' ? <Scale size={16} /> : <Package size={16} />}
        </div>
        <div className="flex-1 text-[13px] text-gray-900 leading-tight">
          <span className="font-medium">{tokens.lhs.value}</span>
          {tokens.lhs.uom && <span className="text-gray-500"> {tokens.lhs.uom}</span>}
          {tokens.lhs.ordHint && <span className="text-[11px] text-gray-400 ml-1">{tokens.lhs.ordHint}</span>}
          <span className="text-gray-400 mx-1.5">×</span>
          <span className="font-medium">{tokens.rhs.value}</span>
          {tokens.rhs.uom && <span className="text-gray-500">/{tokens.rhs.uom}</span>}
          <span className="text-gray-400 mx-1.5">=</span>
          <span className="font-medium">{tokens.result}</span>
        </div>
        <ModePill mode={mode} />
      </div>

      {/* Link strip */}
      <div className="px-3 pb-3 flex items-center gap-3 text-[12px]">
        <div className="flex-1 min-w-0 flex items-center gap-1.5 flex-wrap">
          {linked ? (
            <>
              <Link2 size={12} className="text-gray-400" />
              <span className="text-gray-700">linked to <span className="font-medium text-gray-900">{linked.itemName}</span></span>
              {v != null && Math.abs(v) >= 0.01 && (
                <VariancePill v={v} />
              )}
            </>
          ) : (
            <>
              <Unlink size={12} className="text-red" />
              {item.action === 'CREATE_NEW' ? (
                <span className="text-gray-700">will create new inventory item</span>
              ) : item.action === 'SKIP' ? (
                <span className="text-gray-400">skipped</span>
              ) : (
                <span className="text-red-text font-medium">not linked yet</span>
              )}
            </>
          )}
        </div>
        <RcAssigner
          item={item}
          revenueCenters={revenueCenters}
          onAssign={(rcId) => patchItem(item.id, { revenueCenterId: rcId })}
        />
      </div>

      {/* Expanded details */}
      {isExpanded && (
        <ItemEditSection
          item={item}
          mode={mode}
          variance={v}
          productDefaultMode={pdm}
          patchItem={patchItem}
        />
      )}
    </div>
  )
}

function Pill({ tone, children }: { tone: 'warning' | 'info' | 'danger' | 'success'; children: React.ReactNode }) {
  const t = TONE[tone]
  return <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${t.bg} ${t.text} border ${t.border}`}>{children}</span>
}

function ModePill({ mode }: { mode: PricingMode }) {
  if (mode === 'unknown') return <Pill tone="danger">unknown mode</Pill>
  if (mode === 'per_weight') return <Pill tone="info">by weight</Pill>
  return <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-600 border border-gray-200">by case</span>
}

function VariancePill({ v }: { v: number }) {
  const pct = (v * 100)
  const up = v > 0
  const tone = up ? 'danger' : 'success'
  const t = TONE[tone]
  return (
    <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium ${t.bg} ${t.text} border ${t.border}`}>
      {up ? <TrendingUp size={9} /> : <TrendingDown size={9} />}
      {up ? '↑' : '↓'} {Math.abs(pct).toFixed(1)}%
    </span>
  )
}

function RcAssigner({
  item, revenueCenters, onAssign,
}: {
  item: ScanItem
  revenueCenters: Array<{ id: string; name: string; color: string }>
  onAssign: (rcId: string) => void
}) {
  if (revenueCenters.length <= 1) return null
  const current = revenueCenters.find(rc => rc.id === item.revenueCenterId)
  return (
    <select
      value={item.revenueCenterId ?? ''}
      onChange={(e) => onAssign(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      aria-label="Assign revenue center"
      className={`text-[11px] rounded-lg px-2 py-0.5 shrink-0 focus:outline-none focus:ring-1 focus:ring-gold ${
        current
          ? 'border border-gray-200 bg-paper text-gray-700'
          : 'border border-dashed border-gray-300 bg-paper text-gray-400'
      }`}
    >
      <option value="">RC: assign…</option>
      {revenueCenters.map(rc => (
        <option key={rc.id} value={rc.id}>RC: {rc.name}</option>
      ))}
    </select>
  )
}

// ── Unified item edit section — replaces ExpandedDetails + PerCaseForm + PerWeightForm ──
function ItemEditSection({
  item, mode, variance, productDefaultMode: pdm, patchItem,
}: {
  item: ScanItem
  mode: PricingMode
  variance: number | null
  productDefaultMode: PricingMode | null
  patchItem: (id: string, updates: Partial<ScanItem>) => Promise<void>
}) {
  // ── Local field state ────────────────────────────────────────────────────────
  const [localQty,       setLocalQty]       = useState(item.rawQty        != null ? String(Number(item.rawQty))        : '')
  const [localPackQty,   setLocalPackQty]   = useState(item.invoicePackQty != null ? String(Number(item.invoicePackQty)) : '')
  const [localPackSize,  setLocalPackSize]  = useState(item.invoicePackSize != null ? String(Number(item.invoicePackSize)) : '')
  const [localPackUOM,   setLocalPackUOM]   = useState(item.invoicePackUOM  ?? '')
  const [localUnitPrice, setLocalUnitPrice] = useState(item.rawUnitPrice   != null ? String(Number(item.rawUnitPrice))  : '')
  const [localLineTotal, setLocalLineTotal] = useState(item.rawLineTotal   != null ? String(Number(item.rawLineTotal))  : '')
  const [localQtyOrdered, setLocalQtyOrdered] = useState(item.qtyOrdered  != null ? String(Number(item.qtyOrdered))    : '')
  const [localRate,      setLocalRate]      = useState(item.rate           != null ? String(Number(item.rate))          : '')
  const [localTotalQty,  setLocalTotalQty]  = useState(item.totalQty      != null ? String(Number(item.totalQty))      : '')
  const [priceDriver,    setPriceDriver]    = useState<'unit' | 'total'>('unit')

  // ── Search state ─────────────────────────────────────────────────────────────
  const [searchQuery,   setSearchQuery]   = useState('')
  const [searchResults, setSearchResults] = useState<InventorySearchResult[]>([])
  const [isSearching,   setIsSearching]   = useState(false)
  const [showDropdown,  setShowDropdown]  = useState(false)
  const searchRef  = useRef<HTMLDivElement>(null)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const recomputingRef = useRef(false)

  // ── Sync local state when item.id changes (different row selected) ───────────
  useEffect(() => {
    setLocalQty(item.rawQty        != null ? String(Number(item.rawQty))        : '')
    setLocalPackQty(item.invoicePackQty != null ? String(Number(item.invoicePackQty)) : '')
    setLocalPackSize(item.invoicePackSize != null ? String(Number(item.invoicePackSize)) : '')
    setLocalPackUOM(item.invoicePackUOM ?? '')
    setLocalUnitPrice(item.rawUnitPrice != null ? String(Number(item.rawUnitPrice)) : '')
    setLocalLineTotal(item.rawLineTotal != null ? String(Number(item.rawLineTotal)) : '')
    setLocalQtyOrdered(item.qtyOrdered != null ? String(Number(item.qtyOrdered)) : '')
    setLocalRate(item.rate != null ? String(Number(item.rate)) : '')
    setLocalTotalQty(item.totalQty != null ? String(Number(item.totalQty)) : '')
    setPriceDriver('unit')
  }, [item.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Reactive cross-field calculation ─────────────────────────────────────────
  useEffect(() => {
    if (recomputingRef.current) return
    recomputingRef.current = true
    try {
      if (mode === 'per_case') {
        const qty  = parseFloat(localQty)
        const up   = parseFloat(localUnitPrice)
        const lt   = parseFloat(localLineTotal)
        if (priceDriver === 'unit' && qty > 0 && up > 0) {
          const next = (qty * up).toFixed(2)
          if (next !== localLineTotal) setLocalLineTotal(next)
        } else if (priceDriver === 'total' && qty > 0 && lt > 0) {
          const next = (lt / qty).toFixed(4)
          if (next !== localUnitPrice) setLocalUnitPrice(next)
        }
      } else if (mode === 'per_weight') {
        const tq = parseFloat(localTotalQty)
        const r  = parseFloat(localRate)
        const lt = parseFloat(localLineTotal)
        if (priceDriver === 'unit' && tq > 0 && r > 0) {
          const next = (tq * r).toFixed(2)
          if (next !== localLineTotal) setLocalLineTotal(next)
        } else if (priceDriver === 'total' && tq > 0 && lt > 0) {
          const next = (lt / tq).toFixed(4)
          if (next !== localRate) setLocalRate(next)
        }
      }
    } finally {
      recomputingRef.current = false
    }
  }, [localQty, localUnitPrice, localLineTotal, localTotalQty, localRate, priceDriver, mode])

  // ── Outside-click closes search dropdown ─────────────────────────────────────
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // ── Inventory search ──────────────────────────────────────────────────────────
  const search = useCallback((q: string) => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    if (!q.trim()) { setSearchResults([]); setShowDropdown(false); return }
    searchTimerRef.current = setTimeout(async () => {
      setIsSearching(true)
      try {
        const res = await fetch(`/api/inventory/search?q=${encodeURIComponent(q)}&limit=8`)
        if (res.ok) {
          const data: InventorySearchResult[] = await res.json()
          setSearchResults(data)
          setShowDropdown(true)
        }
      } finally {
        setIsSearching(false)
      }
    }, 250)
  }, [])

  const handleSearchChange = (q: string) => {
    setSearchQuery(q)
    search(q)
  }

  const handleSelectItem = async (inv: InventorySearchResult) => {
    setShowDropdown(false)
    setSearchQuery(inv.itemName)
    await patchItem(item.id, {
      matchedItemId: inv.id,
      action: 'UPDATE_PRICE',
      matchConfidence: 'HIGH',
      matchScore: 100,
    } as Partial<ScanItem>)
  }

  const handleSelectCreateNew = async () => {
    setShowDropdown(false)
    await patchItem(item.id, { matchedItemId: null, action: 'CREATE_NEW' } as Partial<ScanItem>)
  }

  const handleSelectSkip = async () => {
    setShowDropdown(false)
    await patchItem(item.id, { action: 'SKIP' } as Partial<ScanItem>)
  }

  // ── Save all fields at once ───────────────────────────────────────────────────
  const saveAll = useCallback(async () => {
    const toNull = (v: string) => v.trim() === '' ? null : v
    await patchItem(item.id, {
      rawQty:         toNull(localQty),
      invoicePackQty: toNull(localPackQty),
      invoicePackSize: toNull(localPackSize),
      invoicePackUOM:  toNull(localPackUOM),
      rawUnitPrice:   toNull(localUnitPrice),
      rawLineTotal:   toNull(localLineTotal),
      qtyOrdered:     toNull(localQtyOrdered),
      rate:           toNull(localRate),
      totalQty:       toNull(localTotalQty),
    } as Partial<ScanItem>)
  }, [item.id, localQty, localPackQty, localPackSize, localPackUOM, localUnitPrice, localLineTotal, localQtyOrdered, localRate, localTotalQty, patchItem])

  // ── Mode switch ───────────────────────────────────────────────────────────────
  const switchMode = async (next: 'per_case' | 'per_weight') => {
    if (mode === next) return
    if (next === 'per_case') {
      const qty = parseFloat(localQty)
      const lt  = parseFloat(localLineTotal)
      const fallbackUnitPrice = (qty > 0 && lt > 0) ? String(lt / qty) : null
      await patchItem(item.id, {
        pricingMode: 'per_case',
        rate: null, rateUOM: null, totalQty: null, totalQtyUOM: null,
        ...(item.rawUnitPrice == null && fallbackUnitPrice != null ? { rawUnitPrice: fallbackUnitPrice } : {}),
      } as Partial<ScanItem>)
    } else {
      await patchItem(item.id, { pricingMode: 'per_weight', rawUnitPrice: null } as Partial<ScanItem>)
    }
  }

  const rateUOM = item.rateUOM ?? item.totalQtyUOM ?? 'kg'
  const hasPackFormat = localPackQty !== '' || localPackSize !== '' || localPackUOM !== ''
  const linked = item.matchedItem

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="border-t border-dashed border-gray-200 bg-gray-50/80 px-3 py-3 space-y-3">

      {/* ── Linked item search ─────────────────────────────────────────────── */}
      <div ref={searchRef} className="relative">
        <span className="block text-[10px] text-gray-500 mb-1 flex items-center gap-1">
          {linked ? <Link2 size={10} className="text-gray-400" /> : <Unlink size={10} className="text-red" />}
          {linked ? 'Linked item' : 'Link to inventory item'}
        </span>
        <div className="relative flex items-center">
          <input
            type="text"
            value={showDropdown || searchQuery ? searchQuery : (linked?.itemName ?? '')}
            placeholder={`Search inventory… (${descriptionToKeywords(item.rawDescription) || item.rawDescription})`}
            onChange={(e) => handleSearchChange(e.target.value)}
            onFocus={() => {
              const initial = linked?.itemName ?? descriptionToKeywords(item.rawDescription)
              if (!searchQuery) {
                setSearchQuery(initial)
                search(initial)
              } else {
                if (searchResults.length > 0) setShowDropdown(true)
              }
            }}
            className="w-full border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold pr-7"
          />
          {isSearching && (
            <Loader2 size={13} className="absolute right-2 text-gray-400 animate-spin" />
          )}
        </div>

        {showDropdown && (
          <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-paper border border-gray-200 rounded-xl shadow-lg overflow-hidden">
            {searchResults.map((inv) => (
              <button
                key={inv.id}
                onMouseDown={(e) => { e.preventDefault(); handleSelectItem(inv) }}
                className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 flex items-start gap-2 border-b border-gray-50 last:border-0"
              >
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-gray-900 truncate">{inv.itemName}</div>
                  <div className="text-[11px] text-gray-500 truncate">
                    {inv.category} · {inv.packSize}{inv.packUOM} × {inv.qtyPerPurchaseUnit}/{inv.purchaseUnit}
                  </div>
                </div>
              </button>
            ))}
            <div className="flex border-t border-gray-100">
              <button
                onMouseDown={(e) => { e.preventDefault(); handleSelectCreateNew() }}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-[12px] text-green-text hover:bg-green-soft font-medium"
              >
                <Plus size={12} /> Create new item
              </button>
              <div className="w-px bg-gray-100" />
              <button
                onMouseDown={(e) => { e.preventDefault(); handleSelectSkip() }}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-[12px] text-gray-500 hover:bg-gray-50 font-medium"
              >
                — Skip this line
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Pricing details label + mode toggle ───────────────────────────── */}
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest">Pricing details</span>
        <ModeToggle current={mode} onChange={switchMode} />
      </div>

      {/* ── Mode-specific fields ───────────────────────────────────────────── */}
      {mode === 'per_case' ? (
        <div className="space-y-2.5">
          {/* Pack format */}
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Pack format</span>
              {!hasPackFormat && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-gold-soft text-gold-2 border border-[#fcd34d]/60">
                  <AlertTriangle size={9} /> not detected
                </span>
              )}
            </div>
            <div className="grid grid-cols-3 gap-2">
              <label className="block">
                <span className="block text-[10px] text-gray-500 mb-0.5">Pack qty</span>
                <input type="number" step="any" min="0" value={localPackQty} placeholder="e.g. 4"
                  onChange={(e) => setLocalPackQty(e.target.value)}
                  onBlur={saveAll}
                  className="flex-1 w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
              </label>
              <label className="block">
                <span className="block text-[10px] text-gray-500 mb-0.5">Pack size</span>
                <input type="number" step="any" min="0" value={localPackSize} placeholder="e.g. 4"
                  onChange={(e) => setLocalPackSize(e.target.value)}
                  onBlur={saveAll}
                  className="flex-1 w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
              </label>
              <label className="block">
                <span className="block text-[10px] text-gray-500 mb-0.5">Pack UOM</span>
                <input type="text" value={localPackUOM} placeholder="kg, lb, L…"
                  onChange={(e) => setLocalPackUOM(e.target.value)}
                  onBlur={saveAll}
                  className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
              </label>
            </div>
            {hasPackFormat && (
              <div className="mt-1 text-[11px] text-gray-500 px-1">
                = {localPackQty || '?'} × {localPackSize || '?'}{localPackUOM} per case
              </div>
            )}
          </div>
          {/* Qty + pricing */}
          <div className="grid grid-cols-2 gap-2.5">
            <label className="block">
              <span className="block text-[10px] text-gray-500 mb-0.5">Qty ordered</span>
              <div className="flex items-center gap-1">
                <input type="number" step="any" min="0" value={localQtyOrdered}
                  onChange={(e) => setLocalQtyOrdered(e.target.value)}
                  onBlur={saveAll}
                  className="flex-1 min-w-0 border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                <span className="text-[11px] text-gray-500 shrink-0">{item.qtyOrderedUOM ?? 'cs'}</span>
              </div>
            </label>
            <label className="block">
              <span className="block text-[10px] text-gray-500 mb-0.5">Qty shipped</span>
              <div className="flex items-center gap-1">
                <input type="number" step="any" min="0" value={localQty}
                  onChange={(e) => setLocalQty(e.target.value)}
                  onBlur={saveAll}
                  className="flex-1 min-w-0 border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                <span className="text-[11px] text-gray-500 shrink-0">{item.rawUnit ?? 'cs'}</span>
              </div>
            </label>
            <label className="block">
              <span className="block text-[10px] text-gray-500 mb-0.5">Unit price</span>
              <div className="flex items-center gap-1">
                <input type="number" step="any" min="0" value={localUnitPrice}
                  onChange={(e) => { setLocalUnitPrice(e.target.value); setPriceDriver('unit') }}
                  onBlur={saveAll}
                  className="flex-1 min-w-0 border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                <span className="text-[11px] text-gray-500 shrink-0">${'/'}{item.rawUnit ?? 'cs'}</span>
              </div>
            </label>
            <label className="block">
              <span className="block text-[10px] text-gray-500 mb-0.5">Line total</span>
              <div className="flex items-center gap-1">
                <input type="number" step="any" min="0" value={localLineTotal}
                  onChange={(e) => { setLocalLineTotal(e.target.value); setPriceDriver('total') }}
                  onBlur={saveAll}
                  className="flex-1 min-w-0 border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                <span className="text-[11px] text-gray-500 shrink-0">$</span>
              </div>
            </label>
          </div>
        </div>
      ) : mode === 'per_weight' ? (
        <div className="space-y-2.5">
          <div className="grid grid-cols-2 gap-2.5">
            <label className="block">
              <span className="block text-[10px] text-gray-500 mb-0.5">Qty ordered</span>
              <div className="flex items-center gap-1">
                <input type="number" step="any" min="0" value={localQtyOrdered}
                  onChange={(e) => setLocalQtyOrdered(e.target.value)}
                  onBlur={saveAll}
                  className="flex-1 min-w-0 border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                <span className="text-[11px] text-gray-500 shrink-0">{item.qtyOrderedUOM ?? rateUOM}</span>
              </div>
            </label>
            <label className="block">
              <span className="block text-[10px] text-gray-500 mb-0.5">Shipped (total qty)</span>
              <div className="flex items-center gap-1">
                <input type="number" step="any" min="0" value={localTotalQty}
                  onChange={(e) => setLocalTotalQty(e.target.value)}
                  onBlur={saveAll}
                  className="flex-1 min-w-0 border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                <span className="text-[11px] text-gray-500 shrink-0">{item.totalQtyUOM ?? rateUOM}</span>
              </div>
            </label>
            <label className="block">
              <span className="block text-[10px] text-gray-500 mb-0.5">Rate</span>
              <div className="flex items-center gap-1">
                <input type="number" step="any" min="0" value={localRate}
                  onChange={(e) => { setLocalRate(e.target.value); setPriceDriver('unit') }}
                  onBlur={saveAll}
                  className="flex-1 min-w-0 border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                <span className="text-[11px] text-gray-500 shrink-0">${'/'}{rateUOM}</span>
              </div>
            </label>
            <label className="block">
              <span className="block text-[10px] text-gray-500 mb-0.5">Line total</span>
              <div className="flex items-center gap-1">
                <input type="number" step="any" min="0" value={localLineTotal}
                  onChange={(e) => { setLocalLineTotal(e.target.value); setPriceDriver('total') }}
                  onBlur={saveAll}
                  className="flex-1 min-w-0 border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                <span className="text-[11px] text-gray-500 shrink-0">$</span>
              </div>
            </label>
          </div>
          <div className="text-[11px] text-gray-500 px-1">
            Line total = total qty × rate ={' '}
            <span className="font-medium text-gray-700">
              {localLineTotal !== '' ? formatCurrency(parseFloat(localLineTotal))
                : (localRate !== '' && localTotalQty !== '')
                  ? formatCurrency(parseFloat(localRate) * parseFloat(localTotalQty))
                  : '—'}
            </span>
          </div>
        </div>
      ) : (
        <div className="text-xs text-gold-2 bg-gold-soft border border-[#fcd34d]/60 rounded-lg px-3 py-2">
          Mode couldn&apos;t be detected. Pick{' '}
          <button onClick={() => switchMode('per_case')} className="underline font-medium">per case</button>
          {' '}or{' '}
          <button onClick={() => switchMode('per_weight')} className="underline font-medium">per weight</button>
          {' '}to continue.
        </div>
      )}

      {/* ── Inventory cost result ──────────────────────────────────────────── */}
      {linked && <CostResult item={item} variance={variance} />}

      {/* ── Mode-mismatch note ─────────────────────────────────────────────── */}
      {pdm && mode !== 'unknown' && pdm !== mode && linked && (
        <div className="text-[11px] text-gold-2 bg-gold-soft border border-[#fcd34d]/60 rounded-lg px-3 py-2 flex items-start gap-2">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <div>
            Detected pricing is per {mode === 'per_weight' ? 'weight' : 'case'}, but{' '}
            <span className="font-medium">{linked.itemName}</span> is set up per{' '}
            {pdm === 'per_weight' ? 'weight' : 'case'}. The mode change above applies to this line only.
          </div>
        </div>
      )}
    </div>
  )
}

function ModeToggle({ current, onChange }: { current: PricingMode; onChange: (m: 'per_case' | 'per_weight') => void }) {
  const cls = (active: boolean) =>
    `px-2.5 py-1 text-[11px] font-medium transition-colors ${active ? 'bg-blue-soft text-blue-text' : 'bg-paper text-gray-500 hover:text-gray-700'}`
  return (
    <div className="inline-flex border border-gray-200 rounded-lg overflow-hidden">
      <button onClick={() => onChange('per_case')}   className={cls(current === 'per_case')}>case</button>
      <button onClick={() => onChange('per_weight')} className={cls(current === 'per_weight')}>weight</button>
    </div>
  )
}

// ── Inline field editor — debounced PATCH on blur ────────────────────────────
function NumField({
  label, value, onCommit, uom, placeholder, step = 'any',
}: {
  label: string
  value: string | number | null | undefined
  onCommit: (next: string) => void
  uom?: string | null
  placeholder?: string
  step?: string
}) {
  const [local, setLocal] = useState(value == null ? '' : String(Number(value)))
  useEffect(() => { setLocal(value == null ? '' : String(Number(value))) }, [value])
  return (
    <label className="block">
      <span className="block text-[10px] text-gray-500 mb-0.5">{label}</span>
      <div className="flex items-center gap-1">
        <input
          type="number"
          step={step}
          min="0"
          value={local}
          onChange={(e) => setLocal(e.target.value)}
          onBlur={() => { if (local !== (value == null ? '' : String(Number(value)))) onCommit(local) }}
          placeholder={placeholder}
          className="flex-1 min-w-0 border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
        />
        {uom && <span className="text-[11px] text-gray-500 shrink-0">{uom}</span>}
      </div>
    </label>
  )
}

function TextField({
  label, value, onCommit, placeholder,
}: {
  label: string
  value: string | null | undefined
  onCommit: (next: string) => void
  placeholder?: string
}) {
  const [local, setLocal] = useState(value ?? '')
  useEffect(() => { setLocal(value ?? '') }, [value])
  return (
    <label className="block">
      <span className="block text-[10px] text-gray-500 mb-0.5">{label}</span>
      <input
        type="text"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => { if (local !== (value ?? '')) onCommit(local) }}
        placeholder={placeholder}
        className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
      />
    </label>
  )
}

function CostResult({ item, variance }: { item: ScanItem; variance: number | null }) {
  const inv = item.matchedItem
  if (!inv) return null
  const prev = inv.pricePerBaseUnit != null ? Number(inv.pricePerBaseUnit) : null
  // Local recompute mirroring selectors.newCostPerBaseUnit, but expressed
  // for display so we don't have to thread it through props.
  const baseUnit = inv.baseUnit || 'each'
  return (
    <div className="border-t border-dashed border-gray-200 pt-2.5 flex items-center justify-between gap-3 flex-wrap text-[12px]">
      <div className="text-gray-500">
        inventory cost in <span className="font-mono">{baseUnit}</span>
        {prev != null && (
          <> · last applied <span className="font-medium text-gray-700">${prev.toFixed(4)}/{baseUnit}</span></>
        )}
      </div>
      {variance != null && (
        <VariancePill v={variance} />
      )}
    </div>
  )
}

// ── Drawer footer ─────────────────────────────────────────────────────────────
function DrawerFooter({
  session, approvedBy, onApprovedByChange, onApprove, onReject, isApproving,
}: {
  session: Session
  approvedBy: string
  onApprovedByChange: (v: string) => void
  onApprove: () => void
  onReject: () => void
  isApproving: boolean
}) {
  const blockers = useMemo(() => ({
    unknownMode: session.scanItems.filter(isUnknownMode).length,
    needsLink:   session.scanItems.filter(isNeedsLink).length,
    mismatch:    session.scanItems.filter(isModeMismatch).length,
    lowConf:     session.scanItems.filter(isLowConfidence).length,
  }), [session.scanItems])

  const totalItems = session.scanItems.length
  const canApprove = approvedBy.trim().length > 0 && blockers.unknownMode === 0 && blockers.needsLink === 0 && !isApproving
  const hasBlockerHint = blockers.needsLink > 0 || blockers.mismatch > 0 || blockers.lowConf > 0 || blockers.unknownMode > 0

  return (
    <div className="sticky bottom-0 bg-paper border-t border-gray-200 px-4 py-3 pb-safe flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
      <div className="flex-1 text-[12px] text-gray-600 leading-tight">
        <div className="font-medium text-gray-800">{totalItems} items</div>
        {hasBlockerHint && (
          <div className="text-[11px] text-gray-500 mt-0.5">
            {[
              blockers.unknownMode > 0 ? `${blockers.unknownMode} unknown mode` : null,
              blockers.needsLink   > 0 ? `${blockers.needsLink} needs link`     : null,
              blockers.mismatch    > 0 ? `${blockers.mismatch} mismatch`        : null,
              blockers.lowConf     > 0 ? `${blockers.lowConf} low conf`         : null,
            ].filter(Boolean).join(' · ')}
          </div>
        )}
      </div>
      <input
        type="text"
        value={approvedBy}
        onChange={(e) => onApprovedByChange(e.target.value)}
        placeholder="Your name"
        aria-label="Approver name"
        className={`border rounded-lg px-3 py-1.5 text-sm w-full sm:w-36 focus:outline-none focus:ring-2 focus:ring-gold ${
          !approvedBy ? 'border-[#fcd34d] bg-gold-soft' : 'border-gray-200'
        }`}
      />
      <div className="flex items-center gap-2">
        <button
          onClick={onReject}
          disabled={isApproving}
          className="border border-red text-red rounded-lg px-4 py-2 text-sm font-medium hover:bg-red-soft disabled:opacity-50"
        >
          Reject
        </button>
        <button
          onClick={onApprove}
          disabled={!canApprove}
          title={!canApprove
            ? blockers.unknownMode > 0 ? 'Resolve unknown-mode rows first'
              : blockers.needsLink > 0 ? 'Link or create all rows first'
              : !approvedBy.trim() ? 'Enter your name'
              : ''
            : ''}
          className="bg-green-text text-paper rounded-lg px-4 py-2 text-sm font-medium flex items-center gap-2 hover:bg-green-text disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isApproving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
          {isApproving ? 'Approving…' : 'Approve & apply'}
        </button>
      </div>
    </div>
  )
}

// Unused import suppressions — Plus is reserved for an upcoming manual-add hook
void Plus

```


---

## `src/components/invoices/v2/ImageViewer.tsx`

```tsx
'use client'
// Invoice image viewer with zoom / pan / rotate toolbar and SVG bbox highlight.

import { useState, useRef, useEffect, useCallback } from 'react'
import { RotateCcw, RotateCw, Maximize2, FileText, Minus, Plus } from 'lucide-react'

export interface BBox {
  page: number   // 0-indexed file index
  x: number      // left edge as fraction of image width  (0–1)
  y: number      // top edge  as fraction of image height (0–1)
  w: number      // width  as fraction of image width
  h: number      // height as fraction of image height
}

interface Props {
  files: Array<{ id: string; fileName: string; fileType: string; fileUrl: string }>
  activeBbox?: BBox | null
}

const ZOOM_STEP = 0.25
const ZOOM_MIN  = 0.25
const ZOOM_MAX  = 6
const PADDING   = 16   // px of inset padding around the image

export function ImageViewerV2({ files, activeBbox }: Props) {
  const [activeIdx,   setActiveIdx]   = useState(0)
  const [zoom,        setZoom]        = useState(1)
  const [rotation,    setRotation]    = useState(0)
  const [pan,         setPan]         = useState({ x: 0, y: 0 })
  const [isDragging,  setIsDragging]  = useState(false)
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null)
  const [bboxKey,     setBboxKey]     = useState(0)
  // Pixel rect of the rendered image inside containerRef (for bbox SVG positioning)
  const [imgRect,     setImgRect]     = useState<{ x: number; y: number; w: number; h: number } | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const dragStart    = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)

  const file    = files[activeIdx]
  const isPdf   = file?.fileType === 'application/pdf' || file?.fileName?.endsWith('.pdf')
  const isImage = file?.fileType?.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif)$/i.test(file?.fileName ?? '')

  // ── Compute the pixel rect of the contained image ──────────────────────────
  // object-fit: contain centres the image and letterboxes — we need the exact
  // rendered rect so the bbox SVG overlay aligns with the visible pixels.
  const computeImgRect = useCallback((ns: { w: number; h: number }) => {
    const c = containerRef.current
    if (!c) return
    const availW = c.clientWidth  - PADDING * 2
    const availH = c.clientHeight - PADDING * 2
    if (availW <= 0 || availH <= 0) return
    const scale = Math.min(availW / ns.w, availH / ns.h)
    const rw = ns.w * scale
    const rh = ns.h * scale
    setImgRect({
      x: PADDING + (availW - rw) / 2,
      y: PADDING + (availH - rh) / 2,
      w: rw,
      h: rh,
    })
  }, [])

  // Recompute whenever container resizes (also fires when hidden → visible on tab switch)
  useEffect(() => {
    const c = containerRef.current
    if (!c || !naturalSize) return
    const obs = new ResizeObserver(() => computeImgRect(naturalSize))
    obs.observe(c)
    computeImgRect(naturalSize)
    return () => obs.disconnect()
  }, [naturalSize, computeImgRect])

  // ── Reset when switching files ──────────────────────────────────────────────
  useEffect(() => {
    setZoom(1); setRotation(0); setPan({ x: 0, y: 0 }); setNaturalSize(null); setImgRect(null)
  }, [activeIdx])

  // ── Switch page when activeBbox points to a different file ──────────────────
  useEffect(() => {
    if (activeBbox && activeBbox.page !== activeIdx) setActiveIdx(activeBbox.page)
  }, [activeBbox]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Record natural size on load ─────────────────────────────────────────────
  const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget
    const ns = { w: img.naturalWidth, h: img.naturalHeight }
    setNaturalSize(ns)
    computeImgRect(ns)
  }, [computeImgRect])

  // ── Auto-pan+zoom to activeBbox ─────────────────────────────────────────────
  const AUTO_ZOOM_MAX = 2.5

  useEffect(() => {
    if (!activeBbox || activeBbox.page !== activeIdx || !naturalSize || !containerRef.current) return

    setBboxKey(k => k + 1)

    const rect = containerRef.current.getBoundingClientRect()
    const cw = rect.width  - PADDING * 2
    const ch = rect.height - PADDING * 2
    if (cw <= 0 || ch <= 0) return

    const scale  = Math.min(cw / naturalSize.w, ch / naturalSize.h)
    const rendW  = naturalSize.w * scale
    const rendH  = naturalSize.h * scale

    const bboxCx = activeBbox.x + activeBbox.w / 2
    const bboxCy = activeBbox.y + activeBbox.h / 2

    const rad    = (rotation * Math.PI) / 180
    const cosA   = Math.abs(Math.cos(rad))
    const sinA   = Math.abs(Math.sin(rad))
    const bboxVisW = (activeBbox.w * cosA + activeBbox.h * sinA) * rendW
    const bboxVisH = (activeBbox.h * cosA + activeBbox.w * sinA) * rendH

    if (bboxVisW < 2 || bboxVisH < 2) return

    const targetZoom = Math.min(
      Math.max((Math.min(cw, ch) * 0.4) / Math.max(bboxVisW, bboxVisH), 1.2),
      AUTO_ZOOM_MAX,
    )

    const dx = (bboxCx - 0.5) * rendW
    const dy = (bboxCy - 0.5) * rendH
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    const rdx = cos * dx - sin * dy
    const rdy = sin * dx + cos * dy

    const panX = -rdx * targetZoom
    const panY = -rdy * targetZoom
    const maxPanX = (rendW  * targetZoom - cw)  / 2
    const maxPanY = (rendH  * targetZoom - ch) / 2
    setZoom(targetZoom)
    setPan({
      x: Math.max(-maxPanX, Math.min(maxPanX, panX)),
      y: Math.max(-maxPanY, Math.min(maxPanY, panY)),
    })
  }, [activeBbox, activeIdx, naturalSize, rotation]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Toolbar actions ─────────────────────────────────────────────────────────
  const zoomIn      = () => setZoom(z => Math.min(ZOOM_MAX, +(z + ZOOM_STEP).toFixed(2)))
  const zoomOut     = () => setZoom(z => Math.max(ZOOM_MIN, +(z - ZOOM_STEP).toFixed(2)))
  const rotateRight = () => setRotation(r => (r + 90) % 360)
  const rotateLeft  = () => setRotation(r => (r + 270) % 360)
  const reset       = () => { setZoom(1); setRotation(0); setPan({ x: 0, y: 0 }) }

  // ── Mouse-wheel zoom ────────────────────────────────────────────────────────
  const handleWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    if (e.deltaY < 0) zoomIn(); else zoomOut()
  }

  // ── Drag-to-pan ─────────────────────────────────────────────────────────────
  const handleMouseDown = (e: React.MouseEvent) => {
    if (zoom <= 1) return
    setIsDragging(true)
    dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y }
  }
  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || !dragStart.current) return
    setPan({
      x: dragStart.current.panX + (e.clientX - dragStart.current.x),
      y: dragStart.current.panY + (e.clientY - dragStart.current.y),
    })
  }
  const stopDrag = () => { setIsDragging(false); dragStart.current = null }

  const Btn = ({ onClick, children, title, disabled }: {
    onClick: () => void; children: React.ReactNode; title: string; disabled?: boolean
  }) => (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className="p-1.5 rounded-md text-ink-4 hover:bg-[#3a352d] hover:text-bg-2 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
    >
      {children}
    </button>
  )

  const showBbox = activeBbox && activeBbox.page === activeIdx && isImage

  const transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rotation}deg)`
  const transition = isDragging ? 'none' : 'transform 350ms cubic-bezier(0.4, 0, 0.2, 1)'

  return (
    <div className="flex flex-col bg-[#1f1d1a] w-full md:flex-1 md:min-w-0 overflow-hidden">

      {/* File / page tabs */}
      {files.length > 1 && (
        <div className="flex gap-1 px-3 py-2 border-b border-[#3a352d] bg-[#27241f] overflow-x-auto shrink-0">
          {files.map((f, i) => (
            <button
              key={f.id}
              onClick={() => setActiveIdx(i)}
              className={`px-3 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
                activeIdx === i ? 'bg-gold/15 text-[#fcd34d]' : 'text-ink-4 hover:bg-[#3a352d]'
              }`}
            >
              Page {i + 1}
            </button>
          ))}
        </div>
      )}

      {/* Toolbar */}
      {isImage && file?.fileUrl && (
        <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-[#3a352d] bg-[#27241f] shrink-0">
          <Btn onClick={zoomOut} title="Zoom out" disabled={zoom <= ZOOM_MIN}><Minus size={14} /></Btn>
          <span className="text-xs font-mono text-ink-4 w-12 text-center select-none">
            {Math.round(zoom * 100)}%
          </span>
          <Btn onClick={zoomIn} title="Zoom in" disabled={zoom >= ZOOM_MAX}><Plus size={14} /></Btn>
          <div className="w-px h-4 bg-[#3a352d] mx-1" />
          <Btn onClick={rotateLeft}  title="Rotate left"><RotateCcw size={14} /></Btn>
          <Btn onClick={rotateRight} title="Rotate right"><RotateCw size={14} /></Btn>
          <div className="w-px h-4 bg-[#3a352d] mx-1" />
          <Btn onClick={reset} title="Reset view"><Maximize2 size={14} /></Btn>
          {showBbox && (
            <span className="ml-auto text-[10.5px] text-[#fcd34d] font-medium px-2 py-0.5 bg-gold/15 rounded">
              line highlighted
            </span>
          )}
        </div>
      )}

      {/* Image / PDF / fallback */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden select-none relative"
        style={{ cursor: isImage && zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default' }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={stopDrag}
        onMouseLeave={stopDrag}
      >
        {isImage && file?.fileUrl ? (
          <>
            {/* Image — object-fit:contain guarantees it fits the container at any size */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={file.fileUrl}
              alt={file.fileName}
              draggable={false}
              onLoad={handleImageLoad}
              className="rounded-lg shadow-sm border border-gray-200"
              style={{
                position: 'absolute',
                left: PADDING, top: PADDING, right: PADDING, bottom: PADDING,
                width: `calc(100% - ${PADDING * 2}px)`,
                height: `calc(100% - ${PADDING * 2}px)`,
                objectFit: 'contain',
                objectPosition: 'center',
                display: 'block',
                transform,
                transformOrigin: 'center center',
                transition,
                userSelect: 'none',
              }}
            />

            {/* SVG bbox overlay — positioned to match the rendered image pixels */}
            {showBbox && imgRect && (
              <svg
                key={bboxKey}
                viewBox="0 0 1 1"
                preserveAspectRatio="none"
                style={{
                  position: 'absolute',
                  left: imgRect.x,
                  top: imgRect.y,
                  width: imgRect.w,
                  height: imgRect.h,
                  pointerEvents: 'none',
                  overflow: 'visible',
                  transform,
                  transformOrigin: 'center center',
                  transition,
                }}
                className="rounded-lg"
              >
                <rect
                  className="bbox-highlight"
                  x={activeBbox!.x} y={activeBbox!.y}
                  width={activeBbox!.w} height={activeBbox!.h}
                  fill="rgba(251, 191, 36, 0.22)" rx="0.004"
                />
                <rect
                  className="bbox-ring"
                  x={activeBbox!.x} y={activeBbox!.y}
                  width={activeBbox!.w} height={activeBbox!.h}
                  fill="none" stroke="rgb(245, 158, 11)" strokeWidth="0.003" rx="0.004"
                />
                <CornerAccent cx={activeBbox!.x} cy={activeBbox!.y} size={0.018} position="tl" />
                <CornerAccent cx={activeBbox!.x + activeBbox!.w} cy={activeBbox!.y + activeBbox!.h} size={0.018} position="br" />
              </svg>
            )}
          </>
        ) : isPdf && file?.fileUrl ? (
          <div className="absolute inset-0 p-2">
            <iframe
              src={file.fileUrl}
              title={file.fileName}
              className="w-full h-full rounded-lg border border-gray-200 bg-paper"
            />
          </div>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-gray-400">
            <FileText size={40} className="text-gray-300" />
            <p className="text-sm">{file?.fileName ?? 'No file'}</p>
            {file?.fileUrl && (
              <a href={file.fileUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue hover:underline">
                Open file ↗
              </a>
            )}
          </div>
        )}
      </div>

      {/* File name footer */}
      <div className="px-3 py-2 border-t border-[#3a352d] bg-[#27241f] shrink-0">
        <p className="font-mono text-[10px] text-ink-3 truncate">{file?.fileName}</p>
      </div>
    </div>
  )
}

// ── Corner accent ──────────────────────────────────────────────────────────────
function CornerAccent({ cx, cy, size, position }: {
  cx: number; cy: number; size: number; position: 'tl' | 'br'
}) {
  const s = size
  const paths = {
    tl: `M ${cx + s} ${cy} L ${cx} ${cy} L ${cx} ${cy + s}`,
    br: `M ${cx - s} ${cy} L ${cx} ${cy} L ${cx} ${cy - s}`,
  }
  return (
    <path
      className="bbox-ring"
      d={paths[position]}
      fill="none"
      stroke="rgb(245, 158, 11)"
      strokeWidth="0.004"
      strokeLinecap="round"
    />
  )
}

```


---

## `src/components/invoices/v2/context.tsx`

```tsx
'use client'
// DrawerContext — shared state for the invoice review drawer.
// Provider is built in Phase 5. This file defines the shape and the hook.

import { createContext, useContext } from 'react'
import type { ScanItem } from '@/components/invoices/types'
import type { RevenueCenter } from '@/contexts/RevenueCenterContext'
import type { ReconcileResult } from './composites'
import type { FilterKey, SortMode } from '@/lib/invoice/filters'

export interface DrawerContextValue {
  // ── Server-sourced data ────────────────────────────────────────────────────
  lines: ScanItem[]
  revenueCenters: RevenueCenter[]

  // ── Client-side staged edits ───────────────────────────────────────────────
  editedLines: Map<string, Partial<ScanItem>>

  // ── UI state ───────────────────────────────────────────────────────────────
  expandedLineIds: Set<string>
  flashingLineIds: Set<string>        // temporary flash highlight after goToTask
  activeFilters: Set<FilterKey>
  sortMode: SortMode
  pickingLinkForId: string | null     // which line's link picker is open
  modeWritebackItems: Set<string>     // lines where user wants to update product default mode
  acknowledgedPriceLines: Set<string> // lines where the user accepted the price change

  // ── Reconciliation result ──────────────────────────────────────────────────
  reconciliation: ReconcileResult | null

  // ── Computed helpers ───────────────────────────────────────────────────────
  /** Returns server line with staged edits applied. */
  getEffectiveLine: (id: string) => ScanItem
  /** Looks up the full RevenueCenter for a line's revenueCenterId. */
  getItemRc: (id: string) => RevenueCenter | null

  // ── Line mutations ─────────────────────────────────────────────────────────
  updateLine: (id: string, patch: Partial<ScanItem>) => void
  clearLineEdits: (id: string) => void

  // ── Expand / collapse ──────────────────────────────────────────────────────
  toggleExpand: (id: string, forceOpen?: boolean) => void

  // ── Revenue center ─────────────────────────────────────────────────────────
  setLineRc: (id: string, rc: RevenueCenter | null) => void

  // ── Link picker ────────────────────────────────────────────────────────────
  startLinkPicker: (id: string) => void
  closeLinkPicker: () => void

  // ── Create new inventory item modal ───────────────────────────────────────
  openCreateNew: (item: ScanItem) => void

  // ── Edit linked inventory item ─────────────────────────────────────────────
  openInventoryEdit: (inventoryItemId: string) => void

  // ── Mode writeback checkbox ────────────────────────────────────────────────
  toggleModeWriteback: (id: string) => void

  // ── Price-change acknowledgement (resolves the price .issue) ───────────────
  acknowledgePrice: (id: string) => void

  // ── Active bbox for image highlight ────────────────────────────────────────
  activeBboxItemId: string | null     // which line card is expanded + has a bbox

  // ── Filters / sort ─────────────────────────────────────────────────────────
  toggleFilter: (k: FilterKey) => void
  setSortMode: (m: SortMode) => void
}

export const DrawerContext = createContext<DrawerContextValue | null>(null)

export function useDrawerContext(): DrawerContextValue {
  const ctx = useContext(DrawerContext)
  if (!ctx) throw new Error('useDrawerContext must be called inside <InvoiceReviewDrawer>')
  return ctx
}

```


---

## `src/components/invoices/InboxViewV2.tsx`

```tsx
'use client'
import { useEffect, useState, useCallback } from 'react'
import { formatCurrency } from '@/lib/utils'
import {
  FileText, ChefHat, ArrowRight, TrendingUp, TrendingDown,
  Upload, Clock, CheckCircle2, AlertTriangle, X, Loader2,
} from 'lucide-react'
import { SessionSummary, SessionStatus } from './types'

// ── Types ─────────────────────────────────────────────────────────────────────

interface PriceAlert {
  id: string
  direction: string
  changePct: number
  previousPrice: number
  newPrice: number
  acknowledged: boolean
  inventoryItem: { id: string; itemName: string }
  session: { id: string; supplierName: string | null; invoiceDate: string | null }
}

interface RecipeAlert {
  id: string
  changePct: number
  newFoodCostPct: number | null
  exceededThreshold: boolean
  acknowledged: boolean
  recipe: { id: string; name: string; menuPrice: number | null }
  session: { id: string; supplierName: string | null }
}

interface Props {
  sessions: SessionSummary[]
  onSelectSession: (id: string) => void
  onUploadClick: () => void
  onScanClick?: () => void
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_LABEL: Partial<Record<SessionStatus, string>> = {
  REVIEW:     'Needs review',
  PROCESSING: 'Processing',
  UPLOADING:  'Uploading',
  APPROVING:  'Applying',
  ERROR:      'Error',
}

const STATUS_TINT: Partial<Record<SessionStatus, { bg: string; text: string; dot: string }>> = {
  REVIEW:     { bg: 'bg-gold-soft',  text: 'text-gold-2',    dot: 'bg-gold' },
  PROCESSING: { bg: 'bg-blue-soft',  text: 'text-blue-text', dot: 'bg-blue' },
  UPLOADING:  { bg: 'bg-blue-soft',  text: 'text-blue-text', dot: 'bg-blue' },
  APPROVING:  { bg: 'bg-blue-soft',  text: 'text-blue-text', dot: 'bg-blue' },
  ERROR:      { bg: 'bg-red-soft',   text: 'text-red-text',  dot: 'bg-red' },
}

function fmtDate(d: string | null) {
  if (!d) return null
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function fmtAge(createdAt: string) {
  const mins = Math.floor((Date.now() - new Date(createdAt).getTime()) / 60_000)
  if (mins < 1)    return 'just now'
  if (mins < 60)   return `${mins}m ago`
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`
  return `${Math.floor(mins / 1440)}d ago`
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionHead({ label, count, action }: { label: string; count: number; action?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between mb-2 px-1">
      <h3 className="font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3 flex items-baseline gap-2">
        {label}
        {count > 0 && <span className="font-mono text-[10.5px] text-ink-2 normal-case tracking-normal">· {count}</span>}
      </h3>
      {action}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function InboxViewV2({ sessions, onSelectSession, onUploadClick, onScanClick }: Props) {
  const [priceAlerts, setPriceAlerts]   = useState<PriceAlert[]>([])
  const [recipeAlerts, setRecipeAlerts] = useState<RecipeAlert[]>([])
  const [dismissing, setDismissing]     = useState<Set<string>>(new Set())

  const fetchAlerts = useCallback(async () => {
    try {
      const data = await fetch('/api/invoices/alerts', { cache: 'no-store' }).then(r => r.ok ? r.json() : null)
      if (data) {
        setPriceAlerts(data.priceAlerts ?? [])
        setRecipeAlerts(data.recipeAlerts ?? [])
      }
    } catch {}
  }, [])

  useEffect(() => {
    fetchAlerts()
    const t = setInterval(fetchAlerts, 30_000)
    return () => clearInterval(t)
  }, [fetchAlerts])

  // Queue: non-approved, non-rejected sessions, sorted by urgency
  const queue = sessions
    .filter(s => !['APPROVED', 'REJECTED'].includes(s.status))
    .sort((a, b) => {
      const order: Partial<Record<SessionStatus, number>> = { REVIEW: 0, ERROR: 1, APPROVING: 2, PROCESSING: 3, UPLOADING: 4 }
      return (order[a.status] ?? 9) - (order[b.status] ?? 9)
    })

  // Recent approved — last 5
  const recent = sessions.filter(s => s.status === 'APPROVED').slice(0, 5)

  const alertCount = priceAlerts.length + recipeAlerts.length

  async function dismissPriceAlert(id: string) {
    setDismissing(prev => new Set([...prev, id]))
    try {
      await fetch('/api/invoices/alerts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priceAlertIds: [id] }),
      })
      setPriceAlerts(prev => prev.filter(a => a.id !== id))
    } finally {
      setDismissing(prev => { const n = new Set(prev); n.delete(id); return n })
    }
  }

  async function dismissRecipeAlert(id: string) {
    setDismissing(prev => new Set([...prev, id]))
    try {
      await fetch('/api/invoices/alerts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipeAlertIds: [id] }),
      })
      setRecipeAlerts(prev => prev.filter(a => a.id !== id))
    } finally {
      setDismissing(prev => { const n = new Set(prev); n.delete(id); return n })
    }
  }

  async function dismissAll() {
    await fetch('/api/invoices/alerts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acknowledgeAll: true }),
    })
    setPriceAlerts([])
    setRecipeAlerts([])
  }

  return (
    <div className="space-y-6">
      {/* ── Queue ────────────────────────────────────────────────────────── */}
      <section>
        <SectionHead
          label="Queue"
          count={queue.length}
          action={
            <div className="flex items-center gap-2">
              {onScanClick && (
                <button
                  onClick={onScanClick}
                  className="inline-flex items-center gap-1.5 border border-line bg-paper text-ink-2 px-3 py-[7px] rounded-[8px] text-[12.5px] font-medium hover:border-ink-3 transition-colors"
                >
                  <FileText size={12} className="text-ink-3" /> Scan
                </button>
              )}
              <button
                onClick={onUploadClick}
                className="inline-flex items-center gap-1.5 bg-ink text-paper px-3 py-[7px] rounded-[8px] text-[12.5px] font-medium hover:bg-[#18181b] transition-colors"
              >
                <Upload size={12} className="text-gold" /> Upload
              </button>
            </div>
          }
        />
        {queue.length === 0 ? (
          <div className="bg-paper border border-line rounded-[12px] px-6 py-10 text-center">
            <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-green-text">All clear</p>
            <p className="text-[13px] text-ink-3 mt-1.5">No pending invoices — your inbox is empty.</p>
          </div>
        ) : (
          <div className="bg-paper border border-line rounded-[12px] overflow-hidden">
            {queue.map((session, idx) => {
              const isActive = session.status === 'PROCESSING' || session.status === 'UPLOADING' || session.status === 'APPROVING'
              const isError  = session.status === 'ERROR'
              const canOpen  = session.status === 'REVIEW' || session.status === 'ERROR'
              const tint = STATUS_TINT[session.status] ?? { bg: 'bg-bg-2', text: 'text-ink-3', dot: 'bg-ink-4' }
              const isLast = idx === queue.length - 1

              return (
                <div
                  key={session.id}
                  onClick={() => canOpen && onSelectSession(session.id)}
                  className={`group grid grid-cols-[40px_1fr_auto_auto] gap-3.5 items-center px-[18px] py-3.5 transition-colors ${
                    isLast ? '' : 'border-b border-line'
                  } ${canOpen ? 'cursor-pointer hover:bg-bg-2/40' : 'cursor-default'} ${isError ? 'bg-red-soft/30' : ''}`}
                >
                  {/* Status icon */}
                  <div className={`w-9 h-9 rounded-[9px] grid place-items-center shrink-0 ${tint.bg}`}>
                    {isActive
                      ? <Loader2 size={15} className={`${tint.text} animate-spin`} />
                      : isError
                        ? <AlertTriangle size={15} className={tint.text} />
                        : <FileText size={15} className={tint.text} />
                    }
                  </div>

                  {/* Content */}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[14px] font-medium text-ink tracking-[-0.01em] truncate">
                        {session.supplierName ?? 'Unknown supplier'}
                      </span>
                      <span className={`inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.04em] font-medium px-2 py-0.5 rounded-full ${tint.bg} ${tint.text}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${tint.dot}`} />
                        {STATUS_LABEL[session.status] ?? session.status}
                      </span>
                    </div>
                    <div className="font-mono text-[10.5px] text-ink-3 mt-1 tracking-[0]">
                      {session.invoiceNumber && <><span className="text-ink-2">#{session.invoiceNumber}</span> · </>}
                      {session.invoiceDate && <>{fmtDate(session.invoiceDate)} · </>}
                      <b className="text-ink-2 font-medium">{session._count.scanItems}</b> {session._count.scanItems === 1 ? 'line' : 'lines'}
                      {(session._count.priceAlerts > 0 || session._count.recipeAlerts > 0) && (
                        <> · <span className="text-gold-2 font-semibold">{session._count.priceAlerts + session._count.recipeAlerts} alert{session._count.priceAlerts + session._count.recipeAlerts === 1 ? '' : 's'}</span></>
                      )}
                      <> · <span className="text-ink-4">{fmtAge(session.createdAt)}</span></>
                    </div>
                  </div>

                  {/* Total */}
                  {session.total && (
                    <div className="font-mono text-[13.5px] font-semibold text-ink tabular-nums tracking-[-0.01em] text-right whitespace-nowrap">
                      {formatCurrency(parseFloat(String(session.total)))}
                    </div>
                  )}

                  {/* CTA */}
                  {canOpen ? (
                    <button className="font-mono text-[11px] px-3 py-1.5 rounded-full bg-ink text-paper font-medium hover:bg-[#27272a] transition-colors whitespace-nowrap">
                      {isError ? 'Retry' : 'Review'}
                    </button>
                  ) : (
                    <span className="w-7" />
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* ── Price & recipe alerts ───────────────────────────────────────── */}
      <section>
        <SectionHead
          label="Active alerts"
          count={alertCount}
          action={alertCount > 0 ? (
            <button
              onClick={dismissAll}
              className="font-mono text-[10.5px] text-ink-3 hover:text-ink-2 transition-colors uppercase tracking-[0.04em]"
            >
              Dismiss all
            </button>
          ) : null}
        />
        {alertCount === 0 ? (
          <div className="bg-paper border border-line rounded-[12px] px-6 py-8 text-center">
            <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-green-text">Costs stable</p>
            <p className="text-[13px] text-ink-3 mt-1.5">No price or recipe alerts.</p>
          </div>
        ) : (
          <div className="bg-paper border border-line rounded-[12px] overflow-hidden">
            {priceAlerts.map((alert, idx) => {
              const up = alert.direction === 'UP'
              const isLast = idx === priceAlerts.length - 1 && recipeAlerts.length === 0
              return (
                <div key={alert.id}
                  className={`grid grid-cols-[40px_1fr_auto_auto] gap-3.5 items-center px-[18px] py-3 ${isLast ? '' : 'border-b border-line'}`}>
                  <div className={`w-9 h-9 rounded-[9px] grid place-items-center shrink-0 ${up ? 'bg-red-soft text-red-text' : 'bg-green-soft text-green-text'}`}>
                    {up ? <TrendingUp size={15} /> : <TrendingDown size={15} />}
                  </div>
                  <div className="min-w-0">
                    <div className="text-[13.5px] font-medium text-ink tracking-[-0.005em] truncate">{alert.inventoryItem.itemName}</div>
                    <div className="font-mono text-[10.5px] text-ink-3 mt-0.5 tracking-[0]">
                      {formatCurrency(Number(alert.previousPrice))} <span className="text-ink-4">→</span> <span className="text-ink-2">{formatCurrency(Number(alert.newPrice))}</span>
                      {alert.session.supplierName && <> · {alert.session.supplierName}</>}
                    </div>
                  </div>
                  <div className={`font-mono text-[13px] font-semibold tabular-nums whitespace-nowrap ${up ? 'text-red-text' : 'text-green-text'}`}>
                    {up ? '+' : ''}{Number(alert.changePct).toFixed(1)}%
                  </div>
                  <button
                    onClick={() => dismissPriceAlert(alert.id)}
                    disabled={dismissing.has(alert.id)}
                    title="Dismiss"
                    className="w-7 h-7 rounded-md grid place-items-center text-ink-3 hover:text-ink hover:bg-bg-2 disabled:opacity-40 transition-colors"
                  >
                    <X size={13} />
                  </button>
                </div>
              )
            })}

            {recipeAlerts.map((alert, idx) => {
              const isLast = idx === recipeAlerts.length - 1
              const sev    = alert.exceededThreshold
              return (
                <div key={alert.id}
                  className={`grid grid-cols-[40px_1fr_auto_auto] gap-3.5 items-center px-[18px] py-3 ${isLast ? '' : 'border-b border-line'}`}>
                  <div className={`w-9 h-9 rounded-[9px] grid place-items-center shrink-0 ${sev ? 'bg-red-soft text-red-text' : 'bg-gold-soft text-gold-2'}`}>
                    <ChefHat size={15} />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[13.5px] font-medium text-ink tracking-[-0.005em] truncate">{alert.recipe.name}</div>
                    <div className="font-mono text-[10.5px] text-ink-3 mt-0.5 tracking-[0]">
                      {sev && alert.newFoodCostPct !== null && (
                        <span className="text-red-text font-semibold">FC {(Number(alert.newFoodCostPct) * 100).toFixed(1)}% over target · </span>
                      )}
                      Cost {Number(alert.changePct) > 0 ? '+' : ''}{Number(alert.changePct).toFixed(1)}%
                      {alert.session.supplierName && <> · {alert.session.supplierName}</>}
                    </div>
                  </div>
                  <span className={`font-mono text-[10.5px] uppercase tracking-[0.04em] font-semibold px-2 py-0.5 rounded-full ${sev ? 'bg-red-soft text-red-text' : 'bg-gold-soft text-gold-2'}`}>
                    Recipe
                  </span>
                  <button
                    onClick={() => dismissRecipeAlert(alert.id)}
                    disabled={dismissing.has(alert.id)}
                    title="Dismiss"
                    className="w-7 h-7 rounded-md grid place-items-center text-ink-3 hover:text-ink hover:bg-bg-2 disabled:opacity-40 transition-colors"
                  >
                    <X size={13} />
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* ── Recent activity ─────────────────────────────────────────────── */}
      {recent.length > 0 && (
        <section>
          <SectionHead label="Recently approved" count={0} />
          <div className="bg-paper border border-line rounded-[12px] overflow-hidden">
            {recent.map((session, idx) => {
              const isLast = idx === recent.length - 1
              return (
                <button
                  key={session.id}
                  onClick={() => onSelectSession(session.id)}
                  className={`group w-full grid grid-cols-[28px_1fr_auto_auto] gap-3 items-center px-[18px] py-2.5 text-left hover:bg-bg-2/40 transition-colors ${isLast ? '' : 'border-b border-line'}`}
                >
                  <CheckCircle2 size={14} className="text-green-text shrink-0" />
                  <span className="text-[13px] text-ink-2 truncate">
                    {session.supplierName ?? 'Unknown'}
                    {session.invoiceDate ? <span className="font-mono text-[10.5px] text-ink-3"> · {fmtDate(session.invoiceDate)}</span> : ''}
                  </span>
                  {session.total ? (
                    <span className="font-mono text-[12.5px] text-ink tabular-nums shrink-0">
                      {formatCurrency(parseFloat(String(session.total)))}
                    </span>
                  ) : <span />}
                  <span className="font-mono text-[10.5px] text-ink-3 shrink-0 inline-flex items-center gap-1">
                    <Clock size={10} /> {fmtAge(session.createdAt)}
                  </span>
                </button>
              )
            })}
          </div>
        </section>
      )}

      {/* Footer hint */}
      <div className="flex justify-between font-mono text-[10.5px] text-ink-3 tracking-wide pt-2">
        <span>QUEUE REFRESHES EVERY 30S · OCR THEN REVIEW THEN APPROVE</span>
        <span>
          <kbd className="font-mono text-[10px] bg-bg-2 border border-line rounded px-1 py-px text-ink-2">⌘U</kbd> UPLOAD
        </span>
      </div>

      <ArrowRight className="hidden" /> {/* preserve import (used elsewhere historically) */}
    </div>
  )
}

```


---

## `src/components/invoices/InvoiceListV2.tsx`

```tsx
'use client'
import { useState, useMemo } from 'react'
import { Trash2, X, ChevronsUpDown, ChevronUp, ChevronDown, Search, FileText, Upload, MoreHorizontal, RotateCcw } from 'lucide-react'
import { SessionSummary, SessionStatus } from './types'
import { formatCurrency } from '@/lib/utils'

type Tab    = 'all' | 'REVIEW' | 'APPROVED' | 'REJECTED'
type ColKey = 'supplier' | 'date' | 'total' | 'items' | 'status'
type ColDir = 'asc' | 'desc'

// First-click direction: text cols A→Z, numeric/date cols newest/highest first
const COL_DEFAULT_DIR: Record<ColKey, ColDir> = {
  supplier: 'asc',
  date:     'desc',
  total:    'desc',
  items:    'desc',
  status:   'asc',
}

const STATUS_ORDER: Record<string, number> = {
  REVIEW: 0, PROCESSING: 1, APPROVING: 1, UPLOADING: 2, APPROVED: 3, REJECTED: 4, ERROR: 5,
}

interface Props {
  sessions: SessionSummary[]
  onSelect: (id: string) => void
  onUploadClick: () => void
  onScanClick?: () => void
  onDelete: (id: string, status: SessionStatus) => Promise<void>
  onBulkDelete: (ids: string[]) => Promise<void>
  onRetry: (id: string) => Promise<void>
}

// ── Branded status badge ─────────────────────────────────────────────────────

function StatusBadge({ status }: { status: SessionStatus }) {
  const map: Partial<Record<SessionStatus, { label: string; bg: string; text: string; dot: string; pulse?: boolean }>> = {
    REVIEW:     { label: 'Review',     bg: 'bg-gold-soft',  text: 'text-gold-2',    dot: 'bg-gold' },
    APPROVED:   { label: 'Approved',   bg: 'bg-green-soft', text: 'text-green-text', dot: 'bg-green' },
    REJECTED:   { label: 'Rejected',   bg: 'bg-red-soft',   text: 'text-red-text',  dot: 'bg-red' },
    PROCESSING: { label: 'Processing', bg: 'bg-blue-soft',  text: 'text-blue-text', dot: 'bg-blue', pulse: true },
    APPROVING:  { label: 'Applying',   bg: 'bg-blue-soft',  text: 'text-blue-text', dot: 'bg-blue', pulse: true },
    UPLOADING:  { label: 'Uploading',  bg: 'bg-bg-2',       text: 'text-ink-3',     dot: 'bg-ink-4', pulse: true },
    ERROR:      { label: 'Error',      bg: 'bg-red-soft',   text: 'text-red-text',  dot: 'bg-red' },
  }
  const t = map[status] ?? { label: String(status), bg: 'bg-bg-2', text: 'text-ink-3', dot: 'bg-ink-4' }
  return (
    <span className={`inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.04em] font-medium px-2 py-0.5 rounded-full ${t.bg} ${t.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${t.dot} ${t.pulse ? 'animate-pulse' : ''}`} />
      {t.label}
    </span>
  )
}

function SortIcon({ col, colSort }: { col: ColKey; colSort: { col: ColKey; dir: ColDir } | null }) {
  if (!colSort || colSort.col !== col)
    return <ChevronsUpDown size={10} className="text-ink-4 ml-0.5 inline-block shrink-0" />
  return colSort.dir === 'asc'
    ? <ChevronUp   size={10} className="text-gold ml-0.5 inline-block shrink-0" />
    : <ChevronDown size={10} className="text-gold ml-0.5 inline-block shrink-0" />
}

function SortTh({ col, label, colSort, onSort, className = '' }: {
  col: ColKey; label: string
  colSort: { col: ColKey; dir: ColDir } | null
  onSort: (c: ColKey) => void
  className?: string
}) {
  const active = colSort?.col === col
  return (
    <button
      onClick={() => onSort(col)}
      className={`inline-flex items-center gap-0.5 font-mono text-[10px] uppercase tracking-[0.04em] rounded transition-colors whitespace-nowrap
        ${active ? 'text-gold' : 'text-ink-3 hover:text-ink-2'} ${className}`}
    >
      {label}
      <SortIcon col={col} colSort={colSort} />
    </button>
  )
}

function Checkbox({ checked, indeterminate, onChange }: {
  checked: boolean
  indeterminate?: boolean
  onChange: () => void
}) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onChange() }}
      className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
        checked || indeterminate
          ? 'bg-ink border-ink text-paper'
          : 'border-line bg-paper hover:border-ink-3'
      }`}
    >
      {checked && <span className="text-[10px] leading-none">✓</span>}
      {indeterminate && !checked && <span className="block w-2 h-0.5 bg-paper" />}
    </button>
  )
}

// ── Main ─────────────────────────────────────────────────────────────────────

export function InvoiceListV2({ sessions, onSelect, onUploadClick, onScanClick, onDelete, onBulkDelete, onRetry }: Props) {
  const [tab, setTab]                     = useState<Tab>('all')
  const [search, setSearch]               = useState('')
  const [openMenu, setOpenMenu]           = useState<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; status: SessionStatus } | null>(null)
  const [isDeleting, setIsDeleting]       = useState(false)
  const [colSort, setColSort]             = useState<{ col: ColKey; dir: ColDir } | null>(null)

  const [selectedIds, setSelectedIds]             = useState<Set<string>>(new Set())
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false)
  const [isBulkDeleting, setIsBulkDeleting]       = useState(false)

  const reviewCount = sessions.filter(s => s.status === 'REVIEW').length

  const handleSort = (col: ColKey) => {
    setColSort(prev => {
      if (!prev || prev.col !== col) return { col, dir: COL_DEFAULT_DIR[col] }
      return { col, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
    })
  }

  const filtered = useMemo(() => {
    let rows = sessions.filter(s => {
      if (tab !== 'all' && s.status !== tab) return false
      if (search) {
        const q = search.toLowerCase()
        return (
          (s.supplierName?.toLowerCase().includes(q) ?? false) ||
          (s.invoiceNumber?.toLowerCase().includes(q) ?? false)
        )
      }
      return true
    })

    if (colSort) {
      const { col, dir } = colSort
      const sign = dir === 'asc' ? 1 : -1
      rows = [...rows].sort((a, b) => {
        switch (col) {
          case 'supplier': {
            const aName = (a.supplierName ?? '').toLowerCase()
            const bName = (b.supplierName ?? '').toLowerCase()
            return sign * aName.localeCompare(bName)
          }
          case 'date': {
            const aD = a.invoiceDate ?? a.createdAt
            const bD = b.invoiceDate ?? b.createdAt
            return sign * aD.localeCompare(bD)
          }
          case 'total': return sign * (Number(a.total ?? 0) - Number(b.total ?? 0))
          case 'items': return sign * (a._count.scanItems - b._count.scanItems)
          case 'status': return sign * ((STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9))
          default: return 0
        }
      })
    }

    return rows
  }, [sessions, tab, search, colSort])

  const allSelected  = filtered.length > 0 && filtered.every(s => selectedIds.has(s.id))
  const someSelected = filtered.some(s => selectedIds.has(s.id))
  const selectedInView = filtered.filter(s => selectedIds.has(s.id))
  const hasApproved    = selectedInView.some(s => s.status === 'APPROVED')

  const toggleOne = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const toggleAll = () => {
    if (allSelected) {
      setSelectedIds(prev => { const n = new Set(prev); filtered.forEach(s => n.delete(s.id)); return n })
    } else {
      setSelectedIds(prev => { const n = new Set(prev); filtered.forEach(s => n.add(s.id)); return n })
    }
  }

  const clearSelection = () => setSelectedIds(new Set())

  const handleDelete = async (id: string, status: SessionStatus) => {
    setIsDeleting(true)
    await onDelete(id, status)
    setIsDeleting(false)
    setDeleteConfirm(null)
    setSelectedIds(prev => { const n = new Set(prev); n.delete(id); return n })
  }

  const handleBulkDelete = async () => {
    setIsBulkDeleting(true)
    await onBulkDelete(selectedInView.map(s => s.id))
    setIsBulkDeleting(false)
    setBulkDeleteConfirm(false)
    clearSelection()
  }

  return (
    <div className="space-y-3">
      {/* ── Toolbar ── */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Filter pills */}
        <div className="inline-flex bg-paper border border-line rounded-[9px] p-[3px] gap-0.5">
          {(['all', 'REVIEW', 'APPROVED', 'REJECTED'] as Tab[]).map(t => (
            <button key={t} onClick={() => { setTab(t); clearSelection() }}
              className={`font-mono text-[11px] px-3 py-1.5 rounded-[6px] tracking-[0.02em] uppercase transition-colors inline-flex items-center gap-1.5 ${
                tab === t ? 'bg-ink text-paper' : 'text-ink-3 hover:text-ink-2'
              }`}
            >
              {t === 'all' ? 'All' : t === 'REVIEW' ? 'Review' : t === 'APPROVED' ? 'Approved' : 'Rejected'}
              {t === 'REVIEW' && reviewCount > 0 && (
                <span className={`font-mono text-[10px] px-1.5 rounded-full leading-tight ${tab === t ? 'bg-gold text-ink' : 'bg-gold-soft text-gold-2'}`}>{reviewCount}</span>
              )}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="flex-1 min-w-[200px] relative">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
          <input
            value={search}
            onChange={e => { setSearch(e.target.value); clearSelection() }}
            placeholder="Search supplier or invoice #…"
            className="w-full bg-paper border border-line rounded-[9px] pl-8 pr-3 py-[7px] text-[13px] text-ink placeholder-ink-4 focus:outline-none focus:ring-2 focus:ring-gold"
          />
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          {onScanClick && (
            <button onClick={onScanClick}
              className="inline-flex items-center gap-1.5 border border-line bg-paper text-ink-2 px-3 py-[7px] rounded-[8px] text-[12.5px] font-medium hover:border-ink-3 transition-colors">
              <FileText size={12} className="text-ink-3" /> Scan
            </button>
          )}
          <button onClick={onUploadClick}
            className="inline-flex items-center gap-1.5 bg-ink text-paper px-3 py-[7px] rounded-[8px] text-[12.5px] font-medium hover:bg-[#18181b] transition-colors">
            <Upload size={12} className="text-gold" /> Upload
          </button>
        </div>
      </div>

      {/* ── Bulk action bar ── */}
      {selectedInView.length > 0 && (
        <div className="flex items-center gap-3 px-4 py-2.5 bg-ink text-paper rounded-[10px]">
          <span className="font-mono text-[11px] uppercase tracking-[0.04em]">
            <span className="text-gold font-semibold">{selectedInView.length}</span> selected
          </span>
          <div className="flex-1" />
          <button onClick={clearSelection}
            className="font-mono text-[11px] uppercase tracking-[0.04em] text-zinc-400 hover:text-paper inline-flex items-center gap-1 transition-colors">
            <X size={11} /> Clear
          </button>
          <button onClick={() => setBulkDeleteConfirm(true)}
            className="inline-flex items-center gap-1.5 bg-red-600 text-white text-[12px] font-medium px-3 py-1.5 rounded-[8px] hover:bg-red-700 transition-colors">
            <Trash2 size={11} /> Delete {selectedInView.length}
          </button>
        </div>
      )}

      {/* ── Table ── */}
      <div className="bg-paper border border-line rounded-[12px] overflow-hidden">
        {/* Desktop column headers */}
        <div className="hidden sm:grid grid-cols-[36px_1fr_110px_120px_70px_110px_36px] gap-2 px-[18px] py-2.5 bg-bg-2 border-b border-line items-center">
          <Checkbox checked={allSelected} indeterminate={someSelected && !allSelected} onChange={toggleAll} />
          <SortTh col="supplier" label="Supplier / Invoice" colSort={colSort} onSort={handleSort} />
          <SortTh col="date"     label="Date"               colSort={colSort} onSort={handleSort} />
          <SortTh col="total"    label="Total"              colSort={colSort} onSort={handleSort} className="justify-self-end" />
          <SortTh col="items"    label="Items"              colSort={colSort} onSort={handleSort} className="justify-self-end" />
          <SortTh col="status"   label="Status"             colSort={colSort} onSort={handleSort} />
          <div />
        </div>

        <div onClick={() => setOpenMenu(null)}>
          {filtered.length === 0 && (
            <div className="py-12 text-center font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3">No invoices found</div>
          )}

          {filtered.map((s, idx) => {
            const isSelected = selectedIds.has(s.id)
            const isInflight = s.status === 'PROCESSING' || s.status === 'APPROVING' || s.status === 'ERROR'
            const canOpen    = !isInflight
            const isLast     = idx === filtered.length - 1
            return (
              <div key={s.id}>
                {/* Desktop row */}
                <div
                  className={`hidden sm:grid grid-cols-[36px_1fr_110px_120px_70px_110px_36px] gap-2 px-[18px] py-3 items-center transition-colors ${
                    isLast ? '' : 'border-b border-line'
                  } ${
                    isInflight ? 'opacity-70 cursor-default'
                    : isSelected ? 'bg-gold-soft/40 hover:bg-gold-soft/60 cursor-pointer'
                    : s.status === 'REVIEW' ? 'bg-gold-soft/30 hover:bg-gold-soft/50 cursor-pointer'
                    : 'hover:bg-bg-2/40 cursor-pointer'
                  }`}
                  onClick={() => canOpen && onSelect(s.id)}
                >
                  <Checkbox checked={isSelected} onChange={() => toggleOne(s.id)} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[13.5px] font-medium text-ink tracking-[-0.005em] truncate">
                        {s.supplierName ?? 'Unknown supplier'}
                      </span>
                      {s.parentSessionId && (
                        <span className="font-mono text-[9px] uppercase tracking-[0.04em] font-semibold bg-bg-2 text-ink-3 px-1.5 py-0.5 rounded-[4px] shrink-0">Copy</span>
                      )}
                    </div>
                    <div className="font-mono text-[10.5px] text-ink-3 mt-0.5 tracking-[0]">
                      {s._count.priceAlerts > 0 && (
                        <span className="text-gold-2 font-semibold">⚠ {s._count.priceAlerts} alert{s._count.priceAlerts !== 1 ? 's' : ''} · </span>
                      )}
                      {s.invoiceNumber ?? 'No invoice #'}
                    </div>
                    {s.status === 'ERROR' && s.errorMessage && (
                      <div className="font-mono text-[10.5px] text-red-text truncate mt-0.5 tracking-[0]" title={s.errorMessage}>
                        {s.errorMessage}
                      </div>
                    )}
                  </div>
                  <div className="font-mono text-[12px] text-ink-2">{s.invoiceDate ?? '—'}</div>
                  <div className="font-mono text-[13px] font-semibold text-ink tabular-nums text-right tracking-[-0.01em]">
                    {s.total ? formatCurrency(Number(s.total)) : '—'}
                  </div>
                  <div className="font-mono text-[12px] text-ink-2 text-right tabular-nums">{s._count.scanItems}</div>
                  <div><StatusBadge status={s.status} /></div>
                  <div className="relative justify-self-end" onClick={e => e.stopPropagation()}>
                    <button
                      onClick={() => setOpenMenu(openMenu === s.id ? null : s.id)}
                      className="w-7 h-7 grid place-items-center rounded-md text-ink-3 hover:text-ink hover:bg-bg-2 transition-colors"
                    >
                      <MoreHorizontal size={14} />
                    </button>
                    {openMenu === s.id && (
                      <div className="absolute right-0 top-8 z-10 bg-paper rounded-[10px] shadow-lg border border-line py-1 min-w-[140px]">
                        {s.status === 'ERROR' && (
                          <button
                            onClick={() => { onRetry(s.id); setOpenMenu(null) }}
                            className="w-full px-3 py-2 text-left text-[13px] text-ink-2 hover:bg-bg-2 inline-flex items-center gap-2"
                          >
                            <RotateCcw size={12} /> Retry scan
                          </button>
                        )}
                        <button
                          onClick={() => { setDeleteConfirm({ id: s.id, status: s.status }); setOpenMenu(null) }}
                          className="w-full px-3 py-2 text-left text-[13px] text-red-text hover:bg-red-soft/50 inline-flex items-center gap-2"
                        >
                          <Trash2 size={12} /> Delete
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Mobile row */}
                <div
                  className={`sm:hidden flex items-stretch transition-colors ${isLast ? '' : 'border-b border-line'} ${
                    isInflight ? 'opacity-70'
                    : isSelected ? 'bg-gold-soft/40'
                    : s.status === 'REVIEW' ? 'bg-gold-soft/30' : ''
                  }`}
                  onClick={() => canOpen && onSelect(s.id)}
                >
                  <div className="flex items-center pl-3 pr-1 shrink-0" onClick={e => { e.stopPropagation(); toggleOne(s.id) }}>
                    <Checkbox checked={isSelected} onChange={() => toggleOne(s.id)} />
                  </div>
                  <div className="flex-1 min-w-0 px-3 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-[13.5px] font-medium text-ink tracking-[-0.005em] truncate">
                          {s.supplierName ?? 'Unknown supplier'}
                        </span>
                        {s.parentSessionId && (
                          <span className="font-mono text-[9px] uppercase tracking-[0.04em] font-semibold bg-bg-2 text-ink-3 px-1.5 py-0.5 rounded-[4px] shrink-0">Copy</span>
                        )}
                      </div>
                      <StatusBadge status={s.status} />
                    </div>
                    <div className="font-mono text-[10.5px] text-ink-3 mt-1 tracking-[0] flex items-center gap-2 flex-wrap">
                      {s.total && <span className="font-medium text-ink-2">{formatCurrency(Number(s.total))}</span>}
                      <span>{s.invoiceDate ?? '—'}</span>
                      {s._count.priceAlerts > 0 && (
                        <span className="text-gold-2 font-semibold">⚠ {s._count.priceAlerts} alert{s._count.priceAlerts !== 1 ? 's' : ''}</span>
                      )}
                    </div>
                    {s.status === 'ERROR' && s.errorMessage && (
                      <div className="font-mono text-[10.5px] text-red-text truncate mt-1" title={s.errorMessage}>
                        {s.errorMessage}
                      </div>
                    )}
                  </div>
                  <div className="relative flex items-center pr-2 shrink-0" onClick={e => e.stopPropagation()}>
                    <button
                      onClick={() => setOpenMenu(openMenu === s.id ? null : s.id)}
                      className="w-8 h-8 grid place-items-center rounded-md text-ink-3 hover:text-ink hover:bg-bg-2 transition-colors"
                    >
                      <MoreHorizontal size={14} />
                    </button>
                    {openMenu === s.id && (
                      <div className="absolute right-2 top-9 z-10 bg-paper rounded-[10px] shadow-lg border border-line py-1 min-w-[140px]">
                        {s.status === 'ERROR' && (
                          <button
                            onClick={() => { onRetry(s.id); setOpenMenu(null) }}
                            className="w-full px-3 py-2 text-left text-[13px] text-ink-2 hover:bg-bg-2 inline-flex items-center gap-2"
                          >
                            <RotateCcw size={12} /> Retry scan
                          </button>
                        )}
                        <button
                          onClick={() => { setDeleteConfirm({ id: s.id, status: s.status }); setOpenMenu(null) }}
                          className="w-full px-3 py-2 text-left text-[13px] text-red-text hover:bg-red-soft/50 inline-flex items-center gap-2"
                        >
                          <Trash2 size={12} /> Delete
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Footer hint */}
      <div className="flex justify-between font-mono text-[10.5px] text-ink-3 tracking-wide pt-1">
        <span>SHOWING {filtered.length} OF {sessions.length} {sessions.length === 1 ? 'INVOICE' : 'INVOICES'}</span>
        <span>
          <kbd className="font-mono text-[10px] bg-bg-2 border border-line rounded px-1 py-px text-ink-2">⌘U</kbd> UPLOAD ·
          <kbd className="font-mono text-[10px] bg-bg-2 border border-line rounded px-1 py-px text-ink-2 ml-1">⌘F</kbd> SEARCH
        </span>
      </div>

      {/* ── Single delete confirmation modal ── */}
      {deleteConfirm && (
        <ConfirmModal
          onCancel={() => setDeleteConfirm(null)}
          onConfirm={() => handleDelete(deleteConfirm.id, deleteConfirm.status)}
          confirming={isDeleting}
          title="Delete invoice?"
          body={
            deleteConfirm.status === 'APPROVED'
              ? 'This will remove the approved invoice and reverse its price updates.'
              : 'This will permanently delete the invoice session.'
          }
          confirmLabel="Delete"
        />
      )}

      {/* ── Bulk delete confirmation ── */}
      {bulkDeleteConfirm && (
        <ConfirmModal
          onCancel={() => setBulkDeleteConfirm(false)}
          onConfirm={handleBulkDelete}
          confirming={isBulkDeleting}
          title={`Delete ${selectedInView.length} invoice${selectedInView.length !== 1 ? 's' : ''}?`}
          body={
            hasApproved
              ? `${selectedInView.filter(s => s.status === 'APPROVED').length} approved invoice(s) selected — their price updates will be reversed.`
              : 'All selected invoice sessions will be permanently deleted.'
          }
          warning={hasApproved}
          confirmLabel={`Delete ${selectedInView.length}`}
        />
      )}
    </div>
  )
}

function ConfirmModal({ onCancel, onConfirm, confirming, title, body, warning = false, confirmLabel }: {
  onCancel: () => void
  onConfirm: () => void
  confirming: boolean
  title: string
  body: string
  warning?: boolean
  confirmLabel: string
}) {
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onCancel}>
      <div className="bg-paper border border-line rounded-[14px] p-6 max-w-sm w-full mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-start gap-3 mb-3">
          <div className="w-9 h-9 rounded-[9px] grid place-items-center shrink-0 bg-red-soft text-red-text">
            <Trash2 size={15} />
          </div>
          <div className="flex-1">
            <h3 className="text-[16px] font-semibold text-ink tracking-[-0.015em]">{title}</h3>
            <p className="font-mono text-[10.5px] uppercase tracking-[0.04em] text-ink-3 mt-0.5">This cannot be undone</p>
          </div>
        </div>
        {warning ? (
          <div className="bg-gold-soft border border-[#fcd34d]/60 rounded-[8px] px-3 py-2.5 text-[12.5px] text-gold-2 mb-4">
            {body}
          </div>
        ) : (
          <p className="text-[13px] text-ink-2 leading-[1.5] mb-4">{body}</p>
        )}
        <div className="flex gap-2">
          <button onClick={onCancel}
            className="flex-1 px-3 py-2 rounded-[9px] border border-line bg-paper text-[13px] text-ink-2 hover:border-ink-3 transition-colors">
            Cancel
          </button>
          <button onClick={onConfirm} disabled={confirming}
            className="flex-1 px-3 py-2 rounded-[9px] bg-red-600 text-white text-[13px] font-medium hover:bg-red-700 disabled:opacity-50 transition-colors">
            {confirming ? 'Deleting…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

```


---

## `src/components/invoices/InvoiceKpiStripV2.tsx`

```tsx
'use client'
import { useEffect, useState } from 'react'
import { KpiData } from './types'
import { formatCurrency } from '@/lib/utils'

interface Props {
  refreshKey: number  // increment to trigger a refetch
  activeRcId: string | null
  isDefault: boolean
}

/**
 * Branded invoice KPI strip — matches the /pass and /cost pattern.
 *
 * 1.4fr 1fr 1fr 1fr grid:
 *   - Hero (ink bg): This week spend with WoW delta and gold dollar accent
 *   - This month: ink-2 neutral with invoice count
 *   - Awaiting approval: gold-soft when > 0, neutral otherwise
 *   - Price alerts: red-soft when > 0, neutral otherwise
 *
 * Replaces the legacy InvoiceKpiStrip (gray-* tokens, 5-cell horizontal layout
 * including a sparkline that turned into clutter).
 */
export function InvoiceKpiStripV2({ refreshKey, activeRcId, isDefault }: Props) {
  const [kpis, setKpis] = useState<KpiData | null>(null)

  useEffect(() => {
    const p = new URLSearchParams()
    if (activeRcId) {
      p.set('rcId', activeRcId)
      if (isDefault) p.set('isDefault', 'true')
    }
    const qs = p.toString()
    fetch(`/api/invoices/kpis${qs ? `?${qs}` : ''}`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(data => data && setKpis(data))
      .catch(() => {})
  }, [refreshKey, activeRcId, isDefault])

  return (
    <div className="grid gap-3 mb-5" style={{ gridTemplateColumns: '1.4fr 1fr 1fr 1fr' }}>
      <Hero kpis={kpis} />
      <Card
        label="This month"
        value={kpis ? formatCurrency(kpis.monthSpend) : '—'}
        delta={kpis ? <><b>{kpis.monthInvoiceCount}</b> {kpis.monthInvoiceCount === 1 ? 'invoice' : 'invoices'}</> : <>—</>}
      />
      <Card
        label="Awaiting approval"
        value={kpis ? String(kpis.awaitingApprovalCount) : '—'}
        valueClass={kpis && kpis.awaitingApprovalCount > 0 ? 'text-gold-2' : ''}
        delta={
          kpis && kpis.awaitingApprovalCount > 0
            ? <><b>{kpis.awaitingApprovalCount === 1 ? 'session' : 'sessions'}</b> in queue</>
            : <>all caught up</>
        }
        tint={kpis && kpis.awaitingApprovalCount > 0 ? 'warn' : 'neutral'}
      />
      <Card
        label="Price alerts"
        value={kpis ? String(kpis.priceAlertCount) : '—'}
        valueClass={kpis && kpis.priceAlertCount > 0 ? 'text-red-text' : ''}
        delta={
          kpis && kpis.priceAlertCount > 0
            ? <><b>review</b> · open Price alerts</>
            : <>none active</>
        }
        tint={kpis && kpis.priceAlertCount > 0 ? 'bad' : 'neutral'}
      />
    </div>
  )
}

function Hero({ kpis }: { kpis: KpiData | null }) {
  if (!kpis) {
    return (
      <div className="bg-ink text-paper rounded-[12px] border border-ink p-5 flex flex-col justify-between min-h-[128px]">
        <div>
          <div className="font-mono text-[10.5px] text-zinc-500 tracking-[0.01em]">THIS WEEK · INVOICE SPEND</div>
          <div className="text-[34px] font-semibold tracking-[-0.04em] leading-none mt-2 text-zinc-600">—</div>
        </div>
        <div className="font-mono text-[11px] text-zinc-500">loading…</div>
      </div>
    )
  }

  const pct = kpis.weekSpendChangePct
  const trendIs = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat'
  const trendCls = trendIs === 'up' ? 'text-red-300' : trendIs === 'down' ? 'text-green-400' : 'text-zinc-400'
  const arrow = trendIs === 'up' ? '↑' : trendIs === 'down' ? '↓' : '·'

  const formatted = formatCurrency(kpis.weekSpend)
  const [whole, cents] = formatted.split('.')

  return (
    <div className="bg-ink text-paper rounded-[12px] border border-ink p-5 flex flex-col justify-between min-h-[128px] relative overflow-hidden">
      <div>
        <div className="font-mono text-[10.5px] text-zinc-500 tracking-[0.01em]">THIS WEEK · INVOICE SPEND</div>
        <div className="text-[34px] font-semibold tracking-[-0.04em] leading-none mt-2">
          {whole}
          <sub className="text-[18px] font-medium text-gold tracking-[-0.02em] align-baseline">.{cents ?? '00'}</sub>
        </div>
      </div>
      <div className="font-mono text-[11px] text-zinc-500 tracking-[0] flex items-center gap-1.5">
        <span className={`font-semibold ${trendCls}`}>{arrow} {Math.abs(pct).toFixed(1)}%</span>
        <span>vs last week</span>
      </div>
    </div>
  )
}

function Card({
  label, value, delta, valueClass = '', tint = 'neutral',
}: {
  label: string
  value: string
  delta: React.ReactNode
  valueClass?: string
  tint?: 'neutral' | 'warn' | 'bad'
}) {
  const cardCls = tint === 'warn'
    ? 'bg-gold-soft border-[#fcd34d]/60'
    : tint === 'bad'
      ? 'bg-red-soft border-red-200'
      : 'bg-paper border-line'
  const accent = tint === 'warn' ? 'bg-gold-2' : tint === 'bad' ? 'bg-red' : 'bg-gold'

  return (
    <div className={`border rounded-[12px] p-5 flex flex-col justify-between min-h-[128px] relative ${cardCls}`}>
      <div className={`absolute top-0 left-0 w-8 h-0.5 ${accent}`} />
      <div>
        <div className="font-mono text-[10.5px] text-ink-3 tracking-[0.01em] uppercase">{label}</div>
        <div className={`text-[34px] font-semibold tracking-[-0.04em] leading-none mt-2 ${valueClass || 'text-ink'}`}>{value}</div>
      </div>
      <div className="font-mono text-[11px] text-ink-3 tracking-[0] [&_b]:text-ink [&_b]:font-medium">{delta}</div>
    </div>
  )
}

```


---

## `src/components/invoices/InvoiceUploadModal.tsx`

```tsx
'use client'
import { useState, useRef } from 'react'
import {
  Upload, ScanLine, X, Loader2,
  Image, FileText, FileSpreadsheet,
} from 'lucide-react'
import { useUploadThing } from '@/lib/uploadthing-client'

interface Props {
  onClose: () => void
  onComplete: (newSessionId: string) => void
  activeRcId: string | null
}

const fileIcon = (fileType: string) => {
  if (fileType.includes('pdf')) return <FileText size={16} className="text-red-500" />
  if (fileType.includes('csv') || fileType.includes('text')) return <FileSpreadsheet size={16} className="text-green-500" />
  return <Image size={16} className="text-blue-500" />
}

export function InvoiceUploadModal({ onClose, onComplete, activeRcId }: Props) {
  const [files, setFiles] = useState<File[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [noApiKey, setNoApiKey] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [uploadStep, setUploadStep] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const utErrorRef = useRef<string | null>(null)

  const { startUpload } = useUploadThing('invoiceUploader', {
    onUploadError: (err) => {
      utErrorRef.current = err.message ?? 'Upload service error'
    },
  })

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const dropped = Array.from(e.dataTransfer.files).filter(f =>
      f.type.startsWith('image/') || f.type === 'application/pdf' ||
      f.type === 'text/csv' || f.name.endsWith('.csv')
    )
    setFiles(prev => [...prev, ...dropped])
  }

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files
    if (!picked || picked.length === 0) {
      console.warn('[upload] file input fired with no files')
      return
    }
    const arr = Array.from(picked)
    console.log('[upload] received', arr.length, 'file(s):', arr.map(f => `${f.name} (${f.type}, ${f.size}b)`).join(', '))
    setFiles(prev => [...prev, ...arr])
    e.target.value = ''
  }

  // Compress an image file to ≤1 MB at ≤2000 px using Canvas.
  // Non-image files (PDF, CSV) are returned as-is.
  const compressImageFile = (file: File): Promise<File> => {
    if (!file.type.startsWith('image/') || file.size <= 1 * 1024 * 1024) return Promise.resolve(file)
    return new Promise((resolve) => {
      const img = new window.Image()
      const objectUrl = URL.createObjectURL(file)
      img.onload = () => {
        URL.revokeObjectURL(objectUrl)
        const MAX_DIM = 2000
        let { width, height } = img
        if (width > MAX_DIM || height > MAX_DIM) {
          const scale = MAX_DIM / Math.max(width, height)
          width  = Math.round(width  * scale)
          height = Math.round(height * scale)
        }
        const canvas = document.createElement('canvas')
        canvas.width  = width
        canvas.height = height
        canvas.getContext('2d')!.drawImage(img, 0, 0, width, height)
        canvas.toBlob(
          (blob) => {
            if (!blob) { resolve(file); return }
            const name = file.name.replace(/\.[^.]+$/, '.jpg')
            resolve(new File([blob], name, { type: 'image/jpeg' }))
          },
          'image/jpeg',
          0.82,
        )
      }
      img.onerror = () => { URL.revokeObjectURL(objectUrl); resolve(file) }
      img.src = objectUrl
    })
  }

  const handleStartScan = async () => {
    if (files.length === 0) return
    setIsCreating(true)
    setScanError(null)
    setUploadStep(null)
    setNoApiKey(false)

    try {
      // 0. Compress images client-side so large photos become ~0.5-1 MB.
      //    PDFs and CSVs are passed through unchanged.
      setUploadStep('Preparing files…')
      const compressedFiles = await Promise.all(files.map(compressImageFile))

      // 1. Create session
      setUploadStep('Creating session…')
      const sessRes = await fetch('/api/invoices/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revenueCenterId: activeRcId }),
      })
      if (!sessRes.ok) {
        setScanError(`Session error (${sessRes.status}). Please try again.`)
        return
      }
      const sess = await sessRes.json()

      // 2a. Try UploadThing CDN (8s timeout — fail fast so local fallback kicks in)
      let uploadOk = false
      utErrorRef.current = null
      setUploadStep('Uploading to cloud…')
      try {
        const uploaded = await Promise.race([
          startUpload(compressedFiles),
          new Promise<null>((_, rej) => setTimeout(() => rej(new Error('Cloud upload timed out')), 8_000)),
        ])
        if (uploaded?.length) {
          const regRes = await fetch(`/api/invoices/sessions/${sess.id}/upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              files: uploaded.map(f => ({ url: f.ufsUrl ?? f.url, fileName: f.name, fileType: f.type })),
            }),
          })
          if (regRes.ok) uploadOk = true
        }
      } catch (utErr) {
        utErrorRef.current = utErr instanceof Error ? utErr.message : 'Upload service error'
        // fall through to local
      }

      // 2b. Local fallback — stores compressed files as base64 in DB.
      //    Compressed images are typically <1 MB, well inside Vercel's 4.5 MB body limit.
      if (!uploadOk) {
        const totalBytes = compressedFiles.reduce((s, f) => s + f.size, 0)
        const limitBytes = 4 * 1024 * 1024
        if (totalBytes > limitBytes) {
          setScanError(
            `Files are too large to upload (${(totalBytes / 1024 / 1024).toFixed(1)} MB total after compression). ` +
            `Try using fewer pages, or upload a smaller PDF. ` +
            (utErrorRef.current ? `Cloud error: ${utErrorRef.current}. ` : '')
          )
          return
        }
        setUploadStep('Uploading…')
        const fd = new FormData()
        compressedFiles.forEach(f => fd.append('files', f))
        const localRes = await fetch(`/api/invoices/sessions/${sess.id}/upload-local`, {
          method: 'POST',
          body: fd,
        })
        if (localRes.ok) {
          uploadOk = true
        } else {
          const errBody = await localRes.json().catch(() => ({}))
          setScanError(
            errBody.error ??
            `Upload failed (${localRes.status}). ` +
            (utErrorRef.current ? `Cloud error: ${utErrorRef.current}. ` : '') +
            `Please try again.`
          )
          return
        }
      }

      // 3. Fire process as fire-and-forget (drawer will poll for status updates)
      fetch(`/api/invoices/sessions/${sess.id}/process`, { method: 'POST' }).catch(() => {})

      // 4. Close modal and open drawer on new session
      onComplete(sess.id)
    } catch (err) {
      setScanError(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsCreating(false)
      setUploadStep(null)
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />

      {/* Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 shrink-0">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-gold/15 flex items-center justify-center">
                <ScanLine size={16} className="text-gold" />
              </div>
              <h2 className="text-base font-bold text-gray-900">Upload Invoice</h2>
            </div>
            <button onClick={onClose} className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100">
              <X size={16} />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            {scanError && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-800">
                <strong>Upload error:</strong> {scanError}
              </div>
            )}

            {noApiKey && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
                <strong>ANTHROPIC_API_KEY not set.</strong> Add your key to <code className="bg-amber-100 px-1 rounded">.env</code> and restart the server to enable OCR scanning.
              </div>
            )}

            {/* File upload */}
            {(
              <>
                {/* Dropzone is a <label> so the OS file picker is opened by HTML
                    semantics, not a JS click chain. Wrapping the input in an
                    onClick div caused iOS Safari (and some Chromium builds) to
                    re-fire the wrapper's click after the picker closed, silently
                    discarding the selection. */}
                <label
                  htmlFor="invoice-file-input"
                  onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={handleDrop}
                  className={`border-2 border-dashed rounded-2xl p-10 flex flex-col items-center gap-3 cursor-pointer transition-colors ${
                    isDragging ? 'border-blue-400 bg-gold/10' : 'border-gray-200 hover:border-blue-300 hover:bg-gray-50'
                  }`}
                >
                  <Upload size={32} className="text-gray-300" />
                  <div className="text-center">
                    <p className="font-medium text-gray-700">Drop files here or click to browse</p>
                    <p className="text-xs text-gray-400 mt-1">JPEG, PNG, PDF, CSV supported</p>
                  </div>
                  <input
                    id="invoice-file-input"
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="image/*,.pdf,.csv,text/csv"
                    className="sr-only"
                    onChange={handleFileInput}
                    onClick={e => e.stopPropagation()}
                  />
                </label>

                {files.length > 0 && (
                  <div className="bg-white rounded-xl border border-gray-100 divide-y divide-gray-50">
                    {files.map((f, i) => (
                      <div key={i} className="flex items-center gap-3 px-4 py-3">
                        {fileIcon(f.type)}
                        <span className="flex-1 text-sm text-gray-700 truncate">{f.name}</span>
                        <span className="text-xs text-gray-400">{(f.size / 1024).toFixed(0)} KB</span>
                        <button onClick={() => setFiles(prev => prev.filter((_, idx) => idx !== i))}>
                          <X size={14} className="text-gray-300 hover:text-red-400" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Footer with Scan button */}
          <div className="px-5 py-4 border-t border-gray-100 shrink-0">
            <button
              onClick={handleStartScan}
              disabled={files.length === 0 || isCreating}
              className="w-full bg-gold text-white rounded-xl py-3 font-semibold flex items-center justify-center gap-2 hover:bg-[#a88930] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {isCreating ? <Loader2 size={18} className="animate-spin" /> : <ScanLine size={18} />}
              {uploadStep ?? (isCreating ? 'Starting…' : `Upload${files.length > 0 ? ` ${files.length} ${files.length > 1 ? 'files' : 'file'}` : ' Invoice'}`)}
            </button>
          </div>
        </div>
      </div>

    </>
  )
}

```


---

## `src/components/invoices/ProcessingToast.tsx`

```tsx
'use client'
import { useEffect, useRef } from 'react'
import { CheckCircle2, X } from 'lucide-react'

interface Props {
  supplierName: string | null
  invoiceNumber: string | null
  onReview: () => void
  onDismiss: () => void
  label?: string
  actionLabel?: string
}

export function ProcessingToast({ supplierName, invoiceNumber, onReview, onDismiss, label: toastLabel, actionLabel }: Props) {
  const onDismissRef = useRef(onDismiss)
  onDismissRef.current = onDismiss

  useEffect(() => {
    const t = setTimeout(() => onDismissRef.current(), 6000)
    return () => clearTimeout(t)
  }, []) // intentionally empty — timer starts once on mount

  const name = supplierName ?? invoiceNumber ?? 'Invoice'
  const statusLabel = toastLabel ?? 'Ready for review'
  const ctaLabel = actionLabel ?? 'Review'

  return (
    <div className="fixed bottom-24 left-1/2 -translate-x-1/2 sm:left-auto sm:translate-x-0 sm:right-6 sm:bottom-8 z-[70] w-[calc(100vw-32px)] sm:w-80 bg-white border border-gray-200 rounded-2xl shadow-xl flex items-start gap-3 p-4 toast-enter">
      <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center shrink-0">
        <CheckCircle2 size={16} className="text-green-600" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-gray-900 truncate">{name}</p>
        <p className="text-xs text-gray-500 mt-0.5">{statusLabel}</p>
        <button
          onClick={onReview}
          className="mt-2 text-xs font-semibold text-gold hover:text-blue-800"
        >
          {ctaLabel} →
        </button>
      </div>
      <button onClick={onDismiss} className="text-gray-300 hover:text-gray-500 shrink-0">
        <X size={14} />
      </button>
    </div>
  )
}

```


---

## `src/components/invoices/InboxSubNav.tsx`

```tsx
'use client'
import { useEffect, useState } from 'react'
import { Mail, AlertCircle, AlertTriangle } from 'lucide-react'
import { SubNav } from '@/components/layout/SubNav'

interface Counts {
  invoices: number      // awaiting approval
  priceAlerts: number   // unacknowledged
  exceptions: number    // unmatched lines + dupes
}

export function InboxSubNav() {
  const [counts, setCounts] = useState<Counts>({ invoices: 0, priceAlerts: 0, exceptions: 0 })

  useEffect(() => {
    const load = async () => {
      try {
        const [k, a] = await Promise.all([
          fetch('/api/invoices/kpis', { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
          fetch('/api/invoices/alerts', { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
        ])
        setCounts({
          invoices:    k?.awaitingApprovalCount ?? 0,
          priceAlerts: a?.priceAlerts?.length ?? 0,
          exceptions:  k?.exceptionsCount ?? 0,
        })
      } catch {}
    }
    load()
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [])

  return (
    <SubNav
      tabs={[
        { href: '/invoices',                label: 'Invoices',     icon: <BadgeIcon icon={<Mail size={13} />}        n={counts.invoices} /> },
        { href: '/invoices/price-alerts',   label: 'Price alerts', icon: <BadgeIcon icon={<AlertTriangle size={13} />} n={counts.priceAlerts} /> },
        { href: '/invoices/exceptions',     label: 'Exceptions',   icon: <BadgeIcon icon={<AlertCircle size={13} />}  n={counts.exceptions} /> },
      ]}
    />
  )
}

function BadgeIcon({ icon, n }: { icon: React.ReactNode; n: number }) {
  return (
    <span className="relative inline-flex items-center">
      {icon}
      {n > 0 && (
        <span className="font-mono text-[9.5px] bg-gold text-ink font-semibold ml-1.5 px-1.5 py-px rounded-full leading-none">
          {n > 99 ? '99+' : n}
        </span>
      )}
    </span>
  )
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
