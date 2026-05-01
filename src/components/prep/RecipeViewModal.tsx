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
          <button onClick={onClose} className="shrink-0 p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg">
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
