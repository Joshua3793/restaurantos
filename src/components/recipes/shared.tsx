'use client'
// ─── Shared types, helpers and components used by both Recipe Book and Menu pages ───
import { useEffect, useState, useCallback, useRef, memo } from 'react'
import { createPortal } from 'react-dom'
import { formatCurrency, formatUnitPrice, formatQtyUnit } from '@/lib/utils'
import { UOM_GROUPS, getUnitGroup, convertQty, PREP_YIELD_UNITS, MENU_YIELD_UNITS } from '@/lib/uom'
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

// ─── Dimension-conflict surfaces ───────────────────────────────────────────────
// An ingredient whose unit is a different physical dimension than the item's base
// unit (e.g. 'g' on an each/count item) can't be costed — convertQty would pass the
// qty through unchanged and silently mis-cost the line, so the cost engine forces
// that line to $0 and flags it. Surface that so the number isn't read as truth.

/** Small inline pill flagging an ingredient unit ↔ item-dimension mismatch. */
function UnitMismatchPill({ ing }: { ing: { unit: string; ingredientBaseUnit: string } }) {
  return (
    <span
      className="ml-1.5 inline-flex items-center rounded px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide text-red-text bg-red-soft align-middle"
      title={`This ingredient's unit (${ing.unit}) doesn't match the item's dimension (${ing.ingredientBaseUnit}) — line costed at $0`}
    >
      unit mismatch
    </span>
  )
}

/** Recipe-level note when one or more ingredient lines have a dimension conflict. */
function RecipeDimensionWarning({ count, className = '' }: { count: number; className?: string }) {
  if (!count || count <= 0) return null
  return (
    <div className={`flex items-center gap-1.5 text-[11px] text-red-text bg-red-soft rounded-md px-2 py-1 ${className}`}>
      <span>
        {count} ingredient{count === 1 ? '' : 's'} {count === 1 ? 'has' : 'have'} a unit mismatch — cost may be incomplete
      </span>
    </div>
  )
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
  /** Allergens this ingredient contributes (from its inventory item, or a linked prep's synced set). */
  allergens?: string[]
  /** Recipe unit is a different dimension than the item's base unit — line is costed at $0. */
  dimensionConflict?: boolean
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
  steps: string[]
  createdAt: string
  updatedAt: string
  ingredients: IngredientWithCost[]
  totalCost: number
  costPerPortion: number | null
  foodCostPct: number | null
  /** Count of ingredients whose unit dimension doesn't match the item's base unit. */
  dimensionConflicts?: number
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
  if (pct === null) return 'text-ink-3'
  if (pct < FOOD_COST_GREEN) return 'text-green'
  if (pct <= FOOD_COST_AMBER) return 'text-gold'
  return 'text-red'
}

