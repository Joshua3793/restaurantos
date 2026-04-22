'use client'
import React, { useEffect, useState, useCallback, useMemo, useRef, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { formatCurrency, formatUnitPrice, CATEGORY_COLORS, PACK_UOMS, COUNT_UOMS, BASE_UNITS, calcPricePerBaseUnit, calcConversionFactor, deriveBaseUnit, getUnitDimension, compatibleCountUnits } from '@/lib/utils'
import { CategoryBadge } from '@/components/CategoryBadge'
import { StockStatus } from '@/components/StockStatus'
import { AllergenBadges, AllergenToggles, BulkAllergenModal } from '@/components/AllergenBadges'
import {
  Search, Plus, X, Download,
  CheckSquare, Square, ChevronDown, ChevronRight, AlertCircle,
  ChevronsUpDown, ChevronUp, Pencil, Trash2, ShoppingCart, Copy,
  MoreHorizontal,
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
  stockOnHand: number
  allergens?: string[]
  isActive: boolean
  lastCountDate?: string | null; lastCountQty?: number | null
  recipe?: { id: string; name: string } | null
}

type SortMode  = 'category' | 'all'
type ColKey    = 'item' | 'category' | 'supplier' | 'price' | 'stock' | 'value'
type ColDir    = 'asc' | 'desc'
type FilterPill = 'all' | 'counted' | 'notCounted' | 'highValue' | 'outOfStock' | 'active' | 'inactive'

interface EditForm {
  itemName: string; category: string
  supplierId: string; supplierName: string
  storageAreaId: string; storageAreaName: string
  purchaseUnit: string; qtyPerPurchaseUnit: string
  purchasePrice: string
  packSize: string; packUOM: string; countUOM: string
  stockOnHand: string
  isActive: boolean
  allergens: string[]
}

// First-click direction per column: text cols go A→Z, numeric cols go high→low
const COL_DEFAULT_DIR: Record<ColKey, ColDir> = {
  item: 'asc', category: 'asc', supplier: 'asc',
  price: 'desc', stock: 'desc', value: 'desc',
}

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
  location: '', allergens: [] as string[],
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
    return <ChevronsUpDown size={10} className="text-gray-300 ml-0.5 inline-block shrink-0" />
  return colSort.dir === 'asc'
    ? <ChevronUp size={10} className="text-blue-600 ml-0.5 inline-block shrink-0" />
    : <ChevronDown size={10} className="text-blue-600 ml-0.5 inline-block shrink-0" />
}

function SortTh({ col, label, colSort, onSort, className = '' }: {
  col: ColKey; label: string
  colSort: { col: ColKey; dir: ColDir } | null
  onSort: (c: ColKey) => void
  className?: string
}) {
  const active = colSort?.col === col
  return (
    <th className={`px-3 py-3 ${className}`}>
      <button
        onClick={() => onSort(col)}
        className={`inline-flex items-center gap-0.5 text-xs font-medium rounded transition-colors group
          ${active ? 'text-blue-600 font-semibold' : 'text-gray-500 hover:text-gray-800'}`}
      >
        {label}
        <SortIcon col={col} colSort={colSort} />
      </button>
    </th>
  )
}

export default function InventoryPage() {
  return (
    <Suspense fallback={null}>
      <InventoryPageInner />
    </Suspense>
  )
}

