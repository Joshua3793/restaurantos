# Fergie's OS — Pages (src/app)

Every page: inventory, recipes, menu, prep, count, cost, invoices, sales, wastage, variance, signals, pass, reports, setup, auth.


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

## `src/app/count/page.tsx`

```tsx
'use client'

import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react'
import {
  AlertCircle, ArrowLeft, Check, CheckCircle2, ChevronDown,
  Circle, ClipboardList, Minus, MoreHorizontal, Pencil, Plus, RefreshCw, Search, SkipForward, Trash2, WifiOff, X,
} from 'lucide-react'
import { CategoryBadge } from '@/components/CategoryBadge'
import { formatCurrency, formatUnitPrice, BASE_UNITS, PURCHASE_UNITS } from '@/lib/utils'
import { InventoryItemDrawer } from '@/components/inventory/InventoryItemDrawer'
import { useRc } from '@/contexts/RevenueCenterContext'
import { rcHex } from '@/lib/rc-colors'
import {
  enqueueCountMutation, flushCountQueue, loadCountQueue,
  saveCountSessionCache, pendingCountForSession,
} from '@/lib/count-offline'
import {
  getCountableUoms, convertCountQtyToBase, convertBaseToCountUom,
} from '@/lib/count-uom'
import { LARGE_VARIANCE_PCT } from '@/lib/count-constants'

// ─── Types ────────────────────────────────────────────────────────────────────

interface InventoryItemRef {
  id: string
  itemName: string
  category: string
  baseUnit: string
  purchaseUnit: string
  qtyPerPurchaseUnit: number
  qtyUOM?: string | null
  innerQty?: number | string | null
  packSize: number
  packUOM: string
  countUOM: string
  location: string | null
  storageArea: { id: string; name: string } | null
  parLevel?: number | null         // from StockAllocation for the session's RC
  lastCountQty?: number | null     // last verified count, in baseUnit
}

interface Line {
  id: string
  sessionId: string
  inventoryItemId: string
  inventoryItem: InventoryItemRef
  expectedQty: number
  countedQty: number | null
  selectedUom: string
  skipped: boolean
  variancePct: number | null
  varianceCost: number | null
  priceAtCount: number
  sortOrder: number
  notes: string | null
  updatedAt?: string               // for optimistic concurrency on PATCH
}

interface Session {
  id: string
  label: string
  sessionDate: string
  type: string
  areaFilter: string | null
  countedBy: string
  status: string
  startedAt: string
  finalizedAt: string | null
  totalCountedValue: number
  counts?: { total: number; counted: number; skipped: number }
  lines?: Line[]
}

// ─── Types (storage areas) ────────────────────────────────────────────────────

interface StorageArea { id: string; name: string }

// ─── Helpers ─────────────────────────────────────────────────────────────────

function uomOptionLabel(opt: { label: string; hint?: string }, baseUnit: string): string {
  if (opt.label.toLowerCase() === baseUnit.toLowerCase()) return opt.label
  if (!opt.hint) return opt.label
  return `${opt.label} — ${opt.hint}`
}

function varColor(pct: number | null) {
  if (pct === null) return ''
  const a = Math.abs(pct)
  if (a <= 5)  return 'text-green-600'
  if (a <= 15) return 'text-amber-600'
  return 'text-red-600'
}

// Returns false when expectedQty is so small in display units that the % is meaningless
function hasReliableVariance(expectedQty: number, selectedUom: string, item: InventoryItemRef): boolean {
  return convertBaseToCountUom(expectedQty, selectedUom, item) >= 0.05
}

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function fmtClock(d?: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function relTime(sessionDate: string, startedAt?: string | null) {
  const ref = new Date(sessionDate)
  const now = new Date()
  const days = Math.floor((now.getTime() - ref.getTime()) / 86_400_000)
  if (days <= 0) return `Today${startedAt ? ` · ${fmtClock(startedAt)}` : ''}`
  if (days === 1) return 'Yesterday'
  return `${days}d ago`
}

function durationMin(start: string, end: string) {
  const ms = new Date(end).getTime() - new Date(start).getTime()
  return Math.max(0, Math.round(ms / 60_000))
}

const SESSION_ACCENT: Record<string, string> = {
  IN_PROGRESS:    '#3b82f6',
  PENDING_REVIEW: '#f59e0b',
  UPDATING:       '#8b5cf6',
  FINALIZED:      '#22c55e',
  CANCELLED:      '#d1d5db',
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function Toast({ msg, onDone }: { msg: string; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, 4000); return () => clearTimeout(t) }, [onDone])
  return (
    <div className="fixed bottom-20 md:bottom-6 left-1/2 -translate-x-1/2 z-50 bg-green-700 text-white text-sm font-medium px-5 py-3 rounded-xl shadow-xl flex items-center gap-2 max-w-sm w-full mx-4">
      <Check size={15} className="shrink-0" />
      <span>{msg}</span>
    </div>
  )
}

// ─── StatusBadge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    IN_PROGRESS:    'bg-gold-soft text-gold-2',
    PENDING_REVIEW: 'bg-gold-soft text-gold-2',
    UPDATING:       'bg-violet-100 text-violet-700',
    FINALIZED:      'bg-green-soft text-green-text',
    CANCELLED:      'bg-bg-2 text-ink-3',
  }
  const labels: Record<string, string> = {
    IN_PROGRESS: 'In progress', PENDING_REVIEW: 'Pending review',
    UPDATING: 'Updating changes', FINALIZED: 'Finalized', CANCELLED: 'Cancelled',
  }
  return (
    <span className={`inline-flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.04em] font-medium px-2 py-0.5 rounded-full ${map[status] ?? 'bg-bg-2 text-ink-3'}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current opacity-80" />
      {labels[status] ?? status}
    </span>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

type View = 'list' | 'new' | 'count' | 'review'

