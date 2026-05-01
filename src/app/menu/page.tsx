'use client'
import { useEffect, useState, useCallback, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { Plus, X, UtensilsCrossed, Search, Pencil } from 'lucide-react'
import { RecipeCard, RecipePanel, CategoryManager } from '@/components/recipes/shared'
import type { Recipe, RecipeCategory } from '@/components/recipes/shared'
import { useRc } from '@/contexts/RevenueCenterContext'
import { useDrawer } from '@/contexts/DrawerContext'
import { rcHex } from '@/lib/rc-colors'

export default function MenuPage() {
  return (
    <Suspense fallback={null}>
      <MenuPageInner />
    </Suspense>
  )
}

function MenuPageInner() {
  const searchParams = useSearchParams()
  const { revenueCenters, activeRcId, activeRc } = useRc()
  const { setDrawerOpen } = useDrawer()
  const [recipes, setRecipes]             = useState<Recipe[]>([])
  const [categories, setCategories]       = useState<RecipeCategory[]>([])
  const [activeCatId, setActiveCatId]     = useState<string | null>(null)
  const [search, setSearch]               = useState('')
  const [showInactive, setShowInactive]   = useState(false)
  const [selectedRecipeId, setSelectedRecipeId] = useState<string | null>(null)
  const [showNewForm, setShowNewForm]     = useState(false)
  const [showCatManager, setShowCatManager] = useState(false)
  const [newForm, setNewForm]             = useState({
    name: '', categoryId: '', baseYieldQty: '', yieldUnit: '',
    portionSize: '', portionUnit: '', menuPrice: '', notes: '',
    revenueCenterId: '',
  })

  // Pre-fill RC in new form when active RC changes
  useEffect(() => {
    if (activeRcId) setNewForm(f => ({ ...f, revenueCenterId: activeRcId }))
  }, [activeRcId])

  const type = 'MENU'

  const loadCategories = useCallback(async () => {
    const p = new URLSearchParams({ type })
    if (activeRcId) p.set('rcId', activeRcId)
    const data = await fetch(`/api/recipes/categories?${p}`).then(r => r.json())
    setCategories(Array.isArray(data) ? data : [])
  }, [activeRcId])

  const loadRecipes = useCallback(async () => {
    const params = new URLSearchParams({ type })
    if (!showInactive) params.set('isActive', 'true')
    if (search) params.set('search', search)
    // Filter by active RC (skip filter when "All Revenue Centers" is selected)
    if (activeRcId) params.set('rcId', activeRcId)
    const data = await fetch(`/api/recipes?${params}`).then(r => r.json())
    setRecipes(Array.isArray(data) ? data : [])
    // Deep-link: ?item=id selects that recipe
    const itemId = searchParams.get('item')
    if (itemId) setSelectedRecipeId(itemId)
  }, [showInactive, search, searchParams, activeRcId])

  const displayRecipes = activeCatId ? recipes.filter(r => r.categoryId === activeCatId) : recipes

  useEffect(() => { loadCategories() }, [loadCategories])
  useEffect(() => { loadRecipes() }, [loadRecipes])

  useEffect(() => {
    setDrawerOpen(selectedRecipeId !== null)
    return () => setDrawerOpen(false)
  }, [selectedRecipeId, setDrawerOpen])

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
    setNewForm({ name: '', categoryId: '', baseYieldQty: '', yieldUnit: '', portionSize: '', portionUnit: '', menuPrice: '', notes: '', revenueCenterId: activeRcId || '' })
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

  const handleDelete = async (id: string) => {
    await fetch(`/api/recipes/${id}`, { method: 'DELETE' })
    if (selectedRecipeId === id) setSelectedRecipeId(null)
    await loadRecipes()
    await loadCategories()
  }

  const activePill  = 'bg-gold text-white shadow-sm'
  const inactivePill = 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50'

  return (
    <div className="flex flex-col gap-4">

      {/* ── TOP BAR ── */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-2 mr-auto">
          <UtensilsCrossed size={18} className="text-gold" />
          <h1 className="text-lg font-bold text-gray-900">Menu</h1>
        </div>

        {/* Desktop search */}
        <div className="relative hidden md:block">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search dishes…"
            className="w-52 pl-9 pr-4 py-2 text-sm border border-gray-200 rounded-xl bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gold focus:border-transparent transition-all focus:w-64"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500">
              <X size={13} />
            </button>
          )}
        </div>

        <button
          onClick={() => setShowNewForm(true)}
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium text-white bg-gold hover:bg-[#a88930] transition-colors"
        >
          <Plus size={15} />
          <span className="hidden sm:inline">New Dish</span>
          <span className="sm:hidden">New</span>
        </button>
      </div>

      {/* ── MOBILE SEARCH ── */}
      <div className="md:hidden relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search dishes…"
          className="w-full pl-9 pr-9 py-2.5 text-sm border border-gray-200 rounded-xl bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gold"
        />
        {search && (
          <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500">
            <X size={13} />
          </button>
        )}
      </div>

      {/* ── CATEGORY FILTER PILLS + edit button ── */}
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

        <button
          onClick={() => setShowCatManager(true)}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs text-gray-400 hover:text-gray-600 hover:bg-gray-50 border border-gray-200 hover:border-gray-300 transition-all ml-auto"
        >
          <Pencil size={10} />
          <span className="hidden sm:inline">Edit</span>
        </button>
      </div>

      {/* ── SECONDARY TOOLBAR ── */}
      <div className="flex items-center justify-between -mt-2">
        <p className="text-xs text-gray-400">
          {activeCatId
            ? <>Filtering by <span className="font-medium text-gray-600">{typeCats.find(c => c.id === activeCatId)?.name}</span> · {displayRecipes.length} {displayRecipes.length === 1 ? 'dish' : 'dishes'}</>
            : <>{displayRecipes.length} {displayRecipes.length === 1 ? 'dish' : 'dishes'} total</>
          }
        </p>
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
      </div>

      {/* ── MAIN CONTENT ── */}
      <div className="flex-1 pb-20 md:pb-4">

        {/* New dish form */}
        {showNewForm && (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 mb-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-gray-800">New Menu Dish</h3>
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
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">Category *</label>
                  <select
                    required
                    value={newForm.categoryId}
                    onChange={e => setNewForm(f => ({ ...f, categoryId: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold"
                  >
                    <option value="">Select…</option>
                    {typeCats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">Revenue Center *</label>
                  <select
                    required
                    value={newForm.revenueCenterId}
                    onChange={e => setNewForm(f => ({ ...f, revenueCenterId: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold bg-white"
                  >
                    <option value="">Select…</option>
                    {revenueCenters.filter(rc => rc.isActive).map(rc => (
                      <option key={rc.id} value={rc.id}>{rc.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">
                    Portions per batch *
                    <span className="ml-1 font-normal text-gray-400">(usually 1)</span>
                  </label>
                  <div className="flex gap-1">
                    <input
                      required
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="1"
                      value={newForm.baseYieldQty}
                      onChange={e => setNewForm(f => ({ ...f, baseYieldQty: e.target.value }))}
                      className="flex-1 border border-gray-200 rounded-lg px-2 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold"
                    />
                    <select
                      required
                      value={newForm.yieldUnit}
                      onChange={e => setNewForm(f => ({ ...f, yieldUnit: e.target.value }))}
                      className="w-28 border border-gray-200 rounded-lg px-2 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold bg-white"
                    >
                      <option value="">Unit…</option>
                      <option value="portion">portion</option>
                      <option value="portions">portions</option>
                      <option value="serving">serving</option>
                      <option value="servings">servings</option>
                      <option value="each">each</option>
                      <option value="piece">piece</option>
                      <option value="pieces">pieces</option>
                      <option value="plate">plate</option>
                      <option value="bowl">bowl</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">Menu Price ($)</label>
                  <div className="relative">
                    <span className="absolute left-3 top-2 text-gray-400 text-sm">$</span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="0.00"
                      value={newForm.menuPrice}
                      onChange={e => setNewForm(f => ({ ...f, menuPrice: e.target.value }))}
                      className="w-full border border-gray-200 rounded-lg pl-7 pr-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold"
                    />
                  </div>
                </div>
              </div>
              <div className="flex gap-2">
                <button type="submit" className="flex-1 bg-gold text-white py-2 rounded-lg text-sm font-medium hover:bg-[#a88930]">
                  Create
                </button>
                <button type="button" onClick={() => setShowNewForm(false)} className="px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50">
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Dish list */}
        {displayRecipes.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <UtensilsCrossed size={40} className="text-gray-200 mb-3" />
            <p className="text-gray-400 text-sm">
              {search ? `No dishes match "${search}"` : 'No dishes yet'}
            </p>
            {!search && (
              <button onClick={() => setShowNewForm(true)} className="mt-3 text-sm text-gold hover:text-gold">
                Create your first dish →
              </button>
            )}
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-100 overflow-hidden divide-y divide-gray-50">
            <div className="flex items-center gap-3 px-4 py-2 bg-gray-50 text-xs font-medium text-gray-400">
              <span className="w-2.5 shrink-0" />
              <span className="flex-1">Name</span>
              <span className="hidden sm:block pr-20">Base cost · Price · Food cost %</span>
            </div>
            {displayRecipes.map(recipe => (
              <RecipeCard
                key={recipe.id}
                recipe={recipe}
                onOpen={() => setSelectedRecipeId(recipe.id)}
                onToggle={() => handleToggle(recipe.id)}
                onDuplicate={() => handleDuplicate(recipe)}
                onDelete={() => handleDelete(recipe.id)}
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
          revenueCenterId={activeRcId}
        />
      )}
    </div>
  )
}
