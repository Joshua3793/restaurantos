'use client'
// ─── Shared types, helpers and components used by both Recipe Book and Menu pages ───
import { useEffect, useState, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { formatCurrency, formatUnitPrice, formatQtyUnit, calcPricePerBaseUnit, deriveBaseUnit, PACK_UOMS, compatibleCountUnits, getUnitDimension } from '@/lib/utils'
import { UOM_GROUPS } from '@/lib/uom'
import {
  Plus, X, ChefHat, BookOpen, UtensilsCrossed, Search, MoreHorizontal,
  ArrowLeft, ChevronDown, ChevronUp, Pencil, Check, Trash2, Copy,
  Link2, Minus, Package, ExternalLink, Printer,
} from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────
export interface RecipeCategory {
  id: string
  name: string
  type: string
  color: string | null
  sortOrder: number
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
}

export interface Recipe {
  id: string
  name: string
  type: string
  categoryId: string
  categoryName: string
  categoryColor: string | null
  inventoryItemId: string | null
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
  allergens?: string[]
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
        className={`border-b border-blue-500 outline-none bg-transparent ${className}`}
      />
    )
  }
  return (
    <span onClick={() => setEditing(true)} className={`cursor-pointer hover:text-blue-600 group ${className}`}>
      {value} <Pencil size={11} className="inline opacity-0 group-hover:opacity-40 ml-1" />
    </span>
  )
}