export default function CountPage() {
  // ── Global state ──────────────────────────────────────────────────────────
  const [view,          setView]          = useState<View>('list')
  const [sessions,      setSessions]      = useState<Session[]>([])
  const [active,        setActive]        = useState<Session | null>(null)
  const [toast,         setToast]         = useState<string | null>(null)
  const [showModal,     setShowModal]     = useState(false)
  const [finalizing,    setFinalizing]    = useState(false)
  const [deleteTarget,  setDeleteTarget]  = useState<Session | null>(null)
  const [deleting,      setDeleting]      = useState(false)
  const [editTarget,    setEditTarget]    = useState<Session | null>(null)
  const [editLabel,     setEditLabel]     = useState('')
  const [editCountedBy, setEditCountedBy] = useState('')
  const [editDate,      setEditDate]      = useState('')
  const [sessionMenuId, setSessionMenuId] = useState<string | null>(null)
  const [sessionFilter, setSessionFilter] = useState<'all' | 'in_progress' | 'finalized' | 'full' | 'spot'>('all')
  const [sessionSearch, setSessionSearch] = useState('')

  // ── Offline state ─────────────────────────────────────────────────────────
  const [isOffline,      setIsOffline]      = useState(false)
  const [pendingCount,   setPendingCount]   = useState(0)
  const [offlineSyncing, setOfflineSyncing] = useState(false)

  // ── Sync state ───────────────────────────────────────────────────────────
  const [syncing, setSyncing] = useState(false)

  // ── Count-mode state ──────────────────────────────────────────────────────
  const [openId,        setOpenId]        = useState<string | null>(null)
  const [inputQty,      setInputQty]      = useState(0)
  const [catFilter,     setCatFilter]     = useState<string | null>(null)
  const [locFilter,     setLocFilter]     = useState<string | null>(null)
  const [statusFilter,  setStatusFilter]  = useState<'all' | 'uncounted' | 'counted' | 'skipped'>('all')
  const [showCountFilterSheet, setShowCountFilterSheet] = useState(false)
  const [searchQuery,   setSearchQuery]   = useState('')
  const [editingItemId, setEditingItemId] = useState<string | null>(null)

  // ── Storage areas (for partial count picker) ─────────────────────────────
  const [storageAreas, setStorageAreas] = useState<StorageArea[]>([])

  // ── Add-item modal ────────────────────────────────────────────────────────
  const [showAddItem,    setShowAddItem]    = useState(false)
  const [addItemSaving,  setAddItemSaving]  = useState(false)
  const [addItemForm,    setAddItemForm]    = useState({
    itemName: '', category: '', supplierId: '', storageAreaId: '',
    purchaseUnit: '', qtyPerPurchaseUnit: '1', purchasePrice: '0',
    baseUnit: 'g', conversionFactor: '1', stockOnHand: '0', location: '',
  })
  const [addItemCategories, setAddItemCategories] = useState<{ id: string; name: string }[]>([])
  const [addItemSuppliers,  setAddItemSuppliers]  = useState<{ id: string; name: string }[]>([])
  const [addItemAreas,      setAddItemAreas]      = useState<{ id: string; name: string }[]>([])

  // ── New-session form ──────────────────────────────────────────────────────
  const [form, setForm] = useState({
    label: '', countedBy: '',
    type: 'FULL' as 'FULL' | 'PARTIAL',
    sessionDate: new Date().toISOString().slice(0, 10),
    areas: [] as string[], // stores storageArea IDs
  })

  const { revenueCenters, activeRcId, activeRc } = useRc()
  const [selectedRcId, setSelectedRcId] = useState<string>('')

  useEffect(() => {
    if (activeRcId) setSelectedRcId(activeRcId)
  }, [activeRcId])

  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({})

  // ── Loaders ───────────────────────────────────────────────────────────────
  const loadSessions = useCallback(async () => {
    const params = new URLSearchParams()
    if (activeRcId) {
      params.set('rcId', activeRcId)
      if (activeRc?.isDefault) params.set('isDefault', 'true')
    }
    const data = await fetch(`/api/count/sessions?${params}`).then(r => r.json()).catch(() => [])
    setSessions(Array.isArray(data) ? data : [])
  }, [activeRcId, activeRc])

  const loadSession = useCallback(async (id: string): Promise<Session | null> => {
    return fetch(`/api/count/sessions/${id}`).then(r => r.json()).catch(() => null)
  }, [])

  useEffect(() => { loadSessions() }, [loadSessions])
  useEffect(() => {
    fetch('/api/storage-areas').then(r => r.json()).then(d => {
      if (Array.isArray(d)) setStorageAreas(d)
    })
  }, [])

  // Offline detection + auto-sync on reconnect
  useEffect(() => {
    setIsOffline(!navigator.onLine)
    setPendingCount(loadCountQueue().length)
    const goOnline = async () => {
      setIsOffline(false)
      const q = loadCountQueue()
      if (q.length === 0) return
      setOfflineSyncing(true)
      const { synced } = await flushCountQueue()
      setOfflineSyncing(false)
      setPendingCount(0)
      if (synced > 0) setToast(`Synced ${synced} offline update${synced !== 1 ? 's' : ''}.`)
      // Refresh active session after sync so variances update
      if (active) {
        const refreshed = await loadSession(active.id)
        if (refreshed) setActive(refreshed)
      }
    }
    const goOffline = () => setIsOffline(true)
    window.addEventListener('online',  goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online',  goOnline)
      window.removeEventListener('offline', goOffline)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Poll while any session is UPDATING so the list flips to FINALIZED automatically
  useEffect(() => {
    const hasUpdating = sessions.some(s => s.status === 'UPDATING')
    if (!hasUpdating) return
    const timer = setInterval(() => { loadSessions() }, 3000)
    return () => clearInterval(timer)
  }, [sessions, loadSessions])

  // No body-scroll lock needed — new session form is its own view on mobile
  // and a small centered modal on desktop (sm+).

  // Reset qty input when card opens
  useEffect(() => {
    if (!openId || !active?.lines) return
    const line = active.lines.find(l => l.id === openId)
    if (line) {
      // Blind-count: only show prior counted value when re-editing. Don't pre-fill
      // with expected qty — that biases the user toward confirming theoretical stock
      // rather than counting what's actually on the shelf.
      setInputQty(line.countedQty !== null ? Number(line.countedQty) : 0)
    }
  }, [openId, active?.lines])

  // ── Computed ──────────────────────────────────────────────────────────────
  const { total, counted } = useMemo(() => {
    const lines = active?.lines ?? []
    return {
      total:   lines.length,
      counted: lines.filter(l => l.countedQty !== null || l.skipped).length,
    }
  }, [active?.lines])

  // Locations: derived exclusively from the structured StorageArea relation
  // (same source as Inventory) — free-text `location` field is not used for filtering.
  const locations = useMemo(() => {
    const lines = active?.lines ?? []
    const map = new Map<string, string>() // id → name
    for (const l of lines) {
      const sa = l.inventoryItem.storageArea
      if (sa) map.set(sa.id, sa.name)
    }
    return Array.from(map.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [active?.lines])

  const categories = useMemo(() => {
    const lines = active?.lines ?? []
    const map: Record<string, number> = {}
    for (const l of lines) { map[l.inventoryItem.category] = (map[l.inventoryItem.category] || 0) + 1 }
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b))
  }, [active?.lines])

  const filteredLines = useMemo(() => {
    const lines = active?.lines ?? []
    const q = searchQuery.trim().toLowerCase()
    return lines.filter(l => {
      if (catFilter && l.inventoryItem.category !== catFilter) return false
      if (locFilter && l.inventoryItem.storageArea?.id !== locFilter) return false
      if (statusFilter === 'uncounted') { if (l.countedQty !== null || l.skipped) return false }
      if (statusFilter === 'counted')   { if (l.countedQty === null || l.skipped) return false }
      if (statusFilter === 'skipped')   { if (!l.skipped) return false }
      if (q && !l.inventoryItem.itemName.toLowerCase().includes(q)) return false
      return true
    }).sort((a, b) => a.sortOrder - b.sortOrder)
  }, [active?.lines, catFilter, locFilter, statusFilter, searchQuery])

  const grouped = useMemo(() => {
    // Flatten when searching so all matches appear together
    if (catFilter || searchQuery.trim()) return null
    return filteredLines.reduce((acc, l) => {
      const cat = l.inventoryItem.category
      if (!acc[cat]) acc[cat] = []
      acc[cat].push(l)
      return acc
    }, {} as Record<string, Line[]>)
  }, [filteredLines, catFilter, searchQuery])

  const filteredSessions = useMemo(() => {
    return sessions.filter(s => {
      if (sessionFilter === 'in_progress') return s.status === 'IN_PROGRESS' || s.status === 'PENDING_REVIEW'
      if (sessionFilter === 'finalized')   return s.status === 'FINALIZED'
      if (sessionFilter === 'full')        return s.type === 'FULL'
      if (sessionFilter === 'spot')        return s.type === 'PARTIAL'
      return true
    }).filter(s => {
      if (!sessionSearch.trim()) return true
      const q = sessionSearch.toLowerCase()
      return (s.label ?? '').toLowerCase().includes(q) || s.countedBy.toLowerCase().includes(q)
    })
  }, [sessions, sessionFilter, sessionSearch])

  // ── Actions ───────────────────────────────────────────────────────────────
  const openSession = async (s: Session, target: View) => {
    const full = await loadSession(s.id)
    if (!full) return
    saveCountSessionCache(s.id, full)
    setPendingCount(pendingCountForSession(s.id))
    setActive(full)
    setCatFilter(null); setLocFilter(null); setStatusFilter('all'); setOpenId(null)
    setView(target)
  }

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.countedBy.trim()) return
    const res = await fetch('/api/count/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label:       form.label.trim() || undefined,
        type:        form.type,
        countedBy:   form.countedBy.trim(),
        sessionDate: form.sessionDate,
        areaFilter:  form.areas.length ? form.areas.join(',') : undefined,
        revenueCenterId: selectedRcId || undefined,
      }),
    })
    const session = await res.json()
    setForm({ label: '', countedBy: '', type: 'FULL', sessionDate: new Date().toISOString().slice(0, 10), areas: [] })
    setShowModal(false)
    await loadSessions()
    const full = await loadSession(session.id)
    if (full) {
      saveCountSessionCache(session.id, full)
      setPendingCount(0)
      setActive(full); setCatFilter(null); setLocFilter(null); setStatusFilter('all'); setOpenId(null); setView('count')
    }
  }

  const confirmLine = async (line: Line, qty: number) => {
    // qty is in line.selectedUom — convert to baseUnit for variance (expectedQty is in baseUnit)
    const qtyBase = convertCountQtyToBase(qty, line.selectedUom, line.inventoryItem)
    const vPct  = Number(line.expectedQty) > 0 ? ((qtyBase - Number(line.expectedQty)) / Number(line.expectedQty)) * 100 : 0
    const vCost = (qtyBase - Number(line.expectedQty)) * Number(line.priceAtCount)
    setActive(prev => ({
      ...prev!,
      lines: prev!.lines!.map(l =>
        l.id === line.id ? { ...l, countedQty: qty, skipped: false, variancePct: vPct, varianceCost: vCost } : l
      ),
    }))
    setOpenId(null)
    // Auto-advance to next uncounted
    const next = filteredLines.find(l => l.id !== line.id && l.countedQty === null && !l.skipped)
    if (next) {
      setTimeout(() => {
        setOpenId(next.id)
        const prefix = typeof window !== 'undefined' && window.innerWidth < 640 ? 'm-' : 'd-'
        cardRefs.current[`${prefix}${next.id}`]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }, 120)
    }
    if (isOffline) {
      enqueueCountMutation({ sessionId: active!.id, lineId: line.id, type: 'count', qty })
      setPendingCount(c => c + 1)
      return
    }
    const res = await fetch(`/api/count/sessions/${active!.id}/lines/${line.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ countedQty: qty, expectedUpdatedAt: line.updatedAt }),
    })
    if (res.status === 409) {
      // Someone else edited this line — refresh the session to pick up their changes
      setToast('This item was just counted on another device. Refreshing…')
      const fresh = await loadSession(active!.id)
      if (fresh) setActive(fresh)
    }
  }

  const changeUom = async (line: Line, newUom: string) => {
    // When the open card's UOM changes, convert the current inputQty to the new unit
    if (openId === line.id) {
      const inBase = convertCountQtyToBase(inputQty, line.selectedUom, line.inventoryItem)
      setInputQty(Math.round(convertBaseToCountUom(inBase, newUom, line.inventoryItem) * 1000) / 1000)
    }
    setActive(prev => ({
      ...prev!, lines: prev!.lines!.map(l => l.id === line.id ? { ...l, selectedUom: newUom } : l),
    }))
    if (!isOffline) {
      await fetch(`/api/count/sessions/${active!.id}/lines/${line.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectedUom: newUom }),
      })
    }
  }

  const skipLine = async (line: Line) => {
    setActive(prev => ({
      ...prev!, lines: prev!.lines!.map(l => l.id === line.id ? { ...l, skipped: true } : l),
    }))
    setOpenId(null)
    if (isOffline) {
      enqueueCountMutation({ sessionId: active!.id, lineId: line.id, type: 'skip' })
      setPendingCount(c => c + 1)
      return
    }
    await fetch(`/api/count/sessions/${active!.id}/lines/${line.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skipped: true }),
    })
  }

  const unskipLine = async (line: Line) => {
    setActive(prev => ({
      ...prev!, lines: prev!.lines!.map(l =>
        l.id === line.id ? { ...l, skipped: false, countedQty: null, variancePct: null, varianceCost: null } : l
      ),
    }))
    setOpenId(line.id)
    setInputQty(0)
    await fetch(`/api/count/sessions/${active!.id}/lines/${line.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skipped: false }),
    })
  }

  const handleScan = useCallback(async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    const res = await fetch(`/api/inventory/search?barcode=${encodeURIComponent(trimmed)}`)
    const results: { id: string }[] = await res.json()
    if (results.length === 1) {
      const line = (active?.lines ?? []).find(l => l.inventoryItemId === results[0].id)
      if (line) {
        setSearchQuery('')
        const prefix = typeof window !== 'undefined' && window.innerWidth < 640 ? 'm-' : 'd-'
        setTimeout(() => {
          cardRefs.current[`${prefix}${line.id}`]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }, 50)
      }
    }
  }, [active?.lines, setSearchQuery])

  const openAddItem = async () => {
    const [cats, sups, areas] = await Promise.all([
      fetch('/api/categories').then(r => r.json()),
      fetch('/api/suppliers').then(r => r.json()),
      fetch('/api/storage-areas').then(r => r.json()),
    ])
    setAddItemCategories(cats)
    setAddItemSuppliers(sups)
    setAddItemAreas(areas)
    setAddItemForm({
      itemName: '', category: cats[0]?.name ?? '', supplierId: '', storageAreaId: '',
      purchaseUnit: '', qtyPerPurchaseUnit: '1', purchasePrice: '0',
      baseUnit: 'g', conversionFactor: '1', stockOnHand: '0', location: '',
    })
    setShowAddItem(true)
  }

  const handleAddItem = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!active) return
    setAddItemSaving(true)
    const res = await fetch('/api/inventory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(addItemForm),
    })
    const newItem = await res.json()
    // Add the new item as a count line in the active session
    const lineRes = await fetch(`/api/count/sessions/${active.id}/lines`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inventoryItemId: newItem.id }),
    })
    if (lineRes.ok) {
      const newLine = await lineRes.json()
      setActive(prev => prev ? { ...prev, lines: [...(prev.lines ?? []), newLine] } : prev)
    }
    setAddItemSaving(false)
    setShowAddItem(false)
    setToast(`"${addItemForm.itemName}" added to inventory and count session.`)
  }

  const addItemPricePreview =
    parseFloat(addItemForm.purchasePrice) /
    (parseFloat(addItemForm.qtyPerPurchaseUnit) * parseFloat(addItemForm.conversionFactor)) || 0

  const handleFinalize = async () => {
    if (!active || finalizing) return
    setFinalizing(true)
    // Sync any offline mutations before finalizing
    if (loadCountQueue().length > 0) {
      setOfflineSyncing(true)
      await flushCountQueue()
      setOfflineSyncing(false)
      setPendingCount(0)
    }
    // Mark as UPDATING immediately so the list reflects processing state
    await fetch(`/api/count/sessions/${active.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'UPDATING' }),
    })
    const sessionId = active.id
    // Navigate back to list right away — don't wait for heavy processing
    await loadSessions()
    setView('list'); setActive(null); setFinalizing(false)
    // Fire finalize and recover from failures so a session never sits stuck in UPDATING
    try {
      const res = await fetch(`/api/count/sessions/${sessionId}/finalize`, { method: 'POST' })
      if (!res.ok) {
        // Revert status so the user can retry from the review screen
        await fetch(`/api/count/sessions/${sessionId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'PENDING_REVIEW' }),
        })
        const data = await res.json().catch(() => null)
        setToast(`Couldn't finalize: ${data?.error ?? `HTTP ${res.status}`}. Reopen the session to retry.`)
        await loadSessions()
      }
    } catch (err) {
      // Network error — revert so it's not stuck in UPDATING
      await fetch(`/api/count/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'PENDING_REVIEW' }),
      }).catch(() => {})
      setToast(`Couldn't finalize: ${(err as Error).message}. Reopen the session to retry.`)
      await loadSessions()
    }
  }

  const handleDeleteSession = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    await fetch(`/api/count/sessions/${deleteTarget.id}`, { method: 'DELETE' })
    setDeleteTarget(null)
    setDeleting(false)
    await loadSessions()
    setToast('Count session deleted.')
  }

  const openEditModal = (s: Session) => {
    setEditTarget(s)
    setEditLabel(s.label)
    setEditCountedBy(s.countedBy)
    setEditDate(s.sessionDate.slice(0, 10))
  }

  const handleEditSession = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!editTarget) return
    await fetch(`/api/count/sessions/${editTarget.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: editLabel.trim(), countedBy: editCountedBy.trim(), sessionDate: editDate }),
    })
    setEditTarget(null)
    await loadSessions()
  }

  const handleReopenAndEdit = async (s: Session) => {
    if (s.status === 'FINALIZED') {
      await fetch(`/api/count/sessions/${s.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'IN_PROGRESS' }),
      })
      await loadSessions()
    }
    const full = await loadSession(s.id)
    if (full) { setActive(full); setCatFilter(null); setLocFilter(null); setStatusFilter('all'); setOpenId(null); setView('count') }
  }

  const backFromCount = () => {
    if (counted > 0 && !confirm('Leave count session? All confirmed items are saved.')) return
    setView('list'); setActive(null); setOpenId(null)
  }

  const handleSync = async () => {
    if (!active || syncing) return
    setSyncing(true)
    try {
      const res  = await fetch(`/api/count/sessions/${active.id}/sync`, { method: 'POST' })
      const data = await res.json()
      if (res.ok) {
        const { added = 0, removed = 0, updated = 0 } = data
        const changed = added + removed + updated
        if (changed > 0) {
          // Reload the full session so lines reflect all changes
          const refreshed = await loadSession(active.id)
          if (refreshed) setActive(refreshed)
          const parts: string[] = []
          if (added   > 0) parts.push(`${added} added`)
          if (removed > 0) parts.push(`${removed} removed`)
          if (updated > 0) parts.push(`${updated} updated`)
          setToast(parts.join(' · '))
        } else {
          setToast('Already up to date')
        }
      }
    } finally {
      setSyncing(false)
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // VIEW NEW — NEW SESSION FORM (full-page on mobile, modal on desktop)
  // ════════════════════════════════════════════════════════════════════════════

  // Shared form fields rendered identically in both mobile page + desktop modal
  const NewSessionFields = (
    <div className="space-y-5">
      <div>
        <label className="block font-mono text-[10.5px] text-ink-3 uppercase tracking-wide mb-2">Label</label>
        <input
          value={form.label}
          onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
          placeholder={`e.g. Full count ${fmtDate(new Date().toISOString())}`}
          className="w-full border border-line rounded-[9px] px-4 py-3 text-[13.5px] text-ink placeholder:text-ink-4 focus:outline-none focus:border-ink-3 transition-colors"
        />
      </div>
      <div>
        <label className="block font-mono text-[10.5px] text-ink-3 uppercase tracking-wide mb-2">
          Who&apos;s counting <span className="text-red-500">*</span>
        </label>
        <input
          required
          autoFocus
          value={form.countedBy}
          onChange={e => setForm(f => ({ ...f, countedBy: e.target.value }))}
          placeholder="Name"
          className="w-full border border-line rounded-[9px] px-4 py-3 text-[13.5px] text-ink placeholder:text-ink-4 focus:outline-none focus:border-ink-3 transition-colors"
        />
      </div>
      <div>
        <label className="block font-mono text-[10.5px] text-ink-3 uppercase tracking-wide mb-2">Count type</label>
        <div className="grid grid-cols-2 gap-2">
          {(['FULL', 'PARTIAL'] as const).map(t => (
            <button key={t} type="button"
              onClick={() => {
                setForm(f => ({ ...f, type: t }))
                if (t === 'PARTIAL' && !selectedRcId) setSelectedRcId(activeRcId ?? '')
              }}
              className={`py-3 rounded-[9px] text-[13.5px] font-medium border transition-colors ${
                form.type === t ? 'bg-ink text-paper border-ink' : 'bg-paper text-ink-2 border-line hover:border-ink-3'
              }`}
            >
              {t === 'FULL' ? 'Full count' : 'Partial count'}
            </button>
          ))}
        </div>
      </div>
      {form.type === 'PARTIAL' && (
        <div>
          <label className="block font-mono text-[10.5px] text-ink-3 uppercase tracking-wide mb-2">Areas to count</label>
          {storageAreas.length === 0 ? (
            <p className="font-mono text-[11px] text-ink-4">No storage areas configured yet.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {storageAreas.map(area => {
                const on = form.areas.includes(area.id)
                return (
                  <button key={area.id} type="button"
                    onClick={() => setForm(f => ({
                      ...f, areas: on ? f.areas.filter(x => x !== area.id) : [...f.areas, area.id],
                    }))}
                    className={`px-3 py-2 rounded-[9px] text-[13px] font-medium border transition-colors ${
                      on ? 'bg-ink text-paper border-ink' : 'bg-paper text-ink-2 border-line hover:border-ink-3'
                    }`}
                  >
                    {area.name}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}
      <div>
        <label className="block font-mono text-[10.5px] text-ink-3 uppercase tracking-wide mb-2">Date</label>
        <input
          type="date"
          value={form.sessionDate}
          onChange={e => setForm(f => ({ ...f, sessionDate: e.target.value }))}
          className="w-full border border-line rounded-[9px] px-4 py-3 text-[13.5px] text-ink focus:outline-none focus:border-ink-3 transition-colors"
        />
      </div>
      {revenueCenters.length > 1 && (
        <div>
          <label className="block font-mono text-[10.5px] text-ink-3 uppercase tracking-wide mb-2">Revenue Center</label>
          <select
            value={selectedRcId}
            onChange={e => setSelectedRcId(e.target.value)}
            className="w-full border border-line rounded-[9px] px-4 py-3 text-[13.5px] text-ink focus:outline-none focus:border-ink-3 transition-colors bg-paper"
          >
            {form.type === 'FULL' && (
              <option value="">All revenue centers</option>
            )}
            {revenueCenters.map(rc => (
              <option key={rc.id} value={rc.id}>{rc.name}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  )

  // ── New session form — full-page on mobile, centered card on desktop ──────
  if (view === 'new') {
    const cancelNew = () => { setView('list'); setForm({ label: '', countedBy: '', type: 'FULL', sessionDate: new Date().toISOString().slice(0, 10), areas: [] }) }
    return (
      <>
        {/* ── Mobile: full-page ── */}
        <form id="new-session-form" onSubmit={handleCreate} className="md:hidden flex flex-col min-h-screen bg-bg-2">
          <div className="sticky top-0 z-10 bg-paper border-b border-line px-4 py-4 flex items-center gap-3">
            <button type="button" onClick={cancelNew} className="p-1 -ml-1 text-ink-3 hover:text-ink">
              <ArrowLeft size={20} />
            </button>
            <h1 className="text-[17px] font-semibold text-ink tracking-[-0.02em] flex-1">New count session</h1>
          </div>
          <div className="flex-1 px-4 pt-6 pb-48">
            {NewSessionFields}
          </div>
          <div className="fixed bottom-[calc(4rem+env(safe-area-inset-bottom))] inset-x-0 bg-paper border-t border-line px-4 py-4 flex gap-3 z-[60]">
            <button type="button" onClick={cancelNew}
              className="flex-1 py-3.5 border border-line rounded-[12px] text-[13.5px] font-medium text-ink-2 hover:border-ink-3 transition-colors">
              Cancel
            </button>
            <button type="submit"
              className="flex-[2] py-3.5 bg-ink text-paper rounded-[12px] text-[13.5px] font-medium hover:bg-ink-2 transition-colors">
              Start count →
            </button>
          </div>
        </form>

        {/* ── Desktop: centered card ── */}
        <div className="hidden md:flex flex-col gap-6 max-w-xl">
          <div className="flex items-center gap-3">
            <button type="button" onClick={cancelNew} className="p-1.5 rounded-lg hover:bg-bg-2 text-ink-3 transition-colors">
              <ArrowLeft size={18} />
            </button>
            <div>
              <p className="font-mono text-[10.5px] text-ink-3 tracking-wide mb-0.5">TODAY / COUNT</p>
              <h1 className="text-[22px] font-semibold text-ink tracking-[-0.03em]">New count session</h1>
            </div>
          </div>
          <form onSubmit={handleCreate} className="bg-paper rounded-xl border border-line p-6 space-y-6">
            {NewSessionFields}
            <div className="flex gap-3 pt-1">
              <button type="button" onClick={cancelNew}
                className="flex-1 py-2.5 border border-line rounded-[9px] text-[13px] font-medium text-ink-2 hover:border-ink-3 transition-colors">
                Cancel
              </button>
              <button type="submit"
                className="flex-[2] py-2.5 bg-ink text-paper rounded-[9px] text-[13px] font-medium hover:bg-ink-2 transition-colors">
                Start count →
              </button>
            </div>
          </form>
        </div>
      </>
    )
  }

  // ════════════════════════════════════════════════════════════════════════════
  // VIEW A — SESSION LIST
  // ════════════════════════════════════════════════════════════════════════════
  if (view === 'list') {
    const lastFinalized  = sessions.find(s => s.status === 'FINALIZED')
    const inProgressSess = sessions.find(s => s.status === 'IN_PROGRESS' || s.status === 'PENDING_REVIEW')
    const nextCountDate  = (() => {
      const d = new Date()
      if (lastFinalized) {
        const last = new Date(lastFinalized.sessionDate)
        d.setTime(last.getTime())
        d.setDate(d.getDate() + 7)
      }
      return d
    })()
    const isOverdue    = nextCountDate <= new Date()
    const nextDateStr  = nextCountDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase()
    const overdueDays  = isOverdue ? Math.floor((Date.now() - nextCountDate.getTime()) / 86_400_000) : 0
    const inProgCounts = inProgressSess?.counts ?? { total: 0, counted: 0, skipped: 0 }
    const inProgPct    = inProgCounts.total > 0 ? (inProgCounts.counted / inProgCounts.total) * 100 : 0

    const sessionFilterChips: { key: typeof sessionFilter; label: string }[] = [
      { key: 'all',         label: `All · ${sessions.length}` },
      { key: 'in_progress', label: `In progress · ${sessions.filter(s => s.status === 'IN_PROGRESS' || s.status === 'PENDING_REVIEW').length}` },
      { key: 'finalized',   label: `Finalized · ${sessions.filter(s => s.status === 'FINALIZED').length}` },
      { key: 'full',        label: `Full counts · ${sessions.filter(s => s.type === 'FULL').length}` },
      { key: 'spot',        label: `Spot counts · ${sessions.filter(s => s.type === 'PARTIAL').length}` },
    ]

    return (
      <div>
        {toast && <Toast msg={toast} onDone={() => setToast(null)} />}

        {/* ── Header ── */}
        <div className="flex items-start justify-between mb-7 gap-6">
          <div>
            <p className="font-mono text-[10.5px] text-ink-3 tracking-wide mb-2">TODAY / COUNT</p>
            <h1 className="text-[36px] font-semibold tracking-[-0.04em] leading-none text-ink mb-1.5">Stock count</h1>
            <p className="text-[13.5px] text-ink-3 tracking-[-0.005em]">Track inventory accuracy and COGS by counting your stock regularly.</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-[9px] border border-line bg-paper text-ink-2 text-[13px] font-medium hover:border-ink-3 transition-colors whitespace-nowrap">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-ink-3"><path d="M3 5h18M3 12h18M3 19h12"/></svg>
              History
            </button>
            <button className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-[9px] border border-line bg-paper text-ink-2 text-[13px] font-medium hover:border-ink-3 transition-colors whitespace-nowrap">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-ink-3"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>
              Export reports
            </button>
            <button
              onClick={() => setView('new')}
              className="flex items-center gap-1.5 px-4 py-2.5 rounded-[9px] bg-ink text-paper text-[13px] font-medium hover:bg-ink-2 transition-colors whitespace-nowrap"
            >
              <span className="text-gold font-semibold text-base leading-none">+</span>
              Start count
            </button>
          </div>
        </div>

        {sessions.length === 0 ? (
          <div className="text-center py-20 text-ink-3">
            <ClipboardList size={40} className="mx-auto mb-4 opacity-20" />
            <p className="font-semibold text-ink text-base mb-1">No count sessions yet</p>
            <p className="text-[13.5px] text-ink-3 mb-6">Regular stock counts keep your inventory accurate and food costs on target.</p>
            <button
              onClick={() => setView('new')}
              className="inline-flex items-center gap-2 bg-ink text-paper px-5 py-2.5 rounded-[9px] text-[13px] font-medium hover:bg-ink-2 transition-colors"
            >
              <span className="text-gold font-semibold">+</span> Start First Count
            </button>
          </div>
        ) : (
          <>
            {/* ── KPI context strip ── */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
              {/* Hero: last finalized */}
              <div className="bg-ink text-paper rounded-xl border border-ink p-[18px] flex flex-col justify-between min-h-[120px] relative">
                <div className="absolute top-[18px] right-4 flex items-end gap-[3px] h-[18px]">
                  {[14,11,17,9,13,8,15,18].map((h, i) => (
                    <span key={i} className="w-[3px] rounded-[1px]" style={{ height: h, background: '#3f3f46' }} />
                  ))}
                </div>
                <div>
                  <p className="font-mono text-[10.5px] text-[#a1a1aa] tracking-[0.01em]">LAST FINALIZED COUNT</p>
                  {lastFinalized ? (
                    <p className="text-[42px] font-semibold tracking-[-0.045em] leading-none mt-2">
                      {formatCurrency(Number(lastFinalized.totalCountedValue)).replace(/(\.\d+)$/, '')}
                      <sub className="text-[20px] font-medium text-gold align-baseline ml-0.5 tracking-[-0.02em]">
                        {formatCurrency(Number(lastFinalized.totalCountedValue)).match(/\.\d+$/)?.[0] ?? '.00'}
                      </sub>
                    </p>
                  ) : (
                    <p className="text-[42px] font-semibold tracking-[-0.045em] leading-none mt-2 text-[#52525b]">—</p>
                  )}
                </div>
                <p className="font-mono text-[11px] text-[#a1a1aa] mt-2">
                  {lastFinalized
                    ? `${fmtDate(lastFinalized.sessionDate)} · ${lastFinalized.countedBy} · ${lastFinalized.counts?.total ?? 0} items`
                    : 'No finalized count yet'}
                </p>
              </div>

              {/* In progress */}
              <div className="bg-paper border border-ink-2 rounded-xl p-[18px] flex flex-col justify-between min-h-[120px] relative overflow-hidden">
                <div className="absolute top-0 left-0 w-8 h-0.5 bg-gold" />
                <div>
                  <p className="font-mono text-[10.5px] text-gold-2 tracking-[0.01em]">IN PROGRESS</p>
                  {inProgressSess ? (
                    <>
                      <div className="flex items-baseline gap-2.5 mt-2">
                        <span className="text-[28px] font-semibold tracking-[-0.035em] leading-none text-ink">
                          {inProgCounts.counted}
                          <small className="text-[16px] font-medium text-ink-3 tracking-[-0.02em]">/{inProgCounts.total}</small>
                        </span>
                        <span className="font-mono text-[11px] text-ink-3">{Math.round(inProgPct)}% counted</span>
                      </div>
                      <div className="h-1.5 bg-bg-2 rounded-full mt-2.5 overflow-hidden">
                        <div className="h-1.5 bg-gold rounded-full" style={{ width: `${Math.max(inProgPct, inProgCounts.counted > 0 ? 1.5 : 0)}%` }} />
                      </div>
                    </>
                  ) : (
                    <p className="text-[28px] font-semibold tracking-[-0.035em] leading-none mt-2 text-ink-4">—</p>
                  )}
                </div>
                <p className="font-mono text-[11px] text-ink-3 mt-2">
                  {inProgressSess
                    ? `${inProgressSess.countedBy} · ${fmtDate(inProgressSess.sessionDate)}`
                    : 'No active session'}
                </p>
              </div>

              {/* Next count due */}
              <div className={`rounded-xl p-[18px] flex flex-col justify-between min-h-[120px] relative ${isOverdue ? 'bg-[#fffbeb] border border-[#fcd34d]' : 'bg-paper border border-line'}`}>
                {isOverdue && <div className="absolute top-[18px] right-[18px] w-[7px] h-[7px] rounded-full bg-gold" />}
                <div>
                  <p className={`font-mono text-[10.5px] tracking-[0.01em] ${isOverdue ? 'text-gold-2' : 'text-ink-3'}`}>NEXT COUNT DUE</p>
                  <p className={`text-[28px] font-semibold tracking-[-0.035em] leading-none mt-2 ${isOverdue ? 'text-gold' : 'text-ink'}`}>
                    {nextCountDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </p>
                </div>
                <p className="font-mono text-[11px] mt-2">
                  {isOverdue
                    ? <span className="text-gold-2 font-medium">Overdue {overdueDays} day{overdueDays !== 1 ? 's' : ''} · weekly cadence</span>
                    : <span className="text-ink-3">Weekly cadence</span>}
                </p>
              </div>

              {/* Session summary */}
              <div className="bg-paper border border-line rounded-xl p-[18px] flex flex-col justify-between min-h-[120px]">
                <div>
                  <p className="font-mono text-[10.5px] text-ink-3 tracking-[0.01em]">TOTAL SESSIONS</p>
                  <p className="text-[42px] font-semibold tracking-[-0.045em] leading-none mt-2 text-ink">{sessions.length}</p>
                </div>
                <p className="font-mono text-[11px] text-ink-3 mt-2">
                  {sessions.filter(s => s.status === 'FINALIZED').length} finalized · {sessions.filter(s => s.status === 'IN_PROGRESS').length} active
                </p>
              </div>
            </div>

            {/* ── Filter chips ── */}
            <div className="flex flex-wrap gap-1.5 mb-3">
              {sessionFilterChips.map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => setSessionFilter(key)}
                  className={`font-mono text-[11px] px-3 py-1.5 rounded-full border transition-colors whitespace-nowrap ${
                    sessionFilter === key
                      ? 'bg-ink text-paper border-ink'
                      : 'bg-paper text-ink-2 border-line hover:border-ink-3'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* ── Search + filters ── */}
            <div className="flex gap-2 mb-3">
              <div className="relative flex-1">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" />
                <input
                  type="text"
                  placeholder="Search by counter, date, session…"
                  value={sessionSearch}
                  onChange={e => setSessionSearch(e.target.value)}
                  className="w-full pl-8 pr-3 py-2.5 text-[13px] bg-paper border border-line rounded-[9px] text-ink placeholder:text-ink-3 focus:outline-none focus:border-ink-3 transition-colors"
                />
              </div>
            </div>

            <p className="font-mono text-[11px] text-ink-3 mb-3 tracking-wide">
              SHOWING {filteredSessions.length} OF {sessions.length} COUNT{sessions.length !== 1 ? 'S' : ''} · NEWEST FIRST
            </p>

            {/* ── Mobile list ── */}
            <div className="flex sm:hidden flex-col gap-2 mb-4">
              {filteredSessions.map(s => {
                const counts = s.counts ?? { total: 0, counted: 0, skipped: 0 }
                const isUpdating = s.status === 'UPDATING'
                const handleCardTap = () => {
                  setSessionMenuId(null)
                  if (s.status === 'IN_PROGRESS' || s.status === 'PENDING_REVIEW') openSession(s, 'count')
                  else if (s.status === 'FINALIZED') openSession(s, 'review')
                }
                return (
                  <div key={s.id} className="bg-paper rounded-xl border border-line border-l-[3px] flex items-stretch"
                    style={{ borderLeftColor: SESSION_ACCENT[s.status] ?? '#d4d4d8' }}>
                    <div
                      className={`flex-1 min-w-0 px-4 py-3 ${!isUpdating && s.status !== 'CANCELLED' ? 'cursor-pointer' : 'cursor-default'}`}
                      onClick={!isUpdating && s.status !== 'CANCELLED' ? handleCardTap : undefined}
                    >
                      <div className="flex items-center gap-2">
                        <span className="flex-1 text-[13.5px] font-medium text-ink truncate tracking-[-0.01em]">
                          {s.label || (s.type === 'FULL' ? 'Full count' : 'Partial count')}
                        </span>
                        <StatusBadge status={s.status} />
                      </div>
                      <div className="flex items-center justify-between mt-1 gap-2">
                        <span className="font-mono text-[11px] text-ink-3 truncate">
                          {fmtDate(s.sessionDate)} · {s.countedBy}
                        </span>
                        {s.status === 'IN_PROGRESS'    && <span className="font-mono text-[11px] font-medium text-gold shrink-0">Continue →</span>}
                        {s.status === 'PENDING_REVIEW' && <span className="font-mono text-[11px] font-medium text-gold-2 shrink-0">Review →</span>}
                        {s.status === 'FINALIZED'      && <span className="font-mono text-[11px] font-medium text-green-700 shrink-0">Report</span>}
                        {isUpdating && (
                          <span className="flex items-center gap-1 font-mono text-[11px] text-violet-600 shrink-0">
                            <span className="inline-block w-2.5 h-2.5 rounded-full border-2 border-violet-400 border-t-transparent animate-spin" />
                            Processing…
                          </span>
                        )}
                      </div>
                      {s.status === 'FINALIZED' && Number(s.totalCountedValue) > 0 && (
                        <div className="mt-1 font-mono text-[13px] font-semibold text-ink">
                          {formatCurrency(Number(s.totalCountedValue))}
                          <span className="font-mono text-[11px] font-normal text-ink-3 ml-1">total value</span>
                        </div>
                      )}
                    </div>
                    <div className="relative flex items-center pr-2">
                      <button
                        onClick={e => { e.stopPropagation(); setSessionMenuId(sessionMenuId === s.id ? null : s.id) }}
                        className="w-8 h-8 flex items-center justify-center rounded-lg text-ink-4 hover:bg-bg-2"
                      >
                        <MoreHorizontal size={15} />
                      </button>
                      {sessionMenuId === s.id && (
                        <>
                          <div className="fixed inset-0 z-40" onClick={() => setSessionMenuId(null)} />
                          <div className="absolute right-0 top-full mt-1 w-48 bg-paper border border-line rounded-xl shadow-lg z-50 overflow-hidden">
                            <button onClick={e => { e.stopPropagation(); setSessionMenuId(null); openEditModal(s) }}
                              className="flex items-center gap-2 w-full px-4 py-3 text-[13px] text-ink-2 hover:bg-bg-2 border-b border-line">
                              <Pencil size={13} /> Edit metadata
                            </button>
                            <button onClick={e => { e.stopPropagation(); setSessionMenuId(null); handleReopenAndEdit(s) }}
                              className="flex items-center gap-2 w-full px-4 py-3 text-[13px] text-ink-2 hover:bg-bg-2 border-b border-line">
                              <ClipboardList size={13} /> {s.status === 'FINALIZED' ? 'Reopen & edit' : 'Edit counts'}
                            </button>
                            <button onClick={e => { e.stopPropagation(); setSessionMenuId(null); setDeleteTarget(s) }}
                              className="flex items-center gap-2 w-full px-4 py-3 text-[13px] text-red-500 hover:bg-red-50">
                              <Trash2 size={13} /> Delete
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            {/* ── Desktop table ── */}
            <div className="hidden sm:block bg-paper border border-line rounded-xl overflow-hidden mb-5">
              <div className="grid grid-cols-[100px_1.6fr_0.7fr_1.4fr_1fr_220px] px-[18px] py-2.5 bg-bg-2 border-b border-line font-mono text-[10.5px] text-ink-3 tracking-[0.01em]">
                <span>DATE</span>
                <span>SESSION</span>
                <span>TYPE</span>
                <span>PROGRESS</span>
                <span className="text-right">VALUE</span>
                <span className="text-right">ACTIONS</span>
              </div>
              <div>
                {filteredSessions.length === 0 ? (
                  <div className="px-[18px] py-10 text-center font-mono text-[11px] text-ink-4">NO SESSIONS MATCH THIS FILTER</div>
                ) : filteredSessions.map((s, idx) => {
                  const counts  = s.counts ?? { total: 0, counted: 0, skipped: 0 }
                  const pct     = counts.total > 0 ? Math.round((counts.counted / counts.total) * 100) : 0
                  const isLast  = idx === filteredSessions.length - 1
                  return (
                    <div key={s.id}
                      className={`grid grid-cols-[100px_1.6fr_0.7fr_1.4fr_1fr_220px] px-[18px] py-4 items-center hover:bg-bg-2/60 transition-colors ${isLast ? '' : 'border-b border-line'}`}
                    >
                      {/* Date */}
                      <div>
                        <div className="font-mono text-[13px] text-ink tracking-[-0.01em]">{fmtDate(s.sessionDate)}</div>
                        <div className="font-mono text-[10.5px] text-ink-3 mt-0.5">{relTime(s.sessionDate, s.startedAt)}</div>
                      </div>
                      {/* Session label + status */}
                      <div className="min-w-0 pr-3">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[13.5px] font-medium text-ink tracking-[-0.01em] truncate">
                            {s.label || (s.type === 'FULL' ? 'Full count' : 'Partial count')}
                          </span>
                          <StatusBadge status={s.status} />
                        </div>
                        <div className="font-mono text-[11px] text-ink-3 mt-0.5">
                          <b className="font-medium text-ink-2">{s.countedBy}</b>
                          {s.status === 'FINALIZED' && s.finalizedAt && s.startedAt
                            ? ` · ${durationMin(s.startedAt, s.finalizedAt)} min duration`
                            : s.status === 'IN_PROGRESS' || s.status === 'PENDING_REVIEW'
                              ? ` · started ${fmtClock(s.startedAt)}`
                              : ` · ${counts.total} items`}
                        </div>
                      </div>
                      {/* Type */}
                      <div className="font-mono text-[13px] text-ink-2 tracking-[-0.01em]">{s.type === 'FULL' ? 'Full' : 'Partial'}</div>
                      {/* Progress */}
                      <div>
                        {s.status === 'FINALIZED' ? (
                          <>
                            <div className="flex items-baseline gap-2">
                              <span className="font-mono text-[13px] font-medium text-ink tracking-[-0.01em]">{counts.total} / {counts.total}</span>
                              <span className="font-mono text-[11px] text-green-700">complete</span>
                            </div>
                            <div className="h-[5px] bg-bg-2 rounded-full mt-1.5 w-4/5 overflow-hidden">
                              <div className="h-[5px] bg-green-500 rounded-full" style={{ width: '100%' }} />
                            </div>
                          </>
                        ) : s.status === 'UPDATING' ? (
                          <span className="font-mono text-[11px] text-violet-600">Processing…</span>
                        ) : (
                          <>
                            <div className="flex items-baseline gap-2">
                              <span className="font-mono text-[13px] font-medium text-ink tracking-[-0.01em]">{counts.counted} / {counts.total}</span>
                              <span className="font-mono text-[11px] text-gold">{pct}%</span>
                            </div>
                            <div className="h-[5px] bg-bg-2 rounded-full mt-1.5 w-4/5 overflow-hidden">
                              <div className="h-[5px] bg-gold rounded-full" style={{ width: `${Math.max(pct, counts.counted > 0 ? 1.5 : 0)}%` }} />
                            </div>
                          </>
                        )}
                      </div>
                      {/* Value */}
                      <div className="text-right">
                        {s.status === 'FINALIZED' && Number(s.totalCountedValue) > 0 ? (
                          <>
                            <div className="font-mono text-[14px] font-semibold text-ink tracking-[-0.015em]">
                              {formatCurrency(Number(s.totalCountedValue))}
                            </div>
                            <div className="font-mono text-[10.5px] text-ink-3 mt-0.5">{counts.total} lines</div>
                          </>
                        ) : (
                          <span className="font-mono text-[13px] text-ink-4">—</span>
                        )}
                      </div>
                      {/* Actions */}
                      <div className="flex items-center gap-1.5 justify-end">
                        {(s.status === 'IN_PROGRESS' || s.status === 'PENDING_REVIEW') && (
                          <button
                            onClick={() => openSession(s, 'count')}
                            className="flex items-center gap-1 px-3 py-1.5 rounded-[8px] bg-ink text-paper text-[12.5px] font-medium hover:bg-ink-2 transition-colors whitespace-nowrap"
                          >
                            Continue <span className="text-gold">→</span>
                          </button>
                        )}
                        {s.status === 'UPDATING' && (
                          <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] font-mono text-[11px] text-violet-600 bg-violet-50 border border-violet-200">
                            <span className="w-3 h-3 rounded-full border-2 border-violet-400 border-t-transparent animate-spin" />
                            Updating…
                          </span>
                        )}
                        {s.status === 'FINALIZED' && (
                          <button
                            onClick={() => openSession(s, 'review')}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] border border-line bg-paper text-[12.5px] font-medium text-ink-2 hover:border-ink-3 transition-colors whitespace-nowrap"
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
                            Report
                          </button>
                        )}
                        <button onClick={e => { e.stopPropagation(); openEditModal(s) }} title="Edit"
                          className="p-1.5 rounded-lg text-ink-4 hover:text-ink-2 hover:bg-bg-2 transition-colors">
                          <Pencil size={13} />
                        </button>
                        <button onClick={e => { e.stopPropagation(); handleReopenAndEdit(s) }}
                          title={s.status === 'FINALIZED' ? 'Reopen & edit' : 'Edit counts'}
                          className="p-1.5 rounded-lg text-ink-4 hover:text-ink-2 hover:bg-bg-2 transition-colors">
                          <ClipboardList size={13} />
                        </button>
                        <button onClick={e => { e.stopPropagation(); setDeleteTarget(s) }} title="Delete"
                          className="p-1.5 rounded-lg text-ink-4 hover:text-red-500 hover:bg-red-50 transition-colors">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* ── Overdue callout ── */}
            {isOverdue && (
              <div className="flex items-center gap-5 bg-[#fffbeb] border border-[#fcd34d] rounded-xl px-[22px] py-[18px] mb-5">
                <div className="w-9 h-9 rounded-[10px] bg-gold-soft border border-[#fcd34d] flex items-center justify-center shrink-0">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#b45309" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-mono text-[10.5px] text-gold-2 tracking-[0.02em] font-semibold">COUNT OVERDUE · {nextDateStr}</p>
                  <p className="text-[14px] text-amber-900 mt-1 tracking-[-0.01em]">
                    Weekly count is <strong>{overdueDays} day{overdueDays !== 1 ? 's' : ''} late</strong>. COGS calculations are drifting from actuals — start a new count to re-anchor.
                  </p>
                </div>
                <button
                  onClick={() => setView('new')}
                  className="flex items-center gap-1.5 px-4 py-2.5 rounded-[9px] bg-gold text-white text-[13px] font-medium hover:bg-gold-2 transition-colors shrink-0 whitespace-nowrap"
                >
                  <span className="text-[#fef3c7] font-semibold">+</span>
                  Start count now
                </button>
              </div>
            )}

            {/* ── Footer note ── */}
            <div className="flex justify-between font-mono text-[10.5px] text-ink-3 tracking-wide">
              <span>
                SHOWING {filteredSessions.length} SESSION{filteredSessions.length !== 1 ? 'S' : ''} · {sessions.filter(s => s.status === 'IN_PROGRESS').length} IN PROGRESS · {sessions.filter(s => s.status === 'FINALIZED').length} FINALIZED
              </span>
              <span>WEEKLY CADENCE · <kbd className="font-mono text-[10px] bg-bg-2 border border-line rounded px-1 py-px text-ink-2">⌘N</kbd> FOR NEW COUNT</span>
            </div>
          </>
        )}

        {/* ── Delete confirmation modal ── */}
        {deleteTarget && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
            <div className="bg-paper rounded-2xl shadow-xl w-full max-w-sm p-6">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center shrink-0">
                  <Trash2 size={18} className="text-red-600" />
                </div>
                <div>
                  <h3 className="font-semibold text-ink">Delete count session?</h3>
                  <p className="text-xs text-ink-3 mt-0.5">&ldquo;{deleteTarget.label || 'Untitled'}&rdquo; — {fmtDate(deleteTarget.sessionDate)}</p>
                </div>
              </div>
              {deleteTarget.status === 'FINALIZED' && (
                <div className="bg-[#fffbeb] border border-[#fcd34d] rounded-lg px-3 py-2 text-xs text-gold-2 mb-3">
                  This session is finalized. Deleting it won&apos;t revert inventory stock levels.
                </div>
              )}
              <div className="flex gap-3 mt-4">
                <button onClick={() => setDeleteTarget(null)}
                  className="flex-1 px-4 py-2.5 rounded-[9px] border border-line text-[13px] font-medium text-ink-2 hover:border-ink-3 transition-colors">
                  Cancel
                </button>
                <button onClick={handleDeleteSession} disabled={deleting}
                  className="flex-1 px-4 py-2.5 rounded-[9px] bg-red-600 text-white text-[13px] font-medium hover:bg-red-700 disabled:opacity-60 transition-colors">
                  {deleting ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Edit session metadata modal ── */}
        {editTarget && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
            <div className="bg-paper rounded-2xl shadow-xl w-full max-w-sm p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-ink">Edit session details</h3>
                <button onClick={() => setEditTarget(null)} className="p-1 rounded-lg hover:bg-bg-2 text-ink-3">
                  <X size={16} />
                </button>
              </div>
              <form onSubmit={handleEditSession} className="space-y-3">
                <div>
                  <label className="text-[11px] font-medium text-ink-3 block mb-1 uppercase tracking-wide">Label</label>
                  <input value={editLabel} onChange={e => setEditLabel(e.target.value)}
                    placeholder="e.g. Full count Apr 12"
                    className="w-full border border-line rounded-[9px] px-3 py-2.5 text-[13px] text-ink focus:outline-none focus:border-ink-3 transition-colors" />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-ink-3 block mb-1 uppercase tracking-wide">Counted by</label>
                  <input value={editCountedBy} onChange={e => setEditCountedBy(e.target.value)} required
                    className="w-full border border-line rounded-[9px] px-3 py-2.5 text-[13px] text-ink focus:outline-none focus:border-ink-3 transition-colors" />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-ink-3 block mb-1 uppercase tracking-wide">Date</label>
                  <input type="date" value={editDate} onChange={e => setEditDate(e.target.value)}
                    className="w-full border border-line rounded-[9px] px-3 py-2.5 text-[13px] text-ink focus:outline-none focus:border-ink-3 transition-colors" />
                </div>
                <div className="flex gap-3 pt-1">
                  <button type="button" onClick={() => setEditTarget(null)}
                    className="flex-1 px-4 py-2.5 rounded-[9px] border border-line text-[13px] font-medium text-ink-2 hover:border-ink-3 transition-colors">
                    Cancel
                  </button>
                  <button type="submit"
                    className="flex-1 px-4 py-2.5 rounded-[9px] bg-ink text-paper text-[13px] font-medium hover:bg-ink-2 transition-colors">
                    Save
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ════════════════════════════════════════════════════════════════════════════
  // VIEW B — COUNT MODE
  // ════════════════════════════════════════════════════════════════════════════
  if (view === 'count' && active) {
    const renderLine = (line: Line) => {
      const isOpen    = openId === line.id
      const isCounted = line.countedQty !== null && !line.skipped
      const isSkipped = line.skipped
      const locLabel  = line.inventoryItem.storageArea?.name ?? line.inventoryItem.location

      // inputQty is in line.selectedUom; expectedQty is in baseUnit — convert before comparing
      const inputBase = convertCountQtyToBase(inputQty, line.selectedUom, line.inventoryItem)
      const liveVar = isOpen && Number(line.expectedQty) > 0
        ? ((inputBase - Number(line.expectedQty)) / Number(line.expectedQty)) * 100
        : null

      if (isSkipped) return (
        <div key={line.id} id={`ln-${line.id}`}
          ref={el => { cardRefs.current[`d-${line.id}`] = el }}
          className="mx-4 mb-2 border border-line bg-bg-2 rounded-xl opacity-60"
        >
          <div className="flex items-center gap-3 px-4 py-3">
            <SkipForward size={15} className="text-ink-4 shrink-0" />
            <span className="flex-1 text-[13.5px] text-ink-3 line-through">{line.inventoryItem.itemName}</span>
            <button
              onClick={() => setEditingItemId(line.inventoryItemId)}
              className="p-1.5 rounded-lg text-ink-4 hover:text-ink-2 hover:bg-line"
              title="Edit item"
            >
              <Pencil size={13} />
            </button>
            <button
              onClick={() => unskipLine(line)}
              className="font-mono text-[11px] text-gold font-medium hover:text-gold-2 px-2 py-1 rounded-[6px] hover:bg-gold-soft transition-colors"
            >
              Count it
            </button>
          </div>
        </div>
      )

      if (isCounted && !isOpen) {
        const vPct = line.variancePct !== null ? Number(line.variancePct) : null
        const large = vPct !== null && Math.abs(vPct) > LARGE_VARIANCE_PCT
        return (
          <div key={line.id} id={`ln-${line.id}`}
            ref={el => { cardRefs.current[`d-${line.id}`] = el }}
            onClick={() => setOpenId(line.id)}
            className={`mx-4 mb-2 rounded-xl bg-green-50 border border-green-200 cursor-pointer ${large ? 'border-l-[3px] border-l-gold' : ''}`}
          >
            <div className="flex items-center gap-3 px-4 py-3">
              <CheckCircle2 size={18} className="text-green-600 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[13.5px] font-medium text-ink">{line.inventoryItem.itemName}</div>
                <div className="font-mono text-[11px] text-ink-3 mt-0.5 flex items-center gap-1.5">
                  <span>{Number(line.countedQty).toFixed(2)} {line.selectedUom}</span>
                  {vPct !== null && (
                    <span className={varColor(vPct)}>· {vPct >= 0 ? '+' : ''}{vPct.toFixed(1)}%</span>
                  )}
                </div>
              </div>
              <CategoryBadge category={line.inventoryItem.category} />
              {locLabel && <span className="font-mono text-[11px] text-ink-3 ml-1 hidden sm:block">{locLabel}</span>}
              <button
                onClick={e => { e.stopPropagation(); setEditingItemId(line.inventoryItemId) }}
                className="p-1.5 rounded-lg text-ink-4 hover:text-ink-2 hover:bg-green-100 ml-1"
                title="Edit item"
              >
                <Pencil size={13} />
              </button>
            </div>
          </div>
        )
      }

      // Uncounted / open
      const largeOpen = liveVar !== null && Math.abs(liveVar) > LARGE_VARIANCE_PCT
      return (
        <div key={line.id} id={`ln-${line.id}`}
          ref={el => { cardRefs.current[`d-${line.id}`] = el }}
          className={`mx-4 mb-2 rounded-xl bg-paper transition-all ${
            isOpen
              ? `border-2 border-gold${largeOpen ? ' border-l-[3px] border-l-gold' : ''}`
              : 'border border-line hover:border-line-2'
          }`}
        >
          {/* Header row */}
          <div className="flex items-center gap-3 px-4 py-3 cursor-pointer"
            onClick={() => setOpenId(isOpen ? null : line.id)}
          >
            <Circle size={16} className="text-line-2 shrink-0" />
            <span className="flex-1 text-[13.5px] font-medium text-ink">{line.inventoryItem.itemName}</span>
            <CategoryBadge category={line.inventoryItem.category} />
            {locLabel && <span className="font-mono text-[11px] text-ink-3 ml-1">{locLabel}</span>}
            <button
              onClick={e => { e.stopPropagation(); setEditingItemId(line.inventoryItemId) }}
              className="p-1.5 rounded-lg text-ink-4 hover:text-ink-2 hover:bg-bg-2"
              title="Edit item"
            >
              <Pencil size={13} />
            </button>
            <ChevronDown size={15} className={`text-ink-3 ml-1 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
          </div>

          {/* Expanded body */}
          {isOpen && (
            <div className="px-4 pb-4 pt-1 border-t border-line">
              {(() => {
                const uoms = getCountableUoms(line.inventoryItem)
                const expectedDisplay = convertBaseToCountUom(Number(line.expectedQty), line.selectedUom, line.inventoryItem)
                return (
                  <>
                    {uoms.length > 1 && (
                      <div className="mb-3">
                        <select
                          value={line.selectedUom}
                          onChange={e => changeUom(line, e.target.value)}
                          className="w-full border border-line rounded-[9px] px-3 py-2 text-[13px] font-medium text-ink-2 bg-paper focus:outline-none focus:border-ink-3 transition-colors"
                        >
                          {uoms.map(opt => (
                            <option key={opt.label} value={opt.label}>{uomOptionLabel(opt, line.inventoryItem.baseUnit)}</option>
                          ))}
                        </select>
                      </div>
                    )}

                    {/* Expected + live variance */}
                    <div className="font-mono text-[11px] text-ink-3 mb-1.5 flex items-center gap-1.5">
                      <span>Expected: {expectedDisplay.toFixed(2)} {line.selectedUom}</span>
                      {liveVar !== null && (
                        <span className={`font-medium ${varColor(liveVar)}`}>
                          · {liveVar > 0 ? '+' : ''}{liveVar.toFixed(1)}%
                        </span>
                      )}
                    </div>

                    {(line.inventoryItem.parLevel != null || line.inventoryItem.lastCountQty != null) && (
                      <div className="font-mono text-[11px] text-ink-3 mb-3 flex items-center gap-3">
                        {line.inventoryItem.parLevel != null && (
                          <span>Par: <span className="font-medium text-ink-2">{Number(line.inventoryItem.parLevel).toFixed(2)} {line.selectedUom}</span></span>
                        )}
                        {line.inventoryItem.lastCountQty != null && (
                          <span>Last count: <span className="font-medium text-ink-2">{convertBaseToCountUom(Number(line.inventoryItem.lastCountQty), line.selectedUom, line.inventoryItem).toFixed(2)} {line.selectedUom}</span></span>
                        )}
                      </div>
                    )}
                  </>
                )
              })()}

              {/* ± stepper */}
              <div className="flex items-center gap-2 mb-3">
                <button
                  onClick={() => setInputQty(v => Math.max(0, Math.round((v - 1) * 100) / 100))}
                  className="w-14 h-[66px] rounded-[9px] bg-bg-2 border border-line flex items-center justify-center hover:bg-line transition-colors shrink-0"
                >
                  <Minus size={20} className="text-ink-2" />
                </button>
                <input
                  type="number"
                  value={inputQty}
                  onChange={e => setInputQty(parseFloat(e.target.value) || 0)}
                  className="flex-1 min-w-0 h-[66px] text-center text-[28px] font-semibold tracking-[-0.03em] border-2 border-gold rounded-[9px] focus:outline-none text-ink"
                  min={0} step={0.1}
                />
                <button
                  onClick={() => setInputQty(v => Math.round((v + 1) * 100) / 100)}
                  className="w-14 h-[66px] rounded-[9px] bg-bg-2 border border-line flex items-center justify-center hover:bg-line transition-colors shrink-0"
                >
                  <Plus size={20} className="text-ink-2" />
                </button>
              </div>

              <div className="text-center font-mono text-[11px] text-ink-3 mb-4">{line.selectedUom}</div>

              <div className="flex gap-2">
                <button
                  onClick={() => confirmLine(line, inputQty)}
                  className="flex-1 h-11 bg-ink text-paper rounded-[9px] font-medium text-[13px] hover:bg-ink-2 transition-colors flex items-center justify-center gap-1.5"
                >
                  <Check size={15} className="text-gold" /> Confirm count
                </button>
                <button
                  onClick={() => confirmLine(line, 0)}
                  className="px-3 h-11 border border-[#fcd34d] bg-gold-soft text-gold-2 rounded-[9px] font-mono text-[11px] font-medium hover:bg-[#fde68a] transition-colors"
                  title="Mark out of stock"
                >
                  Out of stock
                </button>
                <button
                  onClick={() => skipLine(line)}
                  className="px-4 h-11 border border-line rounded-[9px] text-[13px] text-ink-3 hover:bg-bg-2 transition-colors flex items-center gap-1.5"
                >
                  <SkipForward size={13} /> Skip
                </button>
              </div>
            </div>
          )}
        </div>
      )
    }

    const renderMobileLine = (line: Line) => {
      const isOpen    = openId === line.id
      const isCounted = line.countedQty !== null && !line.skipped
      const isSkipped = line.skipped
      const locLabel  = line.inventoryItem.storageArea?.name ?? line.inventoryItem.location
      const subtitle  = [line.inventoryItem.category, locLabel].filter(Boolean).join(' · ')

      const inputBase2 = convertCountQtyToBase(inputQty, line.selectedUom, line.inventoryItem)
      const liveVar = isOpen && Number(line.expectedQty) > 0
        ? ((inputBase2 - Number(line.expectedQty)) / Number(line.expectedQty)) * 100
        : null

      const dotColor = isSkipped
        ? 'bg-ink-4'
        : isCounted
          ? (line.variancePct !== null && Math.abs(Number(line.variancePct)) > LARGE_VARIANCE_PCT ? 'bg-gold' : 'bg-green-500')
          : 'bg-ink-4'

      const rowBg = isSkipped
        ? 'bg-bg-2 border-line opacity-60'
        : isCounted
          ? (line.variancePct !== null && Math.abs(Number(line.variancePct)) > LARGE_VARIANCE_PCT
              ? 'bg-amber-50/60 border-amber-200'
              : 'bg-green-50/60 border-green-200')
          : isOpen
            ? 'border-2 border-gold bg-paper'
            : 'bg-paper border-line'

      return (
        <div key={`m-${line.id}`}
          ref={el => { cardRefs.current[`m-${line.id}`] = el }}
          className={`rounded-xl border ${rowBg} overflow-hidden`}
        >
          <div
            className="flex items-center gap-3 px-3 py-2.5 cursor-pointer"
            onClick={() => setOpenId(isOpen ? null : line.id)}
          >
            <div className={`w-2 h-2 rounded-full shrink-0 ${dotColor}`} />
            <div className="flex-1 min-w-0">
              <div className={`text-sm font-medium truncate ${isSkipped ? 'line-through text-ink-4' : 'text-ink'}`}>
                {line.inventoryItem.itemName}
              </div>
              {subtitle && <div className="font-mono text-[10.5px] text-ink-4 mt-0.5">{subtitle}</div>}
            </div>
            <button
              onClick={e => { e.stopPropagation(); setEditingItemId(line.inventoryItemId) }}
              className="p-1.5 rounded-[8px] text-ink-4 hover:text-ink-2 hover:bg-bg-2 shrink-0"
              title="Edit item"
            >
              <Pencil size={13} />
            </button>
            <div className="text-right shrink-0">
              {isSkipped ? (
                <button
                  onClick={e => { e.stopPropagation(); unskipLine(line) }}
                  className="font-mono text-[11px] text-gold font-medium px-2 py-1 rounded-[6px] hover:bg-gold-soft"
                >
                  Count it
                </button>
              ) : isCounted ? (
                <>
                  <div className="text-sm font-semibold text-ink">
                    {Number(line.countedQty).toFixed(1)} {line.selectedUom}
                  </div>
                  {line.variancePct !== null && (
                    <div className={`text-xs ${varColor(line.variancePct)}`}>
                      {Number(line.variancePct) >= 0 ? '+' : ''}{Number(line.variancePct).toFixed(1)}%
                    </div>
                  )}
                </>
              ) : (
                <span className="font-mono text-[11px] text-ink-4">— —</span>
              )}
            </div>
          </div>

          {isOpen && (
            <div className="px-3 pb-3 pt-1 border-t border-line">
              {/* UOM selector + expected */}
              {(() => {
                const uoms = getCountableUoms(line.inventoryItem)
                const expectedDisplay = convertBaseToCountUom(Number(line.expectedQty), line.selectedUom, line.inventoryItem)
                return (
                  <>
                    {uoms.length > 1 && (
                      <div className="mb-2">
                        <select
                          value={line.selectedUom}
                          onChange={e => changeUom(line, e.target.value)}
                          className="w-full border border-line rounded-[9px] px-3 py-2 text-[13px] font-medium text-ink bg-paper focus:outline-none focus:border-gold"
                        >
                          {uoms.map(opt => (
                            <option key={opt.label} value={opt.label}>{uomOptionLabel(opt, line.inventoryItem.baseUnit)}</option>
                          ))}
                        </select>
                      </div>
                    )}
                    <div className="font-mono text-[10.5px] text-ink-3 mb-1.5 flex items-center gap-1.5">
                      <span>Expected: {expectedDisplay.toFixed(2)} {line.selectedUom}</span>
                      {liveVar !== null && (
                        <span className={`font-medium ${varColor(liveVar)}`}>
                          · {liveVar > 0 ? '+' : ''}{liveVar.toFixed(1)}%
                        </span>
                      )}
                    </div>
                    {(line.inventoryItem.parLevel != null || line.inventoryItem.lastCountQty != null) && (
                      <div className="font-mono text-[10.5px] text-ink-4 mb-2 flex flex-wrap items-center gap-x-3">
                        {line.inventoryItem.parLevel != null && (
                          <span>Par: <span className="font-medium text-ink-2">{Number(line.inventoryItem.parLevel).toFixed(2)} {line.selectedUom}</span></span>
                        )}
                        {line.inventoryItem.lastCountQty != null && (
                          <span>Last: <span className="font-medium text-ink-2">{convertBaseToCountUom(Number(line.inventoryItem.lastCountQty), line.selectedUom, line.inventoryItem).toFixed(2)} {line.selectedUom}</span></span>
                        )}
                      </div>
                    )}
                  </>
                )
              })()}
              <div className="flex items-center gap-2 mb-2">
                <button
                  onClick={() => setInputQty(v => Math.max(0, Math.round((v - 1) * 100) / 100))}
                  className="w-12 h-12 rounded-[10px] bg-bg-2 border border-line flex items-center justify-center shrink-0"
                >
                  <Minus size={18} className="text-ink-2" />
                </button>
                <input
                  type="number"
                  value={inputQty}
                  onChange={e => setInputQty(parseFloat(e.target.value) || 0)}
                  className="flex-1 min-w-0 h-12 text-center text-2xl font-bold border-2 border-gold rounded-[10px] focus:outline-none text-ink"
                  min={0} step={0.1}
                />
                <button
                  onClick={() => setInputQty(v => Math.round((v + 1) * 100) / 100)}
                  className="w-12 h-12 rounded-[10px] bg-bg-2 border border-line flex items-center justify-center shrink-0"
                >
                  <Plus size={18} className="text-ink-2" />
                </button>
              </div>
              <div className="text-center font-mono text-[11px] text-ink-3 mb-3">{line.selectedUom}</div>
              <div className="flex gap-2">
                <button
                  onClick={() => confirmLine(line, inputQty)}
                  className="flex-1 h-11 bg-ink text-paper rounded-[10px] font-semibold text-sm flex items-center justify-center gap-1.5"
                >
                  <Check size={15} className="text-gold" /> Confirm
                </button>
                <button
                  onClick={() => confirmLine(line, 0)}
                  className="px-3 h-11 border border-amber-200 bg-amber-50 text-amber-700 rounded-[10px] text-xs font-semibold"
                  title="Mark out of stock"
                >
                  Out of stock
                </button>
                <button
                  onClick={() => skipLine(line)}
                  className="px-4 h-11 border border-line rounded-[10px] text-sm text-ink-3 flex items-center gap-1.5"
                >
                  <SkipForward size={13} /> Skip
                </button>
              </div>
            </div>
          )}
        </div>
      )
    }

    const DesktopItems = () => (
      <>
        {(catFilter || !grouped) ? (
          filteredLines.length === 0 ? <Empty /> : filteredLines.map(renderLine)
        ) : (
          Object.keys(grouped).length === 0 ? <Empty /> :
          Object.entries(grouped)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([cat, lines]) => {
              const catDone = lines.filter(l => l.countedQty !== null || l.skipped).length
              return (
                <div key={cat} className="mb-2">
                  <div className="flex items-center gap-2 px-4 py-2">
                    <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-3">{cat}</span>
                    <span className="font-mono text-[10.5px] text-ink-4">{catDone}/{lines.length}</span>
                    <div className="flex-1 max-w-[80px] h-1 bg-bg-2 rounded-full ml-1">
                      <div className="h-1 bg-gold rounded-full"
                        style={{ width: `${lines.length > 0 ? (catDone / lines.length) * 100 : 0}%` }} />
                    </div>
                  </div>
                  {lines.map(renderLine)}
                </div>
              )
            })
        )}
      </>
    )

    const sidebarNavBtn = (active: boolean, onClick: () => void, label: React.ReactNode) => (
      <button onClick={onClick}
        className={`w-full text-left px-3 py-2 rounded-[8px] text-[13px] transition-colors ${active ? 'bg-ink text-paper font-medium' : 'text-ink-2 hover:bg-bg-2'}`}>
        {label}
      </button>
    )

    return (
      <div>
        {toast && <Toast msg={toast} onDone={() => setToast(null)} />}

        {editingItemId && (
          <InventoryItemDrawer
            itemId={editingItemId}
            onClose={() => setEditingItemId(null)}
            onUpdated={async () => {
              if (active) {
                const refreshed = await loadSession(active.id)
                if (refreshed) setActive(refreshed)
              }
            }}
          />
        )}

        {/* ── Sticky top bar ─────────────────────────────────────────────────── */}
        <div className="sticky top-0 z-20 bg-paper border-b border-line px-4 py-3 flex items-center gap-3 -mx-4 sm:-mx-6 md:-mx-8 px-4 sm:px-6 md:px-8">
          <button onClick={backFromCount} className="-ml-1 p-1 text-ink-3 hover:text-ink transition-colors">
            <ArrowLeft size={20} />
          </button>
          <div className="flex-1 min-w-0">
            <span className="text-[13.5px] font-medium text-ink tracking-[-0.01em] truncate block">{active.label}</span>
            <span className="font-mono text-[10.5px] text-ink-3 hidden md:block">{active.countedBy} · {fmtDate(active.sessionDate)}</span>
          </div>
          <span className="shrink-0 bg-bg-2 text-ink-2 border border-line rounded-full px-3 py-1 font-mono text-[11px] whitespace-nowrap">
            {counted} / {total}
          </span>
          <button
            onClick={handleSync}
            disabled={syncing}
            title="Sync with inventory — adds items created after this session started"
            className="shrink-0 flex items-center gap-1.5 border border-line text-ink-2 font-mono text-[11px] px-3 py-1.5 rounded-[8px] hover:border-ink-3 whitespace-nowrap disabled:opacity-50 transition-colors"
          >
            <RefreshCw size={13} className={syncing ? 'animate-spin' : ''} />
            <span className="hidden sm:inline">Sync</span>
          </button>
          <button
            onClick={openAddItem}
            className="shrink-0 flex items-center gap-1.5 border border-line text-ink-2 font-mono text-[11px] px-3 py-1.5 rounded-[8px] hover:border-ink-3 whitespace-nowrap transition-colors"
          >
            <Plus size={13} />
            <span className="hidden sm:inline">Add item</span>
          </button>
          <button
            onClick={() => setView('review')}
            className="shrink-0 bg-ink text-paper text-[12.5px] font-medium px-3 py-1.5 rounded-[8px] hover:bg-ink-2 whitespace-nowrap transition-colors"
          >
            Review &amp; finish
          </button>
        </div>

        {/* ── Add Item Modal ─────────────────────────────────────────────────── */}
        {showAddItem && (
          <div
            className="fixed inset-0 z-50 flex items-start justify-center p-4 overflow-y-auto"
            onMouseDown={(e) => { (e.currentTarget as HTMLElement).dataset.mdown = String(e.target === e.currentTarget) }}
            onClick={(e) => { if (e.target === e.currentTarget && (e.currentTarget as HTMLElement).dataset.mdown === 'true') setShowAddItem(false) }}
          >
            <div className="absolute inset-0 bg-black/30" />
            <div className="relative bg-white rounded-xl p-6 w-full max-w-lg shadow-xl my-8" onClick={e => e.stopPropagation()}>
              <h3 className="font-semibold mb-4 text-lg">Add Inventory Item</h3>
              <form onSubmit={handleAddItem} className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2">
                    <label className="block text-xs font-medium text-gray-600 mb-1">Item Name *</label>
                    <input required value={addItemForm.itemName} onChange={e => setAddItemForm(f => ({ ...f, itemName: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Category</label>
                    <select value={addItemForm.category} onChange={e => setAddItemForm(f => ({ ...f, category: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold">
                      {addItemCategories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Supplier</label>
                    <select value={addItemForm.supplierId} onChange={e => setAddItemForm(f => ({ ...f, supplierId: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold">
                      <option value="">None</option>
                      {addItemSuppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Storage Area</label>
                    <select value={addItemForm.storageAreaId} onChange={e => setAddItemForm(f => ({ ...f, storageAreaId: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold">
                      <option value="">None</option>
                      {addItemAreas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Purchase Unit</label>
                    <select required value={addItemForm.purchaseUnit} onChange={e => setAddItemForm(f => ({ ...f, purchaseUnit: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold bg-white">
                      {PURCHASE_UNITS.map(u => <option key={u}>{u}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Qty per Purchase Unit</label>
                    <input type="number" required value={addItemForm.qtyPerPurchaseUnit} onChange={e => setAddItemForm(f => ({ ...f, qtyPerPurchaseUnit: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" step="any" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Purchase Price ($)</label>
                    <input type="number" required value={addItemForm.purchasePrice} onChange={e => setAddItemForm(f => ({ ...f, purchasePrice: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" step="any" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Base Unit</label>
                    <select value={addItemForm.baseUnit} onChange={e => setAddItemForm(f => ({ ...f, baseUnit: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold">
                      {BASE_UNITS.map(u => <option key={u}>{u}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Conversion Factor</label>
                    <input type="number" required value={addItemForm.conversionFactor} onChange={e => setAddItemForm(f => ({ ...f, conversionFactor: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" step="any" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Stock On Hand</label>
                    <input type="number" value={addItemForm.stockOnHand} onChange={e => setAddItemForm(f => ({ ...f, stockOnHand: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" step="any" />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs font-medium text-gray-600 mb-1">Location</label>
                    <input value={addItemForm.location} onChange={e => setAddItemForm(f => ({ ...f, location: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                  </div>
                </div>
                <div className="bg-gold/10 rounded-lg p-3 text-sm">
                  <span className="text-gold font-medium">Price per base unit preview: </span>
                  <span className="font-bold text-gold">{formatUnitPrice(addItemPricePreview)} / {addItemForm.baseUnit}</span>
                </div>
                <div className="flex gap-2 pt-2">
                  <button type="button" onClick={() => setShowAddItem(false)} className="flex-1 border border-gray-200 rounded-lg py-2 text-sm hover:bg-gray-50">Cancel</button>
                  <button type="submit" disabled={addItemSaving} className="flex-1 bg-gold text-white rounded-lg py-2 text-sm hover:bg-[#a88930] disabled:opacity-60">
                    {addItemSaving ? 'Adding…' : 'Add Item'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* ── Progress bar ───────────────────────────────────────────────────── */}
        <div className="h-1 bg-line -mx-4 sm:-mx-6 md:-mx-8">
          <div
            className="h-1 bg-gold transition-all duration-300"
            style={{ width: `${total > 0 ? (counted / total) * 100 : 0}%` }}
          />
        </div>

        {/* ── Offline banner ─────────────────────────────────────────────────── */}
        {(isOffline || offlineSyncing) && (
          <div className={`flex items-center gap-2 px-4 py-2 font-mono text-[11px] font-medium ${
            offlineSyncing ? 'bg-gold-soft text-gold-2' : 'bg-[#fffbeb] text-[#78350f]'
          }`}>
            <WifiOff size={13} className="shrink-0" />
            {offlineSyncing
              ? 'Syncing offline changes…'
              : `Offline — counts are saved locally${pendingCount > 0 ? ` (${pendingCount} pending)` : ''}`}
          </div>
        )}

        {/* ── Search bar ─────────────────────────────────────────────────────── */}
        <div className="sticky top-[57px] z-10 bg-paper border-b border-line px-4 py-2 -mx-4 sm:-mx-6 md:-mx-8 px-4 sm:px-6 md:px-8">
          <div className="relative max-w-lg">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" />
            <input
              type="text"
              placeholder="Search items…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleScan(searchQuery) }}
              className="w-full pl-8 pr-8 py-2 text-[13px] text-ink bg-bg-2 border border-line rounded-[9px] placeholder:text-ink-4 focus:outline-none focus:border-ink-3 focus:bg-paper transition-colors"
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-4 hover:text-ink-2">
                <X size={14} />
              </button>
            )}
          </div>
        </div>

        {/* ════════════════════════════════════════
            DESKTOP LAYOUT — sidebar + items
        ════════════════════════════════════════ */}
        <div className="hidden md:grid grid-cols-[220px_1fr] gap-6 pt-4 pb-8">
          {/* ── Left sidebar ─────────────────────────────────────────── */}
          <div className="sticky top-[57px] self-start space-y-5 max-h-[calc(100vh-80px)] overflow-y-auto pb-4 pr-1">

            {/* Progress summary */}
            <div className="bg-paper rounded-xl border border-line p-3 space-y-2">
              <div className="flex justify-between items-center">
                <span className="font-mono text-[10.5px] text-ink-3 tracking-wide">PROGRESS</span>
                <span className="font-mono text-[11px] text-ink-2">{counted}/{total} · {total > 0 ? Math.round((counted/total)*100) : 0}%</span>
              </div>
              <div className="h-1.5 bg-bg-2 rounded-full">
                <div className="h-1.5 bg-gold rounded-full transition-all duration-300"
                  style={{ width: `${total > 0 ? (counted/total)*100 : 0}%` }} />
              </div>
              <div className="grid grid-cols-2 gap-1 pt-1 font-mono text-[10.5px] text-ink-3">
                <span>{active.lines?.filter(l => l.countedQty !== null && !l.skipped).length ?? 0} counted</span>
                <span>{active.lines?.filter(l => l.skipped).length ?? 0} skipped</span>
              </div>
            </div>

            {/* Category filter */}
            <div>
              <p className="font-mono text-[10px] text-ink-4 uppercase tracking-[0.06em] mb-1.5 px-1">Category</p>
              <div className="space-y-0.5">
                {sidebarNavBtn(catFilter === null, () => setCatFilter(null),
                  <span className="flex items-center justify-between">All items <span className="font-mono text-[11px] opacity-50">{active.lines?.length ?? 0}</span></span>
                )}
                {categories.map(([cat, n]) =>
                  sidebarNavBtn(catFilter === cat, () => setCatFilter(catFilter === cat ? null : cat),
                    <span className="flex items-center justify-between">{cat} <span className="font-mono text-[11px] opacity-50">{n}</span></span>
                  )
                )}
              </div>
            </div>

            {/* Location filter */}
            {locations.length > 0 && (
              <div>
                <p className="font-mono text-[10px] text-ink-4 uppercase tracking-[0.06em] mb-1.5 px-1">Location</p>
                <div className="space-y-0.5">
                  {sidebarNavBtn(locFilter === null, () => setLocFilter(null), 'All locations')}
                  {locations.map(loc => sidebarNavBtn(locFilter === loc.id, () => setLocFilter(locFilter === loc.id ? null : loc.id), loc.name))}
                </div>
              </div>
            )}

            {/* Status filter */}
            <div>
              <p className="font-mono text-[10px] text-ink-4 uppercase tracking-[0.06em] mb-1.5 px-1">Status</p>
              <div className="space-y-0.5">
                {(['all', 'uncounted', 'counted', 'skipped'] as const).map(f =>
                  sidebarNavBtn(statusFilter === f, () => setStatusFilter(f),
                    f === 'all' ? 'All' : f === 'uncounted' ? 'Uncounted' : f === 'counted' ? 'Counted' : 'Skipped'
                  )
                )}
              </div>
            </div>

            {/* Clear filters */}
            {(catFilter || locFilter || statusFilter !== 'all') && (
              <button
                onClick={() => { setCatFilter(null); setLocFilter(null); setStatusFilter('all') }}
                className="w-full font-mono text-[11px] text-ink-3 hover:text-ink-2 py-1.5 border border-line rounded-[8px] transition-colors"
              >
                Clear filters
              </button>
            )}
          </div>

          {/* ── Right: item list ─────────────────────────────────────── */}
          <div className="pt-1">
            {DesktopItems()}
          </div>
        </div>

        {/* ════════════════════════════════════════
            MOBILE LAYOUT
        ════════════════════════════════════════ */}
        {/* ── Mobile filter row ──────────────────────────────────────────────── */}
        <div className="flex md:hidden items-center gap-2 px-3 pt-2 pb-1.5">
          {(['all', 'uncounted', 'counted', 'skipped'] as const).map(f => (
            <Pill key={f} active={statusFilter === f} onClick={() => setStatusFilter(f)}>
              {f === 'all' ? 'All' : f === 'uncounted' ? 'Uncounted' : f === 'counted' ? 'Counted' : 'Skipped'}
            </Pill>
          ))}
          <div className="flex-1" />
          <button
            onClick={() => setShowCountFilterSheet(true)}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
              catFilter || locFilter
                ? 'bg-gold/10 text-gold border-gold/30'
                : 'bg-paper text-ink-2 border-line'
            }`}
          >
            Filter{(catFilter ? 1 : 0) + (locFilter ? 1 : 0) > 0 && ` · ${(catFilter ? 1 : 0) + (locFilter ? 1 : 0)}`}
          </button>
        </div>

        {/* ── Mobile filter bottom sheet ──────────────────────────────────────── */}
        {showCountFilterSheet && (
          <div
            className="fixed inset-0 z-50 flex items-end md:hidden"
            onMouseDown={(e) => { (e.currentTarget as HTMLElement).dataset.mdown = String(e.target === e.currentTarget) }}
            onClick={(e) => { if (e.target === e.currentTarget && (e.currentTarget as HTMLElement).dataset.mdown === 'true') setShowCountFilterSheet(false) }}
          >
            <div className="absolute inset-0 bg-black/40" />
            <div className="relative bg-paper w-full rounded-t-2xl p-5 pb-8" onClick={e => e.stopPropagation()}>
              <div className="w-9 h-1 bg-line rounded-full mx-auto mb-4" />
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-[15px] text-ink tracking-[-0.02em]">Filter</h3>
                <button onClick={() => setShowCountFilterSheet(false)}><X size={18} className="text-ink-4" /></button>
              </div>
              <div className="space-y-4">
                <div>
                  <div className="font-mono text-[10px] text-ink-4 uppercase tracking-[0.06em] mb-2">Category</div>
                  <div className="flex flex-wrap gap-2">
                    <button onClick={() => setCatFilter(null)}
                      className={`px-3 py-1.5 rounded-full text-[13px] border transition-colors ${catFilter === null ? 'bg-ink text-paper border-ink' : 'bg-paper text-ink-2 border-line'}`}
                    >All</button>
                    {categories.map(([cat]) => (
                      <button key={cat} onClick={() => setCatFilter(cat)}
                        className={`px-3 py-1.5 rounded-full text-[13px] border transition-colors ${catFilter === cat ? 'bg-ink text-paper border-ink' : 'bg-paper text-ink-2 border-line'}`}
                      >{cat}</button>
                    ))}
                  </div>
                </div>
                {locations.length > 0 && (
                  <div>
                    <div className="font-mono text-[10px] text-ink-4 uppercase tracking-[0.06em] mb-2">Location</div>
                    <div className="flex flex-wrap gap-2">
                      <button onClick={() => setLocFilter(null)}
                        className={`px-3 py-1.5 rounded-full text-[13px] border transition-colors ${locFilter === null ? 'bg-ink text-paper border-ink' : 'bg-paper text-ink-2 border-line'}`}
                      >All</button>
                      {locations.map(loc => (
                        <button key={loc.id} onClick={() => setLocFilter(locFilter === loc.id ? null : loc.id)}
                          className={`px-3 py-1.5 rounded-full text-[13px] border transition-colors ${locFilter === loc.id ? 'bg-ink text-paper border-ink' : 'bg-paper text-ink-2 border-line'}`}
                        >{loc.name}</button>
                      ))}
                    </div>
                  </div>
                )}
                <button
                  onClick={() => { setCatFilter(null); setLocFilter(null); setShowCountFilterSheet(false) }}
                  className="w-full py-2.5 border border-line rounded-[10px] text-sm text-ink-2 font-medium"
                >Clear filters</button>
              </div>
            </div>
          </div>
        )}

        {/* ── Mobile items list ──────────────────────────────────────────────── */}
        <div className="md:hidden px-3 pt-1 pb-28 space-y-1.5">
          {(catFilter || !grouped) ? (
            filteredLines.length === 0 ? <Empty /> : filteredLines.map(renderMobileLine)
          ) : (
            Object.keys(grouped).length === 0 ? <Empty /> :
            Object.entries(grouped)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([cat, lines]) => {
                const catDone = lines.filter(l => l.countedQty !== null || l.skipped).length
                return (
                  <div key={`mc-${cat}`}>
                    <div className="flex items-center gap-2 py-2 px-1">
                      <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-3">{cat}</span>
                      <span className="font-mono text-[10.5px] text-ink-4">{catDone}/{lines.length}</span>
                      <div className="flex-1 max-w-[60px] h-1 bg-bg-2 rounded-full">
                        <div className="h-1 bg-gold rounded-full"
                          style={{ width: `${lines.length > 0 ? (catDone / lines.length) * 100 : 0}%` }} />
                      </div>
                    </div>
                    {lines.map(renderMobileLine)}
                  </div>
                )
              })
          )}
        </div>
      </div>
    )
  }

  // ════════════════════════════════════════════════════════════════════════════
  // VIEW C — REVIEW & FINALIZE
  // ════════════════════════════════════════════════════════════════════════════
  if (view === 'review' && active) {
    const lines        = active.lines ?? []
    const countedLines = lines.filter(l => l.countedQty !== null && !l.skipped)
    const flagged      = lines.filter(l =>
      l.variancePct !== null &&
      hasReliableVariance(Number(l.expectedQty), l.selectedUom, l.inventoryItem) &&
      Math.abs(Number(l.variancePct)) > LARGE_VARIANCE_PCT
    )
    const totalValue   = countedLines.reduce((s, l) => {
      const base = convertCountQtyToBase(Number(l.countedQty), l.selectedUom, l.inventoryItem)
      return s + base * Number(l.priceAtCount)
    }, 0)
    const isFinalized  = active.status === 'FINALIZED'
    const sorted       = [...countedLines].sort(
      (a, b) => Math.abs(Number(b.varianceCost ?? 0)) - Math.abs(Number(a.varianceCost ?? 0))
    )

    return (
      <div className="max-w-4xl">
        {toast && <Toast msg={toast} onDone={() => setToast(null)} />}

        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={() => { if (isFinalized) { setView('list'); setActive(null) } else setView('count') }}
            className="-ml-1 p-1 text-ink-3 hover:text-ink transition-colors"
          >
            <ArrowLeft size={20} />
          </button>
          <div className="flex-1">
            <h1 className="text-[18px] font-semibold text-ink tracking-[-0.03em]">Review count</h1>
            <p className="font-mono text-[10.5px] text-ink-3 mt-0.5">{active.label} · {active.countedBy}</p>
          </div>
          {!isFinalized && (
            <button onClick={() => setView('count')} className="font-mono text-[11px] text-ink-3 hover:text-ink shrink-0">
              ← Back to counting
            </button>
          )}
        </div>

        {/* Stats — mobile compact strip */}
        <div className="flex sm:hidden gap-2 mb-4">
          {[
            { val: countedLines.length.toString(),   label: 'Counted',  cls: 'bg-bg-2 text-ink'   },
            { val: flagged.length.toString(),         label: 'Flagged',  cls: flagged.length > 0 ? 'bg-amber-50 text-amber-700' : 'bg-bg-2 text-ink-3' },
            { val: formatCurrency(totalValue),        label: 'Value',    cls: 'bg-gold-soft text-gold-2' },
          ].map(s => (
            <div key={s.label} className={`flex-1 rounded-xl py-2 px-3 text-center ${s.cls}`}>
              <div className="text-base font-semibold leading-tight">{s.val}</div>
              <div className="font-mono text-[10px] mt-0.5 opacity-70">{s.label}</div>
            </div>
          ))}
        </div>

        {/* Stats — desktop */}
        <div className="hidden sm:grid grid-cols-3 gap-3 mb-6">
          {[
            { val: countedLines.length.toString(), label: 'Items counted' },
            { val: flagged.length.toString(), label: `Flagged (>${LARGE_VARIANCE_PCT}%)`, warn: flagged.length > 0 },
            { val: formatCurrency(totalValue), label: 'Total value' },
          ].map(s => (
            <div key={s.label} className="bg-paper border border-line rounded-xl p-4 text-center">
              <div className={`text-2xl font-semibold tracking-[-0.03em] ${(s as {warn?: boolean}).warn ? 'text-amber-600' : 'text-ink'}`}>{s.val}</div>
              <div className="font-mono text-[10.5px] text-ink-3 mt-1">{s.label}</div>
            </div>
          ))}
        </div>

        {/* Variance cards — mobile */}
        {sorted.length > 0 && (
          <div className="block sm:hidden space-y-2 mb-24">
            {sorted.map(l => {
              const vPct     = Number(l.variancePct ?? 0)
              const vCost    = Number(l.varianceCost ?? 0)
              const reliable = hasReliableVariance(Number(l.expectedQty), l.selectedUom, l.inventoryItem)
              const large    = reliable && Math.abs(vPct) > LARGE_VARIANCE_PCT
              return (
                <div key={l.id} className="bg-paper rounded-xl border border-line overflow-hidden flex">
                  {large && <div className="w-1 shrink-0 bg-gold" />}
                  <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 px-3 py-2.5 border-b border-line">
                    {large && <AlertCircle size={13} className="text-gold shrink-0" />}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-ink truncate">{l.inventoryItem.itemName}</div>
                      <div className="font-mono text-[10.5px] text-ink-4">{l.inventoryItem.category}</div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 divide-x divide-line">
                    <div className="px-3 py-2">
                      <div className="font-mono text-[9.5px] text-ink-4 uppercase tracking-[0.06em] mb-0.5">Expected</div>
                      <div className="text-sm text-ink-2">{convertBaseToCountUom(Number(l.expectedQty), l.selectedUom, l.inventoryItem).toFixed(1)} {l.selectedUom}</div>
                    </div>
                    <div className="px-3 py-2">
                      <div className="font-mono text-[9.5px] text-ink-4 uppercase tracking-[0.06em] mb-0.5">Counted</div>
                      <div className="text-sm font-semibold text-ink">{Number(l.countedQty).toFixed(1)} {l.selectedUom}</div>
                    </div>
                    <div className="px-3 py-2 border-t border-line">
                      <div className="font-mono text-[9.5px] text-ink-4 uppercase tracking-[0.06em] mb-0.5">Variance</div>
                      <div className={`text-sm font-semibold ${reliable ? varColor(vPct) : 'text-ink-4'}`}>
                        {reliable ? `${vPct >= 0 ? '+' : ''}${vPct.toFixed(1)}%` : '—'}
                      </div>
                    </div>
                    <div className="px-3 py-2 border-t border-line">
                      <div className="font-mono text-[9.5px] text-ink-4 uppercase tracking-[0.06em] mb-0.5">Cost impact</div>
                      <div className={`text-sm font-semibold ${vCost >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {vCost >= 0 ? '+' : ''}{formatCurrency(vCost)}
                      </div>
                    </div>
                  </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Variance table — desktop */}
        {sorted.length > 0 && (
          <div className="hidden sm:block bg-paper rounded-xl border border-line overflow-hidden mb-6">
            <div className="px-4 py-3 border-b border-line">
              <h2 className="font-mono text-[11px] text-ink-3 uppercase tracking-[0.06em]">Variance breakdown</h2>
            </div>
            <div className="divide-y divide-line">
              <div className="px-4 py-2 grid grid-cols-[1fr_80px_80px_70px_90px] gap-2 font-mono text-[10px] text-ink-4 uppercase tracking-[0.05em]">
                <span>Item</span>
                <span className="text-right">Expected</span>
                <span className="text-right">Counted</span>
                <span className="text-right">Var %</span>
                <span className="text-right">Cost impact</span>
              </div>
              {sorted.map(l => {
                const vPct     = Number(l.variancePct ?? 0)
                const vCost    = Number(l.varianceCost ?? 0)
                const reliable = hasReliableVariance(Number(l.expectedQty), l.selectedUom, l.inventoryItem)
                const large    = reliable && Math.abs(vPct) > LARGE_VARIANCE_PCT
                return (
                  <div key={l.id}
                    className={`px-4 py-2.5 grid grid-cols-[1fr_80px_80px_70px_90px] gap-2 items-center ${large ? 'bg-gold-soft/40' : ''}`}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        {large && <AlertCircle size={12} className="text-gold shrink-0" />}
                        <span className="text-[13px] text-ink truncate">{l.inventoryItem.itemName}</span>
                      </div>
                      <span className="font-mono text-[10.5px] text-ink-4">{l.inventoryItem.category}</span>
                    </div>
                    <span className="text-right text-[13px] text-ink-2">{convertBaseToCountUom(Number(l.expectedQty), l.selectedUom, l.inventoryItem).toFixed(1)} {l.selectedUom}</span>
                    <span className="text-right text-[13px] font-medium text-ink">{Number(l.countedQty).toFixed(1)} {l.selectedUom}</span>
                    <span className={`text-right text-[13px] font-semibold ${reliable ? varColor(vPct) : 'text-ink-4'}`}>
                      {reliable ? `${vPct >= 0 ? '+' : ''}${vPct.toFixed(1)}%` : '—'}
                    </span>
                    <span className={`text-right text-[13px] font-semibold ${vCost >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {vCost >= 0 ? '+' : ''}{formatCurrency(vCost)}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Footer — mobile fixed bar */}
        {!isFinalized && (
          <div className="fixed sm:hidden bottom-20 inset-x-0 bg-paper border-t border-line px-4 py-3 z-30">
            <div className="flex gap-3">
              <button onClick={() => setView('count')}
                className="flex-1 py-3 border border-line rounded-[10px] text-[13px] font-medium text-ink-2"
              >
                ← Back
              </button>
              <button onClick={handleFinalize} disabled={finalizing}
                className="flex-[2] py-3 bg-ink text-paper rounded-[10px] text-[13px] font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50"
              >
                <Check size={15} className="text-gold" /> {finalizing ? 'Updating…' : 'Approve & update'}
              </button>
            </div>
          </div>
        )}

        {/* Footer — desktop */}
        {!isFinalized ? (
          <div className="hidden sm:flex gap-3">
            <button onClick={() => setView('count')}
              className="flex-1 py-3 border border-line rounded-[10px] text-[13px] text-ink-2 hover:bg-bg-2 font-medium flex items-center justify-center gap-1.5 transition-colors"
            >
              <ArrowLeft size={16} /> Back to counting
            </button>
            <button onClick={handleFinalize} disabled={finalizing}
              className="flex-1 py-3 bg-ink text-paper rounded-[10px] text-[13px] font-semibold hover:bg-ink-2 disabled:opacity-50 flex items-center justify-center gap-1.5 transition-colors"
            >
              <Check size={16} className="text-gold" />
              {finalizing ? 'Updating…' : 'Approve & update inventory'}
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-xl px-4 py-3">
            <CheckCircle2 size={16} className="text-green-600 shrink-0" />
            <span className="text-sm text-green-800 font-medium">
              Finalized {active.finalizedAt ? new Date(active.finalizedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}
            </span>
          </div>
        )}
      </div>
    )
  }

  return null
}

// ── Small reusable components ─────────────────────────────────────────────────

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 rounded-full px-3 py-1 font-mono text-[11px] font-medium transition-colors ${
        active ? 'bg-ink text-paper' : 'bg-bg-2 text-ink-2 hover:bg-line'
      }`}
    >
      {children}
    </button>
  )
}

function Empty() {
  return <div className="text-center py-12 font-mono text-[12px] text-ink-4">No items match this filter</div>
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


---

## `src/app/invoices/page.tsx`

```tsx
'use client'
import { useState, useCallback, useEffect, useRef } from 'react'
import dynamic from 'next/dynamic'
import { Mail, Clock } from 'lucide-react'
import { InvoiceKpiStripV2 } from '@/components/invoices/InvoiceKpiStripV2'
import { InvoiceListV2 } from '@/components/invoices/InvoiceListV2'
import { InboxViewV2 } from '@/components/invoices/InboxViewV2'
import { InboxSubNav } from '@/components/invoices/InboxSubNav'
import { PageHead } from '@/components/layout/PageHead'
import { SessionSummary, SessionStatus } from '@/components/invoices/types'
import { useRc } from '@/contexts/RevenueCenterContext'
import { useDrawer } from '@/contexts/DrawerContext'
import { useNotifications } from '@/contexts/NotificationContext'
import { isNative } from '@/lib/capacitor'
import { useNativeScan } from '@/hooks/useNativeScan'

const InvoiceDrawer = dynamic<{
  sessionId: string | null
  onClose: () => void
  onApproveOrReject: () => void
  onNavigate?: (id: string) => void
  allSessions?: SessionSummary[]
}>(
  () => import('@/components/invoices/v2/InvoiceReviewDrawer').then(m => ({ default: m.InvoiceReviewDrawer })),
  { ssr: false, loading: () => null }
)

const InvoiceUploadModal = dynamic(
  () => import('@/components/invoices/InvoiceUploadModal').then(m => ({ default: m.InvoiceUploadModal })),
  { ssr: false, loading: () => null }
)

export default function InvoicesPage() {
  const { activeRcId, activeRc } = useRc()
  const { setDrawerOpen } = useDrawer()
  const { push } = useNotifications()
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [showUpload, setShowUpload] = useState(false)
  const [kpiRefreshKey, setKpiRefreshKey] = useState(0)
  const [view, setView] = useState<'inbox' | 'history'>('inbox')

  // Track previous statuses to detect PROCESSING → REVIEW / APPROVING → APPROVED transitions
  const prevStatusesRef = useRef<Map<string, SessionStatus>>(new Map())

  useEffect(() => {
    setDrawerOpen(selectedSessionId !== null)
    return () => setDrawerOpen(false)
  }, [selectedSessionId, setDrawerOpen])

  const fetchSessions = useCallback(async () => {
    try {
      const p = new URLSearchParams()
      if (activeRcId) {
        p.set('rcId', activeRcId)
        if (activeRc?.isDefault) p.set('isDefault', 'true')
      }
      const qs = p.toString()
      const data: SessionSummary[] = await fetch(`/api/invoices/sessions${qs ? `?${qs}` : ''}`).then(r => r.json())

      // Detect PROCESSING → REVIEW and APPROVING → APPROVED transitions
      const prev = prevStatusesRef.current
      for (const s of data) {
        if (prev.get(s.id) === 'PROCESSING' && s.status === 'REVIEW') {
          const sid = s.id
          push({
            type: 'invoice_ready',
            sessionId: sid,
            supplierName: s.supplierName,
            invoiceNumber: s.invoiceNumber,
            actionLabel: 'Review',
            onAction: () => setSelectedSessionId(sid),
          })
        }
        if (prev.get(s.id) === 'APPROVING' && s.status === 'APPROVED') {
          const sid = s.id
          push({
            type: 'invoice_applied',
            sessionId: sid,
            supplierName: s.supplierName,
            invoiceNumber: s.invoiceNumber,
            actionLabel: 'View',
            onAction: () => setSelectedSessionId(sid),
          })
        }
      }

      // Update previous statuses map
      const next = new Map<string, SessionStatus>()
      for (const s of data) next.set(s.id, s.status)
      prevStatusesRef.current = next

      setSessions(data)
      return data
    } catch {
      // silent — keeps existing sessions on screen, polling continues
    }
  }, [activeRcId, activeRc, push])

  const handleScanComplete = useCallback(() => {
    fetchSessions()
  }, [fetchSessions])

  const { triggerScan, isScanning, scanError, clearError } = useNativeScan({
    activeRcId,
    onComplete: handleScanComplete,
  })

  useEffect(() => { fetchSessions() }, [fetchSessions])

  // Sequential poll via refs so the timer never resets mid-wait.
  // Using refs instead of state deps prevents the interval from being
  // cancelled and restarted on every sessions update (which caused the
  // timer to keep resetting before it could fire on Capacitor WebView).
  const fetchRef    = useRef(fetchSessions)
  const sessionsRef = useRef(sessions)
  fetchRef.current    = fetchSessions
  sessionsRef.current = sessions

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const schedule = () => {
      const hasTransient = sessionsRef.current.some(s =>
        s.status === 'UPLOADING' || s.status === 'PROCESSING' || s.status === 'APPROVING'
      )
      timer = setTimeout(async () => {
        await fetchRef.current()
        schedule()
      }, hasTransient ? 3000 : 15000)
    }
    schedule()
    return () => clearTimeout(timer)
  }, []) // runs once; uses refs for always-fresh values

  // Refresh whenever the tab regains focus (covers status changes made elsewhere)
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') fetchSessions() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [fetchSessions])

  const handleApproveOrReject = useCallback(() => {
    fetchSessions()
    setKpiRefreshKey(k => k + 1)
  }, [fetchSessions])

  const handleDelete = useCallback(async (id: string, _status: SessionStatus): Promise<void> => {
    await fetch(`/api/invoices/sessions/${id}`, { method: 'DELETE' })
    fetchSessions()
    setKpiRefreshKey(k => k + 1)
    if (selectedSessionId === id) setSelectedSessionId(null)
  }, [selectedSessionId, fetchSessions])

  const handleBulkDelete = useCallback(async (ids: string[]): Promise<void> => {
    await fetch('/api/invoices/sessions', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    })
    fetchSessions()
    setKpiRefreshKey(k => k + 1)
    if (selectedSessionId && ids.includes(selectedSessionId)) setSelectedSessionId(null)
  }, [selectedSessionId, fetchSessions])

  const handleRetry = useCallback(async (id: string) => {
    fetch(`/api/invoices/sessions/${id}/process`, { method: 'POST' }).catch(() => {})
    await fetchSessions()
  }, [fetchSessions])

  const queueCount = sessions.filter(s =>
    s.status === 'REVIEW' || s.status === 'PROCESSING' || s.status === 'UPLOADING' ||
    s.status === 'APPROVING' || s.status === 'ERROR'
  ).length

  return (
    <>
    <InboxSubNav />
    <div className="p-4 md:p-6 md:px-8 max-w-7xl mx-auto w-full">

      <PageHead
        crumbs={<><Mail size={12} /> INBOX / INVOICES</>}
        title="Invoices"
        sub={
          view === 'inbox'
            ? <>OCR → review → approve. <b>{queueCount}</b> {queueCount === 1 ? 'session' : 'sessions'} in queue.</>
            : <>All invoice sessions — sortable, searchable, filterable by status.</>
        }
        actions={
          <div className="inline-flex bg-paper border border-line rounded-[9px] p-[3px]">
            <button
              onClick={() => setView('inbox')}
              className={`font-mono text-[11px] px-3 py-1.5 rounded-[6px] tracking-[0.02em] uppercase transition-colors inline-flex items-center gap-1.5 ${
                view === 'inbox' ? 'bg-ink text-paper' : 'text-ink-3 hover:text-ink-2'
              }`}
            >
              <Mail size={11} className={view === 'inbox' ? 'text-gold' : ''} /> Inbox
              {queueCount > 0 && (
                <span className={`font-mono text-[10px] px-1.5 rounded-full leading-tight ${view === 'inbox' ? 'bg-gold text-ink' : 'bg-gold-soft text-gold-2'}`}>{queueCount}</span>
              )}
            </button>
            <button
              onClick={() => setView('history')}
              className={`font-mono text-[11px] px-3 py-1.5 rounded-[6px] tracking-[0.02em] uppercase transition-colors inline-flex items-center gap-1.5 ${
                view === 'history' ? 'bg-ink text-paper' : 'text-ink-3 hover:text-ink-2'
              }`}
            >
              <Clock size={11} className={view === 'history' ? 'text-gold' : ''} /> History
            </button>
          </div>
        }
      />

      <InvoiceKpiStripV2
        refreshKey={kpiRefreshKey}
        activeRcId={activeRcId}
        isDefault={activeRc?.isDefault ?? false}
      />

      {view === 'inbox' ? (
        <InboxViewV2
          sessions={sessions}
          onSelectSession={setSelectedSessionId}
          onUploadClick={() => setShowUpload(true)}
          onScanClick={isNative() ? triggerScan : undefined}
        />
      ) : (
        <InvoiceListV2
          sessions={sessions}
          onSelect={setSelectedSessionId}
          onUploadClick={() => setShowUpload(true)}
          onScanClick={isNative() ? triggerScan : undefined}
          onDelete={handleDelete}
          onBulkDelete={handleBulkDelete}
          onRetry={handleRetry}
        />
      )}
      {scanError && (
        <button
          onClick={clearError}
          className="fixed bottom-20 left-4 right-4 z-50 bg-red-600 text-white text-sm font-medium rounded-xl px-4 py-3 shadow-lg sm:hidden text-left w-auto"
        >
          {scanError} — tap to dismiss
        </button>
      )}
      {isScanning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 sm:hidden">
          <div className="bg-white rounded-2xl px-8 py-6 flex flex-col items-center gap-3 shadow-xl">
            <div className="w-10 h-10 border-4 border-gold border-t-transparent rounded-full animate-spin" />
            <p className="text-sm font-semibold text-gray-700">Processing scan…</p>
          </div>
        </div>
      )}
      <InvoiceDrawer
        sessionId={selectedSessionId}
        onClose={() => setSelectedSessionId(null)}
        onApproveOrReject={handleApproveOrReject}
        onNavigate={(id) => setSelectedSessionId(id)}
        allSessions={sessions}
      />
      {showUpload && (
        <InvoiceUploadModal
          activeRcId={activeRcId}
          onClose={() => setShowUpload(false)}
          onComplete={() => {
            fetchSessions()
            setShowUpload(false)
          }}
        />
      )}
    </div>
    </>
  )
}

```


---

## `src/app/invoices/exceptions/page.tsx`

```tsx
'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertCircle, Copy, ExternalLink } from 'lucide-react'
import { InboxSubNav } from '@/components/invoices/InboxSubNav'
import { PageHead } from '@/components/layout/PageHead'
import { formatCurrency } from '@/lib/utils'

interface UnmatchedRow {
  id: string
  rawItemName: string | null
  rawSize: string | null
  rawLineTotal: number | null
  createdAt: string
  session: { id: string; supplierName: string | null; invoiceNumber: string | null; invoiceDate: string | null }
}

interface DuplicateGroup {
  supplierName: string | null
  invoiceNumber: string | null
  invoiceDate: string | null
  sessions: Array<{ id: string; status: string; total: number | null; createdAt: string }>
}

interface ExceptionsData {
  unmatched: UnmatchedRow[]
  duplicates: DuplicateGroup[]
  totalCount: number
}

export default function ExceptionsPage() {
  const [data, setData] = useState<ExceptionsData | null>(null)

  useEffect(() => {
    fetch('/api/invoices/exceptions', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(json => json && setData(json))
  }, [])

  const unmatched = data?.unmatched ?? []
  const dupes = data?.duplicates ?? []

  return (
    <>
      <InboxSubNav />
      <div className="p-4 md:p-6 md:px-8 max-w-7xl mx-auto w-full">
        <PageHead
          crumbs={<span>INBOX / EXCEPTIONS</span>}
          title="Exceptions"
          sub={<>Invoice lines the matcher couldn&apos;t resolve, and duplicate invoices waiting for cleanup.</>}
        />

        {unmatched.length + dupes.length === 0 ? (
          <div className="bg-paper border border-line rounded-[12px] p-12 text-center">
            <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-green-text">All clean</p>
            <p className="text-[14px] text-ink-2 mt-2">No unmatched lines or duplicate sessions. Inbox is empty.</p>
          </div>
        ) : (
          <div className="space-y-5">
            {unmatched.length > 0 && (
              <section>
                <h2 className="font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3 mb-2">
                  Unmatched OCR lines · {unmatched.length}
                </h2>
                <div className="bg-paper border border-line rounded-[12px] overflow-hidden">
                  {unmatched.map(u => (
                    <Link
                      key={u.id}
                      href={`/invoices?session=${u.session.id}`}
                      className="grid grid-cols-[36px_1.4fr_1fr_auto_auto] items-center gap-3 px-[18px] py-3 border-b border-line last:border-0 hover:bg-bg-2/40 transition-colors"
                    >
                      <div className="w-9 h-9 rounded-[9px] bg-gold-soft text-gold-2 grid place-items-center shrink-0">
                        <AlertCircle size={15} />
                      </div>
                      <div className="min-w-0">
                        <div className="text-[14px] font-medium text-ink tracking-[-0.01em] truncate">{u.rawItemName ?? '—'}</div>
                        <div className="font-mono text-[10.5px] text-ink-3 mt-0.5">
                          {u.session.supplierName ?? '—'} · {u.session.invoiceNumber ?? '—'} · {fmtDate(u.session.invoiceDate ?? u.createdAt)}
                        </div>
                      </div>
                      <div className="font-mono text-[12px] text-ink-3">{u.rawSize ?? '—'}</div>
                      <div className="font-mono text-[13px] text-ink font-medium tabular-nums">
                        {u.rawLineTotal !== null ? formatCurrency(u.rawLineTotal) : '—'}
                      </div>
                      <div className="font-mono text-[11px] text-gold-2 inline-flex items-center gap-1">
                        Match <ExternalLink size={11} />
                      </div>
                    </Link>
                  ))}
                </div>
              </section>
            )}

            {dupes.length > 0 && (
              <section>
                <h2 className="font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3 mb-2">
                  Duplicate invoices · {dupes.length} {dupes.length === 1 ? 'group' : 'groups'}
                </h2>
                <div className="bg-paper border border-line rounded-[12px] overflow-hidden">
                  {dupes.map((g, idx) => (
                    <div key={idx} className="px-[18px] py-3.5 border-b border-line last:border-0">
                      <div className="flex items-start gap-3">
                        <div className="w-9 h-9 rounded-[9px] bg-red-soft text-red-text grid place-items-center shrink-0">
                          <Copy size={15} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-[14px] font-medium text-ink tracking-[-0.01em]">
                            {g.supplierName ?? '—'} · invoice <span className="font-mono">{g.invoiceNumber ?? '—'}</span>
                          </div>
                          <div className="font-mono text-[10.5px] text-ink-3 mt-0.5">
                            {fmtDate(g.invoiceDate ?? '')} · {g.sessions.length} sessions found
                          </div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {g.sessions.map(s => (
                              <Link key={s.id} href={`/invoices?session=${s.id}`}
                                className="inline-flex items-center gap-1.5 font-mono text-[11px] bg-bg-2 border border-line text-ink-2 px-2 py-1 rounded-[7px] hover:border-ink-3 transition-colors">
                                {s.status} · {s.total !== null ? formatCurrency(s.total) : '—'} <ExternalLink size={10} />
                              </Link>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </>
  )
}

function fmtDate(d: string): string {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

```


---

## `src/app/invoices/price-alerts/page.tsx`

```tsx
'use client'
import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { AlertTriangle, Check, ExternalLink } from 'lucide-react'
import { InboxSubNav } from '@/components/invoices/InboxSubNav'
import { PageHead } from '@/components/layout/PageHead'
import { formatCurrency } from '@/lib/utils'

interface PriceAlert {
  id: string
  inventoryItemId: string
  oldPrice: string | number | null
  newPrice: string | number | null
  changePct: string | number | null
  createdAt: string
  acknowledged: boolean
  inventoryItem: { id: string; itemName: string }
  session: { id: string; supplierName: string | null; invoiceDate: string | null }
}

interface RecipeAlert {
  id: string
  newFoodCostPct: string | number | null
  createdAt: string
  acknowledged: boolean
  recipe: { id: string; name: string; menuPrice: number | null }
  session: { id: string; supplierName: string | null }
}

interface AlertsData {
  priceAlerts: PriceAlert[]
  recipeAlerts: RecipeAlert[]
  totalUnread: number
}

export default function PriceAlertsPage() {
  const [data, setData] = useState<AlertsData | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const json: AlertsData = await fetch('/api/invoices/alerts', { cache: 'no-store' }).then(r => r.json())
      setData(json)
    } catch {}
  }, [])

  useEffect(() => { load() }, [load])

  const ackOne = async (kind: 'price' | 'recipe', id: string) => {
    setBusyId(id)
    try {
      await fetch('/api/invoices/alerts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(kind === 'price' ? { priceAlertIds: [id] } : { recipeAlertIds: [id] }),
      })
      await load()
    } finally { setBusyId(null) }
  }

  const ackAll = async () => {
    setBusyId('all')
    try {
      await fetch('/api/invoices/alerts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acknowledgeAll: true }),
      })
      await load()
    } finally { setBusyId(null) }
  }

  const priceAlerts  = data?.priceAlerts  ?? []
  const recipeAlerts = data?.recipeAlerts ?? []
  const total = priceAlerts.length + recipeAlerts.length

  return (
    <>
      <InboxSubNav />
      <div className="p-4 md:p-6 md:px-8 max-w-7xl mx-auto w-full">
        <PageHead
          crumbs={<span>INBOX / PRICE ALERTS</span>}
          title="Price alerts"
          sub={<>Items whose <b>pricePerBaseUnit</b> jumped after an invoice approval — and the recipes affected.</>}
          actions={
            total > 0 ? (
              <button onClick={ackAll} disabled={busyId === 'all'}
                className="inline-flex items-center gap-1.5 bg-ink text-paper px-4 py-[9px] rounded-[9px] text-[13px] font-medium hover:bg-[#18181b] disabled:opacity-50 transition-colors">
                <Check size={13} className="text-gold" /> Acknowledge all
              </button>
            ) : null
          }
        />

        {total === 0 ? (
          <div className="bg-paper border border-line rounded-[12px] p-12 text-center">
            <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-green-text">All clear</p>
            <p className="text-[14px] text-ink-2 mt-2">No active price alerts. Your spine is calm.</p>
          </div>
        ) : (
          <div className="space-y-5">
            {priceAlerts.length > 0 && (
              <section>
                <h2 className="font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3 mb-2">Ingredient price spikes · {priceAlerts.length}</h2>
                <div className="bg-paper border border-line rounded-[12px] overflow-hidden">
                  {priceAlerts.map(a => {
                    const old = a.oldPrice !== null ? Number(a.oldPrice) : null
                    const cur = a.newPrice !== null ? Number(a.newPrice) : null
                    const pct = a.changePct !== null ? Number(a.changePct) : null
                    return (
                      <div key={a.id} className="grid grid-cols-[36px_1.4fr_1fr_1fr_auto] items-center gap-3 px-[18px] py-3.5 border-b border-line last:border-0">
                        <div className="w-9 h-9 rounded-[9px] bg-red-soft text-red-text grid place-items-center shrink-0">
                          <AlertTriangle size={15} />
                        </div>
                        <div className="min-w-0">
                          <Link href={`/inventory?highlight=${a.inventoryItem.id}`}
                            className="text-[14px] font-medium text-ink tracking-[-0.01em] hover:text-gold-2 inline-flex items-center gap-1">
                            {a.inventoryItem.itemName} <ExternalLink size={11} className="text-ink-4" />
                          </Link>
                          <div className="font-mono text-[10.5px] text-ink-3 mt-0.5">
                            {a.session.supplierName ?? '—'} · {fmtDate(a.session.invoiceDate ?? a.createdAt)}
                          </div>
                        </div>
                        <div className="font-mono text-[12px] text-ink-3">
                          {old !== null ? formatCurrency(old) : '—'} <span className="text-ink-4">→</span>{' '}
                          <span className="text-ink font-medium">{cur !== null ? formatCurrency(cur) : '—'}</span>
                        </div>
                        <div className={`font-mono text-[13px] font-semibold tabular-nums ${pct !== null && pct > 0 ? 'text-red-text' : pct !== null && pct < 0 ? 'text-green-text' : 'text-ink-3'}`}>
                          {pct !== null ? (pct > 0 ? '+' : '') + pct.toFixed(1) + '%' : '—'}
                        </div>
                        <button onClick={() => ackOne('price', a.id)} disabled={busyId === a.id}
                          className="font-mono text-[11px] px-3 py-1.5 rounded-full bg-bg-2 text-ink-2 border border-line hover:border-ink-3 disabled:opacity-50 transition-colors">
                          {busyId === a.id ? '…' : 'Ack'}
                        </button>
                      </div>
                    )
                  })}
                </div>
              </section>
            )}

            {recipeAlerts.length > 0 && (
              <section>
                <h2 className="font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3 mb-2">Recipe drift · {recipeAlerts.length}</h2>
                <div className="bg-paper border border-line rounded-[12px] overflow-hidden">
                  {recipeAlerts.map(a => {
                    const fcPct = a.newFoodCostPct !== null ? Number(a.newFoodCostPct) : null
                    const overTarget = fcPct !== null && fcPct > 28
                    return (
                      <div key={a.id} className="grid grid-cols-[36px_1.4fr_1fr_auto] items-center gap-3 px-[18px] py-3.5 border-b border-line last:border-0">
                        <div className="w-9 h-9 rounded-[9px] bg-gold-soft text-gold-2 grid place-items-center shrink-0">
                          <AlertTriangle size={15} />
                        </div>
                        <div className="min-w-0">
                          <Link href={`/menu?highlight=${a.recipe.id}`}
                            className="text-[14px] font-medium text-ink tracking-[-0.01em] hover:text-gold-2 inline-flex items-center gap-1">
                            {a.recipe.name} <ExternalLink size={11} className="text-ink-4" />
                          </Link>
                          <div className="font-mono text-[10.5px] text-ink-3 mt-0.5">
                            triggered by {a.session.supplierName ?? '—'} · {fmtDate(a.createdAt)}
                          </div>
                        </div>
                        <div className={`font-mono text-[13px] font-semibold tabular-nums ${overTarget ? 'text-red-text' : 'text-ink-2'}`}>
                          {fcPct !== null ? fcPct.toFixed(1) + '%' : '—'} food cost
                        </div>
                        <button onClick={() => ackOne('recipe', a.id)} disabled={busyId === a.id}
                          className="font-mono text-[11px] px-3 py-1.5 rounded-full bg-bg-2 text-ink-2 border border-line hover:border-ink-3 disabled:opacity-50 transition-colors">
                          {busyId === a.id ? '…' : 'Ack'}
                        </button>
                      </div>
                    )
                  })}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </>
  )
}

function fmtDate(d: string): string {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

```


---

## `src/app/sales/page.tsx`

```tsx
'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUpDown, BarChart2, Calendar, Check, ChevronDown, ChevronUp,
  Pencil, Plus, Search, Trash2, TrendingUp, Upload, Users, X,
} from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import { useRc } from '@/contexts/RevenueCenterContext'
import { rcHex } from '@/lib/rc-colors'

// ─── Types ────────────────────────────────────────────────────────────────────

interface RecipeSummary {
  id: string
  name: string
  menuPrice: number | null
  portionSize: number | null
  portionUnit: string | null
  yieldUnit: string
  baseYieldQty: number
  category: { name: string; color: string | null } | null
}

interface SaleLineItem {
  id: string
  recipeId: string
  qtySold: number
  recipe: RecipeSummary
}

interface Sale {
  id: string
  date: string
  totalRevenue: number
  foodSalesPct: number
  covers: number | null
  notes: string | null
  createdAt: string
  revenueCenterId: string | null
  revenueCenter: { id: string; name: string; color: string } | null
  lineItems: SaleLineItem[]
  periodType: string
  endDate: string | null
}

type RangeMode = 'week' | 'month' | 'lastMonth' | 'custom'
type SortCol = 'date' | 'revenue' | 'covers' | 'items'
type SortDir = 'asc' | 'desc'

type Granularity = 'day' | 'week' | 'month'

interface PeriodRow {
  key: string
  label: string
  startDate: string
  endDate: string
  totalRevenue: number
  foodSalesPct: number
  covers: number | null
  badge: 'weekly-import' | 'monthly-import' | 'complete' | 'partial' | 'not-available'
  badgeText: string
  directSale: Sale | null
  dailySales: Sale[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function startOfWeek(d: Date) {
  const r = new Date(d)
  r.setDate(r.getDate() - r.getDay())
  r.setHours(0, 0, 0, 0)
  return r
}

function toISO(d: Date) { return d.toISOString().slice(0, 10) }

function fmtDate(s: string) {
  return new Date(s).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })
}

function fmtDay(s: string) {
  return new Date(s).toLocaleDateString('en-CA', { weekday: 'short' })
}

function weekRange(d: Date): [string, string] {
  const s = startOfWeek(d); const e = new Date(s); e.setDate(s.getDate() + 6)
  return [toISO(s), toISO(e)]
}

function monthRange(d: Date): [string, string] {
  const s = new Date(d.getFullYear(), d.getMonth(), 1)
  const e = new Date(d.getFullYear(), d.getMonth() + 1, 0)
  return [toISO(s), toISO(e)]
}

function lastMonthRange(d: Date): [string, string] {
  const s = new Date(d.getFullYear(), d.getMonth() - 1, 1)
  const e = new Date(d.getFullYear(), d.getMonth(), 0)
  return [toISO(s), toISO(e)]
}

function getRange(mode: RangeMode, customStart: string, customEnd: string): [string, string] {
  const now = new Date()
  if (mode === 'week')       return weekRange(now)
  if (mode === 'month')      return monthRange(now)
  if (mode === 'lastMonth')  return lastMonthRange(now)
  return [customStart || toISO(now), customEnd || toISO(now)]
}

function isoWeekStart(d: Date): Date {
  const r = new Date(d)
  r.setHours(0, 0, 0, 0)
  const day = r.getDay()
  r.setDate(r.getDate() - ((day + 6) % 7))
  return r
}

function buildWeekRows(sales: Sale[], rangeStart: string, rangeEnd: string): PeriodRow[] {
  const rows: PeriodRow[] = []
  let cursor = isoWeekStart(new Date(rangeStart))
  const rangeEndDate = new Date(rangeEnd + 'T23:59:59')

  while (cursor <= rangeEndDate) {
    const weekEnd = new Date(cursor)
    weekEnd.setDate(cursor.getDate() + 6)
    const weekStartISO = toISO(cursor)
    const weekEndISO   = toISO(weekEnd)

    const directImport = sales.find(
      s => s.periodType === 'week' &&
        toISO(isoWeekStart(new Date(s.date))) === weekStartISO
    )
    const dailies = sales.filter(
      s => s.periodType === 'day' &&
        s.date.slice(0, 10) >= weekStartISO &&
        s.date.slice(0, 10) <= weekEndISO
    )

    let badge: PeriodRow['badge']
    let badgeText: string
    let totalRevenue: number
    let foodSalesPct: number
    let covers: number | null

    if (directImport) {
      badge = 'weekly-import'; badgeText = 'Weekly import'
      totalRevenue = Number(directImport.totalRevenue)
      foodSalesPct = Number(directImport.foodSalesPct)
      covers = directImport.covers
    } else if (dailies.length === 0) {
      badge = 'not-available'; badgeText = 'Not available'
      totalRevenue = 0; foodSalesPct = 0.7; covers = null
    } else {
      const totalRev       = dailies.reduce((s, d) => s + Number(d.totalRevenue), 0)
      const totalFoodSales = dailies.reduce((s, d) => s + Number(d.totalRevenue) * Number(d.foodSalesPct), 0)
      badge     = dailies.length >= 7 ? 'complete' : 'partial'
      badgeText = `${dailies.length}/7 days`
      totalRevenue = totalRev
      foodSalesPct = totalRev > 0 ? totalFoodSales / totalRev : 0.7
      covers       = dailies.reduce((s, d) => s + (d.covers ?? 0), 0) || null
    }

    const lStart = cursor.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })
    const lEnd   = weekEnd.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })

    rows.push({
      key: `w-${weekStartISO}`,
      label: `${lStart} – ${lEnd}`,
      startDate: weekStartISO,
      endDate: weekEndISO,
      totalRevenue,
      foodSalesPct,
      covers,
      badge,
      badgeText,
      directSale: directImport ?? null,
      dailySales: dailies,
    })

    cursor = new Date(cursor)
    cursor.setDate(cursor.getDate() + 7)
  }

  return rows.reverse()
}

function buildMonthRows(sales: Sale[], rangeStart: string, rangeEnd: string): PeriodRow[] {
  const rows: PeriodRow[] = []
  const rangeStartDate = new Date(rangeStart)
  const rangeEndDate   = new Date(rangeEnd + 'T23:59:59')

  let cursor = new Date(rangeStartDate.getFullYear(), rangeStartDate.getMonth(), 1)
  while (cursor <= rangeEndDate) {
    const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0)
    const monthStartISO = toISO(cursor)
    const monthEndISO   = toISO(monthEnd)

    const directImport = sales.find(
      s => s.periodType === 'month' &&
        new Date(s.date).getFullYear() === cursor.getFullYear() &&
        new Date(s.date).getMonth()    === cursor.getMonth()
    )

    const contributing = sales.filter(
      s => s.periodType !== 'month' &&
        s.date.slice(0, 10) >= monthStartISO &&
        s.date.slice(0, 10) <= monthEndISO
    )
    const dailies = contributing.filter(s => s.periodType === 'day')

    let badge: PeriodRow['badge']
    let badgeText: string
    let totalRevenue: number
    let foodSalesPct: number
    let covers: number | null

    if (directImport) {
      badge = 'monthly-import'; badgeText = 'Monthly import'
      totalRevenue = Number(directImport.totalRevenue)
      foodSalesPct = Number(directImport.foodSalesPct)
      covers = directImport.covers
    } else if (contributing.length === 0) {
      badge = 'not-available'; badgeText = 'Not available'
      totalRevenue = 0; foodSalesPct = 0.7; covers = null
    } else {
      const totalRev       = contributing.reduce((s, e) => s + Number(e.totalRevenue), 0)
      const totalFoodSales = contributing.reduce((s, e) => s + Number(e.totalRevenue) * Number(e.foodSalesPct), 0)
      const coveredDays    = new Set(dailies.map(d => d.date.slice(0, 10)))
      const daysInMonth    = monthEnd.getDate()
      badge     = coveredDays.size >= daysInMonth ? 'complete' : 'partial'
      badgeText = `${coveredDays.size}/${daysInMonth} days`
      totalRevenue = totalRev
      foodSalesPct = totalRev > 0 ? totalFoodSales / totalRev : 0.7
      covers       = contributing.reduce((s, e) => s + (e.covers ?? 0), 0) || null
    }

    rows.push({
      key: `m-${monthStartISO}`,
      label: cursor.toLocaleDateString('en-CA', { month: 'long', year: 'numeric' }),
      startDate: monthStartISO,
      endDate: monthEndISO,
      totalRevenue,
      foodSalesPct,
      covers,
      badge,
      badgeText,
      directSale: directImport ?? null,
      dailySales: dailies,
    })

    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
  }

  return rows.reverse()
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────

function PeriodBadge({ badge, text }: { badge: PeriodRow['badge']; text: string }) {
  const cls = {
    'weekly-import':  'bg-blue-100 text-blue-700',
    'monthly-import': 'bg-purple-100 text-purple-700',
    'complete':       'bg-green-100 text-green-700',
    'partial':        'bg-amber-100 text-amber-700',
    'not-available':  'bg-gray-100 text-gray-400',
  }[badge]
  return <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${cls}`}>{text}</span>
}

function KpiCard({ label, value, sub, accent = 'text-gray-900' }: {
  label: string; value: string; sub?: string; accent?: string
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
      <div className="text-[10px] font-semibold text-gray-400 tracking-wide uppercase">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${accent}`}>{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  )
}

// ─── Sale Form Modal ───────────────────────────────────────────────────────────

interface RcOption { id: string; name: string; color: string }

interface SaleFormProps {
  initial?: Sale | null
  menuRecipes: RecipeSummary[]
  revenueCenters: RcOption[]
  defaultRcId: string | null
  onSave: (data: {
    date: string; totalRevenue: string; foodSalesPct: string
    covers: string; notes: string
    revenueCenterId: string | null
    lineItems: { recipeId: string; qtySold: number }[]
  }) => Promise<void>
  onCancel: () => void
}

function SaleForm({ initial, menuRecipes, revenueCenters, defaultRcId, onSave, onCancel }: SaleFormProps) {
  const [date,          setDate]          = useState(initial ? toISO(new Date(initial.date)) : toISO(new Date()))
  const [revenue,       setRevenue]       = useState(initial ? String(initial.totalRevenue) : '')
  const [foodPct,       setFoodPct]       = useState(initial ? String(Math.round(Number(initial.foodSalesPct) * 100)) : '70')
  const [covers,        setCovers]        = useState(initial ? String(initial.covers ?? '') : '')
  const [notes,         setNotes]         = useState(initial?.notes ?? '')
  const [rcId,          setRcId]          = useState<string | null>(initial ? initial.revenueCenterId : defaultRcId)
  const [saving,        setSaving]        = useState(false)
  const [recipeSearch,  setRecipeSearch]  = useState('')

  // lineItems map: recipeId → qtySold
  const [qtys, setQtys] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {}
    initial?.lineItems.forEach(li => { m[li.recipeId] = String(li.qtySold) })
    return m
  })

  const filteredRecipes = menuRecipes.filter(r =>
    r.name.toLowerCase().includes(recipeSearch.toLowerCase())
  )

  const totalSold = Object.values(qtys).reduce((s, v) => s + (parseInt(v) || 0), 0)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    const lineItems = Object.entries(qtys)
      .map(([recipeId, q]) => ({ recipeId, qtySold: parseInt(q) || 0 }))
      .filter(li => li.qtySold > 0)
    await onSave({ date, totalRevenue: revenue, foodSalesPct: String(parseFloat(foodPct) / 100), covers, notes, revenueCenterId: rcId, lineItems })
    setSaving(false)
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4">
      <div className="bg-white w-full sm:max-w-2xl rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-gray-100 shrink-0">
          <h2 className="text-base font-semibold text-gray-900">{initial ? 'Edit Sales Day' : 'Record Sales Day'}</h2>
          <button onClick={onCancel} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400"><X size={18} /></button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
          <div className="px-5 py-4 space-y-4 overflow-y-auto flex-1">
            {/* Row 1: date + covers */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Date</label>
                <input type="date" required value={date} onChange={e => setDate(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Covers (guests)</label>
                <input type="number" min="0" value={covers} onChange={e => setCovers(e.target.value)}
                  placeholder="0"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
              </div>
            </div>

            {/* Revenue center */}
            {revenueCenters.length > 0 && (
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Revenue Center</label>
                <div className="flex flex-wrap gap-1.5">
                  {revenueCenters.map(rc => {
                    const active = rcId === rc.id
                    return (
                      <button
                        key={rc.id}
                        type="button"
                        onClick={() => setRcId(rc.id)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                          active ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-700 border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: rcHex(rc.color) }} />
                        {rc.name}
                      </button>
                    )
                  })}
                  <button
                    type="button"
                    onClick={() => setRcId(null)}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                      rcId === null ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    Unassigned
                  </button>
                </div>
              </div>
            )}

            {/* Row 2: revenue + food % */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Total Revenue ($)</label>
                <input type="number" required min="0" step="0.01" value={revenue} onChange={e => setRevenue(e.target.value)}
                  placeholder="0.00"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Food Sales %</label>
                <div className="relative">
                  <input type="number" min="0" max="100" value={foodPct} onChange={e => setFoodPct(e.target.value)}
                    placeholder="70"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">%</span>
                </div>
              </div>
            </div>

            {/* Notes */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Notes</label>
              <input value={notes} onChange={e => setNotes(e.target.value)}
                placeholder="e.g. Busy Friday night, private event..."
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
            </div>

            {/* Menu items */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-medium text-gray-600">Menu items sold <span className="text-gray-400 font-normal">({totalSold} total portions)</span></label>
              </div>
              <div className="relative mb-2">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input value={recipeSearch} onChange={e => setRecipeSearch(e.target.value)}
                  placeholder="Search menu items..."
                  className="w-full pl-8 pr-3 py-2 border border-gray-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-gold" />
              </div>
              <div className="border border-gray-100 rounded-xl overflow-hidden divide-y divide-gray-50 max-h-64 overflow-y-auto">
                {filteredRecipes.length === 0 && (
                  <div className="px-3 py-4 text-center text-sm text-gray-400">No menu items found</div>
                )}
                {filteredRecipes.map(r => (
                  <div key={r.id} className="flex items-center gap-3 px-3 py-2 hover:bg-gray-50">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-800 truncate">{r.name}</div>
                      {r.menuPrice && (
                        <div className="text-xs text-gray-400">{formatCurrency(Number(r.menuPrice))}</div>
                      )}
                    </div>
                    <input
                      type="number" min="0" step="1"
                      value={qtys[r.id] ?? ''}
                      onChange={e => setQtys(q => ({ ...q, [r.id]: e.target.value }))}
                      placeholder="0"
                      className="w-20 border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-gold"
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-3 border-t border-gray-100 shrink-0 flex gap-3">
            <button type="button" onClick={onCancel}
              className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50">
              Cancel
            </button>
            <button type="submit" disabled={saving}
              className="flex-1 px-4 py-2.5 rounded-xl bg-gold text-white text-sm font-medium hover:bg-[#a88930] disabled:opacity-60">
              {saving ? 'Saving…' : (initial ? 'Save changes' : 'Record sales')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Import Modal (Toast POS ProductMix) ─────────────────────────────────────

interface ParsedItem {
  rawName: string
  qtySold: number
  matchedRecipeId: string | null
  matchedRecipeName: string | null
  matchConfidence: 'exact' | 'fuzzy' | 'none'
}

interface ParseResult {
  date: string
  endDate: string | null
  periodType: string
  totalSales: number
  foodSales: number
  items: ParsedItem[]
}

function ConfidenceBadge({ c }: { c: ParsedItem['matchConfidence'] }) {
  if (c === 'exact')  return <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-green-100 text-green-700">matched</span>
  if (c === 'fuzzy')  return <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">fuzzy</span>
  return <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">unmatched</span>
}

function ImportModal({ menuRecipes, onImport, onClose }: {
  menuRecipes: RecipeSummary[]
  onImport: (row: { date: string; endDate: string | null; periodType: string; totalRevenue: string; covers: string; foodSalesPct: string; notes: string; lineItems: { recipeId: string; qtySold: number }[] }) => Promise<void>
  onClose: () => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [step,     setStep]     = useState<'upload' | 'review'>('upload')
  const [file,     setFile]     = useState<File | null>(null)
  const [parsing,  setParsing]  = useState(false)
  const [parseErr, setParseErr] = useState('')
  const [parsed,   setParsed]   = useState<ParseResult | null>(null)
  const [saving,   setSaving]   = useState(false)
  const [endDate,    setEndDate]    = useState('')
  const [periodType, setPeriodType] = useState<'day' | 'week' | 'month' | 'custom'>('day')

  // Editable review fields
  const [date,       setDate]       = useState('')
  const [totalSales, setTotalSales] = useState('')
  const [foodSales,  setFoodSales]  = useState('')
  const [qtys,       setQtys]       = useState<Record<string, number>>({})
  // recipeId overrides for unmatched/fuzzy items
  const [overrides,  setOverrides]  = useState<Record<string, string>>({})

  const handleFile = async (f: File) => {
    setFile(f)
    setParseErr('')
    setParsing(true)
    try {
      const form = new FormData()
      form.append('file', f)
      const res = await fetch('/api/sales/import', { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Parse failed')
      const result = data as ParseResult
      setParsed(result)
      setDate(result.date)
      setEndDate(result.endDate ?? '')
      setPeriodType((result.periodType ?? 'day') as 'day' | 'week' | 'month' | 'custom')
      setTotalSales(String(result.totalSales))
      setFoodSales(String(result.foodSales))
      // Initialise qtys from parsed items (keyed by rawName, then recipeId when confirmed)
      const qMap: Record<string, number> = {}
      for (const item of result.items) {
        if (item.matchedRecipeId) qMap[item.matchedRecipeId] = item.qtySold
      }
      setQtys(qMap)
      setOverrides({})
      setStep('review')
    } catch (err: unknown) {
      setParseErr(err instanceof Error ? err.message : 'Failed to parse file')
    } finally {
      setParsing(false)
    }
  }

  const handleSave = async () => {
    if (!parsed) return
    setSaving(true)
    const total = parseFloat(totalSales) || 0
    const food  = parseFloat(foodSales)  || 0
    const foodSalesPct = total > 0 ? String((food / total).toFixed(4)) : '0.7'

    // Build lineItems from matched items (respecting overrides)
    const lineItems: { recipeId: string; qtySold: number }[] = []
    for (const item of parsed.items) {
      const recipeId = overrides[item.rawName] ?? item.matchedRecipeId
      if (!recipeId) continue
      const qty = qtys[recipeId] ?? item.qtySold
      if (qty > 0) lineItems.push({ recipeId, qtySold: qty })
    }

    await onImport({ date, endDate: endDate || null, periodType, totalRevenue: totalSales, covers: '', foodSalesPct, notes: '', lineItems })
    setSaving(false)
  }

  const foodPct = (() => {
    const t = parseFloat(totalSales) || 0
    const f = parseFloat(foodSales)  || 0
    return t > 0 ? Math.round((f / t) * 100) : 0
  })()

  const matched   = parsed?.items.filter(i => (overrides[i.rawName] ?? i.matchedRecipeId) !== null) ?? []
  const unmatched = parsed?.items.filter(i => (overrides[i.rawName] ?? i.matchedRecipeId) === null) ?? []

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4">
      <div className="bg-white w-full sm:max-w-2xl rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[92vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-gray-100 shrink-0">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Import from Toast POS</h2>
            {step === 'review' && <p className="text-xs text-gray-400 mt-0.5">Review and confirm before saving</p>}
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400"><X size={18} /></button>
        </div>

        {/* ── Upload step ── */}
        {step === 'upload' && (
          <div className="px-5 py-5 space-y-4">
            <div className="bg-gold/10 border border-blue-100 rounded-xl p-3 text-sm text-blue-800">
              Upload the <strong>ProductMix</strong> Excel exported from Toast POS. The system will extract food sales totals and BRUNCH item quantities automatically.
            </div>

            <div
              onClick={() => fileRef.current?.click()}
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f) }}
              className="border-2 border-dashed border-gray-200 rounded-xl p-10 text-center cursor-pointer hover:border-blue-400 transition-colors"
            >
              {parsing ? (
                <div className="text-sm text-gray-500">Parsing file…</div>
              ) : (
                <>
                  <Upload size={28} className="mx-auto text-gray-300 mb-2" />
                  <div className="text-sm font-medium text-gray-600">{file ? file.name : 'Click or drag your ProductMix file here'}</div>
                  <div className="text-xs text-gray-400 mt-1">Accepts .xlsx or .csv</div>
                </>
              )}
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />
            </div>

            {parseErr && (
              <div className="text-sm text-red-500 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{parseErr}</div>
            )}

            <div className="flex gap-3 pt-1">
              <button onClick={onClose} className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
            </div>
          </div>
        )}

        {/* ── Review step ── */}
        {step === 'review' && parsed && (
          <>
            <div className="px-5 py-4 overflow-y-auto flex-1 space-y-5">

              {/* Date + Totals */}
              {parsed.endDate ? (
                /* Period import */
                <div className="space-y-3">
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="text-xs font-medium text-gray-600 block mb-1">From</label>
                      <input type="date" value={date} onChange={e => setDate(e.target.value)}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-gray-600 block mb-1">To</label>
                      <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-gray-600 block mb-1">Period Type</label>
                      <select value={periodType} onChange={e => setPeriodType(e.target.value as 'week' | 'month' | 'custom')}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold">
                        <option value="week">Week</option>
                        <option value="month">Month</option>
                        <option value="custom">Custom</option>
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium text-gray-600 block mb-1">Total Net Sales</label>
                      <div className="relative">
                        <span className="absolute left-3 top-2 text-gray-400 text-sm">$</span>
                        <input type="number" min="0" step="0.01" value={totalSales} onChange={e => setTotalSales(e.target.value)}
                          className="w-full border border-gray-200 rounded-lg pl-7 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                      </div>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-gray-600 block mb-1">
                        Food Sales <span className="text-gray-400 font-normal">({foodPct}%)</span>
                      </label>
                      <div className="relative">
                        <span className="absolute left-3 top-2 text-gray-400 text-sm">$</span>
                        <input type="number" min="0" step="0.01" value={foodSales} onChange={e => setFoodSales(e.target.value)}
                          className="w-full border border-gray-200 rounded-lg pl-7 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                /* Single-day import — existing layout */
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="text-xs font-medium text-gray-600 block mb-1">Date</label>
                    <input type="date" value={date} onChange={e => setDate(e.target.value)}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-gray-600 block mb-1">Total Net Sales</label>
                    <div className="relative">
                      <span className="absolute left-3 top-2 text-gray-400 text-sm">$</span>
                      <input type="number" min="0" step="0.01" value={totalSales} onChange={e => setTotalSales(e.target.value)}
                        className="w-full border border-gray-200 rounded-lg pl-7 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-gray-600 block mb-1">
                      Food Sales <span className="text-gray-400 font-normal">({foodPct}%)</span>
                    </label>
                    <div className="relative">
                      <span className="absolute left-3 top-2 text-gray-400 text-sm">$</span>
                      <input type="number" min="0" step="0.01" value={foodSales} onChange={e => setFoodSales(e.target.value)}
                        className="w-full border border-gray-200 rounded-lg pl-7 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                    </div>
                  </div>
                </div>
              )}

              {/* Matched items */}
              <div>
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                  BRUNCH items · {parsed.items.length} from Toast · {matched.length} matched
                </div>
                <div className="border border-gray-100 rounded-xl overflow-hidden divide-y divide-gray-50">
                  {parsed.items.map(item => {
                    const recipeId = overrides[item.rawName] ?? item.matchedRecipeId
                    const confidence = overrides[item.rawName] ? 'exact' : item.matchConfidence
                    const qty = recipeId ? (qtys[recipeId] ?? item.qtySold) : item.qtySold
                    return (
                      <div key={item.rawName} className="flex items-center gap-3 px-3 py-2.5">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-gray-800 truncate">{item.rawName}</span>
                            <ConfidenceBadge c={confidence} />
                          </div>
                          {/* Recipe selector */}
                          <select
                            value={recipeId ?? ''}
                            onChange={e => {
                              const val = e.target.value
                              setOverrides(o => ({ ...o, [item.rawName]: val }))
                              if (val && !qtys[val]) {
                                setQtys(q => ({ ...q, [val]: item.qtySold }))
                              }
                            }}
                            className="mt-1 w-full border border-gray-100 rounded-lg px-2 py-1 text-xs text-gray-600 focus:outline-none focus:ring-1 focus:ring-gold bg-gray-50"
                          >
                            <option value="">— not matched —</option>
                            {menuRecipes.map(r => (
                              <option key={r.id} value={r.id}>{r.name}</option>
                            ))}
                          </select>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <span className="text-xs text-gray-400">×</span>
                          <input
                            type="number" min="0" step="1"
                            value={recipeId ? qty : item.qtySold}
                            onChange={e => {
                              const rid = recipeId
                              if (rid) setQtys(q => ({ ...q, [rid]: parseInt(e.target.value) || 0 }))
                            }}
                            className="w-16 border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-gold"
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>

              {unmatched.length > 0 && (
                <div className="text-xs text-amber-600 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                  {unmatched.length} item{unmatched.length > 1 ? 's' : ''} not matched to a menu recipe — they won&apos;t be recorded. Use the dropdown above to assign them.
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-3 border-t border-gray-100 shrink-0 flex gap-3">
              <button onClick={() => setStep('upload')} className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50">
                ← Back
              </button>
              <button onClick={handleSave} disabled={saving}
                className="flex-1 px-4 py-2.5 rounded-xl bg-gold text-white text-sm font-medium hover:bg-[#a88930] disabled:opacity-60">
                {saving ? 'Saving…' :
                  periodType === 'week'   ? 'Save weekly sales' :
                  periodType === 'month'  ? 'Save monthly sales' :
                  periodType === 'custom' ? 'Save period sales' :
                  `Save sales for ${date}`
                }
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SalesPage() {
  const [sales,         setSales]         = useState<Sale[]>([])
  const [menuRecipes,   setMenuRecipes]   = useState<RecipeSummary[]>([])
  const [loading,       setLoading]       = useState(true)
  const [rangeMode,     setRangeMode]     = useState<RangeMode>('week')
  const [customStart,   setCustomStart]   = useState('')
  const [customEnd,     setCustomEnd]     = useState('')
  const [sortCol,       setSortCol]       = useState<SortCol>('date')
  const [sortDir,       setSortDir]       = useState<SortDir>('desc')
  const [search,        setSearch]        = useState('')
  const [showAdd,       setShowAdd]       = useState(false)
  const [editSale,      setEditSale]      = useState<Sale | null>(null)
  const [selectedSale,  setSelectedSale]  = useState<Sale | null>(null)
  const [selectedPeriodKey, setSelectedPeriodKey] = useState<string | null>(null)
  const [granularity,       setGranularity]       = useState<Granularity>('day')
  const [showImport,    setShowImport]    = useState(false)
  const [deleteId,      setDeleteId]      = useState<string | null>(null)
  const [activeTab,     setActiveTab]     = useState<'list' | 'analytics'>('list')

  const { activeRcId, activeRc, revenueCenters } = useRc()

  const [startDate, endDate] = getRange(rangeMode, customStart, customEnd)

  const fetchSales = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams({ startDate, endDate })
    if (activeRcId) {
      params.set('rcId', activeRcId)
      if (activeRc?.isDefault) params.set('isDefault', 'true')
    }
    const data = await fetch(`/api/sales?${params}`).then(r => r.json())
    setSales(Array.isArray(data) ? data : [])
    setLoading(false)
  }, [startDate, endDate, activeRcId, activeRc])

  useEffect(() => { fetchSales() }, [fetchSales])

  useEffect(() => {
    fetch('/api/recipes?type=MENU').then(r => r.json()).then(d => {
      if (Array.isArray(d)) setMenuRecipes(d)
    })
  }, [])

  // ── KPIs ──
  const kpis = useMemo(() => {
    const totalRevenue  = sales.reduce((s, e) => s + Number(e.totalRevenue), 0)
    const totalFoodSales = sales.reduce((s, e) => s + Number(e.totalRevenue) * Number(e.foodSalesPct), 0)
    const totalCovers   = sales.reduce((s, e) => s + (e.covers ?? 0), 0)
    const days          = sales.length
    const avgDaily      = days > 0 ? totalRevenue / days : 0
    const avgPerCover   = totalCovers > 0 ? totalRevenue / totalCovers : 0
    const totalPortions = sales.reduce((s, e) => s + e.lineItems.reduce((ss, li) => ss + li.qtySold, 0), 0)
    return { totalRevenue, totalFoodSales, totalCovers, days, avgDaily, avgPerCover, totalPortions }
  }, [sales])

  // ── Top items ──
  const topItems = useMemo(() => {
    const map = new Map<string, { name: string; qty: number; revenue: number }>()
    for (const sale of sales) {
      for (const li of sale.lineItems) {
        const prev = map.get(li.recipeId) ?? { name: li.recipe.name, qty: 0, revenue: 0 }
        map.set(li.recipeId, {
          name: li.recipe.name,
          qty: prev.qty + li.qtySold,
          revenue: prev.revenue + (li.recipe.menuPrice ? Number(li.recipe.menuPrice) * li.qtySold : 0),
        })
      }
    }
    return Array.from(map.values()).sort((a, b) => b.qty - a.qty).slice(0, 15)
  }, [sales])

  // ── Period rows (week/month aggregation) ──
  const periodRows = useMemo((): PeriodRow[] => {
    if (granularity === 'week')  return buildWeekRows(sales, startDate, endDate)
    if (granularity === 'month') return buildMonthRows(sales, startDate, endDate)
    return []
  }, [sales, granularity, startDate, endDate])

  // ── Sorted + filtered list ──
  const displayed = useMemo(() => {
    let list = [...sales]
    if (search) list = list.filter(s =>
      new Date(s.date).toLocaleDateString().includes(search) || (s.notes ?? '').toLowerCase().includes(search.toLowerCase())
    )
    list.sort((a, b) => {
      let diff = 0
      if (sortCol === 'date')    diff = new Date(a.date).getTime() - new Date(b.date).getTime()
      if (sortCol === 'revenue') diff = Number(a.totalRevenue) - Number(b.totalRevenue)
      if (sortCol === 'covers')  diff = (a.covers ?? 0) - (b.covers ?? 0)
      if (sortCol === 'items')   diff = a.lineItems.reduce((s,l)=>s+l.qtySold,0) - b.lineItems.reduce((s,l)=>s+l.qtySold,0)
      return sortDir === 'asc' ? diff : -diff
    })
    return list
  }, [sales, search, sortCol, sortDir])

  const toggleSort = (col: SortCol) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('desc') }
  }

  const SortIcon = ({ col }: { col: SortCol }) =>
    sortCol === col
      ? (sortDir === 'asc' ? <ChevronUp size={12} className="text-gold inline ml-1" /> : <ChevronDown size={12} className="text-gold inline ml-1" />)
      : <ArrowUpDown size={12} className="text-gray-300 inline ml-1" />

  // ── CRUD handlers ──
  const handleSave = async (data: Parameters<SaleFormProps['onSave']>[0]) => {
    if (editSale) {
      await fetch(`/api/sales/${editSale.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      setEditSale(null)
    } else {
      await fetch('/api/sales', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      setShowAdd(false)
    }
    fetchSales()
  }

  const handleDelete = async (id: string) => {
    await fetch(`/api/sales/${id}`, { method: 'DELETE' })
    setDeleteId(null)
    if (selectedSale?.id === id) setSelectedSale(null)
    fetchSales()
  }

  const handleImport = async (row: Parameters<Parameters<typeof ImportModal>[0]['onImport']>[0]) => {
    await fetch('/api/sales', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...row, revenueCenterId: activeRcId }) })
    setShowImport(false)
    fetchSales()
  }

  return (
    <div className="space-y-4 pb-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Sales</h1>
          <p className="text-sm text-gray-500 mt-0.5">Daily sales records · inventory consumption tracking</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowImport(true)}
            className="flex items-center gap-2 border border-gray-200 bg-white text-gray-700 px-3 py-2 rounded-lg text-sm hover:bg-gray-50 transition-colors">
            <Upload size={15} /> Import
          </button>
          <button onClick={() => setShowAdd(true)}
            className="flex items-center gap-2 bg-gold text-white px-3 py-2 rounded-lg text-sm hover:bg-[#a88930] transition-colors">
            <Plus size={15} /> Add Sales Day
          </button>
        </div>
      </div>

      {/* Date range tabs */}
      <div className="flex items-center gap-2 flex-wrap">
        {(['week', 'month', 'lastMonth', 'custom'] as RangeMode[]).map(mode => (
          <button key={mode} onClick={() => setRangeMode(mode)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              rangeMode === mode ? 'bg-gold text-white' : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300'
            }`}>
            {{ week: 'This Week', month: 'This Month', lastMonth: 'Last Month', custom: 'Custom' }[mode]}
          </button>
        ))}
        {rangeMode === 'custom' && (
          <div className="flex items-center gap-2 ml-1">
            <input type="date" value={customStart} onChange={e => setCustomStart(e.target.value)}
              className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
            <span className="text-gray-400 text-sm">to</span>
            <input type="date" value={customEnd} onChange={e => setCustomEnd(e.target.value)}
              className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
          </div>
        )}
      </div>

      {/* Onboarding card — shown when no sales have ever been recorded */}
      {!loading && sales.length === 0 && rangeMode === 'week' && (
        <div className="bg-gold/10 border border-blue-100 rounded-xl p-5 flex gap-4 items-start">
          <div className="w-10 h-10 rounded-xl bg-gold/15 flex items-center justify-center shrink-0">
            <BarChart2 size={20} className="text-gold" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-blue-900 text-sm mb-1">Record your daily sales to unlock food cost tracking</h3>
            <p className="text-xs text-gold leading-relaxed mb-3">
              Add each service day — total revenue, covers, and which menu items sold. This powers the food cost % calculation in your dashboard and analytics.
              You can also <button onClick={() => setShowImport(true)} className="underline font-medium">import from Toast POS</button> if you have a ProductMix export.
            </p>
            <button onClick={() => setShowAdd(true)}
              className="inline-flex items-center gap-2 bg-gold text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#a88930] transition-colors">
              <Plus size={14} /> Add First Sales Day
            </button>
          </div>
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard label="Total Revenue" value={formatCurrency(kpis.totalRevenue)} sub={`${kpis.days} days`} accent="text-green-600" />
        <KpiCard label="Food Sales" value={formatCurrency(kpis.totalFoodSales)} sub="estimated" accent="text-gold" />
        <KpiCard label="Total Covers" value={kpis.totalCovers.toLocaleString()} sub="guests" accent="text-gray-900" />
        <KpiCard label="Avg per Cover" value={kpis.avgPerCover > 0 ? formatCurrency(kpis.avgPerCover) : '—'} />
        <KpiCard label="Avg Daily" value={kpis.avgDaily > 0 ? formatCurrency(kpis.avgDaily) : '—'} />
        <KpiCard label="Portions Sold" value={kpis.totalPortions.toLocaleString()} sub="menu items" accent="text-purple-600" />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-100">
        {([['list', 'Sales Log'], ['analytics', 'Top Items']] as const).map(([tab, label]) => (
          <button key={tab} onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab ? 'border-gold text-gold' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}>
            {label}
          </button>
        ))}
      </div>

      {/* Sales Log Tab */}
      {activeTab === 'list' && (
        <>
          {/* Granularity toggle + search */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden">
              {(['day', 'week', 'month'] as Granularity[]).map(g => (
                <button key={g}
                  onClick={() => { setGranularity(g); setSelectedSale(null); setSelectedPeriodKey(null) }}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors capitalize ${
                    granularity === g ? 'bg-gold text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
                  }`}>
                  {g}
                </button>
              ))}
            </div>
            {granularity === 'day' && (
              <div className="relative max-w-xs">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input value={search} onChange={e => setSearch(e.target.value)}
                  placeholder="Search days…"
                  className="w-full pl-8 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
              </div>
            )}
          </div>

          {/* Split panel */}
          <div className="flex gap-4 items-start">

            {/* Left panel */}
            <div className={`${(selectedSale || selectedPeriodKey) ? 'w-[360px] shrink-0' : 'w-full'}`}>

              {/* Day mode table */}
              {granularity === 'day' && (
                <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b border-gray-100">
                      <tr>
                        <th className="px-4 py-3 text-left font-medium text-gray-500 cursor-pointer" onClick={() => toggleSort('date')}>
                          Date <SortIcon col="date" />
                        </th>
                        <th className="px-3 py-3 text-right font-medium text-gray-500 cursor-pointer" onClick={() => toggleSort('revenue')}>
                          Revenue <SortIcon col="revenue" />
                        </th>
                        <th className="px-3 py-3 text-right font-medium text-gray-500 hidden sm:table-cell cursor-pointer" onClick={() => toggleSort('covers')}>
                          Covers <SortIcon col="covers" />
                        </th>
                        <th className="px-3 py-3 text-right font-medium text-gray-500 hidden md:table-cell cursor-pointer" onClick={() => toggleSort('items')}>
                          Portions <SortIcon col="items" />
                        </th>
                        <th className="px-3 py-3 w-16" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {loading && (
                        <tr><td colSpan={5} className="text-center py-12 text-gray-400">Loading…</td></tr>
                      )}
                      {!loading && displayed.length === 0 && (
                        <tr>
                          <td colSpan={5} className="text-center py-12">
                            <div className="text-gray-400 mb-3">No sales recorded for this period</div>
                            <button onClick={() => setShowAdd(true)}
                              className="inline-flex items-center gap-2 px-4 py-2 bg-gold text-white rounded-lg text-sm hover:bg-[#a88930]">
                              <Plus size={14} /> Add Sales Day
                            </button>
                          </td>
                        </tr>
                      )}
                      {displayed.map(sale => {
                        const rev      = Number(sale.totalRevenue)
                        const portions = sale.lineItems.reduce((s, l) => s + l.qtySold, 0)
                        const isSelected = selectedSale?.id === sale.id
                        return (
                          <tr key={sale.id}
                            onClick={() => setSelectedSale(isSelected ? null : sale)}
                            className={`cursor-pointer transition-colors ${isSelected ? 'bg-amber-50' : 'hover:bg-gray-50'}`}>
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-2">
                                <span className="font-medium text-gray-800">{fmtDate(sale.date)}</span>
                                {sale.revenueCenter && (
                                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-gray-100 text-gray-600">
                                    <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: rcHex(sale.revenueCenter.color) }} />
                                    {sale.revenueCenter.name}
                                  </span>
                                )}
                              </div>
                              <div className="text-xs text-gray-400">{fmtDay(sale.date)}{sale.notes ? ` · ${sale.notes}` : ''}</div>
                            </td>
                            <td className="px-3 py-3 text-right">
                              <div className="font-semibold text-gray-900">{formatCurrency(rev)}</div>
                              <div className="text-xs text-gray-400">{Math.round(Number(sale.foodSalesPct) * 100)}% food</div>
                            </td>
                            <td className="px-3 py-3 text-right hidden sm:table-cell">
                              <div className="font-medium text-gray-700">{sale.covers ?? '—'}</div>
                            </td>
                            <td className="px-3 py-3 text-right hidden md:table-cell">
                              <div className="font-medium text-gray-700">{portions > 0 ? portions : '—'}</div>
                            </td>
                            <td className="px-3 py-3" onClick={e => e.stopPropagation()}>
                              <div className="flex items-center gap-1 justify-end">
                                <button onClick={() => setEditSale(sale)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gold">
                                  <Pencil size={13} />
                                </button>
                                <button onClick={() => setDeleteId(sale.id)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-red-500">
                                  <Trash2 size={13} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Week / Month mode list */}
              {granularity !== 'day' && (
                <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
                  {loading && <div className="py-12 text-center text-gray-400">Loading…</div>}
                  {!loading && periodRows.length === 0 && (
                    <div className="py-12 text-center text-gray-400">No sales data for this period</div>
                  )}
                  {periodRows.map(period => {
                    const isSelected = selectedPeriodKey === period.key
                    return (
                      <div key={period.key}
                        onClick={() => setSelectedPeriodKey(isSelected ? null : period.key)}
                        className={`flex items-center gap-3 px-4 py-3.5 border-b border-gray-50 last:border-0 cursor-pointer transition-colors ${isSelected ? 'bg-amber-50' : 'hover:bg-gray-50'}`}>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className="text-sm font-medium text-gray-800">{period.label}</span>
                            <PeriodBadge badge={period.badge} text={period.badgeText} />
                          </div>
                          {period.totalRevenue > 0 && (
                            <div className="text-xs text-gray-400">
                              {formatCurrency(period.totalRevenue)} · {Math.round(period.foodSalesPct * 100)}% food
                            </div>
                          )}
                        </div>
                        {period.covers != null && period.covers > 0 && (
                          <div className="text-right shrink-0">
                            <div className="text-sm font-semibold text-gray-700">{period.covers}</div>
                            <div className="text-[10px] text-gray-400">covers</div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Right panel */}
            {(selectedSale || selectedPeriodKey) && (
              <div className="flex-1 min-w-0">

                {/* Day detail */}
                {selectedSale && (() => {
                  const sale = selectedSale
                  const revenue     = Number(sale.totalRevenue)
                  const foodSalesAmt = revenue * Number(sale.foodSalesPct)
                  const totalSold   = sale.lineItems.reduce((s, li) => s + li.qtySold, 0)
                  const avgPerCover = sale.covers && sale.covers > 0 ? revenue / sale.covers : null
                  return (
                    <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
                      <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-gray-100">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-gray-900">{fmtDate(sale.date)}</span>
                            {sale.revenueCenter && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-gray-100 text-gray-700">
                                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: rcHex(sale.revenueCenter.color) }} />
                                {sale.revenueCenter.name}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-gray-400">{fmtDay(sale.date)}</div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <button onClick={() => { setEditSale(sale); setSelectedSale(null) }}
                            className="flex items-center gap-1 px-2.5 py-1.5 border border-gray-200 rounded-lg text-xs text-gray-600 hover:bg-gray-50">
                            <Pencil size={11} /> Edit
                          </button>
                          <button onClick={() => setSelectedSale(null)}
                            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400"><X size={16} /></button>
                        </div>
                      </div>
                      <div className="px-4 py-4 space-y-4">
                        <div className="grid grid-cols-3 gap-3">
                          <div className="bg-gray-50 rounded-xl p-3 text-center">
                            <div className="text-lg font-bold text-gray-900">{formatCurrency(revenue)}</div>
                            <div className="text-[10px] text-gray-500 mt-0.5 uppercase tracking-wide">Revenue</div>
                          </div>
                          <div className="bg-gray-50 rounded-xl p-3 text-center">
                            <div className="text-lg font-bold text-gray-900">{sale.covers ?? '—'}</div>
                            <div className="text-[10px] text-gray-500 mt-0.5 uppercase tracking-wide">Covers</div>
                          </div>
                          <div className="bg-gray-50 rounded-xl p-3 text-center">
                            <div className="text-lg font-bold text-gray-900">{avgPerCover ? formatCurrency(avgPerCover) : '—'}</div>
                            <div className="text-[10px] text-gray-500 mt-0.5 uppercase tracking-wide">Avg/Cover</div>
                          </div>
                        </div>
                        <div className="text-xs text-gray-500">
                          Food sales: <span className="font-medium text-gray-700">{formatCurrency(foodSalesAmt)}</span>
                          <span className="mx-1">·</span>{Math.round(Number(sale.foodSalesPct) * 100)}%
                          <span className="mx-1">·</span>{totalSold} portions
                        </div>
                        {sale.notes && (
                          <div className="bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 text-sm text-amber-800">{sale.notes}</div>
                        )}
                        {sale.lineItems.length > 0 ? (
                          <div>
                            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Items sold</div>
                            <div className="divide-y divide-gray-50 border border-gray-100 rounded-xl overflow-hidden max-h-80 overflow-y-auto">
                              {sale.lineItems.map(li => {
                                const lineRevenue = li.recipe.menuPrice ? Number(li.recipe.menuPrice) * li.qtySold : null
                                return (
                                  <div key={li.id} className="flex items-center gap-3 px-3 py-2.5">
                                    <div className="flex-1 min-w-0">
                                      <div className="text-sm font-medium text-gray-800 truncate">{li.recipe.name}</div>
                                      {li.recipe.category && <div className="text-xs text-gray-400">{li.recipe.category.name}</div>}
                                    </div>
                                    <div className="text-right shrink-0">
                                      <div className="text-sm font-semibold text-gray-800">×{li.qtySold}</div>
                                      {lineRevenue && <div className="text-xs text-gray-400">{formatCurrency(lineRevenue)}</div>}
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        ) : (
                          <div className="text-center py-4 text-sm text-gray-400">No menu items recorded</div>
                        )}
                      </div>
                    </div>
                  )
                })()}

                {/* Period detail */}
                {selectedPeriodKey && (() => {
                  const period = periodRows.find(p => p.key === selectedPeriodKey)
                  if (!period) return null
                  const foodSalesAmt = period.totalRevenue * period.foodSalesPct
                  return (
                    <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
                      <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-gray-100">
                        <div>
                          <div className="text-sm font-semibold text-gray-900">{period.label}</div>
                          <div className="mt-0.5">
                            <PeriodBadge badge={period.badge} text={period.badgeText} />
                          </div>
                        </div>
                        <button onClick={() => setSelectedPeriodKey(null)}
                          className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400"><X size={16} /></button>
                      </div>
                      <div className="px-4 py-4 space-y-4">
                        {period.totalRevenue > 0 && (
                          <div className="grid grid-cols-3 gap-3">
                            <div className="bg-gray-50 rounded-xl p-3 text-center">
                              <div className="text-lg font-bold text-gray-900">{formatCurrency(period.totalRevenue)}</div>
                              <div className="text-[10px] text-gray-500 mt-0.5 uppercase tracking-wide">Revenue</div>
                            </div>
                            <div className="bg-gray-50 rounded-xl p-3 text-center">
                              <div className="text-lg font-bold text-gray-900">{formatCurrency(foodSalesAmt)}</div>
                              <div className="text-[10px] text-gray-500 mt-0.5 uppercase tracking-wide">Food Sales</div>
                            </div>
                            <div className="bg-gray-50 rounded-xl p-3 text-center">
                              <div className="text-lg font-bold text-gray-900">{period.covers ?? '—'}</div>
                              <div className="text-[10px] text-gray-500 mt-0.5 uppercase tracking-wide">Covers</div>
                            </div>
                          </div>
                        )}
                        {period.badge === 'not-available' && (
                          <div className="text-center py-4 text-sm text-gray-400">No sales data for this period</div>
                        )}
                        {(period.badge === 'weekly-import' || period.badge === 'monthly-import') && (
                          <div className="bg-blue-50 border border-blue-100 rounded-lg px-3 py-2 text-xs text-blue-700">
                            Imported as {period.badge === 'weekly-import' ? 'Weekly' : 'Monthly'} — no per-day breakdown available.
                          </div>
                        )}
                        {period.badge !== 'weekly-import' && period.badge !== 'monthly-import' && period.dailySales.length > 0 && (
                          <div>
                            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Day breakdown</div>
                            <div className="divide-y divide-gray-50 border border-gray-100 rounded-xl overflow-hidden">
                              {(() => {
                                const days: string[] = []
                                const cur = new Date(period.startDate)
                                const pEnd = new Date(period.endDate)
                                while (cur <= pEnd) { days.push(toISO(cur)); cur.setDate(cur.getDate() + 1) }
                                return days.map(day => {
                                  const daySale = period.dailySales.find(s => s.date.slice(0, 10) === day)
                                  return (
                                    <div key={day} className="flex items-center justify-between px-3 py-2">
                                      <span className="text-sm text-gray-700">{fmtDate(day)}</span>
                                      {daySale
                                        ? <span className="text-sm font-medium text-gray-900">{formatCurrency(Number(daySale.totalRevenue))}</span>
                                        : <span className="text-sm text-gray-300">—</span>
                                      }
                                    </div>
                                  )
                                })
                              })()}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })()}

              </div>
            )}
          </div>
        </>
      )}

      {/* Top Items Tab */}
      {activeTab === 'analytics' && (
        <div className="space-y-4">
          {topItems.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-100 p-12 text-center text-gray-400">
              No sales data for this period — add sales days with menu item quantities to see analytics.
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
                <TrendingUp size={15} className="text-gray-400" />
                <span className="text-sm font-semibold text-gray-700">Top selling items</span>
                <span className="text-xs text-gray-400 ml-auto">{startDate} — {endDate}</span>
              </div>
              <div className="divide-y divide-gray-50">
                {topItems.map((item, i) => {
                  const maxQty = topItems[0]?.qty ?? 1
                  const pct = (item.qty / maxQty) * 100
                  return (
                    <div key={item.name} className="px-4 py-3 flex items-center gap-3">
                      <div className="w-6 text-xs font-bold text-gray-400 shrink-0">{i + 1}</div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-gray-800 truncate">{item.name}</div>
                        <div className="h-1.5 bg-gray-100 rounded-full mt-1.5 overflow-hidden">
                          <div className="h-full bg-gold/100 rounded-full transition-all" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-sm font-semibold text-gray-900">{item.qty.toLocaleString()} sold</div>
                        {item.revenue > 0 && <div className="text-xs text-gray-400">{formatCurrency(item.revenue)}</div>}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Modals */}
      {(showAdd || editSale) && (
        <SaleForm
          initial={editSale}
          menuRecipes={menuRecipes}
          revenueCenters={revenueCenters}
          defaultRcId={activeRcId}
          onSave={handleSave}
          onCancel={() => { setShowAdd(false); setEditSale(null) }}
        />
      )}

      {showImport && (
        <ImportModal menuRecipes={menuRecipes} onImport={handleImport} onClose={() => setShowImport(false)} />
      )}

      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center shrink-0">
                <Trash2 size={18} className="text-red-600" />
              </div>
              <div>
                <h3 className="font-semibold text-gray-900">Delete sales entry?</h3>
                <p className="text-xs text-gray-500 mt-0.5">This cannot be undone.</p>
              </div>
            </div>
            <div className="flex gap-3 mt-4">
              <button onClick={() => setDeleteId(null)}
                className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50">
                Cancel
              </button>
              <button onClick={() => handleDelete(deleteId)}
                className="flex-1 px-4 py-2.5 rounded-xl bg-red-600 text-white text-sm font-medium hover:bg-red-700">
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

```


---

## `src/app/wastage/page.tsx`

```tsx
'use client'
import { useEffect, useState, useCallback } from 'react'
import dynamic from 'next/dynamic'
import { formatCurrency, formatDate, WASTAGE_REASONS, compatibleCountUnits } from '@/lib/utils'
import { CategoryBadge } from '@/components/CategoryBadge'
import { useRc } from '@/contexts/RevenueCenterContext'
import { Plus, X, AlertTriangle } from 'lucide-react'

// Lazy-load recharts — only renders when there are logs to display
const WastageCharts = dynamic(() => import('@/components/wastage/WastageCharts'), { ssr: false, loading: () => null })

interface WastageLog {
  id: string
  date: string
  inventoryItemId: string
  inventoryItem: { itemName: string; category: string; baseUnit: string }
  qtyWasted: number
  unit: string
  reason: string
  costImpact: number
  loggedBy: string
  notes: string | null
}

interface InventoryItem {
  id: string
  itemName: string
  baseUnit: string
  pricePerBaseUnit: number
}

const REASON_COLORS: Record<string, string> = {
  SPOILAGE:       'bg-red-100 text-red-700',
  OVERPRODUCTION: 'bg-orange-100 text-orange-700',
  PREP_TRIM:      'bg-yellow-100 text-yellow-700',
  BURNT:          'bg-gray-100 text-gray-700',
  DROPPED:        'bg-gold/15 text-gold',
  EXPIRED:        'bg-purple-100 text-purple-700',
  STAFF_MEAL:     'bg-green-100 text-green-700',
  UNKNOWN:        'bg-gray-100 text-gray-600',
}


export default function WastagePage() {
  const { activeRcId, activeRc } = useRc()
  const [logs, setLogs] = useState<WastageLog[]>([])
  const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([])
  const [reasonFilter, setReasonFilter] = useState('')
  const [startDate, setStartDate] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 7); return d.toISOString().slice(0, 10) })
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState({
    inventoryItemId: '',
    qtyWasted: '',
    unit: 'g',
    reason: 'UNKNOWN',
    loggedBy: '',
    notes: '',
    date: new Date().toISOString().slice(0, 10),
  })

  const fetchLogs = useCallback(() => {
    const params = new URLSearchParams()
    if (reasonFilter) params.set('reason', reasonFilter)
    if (startDate) params.set('startDate', startDate)
    if (endDate) params.set('endDate', endDate)
    if (activeRcId) {
      params.set('rcId', activeRcId)
      if (activeRc?.isDefault) params.set('isDefault', 'true')
    }
    fetch(`/api/wastage?${params}`).then(r => r.json()).then(setLogs)
  }, [reasonFilter, startDate, endDate, activeRcId, activeRc])

  useEffect(() => { fetchLogs() }, [fetchLogs])
  useEffect(() => {
    fetch('/api/inventory').then(r => r.json()).then(setInventoryItems)
  }, [])

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    await fetch('/api/wastage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, revenueCenterId: activeRcId }),
    })
    setShowAdd(false)
    setForm({ inventoryItemId: '', qtyWasted: '', unit: 'g', reason: 'UNKNOWN', loggedBy: '', notes: '', date: new Date().toISOString().slice(0, 10) })
    fetchLogs()
  }

  const totalCost = logs.reduce((sum, l) => sum + parseFloat(String(l.costImpact)), 0)

  // Preview cost
  const selectedItem = inventoryItems.find(i => i.id === form.inventoryItemId)
  const previewCost = selectedItem && form.qtyWasted
    ? parseFloat(form.qtyWasted) * parseFloat(String(selectedItem.pricePerBaseUnit))
    : 0

  // ── Charts data ────────────────────────────────────────────────────────────

  // Pie: cost by reason
  const byReason = Object.entries(
    logs.reduce((acc, l) => {
      const r = l.reason
      acc[r] = (acc[r] ?? 0) + parseFloat(String(l.costImpact))
      return acc
    }, {} as Record<string, number>)
  )
    .map(([reason, cost]) => ({ reason, cost }))
    .sort((a, b) => b.cost - a.cost)

  // Bar: cost by week (group logs into 7-day buckets)
  const byWeek = (() => {
    const buckets: Record<string, number> = {}
    logs.forEach(l => {
      const d = new Date(l.date)
      // Snap to Monday of that week
      const day = d.getDay()
      const diff = (day === 0 ? -6 : 1 - day)
      d.setDate(d.getDate() + diff)
      const key = d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })
      buckets[key] = (buckets[key] ?? 0) + parseFloat(String(l.costImpact))
    })
    return Object.entries(buckets)
      .map(([week, cost]) => ({ week, cost: parseFloat(cost.toFixed(2)) }))
      .slice(-6)
  })()

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h1 className="text-2xl font-bold text-gray-900">Wastage Log</h1>
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-2 bg-gold text-white px-3 py-2 rounded-lg text-sm hover:bg-[#a88930] transition-colors"
        >
          <Plus size={16} /> Log Wastage
        </button>
      </div>

      {/* Summary */}
      <div className="bg-red-50 border border-red-100 rounded-xl p-4 flex items-center gap-3">
        <AlertTriangle size={20} className="text-red-500 shrink-0" />
        <div>
          <div className="font-semibold text-red-700">Total Wastage Cost (filtered)</div>
          <div className="text-2xl font-bold text-red-800">{formatCurrency(totalCost)}</div>
        </div>
        <div className="ml-auto text-right">
          <div className="text-xs text-red-500">{logs.length} entries</div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-2">
        <select
          value={reasonFilter}
          onChange={e => setReasonFilter(e.target.value)}
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
        >
          <option value="">All Reasons</option>
          {WASTAGE_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={startDate}
            onChange={e => setStartDate(e.target.value)}
            className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
          />
          <span className="text-gray-400 text-sm">to</span>
          <input
            type="date"
            value={endDate}
            onChange={e => setEndDate(e.target.value)}
            className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
          />
        </div>
        {(reasonFilter || startDate || endDate) && (
          <button
            onClick={() => { setReasonFilter(''); setStartDate(''); setEndDate('') }}
            className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1"
          >
            <X size={14} /> Clear
          </button>
        )}
      </div>

      {/* Charts — only show when there's data, recharts loads lazily */}
      {logs.length > 0 && (
        <WastageCharts byReason={byReason} byWeek={byWeek} />
      )}

      {/* Logs Table */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Date</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Item</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 hidden sm:table-cell">Category</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Qty Wasted</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 hidden md:table-cell">Reason</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Cost Impact</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 hidden lg:table-cell">Logged By</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {logs.map(log => (
                <tr key={log.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{formatDate(log.date)}</td>
                  <td className="px-4 py-3 font-medium text-gray-800">{log.inventoryItem.itemName}</td>
                  <td className="px-4 py-3 hidden sm:table-cell">
                    <CategoryBadge category={log.inventoryItem.category} />
                  </td>
                  <td className="px-4 py-3 text-right text-gray-700">
                    {parseFloat(String(log.qtyWasted)).toFixed(1)} {log.unit}
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${REASON_COLORS[log.reason] || 'bg-gray-100 text-gray-600'}`}>
                      {log.reason}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-semibold text-red-600">
                    {formatCurrency(parseFloat(String(log.costImpact)))}
                  </td>
                  <td className="px-4 py-3 text-gray-500 hidden lg:table-cell">{log.loggedBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {logs.length === 0 && (
            <div className="text-center py-12 text-gray-400">No wastage logs found</div>
          )}
        </div>
      </div>

      {/* Add Wastage Modal */}
      {showAdd && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          onClick={() => setShowAdd(false)}
        >
          <div className="absolute inset-0 bg-black/30" />
          <div
            className="relative bg-white rounded-xl p-6 w-full max-w-md shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="font-semibold mb-4 text-lg">Log Wastage</h3>
            <form onSubmit={handleAdd} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Item *</label>
                <select
                  required
                  value={form.inventoryItemId}
                  onChange={e => {
                    const item = inventoryItems.find(i => i.id === e.target.value)
                    setForm(f => ({ ...f, inventoryItemId: e.target.value, unit: item?.baseUnit || 'g' }))
                  }}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                >
                  <option value="">Select item...</option>
                  {inventoryItems.map(item => (
                    <option key={item.id} value={item.id}>{item.itemName} ({item.baseUnit})</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Qty Wasted *</label>
                  <input
                    type="number"
                    required
                    value={form.qtyWasted}
                    onChange={e => setForm(f => ({ ...f, qtyWasted: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                    step="any"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Unit</label>
                  <select
                    value={form.unit}
                    onChange={e => setForm(f => ({ ...f, unit: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold bg-white"
                  >
                    {(compatibleCountUnits(inventoryItems.find(i => i.id === form.inventoryItemId)?.baseUnit ?? 'each')).map(u => (
                      <option key={u}>{u}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Reason</label>
                <select
                  value={form.reason}
                  onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                >
                  {WASTAGE_REASONS.map(r => <option key={r}>{r}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Date</label>
                  <input
                    type="date"
                    value={form.date}
                    onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Logged By</label>
                  <input
                    value={form.loggedBy}
                    onChange={e => setForm(f => ({ ...f, loggedBy: e.target.value }))}
                    placeholder="Name"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Notes</label>
                <textarea
                  value={form.notes}
                  onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                  rows={2}
                />
              </div>
              {previewCost > 0 && (
                <div className="bg-red-50 rounded-lg p-3 text-sm">
                  <span className="text-red-600 font-medium">Estimated cost impact: </span>
                  <span className="font-bold text-red-700">{formatCurrency(previewCost)}</span>
                </div>
              )}
              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAdd(false)}
                  className="flex-1 border border-gray-200 rounded-lg py-2 text-sm hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="flex-1 bg-red-600 text-white rounded-lg py-2 text-sm hover:bg-red-700"
                >
                  Log Wastage
                </button>
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

## `src/app/variance/page.tsx`

```tsx
'use client'
import { useEffect, useState, useMemo } from 'react'
import Link from 'next/link'
import { Activity, ArrowRight } from 'lucide-react'
import { PageHead } from '@/components/layout/PageHead'
import { formatCurrency } from '@/lib/utils'

interface VarianceRow {
  inventoryItemId: string
  itemName: string
  category: string
  baseUnit: string
  theoreticalQty: number
  countedQty: number | null
  varianceQty: number | null
  varianceValue: number | null
  pricePerBaseUnit: number
}

interface VarianceResp {
  items: VarianceRow[]
  totalVarianceValue: number
  startDate?: string
  endDate?: string
}

export default function VariancePage() {
  const [data, setData] = useState<VarianceResp | null>(null)
  const [range, setRange] = useState<7 | 14 | 30>(7)

  useEffect(() => {
    const end = new Date()
    const start = new Date(); start.setDate(start.getDate() - range)
    const qs = `?startDate=${start.toISOString().slice(0,10)}&endDate=${end.toISOString().slice(0,10)}`
    fetch(`/api/reports/theoretical-usage${qs}`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(json => json && setData(json))
  }, [range])

  const top = useMemo(() => {
    const items = data?.items ?? []
    return [...items]
      .filter(i => i.varianceValue !== null && Math.abs(i.varianceValue) > 0.01)
      .sort((a, b) => Math.abs(b.varianceValue ?? 0) - Math.abs(a.varianceValue ?? 0))
      .slice(0, 15)
  }, [data])

  return (
    <div>
      <PageHead
        crumbs={<><Activity size={12} /> INSIGHTS / VARIANCE</>}
        title="Variance"
        sub={data ? <>Theoretical vs counted over the last <b>{range}d</b> · total drift <b className={data.totalVarianceValue < 0 ? 'text-red-text' : ''}>{formatCurrency(data.totalVarianceValue)}</b></> : <>Loading…</>}
        actions={
          <div className="inline-flex bg-paper border border-line rounded-[9px] p-[3px]">
            {([7, 14, 30] as const).map(n => (
              <button key={n} onClick={() => setRange(n)}
                className={`font-mono text-[11px] px-3 py-1.5 rounded-[6px] tracking-[0] transition-colors ${
                  range === n ? 'bg-ink text-paper' : 'text-ink-3 hover:text-ink-2'
                }`}>
                {n}d
              </button>
            ))}
          </div>
        }
      />

      {!data ? null : top.length === 0 ? (
        <div className="bg-paper border border-line rounded-[12px] p-12 text-center">
          <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-green-text">No variance</p>
          <p className="text-[14px] text-ink-2 mt-2 max-w-md mx-auto">
            Counts and theoretical depletion are in sync. Either your sales/recipe data is sparse, or you&apos;re running a tight kitchen.
          </p>
        </div>
      ) : (
        <section className="bg-paper border border-line rounded-[12px] overflow-hidden">
          <header className="flex items-center justify-between px-[18px] py-3 border-b border-line bg-bg-2">
            <h3 className="text-[13px] font-semibold tracking-[-0.01em]">
              Top variance lines <span className="font-mono text-[10.5px] text-ink-3 font-normal">· top {top.length}</span>
            </h3>
            <span className="font-mono text-[10.5px] text-ink-3">SORTED BY |Δ$|</span>
          </header>
          <div className="grid grid-cols-[1.6fr_1fr_1fr_auto_auto] gap-3 px-[18px] py-2.5 bg-bg-2 border-b border-line font-mono text-[10.5px] uppercase tracking-[0.02em] text-ink-3">
            <span>Item</span>
            <span className="text-right">Theoretical</span>
            <span className="text-right">Counted</span>
            <span className="text-right">Δ qty</span>
            <span className="text-right">Δ $</span>
          </div>
          {top.map(r => {
            const tone = (r.varianceValue ?? 0) < -5 ? 'bad' : (r.varianceValue ?? 0) > 5 ? 'warn' : 'neutral'
            const toneCls = tone === 'bad' ? 'text-red-text' : tone === 'warn' ? 'text-gold-2' : 'text-ink-3'
            return (
              <Link key={r.inventoryItemId} href={`/inventory?highlight=${r.inventoryItemId}`}
                className="grid grid-cols-[1.6fr_1fr_1fr_auto_auto] gap-3 px-[18px] py-3 border-b border-line last:border-0 items-center hover:bg-bg-2/40 transition-colors">
                <div className="min-w-0">
                  <div className="text-[13px] text-ink font-medium tracking-[-0.005em] truncate">{r.itemName}</div>
                  <div className="font-mono text-[10.5px] text-ink-3 mt-0.5">{r.category} · {r.baseUnit} · ${r.pricePerBaseUnit.toFixed(4)}/u</div>
                </div>
                <div className="font-mono text-[12px] text-ink-2 text-right tabular-nums">{r.theoreticalQty.toFixed(1)}</div>
                <div className="font-mono text-[12px] text-ink-2 text-right tabular-nums">{r.countedQty?.toFixed(1) ?? '—'}</div>
                <div className={`font-mono text-[12px] text-right tabular-nums ${toneCls}`}>
                  {r.varianceQty !== null ? (r.varianceQty > 0 ? '+' : '') + r.varianceQty.toFixed(1) : '—'}
                </div>
                <div className={`font-mono text-[13px] font-semibold text-right tabular-nums ${toneCls} min-w-[80px] inline-flex items-center justify-end gap-1`}>
                  {r.varianceValue !== null ? (r.varianceValue > 0 ? '+' : '−') + '$' + Math.abs(r.varianceValue).toFixed(0) : '—'}
                  <ArrowRight size={11} className="text-ink-4" />
                </div>
              </Link>
            )
          })}
        </section>
      )}

      <div className="mt-5 font-mono text-[10.5px] text-ink-3 tracking-wide text-center">
        Variance = theoretical depletion from sales (recipe × qty sold) minus counted on-hand.
        Negative Δ$ means short (eat into margin); positive means over (likely uncounted waste).
      </div>
    </div>
  )
}

```


---

## `src/app/signals/page.tsx`

```tsx
'use client'
import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { Zap, Check, Clock, X, RefreshCw, AlertTriangle, AlertCircle, Info } from 'lucide-react'
import { PageHead } from '@/components/layout/PageHead'
import { formatCurrency } from '@/lib/utils'

interface Signal {
  id: string
  fingerprint: string
  rule: string
  severity: 'critical' | 'warn' | 'info'
  title: string
  body: string
  verbLabel: string
  verbHref: string
  impactValue: number | null
  itemId: string | null
  recipeId: string | null
  status: 'OPEN' | 'APPLIED' | 'SNOOZED' | 'DISMISSED'
  createdAt: string
}

interface SignalsData {
  signals: Signal[]
  counts: { open: number; applied: number; critical: number }
}

export default function SignalsPage() {
  const [data, setData] = useState<SignalsData | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const json: SignalsData = await fetch('/api/signals', { cache: 'no-store' }).then(r => r.json())
      setData(json)
    } catch {}
  }, [])

  useEffect(() => { load() }, [load])

  const refresh = async () => {
    setRefreshing(true)
    try {
      await fetch('/api/signals/refresh', { method: 'POST' })
      await load()
    } finally { setRefreshing(false) }
  }

  const act = async (id: string, action: 'apply' | 'snooze' | 'dismiss') => {
    setBusyId(id)
    try {
      await fetch('/api/signals', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id], action }),
      })
      await load()
    } finally { setBusyId(null) }
  }

  const open    = data?.signals.filter(s => s.status === 'OPEN')    ?? []
  const applied = data?.signals.filter(s => s.status === 'APPLIED') ?? []

  return (
    <div>
      <PageHead
        crumbs={<span>INSIGHTS / SIGNALS</span>}
        title="Signals"
        sub={
          data
            ? <>
                <b>{data.counts.open}</b> open
                {data.counts.critical > 0 && <> · <b className="text-red-text">{data.counts.critical} critical</b></>}
                {data.counts.applied > 0 && <> · <b>{data.counts.applied}</b> applied</>}
              </>
            : <>Loading…</>
        }
        actions={
          <button
            onClick={refresh}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 bg-ink text-paper px-4 py-[9px] rounded-[9px] text-[13px] font-medium hover:bg-[#18181b] disabled:opacity-60 transition-colors"
          >
            <RefreshCw size={13} className={`text-gold ${refreshing ? 'animate-spin' : ''}`} /> {refreshing ? 'Refreshing…' : 'Refresh signals'}
          </button>
        }
      />

      {!data ? null : (open.length + applied.length === 0) ? (
        <div className="bg-paper border border-line rounded-[12px] p-12 text-center">
          <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-green-text">All quiet</p>
          <p className="text-[14px] text-ink-2 mt-2 max-w-md mx-auto">
            No active signals. Run <b>Refresh</b> to re-evaluate the rules
            (price spikes, recipe drift, count overdue, wastage, menu engineering).
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {open.length > 0 && (
            <section>
              <h2 className="font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3 mb-2">Open · {open.length}</h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {open.map(s => (
                  <SignalCard key={s.id} signal={s} busy={busyId === s.id} onAct={act} />
                ))}
              </div>
            </section>
          )}
          {applied.length > 0 && (
            <section>
              <h2 className="font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3 mb-2">Applied · {applied.length}</h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {applied.map(s => (
                  <SignalCard key={s.id} signal={s} busy={busyId === s.id} onAct={act} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      <div className="mt-5 font-mono text-[10.5px] text-ink-3 tracking-wide text-center">
        5 starter rules: price spikes · recipe drift · count overdue · wastage spikes · menu engineering
      </div>
    </div>
  )
}

function SignalCard({ signal, busy, onAct }: {
  signal: Signal; busy: boolean; onAct: (id: string, action: 'apply' | 'snooze' | 'dismiss') => void
}) {
  const sev = signal.severity
  const Icon = sev === 'critical' ? AlertTriangle : sev === 'warn' ? AlertCircle : Info
  const iconCls = sev === 'critical' ? 'bg-red-soft text-red-text'
    : sev === 'warn' ? 'bg-gold-soft text-gold-2'
    : 'bg-blue-soft text-blue-text'
  const isApplied = signal.status === 'APPLIED'

  return (
    <div className={`bg-paper border rounded-[12px] p-5 transition-opacity ${isApplied ? 'opacity-70 border-line' : 'border-line'}`}>
      <header className="flex items-start gap-3 mb-3">
        <div className={`w-9 h-9 rounded-[9px] grid place-items-center shrink-0 ${iconCls}`}>
          <Icon size={15} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold tracking-[-0.015em] text-ink leading-tight">{signal.title}</div>
          <div className="font-mono text-[10.5px] text-ink-3 mt-1 tracking-[0.02em] uppercase">
            {signal.rule.replaceAll('_', ' ')}
            {signal.impactValue !== null && signal.impactValue > 0 && (
              <> · <span className="text-gold-2 normal-case tracking-normal font-semibold">{formatCurrency(signal.impactValue)} est.</span></>
            )}
          </div>
        </div>
        {isApplied && (
          <span className="font-mono text-[10px] uppercase tracking-[0.04em] bg-green-soft text-green-text px-2 py-0.5 rounded-full font-semibold">
            Applied
          </span>
        )}
      </header>

      <p className="text-[13px] text-ink-2 leading-[1.5] tracking-[-0.005em] mb-4">
        {signal.body}
      </p>

      <div className="flex items-center justify-between gap-2">
        <Link href={signal.verbHref}
          className="inline-flex items-center gap-1.5 bg-ink text-paper px-3 py-1.5 rounded-[8px] text-[12px] font-medium hover:bg-[#18181b] transition-colors">
          {signal.verbLabel} →
        </Link>
        <div className="flex items-center gap-1">
          {!isApplied && (
            <button onClick={() => onAct(signal.id, 'apply')} disabled={busy}
              title="Mark applied"
              className="w-8 h-8 rounded-md grid place-items-center text-ink-3 hover:text-ink hover:bg-bg-2 disabled:opacity-50 transition-colors">
              <Check size={14} />
            </button>
          )}
          <button onClick={() => onAct(signal.id, 'snooze')} disabled={busy}
            title="Snooze 24h"
            className="w-8 h-8 rounded-md grid place-items-center text-ink-3 hover:text-ink hover:bg-bg-2 disabled:opacity-50 transition-colors">
            <Clock size={14} />
          </button>
          <button onClick={() => onAct(signal.id, 'dismiss')} disabled={busy}
            title="Dismiss"
            className="w-8 h-8 rounded-md grid place-items-center text-ink-3 hover:text-ink hover:bg-bg-2 disabled:opacity-50 transition-colors">
            <X size={14} />
          </button>
        </div>
      </div>
    </div>
  )
}

```


---

## `src/app/pass/page.tsx`

```tsx
'use client'
import { useEffect, useState, useMemo } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, Mail, Activity, Zap, Clock,
  ArrowRight, ClipboardList,
} from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { useUser } from '@/contexts/UserContext'
import { formatCurrency } from '@/lib/utils'
import { SubNav } from '@/components/layout/SubNav'
import { PageHead } from '@/components/layout/PageHead'

// ── Types ───────────────────────────────────────────────────────────────────

interface DashboardData {
  totalInventoryValue: number
  weeklyWastageCost: number
  outOfStockCount: number
  outOfStockItems: Array<{ id: string; itemName: string; category: string; lastValue: number }>
  estimatedFoodCostPct: number
  weeklyRevenue: number
  weeklyPurchaseCost: number
}

interface KPIs {
  awaitingApprovalCount: number
  priceAlertCount: number
  recentApprovalsCount: number
}

interface CostChromeData {
  foodCostPct: number | null
  targetPct: number
  variance7d: number | null
  onHand: number
}

interface PrepItem {
  id: string
  name: string
  category: string
  unit: string
  onHand: number
  parLevel: number
  priority: '911' | 'NEEDED_TODAY' | 'LATER'
  suggestedQty: number
}

interface CountSession {
  id: string
  label: string
  sessionDate: string
  startedAt: string
  finalizedAt: string | null
  countedBy: string
  status: string
}

interface AttnItem {
  id: string
  kind: 'price' | 'invoice' | 'variance' | 'count'
  icon: typeof AlertTriangle
  iconTint: 'red' | 'amber' | 'blue' | 'green'
  title: React.ReactNode
  meta: string
  cost: { value: string; sub: string; tint?: 'bad' | 'warn' | 'ok' }
  ctaHref: string
  ctaLabel: string
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function PassPage() {
  const { user } = useUser()
  const { activeRcId, activeRc } = useRc()
  const isDefaultActive = activeRc?.isDefault ?? false
  const [dashboard, setDashboard] = useState<DashboardData | null>(null)
  const [chrome, setChrome] = useState<CostChromeData | null>(null)
  const [inboxKpis, setInboxKpis] = useState<KPIs | null>(null)
  const [prepItems, setPrepItems] = useState<PrepItem[]>([])
  const [countSessions, setCountSessions] = useState<CountSession[]>([])
  const [priceAlertCount, setPriceAlertCount] = useState<number>(0)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const qs = activeRcId ? `?rcId=${activeRcId}&isDefault=${isDefaultActive}` : ''
        const [d, c, k, p, s, a] = await Promise.all([
          fetch(`/api/reports/dashboard${qs}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
          fetch(`/api/insights/cost-chrome${activeRcId ? `?rcId=${activeRcId}` : ''}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
          fetch(`/api/invoices/kpis${qs}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
          fetch('/api/prep/items', { cache: 'no-store' }).then(r => r.ok ? r.json() : []),
          fetch('/api/count/sessions', { cache: 'no-store' }).then(r => r.ok ? r.json() : []),
          fetch('/api/invoices/alerts', { cache: 'no-store' }).then(r => r.ok ? r.json() : { priceAlerts: [] }),
        ])
        if (cancelled) return
        if (d) setDashboard(d)
        if (c) setChrome(c)
        if (k) setInboxKpis(k)
        if (Array.isArray(p)) setPrepItems(p)
        if (Array.isArray(s)) setCountSessions(s)
        if (a?.priceAlerts) setPriceAlertCount(a.priceAlerts.length)
      } catch { /* swallow */ }
    }
    load()
    const t = setInterval(load, 60_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [activeRcId, isDefaultActive])

  // ── Attention queue (derived) ────────────────────────────────────────────
  const attn = useMemo<AttnItem[]>(() => {
    const items: AttnItem[] = []
    if (priceAlertCount > 0) {
      items.push({
        id: 'price-alerts',
        kind: 'price',
        icon: AlertTriangle,
        iconTint: 'red',
        title: <><b>{priceAlertCount}</b> active price {priceAlertCount === 1 ? 'alert' : 'alerts'} — review impact on recipes</>,
        meta: 'PRICE ALERTS · open Inbox to acknowledge',
        cost: { value: priceAlertCount.toString(), sub: priceAlertCount === 1 ? 'alert' : 'alerts', tint: 'bad' },
        ctaHref: '/invoices',
        ctaLabel: 'Review',
      })
    }
    if (inboxKpis && inboxKpis.awaitingApprovalCount > 0) {
      items.push({
        id: 'invoices-pending',
        kind: 'invoice',
        icon: Mail,
        iconTint: 'amber',
        title: <><b>{inboxKpis.awaitingApprovalCount}</b> {inboxKpis.awaitingApprovalCount === 1 ? 'invoice' : 'invoices'} awaiting approval</>,
        meta: 'OCR · ready for review',
        cost: { value: inboxKpis.awaitingApprovalCount.toString(), sub: 'to approve', tint: 'warn' },
        ctaHref: '/invoices',
        ctaLabel: 'Open',
      })
    }
    const criticalPrep = prepItems.filter(p => p.priority === '911').length
    if (criticalPrep > 0) {
      items.push({
        id: 'prep-critical',
        kind: 'count',
        icon: ClipboardList,
        iconTint: 'red',
        title: <><b>{criticalPrep}</b> critical prep {criticalPrep === 1 ? 'item' : 'items'} — depleted or empty</>,
        meta: 'PREP · build before service',
        cost: { value: criticalPrep.toString(), sub: 'critical', tint: 'bad' },
        ctaHref: '/prep',
        ctaLabel: 'Open prep',
      })
    }
    const latestCount = countSessions
      .filter(s => s.status === 'FINALIZED' && s.finalizedAt)
      .sort((a, b) => new Date(b.finalizedAt!).getTime() - new Date(a.finalizedAt!).getTime())[0]
    const daysSinceCount = latestCount
      ? Math.floor((Date.now() - new Date(latestCount.finalizedAt!).getTime()) / 86_400_000)
      : null
    if (daysSinceCount !== null && daysSinceCount > 4) {
      items.push({
        id: 'count-overdue',
        kind: 'variance',
        icon: Activity,
        iconTint: 'amber',
        title: <>Last count was <b>{daysSinceCount}d ago</b> — theoretical-vs-actual drift widens</>,
        meta: 'COUNT · schedule a partial before brunch',
        cost: { value: `${daysSinceCount}d`, sub: 'stale', tint: 'warn' },
        ctaHref: '/count',
        ctaLabel: 'Schedule',
      })
    }
    return items
  }, [priceAlertCount, inboxKpis, prepItems, countSessions])

  const prepSummary = useMemo(() => {
    const active = prepItems.filter(p => p.onHand >= 0 || p.priority !== 'LATER')
    const top = [...prepItems]
      .filter(p => p.priority !== 'LATER')
      .sort((a, b) => (a.priority === '911' ? -1 : 0) - (b.priority === '911' ? -1 : 0))
      .slice(0, 5)
    return { total: active.length, top }
  }, [prepItems])

  const greeting = greetingFor(new Date())
  const firstName = user?.name?.split(' ')[0] ?? user?.email?.split('@')[0] ?? 'there'

  const cutoff = nextServiceCutoff(new Date())
  const remainingMs = cutoff.getTime() - Date.now()
  const remainingH = Math.floor(remainingMs / 3_600_000)
  const remainingM = Math.floor((remainingMs % 3_600_000) / 60_000)

  return (
    <>
      <SubNav
        tabs={[
          { href: '/pass', label: 'Pass' },
          { href: '/prep', label: 'Briefing', icon: <Activity size={14} /> },
          { href: '/cost', label: 'End-of-day', icon: <Clock size={14} /> },
        ]}
      />
      <div className="p-4 md:p-6 md:px-8 max-w-7xl mx-auto w-full">

        <PageHead
          crumbs={<><Clock size={12} /> TODAY / PASS · {fmtCrumbDate(new Date())}</>}
          title={<>Good {greeting}, <em className="not-italic text-gold-2">{firstName}</em>.</>}
          sub={<>
            {greeting === 'morning' ? 'Dinner' : 'Tomorrow'} service in <b>{remainingH}h {remainingM}m</b>
            {dashboard && <> · weekly food sales <b>{formatCurrency(dashboard.weeklyRevenue)}</b></>}
            {attn.length > 0 && <> · <b className="text-red-text">{attn.length} {attn.length === 1 ? 'thing' : 'things'}</b> need you</>}
          </>}
          actions={
            <>
              <Link href="/cost" className="inline-flex items-center gap-1.5 border border-line bg-paper text-ink-2 px-3.5 py-[9px] rounded-[9px] text-[13px] font-medium hover:border-ink-3 transition-colors">
                <Clock size={13} className="text-ink-3" /> End-of-day
              </Link>
              <Link href="/prep" className="inline-flex items-center gap-1.5 bg-ink text-paper px-4 py-[9px] rounded-[9px] text-[13px] font-medium hover:bg-[#18181b] transition-colors">
                <ArrowRight size={13} className="text-gold" /> Start pre-shift
              </Link>
            </>
          }
        />

        <div className="grid gap-3 mb-6" style={{ gridTemplateColumns: '1.4fr 1fr 1fr 1fr' }}>
          <HeroKPI chrome={chrome} dashboard={dashboard} />
          <KPI label="ON HAND"
            value={dashboard ? formatCurrency(dashboard.totalInventoryValue) : '—'}
            delta={<><b>{dashboard?.outOfStockCount ?? 0}</b> out of stock</>}
          />
          <KPI label="PREP TO DO"
            value={prepSummary.total.toString()}
            delta={
              prepSummary.top.filter(p => p.priority === '911').length > 0
                ? <><b className="text-red-text">{prepSummary.top.filter(p => p.priority === '911').length} critical</b></>
                : <>all on par</>
            }
          />
          <KPI label="WASTAGE · 7D"
            value={dashboard ? formatCurrency(dashboard.weeklyWastageCost) : '—'}
            valueClass={dashboard && dashboard.weeklyWastageCost > 0 ? 'text-red-text' : ''}
            delta={<>tracked from <b>waste log</b></>}
          />
        </div>

        <div className="grid gap-5" style={{ gridTemplateColumns: '1fr 320px' }}>
          <div className="space-y-5 min-w-0">

            <section className="bg-paper border border-line rounded-[12px] overflow-hidden">
              <header className="flex items-center justify-between px-[18px] py-3 border-b border-line bg-bg-2">
                <h3 className="text-[13px] font-semibold tracking-[-0.01em] flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${attn.length > 0 ? 'bg-red' : 'bg-green'}`} />
                  Needs you <span className="font-mono text-[10.5px] text-ink-3 font-normal">· {attn.length} {attn.length === 1 ? 'item' : 'items'}</span>
                </h3>
                <span className="font-mono text-[10.5px] text-ink-3">SORTED BY $ IMPACT</span>
              </header>
              {attn.length === 0 ? (
                <div className="px-6 py-10 text-center">
                  <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-green-text">All clear</p>
                  <p className="text-[13px] text-ink-3 mt-1.5">Nothing needs you right now — go cook.</p>
                </div>
              ) : attn.map(a => (
                <AttnRow key={a.id} item={a} />
              ))}
            </section>

            <div className="grid grid-cols-2 gap-4">
              <PrepCard items={prepSummary.top} />
              <CountCard sessions={countSessions} />
            </div>

            <LoopStrip phase={loopPhase(new Date())} weeklyRevenue={dashboard?.weeklyRevenue} />
          </div>

          <aside className="space-y-3.5">
            <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">Right rail · context</div>

            <RailCard icon={<Zap size={11} />} iconTint="amber" title="Signal of the day">
              {priceAlertCount > 0 ? (
                <>You have <b>{priceAlertCount}</b> active price {priceAlertCount === 1 ? 'alert' : 'alerts'} — review whether to bump menu prices or switch suppliers before lunch service.</>
              ) : (
                <>No new signals. Your spine is clean — the live cost chrome above is up to date.</>
              )}
              <div className="flex gap-2 mt-3">
                <Link href="/signals" className="inline-flex items-center gap-1 border border-line bg-paper text-ink-2 px-3 py-1.5 rounded-[7px] text-[12px] font-medium hover:border-ink-3 transition-colors">
                  Open signals
                </Link>
              </div>
            </RailCard>

            <RailCard icon={<Activity size={11} />} iconTint="blue" title="Loop says…">
              {(() => {
                const latest = countSessions.filter(s => s.status === 'FINALIZED' && s.finalizedAt)[0]
                if (!latest) return <>No counts yet. Schedule your first count to start closing the loop.</>
                const days = Math.floor((Date.now() - new Date(latest.finalizedAt!).getTime()) / 86_400_000)
                return <>Counts are <b>{days}d old</b>. Theoretical-vs-actual drift widens until the next reconciliation. Schedule a partial count before service.</>
              })()}
              <div className="flex gap-2 mt-3">
                <Link href="/count" className="inline-flex items-center gap-1 bg-ink text-paper px-3 py-1.5 rounded-[7px] text-[12px] font-medium hover:bg-[#18181b] transition-colors">
                  Schedule count
                </Link>
              </div>
            </RailCard>
          </aside>
        </div>

        <div className="mt-4 flex justify-between font-mono text-[10.5px] text-ink-3 tracking-wide">
          <span>PASS REFRESHES EVERY 60S</span>
          <span><kbd className="font-mono text-[10px] bg-bg-2 border border-line rounded px-1 py-px text-ink-2">⌘R</kbd> REFRESH · <kbd className="font-mono text-[10px] bg-bg-2 border border-line rounded px-1 py-px text-ink-2">⌘/</kbd> SEARCH</span>
        </div>
      </div>
    </>
  )
}

// ── Sub-components ──────────────────────────────────────────────────────────

function HeroKPI({ chrome, dashboard }: { chrome: CostChromeData | null; dashboard: DashboardData | null }) {
  const pct = chrome?.foodCostPct ?? dashboard?.estimatedFoodCostPct ?? null
  const target = chrome?.targetPct ?? 27
  const intStr = pct !== null ? Math.floor(pct).toString() : '—'
  const decimal = pct !== null ? `.${(pct % 1).toFixed(1).slice(2)}%` : ''
  return (
    <div className="bg-ink text-paper rounded-[12px] border border-ink p-5 flex flex-col justify-between min-h-[128px] relative overflow-hidden">
      <div>
        <div className="font-mono text-[10.5px] text-zinc-500 tracking-[0.01em]">FOOD COST · WEEK TO DATE</div>
        <div className="text-[48px] font-semibold tracking-[-0.045em] leading-none mt-2">
          {intStr}<sub className="text-[22px] font-medium text-gold tracking-[-0.02em] align-baseline">{decimal}</sub>
        </div>
      </div>
      <div className="font-mono text-[11px] text-zinc-500 tracking-[0]">
        target <b className="text-paper">{target.toFixed(1)}</b>
        {pct !== null && (
          <> · <span className={pct > target ? 'text-red-300' : 'text-green-400'}>
            {pct > target ? '+' : ''}{(pct - target).toFixed(1)}
          </span> vs target</>
        )}
      </div>
    </div>
  )
}

function KPI({ label, value, delta, valueClass = '' }: { label: string; value: string; delta: React.ReactNode; valueClass?: string }) {
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

function AttnRow({ item }: { item: AttnItem }) {
  const tint = {
    red:   'bg-red-soft text-red-text',
    amber: 'bg-gold-soft text-gold-2',
    blue:  'bg-blue-soft text-blue-text',
    green: 'bg-green-soft text-green-text',
  }[item.iconTint]
  const costTint = item.cost.tint === 'bad' ? 'text-red-text'
    : item.cost.tint === 'warn' ? 'text-gold-2'
    : item.cost.tint === 'ok' ? 'text-green-text' : ''
  const Icon = item.icon
  return (
    <Link href={item.ctaHref} className="grid grid-cols-[48px_1fr_auto_auto] items-center gap-3.5 px-[18px] py-3.5 border-b border-line last:border-0 cursor-pointer hover:bg-bg-2/40 transition-colors">
      <div className={`w-9 h-9 rounded-[9px] grid place-items-center shrink-0 ${tint}`}>
        <Icon size={16} />
      </div>
      <div>
        <div className="text-[14px] font-medium tracking-[-0.01em] text-ink [&_b]:font-semibold [&_b]:text-red-text">{item.title}</div>
        <div className="font-mono text-[10.5px] text-ink-3 mt-1 tracking-[0]">{item.meta}</div>
      </div>
      <div className={`text-right font-mono text-[13.5px] font-semibold tracking-[-0.01em] ${costTint}`}>
        {item.cost.value}
        <small className="block font-normal text-ink-3 font-mono text-[10.5px] mt-0.5">{item.cost.sub}</small>
      </div>
      <button className="font-mono text-[11px] px-3 py-1.5 rounded-full bg-ink text-paper font-medium hover:bg-[#27272a] transition-colors">
        {item.ctaLabel}
      </button>
    </Link>
  )
}

function PrepCard({ items }: { items: PrepItem[] }) {
  return (
    <div className="bg-paper border border-line rounded-[12px] p-5">
      <header className="flex items-center justify-between mb-3">
        <h3 className="text-[15px] font-semibold tracking-[-0.015em]">
          Today&apos;s prep <span className="font-mono text-[10.5px] text-ink-3 font-normal">· {items.length} {items.length === 1 ? 'card' : 'cards'}</span>
        </h3>
        <Link href="/prep" className="font-mono text-[10.5px] text-gold-2 border-b border-dashed border-current">Open prep →</Link>
      </header>
      {items.length === 0 ? (
        <p className="text-[13px] text-ink-3 py-4 text-center">No prep needed today.</p>
      ) : items.map(it => {
        const pct = it.parLevel > 0 ? Math.min(100, (it.onHand / it.parLevel) * 100) : 100
        const tone = it.priority === '911' ? 'bad' : it.priority === 'NEEDED_TODAY' ? 'warn' : 'ok'
        return (
          <div key={it.id} className="grid grid-cols-[1fr_64px_auto] items-center gap-2.5 py-2 border-b border-dashed border-line last:border-0 text-[13px]">
            <div className="font-medium text-ink tracking-[-0.005em] truncate">{it.name}</div>
            <div className="h-[5px] rounded-full bg-bg-2 overflow-hidden">
              <div className={`h-full rounded-full ${tone === 'bad' ? 'bg-red' : tone === 'warn' ? 'bg-gold' : 'bg-green'}`} style={{ width: `${pct}%` }} />
            </div>
            <div className={`font-mono text-[11px] tracking-[0] tabular-nums whitespace-nowrap ${tone === 'bad' ? 'text-red-text' : tone === 'warn' ? 'text-gold-2' : 'text-ink-3'}`}>
              {it.onHand.toFixed(it.onHand % 1 === 0 ? 0 : 1)} / {it.parLevel.toFixed(it.parLevel % 1 === 0 ? 0 : 1)} {it.unit}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function CountCard({ sessions }: { sessions: CountSession[] }) {
  const recent = [...sessions]
    .filter(s => s.status === 'FINALIZED' || s.status === 'IN_PROGRESS')
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .slice(0, 4)
  return (
    <div className="bg-paper border border-line rounded-[12px] p-5">
      <header className="flex items-center justify-between mb-3">
        <h3 className="text-[15px] font-semibold tracking-[-0.015em]">
          Counts <span className="font-mono text-[10.5px] text-ink-3 font-normal">· recent activity</span>
        </h3>
        <Link href="/count" className="font-mono text-[10.5px] text-gold-2 border-b border-dashed border-current">Schedule count →</Link>
      </header>
      {recent.length === 0 ? (
        <p className="text-[13px] text-ink-3 py-4 text-center">No counts yet. Start one →</p>
      ) : recent.map(s => {
        const ref = new Date(s.finalizedAt ?? s.startedAt)
        const days = Math.floor((Date.now() - ref.getTime()) / 86_400_000)
        const tone = days > 4 ? 'bad' : days > 2 ? 'warn' : 'ok'
        return (
          <div key={s.id} className="grid grid-cols-[1fr_auto] items-center gap-2 py-2 border-b border-dashed border-line last:border-0 text-[13px]">
            <div className="min-w-0">
              <div className="font-medium text-ink tracking-[-0.005em] truncate">{s.label || 'Count'}</div>
              <div className="font-mono text-[10.5px] text-ink-3 mt-0.5">{s.countedBy} · {s.status === 'IN_PROGRESS' ? 'in progress' : days === 0 ? 'today' : `${days}d ago`}</div>
            </div>
            <div className={`font-mono text-[11px] tracking-[0] whitespace-nowrap ${tone === 'bad' ? 'text-red-text' : tone === 'warn' ? 'text-gold-2' : 'text-green-text'}`}>
              {s.status === 'IN_PROGRESS' ? 'active' : 'finalized'}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function LoopStrip({ phase, weeklyRevenue }: { phase: number; weeklyRevenue?: number }) {
  const labels = ['01 IN','02 HOLD','03 BUILD','04 PLAN','05 MOVE','06 TRUTH']
  return (
    <div className="bg-ink text-paper rounded-[12px] px-5 py-4 flex items-center gap-5 flex-wrap">
      <span className="font-mono text-[10.5px] text-gold uppercase tracking-[0.04em] font-semibold whitespace-nowrap">↻ THE LOOP</span>
      <div className="text-[12.5px] text-zinc-300 tracking-[-0.005em] flex-1 min-w-[300px] [&_b]:text-paper [&_b]:font-medium">
        You&apos;re at <b>{labels[phase]}</b> — overnight invoices write prices, prep starts, sales drain theoretical, counts close the loop weekly.
        {typeof weeklyRevenue === 'number' && weeklyRevenue > 0 && <> WTD revenue: <b>{formatCurrency(weeklyRevenue)}</b>.</>}
      </div>
      <div className="hidden xl:flex items-center gap-1.5 font-mono text-[11px] text-zinc-500">
        {labels.map((label, i) => (
          <span key={label} className="flex items-center gap-1.5">
            <span className={`px-2.5 py-1 border rounded-full ${i === phase ? 'bg-gold text-ink border-gold font-semibold' : 'border-zinc-800 text-zinc-500'}`}>{label}</span>
            {i < labels.length - 1 && <span className="text-zinc-700">→</span>}
          </span>
        ))}
      </div>
    </div>
  )
}

function RailCard({ icon, iconTint, title, children }: {
  icon: React.ReactNode; iconTint: 'amber' | 'blue' | 'neutral'; title: string; children: React.ReactNode
}) {
  const iconCls = iconTint === 'amber' ? 'bg-gold-soft text-gold-2'
    : iconTint === 'blue' ? 'bg-blue-soft text-blue-text'
    : 'bg-bg-2 text-ink-3'
  return (
    <div className="bg-paper border border-line rounded-[12px] p-4">
      <h4 className="text-[13px] font-semibold tracking-[-0.01em] flex items-center gap-2 mb-2">
        <span className={`w-5 h-5 rounded-md grid place-items-center ${iconCls}`}>{icon}</span>
        {title}
      </h4>
      <div className="text-[13px] leading-[1.5] text-ink-2 tracking-[-0.005em] [&_b]:text-ink [&_b]:font-semibold">
        {children}
      </div>
    </div>
  )
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function greetingFor(d: Date): 'morning' | 'afternoon' | 'evening' {
  const h = d.getHours()
  if (h < 12) return 'morning'
  if (h < 18) return 'afternoon'
  return 'evening'
}

function nextServiceCutoff(d: Date): Date {
  const cutoff = new Date(d)
  if (d.getHours() < 17) {
    cutoff.setHours(17, 0, 0, 0)
  } else {
    cutoff.setDate(d.getDate() + 1)
    cutoff.setHours(11, 0, 0, 0)
  }
  return cutoff
}

function fmtCrumbDate(d: Date): string {
  return d.toLocaleString('en-US', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).toUpperCase()
}

function loopPhase(d: Date): number {
  const h = d.getHours()
  if (h < 6) return 0   // IN — overnight
  if (h < 9) return 1   // HOLD
  if (h < 12) return 2  // BUILD
  if (h < 15) return 3  // PLAN
  if (h < 21) return 4  // MOVE
  return 5              // TRUTH
}

```


---

## `src/app/reports/page.tsx`

```tsx
'use client'
import { useState } from 'react'
import dynamic from 'next/dynamic'
import {
  TrendingUp, Package, ShoppingCart, DollarSign, BarChart2, ChefHat,
} from 'lucide-react'
import { LoadingState } from './report-components'

// ── Lazy-loaded tab components (recharts only loads when tab is opened) ─────────
const OverviewTab   = dynamic(() => import('./tabs/OverviewTab'),   { ssr: false, loading: () => <LoadingState /> })
const SalesTab      = dynamic(() => import('./tabs/SalesTab'),      { ssr: false, loading: () => <LoadingState /> })
const InventoryTab  = dynamic(() => import('./tabs/InventoryTab'),  { ssr: false, loading: () => <LoadingState /> })
const PurchasingTab = dynamic(() => import('./tabs/PurchasingTab'), { ssr: false, loading: () => <LoadingState /> })
const CogsTab       = dynamic(() => import('./tabs/CogsTab'),       { ssr: false, loading: () => <LoadingState /> })
const PrepTab       = dynamic(() => import('./tabs/PrepTab'),       { ssr: false, loading: () => <LoadingState /> })

// ── Constants ─────────────────────────────────────────────────────────────────
const PERIOD_OPTIONS = [
  { label: '30 days', value: 30 },
  { label: '90 days', value: 90 },
  { label: '6 months', value: 180 },
]

const TABS = [
  { id: 'overview',   label: 'Overview',   icon: BarChart2 },
  { id: 'sales',      label: 'Sales',      icon: TrendingUp },
  { id: 'inventory',  label: 'Inventory',  icon: Package },
  { id: 'purchasing', label: 'Purchasing', icon: ShoppingCart },
  { id: 'cogs',       label: 'Cost & COGS',icon: DollarSign },
  { id: 'prep',       label: 'Prep',       icon: ChefHat },
]

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function ReportsPage() {
  const [activeTab, setActiveTab] = useState('overview')
  const [period, setPeriod] = useState(30)

  return (
    <div className="space-y-0">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Analytics</h1>
          <p className="text-sm text-gray-500 mt-0.5">Restaurant performance · costs · inventory · purchasing</p>
        </div>

        {/* Period Selector */}
        <div className="flex items-center gap-0.5 border border-gray-200 rounded-lg p-0.5 bg-white shrink-0">
          {PERIOD_OPTIONS.map(opt => (
            <button key={opt.value} onClick={() => setPeriod(opt.value)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                period === opt.value ? 'bg-gold text-white shadow-sm' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
              }`}>
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="flex items-center gap-1 border-b border-gray-200 mb-6 overflow-x-auto">
        {TABS.map(tab => {
          const Icon = tab.icon
          const active = activeTab === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
                active
                  ? 'border-gold text-gold'
                  : 'border-transparent text-gray-500 hover:text-gray-800 hover:border-gray-300'
              }`}
            >
              <Icon size={14} />
              {tab.label}
            </button>
          )
        })}
      </div>

      {/* Tab Content — each tab chunk loads lazily on first click */}
      <div>
        {activeTab === 'overview'   && <OverviewTab   period={period} />}
        {activeTab === 'sales'      && <SalesTab      period={period} />}
        {activeTab === 'inventory'  && <InventoryTab  period={period} />}
        {activeTab === 'purchasing' && <PurchasingTab period={period} />}
        {activeTab === 'cogs'       && <CogsTab />}
        {activeTab === 'prep'       && <PrepTab />}
      </div>
    </div>
  )
}

```


---

## `src/app/reports/report-components.tsx`

```tsx
'use client'
import { ChevronUp, ChevronDown, Minus } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'

export const CAT_COLORS: Record<string, string> = {
  MEAT: '#ef4444', FISH: '#06b6d4', DAIRY: '#3b82f6', PROD: '#22c55e',
  DRY: '#eab308', BREAD: '#f97316', PREPD: '#8b5cf6', CHM: '#94a3b8',
}

export const CHART_COLORS = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#f97316','#ec4899']

export function pct(n: number | null | undefined, decimals = 1) {
  if (n == null) return '—'
  return `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`
}

export function DeltaBadge({ change, inverse = false }: { change: number | null; inverse?: boolean }) {
  if (change === null) return <span className="text-xs text-gray-400">vs prev</span>
  const good = inverse ? change < 0 : change > 0
  const Icon = change > 0 ? ChevronUp : change < 0 ? ChevronDown : Minus
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${good ? 'text-green-600' : change === 0 ? 'text-gray-400' : 'text-red-500'}`}>
      <Icon size={11} />
      {Math.abs(change).toFixed(1)}%
    </span>
  )
}

export function KpiCard({ label, value, sub, change, inverse = false, accent = 'blue', icon: Icon }:
  { label: string; value: string; sub?: string; change?: number | null; inverse?: boolean; accent?: string; icon?: React.ElementType }) {
  const accentMap: Record<string, string> = {
    blue: 'text-gold', green: 'text-green-600', amber: 'text-amber-500',
    red: 'text-red-500', purple: 'text-purple-600', gray: 'text-gray-600',
  }
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className="text-[11px] font-semibold text-gray-400 tracking-wide uppercase leading-tight">{label}</span>
        {Icon && <Icon size={16} className={accentMap[accent] ?? 'text-gray-400'} />}
      </div>
      <div className={`text-2xl font-bold ${accentMap[accent] ?? 'text-gray-800'}`}>{value}</div>
      <div className="flex items-center justify-between mt-1.5 gap-2">
        {sub && <span className="text-xs text-gray-400">{sub}</span>}
        {change !== undefined && <DeltaBadge change={change ?? null} inverse={inverse} />}
      </div>
    </div>
  )
}

export function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-base font-bold text-gray-900">{title}</h2>
      {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
    </div>
  )
}

export function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`bg-white rounded-xl border border-gray-100 shadow-sm p-4 ${className}`}>{children}</div>
}

export function EmptyState({ message }: { message: string }) {
  return <div className="flex items-center justify-center py-12 text-gray-400 text-sm">{message}</div>
}

export const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string }) => {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-lg px-3 py-2 text-xs">
      <div className="font-semibold text-gray-700 mb-1">{label}</div>
      {payload.map(p => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ background: p.color }} />
          <span className="text-gray-600">{p.name}:</span>
          <span className="font-semibold text-gray-800">{typeof p.value === 'number' ? formatCurrency(p.value) : p.value}</span>
        </div>
      ))}
    </div>
  )
}

export function LoadingState() {
  return (
    <div className="space-y-4">
      {[1,2,3].map(i => (
        <div key={i} className="bg-white rounded-xl border border-gray-100 p-4 h-32 animate-pulse">
          <div className="h-3 bg-gray-100 rounded w-1/4 mb-3" />
          <div className="h-6 bg-gray-100 rounded w-1/2 mb-2" />
          <div className="h-3 bg-gray-100 rounded w-1/3" />
        </div>
      ))}
    </div>
  )
}

```


---

## `src/app/reports/tabs/OverviewTab.tsx`

```tsx
'use client'
import { useState, useEffect } from 'react'
import { TrendingUp, ShoppingCart, AlertTriangle, Package } from 'lucide-react'
import {
  AreaChart, Area, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts'
import { formatCurrency } from '@/lib/utils'
import { KpiCard, SectionHeader, Card, EmptyState, CustomTooltip, LoadingState, CAT_COLORS } from '../report-components'

export default function OverviewTab({ period }: { period: number }) {
  const [data, setData] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/reports/analytics?section=overview&days=${period}`)
      .then(r => r.json()).then(setData).finally(() => setLoading(false))
  }, [period])

  if (loading) return <LoadingState />
  if (!data) return <EmptyState message="Failed to load overview" />

  const kpis = data.kpis as Record<string, { value: number; prev: number | null; change: number | null }>
  const revenueTrend = (data.revenueTrend as { date: string; revenue: number }[]) ?? []
  const byCategory = (data.inventoryByCategory as { cat: string; value: number }[]) ?? []
  const alerts = (data.recentAlerts as { id: string; inventoryItem: { itemName: string }; changePct: number; direction: string; session: { supplierName: string } | null }[]) ?? []
  const lastCount = data.lastCount as { label: string; totalCountedValue: number; finalizedAt: string } | null

  return (
    <div className="space-y-6">
      {/* KPI Row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <KpiCard label="Revenue" value={formatCurrency(kpis.revenue.value)} change={kpis.revenue.change} accent="blue" icon={TrendingUp} sub={`last ${period}d`} />
        <KpiCard label="Purchase Spend" value={formatCurrency(kpis.purchases.value)} change={kpis.purchases.change} inverse accent="purple" icon={ShoppingCart} sub={`last ${period}d`} />
        <KpiCard label="Wastage Cost" value={formatCurrency(kpis.wastage.value)} change={kpis.wastage.change} inverse accent="amber" icon={AlertTriangle} sub={`last ${period}d`} />
        <KpiCard label="Inventory Value" value={formatCurrency(kpis.inventoryValue.value)} accent="green" icon={Package} sub="current" />
        <KpiCard label="Price Alerts" value={String(kpis.priceAlerts.value)} accent={kpis.priceAlerts.value > 0 ? 'red' : 'gray'} icon={AlertTriangle} sub="unacknowledged" />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <SectionHeader title="Revenue Trend" subtitle={`Daily revenue over the last ${period} days`} />
          {revenueTrend.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={revenueTrend}>
                <defs>
                  <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.15} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={d => d.slice(5)} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `$${(v/1000).toFixed(0)}k`} width={40} />
                <Tooltip content={<CustomTooltip />} />
                <Area type="monotone" dataKey="revenue" name="Revenue" stroke="#3b82f6" fill="url(#revGrad)" strokeWidth={2} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          ) : <EmptyState message="No sales data for this period" />}
        </Card>

        <Card>
          <SectionHeader title="Inventory by Category" />
          {byCategory.length > 0 ? (
            <>
              <div className="space-y-2">
                {byCategory.slice(0, 6).map(item => {
                  const total = byCategory.reduce((s, i) => s + i.value, 0)
                  const pctVal = total > 0 ? (item.value / total) * 100 : 0
                  return (
                    <div key={item.cat}>
                      <div className="flex items-center justify-between text-xs mb-0.5">
                        <span className="font-medium text-gray-700">{item.cat}</span>
                        <span className="text-gray-500">{formatCurrency(item.value)}</span>
                      </div>
                      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div className="h-full rounded-full transition-all" style={{ width: `${pctVal}%`, background: CAT_COLORS[item.cat] ?? '#94a3b8' }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          ) : <EmptyState message="No inventory data" />}
        </Card>
      </div>

      {/* Alerts + Last Count */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <SectionHeader title="Recent Price Alerts" subtitle="Latest unacknowledged price changes" />
          {alerts.length > 0 ? (
            <div className="space-y-2">
              {alerts.map(a => (
                <div key={a.id} className="flex items-center justify-between py-1.5 border-b border-gray-50 last:border-0">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-gray-800 truncate">{a.inventoryItem.itemName}</div>
                    <div className="text-xs text-gray-400">{a.session?.supplierName ?? '—'}</div>
                  </div>
                  <span className={`text-sm font-bold shrink-0 ml-3 ${a.direction === 'UP' ? 'text-red-500' : 'text-green-600'}`}>
                    {a.direction === 'UP' ? '+' : ''}{Number(a.changePct).toFixed(1)}%
                  </span>
                </div>
              ))}
            </div>
          ) : <EmptyState message="No unacknowledged price alerts" />}
        </Card>

        <Card>
          <SectionHeader title="Last Inventory Count" />
          {lastCount ? (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-green-100 flex items-center justify-center shrink-0">
                  <Package size={18} className="text-green-600" />
                </div>
                <div>
                  <div className="font-semibold text-gray-900">{lastCount.label}</div>
                  <div className="text-xs text-gray-400">{new Date(lastCount.finalizedAt).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })}</div>
                </div>
              </div>
              <div className="bg-green-50 rounded-lg p-3">
                <div className="text-xs text-green-600 font-medium">Total Counted Value</div>
                <div className="text-2xl font-bold text-green-700">{formatCurrency(Number(lastCount.totalCountedValue))}</div>
              </div>
            </div>
          ) : <EmptyState message="No finalized counts yet" />}
        </Card>
      </div>
    </div>
  )
}

```


---

## `src/app/reports/tabs/SalesTab.tsx`

```tsx
'use client'
import { useState, useEffect } from 'react'
import { TrendingUp, AlertTriangle } from 'lucide-react'
import {
  BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts'
import { formatCurrency } from '@/lib/utils'
import { KpiCard, SectionHeader, Card, EmptyState, CustomTooltip, LoadingState } from '../report-components'

export default function SalesTab({ period }: { period: number }) {
  const [data, setData] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/reports/analytics?section=sales&days=${period}`)
      .then(r => r.json()).then(setData).finally(() => setLoading(false))
  }, [period])

  if (loading) return <LoadingState />
  if (!data) return <EmptyState message="Failed to load sales data" />

  const summary = data.summary as { totalRevenue: number; totalFoodSales: number; totalOrders: number }
  const topMenuItems = (data.topMenuItems as {
    name: string; qty: number; revenue: number; cost: number; menuPrice: number | null; foodCostPct: number | null
  }[]) ?? []
  const weeklyRevenue = (data.weeklyRevenue as { week: string; revenue: number; foodSales: number }[]) ?? []
  const foodCostAlerts = (data.foodCostAlerts as { name: string; foodCostPct: number; qty: number }[]) ?? []

  return (
    <div className="space-y-6">
      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <KpiCard label="Total Revenue" value={formatCurrency(summary.totalRevenue)} accent="blue" icon={TrendingUp} sub={`last ${period}d`} />
        <KpiCard label="Food Sales" value={formatCurrency(summary.totalFoodSales)} accent="green" sub="est. food portion" />
        <KpiCard label="Service Days" value={String(summary.totalOrders)} accent="gray" sub="entries logged" />
      </div>

      {/* Weekly Revenue Chart */}
      <Card>
        <SectionHeader title="Weekly Revenue" subtitle="Revenue and food sales by week" />
        {weeklyRevenue.length > 0 ? (
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={weeklyRevenue} barGap={2}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="week" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `$${(v/1000).toFixed(0)}k`} width={40} />
              <Tooltip content={<CustomTooltip />} />
              <Bar dataKey="revenue"   name="Revenue"    fill="#3b82f6" radius={[3,3,0,0]} />
              <Bar dataKey="foodSales" name="Food Sales" fill="#10b981" radius={[3,3,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : <EmptyState message="No sales data for this period" />}
      </Card>

      {/* Top Menu Items */}
      <Card>
        <SectionHeader title="Top Menu Items" subtitle={`By quantity sold · last ${period} days`} />
        {topMenuItems.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b border-gray-100">
                  <th className="py-2 pr-3 text-xs font-semibold text-gray-500 w-6">#</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-gray-500">Item</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-gray-500 text-right">Sold</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-gray-500 text-right">Revenue</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-gray-500 text-right">Menu Price</th>
                  <th className="py-2 text-xs font-semibold text-gray-500 text-right">Food Cost %</th>
                </tr>
              </thead>
              <tbody>
                {topMenuItems.map((item, i) => {
                  const fc = item.foodCostPct
                  const fcColor = fc == null ? 'text-gray-400' : fc > 35 ? 'text-red-500 font-bold' : fc > 28 ? 'text-amber-500 font-semibold' : 'text-green-600 font-semibold'
                  return (
                    <tr key={item.name} className="border-b border-gray-50 hover:bg-gray-50/60">
                      <td className="py-2.5 pr-3 text-xs text-gray-400 font-medium">{i + 1}</td>
                      <td className="py-2.5 pr-3 font-medium text-gray-800">{item.name}</td>
                      <td className="py-2.5 pr-3 text-right text-gray-700">{item.qty.toLocaleString()}</td>
                      <td className="py-2.5 pr-3 text-right text-gray-700">{formatCurrency(item.revenue)}</td>
                      <td className="py-2.5 pr-3 text-right text-gray-600">{item.menuPrice ? formatCurrency(item.menuPrice) : '—'}</td>
                      <td className="py-2.5 text-right">
                        <span className={`text-sm ${fcColor}`}>{fc != null ? `${fc.toFixed(1)}%` : '—'}</span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : <EmptyState message="No menu item sales data. Import sales first." />}
      </Card>

      {/* Food Cost Alerts */}
      {foodCostAlerts.length > 0 && (
        <Card>
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle size={16} className="text-amber-500" />
            <SectionHeader title="Food Cost Alerts" subtitle="Items where food cost % exceeds 35% — review pricing or recipe costs" />
          </div>
          <div className="space-y-2">
            {foodCostAlerts.map(a => (
              <div key={a.name} className="flex items-center justify-between py-2 px-3 bg-amber-50 rounded-lg border border-amber-100">
                <span className="text-sm font-medium text-gray-800">{a.name}</span>
                <div className="flex items-center gap-3 text-xs">
                  <span className="text-gray-500">{a.qty} sold</span>
                  <span className="font-bold text-red-500">{a.foodCostPct?.toFixed(1)}% food cost</span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}

```


---

## `src/app/reports/tabs/InventoryTab.tsx`

```tsx
'use client'
import { useState, useEffect } from 'react'
import { Package } from 'lucide-react'
import {
  AreaChart, Area, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts'
import { formatCurrency } from '@/lib/utils'
import { KpiCard, SectionHeader, Card, EmptyState, CustomTooltip, LoadingState, CAT_COLORS } from '../report-components'

export default function InventoryTab({ period }: { period: number }) {
  const [data, setData] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/reports/analytics?section=inventory&days=${period}`)
      .then(r => r.json()).then(setData).finally(() => setLoading(false))
  }, [period])

  if (loading) return <LoadingState />
  if (!data) return <EmptyState message="Failed to load inventory data" />

  const summary = data.summary as { totalValue: number; totalItems: number; notCounted30: number; priceChanges: number; priceIncreases: number; priceDecreases: number }
  const topPriceChanges = (data.topPriceChanges as { item: string; category: string; supplier: string; previousPrice: number; newPrice: number; changePct: number; direction: string }[]) ?? []
  const supplierVol = (data.supplierVolatility as { name: string; changes: number; ups: number; downs: number; avgChange: number }[]) ?? []
  const topValueItems = (data.topValueItems as { name: string; category: string; supplier: string; value: number; stock: number }[]) ?? []
  const valueTrend = (data.valueTrend as { label: string; date: string; value: number }[]) ?? []
  const byCategory = (data.byCategory as { cat: string; value: number; count: number }[]) ?? []

  return (
    <div className="space-y-6">
      {/* KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <KpiCard label="Inventory Value" value={formatCurrency(summary.totalValue)} accent="green" icon={Package} />
        <KpiCard label="Active Items" value={String(summary.totalItems)} accent="blue" sub="in inventory" />
        <KpiCard label="Not Counted 30d" value={String(summary.notCounted30)} accent={summary.notCounted30 > 20 ? 'red' : 'amber'} sub="needs attention" />
        <KpiCard label="Price Increases" value={String(summary.priceIncreases)} accent="red" sub={`last ${period}d`} />
        <KpiCard label="Price Decreases" value={String(summary.priceDecreases)} accent="green" sub={`last ${period}d`} />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <SectionHeader title="Inventory Value Trend" subtitle="From finalized count sessions" />
          {valueTrend.length >= 2 ? (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={valueTrend}>
                <defs>
                  <linearGradient id="invGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.15} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `$${(v/1000).toFixed(0)}k`} width={40} />
                <Tooltip content={<CustomTooltip />} />
                <Area type="monotone" dataKey="value" name="Inventory Value" stroke="#10b981" fill="url(#invGrad)" strokeWidth={2} dot={{ fill: '#10b981', r: 4 }} />
              </AreaChart>
            </ResponsiveContainer>
          ) : <EmptyState message="Need at least 2 finalized counts to show trend" />}
        </Card>

        <Card>
          <SectionHeader title="Value by Category" />
          {byCategory.length > 0 ? (
            <div className="space-y-2.5 mt-1">
              {byCategory.map(item => {
                const total = byCategory.reduce((s, i) => s + i.value, 0)
                const pctVal = total > 0 ? (item.value / total) * 100 : 0
                return (
                  <div key={item.cat}>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full" style={{ background: CAT_COLORS[item.cat] ?? '#94a3b8' }} />
                        <span className="font-medium text-gray-700">{item.cat}</span>
                        <span className="text-gray-400">({item.count} items)</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-gray-400">{pctVal.toFixed(1)}%</span>
                        <span className="font-semibold text-gray-700">{formatCurrency(item.value)}</span>
                      </div>
                    </div>
                    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${pctVal}%`, background: CAT_COLORS[item.cat] ?? '#94a3b8' }} />
                    </div>
                  </div>
                )
              })}
            </div>
          ) : <EmptyState message="No inventory data" />}
        </Card>
      </div>

      {/* Price Changes Table */}
      <Card>
        <SectionHeader title="Biggest Price Changes" subtitle={`Items with the largest price movements in the last ${period} days`} />
        {topPriceChanges.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b border-gray-100">
                  <th className="py-2 pr-3 text-xs font-semibold text-gray-500">Item</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-gray-500">Category</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-gray-500 hidden sm:table-cell">Supplier</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-gray-500 text-right">Previous</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-gray-500 text-right">New</th>
                  <th className="py-2 text-xs font-semibold text-gray-500 text-right">Change</th>
                </tr>
              </thead>
              <tbody>
                {topPriceChanges.map((r, i) => (
                  <tr key={i} className="border-b border-gray-50 hover:bg-gray-50/60">
                    <td className="py-2.5 pr-3 font-medium text-gray-800">{r.item}</td>
                    <td className="py-2.5 pr-3 text-gray-500 text-xs">{r.category}</td>
                    <td className="py-2.5 pr-3 text-gray-500 text-xs hidden sm:table-cell">{r.supplier}</td>
                    <td className="py-2.5 pr-3 text-right text-gray-500 text-xs">{formatCurrency(r.previousPrice)}</td>
                    <td className="py-2.5 pr-3 text-right text-gray-700 font-medium">{formatCurrency(r.newPrice)}</td>
                    <td className="py-2.5 text-right">
                      <span className={`font-bold text-sm ${r.direction === 'UP' ? 'text-red-500' : 'text-green-600'}`}>
                        {r.direction === 'UP' ? '+' : ''}{Number(r.changePct).toFixed(1)}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyState message={`No price changes recorded in the last ${period} days`} />}
      </Card>

      {/* Supplier Volatility + Top Value Items */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <SectionHeader title="Supplier Price Volatility" subtitle="Suppliers with the most price changes" />
          {supplierVol.length > 0 ? (
            <div className="space-y-3">
              {supplierVol.map(s => (
                <div key={s.name} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-gray-800 truncate">{s.name}</div>
                    <div className="flex items-center gap-2 mt-0.5 text-xs text-gray-400">
                      <span className="text-red-400">↑{s.ups} up</span>
                      <span className="text-green-500">↓{s.downs} down</span>
                    </div>
                  </div>
                  <div className="text-right shrink-0 ml-3">
                    <div className="font-bold text-gray-800">{s.changes} changes</div>
                    <div className="text-xs text-gray-400">avg {s.avgChange.toFixed(1)}% Δ</div>
                  </div>
                </div>
              ))}
            </div>
          ) : <EmptyState message="No supplier price data for this period" />}
        </Card>

        <Card>
          <SectionHeader title="Top Value Items" subtitle="Items representing most inventory value" />
          {topValueItems.length > 0 ? (
            <div className="space-y-2">
              {topValueItems.map((item, i) => (
                <div key={item.name} className="flex items-center gap-3 py-1.5 border-b border-gray-50 last:border-0">
                  <span className="text-xs text-gray-400 w-5 text-right shrink-0">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-800 truncate">{item.name}</div>
                    <div className="text-xs text-gray-400">{item.category} · {item.supplier}</div>
                  </div>
                  <span className="font-semibold text-gray-800 shrink-0">{formatCurrency(item.value)}</span>
                </div>
              ))}
            </div>
          ) : <EmptyState message="No inventory data" />}
        </Card>
      </div>
    </div>
  )
}

```


---

## `src/app/reports/tabs/CogsTab.tsx`

```tsx
'use client'
import { useState, useCallback } from 'react'
import { RefreshCw } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import { SectionHeader, Card, LoadingState } from '../report-components'
import { useRc } from '@/contexts/RevenueCenterContext'
import { rcHex } from '@/lib/rc-colors'

interface CogsResult {
  startDate: string; endDate: string
  beginningInventory: { value: number; sessionDate: string | null; sessionId: string | null; fallback: boolean }
  purchases: { total: number; invoiceCount: number }
  endingInventory: { value: number; sessionDate: string | null; sessionId: string | null; fallback: boolean }
  cogs: number; foodSales: number; foodCostPct: number
  byCategory: Array<{ category: string; beginningValue: number; endingValue: number; purchases: number; cogs: number }>
}

export default function CogsTab() {
  const { activeRcId, activeRc } = useRc()
  const getWeekBounds = () => {
    const today = new Date(), dow = today.getDay()
    const mon = new Date(today); mon.setDate(today.getDate() - ((dow + 6) % 7))
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6)
    return { start: mon.toISOString().split('T')[0], end: sun.toISOString().split('T')[0] }
  }
  const { start: defaultStart, end: defaultEnd } = getWeekBounds()
  const [startDate, setStartDate] = useState(defaultStart)
  const [endDate, setEndDate]     = useState(defaultEnd)
  const [data, setData] = useState<CogsResult | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ startDate, endDate })
      if (activeRcId) {
        params.set('rcId', activeRcId)
        if (activeRc?.isDefault) params.set('isDefault', 'true')
      }
      const res = await fetch(`/api/reports/cogs?${params}`)
      setData(await res.json())
    } finally { setLoading(false) }
  }, [startDate, endDate, activeRcId, activeRc])

  const fcColor = (pct: number) => pct < 28 ? 'text-green-600' : pct < 35 ? 'text-amber-500' : 'text-red-500'

  return (
    <div className="space-y-6">
      {/* Date selector */}
      <Card>
        <SectionHeader title="COGS Calculator" subtitle="Beginning Inventory + Purchases − Ending Inventory" />
        <div className="flex flex-col sm:flex-row items-start sm:items-end gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Start Date</label>
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">End Date</label>
            <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
          </div>
          <button onClick={load} disabled={loading}
            className="flex items-center gap-2 bg-gold text-white px-4 py-2 rounded-lg text-sm hover:bg-[#a88930] disabled:opacity-50">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Calculating…' : 'Calculate COGS'}
          </button>
          {activeRc && (
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: rcHex(activeRc.color) }} />
              {activeRc.name}
            </div>
          )}
        </div>
      </Card>

      {loading && <LoadingState />}

      {data && (
        <>
          {/* Formula Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-center">
            <Card className="text-center">
              <div className="text-xs font-medium text-gray-500 mb-1">Beginning Inventory</div>
              <div className="text-xl font-bold text-gray-800">{formatCurrency(data.beginningInventory.value)}</div>
              {data.beginningInventory.fallback && <div className="text-[10px] text-amber-500 mt-1">⚠ estimated</div>}
              {data.beginningInventory.sessionDate && <div className="text-[10px] text-gray-400 mt-1">{data.beginningInventory.sessionDate}</div>}
            </Card>
            <div className="flex items-center justify-center text-2xl font-light text-gray-400">+</div>
            <Card className="text-center">
              <div className="text-xs font-medium text-gray-500 mb-1">Purchases</div>
              <div className="text-xl font-bold text-gray-800">{formatCurrency(data.purchases.total)}</div>
              <div className="text-[10px] text-gray-400 mt-1">{data.purchases.invoiceCount} invoices</div>
            </Card>
            <div className="hidden sm:flex items-center justify-center text-2xl font-light text-gray-400">−</div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-center">
            <div className="hidden sm:block" />
            <div className="hidden sm:block" />
            <Card className="text-center">
              <div className="text-xs font-medium text-gray-500 mb-1">Ending Inventory</div>
              <div className="text-xl font-bold text-gray-800">{formatCurrency(data.endingInventory.value)}</div>
              {data.endingInventory.fallback && <div className="text-[10px] text-amber-500 mt-1">⚠ estimated</div>}
              {data.endingInventory.sessionDate && <div className="text-[10px] text-gray-400 mt-1">{data.endingInventory.sessionDate}</div>}
            </Card>
            <Card className="text-center border-gold/30 bg-gold/10">
              <div className="text-xs font-semibold text-gold mb-1">= COGS</div>
              <div className="text-2xl font-bold text-gold">{formatCurrency(data.cogs)}</div>
              {data.foodSales > 0 && (
                <div className={`text-lg font-bold mt-1 ${fcColor(data.foodCostPct)}`}>{data.foodCostPct.toFixed(1)}% food cost</div>
              )}
            </Card>
          </div>

          {/* Category Breakdown */}
          {data.byCategory?.length > 0 && (
            <Card>
              <SectionHeader title="COGS by Category" />
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left border-b border-gray-100">
                      {['Category','Beginning','Purchases','Ending','COGS'].map(h => (
                        <th key={h} className={`py-2 pr-3 text-xs font-semibold text-gray-500 ${h !== 'Category' ? 'text-right' : ''}`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.byCategory.map(row => (
                      <tr key={row.category} className="border-b border-gray-50 hover:bg-gray-50/60">
                        <td className="py-2.5 pr-3 font-medium text-gray-800">{row.category}</td>
                        <td className="py-2.5 pr-3 text-right text-gray-600">{formatCurrency(row.beginningValue)}</td>
                        <td className="py-2.5 pr-3 text-right text-gray-600">{formatCurrency(row.purchases)}</td>
                        <td className="py-2.5 pr-3 text-right text-gray-600">{formatCurrency(row.endingValue)}</td>
                        <td className="py-2.5 text-right font-semibold text-gray-800">{formatCurrency(row.cogs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  )
}

```


---

## `src/app/reports/tabs/PurchasingTab.tsx`

```tsx
'use client'
import { useState, useEffect } from 'react'
import { ShoppingCart } from 'lucide-react'
import {
  BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts'
import { formatCurrency } from '@/lib/utils'
import { KpiCard, SectionHeader, Card, EmptyState, CustomTooltip, LoadingState } from '../report-components'

export default function PurchasingTab({ period }: { period: number }) {
  const [data, setData] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/reports/analytics?section=purchasing&days=${period}`)
      .then(r => r.json()).then(setData).finally(() => setLoading(false))
  }, [period])

  if (loading) return <LoadingState />
  if (!data) return <EmptyState message="Failed to load purchasing data" />

  const summary = data.summary as { totalSpend: number; totalLines: number; supplierCount: number }
  const supplierSpend = (data.supplierSpend as { name: string; spend: number; lines: number }[]) ?? []
  const topItems = (data.topItems as { name: string; spend: number; qty: number; category: string }[]) ?? []
  const spendTrend = (data.spendTrend as { week: string; spend: number }[]) ?? []

  const maxSupplierSpend = supplierSpend[0]?.spend ?? 1

  return (
    <div className="space-y-6">
      {/* KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <KpiCard label="Total Spend" value={formatCurrency(summary.totalSpend)} accent="purple" icon={ShoppingCart} sub={`last ${period}d`} />
        <KpiCard label="Line Items" value={summary.totalLines.toLocaleString()} accent="blue" sub="invoice lines processed" />
        <KpiCard label="Suppliers" value={String(summary.supplierCount)} accent="gray" sub="with approved invoices" />
      </div>

      {/* Weekly Spend Chart */}
      <Card>
        <SectionHeader title="Weekly Purchase Spend" subtitle="Approved invoice totals by week" />
        {spendTrend.length > 0 ? (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={spendTrend}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="week" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `$${(v/1000).toFixed(0)}k`} width={40} />
              <Tooltip content={<CustomTooltip />} />
              <Bar dataKey="spend" name="Spend" fill="#8b5cf6" radius={[3,3,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : <EmptyState message="No approved invoices found for this period. Approve invoice sessions to see spend data." />}
      </Card>

      {/* Supplier Breakdown + Top Items */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <SectionHeader title="Spend by Supplier" subtitle="Top suppliers by total spend" />
          {supplierSpend.length > 0 ? (
            <div className="space-y-3">
              {supplierSpend.map(s => {
                const pctVal = (s.spend / maxSupplierSpend) * 100
                return (
                  <div key={s.name}>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="font-medium text-gray-700 truncate">{s.name}</span>
                      <div className="flex items-center gap-2 shrink-0 ml-2">
                        <span className="text-gray-400">{s.lines} lines</span>
                        <span className="font-semibold text-gray-800">{formatCurrency(s.spend)}</span>
                      </div>
                    </div>
                    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-purple-500" style={{ width: `${pctVal}%` }} />
                    </div>
                  </div>
                )
              })}
            </div>
          ) : <EmptyState message="No supplier spend data" />}
        </Card>

        <Card>
          <SectionHeader title="Top Items by Spend" subtitle="Most expensive items purchased" />
          {topItems.length > 0 ? (
            <div className="overflow-y-auto max-h-80">
              {topItems.map((item, i) => (
                <div key={item.name} className="flex items-center gap-3 py-2 border-b border-gray-50 last:border-0">
                  <span className="text-xs text-gray-400 w-5 text-right shrink-0">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-800 truncate">{item.name}</div>
                    <div className="text-xs text-gray-400">{item.category}</div>
                  </div>
                  <span className="font-semibold text-gray-800 shrink-0">{formatCurrency(item.spend)}</span>
                </div>
              ))}
            </div>
          ) : <EmptyState message="No purchase data" />}
        </Card>
      </div>
    </div>
  )
}

```


---

## `src/app/reports/tabs/PrepTab.tsx`

```tsx
'use client'
import { useState, useEffect } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { ChefHat, TrendingUp, AlertTriangle, CheckCircle2 } from 'lucide-react'

interface DailySummary {
  date: string
  total: number
  done: number
  partial: number
  blocked: number
  skipped: number
  notStarted: number
  completionRate: number
}
interface TopItem {
  name: string
  category: string
  unit: string
  doneCount: number
  totalQty: number
  avgQty: number
}
interface TopBlocked {
  name: string
  blockedCount: number
  reasons: string[]
}
interface CategoryBreakdown {
  category: string
  total: number
  done: number
  partial: number
  completionRate: number
}
interface PrepReport {
  dailySummaries: DailySummary[]
  topItems: TopItem[]
  topBlocked: TopBlocked[]
  categoryBreakdown: CategoryBreakdown[]
  totals: { total: number; done: number; partial: number; blocked: number; skipped: number; notStarted: number; completionRate: number }
}

const PERIOD_OPTIONS = [
  { label: '7 days',  days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
]

function fmtDate(iso: string) {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function completionColor(rate: number) {
  if (rate >= 80) return '#16a34a'
  if (rate >= 50) return '#d97706'
  return '#dc2626'
}

export default function PrepTab() {
  const [period,  setPeriod]  = useState(30)
  const [report,  setReport]  = useState<PrepReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    const end   = new Date()
    const start = new Date()
    start.setDate(start.getDate() - period + 1)
    const fmt = (d: Date) => d.toISOString().slice(0, 10)
    fetch(`/api/reports/prep?startDate=${fmt(start)}&endDate=${fmt(end)}`)
      .then(r => r.json())
      .then(data => { setReport(data); setLoading(false) })
      .catch(() => { setError('Failed to load prep report'); setLoading(false) })
  }, [period])

  return (
    <div className="space-y-6">
      {/* Header + period selector */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <ChefHat size={18} className="text-gold" />
          <h2 className="text-base font-semibold text-gray-800">Prep Performance</h2>
        </div>
        <div className="flex items-center gap-0.5 border border-gray-200 rounded-lg p-0.5 bg-white">
          {PERIOD_OPTIONS.map(opt => (
            <button key={opt.days} onClick={() => setPeriod(opt.days)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                period === opt.days ? 'bg-gold text-white shadow-sm' : 'text-gray-600 hover:bg-gray-50'
              }`}>
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gold" />
        </div>
      ) : error ? (
        <div className="text-sm text-red-600 text-center py-12">{error}</div>
      ) : !report || report.totals.total === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <ChefHat size={36} className="mx-auto mb-3 opacity-40" />
          <p className="text-sm">No prep data found for this period.</p>
          <p className="text-xs mt-1">Start logging prep in the Today tab to see reports here.</p>
        </div>
      ) : (
        <>
          {/* Overall KPI cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'Total Logged',   value: report.totals.total,          icon: ChefHat,      cls: 'text-gray-800' },
              { label: 'Completed',      value: report.totals.done + report.totals.partial, icon: CheckCircle2, cls: 'text-green-700' },
              { label: 'Blocked',        value: report.totals.blocked,         icon: AlertTriangle,cls: 'text-red-600' },
              { label: 'Completion Rate',value: `${report.totals.completionRate}%`, icon: TrendingUp, cls: report.totals.completionRate >= 80 ? 'text-green-700' : report.totals.completionRate >= 50 ? 'text-amber-700' : 'text-red-600' },
            ].map(({ label, value, icon: Icon, cls }) => (
              <div key={label} className="bg-white border border-gray-100 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-1">
                  <Icon size={14} className="text-gray-400" />
                  <span className="text-xs text-gray-400">{label}</span>
                </div>
                <div className={`text-2xl font-bold ${cls}`}>{value}</div>
              </div>
            ))}
          </div>

          {/* Daily completion rate chart */}
          {report.dailySummaries.length > 1 && (
            <div className="bg-white border border-gray-100 rounded-xl p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-4">Daily Completion Rate</h3>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={report.dailySummaries} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="date" tickFormatter={fmtDate} tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                  <YAxis domain={[0, 100]} tickFormatter={v => `${v}%`} tick={{ fontSize: 11 }} />
                  <Tooltip
                    formatter={(v) => [`${v}%`, 'Completion']}
                    labelFormatter={(l) => fmtDate(String(l))}
                  />
                  <Bar dataKey="completionRate" radius={[3, 3, 0, 0]}>
                    {report.dailySummaries.map((entry, i) => (
                      <Cell key={i} fill={completionColor(entry.completionRate)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Daily volume chart */}
          {report.dailySummaries.length > 1 && (
            <div className="bg-white border border-gray-100 rounded-xl p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-4">Daily Items Logged</h3>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={report.dailySummaries} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="date" tickFormatter={fmtDate} tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip labelFormatter={(l) => fmtDate(String(l))} />
                  <Bar dataKey="done"    name="Done"    stackId="a" fill="#16a34a" radius={[0,0,0,0]} />
                  <Bar dataKey="partial" name="Partial" stackId="a" fill="#d97706" />
                  <Bar dataKey="blocked" name="Blocked" stackId="a" fill="#dc2626" />
                  <Bar dataKey="skipped" name="Skipped" stackId="a" fill="#9ca3af" radius={[3,3,0,0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Top prep items */}
            <div className="bg-white border border-gray-100 rounded-xl p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Most Prepped Items</h3>
              <div className="space-y-2">
                {report.topItems.slice(0, 10).map(item => (
                  <div key={item.name} className="flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-gray-700 truncate">{item.name}</div>
                      <div className="text-xs text-gray-400">{item.category} · avg {item.avgQty.toFixed(1)} {item.unit}</div>
                    </div>
                    <span className="text-sm font-semibold text-gray-600 shrink-0">{item.doneCount}×</span>
                  </div>
                ))}
                {report.topItems.length === 0 && <p className="text-xs text-gray-400">No completed items.</p>}
              </div>
            </div>

            {/* Category breakdown */}
            <div className="bg-white border border-gray-100 rounded-xl p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">By Category</h3>
              <div className="space-y-2">
                {report.categoryBreakdown.map(cat => (
                  <div key={cat.category}>
                    <div className="flex items-center justify-between text-sm mb-0.5">
                      <span className="text-gray-700 truncate">{cat.category}</span>
                      <span className="text-xs font-medium shrink-0 ml-2" style={{ color: completionColor(cat.completionRate) }}>
                        {cat.completionRate}%
                      </span>
                    </div>
                    <div className="w-full bg-gray-100 rounded-full h-1.5">
                      <div
                        className="h-1.5 rounded-full transition-all"
                        style={{ width: `${cat.completionRate}%`, backgroundColor: completionColor(cat.completionRate) }}
                      />
                    </div>
                    <div className="text-xs text-gray-400 mt-0.5">{cat.done + cat.partial}/{cat.total} completed</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Blocked items */}
          {report.topBlocked.length > 0 && (
            <div className="bg-white border border-gray-100 rounded-xl p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                <AlertTriangle size={14} className="text-red-500" /> Frequently Blocked
              </h3>
              <div className="space-y-2">
                {report.topBlocked.map(item => (
                  <div key={item.name} className="flex items-start gap-3 py-2 border-b border-gray-50 last:border-0">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-gray-700">{item.name}</div>
                      {item.reasons.length > 0 && (
                        <div className="text-xs text-gray-400 mt-0.5 truncate">
                          {[...new Set(item.reasons)].slice(0, 2).join(' · ')}
                        </div>
                      )}
                    </div>
                    <span className="text-sm font-semibold text-red-600 shrink-0">{item.blockedCount}×</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

```


---

## `src/app/setup/page.tsx`

```tsx
'use client'
import Link from 'next/link'
import {
  Truck, Building2, MapPin, Tag, Ruler, Users, Bell,
} from 'lucide-react'
import { PageHead } from '@/components/layout/PageHead'

interface Card {
  href: string
  label: string
  icon: React.ComponentType<{ size?: number | string }>
  description: string
  built: boolean
}

const cards: Card[] = [
  { href: '/setup/suppliers',       label: 'Suppliers',        icon: Truck,    description: 'Vendor directory, price history, contact info.',                  built: true },
  { href: '/setup/revenue-centers', label: 'Revenue centers',  icon: Building2,description: 'Profit centers, allocations, food-cost targets.',                 built: true },
  { href: '/setup/storage-areas',   label: 'Storage areas',    icon: MapPin,   description: 'Walk-ins, dry storage, bar. Drives count routing.',               built: true },
  { href: '/setup/categories',      label: 'Categories',       icon: Tag,      description: 'Inventory and recipe categories, accent colors.',                 built: true },
  { href: '/setup/users',           label: 'Users & roles',    icon: Users,    description: 'Invite teammates; ADMIN / MANAGER / STAFF.',                      built: true },
  { href: '/setup/uom',             label: 'UOM & conversions',icon: Ruler,    description: 'Unit-of-measure groups, custom conversions, inspector.',          built: true },
  { href: '/setup/general',         label: 'General',          icon: Bell,     description: 'Email digest schedule, notifications, brand.',                    built: true },
]

export default function SetupPage() {
  return (
    <div>
      <PageHead
        crumbs={<><span>SETUP</span></>}
        title="Setup"
        sub={<>Configure suppliers, storage, categories, and team access — demoted from the daily nav.</>}
      />

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {cards.map(card => (
          <SetupCard key={card.href} {...card} />
        ))}
      </div>
    </div>
  )
}

function SetupCard({ href, label, icon: Icon, description, built }: Card) {
  const inner = (
    <div className="h-full bg-paper border border-line rounded-[12px] p-5 hover:border-ink-3 transition-colors">
      <div className="flex items-center justify-between mb-3">
        <div className="w-9 h-9 rounded-[9px] bg-bg-2 flex items-center justify-center text-ink-2">
          <Icon size={16} />
        </div>
        {!built && (
          <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.04em] bg-bg-2 text-ink-3 px-2 py-0.5 rounded-full">
            Soon
          </span>
        )}
      </div>
      <h3 className="text-[15px] font-semibold tracking-[-0.015em] text-ink mb-1">{label}</h3>
      <p className="text-[12.5px] text-ink-3 leading-snug">{description}</p>
    </div>
  )
  return built
    ? <Link href={href} className="block">{inner}</Link>
    : <div className="block opacity-60 cursor-not-allowed">{inner}</div>
}

```


---

## `src/app/setup/general/page.tsx`

```tsx
'use client'
import { Bell } from 'lucide-react'
import { PageHead } from '@/components/layout/PageHead'

export default function GeneralSettingsPage() {
  return (
    <div>
      <PageHead
        crumbs={<><Bell size={12} /> SETUP / GENERAL</>}
        title="General"
        sub={<>App-wide settings — email digest schedule, notifications, brand.</>}
      />
      <div className="bg-paper border border-line rounded-[12px] p-12 text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3">Coming soon</p>
        <p className="text-[14px] text-ink-2 mt-2 max-w-md mx-auto">
          Email digest configuration, notification preferences, and tenant-level brand
          settings live here. The digest endpoint is already wired
          at <span className="font-mono text-gold-2">/api/digest</span>.
        </p>
      </div>
    </div>
  )
}

```


---

## `src/app/setup/suppliers/page.tsx`

```tsx
'use client'
import { useState, useCallback, useEffect } from 'react'
import dynamic from 'next/dynamic'
import { SupplierList } from '@/components/suppliers/SupplierList'
import { SupplierDetail } from '@/components/suppliers/SupplierDetail'
import { SupplierSummary } from '@/components/suppliers/types'
import { formatCurrency } from '@/lib/utils'
import Link from 'next/link'

// Lazy-load the form modal — only needed when user clicks Add or Edit
const SupplierFormModal = dynamic(
  () => import('@/components/suppliers/SupplierFormModal').then(m => ({ default: m.SupplierFormModal })),
  { ssr: false, loading: () => null }
)

export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<SupplierSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editSupplier, setEditSupplier] = useState<SupplierSummary | null>(null)
  const [showAdd, setShowAdd] = useState(false)

  const fetchSuppliers = useCallback(() => {
    fetch('/api/suppliers').then(r => r.json()).then((data: SupplierSummary[]) => {
      setSuppliers(data)
      // Auto-select first supplier if none selected
      setSelectedId(prev => prev ?? (data[0]?.id ?? null))
    })
  }, [])

  useEffect(() => { fetchSuppliers() }, [fetchSuppliers])

  const selectedSupplier = suppliers.find(s => s.id === selectedId) ?? null

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this supplier? Inventory items will be unlinked.')) return
    await fetch(`/api/suppliers/${id}`, { method: 'DELETE' })
    setSelectedId(prev => (prev === id ? null : prev))
    fetchSuppliers()
  }

  return (
    <>
      {/* Desktop: split panel */}
      <div className="hidden sm:flex h-[calc(100vh-64px)] overflow-hidden">
        <SupplierList
          suppliers={suppliers}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onAdd={() => setShowAdd(true)}
        />
        {selectedId ? (
          <SupplierDetail
            key={selectedId}
            supplierId={selectedId}
            supplier={selectedSupplier}
            onEdit={setEditSupplier}
            onDelete={handleDelete}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-gray-400">
            Select a supplier to view details
          </div>
        )}
      </div>

      {/* Mobile: full-width list only (detail navigates to /suppliers/[id]) */}
      <div className="sm:hidden flex flex-col h-[calc(100vh-64px)]">
        <div className="px-4 pt-3 pb-2 shrink-0 flex items-center justify-between">
          <h1 className="text-xl font-bold text-gray-900">Suppliers</h1>
          <button
            onClick={() => setShowAdd(true)}
            className="bg-gold text-white rounded-lg px-3 py-1.5 text-sm font-semibold hover:bg-[#a88930]"
          >
            + Add
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {[...suppliers]
            .sort((a, b) => b.monthSpend - a.monthSpend)
            .map(s => {
              const pct = s.prevMonthSpend === 0 ? null
                : Math.round(((s.monthSpend - s.prevMonthSpend) / s.prevMonthSpend) * 100)
              const pctColor = pct === null ? 'text-gray-400'
                : pct >= 15 ? 'text-red-500' : pct > 0 ? 'text-green-600' : 'text-gray-500'
              return (
                <Link
                  key={s.id}
                  href={`/suppliers/${s.id}`}
                  className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 bg-white hover:bg-gray-50"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">{s.name}</p>
                    <p className={`text-xs mt-0.5 ${pctColor}`}>
                      {s.monthSpend === 0 ? '$0 this month'
                        : `${formatCurrency(s.monthSpend)} this month${pct !== null ? ` · ${pct >= 0 ? '↑' : '↓'}${Math.abs(pct)}%` : ''}`}
                    </p>
                    <p className="text-xs text-gray-400">{s._count.inventory} items · {s.invoiceCount} invoices</p>
                  </div>
                  <span className="text-gray-300 text-lg">›</span>
                </Link>
              )
            })}
        </div>
      </div>

      {/* Add modal */}
      {showAdd && (
        <SupplierFormModal supplier={null} onClose={() => setShowAdd(false)} onSaved={fetchSuppliers} />
      )}

      {/* Edit modal */}
      {editSupplier && (
        <SupplierFormModal supplier={editSupplier} onClose={() => setEditSupplier(null)} onSaved={fetchSuppliers} />
      )}
    </>
  )
}

```


---

## `src/app/setup/categories/page.tsx`

```tsx
'use client'
import { useEffect, useState } from 'react'
import { Plus, Pencil, Trash2, Check, X, Tag } from 'lucide-react'
import { CATEGORY_COLORS } from '@/lib/utils'

interface Category {
  id: string
  name: string
}

interface CategoryStat extends Category {
  count: number
  totalValue: number
}

export default function CategoriesPage() {
  const [cats, setCats] = useState<CategoryStat[]>([])
  const [newName, setNewName] = useState('')
  const [editId, setEditId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [error, setError] = useState('')

  const fetchCats = async () => {
    const [catsRes, itemsRes] = await Promise.all([
      fetch('/api/categories').then(r => r.json()),
      fetch('/api/inventory').then(r => r.json()),
    ])
    const items: any[] = Array.isArray(itemsRes) ? itemsRes : []
    const statsMap = new Map<string, { count: number; totalValue: number }>()
    for (const item of items) {
      const prev = statsMap.get(item.category) ?? { count: 0, totalValue: 0 }
      statsMap.set(item.category, {
        count: prev.count + 1,
        totalValue: prev.totalValue + parseFloat(item.stockOnHand) * parseFloat(item.pricePerBaseUnit),
      })
    }
    setCats(catsRes.map((c: Category) => ({
      ...c,
      ...(statsMap.get(c.name) ?? { count: 0, totalValue: 0 }),
    })))
  }

  useEffect(() => { fetchCats() }, [])

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!newName.trim()) return
    const res = await fetch('/api/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim() }),
    })
    if (!res.ok) {
      const data = await res.json()
      setError(data.error || 'Failed to add')
      return
    }
    setNewName('')
    fetchCats()
  }

  const handleEdit = async (id: string) => {
    if (!editName.trim()) return
    await fetch(`/api/categories/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: editName.trim() }),
    })
    setEditId(null)
    fetchCats()
  }

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete category "${name}"? Items using it will keep their current category string but it won't appear in this list.`)) return
    await fetch(`/api/categories/${id}`, { method: 'DELETE' })
    fetchCats()
  }

  const totalValue = cats.reduce((s, c) => s + c.totalValue, 0)

  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <h2 className="text-xl font-bold text-gray-900">Categories</h2>
        <p className="text-sm text-gray-500 mt-0.5">Manage inventory categories — these are assigned to items in your inventory</p>
      </div>

      {/* Add form */}
      <form onSubmit={handleAdd} className="flex gap-2">
        <div className="flex-1">
          <input
            value={newName}
            onChange={e => { setNewName(e.target.value); setError('') }}
            placeholder="New category name (e.g. BAKERY)..."
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
          />
          {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
        </div>
        <button type="submit" className="flex items-center gap-2 bg-gold text-white px-3 py-2 rounded-lg text-sm hover:bg-[#a88930] whitespace-nowrap">
          <Plus size={15} /> Add
        </button>
      </form>

      {/* List */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm divide-y divide-gray-50">
        {cats.length === 0 && <div className="text-center py-12 text-gray-400">No categories yet</div>}
        {cats.map(cat => {
          const pct = totalValue > 0 ? (cat.totalValue / totalValue) * 100 : 0
          const colors = CATEGORY_COLORS[cat.name] || 'bg-gray-100 text-gray-700'
          return (
            <div key={cat.id} className="px-4 py-3 flex items-center gap-3">
              <Tag size={14} className="text-gray-300 shrink-0" />

              {editId === cat.id ? (
                <>
                  <input
                    autoFocus
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleEdit(cat.id); if (e.key === 'Escape') setEditId(null) }}
                    className="flex-1 border border-blue-300 rounded px-2 py-1 text-sm focus:outline-none"
                  />
                  <button onClick={() => handleEdit(cat.id)} className="text-green-600 hover:text-green-700 p-1"><Check size={15} /></button>
                  <button onClick={() => setEditId(null)} className="text-gray-400 hover:text-gray-600 p-1"><X size={15} /></button>
                </>
              ) : (
                <>
                  <span className={`inline-flex items-center px-2.5 py-1 rounded text-xs font-semibold w-16 justify-center shrink-0 ${colors}`}>
                    {cat.name}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs text-gray-500">{cat.count} item{cat.count !== 1 ? 's' : ''}</span>
                      <span className="text-xs font-semibold text-gray-700">${cat.totalValue.toFixed(2)}</span>
                    </div>
                    <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full bg-gold/100 rounded-full transition-all" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                  <span className="text-xs text-gray-400 w-9 text-right shrink-0">{pct.toFixed(1)}%</span>
                  <button onClick={() => { setEditId(cat.id); setEditName(cat.name) }} className="text-gray-400 hover:text-gold p-1"><Pencil size={13} /></button>
                  <button onClick={() => handleDelete(cat.id, cat.name)} className="text-gray-400 hover:text-red-500 p-1"><Trash2 size={13} /></button>
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

```


---

## `src/app/setup/storage-areas/page.tsx`

```tsx
'use client'
import { useEffect, useState } from 'react'
import { Plus, Pencil, Trash2, Check, X, MapPin } from 'lucide-react'

interface StorageArea {
  id: string
  name: string
  _count?: { items: number }
}

export default function StorageAreasPage() {
  const [areas, setAreas] = useState<StorageArea[]>([])
  const [newName, setNewName] = useState('')
  const [editId, setEditId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')

  const fetchAreas = () => fetch('/api/storage-areas').then(r => r.json()).then(setAreas)
  useEffect(() => { fetchAreas() }, [])

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newName.trim()) return
    await fetch('/api/storage-areas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newName.trim() }) })
    setNewName('')
    fetchAreas()
  }

  const handleEdit = async (id: string) => {
    if (!editName.trim()) return
    await fetch(`/api/storage-areas/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: editName.trim() }) })
    setEditId(null)
    fetchAreas()
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this storage area? Items will be unlinked.')) return
    await fetch(`/api/storage-areas/${id}`, { method: 'DELETE' })
    fetchAreas()
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <h2 className="text-xl font-bold text-gray-900">Storage Areas</h2>
        <p className="text-sm text-gray-500 mt-0.5">Define where inventory items are physically stored</p>
      </div>

      {/* Add form */}
      <form onSubmit={handleAdd} className="flex gap-2">
        <input
          value={newName}
          onChange={e => setNewName(e.target.value)}
          placeholder="New storage area name..."
          className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
        />
        <button type="submit" className="flex items-center gap-2 bg-gold text-white px-3 py-2 rounded-lg text-sm hover:bg-[#a88930]">
          <Plus size={15} /> Add
        </button>
      </form>

      {/* List */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm divide-y divide-gray-50">
        {areas.length === 0 && <div className="text-center py-12 text-gray-400">No storage areas yet</div>}
        {areas.map(area => (
          <div key={area.id} className="flex items-center gap-3 px-4 py-3">
            <MapPin size={16} className="text-gray-400 shrink-0" />
            {editId === area.id ? (
              <>
                <input
                  autoFocus
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleEdit(area.id); if (e.key === 'Escape') setEditId(null) }}
                  className="flex-1 border border-blue-300 rounded px-2 py-1 text-sm focus:outline-none"
                />
                <button onClick={() => handleEdit(area.id)} className="text-green-600 hover:text-green-700"><Check size={16} /></button>
                <button onClick={() => setEditId(null)} className="text-gray-400 hover:text-gray-600"><X size={16} /></button>
              </>
            ) : (
              <>
                <div className="flex-1">
                  <div className="text-sm font-medium text-gray-800">{area.name}</div>
                  <div className="text-xs text-gray-400">{area._count?.items ?? 0} items</div>
                </div>
                <button onClick={() => { setEditId(area.id); setEditName(area.name) }} className="text-gray-400 hover:text-gold p-1"><Pencil size={14} /></button>
                <button onClick={() => handleDelete(area.id)} className="text-gray-400 hover:text-red-500 p-1"><Trash2 size={14} /></button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

```


---

## `src/app/setup/revenue-centers/page.tsx`

```tsx
'use client'
import { useState } from 'react'
import { Plus, Pencil, Trash2, Star, User, Target, ChevronDown, ChevronUp } from 'lucide-react'
import { RC_COLORS, rcHex } from '@/lib/rc-colors'
import { useRc, RevenueCenter } from '@/contexts/RevenueCenterContext'

const RC_TYPES = [
  { value: 'restaurant', label: 'Restaurant Service' },
  { value: 'catering',   label: 'Catering' },
  { value: 'events',     label: 'Events' },
  { value: 'retail',     label: 'Retail' },
  { value: 'other',      label: 'Other' },
] as const

interface RcFormData {
  name: string
  color: string
  isDefault: boolean
  isActive: boolean
  type: string
  description: string
  managerName: string
  targetFoodCostPct: string
  notes: string
}

const EMPTY_FORM: RcFormData = {
  name: '', color: 'blue', isDefault: false, isActive: true,
  type: 'other', description: '', managerName: '', targetFoodCostPct: '', notes: '',
}

function RcFormModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: RevenueCenter | null
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<RcFormData>(
    initial
      ? {
          name:              initial.name,
          color:             initial.color,
          isDefault:         initial.isDefault,
          isActive:          initial.isActive,
          type:              initial.type || 'other',
          description:       initial.description       ?? '',
          managerName:       initial.managerName       ?? '',
          targetFoodCostPct: initial.targetFoodCostPct != null ? String(parseFloat(initial.targetFoodCostPct)) : '',
          notes:             initial.notes             ?? '',
        }
      : EMPTY_FORM
  )
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim()) { setError('Name is required'); return }
    setSaving(true)
    const payload = {
      ...form,
      targetFoodCostPct: form.targetFoodCostPct !== '' ? parseFloat(form.targetFoodCostPct) : null,
      description:  form.description  || null,
      managerName:  form.managerName  || null,
      notes:        form.notes        || null,
    }
    const res = await fetch(
      initial ? `/api/revenue-centers/${initial.id}` : '/api/revenue-centers',
      { method: initial ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
    )
    setSaving(false)
    if (!res.ok) { const d = await res.json(); setError(d.error || 'Failed'); return }
    onSaved()
    onClose()
  }

  const f = (key: keyof RcFormData, val: string | boolean) =>
    setForm(prev => ({ ...prev, [key]: val }))

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-50" onClick={onClose} />
      <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4">
        <div className="bg-white w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl shadow-xl max-h-[90vh] overflow-y-auto">
          <div className="sticky top-0 bg-white px-5 pt-5 pb-3 border-b border-gray-100">
            <h3 className="font-semibold text-gray-900">
              {initial ? 'Edit Revenue Center' : 'New Revenue Center'}
            </h3>
          </div>

          <form onSubmit={handleSubmit} className="p-5 space-y-4">
            {/* Name */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Name *</label>
              <input
                autoFocus
                value={form.name}
                onChange={e => f('name', e.target.value)}
                placeholder="e.g. Catering, Events..."
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
              />
            </div>

            {/* Type */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Type</label>
              <select
                value={form.type}
                onChange={e => f('type', e.target.value)}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gold"
              >
                {RC_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>

            {/* Color */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-2">Color</label>
              <div className="grid grid-cols-8 gap-2">
                {RC_COLORS.map(c => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => f('color', c)}
                    className={`w-7 h-7 rounded-full transition-transform ${form.color === c ? 'ring-2 ring-offset-2 ring-gray-400 scale-110' : ''}`}
                    style={{ backgroundColor: rcHex(c) }}
                  />
                ))}
              </div>
            </div>

            {/* Description */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Description</label>
              <input
                value={form.description}
                onChange={e => f('description', e.target.value)}
                placeholder="What does this revenue center handle?"
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
              />
            </div>

            {/* Manager + Target food cost */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Manager</label>
                <input
                  value={form.managerName}
                  onChange={e => f('managerName', e.target.value)}
                  placeholder="Name"
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Target Food Cost %</label>
                <div className="relative">
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.1"
                    value={form.targetFoodCostPct}
                    onChange={e => f('targetFoodCostPct', e.target.value)}
                    placeholder="e.g. 28"
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 pr-7 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">%</span>
                </div>
              </div>
            </div>

            {/* Notes */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Notes</label>
              <textarea
                value={form.notes}
                onChange={e => f('notes', e.target.value)}
                placeholder="Any internal notes..."
                rows={2}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold resize-none"
              />
            </div>

            {/* Toggles */}
            <div className="flex flex-col gap-2 pt-1">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.isDefault}
                  onChange={e => f('isDefault', e.target.checked)}
                  className="rounded border-gray-300"
                />
                <span className="text-sm text-gray-700">Set as default revenue center</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={e => f('isActive', e.target.checked)}
                  className="rounded border-gray-300"
                />
                <span className="text-sm text-gray-700">Active</span>
              </label>
            </div>

            {error && <p className="text-xs text-red-500">{error}</p>}

            <div className="flex gap-2 pt-1 pb-[env(safe-area-inset-bottom)]">
              <button
                type="submit"
                disabled={saving}
                className="flex-1 py-2.5 bg-gray-900 text-white text-sm font-medium rounded-xl hover:bg-gray-800 disabled:opacity-50"
              >
                {saving ? 'Saving…' : initial ? 'Save Changes' : 'Create'}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 border border-gray-200 rounded-xl text-sm text-gray-600 hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  )
}

function RcCard({ rc, onEdit, onDelete }: { rc: RevenueCenter; onEdit: () => void; onDelete: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const typeLabel = RC_TYPES.find(t => t.value === rc.type)?.label ?? rc.type
  const hasDetails = rc.description || rc.managerName || rc.targetFoodCostPct || rc.notes

  return (
    <div className={`bg-white border rounded-2xl overflow-hidden transition-all ${rc.isActive ? 'border-gray-100' : 'border-gray-200 opacity-60'}`}>
      {/* Color accent bar */}
      <div className="h-1.5" style={{ backgroundColor: rcHex(rc.color) }} />

      <div className="p-4">
        <div className="flex items-start gap-3">
          <span className="w-10 h-10 rounded-xl shrink-0 flex items-center justify-center text-white font-bold text-lg"
            style={{ backgroundColor: rcHex(rc.color) }}>
            {rc.name[0].toUpperCase()}
          </span>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold text-gray-900">{rc.name}</h3>
              {rc.isDefault && (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded-full">
                  <Star size={9} /> Default
                </span>
              )}
              {!rc.isActive && (
                <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded-full">
                  Inactive
                </span>
              )}
              <span className="text-[10px] font-medium text-gray-400 bg-gray-50 px-1.5 py-0.5 rounded-full border border-gray-100">
                {typeLabel}
              </span>
            </div>

            {rc.description && (
              <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{rc.description}</p>
            )}

            {/* Key info row */}
            <div className="flex flex-wrap gap-3 mt-2">
              {rc.managerName && (
                <span className="flex items-center gap-1 text-xs text-gray-500">
                  <User size={11} /> {rc.managerName}
                </span>
              )}
              {rc.targetFoodCostPct != null && (
                <span className="flex items-center gap-1 text-xs text-gray-500">
                  <Target size={11} /> {parseFloat(rc.targetFoodCostPct)}% food cost target
                </span>
              )}
            </div>

            {rc.notes && (
              <div className="mt-2">
                {expanded ? (
                  <p className="text-xs text-gray-400 leading-relaxed">{rc.notes}</p>
                ) : null}
                <button
                  onClick={() => setExpanded(e => !e)}
                  className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-600 mt-1"
                >
                  {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                  {expanded ? 'Hide notes' : 'Show notes'}
                </button>
              </div>
            )}
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={onEdit}
              className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
              title="Edit"
            >
              <Pencil size={14} />
            </button>
            <button
              onClick={onDelete}
              className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
              title="Delete"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function RevenueCentersPage() {
  const { revenueCenters, reload } = useRc()
  const [editTarget, setEditTarget] = useState<RevenueCenter | null>(null)
  const [showForm, setShowForm]     = useState(false)
  const [deleteError, setDeleteError] = useState('')

  const handleDelete = async (rc: RevenueCenter) => {
    if (!confirm(`Delete "${rc.name}"?`)) return
    const res = await fetch(`/api/revenue-centers/${rc.id}`, { method: 'DELETE' })
    if (!res.ok) { const d = await res.json(); setDeleteError(d.error || 'Failed to delete'); return }
    setDeleteError('')
    reload()
  }

  const openAdd  = () => { setEditTarget(null); setShowForm(true) }
  const openEdit = (rc: RevenueCenter) => { setEditTarget(rc); setShowForm(true) }

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Revenue Centers</h1>
          <p className="text-sm text-gray-500 mt-0.5">{revenueCenters.length} center{revenueCenters.length !== 1 ? 's' : ''}</p>
        </div>
        <button
          onClick={openAdd}
          className="flex items-center gap-1.5 bg-gold text-white px-3 py-2 rounded-xl text-sm font-semibold hover:bg-[#a88930]"
        >
          <Plus size={16} /> Add
        </button>
      </div>

      {deleteError && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          {deleteError}
        </div>
      )}

      <div className="space-y-3">
        {revenueCenters.map(rc => (
          <RcCard
            key={rc.id}
            rc={rc}
            onEdit={() => openEdit(rc)}
            onDelete={() => handleDelete(rc)}
          />
        ))}
      </div>

      {showForm && (
        <RcFormModal
          initial={editTarget}
          onClose={() => setShowForm(false)}
          onSaved={reload}
        />
      )}
    </div>
  )
}

```


---

## `src/app/setup/users/page.tsx`

```tsx
'use client'
import { useState, useEffect, useCallback } from 'react'
import { Users, Send, AlertCircle, CheckCircle, Trash2 } from 'lucide-react'
import { useUser } from '@/contexts/UserContext'

type UserRole = 'ADMIN' | 'MANAGER' | 'STAFF'

interface TeamUser {
  id: string
  email: string
  name: string | null
  role: UserRole
  isActive: boolean
  createdAt: string
}

const ROLE_LABELS: Record<UserRole, string> = {
  ADMIN: 'Admin',
  MANAGER: 'Manager',
  STAFF: 'Staff',
}

const ROLE_COLORS: Record<UserRole, string> = {
  ADMIN: 'bg-purple-100 text-purple-700',
  MANAGER: 'bg-gold/15 text-gold',
  STAFF: 'bg-gray-100 text-gray-600',
}

export default function UsersSettingsPage() {
  const { user: currentUser } = useUser()
  const [users, setUsers] = useState<TeamUser[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Invite form state
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<UserRole>('STAFF')
  const [inviteName, setInviteName] = useState('')
  const [inviting, setInviting] = useState(false)
  const [inviteResult, setInviteResult] = useState<{ ok: boolean; message: string } | null>(null)

  const loadUsers = useCallback(async () => {
    setLoadError(null)
    try {
      const res = await fetch('/api/settings/users')
      if (!res.ok) throw new Error(`Failed to load users (${res.status})`)
      setUsers(await res.json())
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load users')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadUsers() }, [loadUsers])

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault()
    setInviting(true)
    setInviteResult(null)
    try {
      const res = await fetch('/api/settings/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail, role: inviteRole, name: inviteName || undefined }),
      })
      const data = await res.json()
      if (res.ok) {
        setInviteResult({ ok: true, message: `Invite sent to ${inviteEmail}` })
        setInviteEmail('')
        setInviteName('')
        setInviteRole('STAFF')
        await loadUsers()
      } else {
        setInviteResult({ ok: false, message: data.error ?? 'Failed to send invite' })
      }
    } catch {
      setInviteResult({ ok: false, message: 'Network error' })
    } finally {
      setInviting(false)
    }
  }

  const handleRoleChange = async (userId: string, newRole: UserRole) => {
    const res = await fetch(`/api/settings/users/${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: newRole }),
    })
    if (res.ok) {
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, role: newRole } : u))
    } else {
      // Reload to get accurate state from server
      loadUsers()
    }
  }

  const handleDeactivate = async (userId: string) => {
    if (!confirm('Deactivate this user? They will be signed out immediately.')) return
    const res = await fetch(`/api/settings/users/${userId}`, { method: 'DELETE' })
    if (res.ok) {
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, isActive: false } : u))
    } else {
      loadUsers()
    }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Page header — desktop only */}
      <div className="hidden md:block border-b border-gray-100 pb-4">
        <h2 className="text-lg font-semibold text-gray-900">Team</h2>
        <p className="text-sm text-gray-500 mt-0.5">Manage users and invite new team members</p>
      </div>

      {/* Invite card */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-50">
          <div className="w-8 h-8 bg-gold/15 rounded-lg flex items-center justify-center shrink-0">
            <Send size={15} className="text-gold" />
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-900">Invite a Team Member</p>
            <p className="text-xs text-gray-400">They'll receive an email to set up their account</p>
          </div>
        </div>

        <form onSubmit={handleInvite} className="px-5 py-4 space-y-3">
          <div className="flex gap-2">
            <label htmlFor="invite-name" className="sr-only">Name (optional)</label>
            <input
              id="invite-name"
              type="text"
              value={inviteName}
              onChange={e => setInviteName(e.target.value)}
              placeholder="Name (optional)"
              className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
            />
          </div>
          <div className="flex gap-2">
            <label htmlFor="invite-email" className="sr-only">Email address</label>
            <input
              id="invite-email"
              type="email"
              value={inviteEmail}
              onChange={e => setInviteEmail(e.target.value)}
              placeholder="Email address"
              required
              className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
            />
            <label htmlFor="invite-role" className="sr-only">Role</label>
            <select
              id="invite-role"
              value={inviteRole}
              onChange={e => setInviteRole(e.target.value as UserRole)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold bg-white"
            >
              <option value="STAFF">Staff</option>
              <option value="MANAGER">Manager</option>
              <option value="ADMIN">Admin</option>
            </select>
            <button
              type="submit"
              disabled={inviting}
              className="flex items-center gap-2 bg-gold text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#a88930] disabled:opacity-50 whitespace-nowrap transition-colors"
            >
              <Send size={13} />
              {inviting ? 'Sending…' : 'Send Invite'}
            </button>
          </div>
          {inviteResult && (
            <div className={`flex items-center gap-2 p-2.5 rounded-lg text-xs ${inviteResult.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
              {inviteResult.ok ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
              {inviteResult.message}
            </div>
          )}
        </form>
      </div>

      {/* Team list */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-50">
          <div className="w-8 h-8 bg-gray-100 rounded-lg flex items-center justify-center shrink-0">
            <Users size={15} className="text-gray-600" />
          </div>
          <p className="text-sm font-semibold text-gray-900">Team Members</p>
        </div>

        {loading ? (
          <div className="px-5 py-8 text-sm text-gray-400 text-center">Loading…</div>
        ) : loadError ? (
          <div className="px-5 py-8 text-sm text-red-500 text-center">{loadError}</div>
        ) : users.length === 0 ? (
          <div className="px-5 py-8 text-sm text-gray-400 text-center">No team members yet</div>
        ) : (
          <div className="divide-y divide-gray-50">
            {users.map(u => {
              const isMe = u.id === currentUser?.id
              return (
                <div key={u.id} className={`flex items-center gap-3 px-5 py-3.5 ${!u.isActive ? 'opacity-50' : ''}`}>
                  {/* Avatar */}
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center shrink-0">
                    <span className="text-white text-xs font-semibold">
                      {(u.name ?? u.email)[0].toUpperCase()}
                    </span>
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p className="text-sm font-medium text-gray-900 truncate">
                        {u.name ?? u.email}
                      </p>
                      {isMe && (
                        <span className="text-[10px] font-semibold bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded-full">
                          You
                        </span>
                      )}
                      {!u.isActive && (
                        <span className="text-[10px] font-semibold bg-red-100 text-red-500 px-1.5 py-0.5 rounded-full">
                          Inactive
                        </span>
                      )}
                      {/* Pending: isActive but no name — user invited but hasn't set a display name yet.
                          Note: this heuristic cannot distinguish "never accepted invite" from
                          "accepted but skipped name". A dedicated status field would be more precise. */}
                      {u.isActive && !u.name && (
                        <span className="text-[10px] font-semibold bg-amber-100 text-amber-600 px-1.5 py-0.5 rounded-full">
                          Pending
                        </span>
                      )}
                    </div>
                    {u.name && (
                      <p className="text-xs text-gray-400 truncate">{u.email}</p>
                    )}
                  </div>

                  {/* Role badge / selector */}
                  {isMe ? (
                    <span className={`text-xs font-medium px-2 py-1 rounded-full ${ROLE_COLORS[u.role]}`}>
                      {ROLE_LABELS[u.role]}
                    </span>
                  ) : (
                    <select
                      value={u.role}
                      onChange={e => handleRoleChange(u.id, e.target.value as UserRole)}
                      disabled={!u.isActive}
                      className={`text-xs font-medium px-2 py-1 rounded-full border-0 cursor-pointer focus:outline-none focus:ring-2 focus:ring-gold ${ROLE_COLORS[u.role]} disabled:cursor-default`}
                    >
                      <option value="STAFF">Staff</option>
                      <option value="MANAGER">Manager</option>
                      <option value="ADMIN">Admin</option>
                    </select>
                  )}

                  {/* Deactivate button */}
                  {!isMe && u.isActive && (
                    <button
                      onClick={() => handleDeactivate(u.id)}
                      title="Deactivate user"
                      className="p-1.5 rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50 transition-all"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

```


---

## `src/app/setup/uom/page.tsx`

```tsx
'use client'
import { Ruler, ArrowRight } from 'lucide-react'
import { PageHead } from '@/components/layout/PageHead'
import { UOM_GROUPS } from '@/lib/uom'

export default function UomPage() {
  return (
    <div>
      <PageHead
        crumbs={<><Ruler size={12} /> SETUP / UOM &amp; CONVERSIONS</>}
        title="UOM & conversions"
        sub={<>Unit-of-measure groups the app uses to convert between purchase, recipe, and count units.</>}
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {UOM_GROUPS.map(group => (
          <section key={group.label} className="bg-paper border border-line rounded-[12px] overflow-hidden">
            <header className="px-[18px] py-3 border-b border-line bg-bg-2">
              <h2 className="text-[15px] font-semibold tracking-[-0.015em]">{group.label}</h2>
              <p className="font-mono text-[10.5px] text-ink-3 mt-0.5">{group.units.length} units</p>
            </header>
            <div className="divide-y divide-line">
              {group.units.map(u => {
                const isBase = u.toBase === 1
                return (
                  <div key={u.label} className="grid grid-cols-[1fr_auto_auto] gap-3 items-center px-[18px] py-2.5">
                    <div>
                      <div className="text-[13px] text-ink font-medium tracking-[-0.005em]">{u.label}</div>
                      {isBase && <div className="font-mono text-[10px] uppercase tracking-[0.04em] text-gold-2 mt-0.5">Base unit</div>}
                    </div>
                    <div className="font-mono text-[11px] text-ink-3 inline-flex items-center gap-1">
                      <span>1 {u.label}</span>
                      <ArrowRight size={10} />
                    </div>
                    <div className="font-mono text-[12px] text-ink font-medium tabular-nums">{u.toBase.toLocaleString(undefined, { maximumFractionDigits: 4 })} {group.units[0].label}</div>
                  </div>
                )
              })}
            </div>
          </section>
        ))}
      </div>

      <div className="mt-5 bg-paper border border-line rounded-[12px] p-5">
        <h3 className="text-[13px] font-semibold tracking-[-0.01em] mb-2">Conversion inspector</h3>
        <p className="text-[13px] text-ink-2 leading-[1.5] tracking-[-0.005em]">
          The conversion factor is always relative to the group&apos;s base unit (gram, milliliter, or each).
          Recipe costing reads <span className="font-mono text-gold-2">pricePerBaseUnit</span> from the inventory ledger,
          then multiplies by the unit&apos;s factor — so a recipe calling for 250 ml of olive oil at
          $0.012/ml costs $3.00, while the same oil bought by the case (4 × 3 L) was stored once at the base price.
          Adding a unit needs a code change today; a UI for custom conversions is on the roadmap.
        </p>
      </div>
    </div>
  )
}

```


---

## `src/app/login/page.tsx`

```tsx
'use client'
import { useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Image from 'next/image'
import { createClient } from '@/lib/supabase/client'

function LoginPageInner() {
  const [mode, setMode] = useState<'login' | 'forgot'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()
  const searchParams = useSearchParams()
  const urlError = searchParams.get('error')

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    const supabase = createClient()
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      setError(error.message)
      setLoading(false)
    } else {
      router.push('/')
    }
  }

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    const supabase = createClient()
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/auth/set-password`,
    })
    setLoading(false)
    if (error) {
      setError(error.message)
    } else {
      setMessage('Check your email for a password reset link.')
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4"
      style={{ background: '#0a0a0a' }}>

      {/* Subtle radial glow behind card */}
      <div className="absolute inset-0 pointer-events-none"
        style={{ background: 'radial-gradient(ellipse 60% 50% at 50% 40%, rgba(201,168,76,0.07) 0%, transparent 70%)' }} />

      <div className="relative w-full max-w-sm">
        {/* Logo mark */}
        <div className="flex flex-col items-center mb-8">
          <Image src="/logo-icon.png" alt="Controla OS" width={56} height={56}
            className="rounded-2xl mb-4" />
          <h1 className="text-xl font-bold tracking-wide" style={{ color: '#c9a84c' }}>
            Controla OS
          </h1>
          <p className="text-xs mt-1" style={{ color: 'rgba(255,255,255,0.3)' }}>
            Fergie&apos;s Kitchen
          </p>
        </div>

        {/* Card */}
        <div className="rounded-2xl p-7"
          style={{ background: '#161616', border: '1px solid rgba(255,255,255,0.08)' }}>

          {mode === 'login' ? (
            <form onSubmit={handleLogin} className="space-y-4">
              {urlError === 'invalid_link' && (
                <div className="rounded-lg px-3 py-2 text-xs"
                  style={{ background: 'rgba(217,119,6,0.12)', border: '1px solid rgba(217,119,6,0.25)', color: '#fbbf24' }}>
                  This link has expired or is invalid. Please request a new invite.
                </div>
              )}
              {urlError === 'deactivated' && (
                <div className="rounded-lg px-3 py-2 text-xs"
                  style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.25)', color: '#f87171' }}>
                  Your account has been deactivated. Please contact your admin.
                </div>
              )}
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-widest mb-1.5"
                  style={{ color: 'rgba(255,255,255,0.35)' }}>
                  Email
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  className="w-full px-3 py-2.5 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-gold transition-colors"
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-widest mb-1.5"
                  style={{ color: 'rgba(255,255,255,0.35)' }}>
                  Password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  className="w-full px-3 py-2.5 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-gold transition-colors"
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                />
              </div>
              {error && <p className="text-xs" style={{ color: '#f87171' }}>{error}</p>}
              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 rounded-lg text-sm font-semibold disabled:opacity-50 transition-all mt-2"
                style={{ background: '#c9a84c', color: '#0a0a0a' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#a88930')}
                onMouseLeave={e => (e.currentTarget.style.background = '#c9a84c')}
              >
                {loading ? 'Signing in…' : 'Sign in'}
              </button>
              <button
                type="button"
                onClick={() => { setMode('forgot'); setError('') }}
                className="w-full text-xs text-center pt-1 transition-colors"
                style={{ color: 'rgba(255,255,255,0.3)' }}
                onMouseEnter={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.6)')}
                onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.3)')}
              >
                Forgot password?
              </button>
            </form>
          ) : (
            <form onSubmit={handleForgot} className="space-y-4">
              <p className="text-sm" style={{ color: 'rgba(255,255,255,0.5)' }}>
                Enter your email and we&apos;ll send a password reset link.
              </p>
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-widest mb-1.5"
                  style={{ color: 'rgba(255,255,255,0.35)' }}>
                  Email
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="w-full px-3 py-2.5 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-gold transition-colors"
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                />
              </div>
              {error && <p className="text-xs" style={{ color: '#f87171' }}>{error}</p>}
              {message && <p className="text-xs" style={{ color: '#4ade80' }}>{message}</p>}
              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 rounded-lg text-sm font-semibold disabled:opacity-50 transition-all mt-2"
                style={{ background: '#c9a84c', color: '#0a0a0a' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#a88930')}
                onMouseLeave={e => (e.currentTarget.style.background = '#c9a84c')}
              >
                {loading ? 'Sending…' : 'Send reset link'}
              </button>
              <button
                type="button"
                onClick={() => { setMode('login'); setError(''); setMessage('') }}
                className="w-full text-xs text-center pt-1 transition-colors"
                style={{ color: 'rgba(255,255,255,0.3)' }}
                onMouseEnter={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.6)')}
                onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.3)')}
              >
                Back to sign in
              </button>
            </form>
          )}
        </div>

        <p className="text-xs text-center mt-5" style={{ color: 'rgba(255,255,255,0.2)' }}>
          Don&apos;t have an account? Ask your admin for an invite.
        </p>
      </div>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginPageInner />
    </Suspense>
  )
}

```


---

## `src/app/auth/set-password/page.tsx`

```tsx
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { ChefHat, CheckCircle } from 'lucide-react'

export default function SetPasswordPage() {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }
    setLoading(true)
    setError('')
    const supabase = createClient()
    const { error } = await supabase.auth.updateUser({ password })
    setLoading(false)
    if (error) {
      setError(error.message)
    } else {
      setDone(true)
      setTimeout(() => router.push('/'), 1500)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 w-full max-w-sm">
        <div className="flex items-center gap-2 mb-8">
          <div className="w-9 h-9 bg-gold rounded-xl flex items-center justify-center">
            <ChefHat size={18} className="text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-gray-900 leading-tight">Set your password</h1>
            <p className="text-xs text-gray-400">Choose a password to secure your account</p>
          </div>
        </div>

        {done ? (
          <div className="flex items-center gap-2 text-green-600 text-sm">
            <CheckCircle size={16} />
            Password set! Redirecting\u2026
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
                New Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
                Confirm Password
              </label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                autoComplete="new-password"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
              />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-gold text-white py-2 rounded-lg text-sm font-medium hover:bg-[#a88930] disabled:opacity-50 transition-colors"
            >
              {loading ? 'Saving\u2026' : 'Set password'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

```
