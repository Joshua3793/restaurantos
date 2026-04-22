'use client'
import { useEffect, useState, useCallback, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { Plus, X, BookOpen, Search, Pencil, Link2 } from 'lucide-react'
import { RecipeCard, RecipePanel, CategoryManager } from '@/components/recipes/shared'
import type { Recipe, RecipeCategory } from '@/components/recipes/shared'

export default function RecipesPage() {
  return (
    <Suspense fallback={null}>
      <RecipesInner />
    </Suspense>
  )
}

function RecipesInner() {
  const searchParams = useSearchParams()
  const [recipes, setRecipes]               = useState<Recipe[]>([])
  const [categories, setCategories]         = useState<RecipeCategory[]>([])
  const [activeCatId, setActiveCatId]       = useState<string | null>(null)
  const [search, setSearch]                 = useState('')
  const [showInactive, setShowInactive]     = useState(false)
  const [selectedRecipeId, setSelectedRecipeId] = useState<string | null>(null)
  const [showNewForm, setShowNewForm]       = useState(false)
  const [showCatManager, setShowCatManager] = useState(false)
  const [newForm, setNewForm]               = useState({
    name: '', categoryId: '', baseYieldQty: '', yieldUnit: '',
    portionSize: '', portionUnit: '', menuPrice: '', notes: '',
  })

  const type = 'PREP'

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
  }, [showInactive, search])

  const displayRecipes = activeCatId ? recipes.filter(r => r.categoryId === activeCatId) : recipes

  useEffect(() => { loadCategories() }, [loadCategories])
  useEffect(() => { loadRecipes() }, [loadRecipes])
  useEffect(() => {
    const itemId = searchParams.get('item')
    if (itemId) setSelectedRecipeId(itemId)
  }, [searchParams])

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
    await loadRecipes(); await loadCategories()
    setSelectedRecipeId(created.id)
  }

  const handleToggle = async (id: string) => {
    await fetch(`/api/recipes/${id}/toggle`, { method: 'PATCH' })
    loadRecipes()
  }

  const handleDuplicate = async (recipe: Recipe) => {
    const res = await fetch(`/api/recipes/${recipe.id}/save-scale`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newName: `${recipe.name} (copy)`, factor: 1 }),
    })
    const dup = await res.json()
    await loadRecipes(); await loadCategories()
    setSelectedRecipeId(dup.id)
  }

  const handleDelete = async (id: string) => {
    await fetch(`/api/recipes/${id}`, { method: 'DELETE' })
    if (selectedRecipeId === id) setSelectedRecipeId(null)
    await loadRecipes()
    await loadCategories()
  }

  const activePill  = 'bg-emerald-600 text-white shadow-sm'
  const inactivePill = 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50'

  return (
    <div className="flex flex-col gap-4">

      {/* ── TOP BAR ── */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-2 mr-auto">
          <BookOpen size={18} className="text-emerald-600" />
          <h1 className="text-lg font-bold text-gray-900">Recipe Book</h1>
        </div>
        <div className="relative hidden md:block">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search recipes…"
            className="w-52 pl-9 pr-4 py-2 text-sm border border-gray-200 rounded-xl bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:border-transparent transition-all focus:w-64" />
          {search && <button onClick={() => setSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500"><X size={13} /></button>}
        </div>
        <button onClick={() => setShowNewForm(true)}
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 transition-colors">
          <Plus size={15} />
          <span className="hidden sm:inline">New Recipe</span>
          <span className="sm:hidden">New</span>
        </button>
      </div>

      {/* ── MOBILE SEARCH ── */}
      <div className="md:hidden relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search recipes…"
          className="w-full pl-9 pr-9 py-2.5 text-sm border border-gray-200 rounded-xl bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-emerald-400" />
        {search && <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500"><X size={13} /></button>}
      </div>

      {/* ── CATEGORY FILTER PILLS ── */}
      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={() => setActiveCatId(null)}
          className={`px-3 py-1.5 rounded-xl text-sm font-medium transition-all ${activeCatId === null ? activePill : inactivePill}`}>
          All <span className={`ml-1.5 text-xs ${activeCatId === null ? 'opacity-70' : 'text-gray-400'}`}>{recipes.length}</span>
        </button>
        {typeCats.map(cat => {
          const count = recipes.filter(r => r.categoryId === cat.id).length
          const isActive = activeCatId === cat.id
          return (
            <button key={cat.id} onClick={() => setActiveCatId(isActive ? null : cat.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-medium transition-all ${isActive ? activePill : inactivePill}`}>
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: isActive ? 'rgba(255,255,255,0.6)' : (cat.color ?? '#94a3b8') }} />
              {cat.name}
              <span className={`text-xs ${isActive ? 'opacity-70' : 'text-gray-400'}`}>{count}</span>
            </button>
          )
        })}
      </div>

      {/* ── SECONDARY TOOLBAR ── */}
      <div className="flex items-center justify-between -mt-2">
        <p className="text-xs text-gray-400">
          {activeCatId
            ? <>Filtering by <span className="font-medium text-gray-600">{typeCats.find(c => c.id === activeCatId)?.name}</span> · {displayRecipes.length} {displayRecipes.length === 1 ? 'recipe' : 'recipes'}</>
            : <>{displayRecipes.length} {displayRecipes.length === 1 ? 'recipe' : 'recipes'} total</>}
        </p>
        <div className="flex items-center gap-1">
          <button onClick={() => setShowInactive(s => !s)}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${showInactive ? 'bg-gray-100 text-gray-700 border border-gray-300' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-50 border border-transparent'}`}>
            <span className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-colors ${showInactive ? 'bg-gray-600 border-gray-600' : 'border-gray-300'}`}>
              {showInactive && <span className="text-white" style={{ fontSize: 9, lineHeight: 1 }}>✓</span>}
            </span>
            Inactive
          </button>
          <div className="w-px h-4 bg-gray-200 mx-0.5" />
          <button onClick={() => setShowCatManager(true)}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs text-gray-400 hover:text-gray-600 hover:bg-gray-50 border border-transparent hover:border-gray-200 transition-all">
            <Pencil size={10} />
            <span className="hidden sm:inline">Categories</span>
          </button>
        </div>
      </div>

      {/* ── MAIN CONTENT ── */}
      <div className="flex-1 pb-20 md:pb-4">
        {showNewForm && (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 mb-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-gray-800">New Recipe</h3>
              <button onClick={() => setShowNewForm(false)} className="text-gray-400 hover:text-gray-600"><X size={16} /></button>
            </div>
            <form onSubmit={handleCreate} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="text-xs font-medium text-gray-600 block mb-1">Name *</label>
                  <input required value={newForm.name} onChange={e => setNewForm(f => ({ ...f, name: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-emerald-500" />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">Category *</label>
                  <select required value={newForm.categoryId} onChange={e => setNewForm(f => ({ ...f, categoryId: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-emerald-500">
                    <option value="">Select…</option>
                    {typeCats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">
                    Base Yield *
                    <span className="ml-1 font-normal text-gray-400">(total quantity produced)</span>
                  </label>
                  <div className="flex gap-1">
                    <input required type="number" min="0" step="0.01" placeholder="500" value={newForm.baseYieldQty}
                      onChange={e => setNewForm(f => ({ ...f, baseYieldQty: e.target.value }))}
                      className="flex-1 border border-gray-200 rounded-lg px-2 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-emerald-500" />
                    <select required value={newForm.yieldUnit}
                      onChange={e => setNewForm(f => ({ ...f, yieldUnit: e.target.value }))}
                      className="w-28 border border-gray-200 rounded-lg px-2 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white">
                      <option value="">Unit…</option>
                      <option value="g">g (grams)</option>
                      <option value="kg">kg</option>
                      <option value="ml">ml</option>
                      <option value="L">L (litres)</option>
                      <option value="each">each</option>
                      <option value="oz">oz</option>
                      <option value="lb">lb</option>
                      <option value="portion">portion</option>
                      <option value="portions">portions</option>
                      <option value="batch">batch</option>
                      <option value="cup">cup</option>
                      <option value="tray">tray</option>
                    </select>
                  </div>
                </div>
              </div>
              <div className="flex items-start gap-2 text-xs text-emerald-600 bg-emerald-50 p-2.5 rounded-lg">
                <Link2 size={12} className="mt-0.5 shrink-0" />
                <span>This recipe will automatically create a <strong>PREPD</strong> inventory item so it can be counted in stock takes and COGS.</span>
              </div>
              <div className="flex gap-2">
                <button type="submit" className="flex-1 bg-gray-900 text-white py-2 rounded-lg text-sm font-medium hover:bg-gray-800">Create</button>
                <button type="button" onClick={() => setShowNewForm(false)} className="px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50">Cancel</button>
              </div>
            </form>
          </div>
        )}

        {displayRecipes.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <BookOpen size={40} className="text-gray-200 mb-3" />
            <p className="text-gray-400 text-sm">{search ? `No recipes match "${search}"` : 'No recipes yet'}</p>
            {!search && (
              <button onClick={() => setShowNewForm(true)} className="mt-3 text-sm text-emerald-600 hover:text-emerald-700">
                Create your first recipe →
              </button>
            )}
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-100 overflow-hidden divide-y divide-gray-50">
            <div className="flex items-center gap-3 px-4 py-2 bg-gray-50 text-xs font-medium text-gray-400">
              <span className="w-2.5 shrink-0" />
              <span className="flex-1">Name</span>
              <span className="hidden sm:block pr-20">Total cost · Base cost/unit</span>
            </div>
            {displayRecipes.map(recipe => (
              <RecipeCard key={recipe.id} recipe={recipe}
                onOpen={() => setSelectedRecipeId(recipe.id)}
                onToggle={() => handleToggle(recipe.id)}
                onDuplicate={() => handleDuplicate(recipe)}
                onDelete={() => handleDelete(recipe.id)} />
            ))}
          </div>
        )}
      </div>

      {selectedRecipeId && (
        <RecipePanel recipeId={selectedRecipeId} categories={categories}
          onClose={() => setSelectedRecipeId(null)}
          onUpdated={() => { loadRecipes(); loadCategories() }} />
      )}

      {showCatManager && (
        <CategoryManager type={type} categories={categories}
          onClose={() => setShowCatManager(false)}
          onUpdated={loadCategories} />
      )}
    </div>
  )
}