// ─── RecipeCard ───────────────────────────────────────────────────────────────
export function RecipeCard({ recipe, onOpen, onToggle, onDuplicate }: {
  recipe: Recipe
  onOpen: () => void
  onToggle: () => void
  onDuplicate: () => void
}) {
  const [showMore, setShowMore] = useState(false)
  const [showPrint, setShowPrint] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setShowMore(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const isMenu = recipe.type === 'MENU'
  const inactive = !recipe.isActive

  return (
    <div
      className={`flex items-center gap-3 px-4 py-3 bg-white hover:bg-gray-50/60 transition-colors cursor-pointer ${inactive ? 'opacity-50' : ''}`}
      onClick={onOpen}
    >
      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: recipe.categoryColor ?? '#94a3b8' }} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-gray-900 text-sm">{recipe.name}</span>
          {inactive && <span className="text-xs bg-gray-100 text-gray-400 px-1.5 py-0.5 rounded-full">Off</span>}
        </div>
        {/* Yield subtitle */}
        <div className="text-xs text-gray-400 mt-0.5 flex items-center gap-1.5">
          {!isMenu ? (
            <>
              <span>Yields <span className="text-gray-500 font-medium">{formatQtyUnit(recipe.baseYieldQty, recipe.yieldUnit)}</span></span>
              {recipe.portionSize && recipe.portionUnit && recipe.portionSize > 0 && (
                <>
                  <span className="text-gray-200">·</span>
                  <span>
                    <span className="text-gray-500 font-medium">
                      {Math.round(recipe.baseYieldQty / recipe.portionSize)}
                    </span> × {formatQtyUnit(recipe.portionSize, recipe.portionUnit)} portions
                  </span>
                </>
              )}
              {recipe.usedInCount !== undefined && recipe.usedInCount > 0 && (
                <>
                  <span className="text-gray-200">·</span>
                  <span className="text-emerald-600 font-medium">{recipe.usedInCount} {recipe.usedInCount === 1 ? 'dish' : 'dishes'}</span>
                </>
              )}
            </>
          ) : (
            <>
              {recipe.portionSize && recipe.portionUnit ? (
                <span>Per portion: <span className="text-gray-500 font-medium">{formatQtyUnit(recipe.portionSize, recipe.portionUnit)}</span></span>
              ) : (
                <span>Yield: <span className="text-gray-500 font-medium">{formatQtyUnit(recipe.baseYieldQty, recipe.yieldUnit)}</span></span>
              )}
            </>
          )}
        </div>
      </div>

      {!isMenu && (
        <div className="hidden sm:flex items-center gap-1.5 text-xs shrink-0">
          <span className="text-gray-400">{formatCurrency(recipe.totalCost)}</span>
          <span className="text-gray-200">·</span>
          <span className="font-semibold text-gray-700">
            {recipe.baseYieldQty > 0 ? `${formatUnitPrice(recipe.totalCost / recipe.baseYieldQty)}/${recipe.yieldUnit}` : '—'}
          </span>
        </div>
      )}

      {isMenu && (
        <div className="hidden sm:flex items-center gap-1.5 text-xs shrink-0">
          <span className="text-gray-400">{formatCurrency(recipe.totalCost)}</span>
          <span className="text-gray-200">·</span>
          <span className="text-gray-700">{recipe.menuPrice !== null ? formatCurrency(recipe.menuPrice) : '—'}</span>
          <span className="text-gray-200">·</span>
          <span className={`font-semibold ${foodCostClass(recipe.menuPrice ? (recipe.totalCost / recipe.menuPrice) * 100 : null)}`}>
            {recipe.menuPrice ? `${((recipe.totalCost / recipe.menuPrice) * 100).toFixed(1)}%` : '—'}
          </span>
        </div>
      )}

      <button
        onClick={e => { e.stopPropagation(); onToggle() }}
        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${recipe.isActive ? 'bg-green-500' : 'bg-gray-200'}`}
      >
        <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${recipe.isActive ? 'translate-x-4' : 'translate-x-0'}`} />
      </button>

      <div className="relative shrink-0" ref={moreRef} onClick={e => e.stopPropagation()}>
        <button onClick={() => setShowMore(s => !s)} className="p-1 text-gray-300 hover:text-gray-500 rounded">
          <MoreHorizontal size={15} />
        </button>
        {showMore && (
          <div className="absolute right-0 top-7 bg-white rounded-xl shadow-lg border border-gray-100 py-1 z-10 w-36">
            <button onClick={() => { setShowPrint(true); setShowMore(false) }} className="w-full px-3 py-2 text-sm text-left text-gray-700 hover:bg-gray-50 flex items-center gap-2">
              <Printer size={13} /> Print Card
            </button>
            <button onClick={() => { onDuplicate(); setShowMore(false) }} className="w-full px-3 py-2 text-sm text-left text-gray-700 hover:bg-gray-50 flex items-center gap-2">
              <Copy size={13} /> Duplicate
            </button>
            <button onClick={() => { onToggle(); setShowMore(false) }} className="w-full px-3 py-2 text-sm text-left text-gray-700 hover:bg-gray-50 flex items-center gap-2">
              {recipe.isActive ? <Minus size={13} /> : <Check size={13} />}
              {recipe.isActive ? 'Deactivate' : 'Activate'}
            </button>
          </div>
        )}
      </div>
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
    <div className="fixed inset-0 z-[200] flex items-start justify-center p-4 overflow-y-auto print:p-0 print:inset-0 print:z-auto">
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
                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${scale === s ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
              >
                {s === 1 ? '×1 (base)' : `×${s}`}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handlePrint} className="flex items-center gap-2 bg-blue-600 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-blue-700">
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
              <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">{recipe.notes}</p>
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
      className="w-full border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-400" />
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
    : calcPricePerBaseUnit(pp, qty, ps, pu)
  const bu   = isPrep ? (item?.baseUnit ?? 'each') : deriveBaseUnit(pu)

  const inputCls = 'w-full border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-400'
  const selectCls = inputCls + ' bg-white'

  return (
    // Full-screen dimmed overlay at z-[60], above the recipe panel (z-50)
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" onClick={onClose}>
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
          <div className={`rounded-xl p-3 ${isPrep ? 'bg-purple-50' : 'bg-blue-50'}`}>
            <div className={`text-[11px] font-semibold uppercase tracking-wide mb-1 ${isPrep ? 'text-purple-600' : 'text-blue-600'}`}>
              {isPrep ? 'Recipe-derived cost' : 'Cost preview'}
            </div>
            <div className={`text-xl font-bold ${isPrep ? 'text-purple-700' : 'text-blue-700'}`}>
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
            className="flex-1 bg-blue-600 text-white rounded-xl py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── IngredientRow ────────────────────────────────────────────────────────────
function IngredientRow({ ing, scaleFactor, canMoveUp, canMoveDown, onUpdate, onDelete, onMoveUp, onMoveDown, onEditItem }: {
  ing: IngredientWithCost
  scaleFactor: number
  canMoveUp: boolean
  canMoveDown: boolean
  onUpdate: (data: Record<string, unknown>) => void
  onDelete: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onEditItem: () => void
}) {
  const [editingQty, setEditingQty] = useState(false)
  const [editingPct, setEditingPct] = useState(false)
  const [qty, setQty] = useState(String(ing.qtyBase))
  const [unit, setUnit] = useState(ing.unit)
  const [pct, setPct] = useState(ing.recipePercent !== null ? String(ing.recipePercent) : '')

  useEffect(() => { setQty(String(ing.qtyBase)) }, [ing.qtyBase])
  useEffect(() => { setUnit(ing.unit) }, [ing.unit])
  useEffect(() => { setPct(ing.recipePercent !== null ? String(ing.recipePercent) : '') }, [ing.recipePercent])

  const saveQty = () => { setEditingQty(false); if (qty !== String(ing.qtyBase)) onUpdate({ qtyBase: qty, unit }) }
  const saveUnit = (newUnit: string) => { setUnit(newUnit); onUpdate({ qtyBase: qty, unit: newUnit }) }
  const savePct = () => {
    setEditingPct(false)
    const parsed = pct === '' ? null : parseFloat(pct)
    if (parsed !== ing.recipePercent) onUpdate({ recipePercent: parsed })
  }

  const allKnownUnits = UOM_GROUPS.flatMap(g => g.units.map(u => u.label))
  const unitInList = allKnownUnits.includes(unit)
  const displayQty  = ing.qtyBase * scaleFactor
  const displayCost = ing.lineCost * scaleFactor

  return (
    <div className="grid grid-cols-12 gap-2 px-3 py-2 items-center border-t border-gray-50 hover:bg-gray-50 group">
      <div className="col-span-4 flex items-center gap-1.5 min-w-0">
        {ing.ingredientType === 'recipe'
          ? <ChefHat size={11} className="text-emerald-600 shrink-0" />
          : <Package size={11} className="text-blue-500 shrink-0" />
        }
        <button
          onClick={onEditItem}
          title={`Quick-edit ${ing.ingredientName}`}
          className="text-sm text-gray-800 text-left hover:text-blue-600 group/name flex items-start gap-1 min-w-0"
        >
          <span className="line-clamp-2 break-words leading-snug">{ing.ingredientName}</span>
          <Pencil size={10} className="shrink-0 opacity-0 group-hover/name:opacity-50 text-blue-500 transition-opacity mt-0.5" />
        </button>
      </div>

      <div className="col-span-1 text-center">
        {editingPct ? (
          <input type="number" value={pct} onChange={e => setPct(e.target.value)} onBlur={savePct}
            onKeyDown={e => e.key === 'Enter' && savePct()} placeholder="0"
            className="w-full text-center border border-blue-300 rounded px-0.5 py-0.5 text-xs text-gray-900 focus:outline-none" autoFocus />
        ) : (
          <span onClick={() => setEditingPct(true)} className={`text-xs cursor-pointer rounded px-0.5 ${
            ing.recipePercent !== null ? 'font-semibold text-indigo-600 hover:text-indigo-800' : 'text-gray-300 hover:text-gray-500'
          }`}>
            {ing.recipePercent !== null ? `${ing.recipePercent}%` : '—'}
          </span>
        )}
      </div>

      <div className="col-span-2 text-right">
        {editingQty ? (
          <input type="number" value={qty} onChange={e => setQty(e.target.value)} onBlur={saveQty}
            onKeyDown={e => e.key === 'Enter' && saveQty()}
            className="w-full text-right border border-blue-300 rounded px-1 py-0.5 text-sm text-gray-900 focus:outline-none" autoFocus />
        ) : (
          <span onClick={() => setEditingQty(true)} className="text-sm text-gray-800 cursor-pointer hover:text-blue-600">
            {Number(displayQty.toFixed(3)).toString()}
          </span>
        )}
      </div>

      <div className="col-span-2">
        <select value={unitInList ? unit : '__custom__'} onChange={e => { if (e.target.value !== '__custom__') saveUnit(e.target.value) }}
          className="w-full border border-gray-200 rounded px-1 py-0.5 text-xs text-gray-700 bg-white focus:outline-none focus:ring-1 focus:ring-blue-400">
          {!unitInList && <option value="__custom__">{unit}</option>}
          {UOM_GROUPS.map(group => (
            <optgroup key={group.label} label={group.label}>
              {group.units.map(u => <option key={u.label} value={u.label}>{u.label}</option>)}
            </optgroup>
          ))}
        </select>
      </div>

      <div className="col-span-2 text-right text-sm font-medium text-gray-800">{formatCurrency(displayCost)}</div>

      <div className="col-span-1 flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
        <div className="flex flex-col">
          <button onClick={onMoveUp} disabled={!canMoveUp} className="text-gray-300 hover:text-gray-600 disabled:opacity-0 leading-none"><ChevronUp size={10} /></button>
          <button onClick={onMoveDown} disabled={!canMoveDown} className="text-gray-300 hover:text-gray-600 disabled:opacity-0 leading-none"><ChevronDown size={10} /></button>
        </div>
        <button onClick={onDelete} className="text-gray-300 hover:text-red-500 ml-0.5"><Trash2 size={12} /></button>
      </div>
    </div>
  )
}

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
  const [saving, setSaving] = useState(false)
  const [showSaveScale, setShowSaveScale] = useState(false)
  const [newScaleName, setNewScaleName] = useState('')
  const [editingItem, setEditingItem] = useState<{ inventoryItemId: string } | { linkedRecipeId: string } | null>(null)
  const searchRef = useRef<HTMLDivElement>(null)
  const searchTimer = useRef<ReturnType<typeof setTimeout>>()

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
    const data = await fetch(`/api/recipes/search-ingredients?q=${encodeURIComponent(q)}`).then(r => r.json())
    setSearchResults(data)
  }, [])

  const patchRecipe = async (data: Record<string, unknown>) => {
    setSaving(true)
    await fetch(`/api/recipes/${recipeId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
    await load(); onUpdated(); setSaving(false)
  }

  const addIngredient = async (item: IngredientSearchResult) => {
    await fetch(`/api/recipes/${recipeId}/ingredients`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inventoryItemId: item.type === 'inventory' ? item.id : null, linkedRecipeId: item.type === 'recipe' ? item.id : null, qtyBase: 100, unit: item.unit }),
    })
    await load(); onUpdated(); setShowSearch(false); setSearchQ(''); setSearchResults([])
  }

  const updateIngredient = async (ingId: string, data: Record<string, unknown>) => {
    await fetch(`/api/recipes/${recipeId}/ingredients/${ingId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
    await load(); onUpdated()
  }

  const deleteIngredient = async (ingId: string) => {
    await fetch(`/api/recipes/${recipeId}/ingredients/${ingId}`, { method: 'DELETE' })
    await load(); onUpdated()
  }

  const saveScale = async () => {
    if (!newScaleName.trim()) return
    await fetch(`/api/recipes/${recipeId}/save-scale`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ newName: newScaleName, factor: scaleFactor }) })
    setShowSaveScale(false); setNewScaleName(''); onUpdated()
  }

  if (!recipe) return (
    <div className="fixed inset-y-0 right-0 w-full md:w-[600px] bg-white shadow-2xl flex items-center justify-center z-50">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
    </div>
  )

  const sf = scaleFactor
  const isMenu = recipe.type === 'MENU'
  const scaledTotal = recipe.totalCost * sf
  const baseCostPerUnit = recipe.baseYieldQty > 0 ? recipe.totalCost / recipe.baseYieldQty : 0
  const menuFoodCostPct = isMenu && recipe.menuPrice ? (recipe.totalCost / recipe.menuPrice) * 100 : null
  const margin = recipe.menuPrice !== null ? recipe.menuPrice - recipe.totalCost : null

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div className="w-full md:w-[640px] bg-white h-full overflow-y-auto flex flex-col shadow-2xl">
        <div className="sticky top-0 bg-white border-b border-gray-100 px-5 py-4 flex items-center gap-3 z-10">
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><ArrowLeft size={20} /></button>
          <div className="flex-1 min-w-0">
            <InlineEdit value={recipe.name} onSave={name => patchRecipe({ name })} className="text-lg font-bold text-gray-900" />
            <div className="flex items-center gap-2 mt-0.5">
              {isMenu ? (
                <span className="text-xs text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full flex items-center gap-1">
                  <UtensilsCrossed size={10} /> Menu
                </span>
              ) : (
                <span className="text-xs text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full flex items-center gap-1">
                  <BookOpen size={10} /> Recipe
                </span>
              )}
              {recipe.inventoryItemId && (
                <a href={`/inventory?highlight=${recipe.inventoryItemId}`}
                  className="text-xs bg-emerald-50 text-emerald-600 px-2 py-0.5 rounded-full flex items-center gap-1 hover:bg-emerald-100 transition-colors"
                  onClick={e => e.stopPropagation()}
                  title="View in Inventory">
                  <Link2 size={9} /> Synced to Inventory <ExternalLink size={8} />
                </a>
              )}
            </div>
          </div>
          {saving && <div className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />}
          <button onClick={() => patchRecipe({ isActive: !recipe.isActive })}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${recipe.isActive ? 'bg-green-500' : 'bg-gray-200'}`}>
            <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${recipe.isActive ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
        </div>

        <div className="p-5 space-y-5">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-gray-500 block mb-1">Category</label>
              <select value={recipe.categoryId} onChange={e => patchRecipe({ categoryId: e.target.value })}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500">
                {categories.filter(c => c.type === recipe.type).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-gray-500 block mb-1">
                Base Yield
                {(() => { const f = formatQtyUnit(recipe.baseYieldQty, recipe.yieldUnit); const raw = `${recipe.baseYieldQty} ${recipe.yieldUnit}`; return f !== raw ? <span className="ml-1 text-blue-500 font-normal">= {f}</span> : null })()}
              </label>
              <div className="flex gap-1">
                <input type="number" min="0" step="0.01" defaultValue={recipe.baseYieldQty} onBlur={e => patchRecipe({ baseYieldQty: e.target.value })}
                  className="flex-1 border border-gray-200 rounded-lg px-2 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                <input type="text" defaultValue={recipe.yieldUnit} onBlur={e => patchRecipe({ yieldUnit: e.target.value })}
                  className="w-16 border border-gray-200 rounded-lg px-2 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-gray-500 block mb-1">
                Menu Price {!isMenu && <span className="text-gray-300">(optional)</span>}
              </label>
              <div className="relative">
                <span className="absolute left-3 top-2 text-gray-400 text-sm">$</span>
                <input type="number" min="0" step="0.01" defaultValue={recipe.menuPrice ?? ''} placeholder="0.00"
                  onBlur={e => patchRecipe({ menuPrice: e.target.value || null })}
                  className="w-full border border-gray-200 rounded-lg pl-7 pr-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>
          </div>

          {/* Allergen matrix — inherited from ingredients */}
          {recipe.allergens && recipe.allergens.length > 0 && (
            <div className="bg-orange-50 border border-orange-200 rounded-xl p-3">
              <div className="text-xs font-bold uppercase tracking-wide text-orange-700 mb-2">⚠ Contains Allergens</div>
              <div className="flex flex-wrap gap-1.5">
                {recipe.allergens.map(a => (
                  <span key={a} className="px-2 py-0.5 rounded-full text-xs bg-orange-100 border border-orange-300 text-orange-800 font-medium">{a}</span>
                ))}
              </div>
            </div>
          )}

          <div>
            <button onClick={() => setShowNotes(s => !s)} className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700">
              {showNotes ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              Notes {recipe.notes && <span className="text-blue-500">•</span>}
            </button>
            {showNotes && (
              <textarea defaultValue={recipe.notes ?? ''} onBlur={e => patchRecipe({ notes: e.target.value || null })} rows={3}
                className="mt-2 w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                placeholder="Recipe notes, storage instructions…" />
            )}
          </div>

          {!isMenu && (
            <div className="bg-gray-50 rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-semibold text-gray-700">Scale Recipe</span>
                {sf !== 1 && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-blue-600 font-semibold">×{sf}</span>
                    <button onClick={() => { setShowSaveScale(s => !s); setNewScaleName(`${recipe.name} ×${sf}`) }}
                      className="text-xs bg-blue-600 text-white px-2.5 py-1 rounded-lg hover:bg-blue-700">Save as new</button>
                  </div>
                )}
              </div>
              <div className="flex gap-2 flex-wrap mb-3">
                {SCALE_PRESETS.map(p => (
                  <button key={p} onClick={() => { setScaleFactor(p); setCustomScale('') }}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${sf === p ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-700 hover:border-blue-400'}`}>
                    ×{p}
                  </button>
                ))}
              </div>
              <input type="range" min="0.25" max="10" step="0.25" value={sf}
                onChange={e => { setScaleFactor(parseFloat(e.target.value)); setCustomScale('') }}
                className="w-full accent-blue-600 mb-2" />
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500">Custom:</span>
                <input type="number" min="0.1" step="0.1" value={customScale} onChange={e => setCustomScale(e.target.value)}
                  onBlur={() => { const v = parseFloat(customScale); if (!isNaN(v) && v > 0) setScaleFactor(v) }}
                  placeholder="e.g. 2.5"
                  className="w-20 border border-gray-200 rounded px-2 py-1 text-xs text-gray-900 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                <span className="text-xs text-gray-400">×</span>
              </div>
              {showSaveScale && (
                <div className="mt-3 flex gap-2">
                  <input value={newScaleName} onChange={e => setNewScaleName(e.target.value)} placeholder="New recipe name…"
                    className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <button onClick={saveScale} className="bg-blue-600 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-blue-700">Save</button>
                  <button onClick={() => setShowSaveScale(false)} className="p-1.5 text-gray-400 hover:text-gray-600"><X size={14} /></button>
                </div>
              )}
            </div>
          )}

          <div>
            <div className="text-sm font-semibold text-gray-700 mb-2">
              Ingredients {sf !== 1 && <span className="text-blue-500 font-normal text-xs ml-1">scaled ×{sf}</span>}
            </div>
            <div className="border border-gray-100 rounded-t-xl overflow-hidden">
              <div className="grid grid-cols-12 gap-2 px-3 py-2 bg-gray-50 text-xs font-medium text-gray-500">
                <div className="col-span-4">Ingredient</div>
                <div className="col-span-1 text-center">%</div>
                <div className="col-span-2 text-right">Qty</div>
                <div className="col-span-2">Unit</div>
                <div className="col-span-2 text-right">Line cost</div>
                <div className="col-span-1" />
              </div>
              {recipe.ingredients.length === 0 && <div className="text-center py-6 text-gray-400 text-sm">No ingredients yet</div>}
              {recipe.ingredients.map((ing, idx) => (
                <IngredientRow key={ing.id} ing={ing} scaleFactor={sf}
                  canMoveUp={idx > 0} canMoveDown={idx < recipe.ingredients.length - 1}
                  onUpdate={data => updateIngredient(ing.id, data)}
                  onDelete={() => deleteIngredient(ing.id)}
                  onMoveUp={() => { const prev = recipe.ingredients[idx - 1]; updateIngredient(ing.id, { sortOrder: prev.sortOrder }); updateIngredient(prev.id, { sortOrder: ing.sortOrder }) }}
                  onMoveDown={() => { const next = recipe.ingredients[idx + 1]; updateIngredient(ing.id, { sortOrder: next.sortOrder }); updateIngredient(next.id, { sortOrder: ing.sortOrder }) }}
                  onEditItem={() => {
                    if (ing.inventoryItemId) setEditingItem({ inventoryItemId: ing.inventoryItemId })
                    else if (ing.linkedRecipeId) setEditingItem({ linkedRecipeId: ing.linkedRecipeId })
                  }}
                />
              ))}
            </div>
            <div className="relative border border-gray-100 border-t-0 rounded-b-xl px-3 py-2 bg-white" ref={searchRef}>
              <div className="flex items-center gap-2">
                <Search size={14} className="text-gray-400 shrink-0" />
                <input value={searchQ} onChange={e => {
                  setSearchQ(e.target.value)
                  clearTimeout(searchTimer.current)
                  searchTimer.current = setTimeout(() => { doSearch(e.target.value); setShowSearch(true) }, 250)
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
                      <span className={`text-xs px-1.5 py-0.5 rounded ${item.type === 'recipe' ? 'bg-emerald-50 text-emerald-600' : 'bg-blue-50 text-blue-600'}`}>
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
                  <span className="text-gray-600">Base Cost</span>
                  <span className="font-semibold text-gray-800">{formatUnitPrice(baseCostPerUnit)}<span className="text-gray-400 text-xs ml-0.5">/{recipe.yieldUnit}</span></span>
                </div>
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
                  <div className="pt-1">
                    <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${foodCostClass(menuFoodCostPct).replace('text-', 'bg-')}`}
                        style={{ width: `${Math.min(100, (recipe.totalCost / recipe.menuPrice) * 100)}%` }} />
                    </div>
                    <div className="flex justify-between text-xs text-gray-400 mt-0.5"><span>Cost</span><span>Price</span></div>
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
      </div>

      {/* ── Quick-edit overlays ───────────────────────────────────────────── */}
      {'inventoryItemId' in (editingItem ?? {}) && (editingItem as { inventoryItemId: string })?.inventoryItemId && (
        <InventoryQuickEdit
          inventoryItemId={(editingItem as { inventoryItemId: string }).inventoryItemId}
          onClose={() => setEditingItem(null)}
          onSaved={async () => { setEditingItem(null); await load(); onUpdated() }}
        />
      )}

      {'linkedRecipeId' in (editingItem ?? {}) && (editingItem as { linkedRecipeId: string })?.linkedRecipeId && (
        <PrepRecipeInfo
          linkedRecipeId={(editingItem as { linkedRecipeId: string }).linkedRecipeId}
          onClose={() => setEditingItem(null)}
        />
      )}
    </div>
  )
}

// ─── PrepRecipeInfo — read-only card for PREP sub-recipe ingredients ──────────
function PrepRecipeInfo({ linkedRecipeId, onClose }: { linkedRecipeId: string; onClose: () => void }) {
  const [info, setInfo] = useState<{ name: string; totalCost: number; baseYieldQty: number; yieldUnit: string; costPerPortion: number | null } | null>(null)

  useEffect(() => {
    fetch(`/api/recipes/${linkedRecipeId}`).then(r => r.json()).then(setInfo)
  }, [linkedRecipeId])

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="px-5 pt-5 pb-4 border-b border-gray-100 flex items-start justify-between gap-2">
          <div>
            <h3 className="font-semibold text-gray-900">{info?.name ?? '…'}</h3>
            <span className="text-[11px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-full font-medium">PREP Recipe</span>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 mt-0.5"><X size={16} /></button>
        </div>
        <div className="px-5 py-4 space-y-3">
          {info ? (
            <>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-[11px] text-gray-500">Total Cost</div>
                  <div className="font-semibold text-gray-800 mt-0.5">{formatCurrency(info.totalCost)}</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-[11px] text-gray-500">Yield</div>
                  <div className="font-semibold text-gray-800 mt-0.5">{formatQtyUnit(info.baseYieldQty, info.yieldUnit)}</div>
                </div>
                <div className="bg-emerald-50 rounded-lg p-3 col-span-2">
                  <div className="text-[11px] text-emerald-600">Cost per {info.yieldUnit}</div>
                  <div className="text-lg font-bold text-emerald-700">
                    {formatUnitPrice(info.baseYieldQty > 0 ? info.totalCost / info.baseYieldQty : 0)} / {info.yieldUnit}
                  </div>
                </div>
              </div>
              <p className="text-xs text-gray-500 bg-amber-50 rounded-lg px-3 py-2">
                To edit this recipe&apos;s ingredients or costs, open it in the Recipe Book.
              </p>
            </>
          ) : (
            <div className="flex justify-center py-6"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-emerald-600" /></div>
          )}
        </div>
        <div className="px-5 pb-5">
          <button onClick={onClose} className="w-full border border-gray-200 rounded-xl py-2 text-sm text-gray-700 hover:bg-gray-50">
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── CategoryManager ──────────────────────────────────────────────────────────
export function CategoryManager({ type, categories, onClose, onUpdated }: {
  type: string
  categories: RecipeCategory[]
  onClose: () => void
  onUpdated: () => void
}) {
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState(CATEGORY_PALETTE[0])

  const typeCats = categories.filter(c => c.type === type).sort((a, b) => a.sortOrder - b.sortOrder)

  const addCat = async () => {
    if (!newName.trim()) return
    await fetch('/api/recipes/categories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newName, type, color: newColor }) })
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
                className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              <button onClick={addCat} className="text-blue-600"><Check size={16} /></button>
              <button onClick={() => setAdding(false)} className="text-gray-400"><X size={14} /></button>
            </div>
          ) : (
            <button onClick={() => setAdding(true)} className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700 mt-2">
              <Plus size={14} /> Add category
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
