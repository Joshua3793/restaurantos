'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import { formatCurrency, formatUnitPrice } from '@/lib/utils'
import { UOM_GROUPS } from '@/lib/uom'
import {
  Plus, X, ChefHat, BookOpen, UtensilsCrossed, Search, MoreHorizontal,
  ArrowLeft, ChevronDown, ChevronUp, Pencil, Check, Trash2, Copy,
  Link2, Minus, Package
} from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────
interface RecipeCategory {
  id: string
  name: string
  type: string
  color: string | null
  sortOrder: number
  _count?: { recipes: number }
}

interface IngredientWithCost {
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

interface Recipe {
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

const CATEGORY_PALETTE = [
  '#ef4444','#f97316','#eab308','#22c55e',
  '#14b8a6','#3b82f6','#8b5cf6','#ec4899',
]

// ─── Helpers ─────────────────────────────────────────────────────────────────
function foodCostClass(pct: number | null): string {
  if (pct === null) return 'text-gray-500'
  if (pct < FOOD_COST_GREEN) return 'text-green-600'
  if (pct <= FOOD_COST_AMBER) return 'text-amber-500'
  return 'text-red-600'
}

function catDot(color: string | null) {
  return (
    <span
      className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
      style={{ background: color ?? '#94a3b8' }}
    />
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/** Inline editable text */
function InlineEdit({ value, onSave, className = '' }: { value: string; onSave: (v: string) => void; className?: string }) {
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

// ─── RECIPE CARD ──────────────────────────────────────────────────────────────
function RecipeCard({ recipe, onOpen, onToggle, onDuplicate }: {
  recipe: Recipe
  onOpen: () => void
  onToggle: () => void
  onDuplicate: () => void
}) {
  const [showMore, setShowMore] = useState(false)
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
      {/* Category dot + name */}
      <span
        className="w-2.5 h-2.5 rounded-full shrink-0"
        style={{ background: recipe.categoryColor ?? '#94a3b8' }}
      />
      <div className="flex-1 min-w-0">
        <span className="font-medium text-gray-900 text-sm">{recipe.name}</span>
        {inactive && (
          <span className="ml-2 text-xs bg-gray-100 text-gray-400 px-1.5 py-0.5 rounded-full">Off</span>
        )}
      </div>

      {/* PREP cost chips */}
      {!isMenu && (
        <div className="hidden sm:flex items-center gap-1.5 text-xs shrink-0">
          <span className="text-gray-400">{formatCurrency(recipe.totalCost)}</span>
          <span className="text-gray-200">·</span>
          <span className="font-semibold text-gray-700">
            {recipe.baseYieldQty > 0
              ? `${formatUnitPrice(recipe.totalCost / recipe.baseYieldQty)}/${recipe.yieldUnit}`
              : '—'}
          </span>
        </div>
      )}

      {/* MENU cost chips */}
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

      {/* Toggle */}
      <button
        onClick={e => { e.stopPropagation(); onToggle() }}
        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${recipe.isActive ? 'bg-green-500' : 'bg-gray-200'}`}
      >
        <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${recipe.isActive ? 'translate-x-4' : 'translate-x-0'}`} />
      </button>

      {/* More menu */}
      <div className="relative shrink-0" ref={moreRef} onClick={e => e.stopPropagation()}>
        <button
          onClick={() => setShowMore(s => !s)}
          className="p-1 text-gray-300 hover:text-gray-500 rounded"
        >
          <MoreHorizontal size={15} />
        </button>
        {showMore && (
          <div className="absolute right-0 top-7 bg-white rounded-xl shadow-lg border border-gray-100 py-1 z-10 w-36">
            <button
              onClick={() => { onDuplicate(); setShowMore(false) }}
              className="w-full px-3 py-2 text-sm text-left text-gray-700 hover:bg-gray-50 flex items-center gap-2"
            >
              <Copy size={13} /> Duplicate
            </button>
            <button
              onClick={() => { onToggle(); setShowMore(false) }}
              className="w-full px-3 py-2 text-sm text-left text-gray-700 hover:bg-gray-50 flex items-center gap-2"
            >
              {recipe.isActive ? <Minus size={13} /> : <Check size={13} />}
              {recipe.isActive ? 'Deactivate' : 'Activate'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── DETAIL PANEL ─────────────────────────────────────────────────────────────
function RecipePanel({
  recipeId, categories, onClose, onUpdated,
}: {
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
    await fetch(`/api/recipes/${recipeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    await load()
    onUpdated()
    setSaving(false)
  }

  const addIngredient = async (item: IngredientSearchResult) => {
    await fetch(`/api/recipes/${recipeId}/ingredients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inventoryItemId: item.type === 'inventory' ? item.id : null,
        linkedRecipeId: item.type === 'recipe' ? item.id : null,
        qtyBase: 100,
        unit: item.unit,
      }),
    })
    await load()
    onUpdated()
    setShowSearch(false)
    setSearchQ('')
    setSearchResults([])
  }

  const updateIngredient = async (ingId: string, data: Record<string, unknown>) => {
    await fetch(`/api/recipes/${recipeId}/ingredients/${ingId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    await load()
    onUpdated()
  }

  const deleteIngredient = async (ingId: string) => {
    await fetch(`/api/recipes/${recipeId}/ingredients/${ingId}`, { method: 'DELETE' })
    await load()
    onUpdated()
  }

  const saveScale = async () => {
    if (!newScaleName.trim()) return
    await fetch(`/api/recipes/${recipeId}/save-scale`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newName: newScaleName, factor: scaleFactor }),
    })
    setShowSaveScale(false)
    setNewScaleName('')
    onUpdated()
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
      {/* Backdrop */}
      <div className="flex-1 bg-black/30 backdrop-blur-sm" onClick={onClose} />

      {/* Panel */}
      <div className="w-full md:w-[640px] bg-white h-full overflow-y-auto flex flex-col shadow-2xl">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-gray-100 px-5 py-4 flex items-center gap-3 z-10">
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <ArrowLeft size={20} />
          </button>
          <div className="flex-1 min-w-0">
            <InlineEdit
              value={recipe.name}
              onSave={name => patchRecipe({ name })}
              className="text-lg font-bold text-gray-900"
            />
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
                <span className="text-xs bg-emerald-50 text-emerald-600 px-2 py-0.5 rounded-full flex items-center gap-1">
                  <Link2 size={9} /> Synced to Inventory
                </span>
              )}
            </div>
          </div>
          {saving && <div className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />}
          <button
            onClick={() => patchRecipe({ isActive: !recipe.isActive })}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${recipe.isActive ? 'bg-green-500' : 'bg-gray-200'}`}
          >
            <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${recipe.isActive ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Meta fields */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-gray-500 block mb-1">Category</label>
              <select
                value={recipe.categoryId}
                onChange={e => patchRecipe({ categoryId: e.target.value })}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {categories.filter(c => c.type === recipe.type).map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-gray-500 block mb-1">Base Yield</label>
              <div className="flex gap-1">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={recipe.baseYieldQty}
                  onBlur={e => patchRecipe({ baseYieldQty: e.target.value })}
                  className="flex-1 border border-gray-200 rounded-lg px-2 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <input
                  type="text"
                  defaultValue={recipe.yieldUnit}
                  onBlur={e => patchRecipe({ yieldUnit: e.target.value })}
                  className="w-16 border border-gray-200 rounded-lg px-2 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-gray-500 block mb-1">
                Menu Price {!isMenu && <span className="text-gray-300">(optional)</span>}
              </label>
              <div className="relative">
                <span className="absolute left-3 top-2 text-gray-400 text-sm">$</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={recipe.menuPrice ?? ''}
                  placeholder="0.00"
                  onBlur={e => patchRecipe({ menuPrice: e.target.value || null })}
                  className="w-full border border-gray-200 rounded-lg pl-7 pr-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
          </div>

          {/* Notes */}
          <div>
            <button
              onClick={() => setShowNotes(s => !s)}
              className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700"
            >
              {showNotes ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              Notes {recipe.notes && <span className="text-blue-500">•</span>}
            </button>
            {showNotes && (
              <textarea
                defaultValue={recipe.notes ?? ''}
                onBlur={e => patchRecipe({ notes: e.target.value || null })}
                rows={3}
                className="mt-2 w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                placeholder="Recipe notes, storage instructions…"
              />
            )}
          </div>

          {/* ── SCALE CONTROL (PREP only) ── */}
          {!isMenu && <div className="bg-gray-50 rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-semibold text-gray-700">Scale Recipe</span>
              {sf !== 1 && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-blue-600 font-semibold">×{sf}</span>
                  <button
                    onClick={() => { setShowSaveScale(s => !s); setNewScaleName(`${recipe.name} ×${sf}`) }}
                    className="text-xs bg-blue-600 text-white px-2.5 py-1 rounded-lg hover:bg-blue-700"
                  >
                    Save as new
                  </button>
                </div>
              )}
            </div>

            {/* Preset buttons */}
            <div className="flex gap-2 flex-wrap mb-3">
              {SCALE_PRESETS.map(p => (
                <button
                  key={p}
                  onClick={() => { setScaleFactor(p); setCustomScale('') }}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    sf === p ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-700 hover:border-blue-400'
                  }`}
                >
                  ×{p}
                </button>
              ))}
            </div>

            {/* Range slider */}
            <input
              type="range"
              min="0.25"
              max="10"
              step="0.25"
              value={sf}
              onChange={e => { setScaleFactor(parseFloat(e.target.value)); setCustomScale('') }}
              className="w-full accent-blue-600 mb-2"
            />
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">Custom:</span>
              <input
                type="number"
                min="0.1"
                step="0.1"
                value={customScale}
                onChange={e => setCustomScale(e.target.value)}
                onBlur={() => {
                  const v = parseFloat(customScale)
                  if (!isNaN(v) && v > 0) setScaleFactor(v)
                }}
                placeholder="e.g. 2.5"
                className="w-20 border border-gray-200 rounded px-2 py-1 text-xs text-gray-900 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <span className="text-xs text-gray-400">×</span>
            </div>

            {showSaveScale && (
              <div className="mt-3 flex gap-2">
                <input
                  value={newScaleName}
                  onChange={e => setNewScaleName(e.target.value)}
                  placeholder="New recipe name…"
                  className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button onClick={saveScale} className="bg-blue-600 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-blue-700">Save</button>
                <button onClick={() => setShowSaveScale(false)} className="p-1.5 text-gray-400 hover:text-gray-600"><X size={14} /></button>
              </div>
            )}
          </div>}

          {/* ── INGREDIENT TABLE ── */}
          <div>
            <div className="text-sm font-semibold text-gray-700 mb-2">
              Ingredients {sf !== 1 && <span className="text-blue-500 font-normal text-xs ml-1">scaled ×{sf}</span>}
            </div>

            <div className="border border-gray-100 rounded-t-xl overflow-hidden">
              {/* Header */}
              <div className="grid grid-cols-12 gap-2 px-3 py-2 bg-gray-50 text-xs font-medium text-gray-500">
                <div className="col-span-4">Ingredient</div>
                <div className="col-span-1 text-center">%</div>
                <div className="col-span-2 text-right">Qty</div>
                <div className="col-span-2">Unit</div>
                <div className="col-span-2 text-right">Line cost</div>
                <div className="col-span-1" />
              </div>

              {recipe.ingredients.length === 0 && (
                <div className="text-center py-6 text-gray-400 text-sm">No ingredients yet</div>
              )}

              {recipe.ingredients.map((ing, idx) => (
                <IngredientRow
                  key={ing.id}
                  ing={ing}
                  scaleFactor={sf}
                  canMoveUp={idx > 0}
                  canMoveDown={idx < recipe.ingredients.length - 1}
                  onUpdate={data => updateIngredient(ing.id, data)}
                  onDelete={() => deleteIngredient(ing.id)}
                  onMoveUp={() => {
                    const prev = recipe.ingredients[idx - 1]
                    updateIngredient(ing.id, { sortOrder: prev.sortOrder })
                    updateIngredient(prev.id, { sortOrder: ing.sortOrder })
                  }}
                  onMoveDown={() => {
                    const next = recipe.ingredients[idx + 1]
                    updateIngredient(ing.id, { sortOrder: next.sortOrder })
                    updateIngredient(next.id, { sortOrder: ing.sortOrder })
                  }}
                />
              ))}

            </div>

            {/* Add ingredient search — outside overflow:hidden so dropdown isn't clipped */}
            <div
              className="relative border border-gray-100 border-t-0 rounded-b-xl px-3 py-2 bg-white"
              ref={searchRef}
            >
              <div className="flex items-center gap-2">
                <Search size={14} className="text-gray-400 shrink-0" />
                <input
                  value={searchQ}
                  onChange={e => {
                    setSearchQ(e.target.value)
                    clearTimeout(searchTimer.current)
                    searchTimer.current = setTimeout(() => {
                      doSearch(e.target.value)
                      setShowSearch(true)
                    }, 250)
                  }}
                  onFocus={() => { if (searchResults.length > 0) setShowSearch(true) }}
                  placeholder="+ Add ingredient — search inventory or recipes…"
                  className="flex-1 text-sm text-gray-700 placeholder-gray-400 outline-none bg-transparent py-1"
                />
              </div>
              {showSearch && searchResults.length > 0 && (
                <div className="absolute left-0 right-0 top-full mt-1 bg-white border border-gray-200 rounded-xl shadow-xl z-50 max-h-64 overflow-y-auto">
                  {searchResults.map(item => (
                    <button
                      key={`${item.type}-${item.id}`}
                      onClick={() => addIngredient(item)}
                      className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-gray-50 text-left text-sm"
                    >
                      {item.type === 'recipe'
                        ? <ChefHat size={13} className="text-emerald-600 shrink-0" />
                        : <Package size={13} className="text-blue-500 shrink-0" />
                      }
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

          {/* ── COST SUMMARY ── */}
          <div className="bg-gray-50 rounded-xl p-4 space-y-2">
            {!isMenu ? (
              <>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">Total recipe cost</span>
                  <span className="font-bold text-gray-900">
                    {formatCurrency(scaledTotal)}
                    {sf !== 1 && <span className="text-xs text-blue-500 ml-1">at ×{sf}</span>}
                  </span>
                </div>
                <div className="flex justify-between text-sm items-center">
                  <span className="text-gray-600">Base Cost</span>
                  <span className="font-semibold text-gray-800">
                    {formatUnitPrice(baseCostPerUnit)}
                    <span className="text-gray-400 text-xs ml-0.5">/{recipe.yieldUnit}</span>
                  </span>
                </div>
              </>
            ) : (
              <>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">Base Cost</span>
                  <span className="font-bold text-gray-900">{formatCurrency(recipe.totalCost)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">Menu price</span>
                  <span className="font-semibold text-gray-800">
                    {recipe.menuPrice !== null ? formatCurrency(recipe.menuPrice) : '—'}
                  </span>
                </div>
                <div className="flex justify-between text-sm items-center">
                  <span className="text-gray-600">Food cost %</span>
                  <span className={`font-bold text-base ${foodCostClass(menuFoodCostPct)}`}>
                    {menuFoodCostPct !== null ? `${menuFoodCostPct.toFixed(1)}%` : '—'}
                  </span>
                </div>
                {margin !== null && (
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">Margin / dish</span>
                    <span className={`font-semibold ${margin >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                      {formatCurrency(margin)}
                    </span>
                  </div>
                )}
                {recipe.menuPrice !== null && (
                  <div className="pt-1">
                    <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${foodCostClass(menuFoodCostPct).replace('text-', 'bg-')}`}
                        style={{ width: `${Math.min(100, (recipe.totalCost / recipe.menuPrice) * 100)}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-xs text-gray-400 mt-0.5">
                      <span>Cost</span><span>Price</span>
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
      </div>
    </div>
  )
}

// ─── INGREDIENT ROW ───────────────────────────────────────────────────────────
function IngredientRow({ ing, scaleFactor, canMoveUp, canMoveDown, onUpdate, onDelete, onMoveUp, onMoveDown }: {
  ing: IngredientWithCost
  scaleFactor: number
  canMoveUp: boolean
  canMoveDown: boolean
  onUpdate: (data: Record<string, unknown>) => void
  onDelete: () => void
  onMoveUp: () => void
  onMoveDown: () => void
}) {
  const [editingQty, setEditingQty] = useState(false)
  const [editingPct, setEditingPct] = useState(false)
  const [qty, setQty] = useState(String(ing.qtyBase))
  const [unit, setUnit] = useState(ing.unit)
  const [pct, setPct] = useState(ing.recipePercent !== null ? String(ing.recipePercent) : '')

  // Keep local state in sync if parent reloads
  useEffect(() => { setQty(String(ing.qtyBase)) }, [ing.qtyBase])
  useEffect(() => { setUnit(ing.unit) }, [ing.unit])
  useEffect(() => { setPct(ing.recipePercent !== null ? String(ing.recipePercent) : '') }, [ing.recipePercent])

  const saveQty = () => {
    setEditingQty(false)
    if (qty !== String(ing.qtyBase)) onUpdate({ qtyBase: qty, unit })
  }

  const saveUnit = (newUnit: string) => {
    setUnit(newUnit)
    onUpdate({ qtyBase: qty, unit: newUnit })
  }

  const savePct = () => {
    setEditingPct(false)
    const parsed = pct === '' ? null : parseFloat(pct)
    const current = ing.recipePercent
    if (parsed !== current) onUpdate({ recipePercent: parsed })
  }

  // All known unit labels for the datalist
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
        <span className="text-sm text-gray-800 truncate">{ing.ingredientName}</span>
      </div>

      {/* Recipe % — editable, doesn't change with scale */}
      <div className="col-span-1 text-center">
        {editingPct ? (
          <input
            type="number"
            value={pct}
            onChange={e => setPct(e.target.value)}
            onBlur={savePct}
            onKeyDown={e => e.key === 'Enter' && savePct()}
            placeholder="0"
            className="w-full text-center border border-blue-300 rounded px-0.5 py-0.5 text-xs text-gray-900 focus:outline-none"
            autoFocus
          />
        ) : (
          <span
            onClick={() => setEditingPct(true)}
            className={`text-xs cursor-pointer rounded px-0.5 ${
              ing.recipePercent !== null
                ? 'font-semibold text-indigo-600 hover:text-indigo-800'
                : 'text-gray-300 hover:text-gray-500'
            }`}
          >
            {ing.recipePercent !== null ? `${ing.recipePercent}%` : '—'}
          </span>
        )}
      </div>

      {/* Qty */}
      <div className="col-span-2 text-right">
        {editingQty ? (
          <input
            type="number"
            value={qty}
            onChange={e => setQty(e.target.value)}
            onBlur={saveQty}
            onKeyDown={e => e.key === 'Enter' && saveQty()}
            className="w-full text-right border border-blue-300 rounded px-1 py-0.5 text-sm text-gray-900 focus:outline-none"
            autoFocus
          />
        ) : (
          <span
            onClick={() => setEditingQty(true)}
            className="text-sm text-gray-800 cursor-pointer hover:text-blue-600"
          >
            {Number(displayQty.toFixed(3)).toString()}
          </span>
        )}
      </div>

      {/* Unit — grouped select */}
      <div className="col-span-2">
        <select
          value={unitInList ? unit : '__custom__'}
          onChange={e => {
            if (e.target.value !== '__custom__') saveUnit(e.target.value)
          }}
          className="w-full border border-gray-200 rounded px-1 py-0.5 text-xs text-gray-700 bg-white focus:outline-none focus:ring-1 focus:ring-blue-400"
        >
          {!unitInList && (
            <option value="__custom__">{unit}</option>
          )}
          {UOM_GROUPS.map(group => (
            <optgroup key={group.label} label={group.label}>
              {group.units.map(u => (
                <option key={u.label} value={u.label}>{u.label}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      {/* Line cost */}
      <div className="col-span-2 text-right text-sm font-medium text-gray-800">
        {formatCurrency(displayCost)}
      </div>

      {/* Actions */}
      <div className="col-span-1 flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
        <div className="flex flex-col">
          <button onClick={onMoveUp} disabled={!canMoveUp} className="text-gray-300 hover:text-gray-600 disabled:opacity-0 leading-none">
            <ChevronUp size={10} />
          </button>
          <button onClick={onMoveDown} disabled={!canMoveDown} className="text-gray-300 hover:text-gray-600 disabled:opacity-0 leading-none">
            <ChevronDown size={10} />
          </button>
        </div>
        <button onClick={onDelete} className="text-gray-300 hover:text-red-500 ml-0.5">
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  )
}

// ─── CATEGORY MANAGER MODAL ────────────────────────────────────────────────────
function CategoryManager({ type, categories, onClose, onUpdated }: {
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
    await fetch('/api/recipes/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName, type, color: newColor }),
    })
    setNewName('')
    setAdding(false)
    onUpdated()
  }

  const updateCat = async (id: string, data: Record<string, unknown>) => {
    await fetch(`/api/recipes/categories/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    onUpdated()
  }

  const deleteCat = async (id: string) => {
    const res = await fetch(`/api/recipes/categories/${id}`, { method: 'DELETE' })
    if (!res.ok) {
      const d = await res.json()
      alert(d.error)
      return
    }
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
                <div
                  className="w-6 h-6 rounded-full cursor-pointer border-2 border-white shadow"
                  style={{ background: cat.color ?? '#94a3b8' }}
                />
                <input
                  type="color"
                  value={cat.color ?? '#94a3b8'}
                  onChange={e => updateCat(cat.id, { color: e.target.value })}
                  className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                />
              </div>
              <InlineEdit
                value={cat.name}
                onSave={name => updateCat(cat.id, { name })}
                className="flex-1 text-sm text-gray-800"
              />
              <span className="text-xs text-gray-400">{cat._count?.recipes ?? 0} recipes</span>
              <button
                onClick={() => deleteCat(cat.id)}
                disabled={(cat._count?.recipes ?? 0) > 0}
                title={(cat._count?.recipes ?? 0) > 0 ? 'Move recipes first' : 'Delete'}
                className="text-gray-300 hover:text-red-500 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}

          {adding ? (
            <div className="flex items-center gap-2 mt-2">
              <div className="flex gap-1">
                {CATEGORY_PALETTE.map(c => (
                  <button
                    key={c}
                    onClick={() => setNewColor(c)}
                    className={`w-5 h-5 rounded-full border-2 ${newColor === c ? 'border-gray-600' : 'border-transparent'}`}
                    style={{ background: c }}
                  />
                ))}
              </div>
              <input
                autoFocus
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addCat(); if (e.key === 'Escape') setAdding(false) }}
                placeholder="Category name"
                className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button onClick={addCat} className="text-blue-600"><Check size={16} /></button>
              <button onClick={() => setAdding(false)} className="text-gray-400"><X size={14} /></button>
            </div>
          ) : (
            <button
              onClick={() => setAdding(true)}
              className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700 mt-2"
            >
              <Plus size={14} /> Add category
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── MAIN PAGE ────────────────────────────────────────────────────────────────
export default function RecipesPage() {
  const [view, setView] = useState<'book' | 'menu'>('book')
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [categories, setCategories] = useState<RecipeCategory[]>([])
  const [activeCatId, setActiveCatId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [showInactive, setShowInactive] = useState(false)
  const [selectedRecipeId, setSelectedRecipeId] = useState<string | null>(null)
  const [showNewForm, setShowNewForm] = useState(false)
  const [showCatManager, setShowCatManager] = useState(false)
  const [newForm, setNewForm] = useState({
    name: '', categoryId: '', baseYieldQty: '', yieldUnit: '', portionSize: '', portionUnit: '', menuPrice: '', notes: '',
  })

  const type = view === 'book' ? 'PREP' : 'MENU'

  const loadCategories = useCallback(async () => {
    const data = await fetch('/api/recipes/categories').then(r => r.json())
    setCategories(Array.isArray(data) ? data : [])
  }, [])

  const loadRecipes = useCallback(async () => {
    const params = new URLSearchParams({ type })
    if (!showInactive) params.set('isActive', 'true')
    if (search) params.set('search', search)
    const data = await fetch(`/api/recipes?${params}`).then(r => r.json())
    setRecipes(Array.isArray(data) ? data : [])
  }, [type, showInactive, search])

  // Filter client-side so category counts always reflect the full unfiltered set
  const displayRecipes = activeCatId ? recipes.filter(r => r.categoryId === activeCatId) : recipes

  useEffect(() => { loadCategories() }, [loadCategories])
  useEffect(() => { loadRecipes() }, [loadRecipes])

  const typeCats = categories.filter(c => c.type === type).sort((a, b) => a.sortOrder - b.sortOrder)

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newForm.name || !newForm.categoryId || !newForm.baseYieldQty || !newForm.yieldUnit) return

    const res = await fetch('/api/recipes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...newForm, type }),
    })
    const created = await res.json()
    setShowNewForm(false)
    setNewForm({ name: '', categoryId: '', baseYieldQty: '', yieldUnit: '', portionSize: '', portionUnit: '', menuPrice: '', notes: '' })
    await loadRecipes()
    await loadCategories()
    setSelectedRecipeId(created.id)
  }

  const handleToggle = async (id: string) => {
    await fetch(`/api/recipes/${id}/toggle`, { method: 'PATCH' })
    loadRecipes()
  }

  const handleDuplicate = async (recipe: Recipe) => {
    const res = await fetch(`/api/recipes/${recipe.id}/save-scale`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newName: `${recipe.name} (copy)`, factor: 1 }),
    })
    const dup = await res.json()
    await loadRecipes()
    await loadCategories()
    setSelectedRecipeId(dup.id)
  }

  // Active-color helpers
  const activePill = view === 'book'
    ? 'bg-emerald-600 text-white shadow-sm'
    : 'bg-blue-600 text-white shadow-sm'
  const inactivePill = 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50'

  return (
    <div className="flex flex-col gap-4">

      {/* ── TOP BAR: tabs + new button ── */}
      <div className="flex items-center gap-2">
        {/* View tabs */}
        <button
          onClick={() => { setView('book'); setActiveCatId(null); setSearch('') }}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all ${view === 'book' ? 'bg-emerald-600 text-white shadow-sm' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'}`}
        >
          <BookOpen size={15} /> Recipe Book
        </button>
        <button
          onClick={() => { setView('menu'); setActiveCatId(null); setSearch('') }}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all ${view === 'menu' ? 'bg-blue-600 text-white shadow-sm' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'}`}
        >
          <UtensilsCrossed size={15} /> Menu
        </button>

        <div className="flex-1" />

        {/* Search bar */}
        <div className="relative hidden md:block">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={`Search ${view === 'book' ? 'recipes' : 'dishes'}…`}
            className="w-52 pl-9 pr-4 py-2 text-sm border border-gray-200 rounded-xl bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent transition-all focus:w-64"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500">
              <X size={13} />
            </button>
          )}
        </div>

        <button
          onClick={() => setShowNewForm(true)}
          className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium text-white transition-colors ${view === 'book' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-blue-600 hover:bg-blue-700'}`}
        >
          <Plus size={15} />
          <span className="hidden sm:inline">New {view === 'book' ? 'Recipe' : 'Dish'}</span>
          <span className="sm:hidden">New</span>
        </button>
      </div>

      {/* ── MOBILE SEARCH ── */}
      <div className="md:hidden relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={`Search ${view === 'book' ? 'recipes' : 'dishes'}…`}
          className="w-full pl-9 pr-9 py-2.5 text-sm border border-gray-200 rounded-xl bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-400"
        />
        {search && (
          <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500">
            <X size={13} />
          </button>
        )}
      </div>

      {/* ── CATEGORY FILTER PILLS ── */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => setActiveCatId(null)}
          className={`px-3 py-1.5 rounded-xl text-sm font-medium transition-all ${activeCatId === null ? activePill : inactivePill}`}
        >
          All
          <span className={`ml-1.5 text-xs ${activeCatId === null ? 'opacity-70' : 'text-gray-400'}`}>
            {recipes.length}
          </span>
        </button>

        {typeCats.map(cat => {
          const count = recipes.filter(r => r.categoryId === cat.id).length
          const isActive = activeCatId === cat.id
          return (
            <button
              key={cat.id}
              onClick={() => setActiveCatId(isActive ? null : cat.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-medium transition-all ${isActive ? activePill : inactivePill}`}
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ background: isActive ? 'rgba(255,255,255,0.6)' : (cat.color ?? '#94a3b8') }}
              />
              {cat.name}
              <span className={`text-xs ${isActive ? 'opacity-70' : 'text-gray-400'}`}>{count}</span>
            </button>
          )
        })}
      </div>

      {/* ── SECONDARY TOOLBAR: smaller, clearly separated from filter pills ── */}
      <div className="flex items-center justify-between -mt-2">
        {/* Left: active filter label */}
        <p className="text-xs text-gray-400">
          {activeCatId
            ? <>Filtering by <span className="font-medium text-gray-600">{typeCats.find(c => c.id === activeCatId)?.name}</span> · {displayRecipes.length} {displayRecipes.length === 1 ? 'recipe' : 'recipes'}</>
            : <>{displayRecipes.length} {displayRecipes.length === 1 ? 'recipe' : 'recipes'} total</>
          }
        </p>

        {/* Right: utility controls — smaller and clearly secondary */}
        <div className="flex items-center gap-1">
          {/* Show inactive — subtle checkbox-style */}
          <button
            onClick={() => setShowInactive(s => !s)}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
              showInactive
                ? 'bg-gray-100 text-gray-700 border border-gray-300'
                : 'text-gray-400 hover:text-gray-600 hover:bg-gray-50 border border-transparent'
            }`}
          >
            <span className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-colors ${showInactive ? 'bg-gray-600 border-gray-600' : 'border-gray-300'}`}>
              {showInactive && <span className="text-white" style={{ fontSize: 9, lineHeight: 1 }}>✓</span>}
            </span>
            Inactive
          </button>

          <div className="w-px h-4 bg-gray-200 mx-0.5" />

          {/* Edit Categories — small icon+text, clearly a settings action */}
          <button
            onClick={() => setShowCatManager(true)}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs text-gray-400 hover:text-gray-600 hover:bg-gray-50 border border-transparent hover:border-gray-200 transition-all"
          >
            <Pencil size={10} />
            <span className="hidden sm:inline">Categories</span>
          </button>
        </div>
      </div>

      {/* ── MAIN CONTENT ── */}
      <div className="flex-1 pb-20 md:pb-4">

          {/* New recipe form */}
          {showNewForm && (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 mb-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-gray-800">
                  New {view === 'book' ? 'Recipe' : 'Menu Dish'}
                </h3>
                <button onClick={() => setShowNewForm(false)} className="text-gray-400 hover:text-gray-600"><X size={16} /></button>
              </div>
              <form onSubmit={handleCreate} className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2">
                    <label className="text-xs font-medium text-gray-600 block mb-1">Name *</label>
                    <input
                      required
                      value={newForm.name}
                      onChange={e => setNewForm(f => ({ ...f, name: e.target.value }))}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-gray-600 block mb-1">Category *</label>
                    <select
                      required
                      value={newForm.categoryId}
                      onChange={e => setNewForm(f => ({ ...f, categoryId: e.target.value }))}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">Select…</option>
                      {typeCats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-gray-600 block mb-1">Base Yield *</label>
                    <div className="flex gap-1">
                      <input
                        required
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="50"
                        value={newForm.baseYieldQty}
                        onChange={e => setNewForm(f => ({ ...f, baseYieldQty: e.target.value }))}
                        className="flex-1 border border-gray-200 rounded-lg px-2 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                      <input
                        required
                        type="text"
                        placeholder="each"
                        value={newForm.yieldUnit}
                        onChange={e => setNewForm(f => ({ ...f, yieldUnit: e.target.value }))}
                        className="w-16 border border-gray-200 rounded-lg px-2 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  </div>
                  {view === 'menu' && (
                    <div>
                      <label className="text-xs font-medium text-gray-600 block mb-1">Menu Price</label>
                      <div className="relative">
                        <span className="absolute left-3 top-2 text-gray-400 text-sm">$</span>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="0.00"
                          value={newForm.menuPrice}
                          onChange={e => setNewForm(f => ({ ...f, menuPrice: e.target.value }))}
                          className="w-full border border-gray-200 rounded-lg pl-7 pr-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                    </div>
                  )}
                </div>
                {view === 'book' && (
                  <div className="flex items-start gap-2 text-xs text-emerald-600 bg-emerald-50 p-2.5 rounded-lg">
                    <Link2 size={12} className="mt-0.5 shrink-0" />
                    <span>This recipe will automatically create a <strong>PREPD</strong> inventory item so it can be counted in stock takes and COGS.</span>
                  </div>
                )}
                <div className="flex gap-2">
                  <button type="submit" className="flex-1 bg-gray-900 text-white py-2 rounded-lg text-sm font-medium hover:bg-gray-800">
                    Create
                  </button>
                  <button type="button" onClick={() => setShowNewForm(false)} className="px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50">
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* Recipe grid */}
          {displayRecipes.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              {view === 'book' ? <BookOpen size={40} className="text-gray-200 mb-3" /> : <UtensilsCrossed size={40} className="text-gray-200 mb-3" />}
              <p className="text-gray-400 text-sm">
                {search ? `No ${view === 'book' ? 'recipes' : 'dishes'} match "${search}"` : `No ${view === 'book' ? 'recipes' : 'dishes'} yet`}
              </p>
              {!search && (
                <button onClick={() => setShowNewForm(true)} className="mt-3 text-sm text-blue-600 hover:text-blue-700">
                  Create your first {view === 'book' ? 'recipe' : 'dish'} →
                </button>
              )}
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-gray-100 overflow-hidden divide-y divide-gray-50">
              {/* List header */}
              <div className="flex items-center gap-3 px-4 py-2 bg-gray-50 text-xs font-medium text-gray-400">
                <span className="w-2.5 shrink-0" />
                <span className="flex-1">Name</span>
                {view === 'book'
                  ? <span className="hidden sm:block pr-20">Total cost · Base cost/unit</span>
                  : <span className="hidden sm:block pr-20">Base cost · Price · Food cost %</span>
                }
              </div>
              {displayRecipes.map(recipe => (
                <RecipeCard
                  key={recipe.id}
                  recipe={recipe}
                  onOpen={() => setSelectedRecipeId(recipe.id)}
                  onToggle={() => handleToggle(recipe.id)}
                  onDuplicate={() => handleDuplicate(recipe)}
                />
              ))}
            </div>
          )}
        </div>

      {/* Recipe Detail Panel */}
      {selectedRecipeId && (
        <RecipePanel
          recipeId={selectedRecipeId}
          categories={categories}
          onClose={() => setSelectedRecipeId(null)}
          onUpdated={() => { loadRecipes(); loadCategories() }}
        />
      )}

      {/* Category Manager Modal */}
      {showCatManager && (
        <CategoryManager
          type={type}
          categories={categories}
          onClose={() => setShowCatManager(false)}
          onUpdated={loadCategories}
        />
      )}
    </div>
  )
}