function InventoryPageInner() {
  const searchParams = useSearchParams()
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
  const [showBulkAllergen, setShowBulkAllergen] = useState(false)
  const [countedFlash,  setCountedFlash]  = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [syncingPrepd,  setSyncingPrepd]  = useState(false)
  const [lastCount,    setLastCount]    = useState<{ totalCountedValue: number; label: string; sessionDate: string } | null>(null)
  const [showOrderList, setShowOrderList] = useState(false)
  const [orderQtys,    setOrderQtys]    = useState<Record<string, string>>({})
  const [showMobileOverflow,    setShowMobileOverflow]    = useState(false)
  const [showMobileSortSheet,   setShowMobileSortSheet]   = useState(false)
  const [showMobileFilterSheet, setShowMobileFilterSheet] = useState(false)
  const [priceHistory, setPriceHistory] = useState<Array<{
    invoiceDate: string; invoiceNumber: string; supplierName: string;
    qtyPurchased: number; unitPrice: number; lineTotal: number
  }>>([])
  const [editMode,     setEditMode]     = useState(false)
  const [editForm,     setEditForm]     = useState<EditForm>({
    itemName: '', category: '', supplierId: '', supplierName: '',
    storageAreaId: '', storageAreaName: '', purchaseUnit: 'case',
    qtyPerPurchaseUnit: '1', purchasePrice: '0',
    packSize: '1', packUOM: 'each', countUOM: 'each',
    stockOnHand: '0', isActive: true, allergens: [],
  })

  const fetchItems = useCallback(() => {
    const p = new URLSearchParams()
    if (search)         p.set('search', search)
    if (catFilter)      p.set('category', catFilter)
    if (supplierFilter) p.set('supplierId', supplierFilter)
    fetch(`/api/inventory?${p}`).then(r => r.json()).then(setItems)
  }, [search, catFilter, supplierFilter])

  useEffect(() => { fetchItems() }, [fetchItems])

  // Deep-link: ?item=id opens that item's drawer; ?orderList=1 opens the order list
  useEffect(() => {
    const itemId    = searchParams.get('item')
    const orderList = searchParams.get('orderList')
    if (orderList === '1') {
      setShowOrderList(true)
    }
    if (itemId) {
      fetch('/api/inventory').then(r => r.json()).then((all: InventoryItem[]) => {
        const match = all.find(i => i.id === itemId)
        if (match) setSelected(match)
      })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // run once on mount

  // Fetch price history whenever an item is selected
  useEffect(() => {
    if (!selected) { setPriceHistory([]); return }
    fetch(`/api/inventory/${selected.id}/price-history`)
      .then(r => r.json())
      .then(setPriceHistory)
      .catch(() => setPriceHistory([]))
  }, [selected])

  useEffect(() => {
    fetch('/api/suppliers').then(r => r.json()).then(setSuppliers)
    fetch('/api/storage-areas').then(r => r.json()).then(setStorageAreas)
    fetch('/api/categories').then(r => r.json()).then(setCategories)
    fetch('/api/count/sessions').then(r => r.json()).then((sessions: Array<{ status: string; totalCountedValue: number; label: string; sessionDate: string; finalizedAt: string | null }>) => {
      const finalized = sessions.filter(s => s.status === 'FINALIZED').sort((a, b) =>
        new Date(b.finalizedAt ?? b.sessionDate).getTime() - new Date(a.finalizedAt ?? a.sessionDate).getTime()
      )
      if (finalized.length > 0) {
        setLastCount({
          totalCountedValue: parseFloat(String(finalized[0].totalCountedValue)),
          label: finalized[0].label,
          sessionDate: finalized[0].sessionDate,
        })
      }
    })
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
      case 'outOfStock': return items.filter(i => parseFloat(String(i.stockOnHand)) <= 0)
      case 'active':     return items.filter(i => i.isActive)
      case 'inactive':   return items.filter(i => !i.isActive)
      default:           return items
    }
  }, [items, activePill, catNames])

  // Column sort: first click → smart default direction; same column → flip direction
  const toggleColSort = (col: ColKey) => {
    setColSort(prev => {
      if (!prev || prev.col !== col) return { col, dir: COL_DEFAULT_DIR[col] }
      return { col, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
    })
  }

  const invValue = (i: InventoryItem) =>
    parseFloat(String(i.stockOnHand)) * parseFloat(String(i.conversionFactor)) * parseFloat(String(i.pricePerBaseUnit))

  // Sort
  const sortedItems = useMemo(() => {
    const copy = [...pillFiltered]
    const dir   = colSort?.dir === 'asc' ? 1 : -1

    // Per-column comparator (applied to both modes)
    const byCol = (col: ColKey) => (a: InventoryItem, b: InventoryItem): number => {
      switch (col) {
        case 'item':     return a.itemName.localeCompare(b.itemName) * dir
        case 'category': return (a.category.localeCompare(b.category) || a.itemName.localeCompare(b.itemName)) * dir
        case 'supplier': return ((a.supplier?.name ?? '').localeCompare(b.supplier?.name ?? '')) * dir
        case 'price':    return (parseFloat(String(a.purchasePrice)) - parseFloat(String(b.purchasePrice))) * dir
        case 'stock':    return (parseFloat(String(a.stockOnHand))   - parseFloat(String(b.stockOnHand)))   * dir
        case 'value':    return (invValue(a) - invValue(b)) * dir
        default:         return 0
      }
    }

    if (sortBy === 'category') {
      // Always keep category groups together; sort items *within* each group by active column
      const itemSort = colSort ? byCol(colSort.col) : (a: InventoryItem, b: InventoryItem) => a.itemName.localeCompare(b.itemName)
      return copy.sort((a, b) => {
        const ia = catNames.indexOf(a.category), ib = catNames.indexOf(b.category)
        const ci = (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib)
        return ci !== 0 ? ci : itemSort(a, b)
      })
    }

    // Flat mode — sort entirely by active column, default A-Z by name
    if (colSort) return copy.sort(byCol(colSort.col))
    return copy.sort((a, b) => a.itemName.localeCompare(b.itemName))
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

  const executeBulkAllergen = async (allergens: string[], mode: 'add' | 'replace') => {
    setShowBulkAllergen(false)
    await fetch('/api/inventory/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: Array.from(checkedIds), action: 'assignAllergens', value: { allergens, mode } }),
    })
    fetchItems()
    setCheckedIds(new Set())
  }

  const syncAllPrepd = async () => {
    setSyncingPrepd(true)
    await fetch('/api/inventory/sync-prepd', { method: 'POST' })
    fetchItems()
    setSyncingPrepd(false)
  }

  const handleToggleActive = async (e: React.MouseEvent, item: InventoryItem) => {
    e.stopPropagation()
    setItems(prev => prev.map(i => i.id === item.id ? { ...i, isActive: !i.isActive } : i))
    await fetch('/api/inventory/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [item.id], action: item.isActive ? 'deactivate' : 'activate' }),
    })
    fetchItems()
  }

  const handleDeleteItem = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    setConfirmDeleteId(null)
    await fetch(`/api/inventory/${id}`, { method: 'DELETE' })
    setItems(prev => prev.filter(i => i.id !== id))
    if (selected?.id === id) setSelected(null)
  }

  const markCounted = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    // Optimistic update — turn green immediately
    setItems(prev => prev.map(it =>
      it.id === id ? { ...it, lastCountDate: new Date().toISOString() } : it
    ))
    setCountedFlash(id)
    setTimeout(() => setCountedFlash(null), 2000)
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
        isActive: editForm.isActive,
        allergens: editForm.allergens,
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
    const itemValue = invValue(item)
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
          <AllergenBadges allergens={item.allergens ?? []} size="xs" />
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
          <div className="text-sm font-medium text-orange-600">{formatCurrency(parseFloat(String(item.purchasePrice)))}<span className="text-gray-400 font-normal text-xs">/{item.purchaseUnit}</span></div>
          <div className="text-xs text-gray-400">{formatUnitPrice(parseFloat(String(item.pricePerBaseUnit)))} / {item.baseUnit}</div>
        </td>
        <td className="px-3 py-3 text-right text-sm text-gray-700">
          {parseFloat(String(item.stockOnHand)).toFixed(1)}
          <span className="text-xs text-gray-400 ml-1">{item.countUOM || item.purchaseUnit}</span>
        </td>
        <td className="px-3 py-3 text-right">
          <span className={`text-sm font-mono font-semibold ${itemValue > 10 ? 'text-gray-800' : 'text-gray-500'}`}>
            {formatCurrency(itemValue)}
          </span>
        </td>
        <td className="px-3 py-3 text-center hidden sm:table-cell">
          <StockStatus stock={parseFloat(String(item.stockOnHand))} />
        </td>
        <td className="px-3 py-3 text-center" onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-center gap-2">
            {/* Active / inactive toggle */}
            <button
              onClick={e => handleToggleActive(e, item)}
              title={item.isActive ? 'Deactivate item' : 'Activate item'}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${item.isActive ? 'bg-green-500' : 'bg-gray-200'}`}
            >
              <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${item.isActive ? 'translate-x-4' : 'translate-x-0'}`} />
            </button>

            {/* Delete with inline confirm */}
            {confirmDeleteId === item.id ? (
              <div className="flex items-center gap-1">
                <button
                  onClick={e => handleDeleteItem(e, item.id)}
                  className="text-xs font-medium text-red-600 hover:text-red-700 px-1 py-0.5 rounded hover:bg-red-50 transition-colors"
                >Yes</button>
                <button
                  onClick={e => { e.stopPropagation(); setConfirmDeleteId(null) }}
                  className="text-xs text-gray-400 hover:text-gray-600 px-1 py-0.5 rounded hover:bg-gray-50 transition-colors"
                >No</button>
              </div>
            ) : (
              <button
                onClick={e => { e.stopPropagation(); setConfirmDeleteId(item.id) }}
                title="Delete item"
                className="text-gray-300 hover:text-red-500 transition-colors"
              >
                <Trash2 size={13} />
              </button>
            )}
          </div>
        </td>
      </tr>
    )
  }

  const renderMobileRow = (item: InventoryItem) => {
    const inStock = parseFloat(String(item.stockOnHand)) > 0
    return (
      <div
        key={`m-${item.id}`}
        onClick={() => setSelected(item)}
        className={`flex items-center gap-3 px-4 py-2.5 border-b border-gray-50 cursor-pointer active:bg-gray-50 transition-colors ${
          !inStock ? 'bg-orange-50/50' : ''
        } ${!item.isActive ? 'opacity-50' : ''}`}
      >
        <div className={`w-2 h-2 rounded-full shrink-0 ${inStock ? 'bg-green-500' : 'bg-orange-400'}`} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-gray-900 truncate">{item.itemName}</div>
          {item.allergens && item.allergens.length > 0 && (
            <div className="mt-0.5">
              <AllergenBadges allergens={item.allergens} size="xs" />
            </div>
          )}
        </div>
        <div className="text-right shrink-0">
          <div className="text-sm font-bold text-gray-900">
            {formatCurrency(parseFloat(String(item.purchasePrice)))}
            <span className="text-[10px] font-normal text-gray-400">/{item.purchaseUnit}</span>
          </div>
          <div className={`text-[11px] ${inStock ? 'text-gray-500' : 'text-orange-500'}`}>
            {parseFloat(String(item.stockOnHand)).toFixed(1)} {item.countUOM || item.baseUnit}
            {!inStock && ' · out of stock'}
          </div>
        </div>
        <ChevronRight size={14} className="text-gray-300 shrink-0" />
      </div>
    )
  }

  const pills: { key: FilterPill; label: string }[] = [
    { key: 'all',        label: 'All Items' },
    { key: 'active',     label: 'Active' },
    { key: 'inactive',   label: 'Inactive' },
    { key: 'counted',    label: 'Counted This Week' },
    { key: 'notCounted', label: 'Not Counted' },
    { key: 'highValue',  label: 'High Value' },
    { key: 'outOfStock', label: 'Out of Stock' },
  ]

  return (
    <div className="space-y-4">
      {/* Mobile header */}
      <div className="flex sm:hidden items-center gap-2">
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold text-gray-900 leading-tight">Inventory</h1>
          <p className="text-xs text-gray-400">{items.length} items</p>
        </div>
        <button
          onClick={() => { setShowOrderList(true); setOrderQtys({}) }}
          className="flex items-center justify-center w-9 h-9 bg-green-50 border border-green-200 text-green-700 rounded-xl"
        >
          <ShoppingCart size={16} />
        </button>
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-1.5 bg-blue-600 text-white px-3 h-9 rounded-xl text-sm font-semibold"
        >
          <Plus size={15} /> Add
        </button>
        <div className="relative">
          <button
            onClick={() => setShowMobileOverflow(v => !v)}
            className="flex items-center justify-center w-9 h-9 bg-gray-50 border border-gray-200 text-gray-600 rounded-xl"
          >
            <MoreHorizontal size={16} />
          </button>
          {showMobileOverflow && (
            <div className="absolute right-0 top-full mt-1 w-44 bg-white border border-gray-200 rounded-xl shadow-lg z-50 overflow-hidden">
              <button
                onClick={() => { window.location.href = '/api/inventory/export'; setShowMobileOverflow(false) }}
                className="flex items-center gap-2 w-full px-4 py-3 text-sm text-gray-700 hover:bg-gray-50 border-b border-gray-100"
              >
                <Download size={14} /> Export CSV
              </button>
              <button
                onClick={() => { syncAllPrepd(); setShowMobileOverflow(false) }}
                disabled={syncingPrepd}
                className="flex items-center gap-2 w-full px-4 py-3 text-sm text-purple-700 hover:bg-purple-50 disabled:opacity-50"
              >
                {syncingPrepd ? '⟳ Syncing…' : '⟳ Sync PREPD'}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Header */}
      <div className="hidden sm:flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Inventory</h1>
          <p className="text-sm text-gray-500 mt-0.5">Master database &middot; weekly stock counting &middot; cost control</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={syncAllPrepd}
            disabled={syncingPrepd}
            title="Re-sync all PREPD item prices from their recipes"
            className="flex items-center gap-2 border border-purple-200 bg-purple-50 text-purple-700 px-3 py-2 rounded-lg text-sm hover:bg-purple-100 transition-colors disabled:opacity-50"
          >
            {syncingPrepd ? '⟳ Syncing…' : '⟳ Sync PREPD'}
          </button>
          <button
            onClick={() => { setShowOrderList(true); setOrderQtys({}) }}
            className="flex items-center gap-2 border border-green-200 bg-green-50 text-green-700 px-3 py-2 rounded-lg text-sm hover:bg-green-100 transition-colors"
          >
            <ShoppingCart size={15} /> Order List
          </button>
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

      {/* Mobile KPI strip */}
      <div className="flex sm:hidden gap-3 overflow-x-auto pb-0.5" style={{ scrollbarWidth: 'none' }}>
        <div className="flex-shrink-0 bg-blue-50 rounded-xl px-3 py-2.5 min-w-[110px]">
          <div className="text-[9px] font-bold text-blue-500 uppercase tracking-wide">Stock Value</div>
          <div className="text-lg font-extrabold text-blue-700 mt-0.5">{formatCurrency(kpis.totalValue)}</div>
        </div>
        <div className="flex-shrink-0 bg-green-50 rounded-xl px-3 py-2.5 min-w-[100px]">
          <div className="text-[9px] font-bold text-green-600 uppercase tracking-wide">Counted</div>
          <div className="text-lg font-extrabold text-green-700 mt-0.5">
            {kpis.counted} <span className="text-xs font-medium text-green-400">/ {kpis.activeCount}</span>
          </div>
        </div>
        <div className="flex-shrink-0 bg-orange-50 rounded-xl px-3 py-2.5 min-w-[100px]">
          <div className="text-[9px] font-bold text-orange-500 uppercase tracking-wide">Uncounted</div>
          <div className="text-lg font-extrabold text-orange-600 mt-0.5">{kpis.notCounted}</div>
        </div>
        <div className="flex-shrink-0 bg-gray-50 rounded-xl px-3 py-2.5 min-w-[80px]">
          <div className="text-[9px] font-bold text-gray-500 uppercase tracking-wide">Active</div>
          <div className="text-lg font-extrabold text-gray-700 mt-0.5">{kpis.activeCount}</div>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="hidden sm:grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {[
          { label: 'CURRENT STOCK VALUE',  value: formatCurrency(kpis.totalValue), sub: `${kpis.activeCount} active items`, accent: 'text-blue-600',   alert: false },
          { label: 'PREVIOUS STOCK VALUE', value: lastCount ? formatCurrency(lastCount.totalCountedValue) : '$0.00', sub: lastCount ? `${lastCount.label} · ${new Date(lastCount.sessionDate).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}` : 'No prior count', accent: lastCount ? 'text-purple-600' : 'text-gray-400', alert: false },
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

      {/* Mobile filter pills */}
      <div className="flex sm:hidden gap-2 overflow-x-auto pb-0.5" style={{ scrollbarWidth: 'none' }}>
        {pills.map(p => (
          <button
            key={p.key}
            onClick={() => setActivePill(p.key)}
            className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
              activePill === p.key ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600'
            }`}
          >
            {p.label}
          </button>
        ))}
        <button
          onClick={() => setShowMobileSortSheet(true)}
          className="flex-shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-semibold bg-white border border-gray-200 text-gray-600"
        >
          <ChevronsUpDown size={11} /> Sort
        </button>
        <button
          onClick={() => setShowMobileFilterSheet(true)}
          className="flex-shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-semibold bg-white border border-gray-200 text-gray-600"
        >
          ▽ Filter
        </button>
      </div>

      {/* Filter Pills */}
      <div className="hidden sm:flex gap-1.5 flex-wrap">
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
        <select value={catFilter} onChange={e => setCatFilter(e.target.value)} className="hidden sm:block border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
          <option value="">All Categories</option>
          {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
        </select>
        <select value={supplierFilter} onChange={e => setSupplierFilter(e.target.value)} className="hidden sm:block border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
          <option value="">All Suppliers</option>
          {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <div className="hidden sm:flex items-center gap-0.5 border border-gray-200 rounded-lg p-0.5 bg-white shrink-0">
          {([['category','⊞ Grouped'],['all','≡ Flat']] as [SortMode, string][]).map(([mode, label]) => (
            <button
              key={mode}
              onClick={() => setSortBy(mode)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                sortBy === mode
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
              }`}
            >
              {label}
            </button>
          ))}
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
                <button
                  onClick={() => setShowBulkAllergen(true)}
                  className="px-3 py-1.5 bg-white border border-gray-200 text-xs rounded-lg hover:bg-gray-50 flex items-center gap-1"
                >
                  Assign Allergens
                </button>
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

      {/* Mobile Sort Sheet */}
      {showMobileSortSheet && (
        <div className="fixed inset-0 z-50 flex items-end sm:hidden" onClick={() => setShowMobileSortSheet(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <div className="relative bg-white w-full rounded-t-2xl p-5 pb-8" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-gray-900">Sort by</h3>
              <button onClick={() => setShowMobileSortSheet(false)}><X size={18} className="text-gray-400" /></button>
            </div>
            {/* Grouped / Flat */}
            <div className="mb-4">
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">View</div>
              <div className="flex gap-2">
                {([['category', '⊞ Grouped'], ['all', '≡ Flat']] as [SortMode, string][]).map(([mode, label]) => (
                  <button
                    key={mode}
                    onClick={() => setSortBy(mode)}
                    className={`flex-1 py-2.5 rounded-xl text-sm font-medium border transition-colors ${
                      sortBy === mode ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-200'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {/* Column sort */}
            <div>
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Sort column</div>
              <div className="space-y-1">
                {([
                  ['item',     'Item name'],
                  ['price',    'Purchase price'],
                  ['stock',    'Stock on hand'],
                  ['value',    'Inventory value'],
                  ['supplier', 'Supplier'],
                ] as [ColKey, string][]).map(([col, label]) => (
                  <button
                    key={col}
                    onClick={() => { toggleColSort(col); setShowMobileSortSheet(false) }}
                    className={`flex items-center justify-between w-full px-4 py-3 rounded-xl text-sm transition-colors ${
                      colSort?.col === col ? 'bg-blue-50 text-blue-700 font-semibold' : 'bg-gray-50 text-gray-700'
                    }`}
                  >
                    <span>{label}</span>
                    {colSort?.col === col && (
                      <span className="text-xs">{colSort.dir === 'asc' ? '↑ A–Z / Low–High' : '↓ Z–A / High–Low'}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Mobile Filter Sheet */}
      {showMobileFilterSheet && (
        <div className="fixed inset-0 z-50 flex items-end sm:hidden" onClick={() => setShowMobileFilterSheet(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <div className="relative bg-white w-full rounded-t-2xl p-5 pb-8" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-gray-900">Filter</h3>
              <button onClick={() => setShowMobileFilterSheet(false)}><X size={18} className="text-gray-400" /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Category</label>
                <select
                  value={catFilter}
                  onChange={e => setCatFilter(e.target.value)}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">All Categories</option>
                  {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Supplier</label>
                <select
                  value={supplierFilter}
                  onChange={e => setSupplierFilter(e.target.value)}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">All Suppliers</option>
                  {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <button
                onClick={() => { setCatFilter(''); setSupplierFilter(''); setShowMobileFilterSheet(false) }}
                className="w-full py-2.5 border border-gray-200 rounded-xl text-sm text-gray-600 font-medium"
              >
                Clear filters
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Order List Modal */}
      {showOrderList && (() => {
        const activeItems = items.filter(i => i.isActive && i.category !== 'PREPD')
        const outOfStock  = activeItems.filter(i => parseFloat(String(i.stockOnHand)) <= 0)
        const bySupplier  = new Map<string, { supplierName: string; items: InventoryItem[] }>()
        for (const item of outOfStock) {
          const key  = item.supplierId ?? '__none__'
          const name = item.supplier?.name ?? 'No Supplier'
          if (!bySupplier.has(key)) bySupplier.set(key, { supplierName: name, items: [] })
          bySupplier.get(key)!.items.push(item)
        }
        const copyText = Array.from(bySupplier.values()).map(({ supplierName, items: grp }) =>
          `${supplierName}:\n` + grp.map(i => `  - ${i.itemName}  ${orderQtys[i.id] ?? ''}  ${i.purchaseUnit}  @${formatCurrency(parseFloat(String(i.purchasePrice)))}`).join('\n')
        ).join('\n\n')
        return (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4">
            <div className="bg-white w-full sm:max-w-xl rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[85vh]">
              <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-gray-100 shrink-0">
                <div className="flex items-center gap-2">
                  <ShoppingCart size={18} className="text-green-600" />
                  <h2 className="font-semibold text-gray-900">Order List</h2>
                  <span className="text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full">{outOfStock.length} items</span>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => { navigator.clipboard.writeText(copyText) }}
                    className="flex items-center gap-1.5 text-xs border border-gray-200 px-2.5 py-1.5 rounded-lg text-gray-600 hover:bg-gray-50">
                    <Copy size={12} /> Copy
                  </button>
                  <button onClick={() => setShowOrderList(false)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400"><X size={18} /></button>
                </div>
              </div>
              <div className="overflow-y-auto flex-1 p-4 space-y-4">
                {outOfStock.length === 0 ? (
                  <div className="text-center py-12 text-gray-400 text-sm">All active items are in stock</div>
                ) : (
                  Array.from(bySupplier.values()).map(({ supplierName, items: grp }) => (
                    <div key={supplierName}>
                      <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{supplierName}</div>
                      <div className="space-y-1">
                        {grp.map(item => (
                          <div key={item.id} className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2">
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium text-gray-800 truncate">{item.itemName}</div>
                              <div className="text-xs text-gray-400">{formatCurrency(parseFloat(String(item.purchasePrice)))} / {item.purchaseUnit}</div>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <input type="number" min="1" step="1"
                                value={orderQtys[item.id] ?? ''}
                                onChange={e => setOrderQtys(q => ({ ...q, [item.id]: e.target.value }))}
                                placeholder="qty"
                                className="w-14 border border-gray-200 rounded-lg px-2 py-1 text-sm text-center text-gray-900 focus:outline-none focus:ring-2 focus:ring-green-400" />
                              <span className="text-xs text-gray-500">{item.purchaseUnit}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )
      })()}

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
                {/* Checkbox */}
                <th className="pl-4 py-3 pr-2 w-8">
                  <button onClick={toggleAll} className="text-gray-400 hover:text-blue-600">
                    {checkedIds.size === sortedItems.length && sortedItems.length > 0
                      ? <CheckSquare size={15} className="text-blue-600" /> : <Square size={15} />}
                  </button>
                </th>

                {/* Item — always sortable */}
                <SortTh col="item" label="Item" colSort={colSort} onSort={toggleColSort} className="text-left" />

                {/* Category — only visible in flat mode, sortable */}
                {sortBy === 'all' && (
                  <SortTh col="category" label="Category" colSort={colSort} onSort={toggleColSort} className="text-left hidden sm:table-cell" />
                )}

                {/* Supplier — sortable, hidden on small screens */}
                <SortTh col="supplier" label="Supplier" colSort={colSort} onSort={toggleColSort} className="text-left hidden md:table-cell" />

                {/* Purchase Price — sortable */}
                <SortTh col="price" label="Purchase Price" colSort={colSort} onSort={toggleColSort} className="text-right" />

                {/* Current Stock — sortable */}
                <SortTh col="stock" label="Current Stock" colSort={colSort} onSort={toggleColSort} className="text-right" />

                {/* Inv Value — sortable */}
                <SortTh col="value" label="Inv Value" colSort={colSort} onSort={toggleColSort} className="text-right" />

                <th className="text-center px-3 py-3 font-medium text-gray-500 text-xs hidden sm:table-cell">Status</th>
                <th className="text-center px-3 py-3 font-medium text-gray-500 text-xs w-24">Active</th>
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
                        isActive: selected.isActive,
                        allergens: selected.allergens ?? [],
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
                {/* PREPD items: price fields are managed by recipe */}
                {selected?.recipe && (
                  <div className="bg-purple-50 border border-purple-200 rounded-lg px-3 py-2 text-xs text-purple-700 flex items-start gap-2">
                    <span className="text-purple-400 mt-0.5">⟳</span>
                    <span><strong>Price is managed by recipe:</strong> {selected.recipe.name}. Edit the recipe to change costs. You can only change Count UOM and stock fields here.</span>
                  </div>
                )}

                {/* Purchase structure — hidden for PREPD items */}
                {!selected?.recipe && (
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
                    <div className="col-span-2">
                      <label className="block text-xs font-medium text-gray-600 mb-1">Purchase Price ($)</label>
                      <input type="number" step="any" value={editForm.purchasePrice}
                        onChange={e => setEditForm(f => ({ ...f, purchasePrice: e.target.value }))}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    </div>
                  </div>
                )}

                {/* Stock + Count fields — always shown */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      Count UOM
                      {selected?.recipe && (
                        <span className="ml-1 text-purple-500 font-normal">
                          ({getUnitDimension(selected.baseUnit)}-compatible)
                        </span>
                      )}
                    </label>
                    <select value={editForm.countUOM} onChange={e => setEditForm(f => ({ ...f, countUOM: e.target.value }))}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
                      {(selected?.recipe
                        ? compatibleCountUnits(selected.baseUnit)
                        : COUNT_UOMS
                      ).map(u => <option key={u}>{u}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Stock On Hand</label>
                    <input type="number" step="any" value={editForm.stockOnHand}
                      onChange={e => setEditForm(f => ({ ...f, stockOnHand: e.target.value }))}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                </div>

                {/* Allergens — Health Canada Big 9 */}
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
                  const isPrep = !!selected?.recipe
                  const pp   = parseFloat(editForm.purchasePrice) || 0
                  const qty  = parseFloat(editForm.qtyPerPurchaseUnit) || 1
                  const ps   = parseFloat(editForm.packSize) || 1
                  const pu   = editForm.packUOM
                  const cu   = editForm.countUOM
                  const bu   = isPrep ? (selected?.baseUnit ?? deriveBaseUnit(pu)) : deriveBaseUnit(pu)
                  const ppbu = isPrep
                    ? parseFloat(String(selected?.pricePerBaseUnit ?? 0))
                    : calcPricePerBaseUnit(pp, qty, ps, pu)
                  const cf = isPrep
                    ? parseFloat(String(selected?.conversionFactor ?? 1))
                    : calcConversionFactor(cu, qty, ps, pu)
                  return (
                    <div className={`rounded-lg p-3 space-y-1.5 ${isPrep ? 'bg-purple-50' : 'bg-blue-50'}`}>
                      <div className={`text-xs font-semibold uppercase tracking-wide ${isPrep ? 'text-purple-700' : 'text-blue-700'}`}>
                        {isPrep ? 'Recipe-derived cost' : 'Auto-calculated'}
                      </div>
                      <div className="flex items-baseline gap-1.5">
                        <span className={`text-xs ${isPrep ? 'text-purple-600' : 'text-blue-600'}`}>Price per {bu}:</span>
                        <span className={`text-lg font-bold ${isPrep ? 'text-purple-700' : 'text-blue-700'}`}>{formatUnitPrice(ppbu)}</span>
                      </div>
                      <div className="flex items-baseline gap-1.5">
                        <span className={`text-xs ${isPrep ? 'text-purple-600' : 'text-blue-600'}`}>1 {cu} =</span>
                        <span className={`font-semibold ${isPrep ? 'text-purple-700' : 'text-blue-700'}`}>{cf.toFixed(4)} {bu}</span>
                      </div>
                      <div className={`text-xs ${isPrep ? 'text-purple-500' : 'text-blue-500'}`}>
                        {isPrep
                          ? `Recipe total ÷ ${ps.toLocaleString()} ${bu} yield = ${formatUnitPrice(ppbu)}/${bu}`
                          : `$${pp.toFixed(2)} ÷ (${qty} × ${ps} ${pu}) = ${formatUnitPrice(ppbu)}/${bu}`
                        }
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
                  {selected.allergens && selected.allergens.length > 0 && selected.allergens.map(a => (
                    <span key={a} className="px-2 py-0.5 rounded-full text-xs bg-orange-100 text-orange-700 font-medium">⚠ {a}</span>
                  ))}
                  {selected.isActive
                    ? <span className="px-2 py-0.5 rounded-full text-xs bg-green-100 text-green-700 font-medium">Active</span>
                    : <span className="px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-500">Inactive</span>
                  }
                </div>
                <div className="grid grid-cols-2 gap-3 text-sm">
                {(() => {
                  const rows: [string, string][] = selected.recipe ? [
                    ['Supplier',       selected.supplier?.name || '\u2014'],
                    ['Storage Area',   selected.storageArea?.name || '\u2014'],
                    ['Linked Recipe',  selected.recipe.name],
                    ['Yield',          `${parseFloat(String(selected.packSize ?? 1)).toLocaleString()} ${selected.baseUnit}`],
                    ['Batch Cost',     formatCurrency(parseFloat(String(selected.purchasePrice)))],
                    ['Count UOM',      selected.countUOM ?? selected.baseUnit],
                    ['Stock On Hand',  `${parseFloat(String(selected.stockOnHand)).toFixed(2)} ${selected.countUOM ?? ''}`],
                    ['Last Count',     selected.lastCountDate ? new Date(selected.lastCountDate).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) : 'Never'],
                    ['Last Count Qty', selected.lastCountQty != null ? `${parseFloat(String(selected.lastCountQty)).toFixed(2)} ${selected.countUOM ?? ''}` : '\u2014'],
                  ] : [
                    ['Supplier',       selected.supplier?.name || '\u2014'],
                    ['Storage Area',   selected.storageArea?.name || '\u2014'],
                    ['Purchase Unit',  selected.purchaseUnit],
                    ['Qty per Case',   parseFloat(String(selected.qtyPerPurchaseUnit)).toFixed(0)],
                    ['Purchase Price', formatCurrency(parseFloat(String(selected.purchasePrice)))],
                    ['Pack Size',      `${parseFloat(String(selected.packSize ?? 1))} ${selected.packUOM ?? 'each'}`],
                    ['Count UOM',      selected.countUOM ?? 'each'],
                    ['Stock On Hand',  `${parseFloat(String(selected.stockOnHand)).toFixed(2)} ${selected.countUOM ?? ''}`],
                    ['Last Count',     selected.lastCountDate ? new Date(selected.lastCountDate).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) : 'Never'],
                    ['Last Count Qty', selected.lastCountQty != null ? `${parseFloat(String(selected.lastCountQty)).toFixed(2)} ${selected.countUOM ?? ''}` : '\u2014'],
                  ]
                  return rows.map(([label, value]) => (
                    <div key={label} className="bg-gray-50 rounded-lg p-3">
                      <div className="text-xs text-gray-500">{label}</div>
                      <div className="font-medium text-gray-800 mt-0.5">{value}</div>
                    </div>
                  ))
                })()}
                  <div className={`rounded-lg p-3 col-span-2 mt-0 ${selected.recipe ? 'bg-purple-50' : 'bg-blue-50'}`}>
                    {selected.recipe && (
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <span className="text-[10px] font-bold uppercase tracking-wide bg-purple-200 text-purple-800 px-1.5 py-0.5 rounded-full">Recipe</span>
                        <span className="text-xs text-purple-700 font-medium">{selected.recipe.name}</span>
                      </div>
                    )}
                    <div className={`text-xs font-medium ${selected.recipe ? 'text-purple-600' : 'text-blue-600'}`}>
                      Price per {selected.baseUnit}
                    </div>
                    <div className={`text-lg font-bold mt-0.5 ${selected.recipe ? 'text-purple-700' : 'text-blue-700'}`}>
                      {formatUnitPrice(parseFloat(String(selected.pricePerBaseUnit)))} / {selected.baseUnit}
                    </div>
                    <div className={`text-xs mt-1 ${selected.recipe ? 'text-purple-500' : 'text-blue-500'}`}>
                      {selected.recipe
                        ? <>Recipe total {formatCurrency(parseFloat(String(selected.purchasePrice)))} ÷ {parseFloat(String(selected.packSize ?? 1)).toLocaleString()} {selected.baseUnit} yield</>
                        : <>{formatCurrency(parseFloat(String(selected.purchasePrice)))} ÷ ({parseFloat(String(selected.qtyPerPurchaseUnit))} × {parseFloat(String(selected.packSize ?? 1))} {selected.packUOM ?? 'each'})</>
                      }
                      &nbsp;|&nbsp; 1 {selected.countUOM ?? 'each'} = {parseFloat(String(selected.conversionFactor)).toFixed(4)} {selected.baseUnit}
                    </div>
                  </div>
                </div>{/* end grid */}

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
          </div>
        </div>
      )}

      {showBulkAllergen && (
        <BulkAllergenModal
          count={checkedIds.size}
          initialAllergens={Array.from(new Set(
            items.filter(i => checkedIds.has(i.id)).flatMap(i => i.allergens ?? [])
          ))}
          onClose={() => setShowBulkAllergen(false)}
          onApply={executeBulkAllergen}
        />
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
