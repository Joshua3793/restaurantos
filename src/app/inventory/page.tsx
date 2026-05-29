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
  priceType?: 'CASE' | 'UOM' | null
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
            <span className="text-ink-3 text-[10.5px] ml-1">/{item.priceType === 'UOM' ? (item.packUOM || item.baseUnit) : item.purchaseUnit}</span>
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
          <div className="font-mono text-[10px] text-ink-4">/{item.priceType === 'UOM' ? (item.packUOM || item.baseUnit) : item.purchaseUnit}</div>
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
