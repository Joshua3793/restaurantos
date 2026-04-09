'use client'
import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { formatCurrency, formatUnitPrice, CATEGORY_COLORS, PACK_UOMS, COUNT_UOMS, calcPricePerBaseUnit, calcConversionFactor, deriveBaseUnit } from '@/lib/utils'
import { CategoryBadge } from '@/components/CategoryBadge'
import { StockStatus } from '@/components/StockStatus'
import {
  Search, Plus, X, ArrowUpDown, Download, ClipboardCheck,
  CheckSquare, Square, ChevronDown, ChevronRight, AlertCircle,
  ChevronsUpDown, ChevronUp, Pencil, Trash2,
} from 'lucide-react'

interface StorageArea { id: string; name: string }
interface Supplier    { id: string; name: string }
interface Category    { id: string; name: string }
interface InventoryItem {
  id: string; itemName: string; category: string
  supplier?: Supplier | null;    supplierId?: string | null
  storageArea?: StorageArea | null; storageAreaId?: string | null
  purchaseUnit: string; qtyPerPurchaseUnit: number
  purchasePrice: number; baseUnit: string
  packSize: number; packUOM: string; countUOM: string
  conversionFactor: number; pricePerBaseUnit: number
  stockOnHand: number; abbreviation?: string | null
  isActive: boolean
  lastCountDate?: string | null; lastCountQty?: number | null
}

type SortMode  = 'category' | 'all'
type ColKey    = 'item' | 'category' | 'value'
type ColDir    = 'asc' | 'desc'
type FilterPill = 'all' | 'counted' | 'notCounted' | 'highValue' | 'active' | 'inactive'

interface EditForm {
  itemName: string; category: string
  supplierId: string; supplierName: string
  storageAreaId: string; storageAreaName: string
  purchaseUnit: string; qtyPerPurchaseUnit: string
  purchasePrice: string
  packSize: string; packUOM: string; countUOM: string
  stockOnHand: string
  abbreviation: string; isActive: boolean
}

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: 'category', label: 'Group by Category' },
  { value: 'all',      label: 'Group by All' },
]

const CATEGORY_HEADER: Record<string, string> = {
  BREAD: 'bg-amber-50 border-amber-200 text-amber-800',
  DAIRY: 'bg-blue-50 border-blue-200 text-blue-800',
  DRY:   'bg-yellow-50 border-yellow-200 text-yellow-800',
  FISH:  'bg-cyan-50 border-cyan-200 text-cyan-800',
  MEAT:  'bg-red-50 border-red-200 text-red-800',
  PREPD: 'bg-purple-50 border-purple-200 text-purple-800',
  PROD:  'bg-green-50 border-green-200 text-green-800',
  CHM:   'bg-gray-100 border-gray-300 text-gray-700',
}

const defaultForm = {
  itemName: '', category: '', supplierId: '', storageAreaId: '',
  purchaseUnit: '', qtyPerPurchaseUnit: '1', purchasePrice: '0',
  baseUnit: 'g', conversionFactor: '1', stockOnHand: '0',
  abbreviation: '', location: '',
}

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
        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      {open && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
          {filtered.length === 0 && !query && <div className="px-3 py-2 text-sm text-gray-400">No options</div>}
          {filtered.map(item => (
            <button key={item.id} type="button"
              onMouseDown={() => { onSelect(item.id, item.name); setQuery(''); setOpen(false) }}
              className="block w-full text-left px-3 py-2 text-sm hover:bg-blue-50"
            >{item.name}</button>
          ))}
          {!exactMatch && query && onAddNew && (
            <button type="button"
              onMouseDown={async () => {
                const r = await onAddNew(query)
                onSelect(r.id, r.name); setQuery(''); setOpen(false)
              }}
              className="block w-full text-left px-3 py-2 text-sm text-blue-600 hover:bg-blue-50 border-t border-gray-100"
            >+ Add &ldquo;{query}&rdquo;</button>
          )}
        </div>
      )}
    </div>
  )
}

function isCountedThisWeek(item: InventoryItem) {
  if (!item.lastCountDate) return false
  const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7)
  return new Date(item.lastCountDate) >= weekAgo
}

function SortIcon({ col, colSort }: { col: ColKey; colSort: { col: ColKey; dir: ColDir } | null }) {
  if (!colSort || colSort.col !== col)
    return <ChevronsUpDown size={11} className="text-gray-300 ml-1 inline-block" />
  return colSort.dir === 'asc'
    ? <ChevronUp size={11} className="text-blue-600 ml-1 inline-block" />
    : <ChevronDown size={11} className="text-blue-600 ml-1 inline-block" />
}