export function catDot(color: string | null) {
  return (
    <span
      className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
      style={{ background: color ?? '#94a3b8' }}
    />
  )
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
        className="px-3 py-1.5 rounded-[10px] text-[#f87171] hover:bg-white/10 transition-colors font-medium"
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
              ? 'bg-green'
              : fcPct <= FOOD_COST_AMBER
                ? 'bg-gold'
                : 'bg-red'
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
          title={recipe.isActive ? 'Deactivate' : 'Activate'}
          className={`relative inline-flex w-[30px] h-[18px] shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${recipe.isActive ? 'bg-ink' : 'bg-line-2'}`}
        >
          <span className={`pointer-events-none inline-block h-[14px] w-[14px] transform rounded-full bg-white shadow ring-0 transition duration-200 ${recipe.isActive ? 'translate-x-[12px]' : 'translate-x-0'}`} />
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
                      className="flex-1 px-2 py-1 bg-red text-paper text-[11px] rounded-[6px] hover:bg-red-text"
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
                  className="w-full px-3 py-2 text-[13px] text-left text-red hover:bg-red-soft flex items-center gap-2"
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
        <div className="flex items-center justify-between p-4 border-b border-line print:hidden">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-ink-2">Scale:</span>
            {[0.5, 1, 2, 3, 5, 10].map(s => (
              <button
                key={s}
                onClick={() => setScale(s)}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${scale === s ? 'bg-ink text-paper [&_svg]:text-gold' : 'bg-bg-2 text-ink-3 hover:bg-line'}`}
              >
                {s === 1 ? '×1 (base)' : `×${s}`}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handlePrint} className="flex items-center gap-2 bg-ink text-paper [&_svg]:text-gold px-3 py-1.5 rounded-lg text-sm hover:bg-ink-2">
              <Printer size={14} /> Print
            </button>
            <button onClick={onClose} className="p-1.5 text-ink-4 hover:text-ink-3 rounded-lg hover:bg-bg-2">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Print card content */}
        <div className="p-8 print:p-6 font-sans">
          {/* Header */}
          <div className="flex items-start justify-between mb-6 pb-4 border-b-2 border-ink">
            <div>
              <h1 className="text-2xl font-bold text-ink">{recipe.name}</h1>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-sm text-ink-3">{recipe.categoryName}</span>
                <span className="text-ink-4">·</span>
                <span className="text-sm font-medium text-ink-2">
                  {recipe.type === 'MENU' ? 'Menu Item' : 'Prep Recipe'}
                </span>
              </div>
            </div>
            <div className="text-right text-sm text-ink-3">
              <div className="text-xs uppercase tracking-wide font-semibold text-ink-4 mb-1">Yield</div>
              <div className="text-xl font-bold text-ink">
                {formatQtyUnit(scaledYield, recipe.yieldUnit)}
              </div>
              {recipe.portionSize && recipe.portionUnit && (
                <div className="text-xs text-ink-3 mt-0.5">
                  {formatQtyUnit(recipe.portionSize * scale, recipe.portionUnit)} / portion
                </div>
              )}
            </div>
          </div>

          {/* Allergens */}
          {recipe.allergens && recipe.allergens.length > 0 && (
            <div className="mb-6 flex items-center gap-3">
              <h2 className="text-xs font-bold uppercase tracking-wider text-ink-4 shrink-0">Allergens</h2>
              <AllergenBadges allergens={recipe.allergens} size="sm" />
            </div>
          )}

          {/* Ingredients */}
          <div className="mb-6">
            <h2 className="text-xs font-bold uppercase tracking-wider text-ink-4 mb-3">Ingredients</h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line">
                  <th className="text-left pb-1.5 font-semibold text-ink-3">Item</th>
                  <th className="text-right pb-1.5 font-semibold text-ink-3">Qty</th>
                  <th className="text-right pb-1.5 font-semibold text-ink-3">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {scaledIngredients.map(ing => (
                  <tr key={ing.id}>
                    <td className="py-1.5 text-ink-2">
                      <span className="inline-flex items-center gap-1.5 flex-wrap align-middle">
                        {ing.ingredientName}
                        {ing.allergens && ing.allergens.length > 0 && (
                          <AllergenBadges allergens={ing.allergens} size="xs" />
                        )}
                      </span>
                    </td>
                    <td className="py-1.5 text-right text-ink-3">
                      {formatQtyUnit(ing.qtyBase, ing.unit)}
                    </td>
                    <td className="py-1.5 text-right text-ink-3">
                      {ing.dimensionConflict && <UnitMismatchPill ing={ing} />}
                      {formatCurrency(ing.lineCost)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-ink">
                  <td className="pt-2 font-bold text-ink">Total</td>
                  <td />
                  <td className="pt-2 text-right font-bold text-ink">{formatCurrency(scaledTotalCost)}</td>
                </tr>
              </tfoot>
            </table>
            <RecipeDimensionWarning count={recipe.dimensionConflicts ?? 0} className="mt-2" />
          </div>

          {/* Cost summary row */}
          <div className="grid grid-cols-3 gap-4 mb-6 bg-bg rounded-xl p-4">
            <div className="text-center">
              <div className="text-xs font-semibold uppercase tracking-wide text-ink-4">Batch Cost</div>
              <div className="text-lg font-bold text-ink mt-0.5">{formatCurrency(scaledTotalCost)}</div>
            </div>
            {recipe.costPerPortion !== null && (
              <div className="text-center border-l border-line">
                <div className="text-xs font-semibold uppercase tracking-wide text-ink-4">Cost / Portion</div>
                <div className="text-lg font-bold text-ink mt-0.5">{formatCurrency(recipe.costPerPortion)}</div>
              </div>
            )}
            {recipe.menuPrice !== null && (
              <div className="text-center border-l border-line">
                <div className="text-xs font-semibold uppercase tracking-wide text-ink-4">Food Cost %</div>
                <div className={`text-lg font-bold mt-0.5 ${foodCostClass(recipe.foodCostPct)}`}>
                  {recipe.foodCostPct !== null ? `${recipe.foodCostPct.toFixed(1)}%` : '—'}
                </div>
              </div>
            )}
          </div>

          {/* Method notes */}
          {recipe.notes && (
            <div>
              <h2 className="text-xs font-bold uppercase tracking-wider text-ink-4 mb-2">Method</h2>
              <p className="text-sm text-ink-2 leading-relaxed">{renderMarkdown(recipe.notes)}</p>
            </div>
          )}

          {/* Footer */}
          <div className="mt-8 pt-4 border-t border-line flex justify-between text-xs text-ink-4 print:block">
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
          /* keep allergen pill colors when printing */
          .fixed.z-\\[200\\] * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
        }
      `}</style>
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
            {ing.allergens && ing.allergens.length > 0 && (
              <AllergenBadges allergens={ing.allergens} size="xs" />
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

        <div className="col-span-2 text-right font-mono text-[13px] font-medium text-ink">
          {ing.dimensionConflict && <UnitMismatchPill ing={ing} />}
          {formatCurrency(displayCost)}
        </div>

        <div className="col-span-1 flex items-center justify-end gap-1">
          <button
            onClick={() => setSubstituting(s => !s)}
            title="Substitute ingredient"
            className={`transition-colors ${substituting ? 'text-blue' : 'text-ink-4 hover:text-blue'}`}
          >
            <Pencil size={12} />
          </button>
          <button onClick={() => onDelete(ing.id)} className="text-ink-4 hover:text-red"><Trash2 size={12} /></button>
        </div>
      </div>

      {/* Inline substitute search */}
      {substituting && (
        <div ref={subRef} className="relative px-3 pb-2">
          <div className="flex items-center gap-2 border border-[#93c5fd] rounded-lg px-2 py-1.5 bg-blue-soft">
            <Search size={13} className="text-blue shrink-0" />
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
              className="flex-1 text-sm text-ink-2 placeholder-ink-4 outline-none bg-transparent"
            />
            <button onClick={() => { setSubstituting(false); setSubQ(''); setSubResults([]) }} className="text-ink-4 hover:text-ink-3">
              <X size={13} />
            </button>
          </div>
          {subResults.length > 0 && (
            <div className="absolute left-3 right-3 top-full mt-1 bg-white border border-line rounded-xl shadow-xl z-50 max-h-52 overflow-y-auto">
              {subResults.map(item => (
                <button key={`${item.type}-${item.id}`} onClick={() => pickSubstitute(item)}
                  className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-bg text-left text-sm">
                  {item.type === 'recipe' ? <ChefHat size={13} className="text-green shrink-0" /> : <Package size={13} className="text-blue shrink-0" />}
                  <span className="flex-1 text-ink-2">{item.name}</span>
                  <span className="text-xs text-ink-4">{item.unit}</span>
                  <span className="text-xs text-ink-3">{formatCurrency(item.pricePerBaseUnit)}/{item.unit}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded ${item.type === 'recipe' ? 'bg-green-soft text-green' : 'bg-gold/10 text-gold'}`}>
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
export function RecipePanel({ recipeId, categories, onClose, onUpdated, revenueCenters }: {
  recipeId: string
  categories: RecipeCategory[]
  onClose: () => void
  onUpdated: () => void
  revenueCenters?: { id: string; name: string; isActive: boolean }[]
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
    const snapshot = recipe
    setRecipe(prev => (prev ? { ...prev, ...(data as Partial<Recipe>) } : prev))
    try {
      const res = await fetch(`/api/recipes/${recipeId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      if (res.ok) {
        const updated = await res.json()
        setRecipe(updated)
        dirtyRef.current = true
      } else {
        setRecipe(snapshot)
      }
    } catch {
      setRecipe(snapshot)
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
    // Optimistic: update name/type; keep prior lineCost as placeholder until load() reconciles
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
          lineCost: ing.lineCost,
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
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-green-text bg-green-soft px-2 py-0.5 rounded-full flex items-center gap-1">
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
        title={recipe.isActive ? 'Deactivate' : 'Activate'}
        className={`relative inline-flex h-[22px] w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${recipe.isActive ? 'bg-ink' : 'bg-line-2'}`}>
        <span className={`pointer-events-none inline-block h-[18px] w-[18px] transform rounded-full bg-white shadow ring-0 transition duration-200 ${recipe.isActive ? 'translate-x-[14px]' : 'translate-x-0'}`} />
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
                  <div className="w-px h-9 bg-ink-2 mx-4 shrink-0" />
                  <div className="flex flex-col shrink-0">
                    <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-4">Price</span>
                    <span className="font-mono text-[16px] font-semibold text-paper leading-tight">{recipe.menuPrice !== null ? formatCurrency(recipe.menuPrice) : <span className="text-ink-3 italic">unset</span>}</span>
                  </div>
                  <div className="w-px h-9 bg-ink-2 mx-4 shrink-0" />
                  <div className="flex flex-col shrink-0">
                    <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-4">Food cost</span>
                    <span className={`font-mono text-[16px] font-bold leading-tight ${menuFoodCostPct !== null ? (menuFoodCostPct < FOOD_COST_GREEN ? 'text-[#4ade80]' : menuFoodCostPct <= FOOD_COST_AMBER ? 'text-gold' : 'text-[#f87171]') : 'text-ink-3'}`}>
                      {menuFoodCostPct !== null ? `${menuFoodCostPct.toFixed(1)}%` : '—'}
                    </span>
                  </div>
                  {margin !== null && (
                    <>
                      <div className="w-px h-9 bg-ink-2 mx-4 shrink-0" />
                      <div className="flex flex-col shrink-0">
                        <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-4">Margin</span>
                        <span className={`font-mono text-[16px] font-semibold leading-tight ${margin >= 0 ? 'text-[#4ade80]' : 'text-[#f87171]'}`}>{formatCurrency(margin)}</span>
                      </div>
                    </>
                  )}
                  {menuFoodCostPct !== null && (
                    <div className="ml-auto relative h-1.5 w-32 bg-ink-2 rounded-full overflow-hidden shrink-0">
                      <div
                        className={`h-full rounded-full ${menuFoodCostPct < FOOD_COST_GREEN ? 'bg-green' : menuFoodCostPct <= FOOD_COST_AMBER ? 'bg-gold' : 'bg-red'}`}
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
                  <div className="w-px h-9 bg-ink-2 mx-4 shrink-0" />
                  <div className="flex flex-col shrink-0">
                    <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-4">Per {recipe.yieldUnit}</span>
                    <span className="font-mono text-[16px] font-semibold text-paper leading-tight">
                      {recipe.baseYieldQty > 0 ? formatCurrency(recipe.totalCost / recipe.baseYieldQty) : '—'}
                    </span>
                  </div>
                  {recipe.costPerPortion !== null && (
                    <>
                      <div className="w-px h-9 bg-ink-2 mx-4 shrink-0" />
                      <div className="flex flex-col shrink-0">
                        <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-4">Per portion</span>
                        <span className="font-mono text-[16px] font-semibold text-paper leading-tight">{formatCurrency(recipe.costPerPortion)}</span>
                      </div>
                    </>
                  )}
                  {recipe.usedInCount !== undefined && recipe.usedInCount > 0 && (
                    <>
                      <div className="w-px h-9 bg-ink-2 mx-4 shrink-0" />
                      <div className="flex flex-col shrink-0">
                        <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-4">Used in</span>
                        <span className="font-mono text-[16px] font-semibold text-[#4ade80] leading-tight">{recipe.usedInCount} {recipe.usedInCount === 1 ? 'dish' : 'dishes'}</span>
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
            <div className="flex items-start gap-3 bg-gold-soft border border-gold-soft rounded-xl p-3">
              <Share2 size={14} className="text-gold shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-gold-2 mb-1.5">
                  Used in {recipe.usedInRecipes.length} {recipe.usedInRecipes.length === 1 ? 'recipe' : 'recipes'} — ingredient changes here will reprice them
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {recipe.usedInRecipes.map(r => (
                    <span key={r.id} className="text-[11px] bg-gold-soft text-gold-2 px-2 py-0.5 rounded-full flex items-center gap-1">
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
            {revenueCenters && (
              <div>
                <label className="font-mono text-[10.5px] uppercase tracking-[0.04em] text-ink-3 block mb-1.5">Revenue Center</label>
                <select value={recipe.revenueCenterId ?? ''} onChange={e => patchRecipe({ revenueCenterId: e.target.value || null })}
                  className="w-full border border-line rounded-[10px] px-3 py-2 text-sm text-ink bg-paper focus:outline-none focus:ring-2 focus:ring-gold">
                  <option value="">Shared (all RCs)</option>
                  {revenueCenters.filter(rc => rc.isActive).map(rc => (
                    <option key={rc.id} value={rc.id}>{rc.name}</option>
                  ))}
                </select>
              </div>
            )}
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
                  {(isMenu ? MENU_YIELD_UNITS : PREP_YIELD_UNITS).map(u => <option key={u} value={u}>{u}</option>)}
                  {/* Allow the existing value even if not in the canonical list (legacy data) */}
                  {!(isMenu ? MENU_YIELD_UNITS : PREP_YIELD_UNITS).includes(recipe.yieldUnit as never) && (
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
                    {PREP_YIELD_UNITS.map(u => (
                      <option key={u} value={u}>{u}</option>
                    ))}
                    {!PREP_YIELD_UNITS.includes((recipe.portionUnit ?? recipe.yieldUnit) as never) && (
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
              <span className="text-xs font-medium text-ink-3 uppercase tracking-wide">Allergens</span>
              <AllergenBadges allergens={recipe.allergens} size="sm" />
            </div>
          )}

          <div>
            <button onClick={() => setShowNotes(s => !s)} className="flex items-center gap-1.5 text-xs text-ink-3 hover:text-ink-2">
              {showNotes ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              Notes {recipe.notes && <span className="text-blue">•</span>}
            </button>
            {showNotes && (
              <div className="mt-2 space-y-2">
                {recipe.notes && (
                  <div className="text-sm text-ink-2 leading-relaxed px-3 py-2 bg-bg rounded-lg">
                    {renderMarkdown(recipe.notes)}
                  </div>
                )}
                <textarea defaultValue={recipe.notes ?? ''} onBlur={e => patchRecipe({ notes: e.target.value || null })} rows={3}
                  className="w-full border border-line rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-gold resize-none"
                  placeholder="Recipe notes, storage instructions…" />
              </div>
            )}
          </div>

          {/* Method steps — ordered, persists via patchRecipe */}
          <div className="mt-5">
            <div className="font-mono text-[10px] uppercase tracking-[0.05em] text-ink-3 mb-2">Method · steps</div>
            <ol className="flex flex-col gap-2">
              {(recipe.steps ?? []).map((s, i) => (
                <li key={i} className="flex gap-2 items-start">
                  <span className="font-mono text-[11px] font-semibold text-gold-2 bg-gold-soft w-[22px] h-[22px] rounded-[7px] grid place-items-center shrink-0">{i + 1}</span>
                  <textarea
                    defaultValue={s}
                    rows={2}
                    onBlur={e => {
                      const next = [...(recipe.steps ?? [])]; next[i] = e.target.value
                      patchRecipe({ steps: next.filter(x => x.trim() !== '') })
                    }}
                    className="flex-1 text-sm border border-line rounded-lg px-3 py-2 resize-y outline-none focus:border-ink-3"
                  />
                  <button
                    onClick={() => patchRecipe({ steps: (recipe.steps ?? []).filter((_, j) => j !== i) })}
                    className="text-ink-3 hover:text-red-text px-2 py-1"
                    aria-label="Remove step"
                  >✕</button>
                </li>
              ))}
            </ol>
            <button
              onClick={() => patchRecipe({ steps: [...(recipe.steps ?? []), ''] })}
              className="mt-2 text-[12.5px] font-medium text-ink-2 hover:text-ink"
            >+ Add step</button>
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
            <div className="text-sm font-semibold text-ink-2 mb-2">
              Ingredients {sf !== 1 && <span className="text-blue font-normal text-xs ml-1">scaled ×{sf}</span>}
            </div>
            {baseIsSet && baseIngName && (
              <div className="flex items-center gap-1.5 mb-2 bg-gold-soft border border-gold-soft rounded-lg px-2.5 py-1.5 text-xs text-gold-2">
                <Star size={10} className="fill-gold text-gold shrink-0" />
                <span>Baker&apos;s %: relative to <span className="font-semibold">{baseIngName}</span> (100%) — volume treated as 1 ml = 1 g</span>
              </div>
            )}
            {!baseIsSet && (
              <div className="flex items-center gap-1.5 mb-2 text-xs text-ink-4">
                <Star size={10} className="shrink-0" />
                <span>Click <Star size={9} className="inline" /> on any ingredient to set it as the baker&apos;s 100% reference</span>
              </div>
            )}
            <RecipeDimensionWarning count={recipe.dimensionConflicts ?? 0} className="mb-2" />
            <div className="border border-line rounded-t-xl overflow-hidden">
              <div className="grid grid-cols-12 gap-2 px-3 py-2 bg-bg text-xs font-medium text-ink-3">
                <div className="col-span-4">Ingredient</div>
                <div className="col-span-1 text-center" title={baseIsSet && baseIngName ? `Baker's % relative to ${baseIngName}` : 'Baker\'s %'}>%</div>
                <div className="col-span-2 text-right">Qty</div>
                <div className="col-span-2">Unit</div>
                <div className="col-span-2 text-right">Line cost</div>
                <div className="col-span-1" />
              </div>
              {recipe.ingredients.length === 0 && <div className="text-center py-6 text-ink-4 text-sm">No ingredients yet</div>}
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
            <div className="relative border border-line border-t-0 rounded-b-xl px-3 py-2 bg-white" ref={searchRef}>
              <div className="flex items-center gap-2">
                <Search size={14} className="text-ink-4 shrink-0" />
                <input value={searchQ} onChange={e => {
                  setSearchQ(e.target.value)
                  clearTimeout(searchTimer.current)
                  searchTimer.current = setTimeout(() => { doSearch(e.target.value); setShowSearch(true) }, 400)
                }}
                  onFocus={() => { if (searchResults.length > 0) setShowSearch(true) }}
                  placeholder="+ Add ingredient — search inventory or recipes…"
                  className="flex-1 text-sm text-ink-2 placeholder-ink-4 outline-none bg-transparent py-1" />
              </div>
              {showSearch && searchResults.length > 0 && (
                <div className="absolute left-0 right-0 top-full mt-1 bg-white border border-line rounded-xl shadow-xl z-50 max-h-64 overflow-y-auto">
                  {searchResults.map(item => (
                    <button key={`${item.type}-${item.id}`} onClick={() => addIngredient(item)}
                      className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-bg text-left text-sm">
                      {item.type === 'recipe' ? <ChefHat size={13} className="text-green shrink-0" /> : <Package size={13} className="text-blue shrink-0" />}
                      <span className="flex-1 text-ink-2">{item.name}</span>
                      <span className="text-xs text-ink-4">{item.unit}</span>
                      <span className="text-xs text-ink-3">{formatCurrency(item.pricePerBaseUnit)}/{item.unit}</span>
                      <span className={`text-xs px-1.5 py-0.5 rounded ${item.type === 'recipe' ? 'bg-green-soft text-green' : 'bg-gold/10 text-gold'}`}>
                        {item.type === 'recipe' ? 'PREP' : item.category}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="bg-bg rounded-xl p-4 space-y-2">
            {!isMenu ? (
              <>
                <div className="flex justify-between text-sm">
                  <span className="text-ink-3">Total recipe cost</span>
                  <span className="font-bold text-ink">{formatCurrency(scaledTotal)}{sf !== 1 && <span className="text-xs text-blue ml-1">at ×{sf}</span>}</span>
                </div>
                <div className="flex justify-between text-sm items-center">
                  <span className="text-ink-3">Cost per {recipe.yieldUnit}</span>
                  <span className="font-semibold text-ink-2">{formatUnitPrice(baseCostPerUnit)}<span className="text-ink-4 text-xs ml-0.5">/{recipe.yieldUnit}</span></span>
                </div>
                {recipe.portionSize && recipe.portionSize > 0 && (() => {
                  const portionUnit = recipe.portionUnit ?? recipe.yieldUnit
                  const portionQty = Number(recipe.portionSize)
                  const portionCost = recipe.costPerPortion !== null ? recipe.costPerPortion * sf : baseCostPerUnit * portionQty * sf
                  const portionsPerBatch = recipe.baseYieldQty > 0 && portionQty > 0 ? Math.floor(recipe.baseYieldQty / portionQty) : null
                  return (
                    <>
                      <div className="border-t border-line pt-2 mt-1 flex justify-between text-sm items-center">
                        <span className="text-ink-3">Cost per {portionQty}{portionUnit} portion</span>
                        <span className="font-semibold text-blue-text">{formatCurrency(portionCost)}</span>
                      </div>
                      {portionsPerBatch !== null && (
                        <div className="flex justify-between text-xs text-ink-4">
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
                <div className="flex justify-between text-sm"><span className="text-ink-3">Base Cost</span><span className="font-bold text-ink">{formatCurrency(recipe.totalCost)}</span></div>
                <div className="flex justify-between text-sm">
                  <span className="text-ink-3">Menu price</span>
                  <span className="font-semibold text-ink-2">{recipe.menuPrice !== null ? formatCurrency(recipe.menuPrice) : '—'}</span>
                </div>
                <div className="flex justify-between text-sm items-center">
                  <span className="text-ink-3">Food cost %</span>
                  <span className={`font-bold text-base ${foodCostClass(menuFoodCostPct)}`}>{menuFoodCostPct !== null ? `${menuFoodCostPct.toFixed(1)}%` : '—'}</span>
                </div>
                {margin !== null && (
                  <div className="flex justify-between text-sm">
                    <span className="text-ink-3">Margin / dish</span>
                    <span className={`font-semibold ${margin >= 0 ? 'text-green-text' : 'text-red'}`}>{formatCurrency(margin)}</span>
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
              <div className="flex items-center gap-1.5 text-xs text-green pt-1 border-t border-line">
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
        <div className="px-5 pt-5 pb-4 border-b border-line flex items-start justify-between gap-2 shrink-0">
          <div>
            <div className="flex items-center gap-2">
              <ChefHat size={15} className="text-green" />
              <h3 className="font-semibold text-ink">{recipe?.name ?? '…'}</h3>
            </div>
            <span className="text-[11px] bg-green-soft text-green-text px-1.5 py-0.5 rounded-full font-medium">PREP Recipe</span>
          </div>
          <button onClick={onClose} className="text-ink-4 hover:text-ink-3 mt-0.5 shrink-0"><X size={16} /></button>
        </div>

        {!recipe ? (
          <div className="flex justify-center py-10"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-gold" /></div>
        ) : (
          <>
            {/* Stats */}
            <div className="px-5 py-3 grid grid-cols-3 gap-2 shrink-0 border-b border-line">
              <div className="bg-bg rounded-lg px-3 py-2 text-center">
                <div className="text-[10px] text-ink-4 uppercase tracking-wide">Total Cost</div>
                <div className="font-semibold text-ink-2 text-sm">{formatCurrency(recipe.totalCost)}</div>
              </div>
              <div className="bg-bg rounded-lg px-3 py-2 text-center">
                <div className="text-[10px] text-ink-4 uppercase tracking-wide">Yield</div>
                <div className="font-semibold text-ink-2 text-sm">{formatQtyUnit(recipe.baseYieldQty, recipe.yieldUnit)}</div>
              </div>
              <div className="bg-gold/10 rounded-lg px-3 py-2 text-center">
                <div className="text-[10px] text-gold/70 uppercase tracking-wide">Cost/{recipe.yieldUnit}</div>
                <div className="font-semibold text-gold text-sm">{formatUnitPrice(costPerUnit)}</div>
              </div>
            </div>

            {/* Ingredients */}
            <div className="overflow-y-auto flex-1">
              {/* Column headers */}
              <div className="grid grid-cols-12 gap-2 px-4 py-2 text-[10px] font-medium text-ink-4 uppercase tracking-wide bg-bg border-b border-line">
                <div className="col-span-5">Ingredient</div>
                <div className="col-span-2 text-right">Qty</div>
                <div className="col-span-2">Unit</div>
                <div className="col-span-2 text-right">Cost</div>
                <div className="col-span-1" />
              </div>

              {recipe.ingredients.length === 0 && (
                <div className="text-center py-8 text-ink-4 text-sm">No ingredients yet</div>
              )}

              {recipe.ingredients.map(ing => (
                <PrepIngredientRow key={ing.id} ing={ing}
                  onUpdate={data => updateIngredient(ing.id, data)}
                  onDelete={() => deleteIngredient(ing.id)} />
              ))}

              {/* Add ingredient search */}
              <div className="relative px-3 py-2 border-t border-line" ref={searchRef}>
                <div className="flex items-center gap-2">
                  <Search size={13} className="text-ink-4 shrink-0" />
                  <input value={searchQ} onChange={e => {
                    setSearchQ(e.target.value)
                    clearTimeout(searchTimer.current)
                    searchTimer.current = setTimeout(() => { doSearch(e.target.value); setShowSearch(true) }, 400)
                  }}
                    onFocus={() => { if (searchResults.length > 0) setShowSearch(true) }}
                    placeholder="+ Add ingredient…"
                    className="flex-1 text-sm text-ink-2 placeholder-ink-4 outline-none bg-transparent py-1" />
                </div>
                {showSearch && searchResults.length > 0 && (
                  <div className="absolute left-0 right-0 bottom-full mb-1 bg-white border border-line rounded-xl shadow-xl z-50 max-h-48 overflow-y-auto">
                    {searchResults.map(item => (
                      <button key={`${item.type}-${item.id}`} onClick={() => addIngredient(item)}
                        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-bg text-left text-sm">
                        {item.type === 'recipe' ? <ChefHat size={12} className="text-green shrink-0" /> : <Package size={12} className="text-blue shrink-0" />}
                        <span className="flex-1 text-ink-2">{item.name}</span>
                        <span className="text-xs text-ink-4">{item.unit}</span>
                        <span className={`text-xs px-1.5 py-0.5 rounded ${item.type === 'recipe' ? 'bg-green-soft text-green' : 'bg-gold/10 text-gold'}`}>
                          {item.type === 'recipe' ? 'PREP' : item.category}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Footer */}
            <div className="px-5 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] border-t border-line shrink-0">
              <button onClick={onClose} className="w-full border border-line rounded-xl py-2 text-sm text-ink-2 hover:bg-bg transition-colors">
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
    <div className="grid grid-cols-12 gap-2 px-4 py-2 items-center border-t border-line hover:bg-bg group">
      <div className="col-span-5 flex items-center gap-1.5 min-w-0 flex-wrap">
        {ing.ingredientType === 'recipe'
          ? <ChefHat size={11} className="text-green shrink-0" />
          : <Package size={11} className="text-blue shrink-0" />}
        <span className="text-sm text-ink-2 truncate">{ing.ingredientName}</span>
        {ing.allergens && ing.allergens.length > 0 && (
          <AllergenBadges allergens={ing.allergens} size="xs" />
        )}
      </div>
      <div className="col-span-2">
        <input type="number" value={qty} onChange={e => setQty(e.target.value)} onBlur={saveQty}
          onKeyDown={e => e.key === 'Enter' && saveQty()}
          className="w-full text-right border border-line rounded px-1 py-0.5 text-sm text-ink focus:outline-none focus:border-[#93c5fd]" />
      </div>
      <div className="col-span-2">
        <select value={unitInList ? unit : '__custom__'} onChange={e => { if (e.target.value !== '__custom__') saveUnit(e.target.value) }}
          className="w-full border border-line rounded px-1 py-0.5 text-xs text-ink-2 bg-white focus:outline-none focus:ring-1 focus:ring-gold">
          {!unitInList && <option value="__custom__">{unit}</option>}
          {compatibleGroups.map(group => (
            <optgroup key={group.label} label={group.label}>
              {group.units.map(u => <option key={u.label} value={u.label}>{u.label}</option>)}
            </optgroup>
          ))}
        </select>
      </div>
      <div className="col-span-2 text-right text-sm font-medium text-ink-2">
        {ing.dimensionConflict && <UnitMismatchPill ing={ing} />}
        {formatCurrency(ing.lineCost)}
      </div>
      <div className="col-span-1 flex justify-end opacity-0 group-hover:opacity-100">
        <button onClick={onDelete} className="text-ink-4 hover:text-red"><Trash2 size={13} /></button>
      </div>
    </div>
  )
}

// ─── CategoryManager ──────────────────────────────────────────────────────────
export function CategoryManager({ type, categories, onClose, onUpdated, revenueCenterId, revenueCenters }: {
  type: string
  categories: RecipeCategory[]
  onClose: () => void
  onUpdated: () => void
  revenueCenterId?: string | null
  revenueCenters?: { id: string; name: string; isActive: boolean }[]
}) {
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState(CATEGORY_PALETTE[0])
  // Both MENU and PREP categories are revenue-center-scoped; null = Shared
  // (visible in all RCs). Make the RC an explicit, visible choice (pre-filled
  // from the active filter) rather than a silent inherit — mirrors the RC field
  // on the recipe forms. The selector shows whenever revenueCenters is provided.
  const [newRcId, setNewRcId] = useState<string>(revenueCenterId ?? '')

  const typeCats = categories.filter(c => c.type === type).sort((a, b) => a.sortOrder - b.sortOrder)
  const showRcPicker = !!revenueCenters?.length

  const addCat = async () => {
    if (!newName.trim()) return
    await fetch('/api/recipes/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: newName,
        type,
        color: newColor,
        revenueCenterId: newRcId || null,
      }),
    })
    setNewName(''); setNewRcId(revenueCenterId ?? ''); setAdding(false); onUpdated()
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
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <h3 className="font-bold text-ink">Manage {type === 'PREP' ? 'Recipe Book' : 'Menu'} Categories</h3>
          <button onClick={onClose} className="text-ink-4 hover:text-ink-3"><X size={18} /></button>
        </div>
        <div className="overflow-y-auto flex-1 p-4 space-y-2">
          {typeCats.map(cat => (
            <div key={cat.id} className="flex items-center gap-2 group">
              <div className="relative">
                <div className="w-6 h-6 rounded-full cursor-pointer border-2 border-white shadow" style={{ background: cat.color ?? '#94a3b8' }} />
                <input type="color" value={cat.color ?? '#94a3b8'} onChange={e => updateCat(cat.id, { color: e.target.value })}
                  className="absolute inset-0 opacity-0 cursor-pointer w-full h-full" />
              </div>
              <InlineEdit value={cat.name} onSave={name => updateCat(cat.id, { name })} className="flex-1 text-sm text-ink-2" />
              <span className="text-xs text-ink-4">{cat._count?.recipes ?? 0} recipes</span>
              <button onClick={() => deleteCat(cat.id)} disabled={(cat._count?.recipes ?? 0) > 0}
                title={(cat._count?.recipes ?? 0) > 0 ? 'Move recipes first' : 'Delete'}
                className="text-ink-4 hover:text-red disabled:opacity-30 disabled:cursor-not-allowed">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          {adding ? (
            <div className="flex flex-col gap-2 mt-2">
              <div className="flex items-center gap-2">
                <div className="flex gap-1">
                  {CATEGORY_PALETTE.map(c => (
                    <button key={c} onClick={() => setNewColor(c)}
                      className={`w-5 h-5 rounded-full border-2 ${newColor === c ? 'border-ink-3' : 'border-transparent'}`}
                      style={{ background: c }} />
                  ))}
                </div>
                <input autoFocus value={newName} onChange={e => setNewName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') addCat(); if (e.key === 'Escape') setAdding(false) }}
                  placeholder="Category name"
                  className="flex-1 border border-line rounded-lg px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-gold" />
                <button onClick={addCat} className="text-gold"><Check size={16} /></button>
                <button onClick={() => setAdding(false)} className="text-ink-4"><X size={14} /></button>
              </div>
              {showRcPicker && (
                <label className="flex items-center gap-2 text-xs text-ink-3 pl-1">
                  Revenue center
                  <select value={newRcId} onChange={e => setNewRcId(e.target.value)}
                    className="flex-1 border border-line rounded-lg px-2.5 py-1.5 text-sm text-ink bg-paper focus:outline-none focus:ring-2 focus:ring-gold">
                    <option value="">Shared (all RCs)</option>
                    {revenueCenters!.filter(rc => rc.isActive).map(rc => (
                      <option key={rc.id} value={rc.id}>{rc.name}</option>
                    ))}
                  </select>
                </label>
              )}
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
