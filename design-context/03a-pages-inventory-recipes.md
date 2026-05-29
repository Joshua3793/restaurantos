# Fergie's OS — Pages — inventory, recipes, menu, prep, cost

Inventory, recipe book, menu, prep, cost pages.


---

## `src/app/inventory/page.tsx`

```tsx
'use client'
import React, { useEffect, useState, useCallback, useMemo, useRef, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { formatCurrency, formatUnitPrice, CATEGORY_COLORS, PACK_UOMS, COUNT_UOMS, BASE_UNITS, PURCHASE_UNITS, QTY_UOMS, calcPricePerBaseUnit, calcConversionFactor, deriveBaseUnit, getUnitDimension, compatibleCountUnits } from '@/lib/utils'
import { convertCountQtyToBase, convertBaseToCountUom, getCountableUoms, resolveCountUom } from '@/lib/count-uom'
import { CategoryBadge } from '@/components/CategoryBadge'
import { StockStatus } from '@/components/StockStatus'
import { RcAllocationPanel } from '@/components/inventory/RcAllocationPanel'
import { InventoryItemDrawer } from '@/components/inventory/InventoryItemDrawer'
import { useRc } from '@/contexts/RevenueCenterContext'
import { useDrawer } from '@/contexts/DrawerContext'
import { AllergenBadges, AllergenToggles, BulkAllergenModal } from '@/components/AllergenBadges'
import { InventoryImportModal } from '@/components/inventory/InventoryImportModal'
import {
  Search, Plus, X, Download, Loader2,
  CheckSquare, Square, ChevronDown, ChevronRight, AlertCircle,
  ChevronsUpDown, ChevronUp, Pencil, Trash2, ShoppingCart, Copy, UploadCloud,
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
  rcStock?: number        // set when viewing a non-default RC (from StockAllocation)
  parLevel?:   number | null  // in countUOM; null = no par set
  reorderQty?: number | null  // in purchaseUnit; null = auto-calculate
  barcode?:    string | null
  allergens?: string[]
  isActive: boolean
  qtyUOM?: string | null
  innerQty?: number | string | null
  needsReview?: boolean | null
  lastCountDate?: string | null; lastCountQty?: number | null
  recipe?: { id: string; name: string } | null
}

type SortMode  = 'category' | 'all'
type ColKey    = 'item' | 'category' | 'supplier' | 'price' | 'stock' | 'value'
type ColDir    = 'asc' | 'desc'
type FilterPill = 'all' | 'counted' | 'notCounted' | 'highValue' | 'outOfStock' | 'lowStock' | 'active' | 'inactive'

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
}

// First-click direction per column: text cols go A→Z, numeric cols go high→low
const COL_DEFAULT_DIR: Record<ColKey, ColDir> = {
  item: 'asc', category: 'asc', supplier: 'asc',
  price: 'desc', stock: 'desc', value: 'desc',
}

const defaultForm = {
  itemName: '', category: '', supplierId: '', storageAreaId: '',
  purchaseUnit: 'case', qtyPerPurchaseUnit: '1', purchasePrice: '0',
  packSize: '', packUOM: 'each', qtyUOM: 'each', countUOM: 'each',
  baseUnit: 'g', stockOnHand: '0',
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
        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold"
      />
      {open && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
          {filtered.length === 0 && !query && <div className="px-3 py-2 text-sm text-gray-400">No options</div>}
          {filtered.map(item => (
            <button key={item.id} type="button"
              onMouseDown={() => { onSelect(item.id, item.name); setQuery(''); setOpen(false) }}
              className="block w-full text-left px-3 py-2 text-sm hover:bg-gold/10"
            >{item.name}</button>
          ))}
          {!exactMatch && query && onAddNew && (
            <button type="button"
              onMouseDown={async () => {
                const r = await onAddNew(query)
                onSelect(r.id, r.name); setQuery(''); setOpen(false)
              }}
              className="block w-full text-left px-3 py-2 text-sm text-gold hover:bg-gold/10 border-t border-gray-100"
            >+ Add &ldquo;{query}&rdquo;</button>
          )}
        </div>
      )}
    </div>
  )
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
  const weightVol = ['kg','g','lb','oz','l','ml']
  if (weightVol.includes(qtyUOM)) return `${pu} of ${qty} ${qtyUOM}`
  const hasWeight = packSize > 0 && packUOM && !['each',''].includes(packUOM)
  if (qtyUOM === 'pack' && innerQty) {
    return hasWeight
      ? `${pu} of ${qty} packs × ${innerQty} × ${packSize}${packUOM}`
      : `${pu} of ${qty} packs × ${innerQty} each`
  }
  return hasWeight
    ? `${pu} of ${qty} × ${packSize}${packUOM} each`
    : `${pu} of ${qty} each`
}

function normalizePurchaseUnit(raw: string): string {
  if ((PURCHASE_UNITS as readonly string[]).includes(raw)) return raw
  const found = (PURCHASE_UNITS as readonly string[]).find(u => raw.toLowerCase().includes(u))
  return found ?? 'case'
}

function normalizeItem(item: InventoryItem): InventoryItem {
  const dims = { baseUnit: item.baseUnit, purchaseUnit: item.purchaseUnit, qtyPerPurchaseUnit: Number(item.qtyPerPurchaseUnit), qtyUOM: item.qtyUOM ?? 'each', innerQty: item.innerQty != null ? Number(item.innerQty) : null, packSize: Number(item.packSize ?? 1), packUOM: item.packUOM ?? 'each', countUOM: item.countUOM ?? 'each' }
  return { ...item, countUOM: resolveCountUom(dims) }
}

function isCountedThisWeek(item: InventoryItem) {
  if (!item.lastCountDate) return false
  const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7)
  return new Date(item.lastCountDate) >= weekAgo
}

function SortIcon({ col, colSort }: { col: ColKey; colSort: { col: ColKey; dir: ColDir } | null }) {
  if (!colSort || colSort.col !== col)
    return <ChevronsUpDown size={9} className="text-zinc-400 ml-[3px] inline-block shrink-0" />
  return colSort.dir === 'asc'
    ? <ChevronUp size={9} className="text-gold ml-[3px] inline-block shrink-0" />
    : <ChevronDown size={9} className="text-gold ml-[3px] inline-block shrink-0" />
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
        className={`inline-flex items-center font-mono text-[10.5px] tracking-[0.01em] rounded transition-colors cursor-pointer
          ${active ? 'text-gold font-semibold' : 'text-ink-3 hover:text-ink-2'}`}
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
  const { revenueCenters, activeRcId, activeRc } = useRc()
  const { setDrawerOpen } = useDrawer()
  const defaultRcId = useMemo(() => revenueCenters.find(rc => rc.isDefault)?.id ?? null, [revenueCenters])
  const [items,        setItems]        = useState<InventoryItem[]>([])
  const [suppliers,    setSuppliers]    = useState<Supplier[]>([])
  const [storageAreas, setStorageAreas] = useState<StorageArea[]>([])
  const [categories,   setCategories]   = useState<Category[]>([])
  const [search,       setSearch]       = useState('')
  const [catFilter,       setCatFilter]       = useState('')
  const [supplierFilter,  setSupplierFilter]  = useState('')
  const [areaFilter,      setAreaFilter]      = useState('')
  const [sortBy,       setSortBy]       = useState<SortMode>('category')
  const [colSort,      setColSort]      = useState<{ col: ColKey; dir: ColDir } | null>(null)
  const [activePill,   setActivePill]   = useState<FilterPill>('all')
  const [selected,     setSelected]     = useState<InventoryItem | null>(null)
  const [showAdd,      setShowAdd]      = useState(false)
  const [showImport,   setShowImport]   = useState(false)
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
  const [orderTab, setOrderTab] = useState<'all' | 'belowPar' | 'outOfStock'>('all')
  const [orderQtys,    setOrderQtys]    = useState<Record<string, string>>({})
  const [showMobileSortSheet,   setShowMobileSortSheet]   = useState(false)
  const [showMobileFilterSheet, setShowMobileFilterSheet] = useState(false)
  const [priceHistory, setPriceHistory] = useState<Array<{
    invoiceDate: string; invoiceNumber: string; supplierName: string;
    qtyPurchased: number; unitPrice: number; lineTotal: number
  }>>([])
  type MovementType = 'SALE' | 'WASTAGE' | 'PREP_IN' | 'PREP_OUT' | 'PURCHASE'
  interface StockMovement { id: string; date: string; type: MovementType; qty: number; unit: string; description: string }
  interface StockMovementsResponse {
    lastCount: { qty: number; unit: string; date: string | null }
    theoretical: { qty: number; unit: string }
    movements: StockMovement[]
  }
  const [stockMovements, setStockMovements] = useState<StockMovementsResponse | null>(null)
  const [editMode,     setEditMode]     = useState(false)
  const [editForm,     setEditForm]     = useState<EditForm>({
    itemName: '', category: '', supplierId: '', supplierName: '',
    storageAreaId: '', storageAreaName: '', purchaseUnit: 'case',
    qtyPerPurchaseUnit: '1', purchasePrice: '0',
    packSize: '', packUOM: 'each', countUOM: 'each',
    qtyUOM: 'each', innerQty: '',
    stockOnHand: '0', isActive: true, allergens: [], barcode: null,
  })
  const [filterNeedsReview, setFilterNeedsReview] = useState(false)

  const fetchItems = useCallback(() => {
    const p = new URLSearchParams()
    if (search)         p.set('search', search)
    if (catFilter)      p.set('category', catFilter)
    if (supplierFilter) p.set('supplierId', supplierFilter)
    if (areaFilter)     p.set('storageAreaId', areaFilter)
    if (activeRcId)     { p.set('rcId', activeRcId); if (activeRc?.isDefault) p.set('isDefault', 'true') }
    fetch(`/api/inventory?${p}`).then(r => r.json()).then((data: InventoryItem[]) => setItems(data.map(normalizeItem)))
  }, [search, catFilter, supplierFilter, areaFilter, activeRcId, activeRc])

  useEffect(() => { fetchItems() }, [fetchItems])

  useEffect(() => {
    setDrawerOpen(selected !== null)
    return () => setDrawerOpen(false)
  }, [selected, setDrawerOpen])

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
    if (!selected) { setPriceHistory([]); setStockMovements(null); return }
    fetch(`/api/inventory/${selected.id}/stock-movements`)
      .then(r => r.json()).then(setStockMovements).catch(() => setStockMovements(null))
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

  // Effective stock: for non-default RCs use the allocated quantity (always in baseUnit)
  const effStock = (i: InventoryItem) =>
    i.rcStock !== undefined ? i.rcStock : parseFloat(String(i.stockOnHand))

  // Stock converted from baseUnit to countUOM for human display
  const displayStock = (i: InventoryItem) => convertBaseToCountUom(effStock(i), i.countUOM || i.baseUnit, {
    baseUnit: i.baseUnit,
    purchaseUnit: i.purchaseUnit,
    qtyPerPurchaseUnit: Number(i.qtyPerPurchaseUnit),
    qtyUOM: i.qtyUOM ?? 'each',
    innerQty: i.innerQty != null ? Number(i.innerQty) : null,
    packSize: Number(i.packSize ?? 1),
    packUOM: i.packUOM ?? 'each',
    countUOM: i.countUOM || i.baseUnit,
  })

  // KPIs
  const kpis = useMemo(() => {
    const active = items.filter(i => i.isActive)
    const totalValue = active.reduce((s, i) =>
      s + effStock(i) * parseFloat(String(i.pricePerBaseUnit)), 0)
    const counted = active.filter(isCountedThisWeek).length
    return { totalValue, counted, notCounted: active.length - counted, activeCount: active.length, totalCount: items.length }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items])

  // Pill filter
  const pillFiltered = useMemo(() => {
    const base = filterNeedsReview ? items.filter(i => i.needsReview) : items
    switch (activePill) {
      case 'counted':    return base.filter(isCountedThisWeek)
      case 'notCounted': return base.filter(i => !isCountedThisWeek(i))
      case 'highValue':  return base.filter(i => parseFloat(String(i.pricePerBaseUnit)) > 0.01)
      case 'outOfStock': return base.filter(i => effStock(i) <= 0)
      case 'lowStock':   return base.filter(i => i.parLevel != null && displayStock(i) > 0 && displayStock(i) < i.parLevel)
      case 'active':     return base.filter(i => i.isActive)
      case 'inactive':   return base.filter(i => !i.isActive)
      default:           return base
    }
  }, [items, activePill, filterNeedsReview])

  // Column sort: first click → smart default direction; same column → flip direction
  const toggleColSort = (col: ColKey) => {
    setColSort(prev => {
      if (!prev || prev.col !== col) return { col, dir: COL_DEFAULT_DIR[col] }
      return { col, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
    })
  }

  const invValue = (i: InventoryItem) =>
    effStock(i) * parseFloat(String(i.pricePerBaseUnit))

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
        case 'stock':    return (effStock(a) - effStock(b)) * dir
        case 'value':    return (invValue(a) - invValue(b)) * dir
        default:         return 0
      }
    }

    if (sortBy === 'category') {
      // Always keep category groups together; sort items *within* each group by active column
      const itemSort = colSort ? byCol(colSort.col) : (a: InventoryItem, b: InventoryItem) => a.itemName.localeCompare(b.itemName)
      return copy.sort((a, b) => {
        const ci = a.category.localeCompare(b.category)
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
    for (const item of sortedItems) {
      if (!map.has(item.category)) map.set(item.category, [])
      map.get(item.category)!.push(item)
    }
    return Array.from(map.entries()) as [string, InventoryItem[]][]
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
    const qty = parseFloat(form.qtyPerPurchaseUnit) || 1
    const ps  = parseFloat(form.packSize) || 1
    const stockBase = convertCountQtyToBase(parseFloat(form.stockOnHand) || 0, form.countUOM, {
      baseUnit: form.baseUnit,
      purchaseUnit: form.purchaseUnit,
      qtyPerPurchaseUnit: qty,
      qtyUOM: form.qtyUOM || 'each',
      packSize: ps,
      packUOM: form.packUOM,
      countUOM: form.countUOM,
    })
    const conversionFactor = calcConversionFactor(form.countUOM, qty, form.qtyUOM || 'each', null, ps, form.packUOM)
    await fetch('/api/inventory', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, stockOnHand: stockBase, conversionFactor }),
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
        qtyUOM: editForm.qtyUOM,
        innerQty: editForm.innerQty ? parseFloat(editForm.innerQty) : null,
        stockOnHand: convertCountQtyToBase(parseFloat(editForm.stockOnHand) || 0, editForm.countUOM, {
          baseUnit: selected.baseUnit,
          purchaseUnit: editForm.purchaseUnit,
          qtyPerPurchaseUnit: parseFloat(editForm.qtyPerPurchaseUnit) || 1,
          packSize: parseFloat(editForm.packSize) || 1,
          packUOM: editForm.packUOM,
          countUOM: editForm.countUOM,
        }),
        isActive: editForm.isActive,
        allergens: editForm.allergens,
        barcode: editForm.barcode,
      }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => null)
      alert(err?.error ?? `Save failed (${res.status}). Please try again.`)
      return
    }
    const updated = await res.json()
    setSelected({ ...selected, ...updated, supplier: updated.supplier, storageArea: updated.storageArea })
    setEditMode(false)
    fetchItems()
  }

  const pricePreview = calcPricePerBaseUnit(
    parseFloat(form.purchasePrice) || 0,
    parseFloat(form.qtyPerPurchaseUnit) || 1,
    'each',
    null,
    parseFloat(form.packSize) || 1,
    form.packUOM,
  )

  // Row renderer
  const renderRow = (item: InventoryItem) => {
    const itemValue = invValue(item)
    const stockQty  = displayStock(item)
    const isOut     = stockQty <= 0
    const isLow     = !isOut && item.parLevel != null && stockQty < item.parLevel
    return (
      <tr
        key={item.id}
        className={`hover:bg-[#fafaf9] cursor-pointer border-b border-line ${!item.isActive ? 'opacity-50' : ''}`}
        onClick={() => setSelected(item)}
      >
        <td className="pl-4 py-[13px] pr-2" onClick={e => e.stopPropagation()}>
          <button onClick={() => toggleCheck(item.id)} className="text-zinc-400 hover:text-gold">
            {checkedIds.has(item.id) ? <CheckSquare size={16} className="text-gold" /> : <Square size={16} />}
          </button>
        </td>
        <td className="px-3 py-[13px]">
          <div className="flex flex-col gap-1">
            <div className="font-medium text-ink text-[13.5px] tracking-[-0.01em]">{item.itemName}</div>
            <AllergenBadges allergens={item.allergens ?? []} size="xs" />
          </div>
        </td>
        {sortBy === 'all' && (
          <td className="px-3 py-[13px] hidden sm:table-cell">
            <CategoryBadge category={item.category} />
          </td>
        )}
        <td className="px-3 py-[13px] hidden md:table-cell">
          {item.supplier?.name
            ? <span className="text-[13px] text-ink-2">{item.supplier.name}</span>
            : <span className="text-[13px] text-zinc-400">&mdash;</span>
          }
        </td>
        <td className="px-3 py-[13px]">
          <div className="font-mono text-[13px] whitespace-nowrap">
            <span className="text-gold-2">{formatCurrency(parseFloat(String(item.purchasePrice)))}</span>
            <span className="text-ink-3 text-[10.5px] ml-1">/{item.purchaseUnit}</span>
          </div>
          <div className="font-mono text-[10.5px] text-ink-3 mt-0.5 whitespace-nowrap">{formatUnitPrice(parseFloat(String(item.pricePerBaseUnit)))} / {item.baseUnit}</div>
        </td>
        <td className="px-3 py-[13px]">
          <span className="font-mono text-[13px] text-ink-2 whitespace-nowrap">
            {stockQty.toFixed(1)}<small className="font-mono text-[10.5px] text-ink-3 ml-[3px] font-normal">{item.countUOM || item.purchaseUnit}</small>
          </span>
        </td>
        <td className="px-3 py-[13px]">
          <span className={`font-mono text-[13px] whitespace-nowrap ${itemValue > 0 ? 'text-ink font-medium' : 'text-zinc-400 font-normal'}`}>
            {formatCurrency(itemValue)}
          </span>
        </td>
        <td className="px-3 py-[13px] hidden sm:table-cell">
          {isOut
            ? <span className="font-mono text-[10px] px-[9px] py-[3px] rounded-full bg-red-100 text-red-800 font-medium inline-flex items-center gap-[5px] whitespace-nowrap"><span className="w-[5px] h-[5px] rounded-full bg-current opacity-70 inline-block shrink-0" />Out of stock</span>
            : isLow
            ? <span className="font-mono text-[10px] px-[9px] py-[3px] rounded-full bg-gold-soft text-gold-2 font-medium inline-flex items-center gap-[5px] whitespace-nowrap"><span className="w-[5px] h-[5px] rounded-full bg-current opacity-70 inline-block shrink-0" />Low stock</span>
            : <span className="font-mono text-[10px] px-[9px] py-[3px] rounded-full bg-green-100 text-green-800 font-medium inline-flex items-center gap-[5px] whitespace-nowrap"><span className="w-[5px] h-[5px] rounded-full bg-current opacity-70 inline-block shrink-0" />In stock</span>
          }
        </td>
        <td className="px-3 py-[13px]" onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-end gap-2.5">
            <button
              onClick={e => handleToggleActive(e, item)}
              title={item.isActive ? 'Deactivate item' : 'Activate item'}
              className={`relative inline-flex w-[30px] h-[18px] shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${item.isActive ? 'bg-ink' : 'bg-line-2'}`}
            >
              <span className={`pointer-events-none inline-block h-[14px] w-[14px] transform rounded-full bg-white shadow ring-0 transition duration-200 ${item.isActive ? 'translate-x-[12px]' : 'translate-x-0'}`} />
            </button>
            {confirmDeleteId === item.id ? (
              <div className="flex items-center gap-1">
                <button onClick={e => handleDeleteItem(e, item.id)} className="text-xs font-medium text-red-600 hover:text-red-700 px-1 py-0.5 rounded hover:bg-red-50 transition-colors">Yes</button>
                <button onClick={e => { e.stopPropagation(); setConfirmDeleteId(null) }} className="text-xs text-zinc-400 hover:text-ink-2 px-1 py-0.5 rounded hover:bg-bg-2 transition-colors">No</button>
              </div>
            ) : (
              <button onClick={e => { e.stopPropagation(); setConfirmDeleteId(item.id) }} title="Delete item" className="text-zinc-400 hover:text-red-500 transition-colors">
                <Trash2 size={13} />
              </button>
            )}
          </div>
        </td>
      </tr>
    )
  }

  const renderMobileRow = (item: InventoryItem) => {
    const inStock = effStock(item) > 0
    return (
      <div
        key={`m-${item.id}`}
        onClick={() => setSelected(item)}
        className={`flex items-center gap-3 px-3 py-2.5 border-b border-line cursor-pointer active:bg-bg transition-colors ${
          !inStock ? 'bg-gold-soft/40' : ''
        } ${!item.isActive ? 'opacity-50' : ''}`}
      >
        {/* Category accent stripe — unified gold accent */}
        <div className={`w-1 h-10 rounded-full shrink-0 ${inStock ? 'bg-line-2' : 'bg-gold'}`} />
        <div className="flex-1 min-w-0">
          <div className="text-[14px] font-medium text-ink tracking-[-0.01em] truncate">{item.itemName}</div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className={`font-mono text-[10.5px] ${inStock ? 'text-ink-3' : 'text-gold-2 font-semibold'}`}>
              {displayStock(item).toFixed(1)} {item.countUOM || item.baseUnit}
              {!inStock && ' · OUT'}
            </span>
            {item.supplier && <span className="font-mono text-[10px] text-ink-4">· {item.supplier.name}</span>}
          </div>
          {item.allergens && item.allergens.length > 0 && (
            <div className="mt-0.5">
              <AllergenBadges allergens={item.allergens} size="xs" />
            </div>
          )}
        </div>
        <div className="text-right shrink-0">
          <div className="font-mono text-[13px] font-medium text-ink">
            {formatCurrency(parseFloat(String(item.purchasePrice)))}
          </div>
          <div className="font-mono text-[10px] text-ink-4">/{item.purchaseUnit}</div>
        </div>
        <ChevronRight size={14} className="text-ink-4 shrink-0" />
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
    { key: 'lowStock', label: 'Low Stock' },
  ]

  return (
    <div className="space-y-4">
      {/* Mobile header */}
      <div className="flex sm:hidden items-center gap-2">
        <div className="flex-1 min-w-0">
          <h1 className="text-[22px] font-semibold text-ink tracking-[-0.03em] leading-tight">Inventory</h1>
          <p className="font-mono text-[10.5px] text-ink-3 tracking-[0.01em]">{items.length} items</p>
        </div>
        <button
          onClick={() => { setShowOrderList(true); setOrderQtys({}); setOrderTab('all') }}
          className="flex items-center justify-center w-9 h-9 bg-paper border border-line text-ink-2 rounded-[9px]"
        >
          <ShoppingCart size={16} />
        </button>
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-1.5 bg-ink text-paper px-3 h-9 rounded-[9px] text-[13px] font-medium"
        >
          <span className="text-gold font-semibold">+</span> Add
        </button>
      </div>

      {/* Desktop header */}
      <div className="hidden sm:flex items-end justify-between gap-6 flex-wrap">
        <div>
          <div className="font-mono text-[10.5px] text-ink-3 mb-2.5 tracking-[0.01em]">LIBRARY / INVENTORY</div>
          <h1 className="text-[36px] font-semibold tracking-[-0.04em] text-ink leading-none">Inventory</h1>
          <p className="text-[13.5px] text-ink-3 tracking-[-0.005em] mt-1.5">Master database · weekly stock counting · cost control</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={syncAllPrepd}
            disabled={syncingPrepd}
            title="Re-sync all PREPD item prices from their recipes"
            className="flex items-center gap-[7px] border border-line bg-paper text-ink-2 px-3.5 py-[9px] rounded-[9px] text-[13px] font-medium hover:border-ink-3 transition-colors disabled:opacity-50"
          >
            <span className="text-ink-3 text-[13px]">⟳</span>
            {syncingPrepd ? 'Syncing…' : 'Sync PREPD'}
          </button>
          <button
            onClick={() => { setShowOrderList(true); setOrderQtys({}); setOrderTab('all') }}
            className="flex items-center gap-[7px] border border-line bg-paper text-ink-2 px-3.5 py-[9px] rounded-[9px] text-[13px] font-medium hover:border-ink-3 transition-colors"
          >
            <ShoppingCart size={13} className="text-ink-3" /> Order List
          </button>
          <button
            onClick={() => setShowImport(true)}
            className="flex items-center gap-[7px] border border-line bg-paper text-ink-2 px-3.5 py-[9px] rounded-[9px] text-[13px] font-medium hover:border-ink-3 transition-colors"
          >
            <UploadCloud size={13} className="text-ink-3" /> Import
          </button>
          <button
            onClick={() => window.location.href = '/api/inventory/export'}
            className="flex items-center gap-[7px] border border-line bg-paper text-ink-2 px-3.5 py-[9px] rounded-[9px] text-[13px] font-medium hover:border-ink-3 transition-colors"
          >
            <Download size={13} className="text-ink-3" /> Export
          </button>
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-[7px] bg-ink text-paper px-4 py-[9px] rounded-[9px] text-[13px] font-medium hover:bg-[#18181b] transition-colors"
          >
            <span className="text-gold font-semibold text-[14px]">+</span> Add Item
          </button>
        </div>
      </div>

      {/* Mobile KPI strip */}
      <div className="flex sm:hidden gap-3 overflow-x-auto pb-0.5" style={{ scrollbarWidth: 'none' }}>
        <div className="flex-shrink-0 bg-ink text-paper rounded-[12px] px-3 py-2.5 min-w-[140px]">
          <div className="font-mono text-[9px] uppercase tracking-[0.06em] text-ink-4">Stock Value</div>
          <div className="font-mono text-[18px] font-semibold text-paper mt-0.5 tracking-[-0.02em]">
            {(() => { const [d,c] = formatCurrency(kpis.totalValue).split('.'); return <>{d}<span className="text-gold">.{c ?? '00'}</span></> })()}
          </div>
        </div>
        <div className="flex-shrink-0 bg-paper border border-line rounded-[12px] px-3 py-2.5 min-w-[100px]">
          <div className="font-mono text-[9px] uppercase tracking-[0.06em] text-ink-3">Counted</div>
          <div className="font-mono text-[18px] font-semibold text-ink mt-0.5 tracking-[-0.02em]">
            {kpis.counted}<span className="text-[12px] font-normal text-ink-4"> / {kpis.activeCount}</span>
          </div>
        </div>
        <div className="flex-shrink-0 bg-gold-soft border border-[#fcd34d] rounded-[12px] px-3 py-2.5 min-w-[100px]">
          <div className="font-mono text-[9px] uppercase tracking-[0.06em] text-gold-2">Uncounted</div>
          <div className="font-mono text-[18px] font-semibold text-gold-2 mt-0.5 tracking-[-0.02em]">{kpis.notCounted}</div>
        </div>
        <div className="flex-shrink-0 bg-paper border border-line rounded-[12px] px-3 py-2.5 min-w-[80px]">
          <div className="font-mono text-[9px] uppercase tracking-[0.06em] text-ink-3">Active</div>
          <div className="font-mono text-[18px] font-semibold text-ink mt-0.5 tracking-[-0.02em]">{kpis.activeCount}</div>
        </div>
      </div>

      {/* Desktop KPI row */}
      <div className="hidden sm:grid gap-3" style={{ gridTemplateColumns: '1.35fr 1fr 1fr 1fr 1fr' }}>
        {/* Hero — Current Stock Value */}
        <div className="bg-ink text-paper rounded-xl border border-ink p-5 flex flex-col justify-between min-h-[128px] relative">
          <div className="absolute right-4 top-[18px] flex gap-[2px] items-end h-[18px]">
            {[6,8,12,9,14,11,17,13].map((h, i) => (
              <span key={i} className="w-[3px] rounded-[1px] inline-block" style={{ height: h, background: '#3f3f46' }} />
            ))}
          </div>
          <div>
            <div className="font-mono text-[10.5px] text-[#a1a1aa] tracking-[0.01em]">CURRENT STOCK VALUE</div>
            <div className="text-[48px] font-semibold tracking-[-0.045em] leading-none mt-2 whitespace-nowrap">
              {formatCurrency(kpis.totalValue).split('.')[0]}
              <sub className="text-[22px] font-medium text-gold tracking-[-0.02em] align-baseline ml-[1px]">
                .{formatCurrency(kpis.totalValue).split('.')[1] ?? '00'}
              </sub>
            </div>
          </div>
          <div className="font-mono text-[11px] text-[#a1a1aa] mt-2">
            {kpis.activeCount} active items
          </div>
        </div>

        {/* Previous Stock Value */}
        <div className="bg-paper border border-line rounded-xl p-5 flex flex-col justify-between min-h-[128px] relative">
          <div className="absolute top-0 left-0 w-8 h-[2px] bg-line-2 rounded-[1px]" />
          <div>
            <div className="font-mono text-[10.5px] text-ink-3 tracking-[0.01em]">PREVIOUS STOCK VALUE</div>
            <div className="text-[34px] font-semibold tracking-[-0.04em] leading-none mt-2 text-ink whitespace-nowrap">
              {lastCount ? formatCurrency(lastCount.totalCountedValue).split('.')[0] : '$0'}
              <sub className="font-mono text-[18px] font-medium text-ink-3 tracking-[-0.02em] align-baseline ml-[1px]">
                .{lastCount ? (formatCurrency(lastCount.totalCountedValue).split('.')[1] ?? '00') : '00'}
              </sub>
            </div>
          </div>
          <div className="font-mono text-[11px] text-ink-3 mt-2">
            {lastCount
              ? `${lastCount.label} · ${new Date(lastCount.sessionDate).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}`
              : 'No prior count'}
          </div>
        </div>

        {/* Counted This Week */}
        <div className="bg-paper border border-line rounded-xl p-5 flex flex-col justify-between min-h-[128px]">
          <div>
            <div className="font-mono text-[10.5px] text-ink-3 tracking-[0.01em]">COUNTED THIS WEEK</div>
            <div className="text-[34px] font-semibold tracking-[-0.04em] leading-none mt-2 text-ink-3">{kpis.counted}</div>
          </div>
          <div className="font-mono text-[11px] text-ink-3 mt-2">of {kpis.activeCount} active</div>
        </div>

        {/* Not Yet Counted — alert */}
        <div className="rounded-xl p-5 flex flex-col justify-between min-h-[128px] relative" style={{ background: '#fffbeb', border: '1px solid #fcd34d' }}>
          <div className="absolute top-[18px] right-[18px] w-[7px] h-[7px] rounded-full bg-gold" />
          <div>
            <div className="font-mono text-[10.5px] text-gold-2 tracking-[0.01em]">NOT YET COUNTED</div>
            <div className="text-[34px] font-semibold tracking-[-0.04em] leading-none mt-2 text-gold-2">{kpis.notCounted}</div>
          </div>
          <div className="font-mono text-[11px] text-gold-2 font-medium mt-2">Items need counting</div>
        </div>

        {/* Active Items */}
        <div className="bg-paper border border-line rounded-xl p-5 flex flex-col justify-between min-h-[128px]">
          <div>
            <div className="font-mono text-[10.5px] text-ink-3 tracking-[0.01em]">ACTIVE ITEMS</div>
            <div className="text-[34px] font-semibold tracking-[-0.04em] leading-none mt-2 text-ink">{kpis.activeCount}</div>
          </div>
          <div className="font-mono text-[11px] text-ink-3 mt-2">
            {kpis.totalCount} total · <span className="text-ink font-medium">{kpis.totalCount - kpis.activeCount} inactive</span>
          </div>
        </div>
      </div>

      {/* Mobile controls — Sort & Filter always visible, pills scroll separately */}
      <div className="flex sm:hidden flex-col gap-2">
        {/* Always-visible controls row */}
        <div className="flex items-center gap-1.5">
          {/* Grouped / Flat toggle */}
          <div className="flex items-center gap-0.5 border border-gray-200 rounded-lg p-0.5 bg-white shrink-0">
            {([['category', '⊞'], ['all', '≡']] as [SortMode, string][]).map(([mode, label]) => (
              <button
                key={mode}
                onClick={() => setSortBy(mode)}
                title={mode === 'category' ? 'Grouped by category' : 'Flat list'}
                className={`px-2 py-1 rounded-md text-xs font-medium transition-colors ${
                  sortBy === mode ? 'bg-gold text-white shadow-sm' : 'text-gray-500'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {/* Sort */}
          <button
            onClick={() => setShowMobileSortSheet(true)}
            className={`flex items-center gap-0.5 px-2 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
              colSort ? 'bg-gold/10 border-gold/30 text-gold' : 'bg-white border-gray-200 text-gray-600'
            }`}
          >
            <ChevronsUpDown size={11} />
            {colSort ? (colSort.col === 'item' ? 'Name' : colSort.col === 'value' ? 'Value' : colSort.col === 'price' ? 'Price' : 'Sort') : 'Sort'}
            {colSort && <span className="text-[10px] ml-0.5">{colSort.dir === 'asc' ? '↑' : '↓'}</span>}
          </button>
          {/* Filter */}
          <button
            onClick={() => setShowMobileFilterSheet(true)}
            className={`flex items-center gap-0.5 px-2 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
              (catFilter || supplierFilter || areaFilter) ? 'bg-gold/10 border-gold/30 text-gold' : 'bg-white border-gray-200 text-gray-600'
            }`}
          >
            ▽ Filter{(catFilter || supplierFilter || areaFilter) ? ' ·' : ''}
          </button>
          <div className="flex-1" />
          {/* Import CSV */}
          <button
            onClick={() => setShowImport(true)}
            title="Import CSV"
            className="flex items-center gap-1 px-2 py-1.5 rounded-[8px] font-mono text-[11px] uppercase tracking-[0.04em] border border-line bg-paper text-ink-2 transition-colors hover:border-ink-3"
          >
            <UploadCloud size={11} /> Import
          </button>
          {/* Export CSV */}
          <button
            onClick={() => { window.location.href = '/api/inventory/export' }}
            title="Export CSV"
            className="flex items-center gap-1 px-2 py-1.5 rounded-[8px] font-mono text-[11px] uppercase tracking-[0.04em] border border-line bg-paper text-ink-2 transition-colors hover:border-ink-3"
          >
            <Download size={11} /> CSV
          </button>
          {/* Sync PREPD */}
          <button
            onClick={syncAllPrepd}
            disabled={syncingPrepd}
            title="Re-sync all PREPD item prices from their recipes"
            className="flex items-center gap-1 px-2 py-1.5 rounded-[8px] font-mono text-[11px] uppercase tracking-[0.04em] border border-line bg-paper text-ink-2 transition-colors hover:border-ink-3 disabled:opacity-50"
          >
            {syncingPrepd ? <Loader2 size={11} className="animate-spin" /> : <span className="text-[11px] text-ink-3">⟳</span>}
            PREPD
          </button>
        </div>
        {/* Status pills — scrollable */}
        <div className="flex gap-2 overflow-x-auto pb-0.5" style={{ scrollbarWidth: 'none' }}>
          {pills.map(p => (
            <button
              key={p.key}
              onClick={() => setActivePill(p.key)}
              className={`flex-shrink-0 px-3 py-1.5 rounded-full font-mono text-[11px] uppercase tracking-[0.04em] transition-colors ${
                activePill === p.key ? 'bg-ink text-paper' : 'bg-bg-2 text-ink-2 border border-line'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Desktop filter chips */}
      <div className="hidden sm:flex gap-1.5 flex-wrap">
        {pills.map(p => {
          const count = p.key === 'all' ? items.length
            : p.key === 'active' ? kpis.activeCount
            : p.key === 'inactive' ? (kpis.totalCount - kpis.activeCount)
            : p.key === 'counted' ? kpis.counted
            : p.key === 'notCounted' ? kpis.notCounted
            : p.key === 'outOfStock' ? items.filter(i => effStock(i) <= 0).length
            : p.key === 'lowStock' ? items.filter(i => i.parLevel != null && displayStock(i) > 0 && displayStock(i) < i.parLevel!).length
            : items.filter(i => parseFloat(String(i.pricePerBaseUnit)) > 0.01).length
          return (
            <button
              key={p.key}
              onClick={() => setActivePill(p.key)}
              className={`font-mono text-[11px] px-3 py-[6px] rounded-full transition-colors whitespace-nowrap ${
                activePill === p.key
                  ? 'bg-ink text-paper border border-ink'
                  : 'bg-paper border border-line text-ink-2 hover:border-ink-3'
              }`}
            >
              {p.label} <span className={activePill === p.key ? 'text-[#a1a1aa]' : 'text-ink-3'}>{count}</span>
            </button>
          )
        })}
      </div>

      {/* Search + Filters */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search items, suppliers, SKUs…"
            className="w-full pl-9 pr-3 py-2 sm:py-[9px] border border-line rounded-[9px] text-[13px] font-[inherit] bg-paper text-ink focus:outline-none placeholder:text-ink-3"
          />
        </div>
        <select value={catFilter} onChange={e => setCatFilter(e.target.value)} className="hidden sm:block border border-line bg-paper rounded-[9px] px-3 py-[9px] text-[13px] text-ink-2 focus:outline-none min-w-[140px]">
          <option value="">All categories</option>
          {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
        </select>
        <select value={supplierFilter} onChange={e => setSupplierFilter(e.target.value)} className="hidden sm:block border border-line bg-paper rounded-[9px] px-3 py-[9px] text-[13px] text-ink-2 focus:outline-none min-w-[140px]">
          <option value="">All suppliers</option>
          {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select value={areaFilter} onChange={e => setAreaFilter(e.target.value)} className="hidden sm:block border border-line bg-paper rounded-[9px] px-3 py-[9px] text-[13px] text-ink-2 focus:outline-none min-w-[120px]">
          <option value="">All areas</option>
          {storageAreas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <div className="hidden sm:flex bg-paper border border-line rounded-[9px] p-[3px] shrink-0">
          {([['category','⊞ Grouped'],['all','≡ Flat']] as [SortMode, string][]).map(([mode, label]) => (
            <button
              key={mode}
              onClick={() => setSortBy(mode)}
              className={`px-3 py-[6px] rounded-[6px] font-mono text-[11px] transition-colors ${
                sortBy === mode
                  ? 'bg-ink text-paper'
                  : 'text-ink-3 hover:text-ink-2 hover:bg-bg-2'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="font-mono text-[11px] text-ink-3 tracking-[0.01em]">
        SHOWING {sortedItems.length} OF {items.length} ITEMS · SORTED BY {sortBy === 'category' ? 'CATEGORY → NAME' : colSort ? `${colSort.col.toUpperCase()} ${colSort.dir === 'asc' ? '↑' : '↓'}` : 'NAME'}
      </div>

      {/* needsReview banner */}
      {items.some(i => i.needsReview) && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <span className="text-base">⚠</span>
          <div className="flex-1">
            <span className="font-semibold">{items.filter(i => i.needsReview).length} items need purchase structure review</span>
            {' '}— their data couldn&apos;t be auto-repaired during migration.{' '}
            <button
              className="underline font-medium"
              onClick={() => setFilterNeedsReview(v => !v)}
            >
              {filterNeedsReview ? 'Show all' : 'Show items'}
            </button>
          </div>
        </div>
      )}

      {/* Bulk action bar — fixed at bottom so it's visible no matter how far you scroll */}
      {checkedIds.size > 0 && (
        <div className="fixed bottom-16 md:bottom-4 left-0 right-0 z-40 px-3 pointer-events-none">
          <div className="max-w-5xl mx-auto pointer-events-auto">
            <div className="bg-ink border border-ink rounded-[12px] px-4 py-3 shadow-2xl flex flex-wrap items-center gap-2">
              <span className="font-mono text-[11px] uppercase tracking-[0.04em] text-paper shrink-0"><span className="text-gold font-semibold">{checkedIds.size}</span> selected</span>
              <div className="flex gap-2 flex-wrap flex-1">
                <button onClick={() => executeBulk('activate')}   className="px-3 py-1.5 bg-paper text-ink text-xs rounded-[8px] hover:bg-bg font-medium">Activate</button>
                <button onClick={() => executeBulk('deactivate')} className="px-3 py-1.5 bg-zinc-800 text-paper text-xs rounded-[8px] hover:bg-zinc-700 border border-zinc-700">Deactivate</button>
                <button
                  onClick={() => setShowBulkAllergen(true)}
                  className="px-3 py-1.5 bg-zinc-800 text-paper border border-zinc-700 text-xs rounded-[8px] hover:bg-zinc-700 flex items-center gap-1"
                >
                  Assign Allergens
                </button>
                {/* Assign Category */}
                <div className="relative">
                  <button
                    onClick={() => { setBulkAction('setCategory'); setShowBulkMenu(v => bulkAction === 'setCategory' ? !v : true) }}
                    className="px-3 py-1.5 bg-zinc-800 text-paper border border-zinc-700 text-xs rounded-[8px] hover:bg-zinc-700 flex items-center gap-1"
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
                    className="px-3 py-1.5 bg-zinc-800 text-paper border border-zinc-700 text-xs rounded-[8px] hover:bg-zinc-700 flex items-center gap-1"
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
                    className="px-3 py-1.5 bg-zinc-800 text-paper border border-zinc-700 text-xs rounded-[8px] hover:bg-zinc-700 flex items-center gap-1"
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
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600 text-white text-xs rounded-[8px] hover:bg-red-700 font-medium"
                >
                  <Trash2 size={12} /> Delete
                </button>
                <button onClick={() => { setCheckedIds(new Set()); setShowBulkMenu(false) }} className="text-xs text-ink-4 hover:text-paper px-1">✕</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Mobile Sort Sheet */}
      {showMobileSortSheet && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:hidden"
          onMouseDown={(e) => { (e.currentTarget as HTMLElement).dataset.mdown = String(e.target === e.currentTarget) }}
          onClick={(e) => { if (e.target === e.currentTarget && (e.currentTarget as HTMLElement).dataset.mdown === 'true') setShowMobileSortSheet(false) }}
        >
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
                    onClick={() => { setSortBy(mode); setShowMobileSortSheet(false) }}
                    className={`flex-1 py-2.5 rounded-xl text-sm font-medium border transition-colors ${
                      sortBy === mode ? 'bg-gold text-white border-gold' : 'bg-white text-gray-600 border-gray-200'
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
                      colSort?.col === col ? 'bg-gold/10 text-gold font-semibold' : 'bg-gray-50 text-gray-700'
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
        <div
          className="fixed inset-0 z-50 flex items-end sm:hidden"
          onMouseDown={(e) => { (e.currentTarget as HTMLElement).dataset.mdown = String(e.target === e.currentTarget) }}
          onClick={(e) => { if (e.target === e.currentTarget && (e.currentTarget as HTMLElement).dataset.mdown === 'true') setShowMobileFilterSheet(false) }}
        >
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
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gold"
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
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gold"
                >
                  <option value="">All Suppliers</option>
                  {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Storage Area</label>
                <select
                  value={areaFilter}
                  onChange={e => setAreaFilter(e.target.value)}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gold"
                >
                  <option value="">All Areas</option>
                  {storageAreas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
              <button
                onClick={() => { setCatFilter(''); setSupplierFilter(''); setAreaFilter(''); setShowMobileFilterSheet(false) }}
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
        const orderItems  = activeItems.filter(i =>
          displayStock(i) <= 0 ||
          (i.parLevel != null && displayStock(i) < i.parLevel)
        )
        const belowPar   = orderItems.filter(i => i.parLevel != null && displayStock(i) > 0 && displayStock(i) < i.parLevel)
        const outOfStock = orderItems.filter(i => displayStock(i) <= 0)

        const suggestedQty = (item: InventoryItem): string => {
          if (item.reorderQty != null) return String(item.reorderQty)
          if (item.parLevel != null && item.parLevel > displayStock(item)) {
            const needed = item.parLevel - displayStock(item)
            return String(Math.ceil(needed / (Number(item.qtyPerPurchaseUnit) || 1)))
          }
          return ''
        }

        type OrderTab = 'all' | 'belowPar' | 'outOfStock'
        const tabItems = orderTab === 'belowPar' ? belowPar
          : orderTab === 'outOfStock' ? outOfStock
          : orderItems

        const bySupplier = new Map<string, { supplierName: string; items: InventoryItem[] }>()
        for (const item of tabItems) {
          const key  = item.supplierId ?? '__none__'
          const name = item.supplier?.name ?? 'No Supplier'
          if (!bySupplier.has(key)) bySupplier.set(key, { supplierName: name, items: [] })
          bySupplier.get(key)!.items.push(item)
        }
        const copyText = Array.from(bySupplier.values()).map(({ supplierName, items: grp }) =>
          `${supplierName}:\n` + grp.map(i => `  - ${i.itemName}  ${orderQtys[i.id] ?? suggestedQty(i)}  ${i.purchaseUnit}  @${formatCurrency(parseFloat(String(i.purchasePrice)))}`).join('\n')
        ).join('\n\n')

        return (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4">
            <div className="bg-white w-full sm:max-w-xl rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[85vh]">
              <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-gray-100 shrink-0">
                <div className="flex items-center gap-2">
                  <ShoppingCart size={18} className="text-green-600" />
                  <h2 className="font-semibold text-gray-900">Order Guide</h2>
                  <span className="text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full">{orderItems.length} items</span>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => { navigator.clipboard.writeText(copyText) }}
                    className="flex items-center gap-1.5 text-xs border border-gray-200 px-2.5 py-1.5 rounded-lg text-gray-600 hover:bg-gray-50">
                    <Copy size={12} /> Copy
                  </button>
                  <button onClick={() => setShowOrderList(false)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400"><X size={18} /></button>
                </div>
              </div>

              {/* Filter tabs */}
              <div className="flex gap-1.5 px-4 py-2 border-b border-gray-100 bg-gray-50 shrink-0">
                {([
                  { key: 'all' as OrderTab,        label: `All (${orderItems.length})` },
                  { key: 'belowPar' as OrderTab,   label: `⚠ Below Par (${belowPar.length})` },
                  { key: 'outOfStock' as OrderTab, label: `Out of Stock (${outOfStock.length})` },
                ]).map(t => (
                  <button
                    key={t.key}
                    onClick={() => setOrderTab(t.key)}
                    className={`text-xs font-semibold px-3 py-1 rounded-full transition-colors ${
                      orderTab === t.key
                        ? 'bg-gray-900 text-white'
                        : t.key === 'belowPar'
                          ? 'bg-amber-100 text-amber-800 hover:bg-amber-200'
                          : 'text-gray-500 hover:bg-gray-100'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              <div className="overflow-y-auto flex-1 p-4 space-y-4">
                {tabItems.length === 0 ? (
                  <div className="text-center py-12 text-gray-400 text-sm">No items in this category</div>
                ) : (
                  Array.from(bySupplier.values()).map(({ supplierName, items: grp }) => (
                    <div key={supplierName}>
                      <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{supplierName}</div>
                      <div className="space-y-1">
                        {grp.map(item => {
                          const isOut = displayStock(item) <= 0
                          return (
                            <div key={item.id} className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <div className="text-sm font-medium text-gray-800 truncate">{item.itemName}</div>
                                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full shrink-0 ${
                                    isOut ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
                                  }`}>
                                    {isOut ? 'Out' : 'Low'}
                                  </span>
                                </div>
                                {item.parLevel != null ? (
                                  <div className="text-xs text-gray-400">
                                    Par {item.parLevel} {item.countUOM} · Have {displayStock(item).toFixed(1)}
                                  </div>
                                ) : (
                                  <div className="text-xs text-gray-400">
                                    {formatCurrency(parseFloat(String(item.purchasePrice)))} / {item.purchaseUnit}
                                  </div>
                                )}
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                <input type="number" min="1" step="1"
                                  value={orderQtys[item.id] ?? suggestedQty(item)}
                                  onChange={e => setOrderQtys(q => ({ ...q, [item.id]: e.target.value }))}
                                  placeholder="qty"
                                  className="w-14 border border-gray-200 rounded-lg px-2 py-1 text-sm text-center text-gray-900 focus:outline-none focus:ring-2 focus:ring-green-400" />
                                <span className="text-xs text-gray-500">{item.purchaseUnit}</span>
                              </div>
                            </div>
                          )
                        })}
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

      {/* Mobile list */}
      <div className="block sm:hidden bg-paper rounded-[12px] border border-line overflow-hidden">
        {categoryGroups ? (
          categoryGroups.map(([cat, rows]) => {
            const catValue = rows.reduce((s, i) => s + invValue(i), 0)
            const collapsed = collapsedCats.has(cat)
            const belowPar = rows.filter(r => r.parLevel != null && displayStock(r) < (r.parLevel ?? 0)).length
            return (
              <React.Fragment key={`mg-${cat}`}>
                <div
                  className="flex items-center justify-between px-4 py-2 cursor-pointer border-y bg-gold-soft border-[#fcd34d]/60 text-gold-2"
                  onClick={() => setCollapsedCats(prev => {
                    const n = new Set(prev); n.has(cat) ? n.delete(cat) : n.add(cat); return n
                  })}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                    <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.06em]">{cat}</span>
                    <span className="font-mono text-[10.5px] text-gold-2/80">· {rows.length} items{belowPar > 0 ? ` · ${belowPar} below par` : ''}</span>
                  </div>
                  <span className="font-mono text-[12px] font-semibold">{formatCurrency(catValue)}</span>
                </div>
                {!collapsed && rows.map(item => renderMobileRow(item))}
              </React.Fragment>
            )
          })
        ) : (
          sortedItems.map(item => renderMobileRow(item))
        )}
        {sortedItems.length === 0 && (
          <div className="text-center py-12 font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3">No items found</div>
        )}
      </div>

      {/* Desktop table */}
      <div className="hidden sm:block bg-paper border border-line rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-bg-2 border-b border-line">
              <tr>
                <th className="pl-4 py-[10px] pr-2 w-8">
                  <button onClick={toggleAll} className="text-zinc-400 hover:text-gold">
                    {checkedIds.size === sortedItems.length && sortedItems.length > 0
                      ? <CheckSquare size={15} className="text-gold" /> : <Square size={15} />}
                  </button>
                </th>
                <SortTh col="item" label="Item" colSort={colSort} onSort={toggleColSort} className="text-left" />
                {sortBy === 'all' && (
                  <SortTh col="category" label="Category" colSort={colSort} onSort={toggleColSort} className="text-left hidden sm:table-cell" />
                )}
                <SortTh col="supplier" label="Supplier" colSort={colSort} onSort={toggleColSort} className="text-left hidden md:table-cell" />
                <SortTh col="price" label="Purchase price" colSort={colSort} onSort={toggleColSort} className="text-left" />
                <SortTh col="stock" label="Current stock" colSort={colSort} onSort={toggleColSort} className="text-left" />
                <SortTh col="value" label="Inv value" colSort={colSort} onSort={toggleColSort} className="text-left" />
                <th className="px-3 py-[10px] font-mono text-[10.5px] text-ink-3 tracking-[0.01em] hidden sm:table-cell">Status</th>
                <th className="px-3 py-[10px] font-mono text-[10.5px] text-ink-3 tracking-[0.01em] text-right w-24">Active</th>
              </tr>
            </thead>
            <tbody>
              {categoryGroups ? (
                categoryGroups.map(([cat, rows]) => {
                  const catValue  = rows.reduce((s, i) => s + invValue(i), 0)
                  const allChecked = rows.length > 0 && rows.every(r => checkedIds.has(r.id))
                  const collapsed  = collapsedCats.has(cat)
                  return (
                    <React.Fragment key={`group-${cat}`}>
                      <tr
                        className="cursor-pointer bg-gold-soft border-y border-[#fcd34d]"
                        onClick={() => setCollapsedCats(prev => { const n = new Set(prev); n.has(cat) ? n.delete(cat) : n.add(cat); return n })}
                      >
                        <td className="pl-4 py-[10px] pr-2" onClick={e => e.stopPropagation()}>
                          <button onClick={() => toggleCatGroup(rows)} className="text-zinc-400 hover:text-gold-2">
                            {allChecked ? <CheckSquare size={15} className="text-gold-2" /> : <Square size={15} />}
                          </button>
                        </td>
                        <td className="px-3 py-[10px]" colSpan={6}>
                          <div className="flex items-center gap-2">
                            {collapsed
                              ? <ChevronRight size={10} className="text-gold-2" />
                              : <ChevronDown size={10} className="text-gold-2" />}
                            <span className="font-mono text-[11.5px] text-gold-2 font-semibold tracking-[0.02em]">{cat}</span>
                            <span className="font-mono text-[11px] text-amber-700">· {rows.length} items</span>
                          </div>
                        </td>
                        <td className="px-3 py-[10px] text-right" colSpan={2}>
                          <span className="font-mono text-[12.5px] text-gold-2 font-semibold">{formatCurrency(catValue)}</span>
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

      {/* Item drawer — single source of truth across Inventory / Count */}
      {selected && (
        <InventoryItemDrawer
          itemId={selected.id}
          onClose={() => setSelected(null)}
          onUpdated={fetchItems}
        />
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

      {/* Import Modal */}
      {showImport && (
        <InventoryImportModal
          onClose={() => setShowImport(false)}
          onImported={() => { setShowImport(false); fetchItems() }}
        />
      )}

      {/* Add Item Modal */}
      {showAdd && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center p-4 overflow-y-auto"
          onMouseDown={(e) => { (e.currentTarget as HTMLElement).dataset.mdown = String(e.target === e.currentTarget) }}
          onClick={(e) => { if (e.target === e.currentTarget && (e.currentTarget as HTMLElement).dataset.mdown === 'true') setShowAdd(false) }}
        >
          <div className="absolute inset-0 bg-black/30" />
          <div className="relative bg-white rounded-xl p-6 w-full max-w-lg shadow-xl my-8" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold mb-4 text-lg">Add Inventory Item</h3>
            <form onSubmit={handleAdd} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-gray-600 mb-1">Item Name *</label>
                  <input required value={form.itemName} onChange={e => setForm(f => ({ ...f, itemName: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Category</label>
                  <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold">
                    {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Supplier</label>
                  <select value={form.supplierId} onChange={e => setForm(f => ({ ...f, supplierId: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold">
                    <option value="">None</option>
                    {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Storage Area</label>
                  <select value={form.storageAreaId} onChange={e => setForm(f => ({ ...f, storageAreaId: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold">
                    <option value="">None</option>
                    {storageAreas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Purchase Unit</label>
                  <select required value={form.purchaseUnit} onChange={e => setForm(f => ({ ...f, purchaseUnit: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold bg-white">
                    {PURCHASE_UNITS.map(u => <option key={u}>{u}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Qty per Purchase Unit</label>
                  <input type="number" required value={form.qtyPerPurchaseUnit} onChange={e => setForm(f => ({ ...f, qtyPerPurchaseUnit: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" step="any" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Pack Size</label>
                  <input type="number" step="any" value={form.packSize} onChange={e => setForm(f => ({ ...f, packSize: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Pack UOM</label>
                  <select value={form.packUOM} onChange={e => setForm(f => ({ ...f, packUOM: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold bg-white">
                    {PACK_UOMS.map(u => <option key={u}>{u}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Count UOM</label>
                  <select value={form.countUOM} onChange={e => setForm(f => ({ ...f, countUOM: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold bg-white">
                    {COUNT_UOMS.map(u => <option key={u}>{u}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Purchase Price ($)</label>
                  <input type="number" required value={form.purchasePrice} onChange={e => setForm(f => ({ ...f, purchasePrice: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" step="any" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Base Unit</label>
                  <select value={form.baseUnit} onChange={e => setForm(f => ({ ...f, baseUnit: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold">
                    {BASE_UNITS.map(u => <option key={u}>{u}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Stock On Hand ({form.countUOM})</label>
                  <input type="number" value={form.stockOnHand} onChange={e => setForm(f => ({ ...f, stockOnHand: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" step="any" />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-gray-600 mb-1">Location</label>
                  <input value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                </div>
              </div>
              <div className="bg-gold/10 rounded-lg p-3 text-sm">
                <span className="text-gold font-medium">Price per base unit preview: </span>
                <span className="font-bold text-gold">{formatUnitPrice(pricePreview)} / {form.baseUnit}</span>
              </div>
              <div className="flex gap-2 pt-2">
                <button type="button" onClick={() => setShowAdd(false)} className="flex-1 border border-gray-200 rounded-lg py-2 text-sm hover:bg-gray-50">Cancel</button>
                <button type="submit" className="flex-1 bg-gold text-white rounded-lg py-2 text-sm hover:bg-[#a88930]">Add Item</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

```


---

## `src/app/inventory/layout.tsx`

```tsx
export default function InventoryLayout({ children }: { children: React.ReactNode }) {
  // v2: Storage Areas / Categories / Count Stock moved out of /inventory.
  // Storage + Categories now live under /setup; Count is top-level at /count.
  return <>{children}</>
}

```


---

## `src/app/recipes/page.tsx`

```tsx
'use client'
import { useEffect, useState, useCallback, useRef, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { X, BookOpen, Search, Link2, Check, Download, SlidersHorizontal } from 'lucide-react'
import { RecipeCard, RecipePanel, CategoryManager, BulkActionBar } from '@/components/recipes/shared'
import type { Recipe, RecipeCategory } from '@/components/recipes/shared'
import { useDrawer } from '@/contexts/DrawerContext'

export default function RecipesPage() {
  return (
    <Suspense fallback={null}>
      <RecipesInner />
    </Suspense>
  )
}

function RecipesInner() {
  const searchParams = useSearchParams()
  const { setDrawerOpen } = useDrawer()
  const [recipes, setRecipes]               = useState<Recipe[]>([])
  const [categories, setCategories]         = useState<RecipeCategory[]>([])
  const [activeCatId, setActiveCatId]       = useState<string | null>(null)
  const [searchInput, setSearchInput]       = useState('')
  const [search, setSearch]                 = useState('')
  const searchDebounce = useRef<ReturnType<typeof setTimeout>>()
  const [showInactive, setShowInactive]     = useState(false)
  const [sortMode, setSortMode]             = useState<'az' | 'cost' | 'usage'>('az')
  const [viewMode, setViewMode]             = useState<'list' | 'grid'>('list')
  const [selectedRecipeId, setSelectedRecipeId] = useState<string | null>(null)
  const [showNewForm, setShowNewForm]       = useState(false)
  const [showCatManager, setShowCatManager] = useState(false)
  const [selectedIds, setSelectedIds]       = useState<Set<string>>(new Set())
  const [bulkConfirm, setBulkConfirm]       = useState<'deactivate' | 'delete' | null>(null)
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

  const baseRecipes = activeCatId ? recipes.filter(r => r.categoryId === activeCatId) : recipes
  const displayRecipes = [...baseRecipes].sort((a, b) => {
    if (sortMode === 'cost')  return b.totalCost - a.totalCost
    if (sortMode === 'usage') return (b.usedInCount ?? 0) - (a.usedInCount ?? 0)
    return a.name.localeCompare(b.name)
  })

  useEffect(() => { loadCategories() }, [loadCategories])
  useEffect(() => { loadRecipes() }, [loadRecipes])
  useEffect(() => {
    const itemId = searchParams.get('item')
    if (itemId) setSelectedRecipeId(itemId)
  }, [searchParams])

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

  const sortLabel = sortMode === 'az' ? 'A–Z' : sortMode === 'cost' ? 'Cost' : 'Usage'

  return (
    <div className="flex flex-col gap-4">

      {/* ── SUB-NAV TABS ── */}
      <nav className="flex items-stretch border-b border-line -mx-4 sm:-mx-6 md:-mx-8 px-4 sm:px-6 md:px-8 h-12">
        <button className="flex items-center gap-2 px-4 text-[13.5px] font-medium text-ink border-b-2 border-gold tracking-[-0.005em]">
          <BookOpen size={14} />
          Recipe Book
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
            <BookOpen size={12} />
            LIBRARY / RECIPES
          </div>
          <h1 className="text-[28px] sm:text-[32px] font-semibold text-ink tracking-[-0.04em] leading-none">Recipe Book</h1>
          <p className="text-[13px] text-ink-3 mt-2">
            <span className="font-medium text-ink">{recipes.length} {recipes.length === 1 ? 'recipe' : 'recipes'}</span>
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            className="hidden sm:flex items-center gap-1.5 px-3.5 py-2 rounded-[9px] text-[13px] font-medium text-ink-2 bg-paper border border-line hover:border-ink-3 transition-colors"
            title="Export recipes (coming soon)"
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
          <button onClick={() => setShowNewForm(true)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-[9px] text-[13px] font-medium text-paper bg-ink hover:bg-ink-2 transition-colors">
            <span className="text-gold font-semibold">+</span>
            <span className="hidden sm:inline">New recipe</span>
            <span className="sm:hidden">New</span>
          </button>
        </div>
      </div>

      {/* ── TOOLBAR: search + sort + view ── */}
      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto] gap-2 items-center">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" />
          <input value={searchInput} onChange={e => {
              setSearchInput(e.target.value)
              clearTimeout(searchDebounce.current)
              searchDebounce.current = setTimeout(() => setSearch(e.target.value), 350)
            }} placeholder="Search recipes, ingredients, categories…"
            className="w-full pl-9 pr-9 py-2.5 text-[13px] border border-line rounded-[9px] bg-paper text-ink placeholder:text-ink-3 focus:outline-none focus:border-ink-3 transition-colors" />
          {searchInput && <button onClick={() => { setSearchInput(''); clearTimeout(searchDebounce.current); setSearch('') }} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-4 hover:text-ink-2"><X size={13} /></button>}
        </div>
        <div className="flex bg-paper border border-line rounded-[9px] p-[3px]">
          {(['az', 'cost', 'usage'] as const).map(m => (
            <button key={m} onClick={() => setSortMode(m)}
              className={`px-3 py-[5px] font-mono text-[11px] rounded-[6px] transition-colors ${sortMode === m ? 'bg-ink text-paper' : 'text-ink-3 hover:text-ink-2'}`}>
              {m === 'az' ? 'A–Z' : m === 'cost' ? 'Cost' : 'Usage'}
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
        <button onClick={() => setActiveCatId(null)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12.5px] font-medium transition-colors ${activeCatId === null ? activePill : inactivePill}`}>
          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: activeCatId === null ? '#fafaf9' : '#a1a1aa' }} />
          All <span className={`font-mono text-[10.5px] ${activeCatId === null ? 'opacity-60' : 'text-ink-3'}`}>{recipes.length}</span>
        </button>
        {typeCats.map(cat => {
          const count = recipes.filter(r => r.categoryId === cat.id).length
          const isActive = activeCatId === cat.id
          return (
            <button key={cat.id} onClick={() => setActiveCatId(isActive ? null : cat.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12.5px] font-medium transition-colors ${isActive ? activePill : inactivePill}`}>
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: cat.color ?? '#a1a1aa' }} />
              {cat.name}
              <span className={`font-mono text-[10.5px] ${isActive ? 'opacity-60' : 'text-ink-3'}`}>{count}</span>
            </button>
          )
        })}
      </div>

      {/* ── SHOWING ROW ── */}
      <div className="flex items-center justify-between -mt-1">
        <p className="font-mono text-[10.5px] text-ink-3 tracking-[0.04em] uppercase">
          {displayRecipes.length} {displayRecipes.length === 1 ? 'recipe' : 'recipes'} · {sortLabel}
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
        {showNewForm && (
          <div className="bg-paper rounded-xl border border-line p-4 mb-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-[15px] text-ink tracking-[-0.02em]">New recipe</h3>
              <button onClick={() => setShowNewForm(false)} className="text-ink-4 hover:text-ink-2"><X size={16} /></button>
            </div>
            <form onSubmit={handleCreate} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="text-[12.5px] font-medium text-ink-2 block mb-1.5">Name *</label>
                  <input required value={newForm.name} onChange={e => setNewForm(f => ({ ...f, name: e.target.value }))}
                    className="w-full border border-line rounded-[9px] px-3 py-2 text-[13px] text-ink focus:outline-none focus:border-ink-3" />
                </div>
                <div>
                  <label className="text-[12.5px] font-medium text-ink-2 block mb-1.5">Category *</label>
                  <select required value={newForm.categoryId} onChange={e => setNewForm(f => ({ ...f, categoryId: e.target.value }))}
                    className="w-full border border-line rounded-[9px] px-3 py-2 text-[13px] text-ink bg-paper focus:outline-none focus:border-ink-3">
                    <option value="">Select…</option>
                    {typeCats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[12.5px] font-medium text-ink-2 block mb-1.5">
                    Base yield *
                    <span className="ml-1.5 font-mono text-[10.5px] font-normal text-ink-3">total qty produced</span>
                  </label>
                  <div className="flex gap-1">
                    <input required type="number" min="0" step="0.01" placeholder="500" value={newForm.baseYieldQty}
                      onChange={e => setNewForm(f => ({ ...f, baseYieldQty: e.target.value }))}
                      className="flex-1 border border-line rounded-[9px] px-2.5 py-2 text-[13px] text-ink focus:outline-none focus:border-ink-3" />
                    <select required value={newForm.yieldUnit}
                      onChange={e => setNewForm(f => ({ ...f, yieldUnit: e.target.value }))}
                      className="w-28 border border-line rounded-[9px] px-2.5 py-2 text-[13px] text-ink bg-paper focus:outline-none focus:border-ink-3">
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
              <div className="flex items-start gap-2 text-[12px] text-gold-2 bg-gold-soft border border-[#fcd34d] p-2.5 rounded-[9px]">
                <Link2 size={12} className="mt-0.5 shrink-0" />
                <span>This recipe will automatically create a <strong className="text-ink">PREPD</strong> inventory item so it can be counted in stock takes and COGS.</span>
              </div>
              <div className="flex gap-2">
                <button type="submit" className="flex-1 bg-ink text-paper py-2 rounded-[9px] text-[13px] font-semibold hover:bg-ink-2 transition-colors">Create</button>
                <button type="button" onClick={() => setShowNewForm(false)} className="px-4 py-2 border border-line rounded-[9px] text-[13px] text-ink-2 hover:bg-bg-2 transition-colors">Cancel</button>
              </div>
            </form>
          </div>
        )}

        {displayRecipes.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <BookOpen size={40} className="text-ink-4 mb-3" />
            <p className="text-ink-3 text-[13px]">{search ? `No recipes match "${search}"` : 'No recipes yet'}</p>
            {!search && (
              <button onClick={() => setShowNewForm(true)} className="mt-3 font-mono text-[11px] text-gold-2 hover:text-gold">
                Create your first recipe →
              </button>
            )}
          </div>
        ) : (
          <div className="bg-paper rounded-xl border border-line overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-2.5 bg-bg-2 border-b border-line font-mono text-[10.5px] uppercase tracking-[0.04em] text-ink-3">
              <button
                onClick={handleSelectAll}
                className={`shrink-0 w-4 h-4 rounded-[4px] border-[1.5px] flex items-center justify-center transition-colors ${
                  allVisibleSelected
                    ? 'border-ink bg-ink'
                    : selectedIds.size > 0
                      ? 'border-ink bg-bg-2'
                      : 'border-line-2 hover:border-ink-3 bg-paper'
                }`}
                title={allVisibleSelected ? 'Deselect all' : 'Select all'}
              >
                {allVisibleSelected
                  ? <Check size={10} className="text-paper" strokeWidth={3} />
                  : selectedIds.size > 0
                    ? <span className="w-1.5 h-0.5 bg-ink rounded-full" />
                    : null}
              </button>
              <span className="flex-1">Name</span>
              <span className="hidden sm:block pr-20">Total cost · Base cost / unit</span>
            </div>
            {displayRecipes.map(recipe => (
              <RecipeCard key={recipe.id} recipe={recipe}
                onOpen={() => setSelectedRecipeId(recipe.id)}
                onToggle={() => handleToggle(recipe.id)}
                onDuplicate={() => handleDuplicate(recipe)}
                onDelete={() => handleDelete(recipe.id)}
                isSelected={selectedIds.has(recipe.id)}
                onSelect={() => handleSelect(recipe.id)} />
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

      {selectedIds.size > 0 && !bulkConfirm && (
        <BulkActionBar
          count={selectedIds.size}
          onDeactivate={() => setBulkConfirm('deactivate')}
          onDelete={() => setBulkConfirm('delete')}
          onClear={() => setSelectedIds(new Set())}
        />
      )}

      {bulkConfirm && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40" onClick={() => setBulkConfirm(null)} />
          <div className="relative bg-paper rounded-2xl shadow-2xl border border-line p-6 w-full max-w-sm">
            {bulkConfirm === 'deactivate' ? (
              <>
                <h3 className="font-semibold text-ink text-[15px] tracking-[-0.02em] mb-1">Deactivate {selectedIds.size} {selectedIds.size === 1 ? 'recipe' : 'recipes'}?</h3>
                <p className="text-[13px] text-ink-3 mb-5">They will be hidden from active lists but not deleted. You can reactivate them at any time.</p>
                <div className="flex gap-2">
                  <button onClick={handleBulkDeactivate} className="flex-1 py-2.5 rounded-[10px] bg-ink hover:bg-ink-2 text-paper text-[13px] font-semibold transition-colors">Deactivate</button>
                  <button onClick={() => setBulkConfirm(null)} className="flex-1 py-2.5 rounded-[10px] border border-line text-ink-2 text-[13px] hover:bg-bg-2 transition-colors">Cancel</button>
                </div>
              </>
            ) : (
              <>
                <h3 className="font-semibold text-ink text-[15px] tracking-[-0.02em] mb-1">Delete {selectedIds.size} {selectedIds.size === 1 ? 'recipe' : 'recipes'}?</h3>
                <p className="text-[13px] text-ink-3 mb-5">This is permanent and cannot be undone. All ingredients and costing data will be removed.</p>
                <div className="flex gap-2">
                  <button onClick={handleBulkDelete} className="flex-1 py-2.5 rounded-[10px] bg-red-600 hover:bg-red-700 text-paper text-[13px] font-semibold transition-colors">Delete permanently</button>
                  <button onClick={() => setBulkConfirm(null)} className="flex-1 py-2.5 rounded-[10px] border border-line text-ink-2 text-[13px] hover:bg-bg-2 transition-colors">Cancel</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

```


---

## `src/app/menu/page.tsx`

```tsx
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
                    className="flex-1 bg-red-600 hover:bg-red-700 text-paper py-2.5 rounded-[10px] text-[13px] font-semibold transition-colors"
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
        />
      )}
    </div>
  )
}

```


---

## `src/app/prep/page.tsx`

```tsx
'use client'
import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useDrawer } from '@/contexts/DrawerContext'
import dynamic from 'next/dynamic'
import {
  ChefHat, Plus, RefreshCw, Search, Settings, BookOpen,
  SlidersHorizontal, WifiOff, RefreshCcw, History, AlertTriangle, Check,
} from 'lucide-react'
import { savePrepCache, loadPrepCache, loadQueue, enqueueMutation, flushQueue } from '@/lib/prep-offline'
import { PrepKpiStrip }    from '@/components/prep/PrepKpiStrip'
import { PrepItemRow }     from '@/components/prep/PrepItemRow'
import type { PrepItemRich, PrepLogData } from '@/components/prep/types'

// Lazy-load conditional components — only mount when user opens them
const PrepDetailPanel   = dynamic(() => import('@/components/prep/PrepDetailPanel').then(m => ({ default: m.PrepDetailPanel })), { ssr: false, loading: () => null })
const PrepItemForm      = dynamic(() => import('@/components/prep/PrepItemForm').then(m => ({ default: m.PrepItemForm })), { ssr: false, loading: () => null })
const PrepSettingsModal = dynamic(() => import('@/components/prep/PrepSettingsModal').then(m => ({ default: m.PrepSettingsModal })), { ssr: false, loading: () => null })

export default function PrepPage() {
  const { setDrawerOpen } = useDrawer()
  const [items,        setItems]        = useState<PrepItemRich[]>([])
  const [loading,      setLoading]      = useState(true)
  const [generating,   setGenerating]   = useState(false)
  const [selected,     setSelected]     = useState<PrepItemRich | null>(null)
  const [editing,      setEditing]      = useState<PrepItemRich | null>(null)
  const [showAdd,      setShowAdd]      = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [actionError,  setActionError]  = useState<string | null>(null)
  const [syncing,      setSyncing]      = useState(false)
  const [syncResult,   setSyncResult]   = useState<{ created: number; updated: number; skipped: number } | null>(null)
  const [isOffline,      setIsOffline]      = useState(false)
  const [offlineSyncing, setOfflineSyncing] = useState(false)
  const [pendingCount,   setPendingCount]   = useState(0)
  const [cacheAge,       setCacheAge]       = useState<number | null>(null)

  // View state
  const [viewMode,          setViewMode]          = useState<'today' | 'smartprep' | 'history'>('today')
  const [smartPrepView,     setSmartPrepView]     = useState<'urgency' | 'category' | 'station'>('urgency')
  const [showMobileFilters, setShowMobileFilters] = useState(false)
  const [lookingGoodOpen,   setLookingGoodOpen]   = useState(false)

  // Filters (used in Smart Prep and Today)
  const [search,         setSearch]         = useState('')
  const [filterCategory, setFilterCategory] = useState('ALL')
  const [filterStation,  setFilterStation]  = useState<'ALL' | 'UNASSIGNED' | (string & {})>('ALL')
  const [activeOnly,     setActiveOnly]     = useState(true)

  // Settings — station list for Smart Prep grouping and filter dropdown
  const [stations, setStations] = useState<string[]>([])

  // History tab state
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1)
  const [historyDate,    setHistoryDate]    = useState(yesterday.toISOString().slice(0, 10))
  const [historyLogs,    setHistoryLogs]    = useState<Array<{
    id: string; status: string; actualPrepQty: number | null
    note: string | null; assignedTo: string | null; logDate: string
    prepItem: { id: string; name: string; unit: string }
  }>>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  // Prevent duplicate concurrent status mutations per item
  const pendingItems = useRef<Set<string>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    try {
      if (!navigator.onLine) throw new Error('offline')
      const res  = await fetch(`/api/prep/items?active=${activeOnly}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const fetched = Array.isArray(data) ? data : []
      setItems(fetched)
      savePrepCache(fetched)
      setIsOffline(false)
      setCacheAge(null)
    } catch (e) {
      if (!navigator.onLine) {
        const cached = loadPrepCache()
        if (cached) {
          setItems(cached.items)
          setCacheAge(Math.round((Date.now() - cached.ts) / 60000))
          setIsOffline(true)
          return
        }
        setIsOffline(true)
      }
      console.error('Failed to load prep items', e)
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [activeOnly])

  const loadSettings = useCallback(async () => {
    try {
      const res = await fetch('/api/prep/settings')
      if (res.ok) {
        const data = await res.json()
        setStations((data.stations ?? []).filter(Boolean))
      }
    } catch { /* silent degradation */ }
  }, [])

  // Reset station filter if the selected station no longer exists in settings
  useEffect(() => {
    if (
      filterStation !== 'ALL' &&
      filterStation !== 'UNASSIGNED' &&
      !stations.includes(filterStation as string)
    ) {
      setFilterStation('ALL')
    }
  }, [stations, filterStation])

  useEffect(() => {
    setIsOffline(!navigator.onLine)
    setPendingCount(loadQueue().length)
    load()
    loadSettings()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadSettings])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    setDrawerOpen(selected !== null)
    return () => setDrawerOpen(false)
  }, [selected, setDrawerOpen])

  // Online/offline events — auto-sync queue on reconnect
  useEffect(() => {
    const handleOnline = async () => {
      setIsOffline(false)
      const queue = loadQueue()
      if (queue.length > 0) {
        setOfflineSyncing(true)
        const result = await flushQueue()
        setPendingCount(0)
        setOfflineSyncing(false)
        if (result.failed > 0) {
          setActionError(`Synced ${result.synced} change${result.synced !== 1 ? 's' : ''}, but ${result.failed} failed — please refresh.`)
        }
      }
      load()
    }
    const handleOffline = () => setIsOffline(true)
    window.addEventListener('online',  handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online',  handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [load])

  const handleOfflineSync = useCallback(async () => {
    if (isOffline || offlineSyncing) return
    setOfflineSyncing(true)
    const result = await flushQueue()
    setPendingCount(0)
    setOfflineSyncing(false)
    if (result.failed > 0) {
      setActionError(`Synced ${result.synced}, but ${result.failed} change${result.failed !== 1 ? 's' : ''} failed — please refresh.`)
    }
    load()
  }, [isOffline, offlineSyncing, load])

  // Fetch history logs when History tab is active or date changes
  useEffect(() => {
    if (viewMode !== 'history') return
    setHistoryLoading(true)
    fetch(`/api/prep/logs?date=${historyDate}`)
      .then(r => r.json())
      .then(data => { setHistoryLogs(Array.isArray(data) ? data : []); setHistoryLoading(false) })
      .catch(() => setHistoryLoading(false))
  }, [viewMode, historyDate])

  // Auto-refresh every 60 seconds (paused while offline)
  useEffect(() => {
    if (isOffline) return
    const id = setInterval(load, 60_000)
    return () => clearInterval(id)
  }, [load, isOffline])

  // ── Derived data ──────────────────────────────────────────────────────────

  const categories = useMemo(() => [...new Set(items.map(i => i.category))].sort(), [items])

  // Today tab: persistent list items, sorted by priority then name
  const todayItems = useMemo(() =>
    items.filter(i => i.isOnList),
  [items])

  // Priority-change alerts: on-list items that have escalated to Critical but not started
  const priorityAlerts = useMemo(() =>
    items.filter(i =>
      i.isOnList &&
      i.priority === '911' &&
      (!i.todayLog || i.todayLog.status === 'NOT_STARTED')
    ),
  [items])

  // Smart Prep urgency buckets (all active items)
  const spCritical    = useMemo(() => items.filter(i => i.priority === '911'),          [items])
  const spNeeded      = useMemo(() => items.filter(i => i.priority === 'NEEDED_TODAY'), [items])
  const spLookingGood = useMemo(() => items.filter(i => i.priority === 'LATER'),        [items])

  // Smart Prep — by-category groups (sorted by urgency within each group)
  const PRIORITY_RANK: Record<string, number> = { '911': 0, 'NEEDED_TODAY': 1, 'LATER': 2 }
  const spCategoryGroups = useMemo(() => {
    const sorted = [...items].sort((a, b) => {
      const pd = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
      return pd !== 0 ? pd : a.name.localeCompare(b.name)
    })
    const map = new Map<string, PrepItemRich[]>()
    for (const cat of [...new Set(sorted.map(i => i.category))].sort()) map.set(cat, [])
    for (const item of sorted) map.get(item.category)!.push(item)
    return Array.from(map.entries()).filter(([, rows]) => rows.length > 0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items])

  // Smart Prep — by-station groups
  const spStationGroups = useMemo(() => {
    const sorted = [...items].sort((a, b) => {
      const pd = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
      return pd !== 0 ? pd : a.name.localeCompare(b.name)
    })
    const groups: [string, PrepItemRich[]][] = []
    for (const station of stations) {
      const rows = sorted.filter(i => i.station === station)
      if (rows.length > 0) groups.push([station, rows])
    }
    const unassigned = sorted.filter(i => !i.station || i.station.trim() === '')
    if (unassigned.length > 0) groups.push(['Unassigned', unassigned])
    const other = sorted.filter(i => i.station && i.station.trim() !== '' && !stations.includes(i.station))
    if (other.length > 0) groups.push(['Other', other])
    return groups.length > 0 ? groups : null
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, stations])

  // Today filter (search + optional category/station filters)
  const filteredToday = useMemo(() => {
    return todayItems.filter(item => {
      if (search && !item.name.toLowerCase().includes(search.toLowerCase())) return false
      if (filterCategory !== 'ALL' && item.category !== filterCategory) return false
      if (filterStation === 'UNASSIGNED') {
        if (item.station && item.station.trim() !== '') return false
      } else if (filterStation !== 'ALL') {
        if (item.station !== filterStation) return false
      }
      return true
    })
  }, [todayItems, search, filterCategory, filterStation])

  // Keep detail panel in sync with live data
  const selectedLive = useMemo(
    () => selected ? (items.find(i => i.id === selected.id) ?? selected) : null,
    [selected, items],
  )

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleRefresh = async () => {
    setGenerating(true)
    try { await load() }
    catch { setActionError('Refresh failed — check your connection and try again.') }
    finally { setGenerating(false) }
  }

  const handleSync = async () => {
    setSyncing(true)
    setSyncResult(null)
    try {
      const res  = await fetch('/api/prep/sync-from-recipes', { method: 'POST' })
      const data = await res.json()
      setSyncResult(data)
      if (data.created > 0) await load()
    } catch {
      setActionError('Sync failed — check your connection and try again.')
    } finally {
      setSyncing(false)
    }
  }

  async function handleStatusChange(itemId: string, newStatus: string, actualQty?: number) {
    if (pendingItems.current.has(itemId)) return
    const item = items.find(i => i.id === itemId)
    if (!item) return
    pendingItems.current.add(itemId)

    const now = new Date().toISOString()
    const completingNow = newStatus === 'DONE' || newStatus === 'PARTIAL'
    setItems(prev => prev.map(i => {
      if (i.id !== itemId) return i
      const existingLog = i.todayLog
      return {
        ...i,
        ...(completingNow && { manualPriorityOverride: null }),
        todayLog: existingLog
          ? { ...existingLog, status: newStatus as PrepLogData['status'], ...(actualQty !== undefined ? { actualPrepQty: actualQty } : {}) }
          : {
              id: `_opt_${itemId}`,
              prepItemId: itemId,
              logDate: now.split('T')[0],
              status: newStatus as PrepLogData['status'],
              requiredQty: null,
              actualPrepQty: actualQty ?? null,
              assignedTo: null,
              dueTime: null,
              note: null,
              blockedReason: null,
              inventoryAdjusted: false,
              createdAt: now,
              updatedAt: now,
            },
      }
    }))

    if (!navigator.onLine) {
      enqueueMutation({ type: 'status', itemId, logId: item.todayLog?.id ?? null, status: newStatus, actualQty })
      setPendingCount(n => n + 1)
      pendingItems.current.delete(itemId)
      return
    }

    try {
      let logId = item.todayLog?.id
      if (!logId || logId.startsWith('_opt_')) {
        const log = await fetch('/api/prep/logs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prepItemId: itemId }),
        }).then(r => r.json())
        logId = log.id
        setItems(prev => prev.map(i => {
          if (i.id !== itemId || !i.todayLog) return i
          return { ...i, todayLog: { ...i.todayLog, id: log.id } }
        }))
      }
      await fetch(`/api/prep/logs/${logId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: newStatus,
          ...(actualQty !== undefined ? { actualPrepQty: actualQty } : {}),
        }),
      })
    } catch {
      setActionError('Status update failed — try again.')
      load()
    } finally {
      pendingItems.current.delete(itemId)
    }
  }

  async function handlePriorityChange(itemId: string, priority: string) {
    setItems(prev => prev.map(item => {
      if (item.id !== itemId) return item
      return {
        ...item,
        manualPriorityOverride: priority || null,
        priority: (priority as PrepItemRich['priority']) || item.priority,
      }
    }))

    if (!navigator.onLine) {
      enqueueMutation({ type: 'priority', itemId, priority })
      setPendingCount(n => n + 1)
      return
    }

    try {
      await fetch(`/api/prep/items/${itemId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manualPriorityOverride: priority }),
      })
      if (!priority) load()
    } catch {
      setActionError('Priority update failed — try again.')
      load()
    }
  }

  async function handleDelete(itemId: string) {
    try {
      await fetch(`/api/prep/items/${itemId}`, { method: 'DELETE' })
      if (selected?.id === itemId) setSelected(null)
      load()
    } catch {
      setActionError('Delete failed — try again.')
    }
  }

  // Toggle isOnList: add to list (true) or remove from list (false)
  async function handleToggleOnList(itemId: string, newValue: boolean) {
    // Optimistic update
    setItems(prev => prev.map(i =>
      i.id === itemId ? { ...i, isOnList: newValue } : i
    ))

    if (!navigator.onLine) {
      enqueueMutation({ type: 'isOnList_toggle', itemId, isOnList: newValue })
      setPendingCount(n => n + 1)
      return
    }

    try {
      await fetch(`/api/prep/items/${itemId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isOnList: newValue }),
      })
      // When removing from list, log SKIPPED for today so it shows in History
      if (!newValue) {
        const existingLog = items.find(i => i.id === itemId)?.todayLog
        if (!existingLog || existingLog.status === 'NOT_STARTED') {
          await fetch('/api/prep/logs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prepItemId: itemId, status: 'SKIPPED' }),
          }).catch(() => {}) // non-critical — don't fail the whole operation
        }
      }
    } catch {
      setActionError('Could not update list — try again.')
      load()
    }
  }

  // Bulk add all items of a given priority to the list
  async function handleAddAll(priority: '911' | 'NEEDED_TODAY') {
    const targets = items.filter(i => i.priority === priority && !i.isOnList)
    if (targets.length === 0) return
    // Optimistic: flip all at once
    setItems(prev => prev.map(i =>
      targets.some(t => t.id === i.id) ? { ...i, isOnList: true } : i
    ))
    await Promise.all(targets.map(i =>
      fetch(`/api/prep/items/${i.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isOnList: true }),
      })
    ))
  }

  // ── Render helpers ────────────────────────────────────────────────────────

  const selCls = 'border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gold'
  const activeFilterCount = [filterCategory !== 'ALL', filterStation !== 'ALL'].filter(Boolean).length

  const STATION_EMOJI: Record<string, string> = {
    'Cold': '❄',
    'Hot': '🔥',
    'Pastry': '🥐',
    'Butchery': '🔪',
    'Garde Manger': '🥗',
  }

  // ── Smart Prep item card (shared across urgency/category/station views) ──
  function SmartPrepCard({ item }: { item: PrepItemRich }) {
    const stockPct = item.parLevel > 0 ? Math.min(100, (item.onHand / item.parLevel) * 100) : 100
    const parPct = item.parLevel > 0 ? Math.round((item.onHand / item.parLevel) * 100) : 100
    const isCritical = item.priority === '911'
    const isNeeded = item.priority === 'NEEDED_TODAY'
    const barColor = isCritical ? 'bg-red-500' : isNeeded ? 'bg-gold' : 'bg-green-500'
    const suggestColor = isCritical ? 'text-red-700' : isNeeded ? 'text-gold-2' : 'text-green-700'
    const suggestAccent = isCritical ? 'text-red-500' : isNeeded ? 'text-gold' : 'text-green-500'
    const isAdded = item.isOnList
    const cardBorder = isCritical ? 'border-[#fca5a5]' : 'border-line'

    return (
      <div className={`bg-paper border ${cardBorder} rounded-[10px] p-3.5 flex flex-col gap-2.5`}>
        {/* Top: name + meta + Add button */}
        <div className="flex items-start justify-between gap-2.5">
          <button onClick={() => setSelected(item)} className="text-left min-w-0 flex-1 hover:opacity-80 transition-opacity">
            <div className="text-[14.5px] font-semibold tracking-[-0.015em] text-ink leading-[1.2]">{item.name}</div>
            <div className="flex items-center gap-1.5 mt-1 flex-wrap whitespace-nowrap">
              <span className="font-mono text-[10.5px] text-ink-3">{item.category}</span>
              {item.station && (
                <span className="font-mono text-[9.5px] px-1.5 py-0.5 rounded-[4px] bg-bg-2 text-ink-2 font-medium tracking-[0.02em] uppercase">{item.station}</span>
              )}
              {item.manualPriorityOverride && (
                <span className="font-mono text-[9.5px] text-gold-2 bg-gold-soft px-1.5 py-0.5 rounded-[4px] font-medium">✎ OVERRIDE</span>
              )}
            </div>
          </button>
          <button
            onClick={() => handleToggleOnList(item.id, !isAdded)}
            title={isAdded ? "Remove from today's list" : "Add to today's list"}
            className={`shrink-0 px-3 py-2 rounded-[8px] text-[12.5px] font-medium tracking-[-0.005em] inline-flex items-center gap-1.5 whitespace-nowrap transition-colors group ${
              isAdded
                ? 'bg-bg-2 text-ink-2 border border-line hover:border-red-300 hover:bg-red-50 hover:text-red-600'
                : 'bg-ink text-paper hover:bg-ink-2'
            }`}
          >
            {isAdded
              ? <><Check size={13} className="text-green-600 group-hover:text-red-500" /> On list <span className="opacity-50 ml-0.5">✕</span></>
              : <><span className="text-gold font-semibold">+</span> Add</>}
          </button>
        </div>

        {/* Progress */}
        <div className="flex flex-col gap-1.5">
          <div className="flex justify-between font-mono text-[11px] text-ink-3 gap-2 whitespace-nowrap">
            <span><b className="text-ink font-medium">{item.onHand % 1 === 0 ? item.onHand.toFixed(0) : item.onHand.toFixed(1)}</b> / {item.parLevel % 1 === 0 ? item.parLevel.toFixed(0) : item.parLevel.toFixed(1)} {item.unit} on hand</span>
            <span className={isCritical ? 'text-red-700' : isNeeded ? 'text-gold-2' : 'text-ink-3'}>{parPct}% of par</span>
          </div>
          <div className="h-1.5 bg-bg-2 rounded-full overflow-hidden">
            <div className={`h-full ${barColor} rounded-full transition-all`} style={{ width: `${Math.max(stockPct, isCritical && stockPct < 1 ? 1 : 0)}%` }} />
          </div>
        </div>

        {/* Suggestion */}
        {item.priority !== 'LATER' ? (
          item.manualPriorityOverride ? (
            <div className="font-mono text-[11.5px] text-ink-3 line-through tracking-[0]">
              System suggests → {item.suggestedQty > 0 ? `make ${item.suggestedQty % 1 === 0 ? item.suggestedQty.toFixed(0) : item.suggestedQty.toFixed(1)} ${item.unit}` : 'review stock'}
            </div>
          ) : (
            <div className={`font-mono text-[11.5px] tracking-[0] flex items-center gap-1.5 whitespace-nowrap ${suggestColor}`}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={suggestAccent}><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>
              System suggests <b className={`${suggestAccent} font-semibold`}>→ make {item.suggestedQty > 0 ? `${item.suggestedQty % 1 === 0 ? item.suggestedQty.toFixed(0) : item.suggestedQty.toFixed(1)} ${item.unit}` : 'TBD'}</b>
              {item.estimatedPrepTime ? <> · ~{item.estimatedPrepTime} min</> : null}
            </div>
          )
        ) : (
          <div className="font-mono text-[11.5px] text-green-700 tracking-[0]">At or above par — looking good</div>
        )}

        {/* Override pills */}
        <div className="flex items-center gap-1.5 flex-wrap pt-2.5 border-t border-line">
          <span className="font-mono text-[10px] text-ink-3 tracking-[0.02em] mr-0.5">OVERRIDE</span>
          {(['911', 'NEEDED_TODAY', 'LATER'] as const).map(p => {
            const labels: Record<string, string> = { '911': 'Critical', 'NEEDED_TODAY': 'Needed today', 'LATER': 'Later' }
            const isActive = (item.manualPriorityOverride ?? item.priority) === p
            const activeCls = p === '911'
              ? 'bg-red-100 text-red-700 border-red-100'
              : p === 'NEEDED_TODAY'
                ? 'bg-gold-soft text-gold-2 border-gold-soft'
                : 'bg-bg-2 text-ink-2 border-bg-2'
            return (
              <button
                key={p}
                onClick={() => handlePriorityChange(item.id, isActive && item.manualPriorityOverride ? '' : p)}
                className={`font-mono text-[10px] px-2 py-1 rounded-full border font-medium tracking-[0] transition-colors ${
                  isActive ? activeCls : 'bg-paper text-ink-2 border-line hover:border-ink-3'
                }`}
              >
                {labels[p]}
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  // ── Smart Prep grouped table row (category / station views) ───────────────
  function SmartPrepTableRow({ item }: { item: PrepItemRich }) {
    const stockPct = item.parLevel > 0 ? Math.min(100, (item.onHand / item.parLevel) * 100) : 100
    const isCritical = item.priority === '911'
    const isNeeded = item.priority === 'NEEDED_TODAY'
    const dotColor = isCritical ? 'bg-red-500' : isNeeded ? 'bg-gold' : 'bg-green-500'
    const barColor = isCritical ? 'bg-red-500' : isNeeded ? 'bg-gold' : 'bg-green-500'
    const suggestColor = isCritical ? 'text-red-700' : isNeeded ? 'text-gold-2' : 'text-ink-3'
    const isAdded = item.isOnList

    const labels: Record<string, string>     = { '911': 'CRITICAL', 'NEEDED_TODAY': 'NEEDED', 'LATER': 'ON PAR' }
    const badgeStyles: Record<string, string> = {
      '911': 'bg-red-100 text-red-700',
      'NEEDED_TODAY': 'bg-gold-soft text-gold-2',
      'LATER': 'bg-green-100 text-green-700',
    }

    return (
      <div className="grid grid-cols-[16px_2fr_1fr_110px_1fr_220px_110px] gap-3 items-center px-[18px] py-3 border-b border-line last:border-0 hover:bg-bg/60 transition-colors text-[13.5px]">
        <span className={`w-2 h-2 rounded-full ${dotColor} inline-block shrink-0`} />
        <button onClick={() => setSelected(item)} className="text-left hover:opacity-80 transition-opacity min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[13.5px] font-medium text-ink tracking-[-0.01em]">{item.name}</span>
            <span className={`font-mono text-[9.5px] px-1.5 py-0.5 rounded-[4px] font-semibold tracking-[0.02em] ${badgeStyles[item.priority]}`}>{labels[item.priority]}</span>
            {item.station && <span className="font-mono text-[9.5px] bg-bg-2 text-ink-2 px-1.5 py-0.5 rounded-[4px] font-medium tracking-[0.02em] uppercase">{item.station}</span>}
            {item.manualPriorityOverride && <span className="font-mono text-[9.5px] text-gold-2 bg-gold-soft px-1.5 py-0.5 rounded-[4px] font-medium">✎ OVERRIDE</span>}
            {isAdded && <span className="font-mono text-[10px] text-ink-4 italic">on list</span>}
          </div>
          <div className={`font-mono text-[10.5px] mt-1 tracking-[0] whitespace-nowrap ${suggestColor}`}>
            {item.priority !== 'LATER' && !item.manualPriorityOverride
              ? `System suggests → ${item.suggestedQty > 0 ? `make ${item.suggestedQty % 1 === 0 ? item.suggestedQty.toFixed(0) : item.suggestedQty.toFixed(1)} ${item.unit}` : 'review stock'}`
              : item.priority === 'LATER' ? 'At or above par' : 'Chef override active'
            }
          </div>
        </button>
        <div>
          <div className="h-1.5 bg-bg-2 rounded-full overflow-hidden">
            <div className={`h-full rounded-full ${barColor}`} style={{ width: `${Math.max(stockPct, isCritical && stockPct < 1 ? 1 : 0)}%` }} />
          </div>
        </div>
        <div className="font-mono text-[12.5px] text-ink-2 tracking-[-0.01em] whitespace-nowrap">
          {item.onHand % 1 === 0 ? item.onHand.toFixed(0) : item.onHand.toFixed(1)} / {item.parLevel % 1 === 0 ? item.parLevel.toFixed(0) : item.parLevel.toFixed(1)} {item.unit}
        </div>
        <div className={`font-mono text-[12.5px] font-medium tracking-[-0.01em] ${isCritical ? 'text-red-700' : isNeeded ? 'text-gold-2' : 'text-ink-4'}`}>
          {item.priority !== 'LATER' && item.suggestedQty > 0
            ? `${item.suggestedQty % 1 === 0 ? item.suggestedQty.toFixed(0) : item.suggestedQty.toFixed(1)} ${item.unit}`
            : '—'
          }
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {(['911', 'NEEDED_TODAY', 'LATER'] as const).map(p => {
            const chipLabels: Record<string, string> = { '911': 'Critical', 'NEEDED_TODAY': 'Needed', 'LATER': 'Later' }
            const isActive = (item.manualPriorityOverride ?? item.priority) === p
            const activeCls = p === '911'
              ? 'bg-red-100 text-red-700 border-red-100'
              : p === 'NEEDED_TODAY'
                ? 'bg-gold-soft text-gold-2 border-gold-soft'
                : 'bg-bg-2 text-ink-2 border-bg-2'
            return (
              <button
                key={p}
                onClick={() => handlePriorityChange(item.id, isActive && item.manualPriorityOverride ? '' : p)}
                className={`font-mono text-[10px] px-2 py-0.5 rounded-full border font-medium tracking-[0] transition-colors ${
                  isActive ? activeCls : 'bg-paper text-ink-2 border-line hover:border-ink-3'
                }`}
              >
                {chipLabels[p]}
              </button>
            )
          })}
        </div>
        <div className="flex justify-end">
          <button
            onClick={() => handleToggleOnList(item.id, !isAdded)}
            title={isAdded ? "Remove from today's list" : "Add to today's list"}
            className={`px-3 py-1.5 rounded-[8px] text-[12px] font-medium tracking-[-0.005em] inline-flex items-center gap-1 whitespace-nowrap transition-colors group ${
              isAdded
                ? 'bg-bg-2 text-ink-2 border border-line hover:border-red-300 hover:bg-red-50 hover:text-red-600'
                : 'bg-ink text-paper hover:bg-ink-2'
            }`}
          >
            {isAdded
              ? <><Check size={12} className="text-green-600 group-hover:text-red-500" /> On list <span className="opacity-50 ml-0.5">✕</span></>
              : <><span className="text-gold font-semibold">+</span> Add</>}
          </button>
        </div>
      </div>
    )
  }

  // ── Page JSX ──────────────────────────────────────────────────────────────

  return (
    <div className="space-y-3 md:space-y-5">

      {/* ── Mobile Header ── */}
      <div className="md:hidden">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h1 className="text-xl font-bold text-gray-900 flex items-center gap-1.5">
              <ChefHat size={20} className="text-gold" /> Prep List
            </h1>
            <p className="text-xs text-gray-500">
              {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <button onClick={handleRefresh} disabled={generating}
              className="p-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              title="Refresh">
              <RefreshCw size={16} className={generating ? 'animate-spin' : ''} />
            </button>
            <button onClick={() => setShowSettings(true)}
              className="p-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
              title="Settings">
              <Settings size={16} />
            </button>
            <button onClick={handleSync} disabled={syncing}
              className="p-2 rounded-lg border border-gold/30 text-gold bg-gold/10 hover:bg-gold/15 disabled:opacity-50"
              title="Sync from Recipes">
              <BookOpen size={16} className={syncing ? 'animate-pulse' : ''} />
            </button>
            <button onClick={() => setShowAdd(true)}
              className="p-2 rounded-lg bg-gold text-white hover:bg-[#a88930]">
              <Plus size={16} />
            </button>
          </div>
        </div>

        {/* Mobile view tabs */}
        <div className="flex bg-gray-100 rounded-xl p-1 mt-3">
          {(['today', 'smartprep', 'history'] as const).map(m => (
            <button key={m} onClick={() => setViewMode(m)}
              className={`flex-1 py-2 text-xs font-medium rounded-lg transition-colors flex items-center justify-center gap-1 ${viewMode === m ? 'bg-white shadow text-gray-900' : 'text-gray-500'}`}>
              {m === 'today' ? <>To Do {todayItems.length > 0 && <span className="bg-amber-500 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full">{todayItems.length}</span>}</> : m === 'smartprep' ? <>Smart Prep {(spCritical.length + spNeeded.length) > 0 && <span className="bg-red-500 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full">{spCritical.length + spNeeded.length}</span>}</> : <><History size={12} /> History</>}
            </button>
          ))}
        </div>

        {/* Mobile KPI strip (Today only) */}
        {viewMode === 'today' && (
          <div className="mt-2">
            <PrepKpiStrip items={todayItems} />
          </div>
        )}

        {/* Search + filter toggle */}
        {viewMode !== 'history' && (
          <div className="flex gap-2 mt-3">
            <div className="relative flex-1">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-gold"
                placeholder="Search prep items…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <button
              onClick={() => setShowMobileFilters(v => !v)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border text-sm font-medium transition-colors ${
                showMobileFilters || activeFilterCount > 0
                  ? 'border-blue-300 bg-gold/10 text-gold'
                  : 'border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}>
              <SlidersHorizontal size={15} />
              {activeFilterCount > 0 ? <span className="bg-gold text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">{activeFilterCount}</span> : 'Filter'}
            </button>
          </div>
        )}

        {showMobileFilters && (
          <div className="mt-2 bg-white border border-gray-100 rounded-xl p-3 space-y-2">
            <select className={selCls + ' w-full'} value={filterCategory} onChange={e => setFilterCategory(e.target.value)}>
              <option value="ALL">All Categories</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select className={selCls + ' w-full'} value={filterStation} onChange={e => setFilterStation(e.target.value)}>
              <option value="ALL">All Stations</option>
              <option value="UNASSIGNED">Unassigned</option>
              {stations.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        )}
      </div>

      {/* ── Desktop Header ── */}
      <div className="hidden md:block space-y-4">
        {/* Top bar */}
        <div className="flex items-center justify-between gap-6">
          <div>
            <p className="font-mono text-[10.5px] text-ink-3 tracking-wide mb-2 flex items-center gap-2">
              <ChefHat size={13} className="text-ink-3" />
              TODAY / PREP
            </p>
            <h1 className="text-[36px] font-semibold tracking-[-0.04em] leading-none text-ink mb-1.5">Prep list</h1>
            <p className="text-[13.5px] text-ink-3 tracking-[-0.005em]">
              {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
            </p>
          </div>

          {/* Desktop tabs — centered, branded pill */}
          <div className="inline-flex bg-bg-2 border border-line rounded-[10px] p-[3px] gap-0.5">
            <button onClick={() => setViewMode('today')} id="dtab-today"
              className={`px-3.5 py-1.5 text-[13px] font-medium rounded-[7px] transition-colors flex items-center gap-1.5 tracking-[-0.005em] ${viewMode === 'today' ? 'bg-paper text-ink shadow-[0_1px_2px_rgba(0,0,0,0.04)]' : 'text-ink-3 hover:text-ink-2'}`}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18M7 13h4M7 16h6"/></svg>
              To do
              {todayItems.length > 0 && <span className="font-mono text-[10px] bg-red-500 text-white px-1.5 py-0.5 rounded-full font-semibold">{todayItems.length}</span>}
            </button>
            <button onClick={() => setViewMode('smartprep')} id="dtab-smartprep"
              className={`px-3.5 py-1.5 text-[13px] font-medium rounded-[7px] transition-colors flex items-center gap-1.5 tracking-[-0.005em] ${viewMode === 'smartprep' ? 'bg-paper text-ink shadow-[0_1px_2px_rgba(0,0,0,0.04)]' : 'text-ink-3 hover:text-ink-2'}`}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>
              Smart prep
              {(spCritical.length + spNeeded.length) > 0 && <span className="font-mono text-[10px] bg-red-500 text-white px-1.5 py-0.5 rounded-full font-semibold">{spCritical.length + spNeeded.length}</span>}
            </button>
            <button onClick={() => setViewMode('history')} id="dtab-history"
              className={`px-3.5 py-1.5 text-[13px] font-medium rounded-[7px] transition-colors flex items-center gap-1.5 tracking-[-0.005em] ${viewMode === 'history' ? 'bg-paper text-ink shadow-[0_1px_2px_rgba(0,0,0,0.04)]' : 'text-ink-3 hover:text-ink-2'}`}>
              <History size={13} />
              History
            </button>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button onClick={handleRefresh} disabled={generating}
              className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-[9px] border border-line bg-paper text-ink-2 text-[13px] font-medium hover:border-ink-3 transition-colors disabled:opacity-50 whitespace-nowrap">
              <RefreshCw size={13} className={`text-ink-3 ${generating ? 'animate-spin' : ''}`} />
              {generating ? 'Refreshing…' : 'Refresh'}
            </button>
            <button onClick={handleSync} disabled={syncing}
              className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-[9px] border border-line bg-paper text-ink-2 text-[13px] font-medium hover:border-ink-3 transition-colors disabled:opacity-50 whitespace-nowrap">
              <BookOpen size={13} className={`text-ink-3 ${syncing ? 'animate-pulse' : ''}`} />
              {syncing ? 'Syncing…' : 'Sync from recipes'}
            </button>
            <button onClick={() => setShowSettings(true)}
              className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-[9px] border border-line bg-paper text-ink-2 text-[13px] font-medium hover:border-ink-3 transition-colors whitespace-nowrap">
              <Settings size={13} className="text-ink-3" />
              Settings
            </button>
            <button onClick={() => setShowAdd(true)}
              className="flex items-center gap-1.5 px-4 py-2.5 rounded-[9px] bg-ink text-paper text-[13px] font-medium hover:bg-ink-2 transition-colors whitespace-nowrap">
              <span className="text-gold font-semibold text-base leading-none">+</span>
              Add item
            </button>
          </div>
        </div>

        {/* Desktop filter bar (Today only — Smart Prep has its own branded tools row) */}
        {viewMode === 'today' && (
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2 items-center">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" />
              <input
                className="w-full bg-paper border border-line rounded-[9px] pl-9 pr-3 py-2.5 text-[13px] text-ink placeholder:text-ink-3 focus:outline-none focus:border-ink-3 transition-colors tracking-[-0.005em]"
                placeholder="Search prep items…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <select
              value={filterCategory}
              onChange={e => setFilterCategory(e.target.value)}
              className="bg-paper border border-line rounded-[9px] px-3 py-2.5 text-[13px] text-ink-2 hover:border-ink-3 focus:outline-none focus:border-ink-3 transition-colors min-w-[140px] tracking-[-0.005em]"
            >
              <option value="ALL">All categories</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select
              value={filterStation}
              onChange={e => setFilterStation(e.target.value)}
              className="bg-paper border border-line rounded-[9px] px-3 py-2.5 text-[13px] text-ink-2 hover:border-ink-3 focus:outline-none focus:border-ink-3 transition-colors min-w-[140px] tracking-[-0.005em]"
            >
              <option value="ALL">All stations</option>
              <option value="UNASSIGNED">Unassigned</option>
              {stations.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <label className="bg-paper border border-line rounded-[9px] px-3 py-2.5 text-[13px] text-ink-2 hover:border-ink-3 transition-colors flex items-center gap-2 cursor-pointer tracking-[-0.005em]">
              <span className={`w-[14px] h-[14px] border-[1.5px] rounded-[3px] grid place-items-center text-[9px] ${activeOnly ? 'bg-ink border-ink text-paper' : 'border-line-2 bg-paper'}`}>
                {activeOnly && '✓'}
              </span>
              <input type="checkbox" checked={activeOnly} onChange={e => setActiveOnly(e.target.checked)} className="hidden" />
              Active only
            </label>
          </div>
        )}
      </div>

      {/* ── System banners ── */}
      {actionError && (
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          <span>{actionError}</span>
          <button onClick={() => setActionError(null)} className="shrink-0 text-red-400 hover:text-red-600">✕</button>
        </div>
      )}

      {(isOffline || pendingCount > 0) && (
        <div className={`flex items-center justify-between gap-3 px-4 py-2.5 rounded-xl text-sm border ${
          isOffline ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-gold/10 border-gold/30 text-blue-800'
        }`}>
          <div className="flex items-center gap-2 min-w-0">
            <WifiOff size={14} className="shrink-0" />
            <span className="truncate">
              {offlineSyncing ? 'Syncing changes…' : isOffline ? `Offline${cacheAge !== null ? ` — data from ${cacheAge < 1 ? 'just now' : `${cacheAge}m ago`}` : ''}` : 'Back online'}
            </span>
            {pendingCount > 0 && !offlineSyncing && (
              <span className="font-semibold shrink-0">· {pendingCount} change{pendingCount !== 1 ? 's' : ''} pending</span>
            )}
          </div>
          {pendingCount > 0 && !isOffline && !offlineSyncing && (
            <button onClick={handleOfflineSync} className="shrink-0 flex items-center gap-1 text-xs font-medium text-gold hover:text-blue-900">
              <RefreshCcw size={12} /> Sync now
            </button>
          )}
        </div>
      )}

      {syncResult && (
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 bg-green-50 border border-green-200 rounded-xl text-sm text-green-800">
          <span>
            {(syncResult.created > 0 || syncResult.updated > 0)
              ? <>{syncResult.created > 0 && <> Created <strong>{syncResult.created}</strong> new prep item{syncResult.created !== 1 ? 's' : ''}.</>}{syncResult.updated > 0 && <> Updated categor{syncResult.updated !== 1 ? 'ies' : 'y'} on <strong>{syncResult.updated}</strong> existing item{syncResult.updated !== 1 ? 's' : ''}.</>}</>
              : <>Everything is already in sync — {syncResult.skipped} prep item{syncResult.skipped !== 1 ? 's' : ''} matched.</>
            }
          </span>
          <button onClick={() => setSyncResult(null)} className="shrink-0 text-green-500 hover:text-green-700">✕</button>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          TODAY TAB
      ══════════════════════════════════════════════════════ */}
      {viewMode === 'today' && (
        <div className="space-y-4">

          {/* Desktop KPI strip */}
          <div className="hidden md:block">
            <PrepKpiStrip items={todayItems} />
          </div>

          {/* Priority-change alert */}
          {priorityAlerts.length > 0 && (
            <div className="bg-orange-50 border border-orange-200 rounded-xl px-4 py-3 flex items-start gap-3">
              <AlertTriangle size={16} className="text-orange-500 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-semibold text-orange-800">Stock changed since scheduling</p>
                <p className="text-sm text-orange-700 mt-0.5">
                  {priorityAlerts.length === 1
                    ? <><strong>{priorityAlerts[0].name}</strong> is now Critical — theoretical stock at or below 0.</>
                    : <><strong>{priorityAlerts.map(i => i.name).join(', ')}</strong> — now Critical, stock depleted.</>
                  }
                </p>
              </div>
            </div>
          )}

          {loading ? (
            <div className="flex justify-center py-16">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gold" />
            </div>
          ) : todayItems.length === 0 ? (
            <div className="bg-white border border-gray-100 rounded-xl py-16 text-center">
              <ChefHat size={32} className="mx-auto text-gray-300 mb-3" />
              <p className="text-gray-500 text-sm">Nothing on today&apos;s list yet.</p>
              <p className="text-xs text-gray-400 mt-2">
                Go to{' '}
                <button onClick={() => setViewMode('smartprep')} className="text-gold hover:underline">
                  Smart Prep
                </button>
                {' '}and add items to your list.
              </p>
            </div>
          ) : (
            <>
              {/* Today list */}
              <div className="bg-white border border-gray-100 rounded-xl overflow-hidden divide-y divide-gray-50">
                {filteredToday.map(item => (
                  <PrepItemRow
                    key={item.id}
                    item={item}
                    onClick={() => setSelected(item)}
                    onStatusChange={handleStatusChange}
                    onPriorityChange={handlePriorityChange}
                    onDelete={handleDelete}
                    onToggleOnList={handleToggleOnList}
                  />
                ))}
              </div>
              <p className="text-center text-xs text-gray-400">
                This list carries over each day — items stay until marked done or removed.
              </p>
            </>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          SMART PREP TAB
      ══════════════════════════════════════════════════════ */}
      {viewMode === 'smartprep' && (
        <div className="space-y-4">
          {/* ── Desktop KPI strip (Smart Prep context cards) ── */}
          {(() => {
            const actionItems = [...spCritical, ...spNeeded]
            const topAction = actionItems[0]
            const totalPrepMinutes = actionItems.reduce((sum, i) => sum + (i.estimatedPrepTime ?? 0), 0)
            const stationsCount = new Set(items.filter(i => i.station).map(i => i.station)).size
            return (
              <div className="hidden md:grid grid-cols-[1.35fr_1.1fr_1fr_1.1fr] gap-3">
                {/* Hero — today's suggested prep */}
                <div className="bg-ink text-paper rounded-xl border border-ink p-[18px] flex flex-col justify-between min-h-[128px] relative">
                  <div className="absolute top-[18px] right-4 flex items-end gap-[2px] h-[18px]">
                    {[11,14,8,16,10,13,17,12].map((h, i) => (
                      <span key={i} className="w-[3px] rounded-[1px]" style={{ height: h, background: '#3f3f46' }} />
                    ))}
                  </div>
                  <div>
                    <p className="font-mono text-[10.5px] text-[#a1a1aa] tracking-[0.01em]">TODAY&apos;S SUGGESTED PREP</p>
                    <p className="text-[42px] font-semibold tracking-[-0.045em] leading-none mt-2">
                      {actionItems.length}
                      <sub className="text-[20px] font-medium text-gold align-baseline ml-1 tracking-[-0.02em]">
                        item{actionItems.length !== 1 ? 's' : ''}
                      </sub>
                    </p>
                  </div>
                  <p className="font-mono text-[11px] text-[#a1a1aa] mt-2">
                    {topAction
                      ? <>{topAction.suggestedQty % 1 === 0 ? topAction.suggestedQty.toFixed(0) : topAction.suggestedQty.toFixed(1)} {topAction.unit} {topAction.name.toLowerCase()}{totalPrepMinutes > 0 ? <> · <b className="text-paper font-medium">~{totalPrepMinutes} min</b></> : null}</>
                      : 'nothing to prep right now'}
                  </p>
                </div>

                {/* Critical */}
                <div className="rounded-xl p-[18px] flex flex-col justify-between min-h-[128px] relative bg-[#fef2f2] border border-[#fca5a5]">
                  {spCritical.length > 0 && <div className="absolute top-[18px] right-[18px] w-[7px] h-[7px] rounded-full bg-red-500" />}
                  <div>
                    <p className="font-mono text-[10.5px] tracking-[0.01em] text-red-700">CRITICAL</p>
                    <p className="text-[34px] font-semibold tracking-[-0.04em] leading-none mt-2 text-red-700">{spCritical.length}</p>
                  </div>
                  <p className="font-mono text-[11px] text-ink-3 mt-2">
                    {spCritical.length > 0
                      ? <><b className="text-red-700 font-medium">Stock depleted</b> · needs prep now</>
                      : <>no critical items</>}
                  </p>
                </div>

                {/* Needed today */}
                <div className="bg-paper border border-line rounded-xl p-[18px] flex flex-col justify-between min-h-[128px]">
                  <div>
                    <p className="font-mono text-[10.5px] text-ink-3 tracking-[0.01em]">NEEDED TODAY</p>
                    <p className={`text-[34px] font-semibold tracking-[-0.04em] leading-none mt-2 ${spNeeded.length > 0 ? 'text-ink' : 'text-ink-3'}`}>{spNeeded.length}</p>
                  </div>
                  <p className="font-mono text-[11px] text-ink-3 mt-2">
                    {spNeeded.length > 0 ? 'below par — prep today' : 'no items below par right now'}
                  </p>
                </div>

                {/* Looking good */}
                <div className="bg-paper border border-line rounded-xl p-[18px] flex flex-col justify-between min-h-[128px]">
                  <div>
                    <p className="font-mono text-[10.5px] text-ink-3 tracking-[0.01em]">LOOKING GOOD</p>
                    <p className="text-[34px] font-semibold tracking-[-0.04em] leading-none mt-2 text-green-700">{spLookingGood.length}</p>
                  </div>
                  <p className="font-mono text-[11px] text-ink-3 mt-2">
                    <b className="text-green-700 font-medium">on par or above</b>{stationsCount > 0 ? ` · across ${stationsCount} station${stationsCount !== 1 ? 's' : ''}` : ''}
                  </p>
                </div>
              </div>
            )
          })()}

          {/* Info banner (branded) */}
          <div className="hidden md:flex items-center gap-3 px-4 py-3 bg-gold-soft border border-[#fcd34d] rounded-[10px]">
            <div className="w-7 h-7 rounded-[7px] bg-paper border border-[#fcd34d] grid place-items-center text-gold-2 shrink-0">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/></svg>
            </div>
            <p className="text-[13px] text-[#78350f] tracking-[-0.005em] leading-[1.4] flex-1">
              Suggestions are computed live from <b className="font-semibold text-ink">theoretical stock</b> — sales, wastage &amp; invoices since the last count. Resets at each stock count.
            </p>
          </div>

          {/* Mobile info banner (original) */}
          <div className="md:hidden flex items-center gap-3 flex-wrap">
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 flex items-center gap-2 flex-1 min-w-0">
              <span className="text-amber-600 shrink-0">📊</span>
              <p className="text-sm text-amber-800">
                Suggestions based on <strong>theoretical stock</strong> from sales, wastage &amp; invoices. Resets at each stock count.
              </p>
            </div>
          </div>

          {/* Desktop tools row: search + dropdowns + segmented control */}
          <div className="hidden md:grid grid-cols-[1fr_auto_auto_auto_auto] gap-2 items-center">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" />
              <input
                className="w-full bg-paper border border-line rounded-[9px] pl-9 pr-3 py-2.5 text-[13px] text-ink placeholder:text-ink-3 focus:outline-none focus:border-ink-3 transition-colors tracking-[-0.005em]"
                placeholder="Search prep items, recipes, stations…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <select
              value={filterCategory}
              onChange={e => setFilterCategory(e.target.value)}
              className="bg-paper border border-line rounded-[9px] px-3 py-2.5 text-[13px] text-ink-2 hover:border-ink-3 focus:outline-none focus:border-ink-3 transition-colors min-w-[140px] tracking-[-0.005em]"
            >
              <option value="ALL">All categories</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select
              value={filterStation}
              onChange={e => setFilterStation(e.target.value)}
              className="bg-paper border border-line rounded-[9px] px-3 py-2.5 text-[13px] text-ink-2 hover:border-ink-3 focus:outline-none focus:border-ink-3 transition-colors min-w-[140px] tracking-[-0.005em]"
            >
              <option value="ALL">All stations</option>
              <option value="UNASSIGNED">Unassigned</option>
              {stations.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <label className="bg-paper border border-line rounded-[9px] px-3 py-2.5 text-[13px] text-ink-2 hover:border-ink-3 transition-colors flex items-center gap-2 cursor-pointer tracking-[-0.005em]">
              <span className={`w-[14px] h-[14px] border-[1.5px] rounded-[3px] grid place-items-center text-[9px] ${activeOnly ? 'bg-ink border-ink text-paper' : 'border-line-2 bg-paper'}`}>
                {activeOnly && '✓'}
              </span>
              <input type="checkbox" checked={activeOnly} onChange={e => setActiveOnly(e.target.checked)} className="hidden" />
              Active only
            </label>
            <div className="flex bg-paper border border-line rounded-[9px] p-[3px]">
              {(['urgency', 'category', 'station'] as const).map(v => (
                <button key={v} onClick={() => setSmartPrepView(v)}
                  className={`px-3 py-1.5 font-mono text-[11px] rounded-[6px] transition-colors whitespace-nowrap ${smartPrepView === v ? 'bg-ink text-paper' : 'text-ink-3 hover:text-ink-2'}`}>
                  By {v}
                </button>
              ))}
            </div>
          </div>

          {/* Desktop "showing N items" mono label */}
          <p className="hidden md:block font-mono text-[11px] text-ink-3 tracking-[0.01em]">
            SHOWING {items.length} ITEMS · GROUPED BY {smartPrepView.toUpperCase()} · RESETS WITH NEXT COUNT
          </p>

          {/* Mobile view toggle */}
          <div className="md:hidden flex bg-bg-2 rounded-[10px] p-1 gap-0.5 border border-line">
            {(['urgency', 'category', 'station'] as const).map(v => (
              <button key={v} onClick={() => setSmartPrepView(v)}
                className={`flex-1 py-2 font-mono text-[11px] uppercase tracking-[0.04em] rounded-[7px] transition-colors ${smartPrepView === v ? 'bg-paper shadow-sm text-ink' : 'text-ink-3'}`}>
                By {v === 'urgency' ? 'Urgency' : v === 'category' ? 'Category' : 'Station'}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="flex justify-center py-16">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gold" />
            </div>
          ) : (
            <>
              {/* ── BY URGENCY ── */}
              {smartPrepView === 'urgency' && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5 items-start">

                  {/* Critical column */}
                  <div className="bg-[#fffafa] md:bg-[#fffafa] border md:border-[#fca5a5] border-gray-100 rounded-xl flex flex-col min-h-[480px]">
                    <div className="px-4 py-3.5 border-b border-[#fca5a5] flex items-center justify-between gap-2.5">
                      <div className="flex items-center gap-2 min-w-0 flex-1 whitespace-nowrap">
                        <span className="w-2 h-2 rounded-full bg-red-500" />
                        <span className="font-mono text-[11.5px] tracking-[0.02em] font-semibold text-red-700">CRITICAL</span>
                        <span className="font-mono text-[11px] text-ink-3 font-normal">· {spCritical.length} item{spCritical.length !== 1 ? 's' : ''}</span>
                      </div>
                      {spCritical.some(i => !i.isOnList) && (
                        <button onClick={() => handleAddAll('911')}
                          className="font-mono text-[10.5px] px-2.5 py-1 rounded-full font-medium border border-red-500 bg-red-500 text-paper hover:bg-red-600 whitespace-nowrap">
                          + Add all
                        </button>
                      )}
                    </div>
                    <p className="font-mono text-[10.5px] text-red-700 px-4 pt-2 pb-1">Stock depleted — make now</p>
                    <div className="flex-1 px-3 pb-3 pt-2 flex flex-col gap-2 overflow-auto">
                      {spCritical.length === 0 ? (
                        <div className="flex-1 flex flex-col items-center justify-center py-10 text-center">
                          <div className="w-9 h-9 rounded-full bg-bg-2 grid place-items-center text-ink-4 mb-2.5">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
                          </div>
                          <p className="text-[13px] text-ink-3 tracking-[-0.005em]">No critical items</p>
                        </div>
                      ) : (
                        spCritical.map(item => <SmartPrepCard key={item.id} item={item} />)
                      )}
                    </div>
                  </div>

                  {/* Needed Today column */}
                  <div className="bg-paper border border-line rounded-xl flex flex-col min-h-[480px]">
                    <div className="px-4 py-3.5 border-b border-line flex items-center justify-between gap-2.5">
                      <div className="flex items-center gap-2 min-w-0 flex-1 whitespace-nowrap">
                        <span className="w-2 h-2 rounded-full bg-gold" />
                        <span className="font-mono text-[11.5px] tracking-[0.02em] font-semibold text-gold-2">NEEDED TODAY</span>
                        <span className="font-mono text-[11px] text-ink-3 font-normal">· {spNeeded.length} item{spNeeded.length !== 1 ? 's' : ''}</span>
                      </div>
                      {spNeeded.some(i => !i.isOnList) && (
                        <button onClick={() => handleAddAll('NEEDED_TODAY')}
                          className="font-mono text-[10.5px] px-2.5 py-1 rounded-full font-medium border border-ink bg-ink text-paper hover:bg-ink-2 whitespace-nowrap">
                          + Add all
                        </button>
                      )}
                    </div>
                    <p className="font-mono text-[10.5px] text-ink-3 px-4 pt-2 pb-1">Below par — should be prepped today</p>
                    <div className="flex-1 px-3 pb-3 pt-2 flex flex-col gap-2 overflow-auto">
                      {spNeeded.length === 0 ? (
                        <div className="flex-1 flex flex-col items-center justify-center py-10 text-center">
                          <div className="w-9 h-9 rounded-full bg-bg-2 grid place-items-center text-ink-4 mb-2.5">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
                          </div>
                          <p className="text-[13px] text-ink-3 tracking-[-0.005em]">All par levels met<br/>
                            <span className="text-ink-4 text-[12px]">Nothing else needs prepping today.</span>
                          </p>
                        </div>
                      ) : (
                        spNeeded.map(item => <SmartPrepCard key={item.id} item={item} />)
                      )}
                    </div>
                  </div>

                  {/* Looking Good column */}
                  <div className="bg-paper border border-line rounded-xl flex flex-col min-h-[480px]">
                    <button
                      onClick={() => setLookingGoodOpen(v => !v)}
                      className="px-4 py-3.5 border-b border-line flex items-center justify-between gap-2.5 hover:bg-bg-2/40 transition-colors"
                    >
                      <div className="flex items-center gap-2 min-w-0 flex-1 whitespace-nowrap">
                        <span className="w-2 h-2 rounded-full bg-green-500" />
                        <span className="font-mono text-[11.5px] tracking-[0.02em] font-semibold text-green-700">LOOKING GOOD</span>
                        <span className="font-mono text-[11px] text-ink-3 font-normal">· {spLookingGood.length} item{spLookingGood.length !== 1 ? 's' : ''}</span>
                      </div>
                      <span className="font-mono text-[11px] text-ink-3">{lookingGoodOpen ? '▾' : '→'}</span>
                    </button>
                    <p className="font-mono text-[10.5px] text-ink-3 px-4 pt-2 pb-1">On par or above — no action needed</p>
                    {lookingGoodOpen ? (
                      <div className="flex-1 px-3 pb-3 pt-2 flex flex-col gap-1.5 overflow-auto">
                        {spLookingGood.length === 0 ? (
                          <div className="flex-1 flex items-center justify-center text-[13px] text-ink-3">No items</div>
                        ) : (
                          spLookingGood.map(item => {
                            const pct = item.parLevel > 0 ? Math.round(((item.onHand - item.parLevel) / item.parLevel) * 100) : 0
                            const label = pct === 0 ? 'on par' : (pct > 0 ? `+${pct}%` : `${pct}%`)
                            const isAdded = item.isOnList
                            return (
                              <div key={item.id}
                                className="bg-bg border border-line rounded-lg px-3 py-2.5 flex items-center justify-between gap-2.5 hover:border-ink-3 transition-colors">
                                <button onClick={() => setSelected(item)} className="flex flex-col gap-0.5 min-w-0 text-left hover:opacity-80 transition-opacity">
                                  <span className="text-[13px] font-medium text-ink tracking-[-0.01em] truncate">{item.name}</span>
                                  <span className="font-mono text-[10.5px] text-ink-3 whitespace-nowrap">
                                    {item.category} · {item.onHand % 1 === 0 ? item.onHand.toFixed(0) : item.onHand.toFixed(1)} / {item.parLevel % 1 === 0 ? item.parLevel.toFixed(0) : item.parLevel.toFixed(1)} {item.unit}
                                  </span>
                                </button>
                                <div className="flex items-center gap-2.5 shrink-0">
                                  <span className="font-mono text-[11px] text-green-700 font-medium">{label}</span>
                                  <button
                                    onClick={() => handleToggleOnList(item.id, !isAdded)}
                                    title={isAdded ? "Remove from today's list" : "Add to today's list"}
                                    className={`px-2.5 py-1 rounded-[7px] text-[11px] font-medium inline-flex items-center gap-1 whitespace-nowrap transition-colors group ${
                                      isAdded
                                        ? 'bg-bg-2 text-ink-2 border border-line hover:border-red-300 hover:bg-red-50 hover:text-red-600'
                                        : 'bg-ink text-paper hover:bg-ink-2'
                                    }`}
                                  >
                                    {isAdded
                                      ? <><Check size={11} className="text-green-600 group-hover:text-red-500" /> On list <span className="opacity-50">✕</span></>
                                      : <><span className="text-gold font-semibold">+</span> Add</>}
                                  </button>
                                </div>
                              </div>
                            )
                          })
                        )}
                      </div>
                    ) : (
                      <div className="flex-1 px-3 pb-3 pt-2 flex flex-col gap-1.5 overflow-hidden">
                        {spLookingGood.slice(0, 6).map(item => {
                          const pct = item.parLevel > 0 ? Math.round(((item.onHand - item.parLevel) / item.parLevel) * 100) : 0
                          const label = pct === 0 ? 'on par' : (pct > 0 ? `+${pct}%` : `${pct}%`)
                          const isAdded = item.isOnList
                          return (
                            <div key={item.id}
                              className="bg-bg border border-line rounded-lg px-3 py-2 flex items-center justify-between gap-2.5 hover:border-ink-3 transition-colors">
                              <button onClick={() => setSelected(item)} className="text-[12.5px] font-medium text-ink tracking-[-0.01em] truncate min-w-0 text-left hover:opacity-80 transition-opacity">{item.name}</button>
                              <div className="flex items-center gap-2 shrink-0">
                                <span className="font-mono text-[10.5px] text-green-700 font-medium">{label}</span>
                                <button
                                  onClick={() => handleToggleOnList(item.id, !isAdded)}
                                  title={isAdded ? "Remove from today's list" : "Add to today's list"}
                                  className={`w-6 h-6 grid place-items-center rounded-[6px] text-[12px] font-medium transition-colors group ${
                                    isAdded
                                      ? 'bg-bg-2 text-ink-2 border border-line hover:border-red-300 hover:bg-red-50 hover:text-red-600'
                                      : 'bg-ink text-paper hover:bg-ink-2'
                                  }`}
                                >
                                  {isAdded
                                    ? <Check size={12} className="text-green-600 group-hover:text-red-500" />
                                    : <span className="text-gold font-semibold leading-none">+</span>}
                                </button>
                              </div>
                            </div>
                          )
                        })}
                        {spLookingGood.length > 6 && (
                          <button onClick={() => setLookingGoodOpen(true)} className="font-mono text-[10.5px] uppercase tracking-[0.04em] text-ink-3 hover:text-ink py-2 text-center border-t border-line mt-1 pt-2.5 transition-colors">
                            + {spLookingGood.length - 6} more · expand all
                          </button>
                        )}
                        {spLookingGood.length === 0 && (
                          <div className="flex-1 flex items-center justify-center text-[12.5px] text-ink-3">No items</div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* ── BY CATEGORY ── */}
              {smartPrepView === 'category' && (
                <div className="space-y-3">
                  {spCategoryGroups.map(([cat, rows]) => {
                    const criticalCount = rows.filter(i => i.priority === '911').length
                    const neededCount = rows.filter(i => i.priority === 'NEEDED_TODAY').length
                    return (
                      <div key={cat} className="bg-paper border border-line rounded-xl overflow-hidden">
                        {/* Group header — branded "grow" style (gold-soft for active categories, neutral otherwise) */}
                        <div className={`grid grid-cols-[1fr_auto] items-center px-[18px] py-2.5 border-b ${criticalCount > 0 || neededCount > 0 ? 'bg-gold-soft border-[#fcd34d]' : 'bg-bg-2 border-line'}`}>
                          <div className="flex items-center gap-2 min-w-0 whitespace-nowrap">
                            <span className={`font-mono text-[11.5px] tracking-[0.02em] font-semibold ${criticalCount > 0 || neededCount > 0 ? 'text-gold-2' : 'text-ink-2'}`}>{cat.toUpperCase()}</span>
                            <span className={`font-mono text-[11px] font-normal ${criticalCount > 0 || neededCount > 0 ? 'text-gold-2/80' : 'text-ink-3'}`}>· {rows.length} item{rows.length !== 1 ? 's' : ''}</span>
                          </div>
                          {(criticalCount > 0 || neededCount > 0) && (
                            <div className="flex items-center gap-1.5">
                              {criticalCount > 0 && <span className="font-mono text-[10px] bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full font-semibold tracking-[0]">{criticalCount} critical</span>}
                              {neededCount > 0 && <span className="font-mono text-[10px] bg-paper text-gold-2 border border-[#fcd34d] px-1.5 py-0.5 rounded-full font-semibold tracking-[0]">{neededCount} needed</span>}
                            </div>
                          )}
                        </div>
                        {/* Desktop table header */}
                        <div className="hidden md:grid grid-cols-[16px_2fr_1fr_110px_1fr_220px_110px] gap-3 items-center px-[18px] py-2.5 bg-bg-2 border-b border-line font-mono text-[10.5px] text-ink-3 tracking-[0.01em]">
                          <div /> <div>ITEM</div> <div>STOCK VS PAR</div> <div>ON HAND</div> <div>MAKE</div> <div>OVERRIDE</div> <div className="text-right">ACTION</div>
                        </div>
                        {/* Desktop rows */}
                        <div className="hidden md:block">
                          {rows.map(item => <SmartPrepTableRow key={item.id} item={item} />)}
                        </div>
                        {/* Mobile cards */}
                        <div className="md:hidden p-3 flex flex-col gap-2">
                          {rows.map(item => <SmartPrepCard key={item.id} item={item} />)}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              {/* ── BY STATION ── */}
              {smartPrepView === 'station' && (
                <div className="space-y-3">
                  {(spStationGroups ?? []).map(([station, rows]) => {
                    const emoji = STATION_EMOJI[station] ?? '🍽'
                    const criticalCount = rows.filter(i => i.priority === '911').length
                    const neededCount = rows.filter(i => i.priority === 'NEEDED_TODAY').length
                    const hasUrgent = criticalCount > 0 || neededCount > 0
                    return (
                      <div key={station} className="bg-paper border border-line rounded-xl overflow-hidden">
                        {/* Group header */}
                        <div className={`grid grid-cols-[1fr_auto] items-center px-[18px] py-2.5 border-b ${hasUrgent ? 'bg-gold-soft border-[#fcd34d]' : 'bg-bg-2 border-line'}`}>
                          <div className="flex items-center gap-2 min-w-0 whitespace-nowrap">
                            <span className="text-[13px]">{emoji}</span>
                            <span className={`font-mono text-[11.5px] tracking-[0.02em] font-semibold ${hasUrgent ? 'text-gold-2' : 'text-ink-2'}`}>{station.toUpperCase()} STATION</span>
                            <span className={`font-mono text-[11px] font-normal ${hasUrgent ? 'text-gold-2/80' : 'text-ink-3'}`}>· {rows.length} item{rows.length !== 1 ? 's' : ''}</span>
                          </div>
                          {hasUrgent && (
                            <div className="flex items-center gap-1.5">
                              {criticalCount > 0 && <span className="font-mono text-[10px] bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full font-semibold tracking-[0]">{criticalCount} critical</span>}
                              {neededCount > 0 && <span className="font-mono text-[10px] bg-paper text-gold-2 border border-[#fcd34d] px-1.5 py-0.5 rounded-full font-semibold tracking-[0]">{neededCount} needed</span>}
                            </div>
                          )}
                        </div>
                        {/* Desktop table header */}
                        <div className="hidden md:grid grid-cols-[16px_2fr_1fr_110px_1fr_220px_110px] gap-3 items-center px-[18px] py-2.5 bg-bg-2 border-b border-line font-mono text-[10.5px] text-ink-3 tracking-[0.01em]">
                          <div /> <div>ITEM</div> <div>STOCK VS PAR</div> <div>ON HAND</div> <div>MAKE</div> <div>OVERRIDE</div> <div className="text-right">ACTION</div>
                        </div>
                        <div className="hidden md:block">
                          {rows.map(item => <SmartPrepTableRow key={item.id} item={item} />)}
                        </div>
                        <div className="md:hidden p-3 flex flex-col gap-2">
                          {rows.map(item => <SmartPrepCard key={item.id} item={item} />)}
                        </div>
                      </div>
                    )
                  })}
                  {(!spStationGroups || spStationGroups.length === 0) && (
                    <div className="bg-paper border border-line rounded-xl py-14 text-center">
                      <p className="text-[13.5px] text-ink-2 font-medium">No stations configured.</p>
                      <p className="font-mono text-[11px] text-ink-3 mt-1.5 tracking-[0]">
                        Add stations in{' '}
                        <button onClick={() => setShowSettings(true)} className="text-gold-2 hover:underline font-medium">Settings</button>.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* Footer hints */}
              <div className="hidden md:flex justify-between font-mono text-[10.5px] text-ink-3 tracking-[0.02em] pt-2">
                <span>
                  SUGGESTIONS REFRESH WITH EACH COUNT · {spCritical.length} CRITICAL · {spNeeded.length} NEEDED · {spLookingGood.length} ON PAR
                </span>
                <span>
                  <kbd className="font-mono text-[10px] bg-bg-2 border border-line rounded px-1 py-px text-ink-2">⌘R</kbd> REFRESH ·{' '}
                  <kbd className="font-mono text-[10px] bg-bg-2 border border-line rounded px-1 py-px text-ink-2">⌘N</kbd> NEW PREP ITEM
                </span>
              </div>
            </>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          HISTORY TAB
      ══════════════════════════════════════════════════════ */}
      {viewMode === 'history' && (
        <div className="space-y-4">
          <div className="bg-white border border-gray-100 rounded-xl p-4 flex items-center gap-3 flex-wrap">
            <History size={16} className="text-gray-400 shrink-0" />
            <span className="text-sm font-medium text-gray-700">View date:</span>
            <input
              type="date"
              max={new Date().toISOString().slice(0, 10)}
              value={historyDate}
              onChange={e => setHistoryDate(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
            />
            <span className="text-xs text-gray-400 ml-auto">
              {new Date(historyDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
            </span>
          </div>

          {historyLoading ? (
            <div className="flex justify-center py-12">
              <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-gold" />
            </div>
          ) : historyLogs.length === 0 ? (
            <div className="bg-white border border-gray-100 rounded-xl py-14 text-center">
              <History size={28} className="mx-auto text-gray-300 mb-3" />
              <p className="text-gray-500 text-sm">No prep was logged on this date.</p>
              <p className="text-xs text-gray-400 mt-1">Try a different date.</p>
            </div>
          ) : (() => {
            const STATUS_HIST: Record<string, { label: string; cls: string }> = {
              DONE:        { label: 'Done',        cls: 'bg-green-100 text-green-700' },
              PARTIAL:     { label: 'Partial',     cls: 'bg-amber-100 text-amber-700' },
              IN_PROGRESS: { label: 'In Progress', cls: 'bg-gold/15 text-gold' },
              BLOCKED:     { label: 'Blocked',     cls: 'bg-red-100 text-red-700' },
              SKIPPED:     { label: 'Skipped',     cls: 'bg-gray-100 text-gray-400' },
              NOT_STARTED: { label: 'Not Started', cls: 'bg-gray-100 text-gray-400' },
            }
            const done    = historyLogs.filter(l => l.status === 'DONE').length
            const partial = historyLogs.filter(l => l.status === 'PARTIAL').length
            const blocked = historyLogs.filter(l => l.status === 'BLOCKED').length
            const total   = historyLogs.length
            const completionRate = total > 0 ? Math.round(((done + partial) / total) * 100) : 0
            return (
              <>
                <div className="grid grid-cols-4 gap-3">
                  {[
                    { label: 'Total', value: total, cls: 'text-gray-800' },
                    { label: 'Done', value: done, cls: 'text-green-700' },
                    { label: 'Partial', value: partial, cls: 'text-amber-700' },
                    { label: 'Completion', value: `${completionRate}%`, cls: completionRate >= 80 ? 'text-green-700' : completionRate >= 50 ? 'text-amber-700' : 'text-red-600' },
                  ].map(c => (
                    <div key={c.label} className="bg-white border border-gray-100 rounded-xl p-3 text-center">
                      <div className="text-xs text-gray-400 mb-1">{c.label}</div>
                      <div className={`text-lg font-bold ${c.cls}`}>{c.value}</div>
                    </div>
                  ))}
                </div>

                {blocked > 0 && (
                  <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-2.5 text-sm text-red-700">
                    {blocked} item{blocked !== 1 ? 's were' : ' was'} blocked — see notes below.
                  </div>
                )}

                <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
                  <div className="px-4 py-2 bg-gray-50 border-b border-gray-100 flex items-center gap-2">
                    <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Items Logged</span>
                    <span className="text-xs text-gray-400">{total}</span>
                  </div>
                  <div className="divide-y divide-gray-50">
                    {historyLogs.map(log => {
                      const meta = STATUS_HIST[log.status] ?? STATUS_HIST.NOT_STARTED
                      return (
                        <div key={log.id} className="px-4 py-3 flex items-center gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-gray-800 truncate">{log.prepItem.name}</div>
                            {log.note && <div className="text-xs text-gray-400 mt-0.5 truncate">{log.note}</div>}
                            {log.assignedTo && <div className="text-xs text-gray-400">by {log.assignedTo}</div>}
                          </div>
                          <div className="flex items-center gap-3 shrink-0">
                            {log.actualPrepQty != null && (
                              <span className="text-sm text-gray-600 font-medium">
                                {Number(log.actualPrepQty).toFixed(1)} {log.prepItem.unit}
                              </span>
                            )}
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${meta.cls}`}>{meta.label}</span>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </>
            )
          })()}
        </div>
      )}

      {/* Detail panel */}
      {selectedLive && (
        <PrepDetailPanel
          item={selectedLive}
          onClose={() => setSelected(null)}
          onRefresh={() => { load(); setSelected(null) }}
          onEdit={() => { setEditing(selectedLive); setSelected(null) }}
        />
      )}

      {showAdd && (
        <PrepItemForm onClose={() => setShowAdd(false)} onSaved={load} />
      )}

      {editing && (
        <PrepItemForm
          item={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { load(); setEditing(null) }}
        />
      )}

      {showSettings && (
        <PrepSettingsModal
          onClose={() => setShowSettings(false)}
          onSaved={() => { load(); loadSettings(); setShowSettings(false) }}
        />
      )}
    </div>
  )
}

```


---

## `src/app/cost/page.tsx`

```tsx
'use client'
import { useEffect, useState, useMemo } from 'react'
import Link from 'next/link'
import { TrendingUp, ArrowRight, BarChart3 } from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { PageHead } from '@/components/layout/PageHead'
import { formatCurrency } from '@/lib/utils'

interface ChromeData {
  foodCostPct: number | null
  targetPct: number
  variance7d: number | null
  onHand: number
}

interface DashboardData {
  totalInventoryValue: number
  weeklyWastageCost: number
  outOfStockCount: number
  topExpensiveItems: Array<{
    id: string; itemName: string; category: string;
    stockOnHand: number; pricePerBaseUnit: string | number; inventoryValue: number;
    baseUnit: string;
  }>
  weeklyRevenue: number
  weeklyFoodSales: number
  weeklyPurchaseCost: number
  estimatedFoodCostPct: number
}

interface RecipeDriftRow {
  id: string
  name: string
  menuPrice: number
  totalCost: number
  foodCostPct: number
  gapPp: number
}

export default function CostPage() {
  const { activeRcId, activeRc } = useRc()
  const [chrome, setChrome] = useState<ChromeData | null>(null)
  const [dashboard, setDashboard] = useState<DashboardData | null>(null)
  const [recipes, setRecipes] = useState<Array<{ id: string; name: string; menuPrice: number | null; totalCost: number }>>([])

  useEffect(() => {
    const qs = activeRcId ? `?rcId=${activeRcId}&isDefault=${activeRc?.isDefault ?? false}` : ''
    Promise.all([
      fetch(`/api/insights/cost-chrome${activeRcId ? `?rcId=${activeRcId}` : ''}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
      fetch(`/api/reports/dashboard${qs}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
      fetch(`/api/recipes?type=MENU`, { cache: 'no-store' }).then(r => r.ok ? r.json() : []),
    ]).then(([c, d, r]) => {
      if (c) setChrome(c)
      if (d) setDashboard(d)
      if (Array.isArray(r)) setRecipes(r)
    })
  }, [activeRcId, activeRc])

  const target = chrome?.targetPct ?? 27
  const drift = useMemo<RecipeDriftRow[]>(() => {
    return recipes
      .filter(r => r.menuPrice !== null && r.totalCost > 0)
      .map(r => {
        const pct = (r.totalCost / Number(r.menuPrice)) * 100
        return {
          id: r.id, name: r.name,
          menuPrice: Number(r.menuPrice), totalCost: r.totalCost,
          foodCostPct: pct,
          gapPp: pct - target,
        }
      })
      .sort((a, b) => b.gapPp - a.gapPp)
      .slice(0, 10)
  }, [recipes, target])

  return (
    <div>
      <PageHead
        crumbs={<><BarChart3 size={12} /> INSIGHTS / COST</>}
        title="Cost"
        sub={chrome ? <>WTD food cost <b>{chrome.foodCostPct?.toFixed(1) ?? '—'}%</b> vs target <b>{target.toFixed(1)}%</b> · on hand <b>{formatCurrency(chrome.onHand)}</b></> : <>Loading…</>}
      />

      <div className="grid gap-3 mb-6" style={{ gridTemplateColumns: '1.4fr 1fr 1fr 1fr' }}>
        <HeroCard chrome={chrome} target={target} />
        <Card label="WEEKLY REVENUE" value={dashboard ? formatCurrency(dashboard.weeklyRevenue) : '—'} delta={<>WTD</>} />
        <Card label="WEEKLY PURCHASES" value={dashboard ? formatCurrency(dashboard.weeklyPurchaseCost) : '—'} delta={<>numerator</>} />
        <Card label="WASTAGE · 7D"
          value={dashboard ? formatCurrency(dashboard.weeklyWastageCost) : '—'}
          valueClass={dashboard && dashboard.weeklyWastageCost > 0 ? 'text-red-text' : ''}
          delta={<>from log</>}
        />
      </div>

      <div className="grid gap-5" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <section className="bg-paper border border-line rounded-[12px] overflow-hidden">
          <header className="flex items-center justify-between px-[18px] py-3 border-b border-line bg-bg-2">
            <h3 className="text-[13px] font-semibold tracking-[-0.01em] flex items-center gap-2">
              <TrendingUp size={13} className="text-gold" />
              Top inventory value drivers
              <span className="font-mono text-[10.5px] text-ink-3 font-normal">· top 10</span>
            </h3>
            <Link href="/inventory" className="font-mono text-[10.5px] text-gold-2 border-b border-dashed border-current">Open inventory →</Link>
          </header>
          {!dashboard ? (
            <div className="p-6 text-center text-ink-3 font-mono text-[11px]">Loading…</div>
          ) : (
            <div className="divide-y divide-line">
              {dashboard.topExpensiveItems.map(it => (
                <Link key={it.id} href={`/inventory?highlight=${it.id}`}
                  className="grid grid-cols-[1fr_auto] gap-3 px-[18px] py-2.5 items-center hover:bg-bg-2/40 transition-colors">
                  <div className="min-w-0">
                    <div className="text-[13px] text-ink font-medium tracking-[-0.005em] truncate">{it.itemName}</div>
                    <div className="font-mono text-[10.5px] text-ink-3 mt-0.5">
                      {it.category} · {Number(it.stockOnHand).toFixed(1)} {it.baseUnit} × ${Number(it.pricePerBaseUnit).toFixed(4)}
                    </div>
                  </div>
                  <div className="font-mono text-[13px] text-ink font-medium tabular-nums">{formatCurrency(it.inventoryValue)}</div>
                </Link>
              ))}
            </div>
          )}
          <div className="px-[18px] py-2.5 font-mono text-[10.5px] text-ink-3 border-t border-line bg-bg-2/40 flex justify-end">
            <Link href="/inventory" className="text-gold-2 inline-flex items-center gap-1">Open repricing <ArrowRight size={11} /></Link>
          </div>
        </section>

        <section className="bg-paper border border-line rounded-[12px] overflow-hidden">
          <header className="flex items-center justify-between px-[18px] py-3 border-b border-line bg-bg-2">
            <h3 className="text-[13px] font-semibold tracking-[-0.01em] flex items-center gap-2">
              <BarChart3 size={13} className="text-red" />
              Recipe drift · over target by &gt;3pp
              <span className="font-mono text-[10.5px] text-ink-3 font-normal">· top {drift.length}</span>
            </h3>
            <Link href="/signals" className="font-mono text-[10.5px] text-gold-2 border-b border-dashed border-current">Open signals →</Link>
          </header>
          {drift.length === 0 ? (
            <div className="p-6 text-center text-ink-3 font-mono text-[11px]">No recipes over target — your costs are dialed.</div>
          ) : (
            <div className="divide-y divide-line">
              {drift.map(r => {
                const tone = r.gapPp > 6 ? 'bad' : r.gapPp > 3 ? 'warn' : 'ok'
                const toneCls = tone === 'bad' ? 'text-red-text' : tone === 'warn' ? 'text-gold-2' : 'text-green-text'
                return (
                  <Link key={r.id} href={`/menu?highlight=${r.id}`}
                    className="grid grid-cols-[1fr_auto_auto] gap-3 px-[18px] py-2.5 items-center hover:bg-bg-2/40 transition-colors">
                    <div className="min-w-0">
                      <div className="text-[13px] text-ink font-medium truncate">{r.name}</div>
                      <div className="font-mono text-[10.5px] text-ink-3 mt-0.5">
                        cost {formatCurrency(r.totalCost)} · price {formatCurrency(r.menuPrice)}
                      </div>
                    </div>
                    <div className={`font-mono text-[13px] font-semibold tabular-nums ${toneCls}`}>
                      {r.foodCostPct.toFixed(1)}%
                    </div>
                    <div className="font-mono text-[10.5px] text-ink-3 text-gold-2 inline-flex items-center gap-1">
                      Reprice <ArrowRight size={10} />
                    </div>
                  </Link>
                )
              })}
            </div>
          )}
        </section>
      </div>

      <div className="mt-5 font-mono text-[10.5px] text-ink-3 tracking-wide text-center">
        Every row ends with a verb. <kbd className="bg-bg-2 border border-line rounded px-1 py-px text-ink-2">⌘R</kbd> refresh.
      </div>
    </div>
  )
}

function HeroCard({ chrome, target }: { chrome: ChromeData | null; target: number }) {
  const pct = chrome?.foodCostPct ?? null
  const intStr = pct !== null ? Math.floor(pct).toString() : '—'
  const decStr = pct !== null ? `.${(pct % 1).toFixed(1).slice(2)}%` : ''
  return (
    <div className="bg-ink text-paper rounded-[12px] border border-ink p-5 flex flex-col justify-between min-h-[128px] relative overflow-hidden">
      <div>
        <div className="font-mono text-[10.5px] text-zinc-500 tracking-[0.01em]">FOOD COST · WEEK TO DATE</div>
        <div className="text-[48px] font-semibold tracking-[-0.045em] leading-none mt-2">
          {intStr}<sub className="text-[22px] font-medium text-gold tracking-[-0.02em] align-baseline">{decStr}</sub>
        </div>
      </div>
      <div className="font-mono text-[11px] text-zinc-500 tracking-[0]">
        target <b className="text-paper">{target.toFixed(1)}</b>
        {pct !== null && <> · <span className={pct > target ? 'text-red-300' : 'text-green-400'}>{pct > target ? '+' : ''}{(pct - target).toFixed(1)}</span></>}
      </div>
    </div>
  )
}

function Card({ label, value, delta, valueClass = '' }: { label: string; value: string; delta: React.ReactNode; valueClass?: string }) {
  return (
    <div className="bg-paper border border-line rounded-[12px] p-5 flex flex-col justify-between min-h-[128px] relative">
      <div className="absolute top-0 left-0 w-8 h-0.5 bg-gold" />
      <div>
        <div className="font-mono text-[10.5px] text-ink-3 tracking-[0.01em] uppercase">{label}</div>
        <div className={`text-[34px] font-semibold tracking-[-0.04em] leading-none mt-2 ${valueClass || 'text-ink'}`}>{value}</div>
      </div>
      <div className="font-mono text-[11px] text-ink-3 tracking-[0] [&_b]:text-ink [&_b]:font-medium">{delta}</div>
    </div>
  )
}

```