export default function InventoryPage() {
  const [items,        setItems]        = useState<InventoryItem[]>([])
  const [suppliers,    setSuppliers]    = useState<Supplier[]>([])
  const [storageAreas, setStorageAreas] = useState<StorageArea[]>([])
  const [categories,   setCategories]   = useState<Category[]>([])
  const [search,       setSearch]       = useState('')
  const [catFilter,    setCatFilter]    = useState('')
  const [supplierFilter, setSupplierFilter] = useState('')
  const [sortBy,       setSortBy]       = useState<SortMode>('category')
  const [colSort,      setColSort]      = useState<{ col: ColKey; dir: ColDir } | null>(null)
  const [activePill,   setActivePill]   = useState<FilterPill>('all')
  const [selected,     setSelected]     = useState<InventoryItem | null>(null)
  const [showAdd,      setShowAdd]      = useState(false)
  const [form,         setForm]         = useState(defaultForm)
  const [checkedIds,   setCheckedIds]   = useState<Set<string>>(new Set())
  const [collapsedCats, setCollapsedCats] = useState<Set<string>>(new Set())
  const [bulkAction,        setBulkAction]        = useState('')
  const [showBulkMenu,      setShowBulkMenu]      = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [editMode,     setEditMode]     = useState(false)
  const [editForm,     setEditForm]     = useState<EditForm>({
    itemName: '', category: '', supplierId: '', supplierName: '',
    storageAreaId: '', storageAreaName: '', purchaseUnit: 'case',
    qtyPerPurchaseUnit: '1', purchasePrice: '0',
    packSize: '1', packUOM: 'each', countUOM: 'each',
    stockOnHand: '0', abbreviation: '', isActive: true,
  })

  const fetchItems = useCallback(() => {
    const p = new URLSearchParams()
    if (search)         p.set('search', search)
    if (catFilter)      p.set('category', catFilter)
    if (supplierFilter) p.set('supplierId', supplierFilter)
    fetch(`/api/inventory?${p}`).then(r => r.json()).then(setItems)
  }, [search, catFilter, supplierFilter])

  useEffect(() => { fetchItems() }, [fetchItems])
  useEffect(() => {
    fetch('/api/suppliers').then(r => r.json()).then(setSuppliers)
    fetch('/api/storage-areas').then(r => r.json()).then(setStorageAreas)
    fetch('/api/categories').then(r => r.json()).then(setCategories)
  }, [])

  // Default form category once categories load
  useEffect(() => {
    if (categories.length > 0 && !form.category) {
      setForm(f => ({ ...f, category: categories[0].name }))
    }
  }, [categories])

  const catNames = useMemo(() => categories.map(c => c.name), [categories])

  // KPIs
  const kpis = useMemo(() => {
    const active = items.filter(i => i.isActive)
    const totalValue = active.reduce((s, i) =>
      s + parseFloat(String(i.stockOnHand)) * parseFloat(String(i.conversionFactor)) * parseFloat(String(i.pricePerBaseUnit)), 0)
    const counted = active.filter(isCountedThisWeek).length
    return { totalValue, counted, notCounted: active.length - counted, activeCount: active.length, totalCount: items.length }
  }, [items])

  // Pill filter
  const pillFiltered = useMemo(() => {
    switch (activePill) {
      case 'counted':    return items.filter(isCountedThisWeek)
      case 'notCounted': return items.filter(i => !isCountedThisWeek(i))
      case 'highValue':  return items.filter(i => parseFloat(String(i.pricePerBaseUnit)) > 0.01)
      case 'active':     return items.filter(i => i.isActive)
      case 'inactive':   return items.filter(i => !i.isActive)
      default:           return items
    }
  }, [items, activePill, catNames])

  // Column sort toggle (cycles: none → asc → desc → none)
  const toggleColSort = (col: ColKey) => {
    setColSort(prev => {
      if (!prev || prev.col !== col) return { col, dir: 'asc' }
      if (prev.dir === 'asc')        return { col, dir: 'desc' }
      return null
    })
  }

  // Sort
  const sortedItems = useMemo(() => {
    const copy = [...pillFiltered]
    if (sortBy === 'all') {
      if (colSort?.col === 'item') {
        return copy.sort((a, b) => {
          const c = a.itemName.localeCompare(b.itemName)
          return colSort.dir === 'asc' ? c : -c
        })
      }
      if (colSort?.col === 'category') {
        return copy.sort((a, b) => {
          const cc = a.category.localeCompare(b.category)
          if (cc !== 0) return colSort.dir === 'asc' ? cc : -cc
          return a.itemName.localeCompare(b.itemName) // items always A-Z within category
        })
      }
      if (colSort?.col === 'value') {
        const val = (i: InventoryItem) => parseFloat(String(i.stockOnHand)) * parseFloat(String(i.pricePerBaseUnit))
        return copy.sort((a, b) => colSort.dir === 'asc' ? val(a) - val(b) : val(b) - val(a))
      }
      // default: A-Z
      return copy.sort((a, b) => a.itemName.localeCompare(b.itemName))
    }
    // category group mode: sort by category order then item name
    return copy.sort((a, b) => {
      const ia = catNames.indexOf(a.category), ib = catNames.indexOf(b.category)
      const ci = (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib)
      return ci !== 0 ? ci : a.itemName.localeCompare(b.itemName)
    })
  }, [pillFiltered, sortBy, colSort, catNames])

  // Category groups (only in 'category' mode)
  const categoryGroups = useMemo(() => {
    if (sortBy !== 'category') return null
    const map = new Map<string, InventoryItem[]>()
    for (const cat of catNames) map.set(cat, [])
    for (const item of sortedItems) {
      if (!map.has(item.category)) map.set(item.category, [])
      map.get(item.category)!.push(item)
    }
    return Array.from(map.entries()).filter(([, rows]) => rows.length > 0) as [string, InventoryItem[]][]
  }, [sortedItems, sortBy, catNames])

  // Checkbox helpers
  const toggleCheck = (id: string) =>
    setCheckedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  const toggleAll = () =>
    setCheckedIds(checkedIds.size === sortedItems.length ? new Set() : new Set(sortedItems.map(i => i.id)))
  const toggleCatGroup = (rows: InventoryItem[]) => {
    const ids = rows.map(r => r.id)
    const allOn = ids.every(id => checkedIds.has(id))
    setCheckedIds(prev => { const n = new Set(prev); ids.forEach(id => allOn ? n.delete(id) : n.add(id)); return n })
  }

  // Bulk action
  const executeBulk = async (action: string, value?: string) => {
    if (!checkedIds.size) return
    await fetch('/api/inventory/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: Array.from(checkedIds), action, value }),
    })
    setCheckedIds(new Set()); setBulkAction(''); setShowBulkMenu(false)
    fetchItems()
  }

  const markCounted = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    await fetch(`/api/inventory/count/${id}`, { method: 'POST' })
    fetchItems()
  }

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    await fetch('/api/inventory', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
    })
    setShowAdd(false); setForm(defaultForm); fetchItems()
  }

  const handleSave = async () => {
    if (!selected) return
    const res = await fetch(`/api/inventory/${selected.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        itemName: editForm.itemName,
        category: editForm.category,
        supplierId: editForm.supplierId || null,
        storageAreaId: editForm.storageAreaId || null,
        purchaseUnit: editForm.purchaseUnit,
        qtyPerPurchaseUnit: editForm.qtyPerPurchaseUnit,
        purchasePrice: editForm.purchasePrice,
        packSize: editForm.packSize,
        packUOM: editForm.packUOM,
        countUOM: editForm.countUOM,
        stockOnHand: editForm.stockOnHand,
        abbreviation: editForm.abbreviation,
        isActive: editForm.isActive,
      }),
    })
    const updated = await res.json()
    setSelected({ ...selected, ...updated, supplier: updated.supplier, storageArea: updated.storageArea })
    setEditMode(false)
    fetchItems()
  }

  const pricePreview = parseFloat(form.purchasePrice) / (parseFloat(form.qtyPerPurchaseUnit) * parseFloat(form.conversionFactor)) || 0

  // Row renderer
  const renderRow = (item: InventoryItem) => {
    const counted  = isCountedThisWeek(item)
    const invValue = parseFloat(String(item.stockOnHand)) * parseFloat(String(item.conversionFactor)) * parseFloat(String(item.pricePerBaseUnit))
    return (
      <tr
        key={item.id}
        className={`hover:bg-gray-50 cursor-pointer border-b border-gray-50 ${!item.isActive ? 'opacity-50' : ''}`}
        onClick={() => setSelected(item)}
      >
        <td className="pl-4 py-3 pr-2" onClick={e => e.stopPropagation()}>
          <button onClick={() => toggleCheck(item.id)} className="text-gray-400 hover:text-blue-600">
            {checkedIds.has(item.id) ? <CheckSquare size={16} className="text-blue-600" /> : <Square size={16} />}
          </button>
        </td>
        <td className="px-3 py-3">
          <div className="font-medium text-gray-800 text-sm">{item.itemName}</div>
          {item.abbreviation && <div className="text-xs text-gray-400">{item.abbreviation}</div>}
        </td>
        {sortBy === 'all' && (
          <td className="px-3 py-3 hidden sm:table-cell">
            <CategoryBadge category={item.category} />
          </td>
        )}
        <td className="px-3 py-3 text-sm text-gray-600 hidden md:table-cell">
          {item.supplier?.name || <span className="text-gray-300">&mdash;</span>}
        </td>
        <td className="px-3 py-3 text-right">
          <div className="text-sm font-medium text-orange-600">{formatCurrency(parseFloat(String(item.purchasePrice)))}</div>
          <div className="text-xs text-gray-400">(1 {item.purchaseUnit} = {parseFloat(String(item.qtyPerPurchaseUnit))} {item.baseUnit})</div>
        </td>
        <td className="px-3 py-3 text-right text-sm text-gray-700">
          {parseFloat(String(item.stockOnHand)).toFixed(1)}
          <span className="text-xs text-gray-400 ml-1">{item.countUOM || item.purchaseUnit}</span>
        </td>
        <td className="px-3 py-3 text-right">
          <span className={`text-sm font-mono font-semibold ${invValue > 10 ? 'text-gray-800' : 'text-gray-500'}`}>
            {formatCurrency(invValue)}
          </span>
        </td>
        <td className="px-3 py-3 text-center hidden sm:table-cell">
          <StockStatus stock={parseFloat(String(item.stockOnHand))} />
        </td>
        <td className="px-3 py-3 text-center">
          <button
            onClick={e => markCounted(e, item.id)}
            title={counted ? `Counted ${item.lastCountDate ? new Date(item.lastCountDate).toLocaleDateString() : ''}` : 'Mark as counted'}
            className={`p-1.5 rounded-lg transition-colors ${counted ? 'bg-green-100 text-green-600' : 'bg-gray-100 text-gray-400 hover:bg-blue-100 hover:text-blue-600'}`}
          >
            <ClipboardCheck size={15} />
          </button>
        </td>
      </tr>
    )
  }

  const pills: { key: FilterPill; label: string }[] = [
    { key: 'all',        label: 'All Items' },
    { key: 'active',     label: 'Active' },
    { key: 'inactive',   label: 'Inactive' },
    { key: 'counted',    label: 'Counted This Week' },
    { key: 'notCounted', label: 'Not Counted' },
    { key: 'highValue',  label: 'High Value Stock' },
  ]

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Inventory</h1>
          <p className="text-sm text-gray-500 mt-0.5">Master database &middot; weekly stock counting &middot; cost control</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => window.location.href = '/api/inventory/export'}
            className="flex items-center gap-2 border border-gray-200 bg-white text-gray-700 px-3 py-2 rounded-lg text-sm hover:bg-gray-50 transition-colors"
          >
            <Download size={15} /> Export
          </button>
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-2 bg-blue-600 text-white px-3 py-2 rounded-lg text-sm hover:bg-blue-700 transition-colors"
          >
            <Plus size={15} /> Add Item
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {[
          { label: 'CURRENT STOCK VALUE',  value: formatCurrency(kpis.totalValue), sub: `${kpis.activeCount} active items`, accent: 'text-blue-600',   alert: false },
          { label: 'PREVIOUS STOCK VALUE', value: '$0.00',                          sub: 'No prior count',                   accent: 'text-gray-400',   alert: false },
          { label: 'COUNTED THIS WEEK',    value: String(kpis.counted),             sub: `of ${kpis.activeCount} active`,    accent: 'text-green-600',  alert: false },
          { label: 'NOT YET COUNTED',      value: String(kpis.notCounted),          sub: 'items need counting',              accent: 'text-orange-500', alert: kpis.notCounted > 0 },
          { label: 'ACTIVE ITEMS',         value: String(kpis.activeCount),         sub: `${kpis.totalCount} total`,         accent: 'text-gray-700',   alert: false },
        ].map(card => (
          <div key={card.label} className="bg-white rounded-xl border border-gray-100 p-3 shadow-sm">
            <div className="flex items-start justify-between gap-1">
              <div className="text-[10px] font-semibold text-gray-400 tracking-wide leading-tight">{card.label}</div>
              {card.alert && <AlertCircle size={14} className="text-orange-400 shrink-0" />}
            </div>
            <div className={`text-2xl font-bold mt-1 ${card.accent}`}>{card.value}</div>
            <div className={`text-xs mt-0.5 ${card.alert ? 'text-orange-500 font-medium' : 'text-gray-400'}`}>{card.sub}</div>
          </div>
        ))}
      </div>

      {/* Filter Pills */}
      <div className="flex gap-1.5 flex-wrap">
        {pills.map(p => (
          <button
            key={p.key}
            onClick={() => setActivePill(p.key)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
              activePill === p.key ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Search + Filters */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search items..."
            className="w-full pl-8 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <select value={catFilter} onChange={e => setCatFilter(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
          <option value="">All Categories</option>
          {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
        </select>
        <select value={supplierFilter} onChange={e => setSupplierFilter(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
          <option value="">All Suppliers</option>
          {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <div className="relative">
          <ArrowUpDown size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          <select
            value={sortBy}
            onChange={e => { setSortBy(e.target.value as SortMode); setColSort(null) }}
            className="pl-8 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white font-medium text-gray-700"
          >
            {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>

      <div className="text-xs text-gray-400">Showing {sortedItems.length} of {items.length} items</div>

      {/* Bulk action bar — fixed at bottom so it's visible no matter how far you scroll */}
      {checkedIds.size > 0 && (
        <div className="fixed bottom-16 md:bottom-4 left-0 right-0 z-40 px-3 pointer-events-none">
          <div className="max-w-5xl mx-auto pointer-events-auto">
            <div className="bg-white border border-blue-200 rounded-xl px-4 py-3 shadow-xl flex flex-wrap items-center gap-2 ring-1 ring-blue-100">
              <span className="text-sm font-semibold text-blue-700 shrink-0">{checkedIds.size} selected</span>
              <div className="flex gap-2 flex-wrap flex-1">
                <button onClick={() => executeBulk('activate')}   className="px-3 py-1.5 bg-green-600 text-white text-xs rounded-lg hover:bg-green-700">Activate</button>
                <button onClick={() => executeBulk('deactivate')} className="px-3 py-1.5 bg-orange-500 text-white text-xs rounded-lg hover:bg-orange-600">Deactivate</button>
                {/* Assign Category */}
                <div className="relative">
                  <button
                    onClick={() => { setBulkAction('setCategory'); setShowBulkMenu(v => bulkAction === 'setCategory' ? !v : true) }}
                    className="px-3 py-1.5 bg-white border border-gray-200 text-xs rounded-lg hover:bg-gray-50 flex items-center gap-1"
                  >
                    Assign Category <ChevronDown size={12} />
                  </button>
                  {showBulkMenu && bulkAction === 'setCategory' && (
                    <div className="absolute bottom-full left-0 mb-1 bg-white border border-gray-200 rounded-lg shadow-lg z-50 min-w-40 max-h-56 overflow-y-auto">
                      {categories.map(c => (
                        <button key={c.id} onClick={() => executeBulk('setCategory', c.name)} className="block w-full text-left px-3 py-2 text-xs hover:bg-gray-50">{c.name}</button>
                      ))}
                    </div>
                  )}
                </div>
                {/* Assign Supplier */}
                <div className="relative">
                  <button
                    onClick={() => { setBulkAction('setSupplier'); setShowBulkMenu(v => bulkAction === 'setSupplier' ? !v : true) }}
                    className="px-3 py-1.5 bg-white border border-gray-200 text-xs rounded-lg hover:bg-gray-50 flex items-center gap-1"
                  >
                    Assign Supplier <ChevronDown size={12} />
                  </button>
                  {showBulkMenu && bulkAction === 'setSupplier' && (
                    <div className="absolute bottom-full left-0 mb-1 bg-white border border-gray-200 rounded-lg shadow-lg z-50 min-w-44 max-h-56 overflow-y-auto">
                      {suppliers.map(s => (
                        <button key={s.id} onClick={() => executeBulk('setSupplier', s.id)} className="block w-full text-left px-3 py-2 text-xs hover:bg-gray-50">{s.name}</button>
                      ))}
                    </div>
                  )}
                </div>
                {/* Assign Area */}
                <div className="relative">
                  <button
                    onClick={() => { setBulkAction('setStorageArea'); setShowBulkMenu(v => bulkAction === 'setStorageArea' ? !v : true) }}
                    className="px-3 py-1.5 bg-white border border-gray-200 text-xs rounded-lg hover:bg-gray-50 flex items-center gap-1"
                  >
                    Assign Area <ChevronDown size={12} />
                  </button>
                  {showBulkMenu && bulkAction === 'setStorageArea' && (
                    <div className="absolute bottom-full left-0 mb-1 bg-white border border-gray-200 rounded-lg shadow-lg z-50 min-w-48 max-h-56 overflow-y-auto">
                      {storageAreas.map(a => (
                        <button key={a.id} onClick={() => executeBulk('setStorageArea', a.id)} className="block w-full text-left px-3 py-2 text-xs hover:bg-gray-50">{a.name}</button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600 text-white text-xs rounded-lg hover:bg-red-700 font-medium"
                >
                  <Trash2 size={12} /> Delete
                </button>
                <button onClick={() => { setCheckedIds(new Set()); setShowBulkMenu(false) }} className="text-xs text-gray-400 hover:text-gray-600 px-1">✕</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
                <Trash2 size={18} className="text-red-600" />
              </div>
              <div>
                <h3 className="font-semibold text-gray-900">Delete {checkedIds.size} item{checkedIds.size > 1 ? 's' : ''}?</h3>
                <p className="text-xs text-gray-500 mt-0.5">This action cannot be undone.</p>
              </div>
            </div>
            <p className="text-sm text-gray-600 mb-5">
              You are about to permanently delete <span className="font-semibold text-gray-900">{checkedIds.size} inventory item{checkedIds.size > 1 ? 's' : ''}</span>. This will remove them from all records.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={async () => { setShowDeleteConfirm(false); await executeBulk('delete') }}
                className="flex-1 px-4 py-2.5 rounded-xl bg-red-600 text-white text-sm font-medium hover:bg-red-700"
              >
                Yes, delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="pl-4 py-3 pr-2 w-8">
                  <button onClick={toggleAll} className="text-gray-400 hover:text-blue-600">
                    {checkedIds.size === sortedItems.length && sortedItems.length > 0
                      ? <CheckSquare size={15} className="text-blue-600" /> : <Square size={15} />}
                  </button>
                </th>
                {/* Item — sortable in 'all' mode */}
                <th className="text-left px-3 py-3 font-medium text-gray-600 text-xs">
                  {sortBy === 'all' ? (
                    <button onClick={() => toggleColSort('item')} className="flex items-center hover:text-blue-600">
                      Item <SortIcon col="item" colSort={colSort} />
                    </button>
                  ) : 'Item'}
                </th>
                {/* Category col only in 'all' mode */}
                {sortBy === 'all' && (
                  <th className="text-left px-3 py-3 font-medium text-gray-600 text-xs hidden sm:table-cell">
                    <button onClick={() => toggleColSort('category')} className="flex items-center hover:text-blue-600">
                      Category <SortIcon col="category" colSort={colSort} />
                    </button>
                  </th>
                )}
                <th className="text-left px-3 py-3 font-medium text-gray-600 text-xs hidden md:table-cell">Supplier</th>
                <th className="text-right px-3 py-3 font-medium text-gray-600 text-xs">Purchase Price</th>
                <th className="text-right px-3 py-3 font-medium text-gray-600 text-xs">Current Stock</th>
                {/* Inv Value — sortable in 'all' mode */}
                <th className="text-right px-3 py-3 font-medium text-gray-600 text-xs">
                  {sortBy === 'all' ? (
                    <button onClick={() => toggleColSort('value')} className="flex items-center justify-end w-full hover:text-blue-600">
                      Inv Value <SortIcon col="value" colSort={colSort} />
                    </button>
                  ) : 'Inv Value'}
                </th>
                <th className="text-center px-3 py-3 font-medium text-gray-600 text-xs hidden sm:table-cell">Status</th>
                <th className="text-center px-3 py-3 font-medium text-gray-600 text-xs">Count</th>
              </tr>
            </thead>
            <tbody>
              {categoryGroups ? (
                categoryGroups.map(([cat, rows]) => {
                  const catValue  = rows.reduce((s, i) => s + parseFloat(String(i.stockOnHand)) * parseFloat(String(i.conversionFactor)) * parseFloat(String(i.pricePerBaseUnit)), 0)
                  const allChecked = rows.length > 0 && rows.every(r => checkedIds.has(r.id))
                  const collapsed  = collapsedCats.has(cat)
                  return (
                    <React.Fragment key={`group-${cat}`}>
                      <tr
                        className={`border-y cursor-pointer ${CATEGORY_HEADER[cat] ?? 'bg-gray-50 border-gray-200'}`}
                        onClick={() => setCollapsedCats(prev => { const n = new Set(prev); n.has(cat) ? n.delete(cat) : n.add(cat); return n })}
                      >
                        <td className="pl-4 py-2 pr-2" onClick={e => e.stopPropagation()}>
                          <button onClick={() => toggleCatGroup(rows)} className="hover:opacity-70">
                            {allChecked ? <CheckSquare size={15} className="text-blue-600" /> : <Square size={15} />}
                          </button>
                        </td>
                        <td className="px-3 py-2" colSpan={6}>
                          <div className="flex items-center gap-2">
                            {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                            <span className="font-semibold text-xs tracking-wider uppercase">{cat}</span>
                            <span className="text-xs opacity-60">({rows.length} items)</span>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right" colSpan={2}>
                          <span className="text-xs font-semibold">{formatCurrency(catValue)}</span>
                        </td>
                      </tr>
                      {!collapsed && rows.map(item => renderRow(item))}
                    </React.Fragment>
                  )
                })
              ) : (
                sortedItems.map(item => renderRow(item))
              )}
            </tbody>
          </table>
          {sortedItems.length === 0 && <div className="text-center py-12 text-gray-400">No items found</div>}
        </div>
      </div>

      {/* Detail Panel */}
      {selected && (
        <div className="fixed inset-0 z-50 flex justify-end" onClick={() => { setSelected(null); setEditMode(false) }}>
          <div className="absolute inset-0 bg-black/30" />
          <div className="relative bg-white w-full max-w-md h-full overflow-y-auto shadow-xl" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="sticky top-0 bg-white border-b border-gray-100 p-4 flex items-center justify-between gap-2">
              <div className="flex-1 min-w-0">
                {editMode ? (
                  <input
                    value={editForm.itemName}
                    onChange={e => setEditForm(f => ({ ...f, itemName: e.target.value }))}
                    className="w-full font-semibold text-gray-900 border border-gray-200 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                ) : (
                  <h2 className="font-semibold text-gray-900 truncate">{selected.itemName}</h2>
                )}
                {selected.storageArea && !editMode && <p className="text-xs text-gray-400">{selected.storageArea.name}</p>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {editMode ? (
                  <>
                    <button onClick={handleSave} className="px-3 py-1.5 bg-blue-600 text-white text-xs rounded-lg hover:bg-blue-700">Save</button>
                    <button onClick={() => setEditMode(false)} className="px-3 py-1.5 border border-gray-200 text-xs rounded-lg hover:bg-gray-50">Cancel</button>
                  </>
                ) : (
                  <button
                    onClick={() => {
                      setEditForm({
                        itemName: selected.itemName,
                        category: selected.category,
                        supplierId: selected.supplierId || '',
                        supplierName: selected.supplier?.name || '',
                        storageAreaId: selected.storageAreaId || '',
                        storageAreaName: selected.storageArea?.name || '',
                        purchaseUnit: selected.purchaseUnit,
                        qtyPerPurchaseUnit: String(selected.qtyPerPurchaseUnit),
                        purchasePrice: String(selected.purchasePrice),
                        packSize: String(selected.packSize ?? 1),
                        packUOM: selected.packUOM ?? 'each',
                        countUOM: selected.countUOM ?? 'each',
                        stockOnHand: String(selected.stockOnHand),
                        abbreviation: selected.abbreviation || '',
                        isActive: selected.isActive,
                      })
                      setEditMode(true)
                    }}
                    className="flex items-center gap-1.5 px-3 py-1.5 border border-gray-200 text-xs rounded-lg hover:bg-gray-50"
                  >
                    <Pencil size={12} /> Edit
                  </button>
                )}
                <button onClick={() => { setSelected(null); setEditMode(false) }}><X size={20} className="text-gray-400" /></button>
              </div>
            </div>

            {editMode ? (
              <div className="p-4 space-y-4">
                {/* Active checkbox */}
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={editForm.isActive}
                    onChange={e => setEditForm(f => ({ ...f, isActive: e.target.checked }))}
                    className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
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

                {/* Numeric / text fields */}
                {/* Purchase structure */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Purchase Unit</label>
                    <input value={editForm.purchaseUnit} placeholder="case, dozen…"
                      onChange={e => setEditForm(f => ({ ...f, purchaseUnit: e.target.value }))}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Qty per Case</label>
                    <input type="number" step="any" value={editForm.qtyPerPurchaseUnit}
                      onChange={e => setEditForm(f => ({ ...f, qtyPerPurchaseUnit: e.target.value }))}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Pack Size</label>
                    <input type="number" step="any" value={editForm.packSize} placeholder="e.g. 480, 9, 1"
                      onChange={e => setEditForm(f => ({ ...f, packSize: e.target.value }))}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Pack UOM</label>
                    <select value={editForm.packUOM} onChange={e => setEditForm(f => ({ ...f, packUOM: e.target.value }))}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
                      {PACK_UOMS.map(u => <option key={u}>{u}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Purchase Price ($)</label>
                    <input type="number" step="any" value={editForm.purchasePrice}
                      onChange={e => setEditForm(f => ({ ...f, purchasePrice: e.target.value }))}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Count UOM</label>
                    <select value={editForm.countUOM} onChange={e => setEditForm(f => ({ ...f, countUOM: e.target.value }))}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
                      {COUNT_UOMS.map(u => <option key={u}>{u}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Stock On Hand</label>
                    <input type="number" step="any" value={editForm.stockOnHand}
                      onChange={e => setEditForm(f => ({ ...f, stockOnHand: e.target.value }))}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Abbreviation</label>
                    <input value={editForm.abbreviation}
                      onChange={e => setEditForm(f => ({ ...f, abbreviation: e.target.value }))}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                </div>

                {/* Auto-calculated preview */}
                {(() => {
                  const pp  = parseFloat(editForm.purchasePrice) || 0
                  const qty = parseFloat(editForm.qtyPerPurchaseUnit) || 1
                  const ps  = parseFloat(editForm.packSize) || 1
                  const pu  = editForm.packUOM
                  const cu  = editForm.countUOM
                  const ppbu = calcPricePerBaseUnit(pp, qty, ps, pu)
                  const cf   = calcConversionFactor(cu, qty, ps, pu)
                  const bu   = deriveBaseUnit(pu)
                  return (
                    <div className="bg-blue-50 rounded-lg p-3 space-y-1.5">
                      <div className="text-xs font-semibold text-blue-700 uppercase tracking-wide">Auto-calculated</div>
                      <div className="flex items-baseline gap-1.5">
                        <span className="text-xs text-blue-600">Price per {bu}:</span>
                        <span className="text-lg font-bold text-blue-700">{formatUnitPrice(ppbu)}</span>
                      </div>
                      <div className="flex items-baseline gap-1.5">
                        <span className="text-xs text-blue-600">BU × {cu}:</span>
                        <span className="font-semibold text-blue-700">{cf.toFixed(4)}</span>
                        <span className="text-xs text-blue-500">(1 {cu} = {cf.toFixed(4)} {bu})</span>
                      </div>
                      <div className="text-xs text-blue-500">
                        ${pp.toFixed(2)} ÷ ({qty} × {ps} {pu}) = {formatUnitPrice(ppbu)}/{bu}
                      </div>
                    </div>
                  )
                })()}
              </div>
            ) : (
              <div className="p-4 space-y-4">
                <div className="flex items-center gap-2 flex-wrap">
                  <CategoryBadge category={selected.category} />
                  <StockStatus stock={parseFloat(String(selected.stockOnHand))} />
                  {selected.isActive
                    ? <span className="px-2 py-0.5 rounded-full text-xs bg-green-100 text-green-700 font-medium">Active</span>
                    : <span className="px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-500">Inactive</span>
                  }
                </div>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  {([
                    ['Abbreviation',    selected.abbreviation || '—'],
                    ['Supplier',        selected.supplier?.name || '—'],
                    ['Storage Area',    selected.storageArea?.name || '—'],
                    ['Purchase Unit',   selected.purchaseUnit],
                    ['Qty per Case',    parseFloat(String(selected.qtyPerPurchaseUnit)).toFixed(0)],
                    ['Purchase Price',  formatCurrency(parseFloat(String(selected.purchasePrice)))],
                    ['Pack Size',       `${parseFloat(String(selected.packSize ?? 1))} ${selected.packUOM ?? 'each'}`],
                    ['Count UOM',       selected.countUOM ?? 'each'],
                    ['Stock On Hand',   `${parseFloat(String(selected.stockOnHand)).toFixed(2)} ${selected.countUOM ?? ''}`],
                    ['Last Count',      selected.lastCountDate ? new Date(selected.lastCountDate).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) : 'Never'],
                    ['Last Count Qty',  selected.lastCountQty != null ? `${parseFloat(String(selected.lastCountQty)).toFixed(2)} ${selected.countUOM ?? ''}` : '—'],
                  ] as [string, string][]).map(([label, value]) => (
                    <div key={label} className="bg-gray-50 rounded-lg p-3">
                      <div className="text-xs text-gray-500">{label}</div>
                      <div className="font-medium text-gray-800 mt-0.5">{value}</div>
                    </div>
                  ))}
                  <div className="bg-blue-50 rounded-lg p-3 col-span-2">
                    <div className="text-xs text-blue-600 font-medium">Price per {deriveBaseUnit(selected.packUOM ?? 'each')}</div>
                    <div className="text-lg font-bold text-blue-700 mt-0.5">
                      {formatUnitPrice(parseFloat(String(selected.pricePerBaseUnit)))} / {deriveBaseUnit(selected.packUOM ?? 'each')}
                    </div>
                    <div className="text-xs text-blue-500 mt-1">
                      {formatCurrency(parseFloat(String(selected.purchasePrice)))} ÷ ({parseFloat(String(selected.qtyPerPurchaseUnit))} × {parseFloat(String(selected.packSize ?? 1))} {selected.packUOM ?? 'each'}) &nbsp;|&nbsp; 1 {selected.countUOM ?? 'each'} = {parseFloat(String(selected.conversionFactor)).toFixed(4)} {deriveBaseUnit(selected.packUOM ?? 'each')}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Add Item Modal */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-start justify-center p-4 overflow-y-auto" onClick={() => setShowAdd(false)}>
          <div className="absolute inset-0 bg-black/30" />
          <div className="relative bg-white rounded-xl p-6 w-full max-w-lg shadow-xl my-8" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold mb-4 text-lg">Add Inventory Item</h3>
            <form onSubmit={handleAdd} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-gray-600 mb-1">Item Name *</label>
                  <input required value={form.itemName} onChange={e => setForm(f => ({ ...f, itemName: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Category</label>
                  <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                    {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Supplier</label>
                  <select value={form.supplierId} onChange={e => setForm(f => ({ ...f, supplierId: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                    <option value="">None</option>
                    {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Storage Area</label>
                  <select value={form.storageAreaId} onChange={e => setForm(f => ({ ...f, storageAreaId: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                    <option value="">None</option>
                    {storageAreas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Purchase Unit</label>
                  <input required value={form.purchaseUnit} onChange={e => setForm(f => ({ ...f, purchaseUnit: e.target.value }))} placeholder="e.g. kg, case, each" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Qty per Purchase Unit</label>
                  <input type="number" required value={form.qtyPerPurchaseUnit} onChange={e => setForm(f => ({ ...f, qtyPerPurchaseUnit: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" step="any" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Purchase Price ($)</label>
                  <input type="number" required value={form.purchasePrice} onChange={e => setForm(f => ({ ...f, purchasePrice: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" step="any" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Base Unit</label>
                  <select value={form.baseUnit} onChange={e => setForm(f => ({ ...f, baseUnit: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                    {BASE_UNITS.map(u => <option key={u}>{u}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Conversion Factor</label>
                  <input type="number" required value={form.conversionFactor} onChange={e => setForm(f => ({ ...f, conversionFactor: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" step="any" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Stock On Hand</label>
                  <input type="number" value={form.stockOnHand} onChange={e => setForm(f => ({ ...f, stockOnHand: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" step="any" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Abbreviation</label>
                  <input value={form.abbreviation} onChange={e => setForm(f => ({ ...f, abbreviation: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-gray-600 mb-1">Location</label>
                  <input value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
              </div>
              <div className="bg-blue-50 rounded-lg p-3 text-sm">
                <span className="text-blue-600 font-medium">Price per base unit preview: </span>
                <span className="font-bold text-blue-700">{formatUnitPrice(pricePreview)} / {form.baseUnit}</span>
              </div>
              <div className="flex gap-2 pt-2">
                <button type="button" onClick={() => setShowAdd(false)} className="flex-1 border border-gray-200 rounded-lg py-2 text-sm hover:bg-gray-50">Cancel</button>
                <button type="submit" className="flex-1 bg-blue-600 text-white rounded-lg py-2 text-sm hover:bg-blue-700">Add Item</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
