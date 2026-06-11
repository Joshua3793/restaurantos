'use client'
import { useEffect, useState, useCallback, useRef, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { X, UtensilsCrossed, Search, Check, Download, SlidersHorizontal } from 'lucide-react'
import { RecipeCard, RecipePanel, CategoryManager, BulkActionBar } from '@/components/recipes/shared'
import type { Recipe, RecipeCategory } from '@/components/recipes/shared'
import { useRc } from '@/contexts/RevenueCenterContext'
import { useDrawer } from '@/contexts/DrawerContext'

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
  const [searchInput, setSearchInput]     = useState('')
  const [search, setSearch]               = useState('')
  const searchDebounce = useRef<ReturnType<typeof setTimeout>>()
  const [showInactive, setShowInactive]   = useState(false)
  const [sortMode, setSortMode]           = useState<'az' | 'cost' | 'foodcost'>('az')
  const [viewMode, setViewMode]           = useState<'list' | 'grid'>('list')
  const [selectedRecipeId, setSelectedRecipeId] = useState<string | null>(null)
  const [showNewForm, setShowNewForm]     = useState(false)
  const [showCatManager, setShowCatManager] = useState(false)
  const [selectedIds, setSelectedIds]     = useState<Set<string>>(new Set())
  const [bulkConfirm, setBulkConfirm]     = useState<'deactivate' | 'delete' | null>(null)
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

  const baseRecipes = activeCatId ? recipes.filter(r => r.categoryId === activeCatId) : recipes
  const displayRecipes = [...baseRecipes].sort((a, b) => {
    if (sortMode === 'cost')     return b.totalCost - a.totalCost
    if (sortMode === 'foodcost') {
      const fa = a.menuPrice ? (a.totalCost / a.menuPrice) * 100 : -1
      const fb = b.menuPrice ? (b.totalCost / b.menuPrice) * 100 : -1
      return fb - fa
    }
    return a.name.localeCompare(b.name)
  })

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

  const handleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const allVisibleSelected = displayRecipes.length > 0 && displayRecipes.every(r => selectedIds.has(r.id))

  const handleSelectAll = () => {
    if (allVisibleSelected) setSelectedIds(new Set())
    else setSelectedIds(new Set(displayRecipes.map(r => r.id)))
  }

  const handleBulkDeactivate = async () => {
    const toDeactivate = displayRecipes.filter(r => selectedIds.has(r.id) && r.isActive)
    await Promise.all(toDeactivate.map(r =>
      fetch(`/api/recipes/${r.id}/toggle`, { method: 'PATCH' })
    ))
    setSelectedIds(new Set())
    setBulkConfirm(null)
    await loadRecipes()
  }

  const handleBulkDelete = async () => {
    await Promise.all([...selectedIds].map(id =>
      fetch(`/api/recipes/${id}`, { method: 'DELETE' })
    ))
    if (selectedIds.has(selectedRecipeId ?? '')) setSelectedRecipeId(null)
    setSelectedIds(new Set())
    setBulkConfirm(null)
    await loadRecipes()
    await loadCategories()
  }

  const activePill  = 'bg-ink text-paper border border-ink'
  const inactivePill = 'bg-paper border border-line text-ink-2 hover:border-ink-3'

  return (
    <div className="flex flex-col gap-4">

      {/* ── SUB-NAV TABS ── */}
      <nav className="flex items-stretch border-b border-line -mx-4 sm:-mx-6 md:-mx-8 px-4 sm:px-6 md:px-8 h-12">
        <button className="flex items-center gap-2 px-4 text-[13.5px] font-medium text-ink border-b-2 border-gold tracking-[-0.005em]">
          <UtensilsCrossed size={14} />
          Menu
        </button>
        <button
          onClick={() => setShowCatManager(true)}
          className="flex items-center gap-2 px-4 text-[13.5px] font-medium text-ink-3 hover:text-ink border-b-2 border-transparent transition-colors tracking-[-0.005em]"
        >
          <SlidersHorizontal size={13} />
          Categories
        </button>
        <div className="ml-auto flex items-center">
          <span className="font-mono text-[10.5px] text-ink-3 bg-bg-2 border border-line rounded-[6px] px-2 py-0.5">⌘ K</span>
        </div>
      </nav>

      {/* ── HEADER ── */}
      <div className="flex items-end justify-between gap-6 mb-1">
        <div>
          <div className="font-mono text-[10.5px] text-ink-3 tracking-[0.04em] mb-1.5 flex items-center gap-2">
            <UtensilsCrossed size={12} />
            LIBRARY / MENU
          </div>
          <h1 className="text-[28px] sm:text-[32px] font-semibold text-ink tracking-[-0.04em] leading-none">Menu</h1>
          <p className="text-[13px] text-ink-3 mt-2">
            <span className="font-medium text-ink">{recipes.length} {recipes.length === 1 ? 'dish' : 'dishes'}</span>
            {activeRc && <> · <span className="font-mono text-[11px]">{activeRc.name}</span></>}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            className="hidden sm:flex items-center gap-1.5 px-3.5 py-2 rounded-[9px] text-[13px] font-medium text-ink-2 bg-paper border border-line hover:border-ink-3 transition-colors"
            title="Export menu (coming soon)"
          >
            <Download size={13} className="text-ink-3" />
            Export
          </button>
          <button
            onClick={() => setShowCatManager(true)}
            className="hidden sm:flex items-center gap-1.5 px-3.5 py-2 rounded-[9px] text-[13px] font-medium text-ink-2 bg-paper border border-line hover:border-ink-3 transition-colors"
          >
            <SlidersHorizontal size={13} className="text-ink-3" />
            Edit categories
          </button>
          <button
            onClick={() => setShowNewForm(true)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-[9px] text-[13px] font-medium text-paper bg-ink hover:bg-ink-2 transition-colors"
          >
            <span className="text-gold font-semibold">+</span>
            <span className="hidden sm:inline">New dish</span>
            <span className="sm:hidden">New</span>
          </button>
        </div>
      </div>

      {/* ── TOOLBAR: search + sort + view ── */}
      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto] gap-2 items-center">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" />
          <input
            value={searchInput}
            onChange={e => {
              setSearchInput(e.target.value)
              clearTimeout(searchDebounce.current)
              searchDebounce.current = setTimeout(() => setSearch(e.target.value), 350)
            }}
            placeholder="Search dishes, ingredients, categories…"
            className="w-full pl-9 pr-9 py-2.5 text-[13px] border border-line rounded-[9px] bg-paper text-ink placeholder:text-ink-3 focus:outline-none focus:border-ink-3 transition-colors"
          />
          {searchInput && (
            <button onClick={() => { setSearchInput(''); clearTimeout(searchDebounce.current); setSearch('') }} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-4 hover:text-ink-2">
              <X size={13} />
            </button>
          )}
        </div>
        <div className="flex bg-paper border border-line rounded-[9px] p-[3px]">
          {(['az', 'cost', 'foodcost'] as const).map(m => (
            <button key={m} onClick={() => setSortMode(m)}
              className={`px-3 py-[5px] font-mono text-[11px] rounded-[6px] transition-colors ${sortMode === m ? 'bg-ink text-paper' : 'text-ink-3 hover:text-ink-2'}`}>
              {m === 'az' ? 'A–Z' : m === 'cost' ? 'Cost' : 'FC %'}
            </button>
          ))}
        </div>
        <div className="flex bg-paper border border-line rounded-[9px] p-[3px]">
          {(['list', 'grid'] as const).map(v => (
            <button key={v} onClick={() => setViewMode(v)}
              className={`px-3 py-[5px] font-mono text-[11px] rounded-[6px] transition-colors ${viewMode === v ? 'bg-ink text-paper' : 'text-ink-3 hover:text-ink-2'}`}>
              {v === 'list' ? 'List' : 'Grid'}
            </button>
          ))}
        </div>
      </div>

      {/* ── CATEGORY FILTER PILLS ── */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <button
          onClick={() => setActiveCatId(null)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12.5px] font-medium transition-colors ${activeCatId === null ? activePill : inactivePill}`}
        >
          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: activeCatId === null ? '#fafaf9' : '#a1a1aa' }} />
          All
          <span className={`font-mono text-[10.5px] ${activeCatId === null ? 'opacity-60' : 'text-ink-3'}`}>
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
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12.5px] font-medium transition-colors ${isActive ? activePill : inactivePill}`}
            >
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ background: cat.color ?? '#a1a1aa' }}
              />
              {cat.name}
              <span className={`font-mono text-[10.5px] ${isActive ? 'opacity-60' : 'text-ink-3'}`}>{count}</span>
            </button>
          )
        })}
      </div>

      {/* ── SHOWING ROW ── */}
      <div className="flex items-center justify-between -mt-1">
        <p className="font-mono text-[10.5px] text-ink-3 tracking-[0.04em] uppercase">
          {displayRecipes.length} {displayRecipes.length === 1 ? 'dish' : 'dishes'} · {sortMode === 'az' ? 'A–Z' : sortMode === 'cost' ? 'Cost' : 'Food cost'}
          {activeCatId && <> · {typeCats.find(c => c.id === activeCatId)?.name}</>}
          {!activeCatId && <> · click any row to edit</>}
        </p>
        <label className="flex items-center gap-2 font-mono text-[10.5px] text-ink-3 tracking-[0.04em] uppercase cursor-pointer select-none">
          <input
            type="checkbox"
            checked={!showInactive}
            onChange={() => setShowInactive(s => !s)}
            className="w-3.5 h-3.5 accent-ink cursor-pointer"
          />
          Active only
        </label>
      </div>

      {/* ── MAIN CONTENT ── */}
      <div className="flex-1 pb-20 md:pb-4">

        {/* New dish form */}
        {showNewForm && (
          <div className="bg-paper rounded-xl border border-line p-4 mb-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-[15px] text-ink tracking-[-0.02em]">New menu dish</h3>
              <button onClick={() => setShowNewForm(false)} className="text-ink-4 hover:text-ink-2"><X size={16} /></button>
            </div>
            <form onSubmit={handleCreate} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="text-[12.5px] font-medium text-ink-2 block mb-1.5">Name *</label>
                  <input
                    required
                    value={newForm.name}
                    onChange={e => setNewForm(f => ({ ...f, name: e.target.value }))}
                    className="w-full border border-line rounded-[9px] px-3 py-2 text-[13px] text-ink focus:outline-none focus:border-ink-3"
                  />
                </div>
                <div>
                  <label className="text-[12.5px] font-medium text-ink-2 block mb-1.5">Category *</label>
                  <select
                    required
                    value={newForm.categoryId}
                    onChange={e => setNewForm(f => ({ ...f, categoryId: e.target.value }))}
                    className="w-full border border-line rounded-[9px] px-3 py-2 text-[13px] text-ink bg-paper focus:outline-none focus:border-ink-3"
                  >
                    <option value="">Select…</option>
                    {typeCats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[12.5px] font-medium text-ink-2 block mb-1.5">Revenue center *</label>
                  <select
                    required
                    value={newForm.revenueCenterId}
                    onChange={e => setNewForm(f => ({ ...f, revenueCenterId: e.target.value }))}
                    className="w-full border border-line rounded-[9px] px-3 py-2 text-[13px] text-ink bg-paper focus:outline-none focus:border-ink-3"
                  >
                    <option value="">Select…</option>
                    {revenueCenters.filter(rc => rc.isActive).map(rc => (
                      <option key={rc.id} value={rc.id}>{rc.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-[12.5px] font-medium text-ink-2 block mb-1.5">
                    Portions per batch *
                    <span className="ml-1.5 font-mono text-[10.5px] font-normal text-ink-3">usually 1</span>
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
                      className="flex-1 border border-line rounded-[9px] px-2.5 py-2 text-[13px] text-ink focus:outline-none focus:border-ink-3"
                    />
                    <select
                      required
                      value={newForm.yieldUnit}
                      onChange={e => setNewForm(f => ({ ...f, yieldUnit: e.target.value }))}
                      className="w-28 border border-line rounded-[9px] px-2.5 py-2 text-[13px] text-ink bg-paper focus:outline-none focus:border-ink-3"
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
                  <label className="text-[12.5px] font-medium text-ink-2 block mb-1.5">Menu price ($)</label>
                  <div className="relative">
                    <span className="absolute left-3 top-2 font-mono text-[13px] text-ink-3">$</span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="0.00"
                      value={newForm.menuPrice}
                      onChange={e => setNewForm(f => ({ ...f, menuPrice: e.target.value }))}
                      className="w-full border border-line rounded-[9px] pl-7 pr-3 py-2 text-[13px] text-ink focus:outline-none focus:border-ink-3"
                    />
                  </div>
                </div>
              </div>
              <div className="flex gap-2">
                <button type="submit" className="flex-1 bg-ink text-paper py-2 rounded-[9px] text-[13px] font-semibold hover:bg-ink-2 transition-colors">
                  Create
                </button>
                <button type="button" onClick={() => setShowNewForm(false)} className="px-4 py-2 border border-line rounded-[9px] text-[13px] text-ink-2 hover:bg-bg-2 transition-colors">
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Dish list */}
        {displayRecipes.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <UtensilsCrossed size={40} className="text-ink-4 mb-3" />
            <p className="text-ink-3 text-[13px]">
              {searchInput ? `No dishes match "${searchInput}"` : 'No dishes yet'}
            </p>
            {!searchInput && (
              <button onClick={() => setShowNewForm(true)} className="mt-3 font-mono text-[11px] text-gold-2 hover:text-gold">
                Create your first dish →
              </button>
            )}
          </div>
        ) : (
          <div className="bg-paper rounded-xl border border-line overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-2.5 bg-bg-2 border-b border-line font-mono text-[10.5px] uppercase tracking-[0.04em] text-ink-3">
              {/* Select-all checkbox */}
              <button
                onClick={handleSelectAll}
                className={`shrink-0 w-4 h-4 rounded-[4px] border-[1.5px] flex items-center justify-center transition-colors ${
                  allVisibleSelected
                    ? 'border-ink bg-ink'
                    : selectedIds.size > 0
                    ? 'border-ink bg-bg-2'
                    : 'border-line-2 hover:border-ink-3 bg-paper'
                }`}
              >
                {allVisibleSelected && <Check size={10} className="text-paper" strokeWidth={3} />}
                {!allVisibleSelected && selectedIds.size > 0 && (
                  <span className="w-1.5 h-0.5 bg-ink rounded-full" />
                )}
              </button>
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
                isSelected={selectedIds.has(recipe.id)}
                onSelect={() => handleSelect(recipe.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── BULK ACTION BAR ── */}
      {selectedIds.size > 0 && !bulkConfirm && (
        <BulkActionBar
          count={selectedIds.size}
          onDeactivate={() => setBulkConfirm('deactivate')}
          onDelete={() => setBulkConfirm('delete')}
          onClear={() => setSelectedIds(new Set())}
        />
      )}

      {/* ── BULK CONFIRMATION MODAL ── */}
      {bulkConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40" onClick={() => setBulkConfirm(null)} />
          <div className="relative bg-paper rounded-2xl shadow-2xl border border-line p-6 w-full max-w-sm">
            {bulkConfirm === 'deactivate' ? (
              <>
                <h3 className="text-[15px] font-semibold text-ink tracking-[-0.02em] mb-1">Deactivate {selectedIds.size} {selectedIds.size === 1 ? 'dish' : 'dishes'}?</h3>
                <p className="text-[13px] text-ink-3 mb-5">
                  They will be hidden from the active menu. You can reactivate them at any time by enabling &quot;Show inactive&quot;.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={handleBulkDeactivate}
                    className="flex-1 bg-ink hover:bg-ink-2 text-paper py-2.5 rounded-[10px] text-[13px] font-semibold transition-colors"
                  >
                    Deactivate
                  </button>
                  <button
                    onClick={() => setBulkConfirm(null)}
                    className="flex-1 border border-line text-ink-2 py-2.5 rounded-[10px] text-[13px] font-medium hover:bg-bg-2 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3 className="text-[15px] font-semibold text-ink tracking-[-0.02em] mb-1">Delete {selectedIds.size} {selectedIds.size === 1 ? 'dish' : 'dishes'}?</h3>
                <p className="text-[13px] text-ink-3 mb-5">
                  This is permanent and cannot be undone. All ingredients and costing data will be lost.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={handleBulkDelete}
                    className="flex-1 bg-red hover:bg-red text-paper py-2.5 rounded-[10px] text-[13px] font-semibold transition-colors"
                  >
                    Delete permanently
                  </button>
                  <button
                    onClick={() => setBulkConfirm(null)}
                    className="flex-1 border border-line text-ink-2 py-2.5 rounded-[10px] text-[13px] font-medium hover:bg-bg-2 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

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
          revenueCenters={revenueCenters}
        />
      )}
    </div>
  )
}
