'use client'
import { useEffect, useRef, useState } from 'react'
import { X, Pencil, Loader2 } from 'lucide-react'
import {
  formatCurrency, formatUnitPrice,
  PACK_UOMS, COUNT_UOMS, PURCHASE_UNITS, QTY_UOMS,
  calcPricePerBaseUnit, calcConversionFactor, deriveBaseUnit,
  getUnitDimension, compatibleCountUnits,
} from '@/lib/utils'
import { convertCountQtyToBase, convertBaseToCountUom } from '@/lib/count-uom'
import { CategoryBadge } from '@/components/CategoryBadge'
import { StockStatus } from '@/components/StockStatus'
import { RcAllocationPanel } from '@/components/inventory/RcAllocationPanel'
import { AllergenBadges, AllergenToggles } from '@/components/AllergenBadges'
import { useRc } from '@/contexts/RevenueCenterContext'

// ─── Types ────────────────────────────────────────────────────────────────────

type MovementType = 'SALE' | 'WASTAGE' | 'PREP_IN' | 'PREP_OUT' | 'PURCHASE'

interface StockMovement {
  id: string; date: string; type: MovementType
  qty: number; unit: string; description: string
}

interface StockMovementsResponse {
  lastCount: { qty: number; unit: string; date: string | null }
  theoretical: { qty: number; unit: string }
  movements: StockMovement[]
}

interface InventoryItem {
  id: string; itemName: string; category: string
  supplier?: { id: string; name: string } | null
  supplierId?: string | null
  storageArea?: { id: string; name: string } | null
  storageAreaId?: string | null
  purchaseUnit: string; qtyPerPurchaseUnit: number
  purchasePrice: number; baseUnit: string
  packSize: number; packUOM: string; countUOM: string
  conversionFactor: number; pricePerBaseUnit: number
  stockOnHand: number
  allergens?: string[]
  barcode?: string | null
  isActive: boolean
  qtyUOM?: string | null
  innerQty?: number | string | null
  needsReview?: boolean | null
  lastCountDate?: string | null; lastCountQty?: number | null
  recipe?: { id: string; name: string } | null
}

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

interface Props {
  itemId: string
  onClose: () => void
  onUpdated?: () => void
}

// ─── Purchase description ─────────────────────────────────────────────────────

function buildPurchaseDescription(
  purchaseUnit: string,
  qty: number,
  qtyUOM: string,
  innerQty: number | null,
  packSize: number,
  packUOM: string,
): string {
  const pu = purchaseUnit || 'unit'
  const weightVol = ['kg', 'g', 'lb', 'oz', 'l', 'ml']
  if (weightVol.includes(qtyUOM)) return `${pu} of ${qty} ${qtyUOM}`
  const hasWeight = packSize > 0 && packSize !== 1 && packUOM && !['each', ''].includes(packUOM)
  if (qtyUOM === 'pack' && innerQty) {
    return hasWeight
      ? `${pu} of ${qty} packs × ${innerQty} × ${packSize}${packUOM}`
      : `${pu} of ${qty} packs × ${innerQty} each`
  }
  return hasWeight
    ? `${pu} of ${qty} × ${packSize}${packUOM} each`
    : `${pu} of ${qty} each`
}

// ─── Combobox (local copy — avoids coupling to inventory page) ────────────────

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
        <div className="absolute z-10 top-full left-0 right-0 bg-white border border-gray-200 rounded-lg shadow-lg mt-1 max-h-48 overflow-y-auto">
          {filtered.map(i => (
            <button key={i.id} type="button"
              className="w-full text-left px-3 py-2 text-sm hover:bg-gold/10"
              onClick={() => { onSelect(i.id, i.name); setOpen(false); setQuery('') }}
            >{i.name}</button>
          ))}
          {!exactMatch && query && onAddNew && (
            <button type="button"
              className="w-full text-left px-3 py-2 text-sm text-gold font-medium hover:bg-gold/10"
              onClick={async () => { const r = await onAddNew(query); onSelect(r.id, r.name); setOpen(false); setQuery('') }}
            >+ Add &quot;{query}&quot;</button>
          )}
          {filtered.length === 0 && !query && <div className="px-3 py-2 text-xs text-gray-400">No options</div>}
        </div>
      )}
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function displayStock(item: InventoryItem): number {
  return convertBaseToCountUom(Number(item.stockOnHand), item.countUOM ?? 'each', {
    baseUnit: item.baseUnit,
    purchaseUnit: item.purchaseUnit,
    qtyPerPurchaseUnit: Number(item.qtyPerPurchaseUnit),
    qtyUOM: item.qtyUOM ?? 'each',
    innerQty: item.innerQty != null ? Number(item.innerQty) : null,
    packSize: Number(item.packSize ?? 1),
    packUOM: item.packUOM ?? 'each',
    countUOM: item.countUOM ?? 'each',
  })
}

// ─── Main component ────────────────────────────────────────────────────────────

export function InventoryItemDrawer({ itemId, onClose, onUpdated }: Props) {
  const { revenueCenters } = useRc()
  const defaultRcId = revenueCenters.find(rc => rc.isDefault)?.id ?? null

  const [item, setItem] = useState<InventoryItem | null>(null)
  const [loading, setLoading] = useState(true)
  const [editMode, setEditMode] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editForm, setEditForm] = useState<EditForm>({
    itemName: '', category: '', supplierId: '', supplierName: '',
    storageAreaId: '', storageAreaName: '', purchaseUnit: 'case',
    qtyPerPurchaseUnit: '1', purchasePrice: '0',
    packSize: '1', packUOM: 'each', countUOM: 'each',
    qtyUOM: 'each', innerQty: '',
    stockOnHand: '0', isActive: true, allergens: [], barcode: null,
  })
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([])
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([])
  const [storageAreas, setStorageAreas] = useState<{ id: string; name: string }[]>([])
  const [priceHistory, setPriceHistory] = useState<Array<{
    invoiceDate: string; invoiceNumber: string; supplierName: string;
    qtyPurchased: number; unitPrice: number; lineTotal: number
  }>>([])
  const [stockMovements, setStockMovements] = useState<StockMovementsResponse | null>(null)

  useEffect(() => {
    setLoading(true)
    Promise.all([
      fetch(`/api/inventory/${itemId}`).then(r => r.json()),
      fetch('/api/suppliers').then(r => r.json()),
      fetch('/api/categories').then(r => r.json()),
      fetch('/api/storage-areas').then(r => r.json()),
      fetch(`/api/inventory/${itemId}/price-history`).then(r => r.json()).catch(() => []),
      fetch(`/api/inventory/${itemId}/stock-movements`).then(r => r.json()).catch(() => null),
    ]).then(([fetchedItem, sups, cats, areas, ph, sm]) => {
      setItem(fetchedItem)
      setSuppliers(sups)
      setCategories(cats)
      setStorageAreas(areas)
      setPriceHistory(ph)
      setStockMovements(sm)
      setLoading(false)
    })
  }, [itemId])

  const openEdit = () => {
    if (!item) return
    setEditForm({
      itemName: item.itemName,
      category: item.category,
      supplierId: item.supplierId || '',
      supplierName: item.supplier?.name || '',
      storageAreaId: item.storageAreaId || '',
      storageAreaName: item.storageArea?.name || '',
      purchaseUnit: item.purchaseUnit,
      qtyPerPurchaseUnit: String(item.qtyPerPurchaseUnit),
      purchasePrice: String(item.purchasePrice),
      packSize: String(item.packSize ?? 1),
      packUOM: item.packUOM ?? 'each',
      countUOM: item.countUOM ?? 'each',
      qtyUOM: item.qtyUOM ?? 'each',
      innerQty: item.innerQty != null ? String(item.innerQty) : '',
      stockOnHand: String(parseFloat(displayStock(item).toFixed(4))),
      isActive: item.isActive,
      allergens: item.allergens ?? [],
      barcode: item.barcode ?? null,
    })
    setEditMode(true)
  }

  const handleSave = async () => {
    if (!item) return
    setSaving(true)
    const res = await fetch(`/api/inventory/${item.id}`, {
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
          baseUnit: item.baseUnit,
          purchaseUnit: editForm.purchaseUnit,
          qtyPerPurchaseUnit: parseFloat(editForm.qtyPerPurchaseUnit) || 1,
          qtyUOM: editForm.qtyUOM,
          innerQty: editForm.innerQty ? parseFloat(editForm.innerQty) : null,
          packSize: parseFloat(editForm.packSize) || 1,
          packUOM: editForm.packUOM,
          countUOM: editForm.countUOM,
        }),
        isActive: editForm.isActive,
        allergens: editForm.allergens,
        barcode: editForm.barcode,
      }),
    })
    const updated = await res.json()
    setItem({ ...item, ...updated, supplier: updated.supplier, storageArea: updated.storageArea })
    setEditMode(false)
    setSaving(false)
    onUpdated?.()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-stretch sm:justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/30" />
      <div
        className="relative bg-white w-full sm:max-w-md h-[92vh] sm:h-full overflow-y-auto shadow-xl rounded-t-2xl sm:rounded-none"
        onClick={e => e.stopPropagation()}
      >
        {loading ? (
          <div className="flex items-center justify-center h-48">
            <Loader2 size={24} className="animate-spin text-gray-300" />
          </div>
        ) : !item ? (
          <div className="flex items-center justify-center h-48 text-gray-400 text-sm">Item not found</div>
        ) : (
          <>
            {/* Header */}
            <div className="sticky top-0 bg-white border-b border-gray-100 p-4 flex items-center justify-between gap-2">
              <div className="flex-1 min-w-0">
                {editMode ? (
                  <input
                    value={editForm.itemName}
                    onChange={e => setEditForm(f => ({ ...f, itemName: e.target.value }))}
                    className="w-full font-semibold text-gray-900 border border-gray-200 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                  />
                ) : (
                  <h2 className="font-semibold text-gray-900 truncate">{item.itemName}</h2>
                )}
                {item.storageArea && !editMode && <p className="text-xs text-gray-400">{item.storageArea.name}</p>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {editMode ? (
                  <>
                    <button
                      onClick={handleSave}
                      disabled={saving}
                      className="px-3 py-1.5 bg-gold text-white text-xs rounded-lg hover:bg-[#a88930] disabled:opacity-50 flex items-center gap-1"
                    >
                      {saving && <Loader2 size={10} className="animate-spin" />}
                      Save
                    </button>
                    <button onClick={() => setEditMode(false)} className="px-3 py-1.5 border border-gray-200 text-xs rounded-lg hover:bg-gray-50">Cancel</button>
                  </>
                ) : (
                  <button
                    onClick={openEdit}
                    className="flex items-center gap-1.5 px-3 py-1.5 border border-gray-200 text-xs rounded-lg hover:bg-gray-50"
                  >
                    <Pencil size={12} /> Edit
                  </button>
                )}
                <button onClick={onClose}><X size={20} className="text-gray-400" /></button>
              </div>
            </div>

            {editMode ? (
              <div className="p-4 space-y-4">
                {/* Active */}
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={editForm.isActive}
                    onChange={e => setEditForm(f => ({ ...f, isActive: e.target.checked }))}
                    className="w-4 h-4 rounded border-gray-300 text-gold focus:ring-gold"
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

                {item.recipe && (
                  <div className="bg-purple-50 border border-purple-200 rounded-lg px-3 py-2 text-xs text-purple-700 flex items-start gap-2">
                    <span className="text-purple-400 mt-0.5">⟳</span>
                    <span><strong>Price is managed by recipe:</strong> {item.recipe.name}. Edit the recipe to change costs. You can only change Count UOM and stock fields here.</span>
                  </div>
                )}

                {/* Purchase structure */}
                {!item.recipe && (
                  <div className="space-y-3">
                    {/* Row 1: Purchase Unit + Qty/Unit pair */}
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Purchase Unit</label>
                        <select value={editForm.purchaseUnit} onChange={e => setEditForm(f => ({ ...f, purchaseUnit: e.target.value }))}
                          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold bg-white">
                          {PURCHASE_UNITS.map(u => <option key={u}>{u}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Qty per {editForm.purchaseUnit}</label>
                        <div className="flex">
                          <input type="number" step="any" value={editForm.qtyPerPurchaseUnit}
                            onChange={e => setEditForm(f => ({ ...f, qtyPerPurchaseUnit: e.target.value }))}
                            className="w-full border border-gray-200 rounded-l-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold border-r-0" />
                          <select value={editForm.qtyUOM} onChange={e => setEditForm(f => ({ ...f, qtyUOM: e.target.value, innerQty: e.target.value === 'pack' ? f.innerQty : '' }))}
                            className="border border-gray-200 rounded-r-lg px-2 py-2 text-sm text-gray-700 bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gold">
                            {QTY_UOMS.map(u => <option key={u}>{u}</option>)}
                          </select>
                        </div>
                      </div>
                    </div>

                    {/* Conditional: pack breakdown when qtyUOM = pack */}
                    {editForm.qtyUOM === 'pack' && (
                      <div className="ml-3 pl-3 border-l-2 border-amber-300 space-y-2">
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs font-medium text-gray-600 mb-1">Items per Pack</label>
                            <div className="flex">
                              <input type="number" step="any" min="1" value={editForm.innerQty}
                                onChange={e => setEditForm(f => ({ ...f, innerQty: e.target.value }))}
                                className="w-full border border-gray-200 rounded-l-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold border-r-0" />
                              <span className="border border-gray-200 rounded-r-lg px-3 py-2 text-sm text-gray-500 bg-gray-50">each</span>
                            </div>
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-600 mb-1">
                              Weight per Item
                              <span className="ml-1 text-[10px] font-semibold bg-gray-100 text-gray-400 rounded px-1 py-0.5 normal-case tracking-normal">optional</span>
                            </label>
                            <div className="flex">
                              <input type="number" step="any" min="0" value={editForm.packSize === '1' ? '' : editForm.packSize}
                                onChange={e => setEditForm(f => ({ ...f, packSize: e.target.value || '1' }))}
                                placeholder="e.g. 100"
                                className="w-full border border-gray-200 rounded-l-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold border-r-0" />
                              <select value={editForm.packUOM} onChange={e => setEditForm(f => ({ ...f, packUOM: e.target.value }))}
                                className="border border-gray-200 rounded-r-lg px-2 py-2 text-sm text-gray-700 bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gold">
                                {(['g', 'kg', 'ml', 'l', 'lb', 'oz']).map(u => <option key={u}>{u}</option>)}
                              </select>
                            </div>
                            <p className="text-[10px] text-amber-700 bg-amber-50 rounded px-2 py-1 mt-1">Leave blank → price per each. Fill in → price per g, usable in recipes by weight.</p>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Conditional: weight per item when qtyUOM = each */}
                    {editForm.qtyUOM === 'each' && (
                      <div className="ml-3 pl-3 border-l-2 border-amber-300">
                        <label className="block text-xs font-medium text-gray-600 mb-1">
                          Weight per Each
                          <span className="ml-1 text-[10px] font-semibold bg-gray-100 text-gray-400 rounded px-1 py-0.5 normal-case tracking-normal">optional</span>
                        </label>
                        <div className="flex">
                          <input type="number" step="any" min="0" value={editForm.packSize === '1' ? '' : editForm.packSize}
                            onChange={e => setEditForm(f => ({ ...f, packSize: e.target.value || '1' }))}
                            placeholder="e.g. 290"
                            className="w-full border border-gray-200 rounded-l-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold border-r-0" />
                          <select value={editForm.packUOM} onChange={e => setEditForm(f => ({ ...f, packUOM: e.target.value }))}
                            className="border border-gray-200 rounded-r-lg px-2 py-2 text-sm text-gray-700 bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gold">
                            {(['g', 'kg', 'ml', 'l', 'lb', 'oz']).map(u => <option key={u}>{u}</option>)}
                          </select>
                        </div>
                        <p className="text-[10px] text-amber-700 bg-amber-50 rounded px-2 py-1 mt-1">Leave blank → price per each. Fill in → price per g, usable in recipes by weight.</p>
                      </div>
                    )}

                    {/* Generated description label */}
                    {(() => {
                      const desc = buildPurchaseDescription(
                        editForm.purchaseUnit,
                        parseFloat(editForm.qtyPerPurchaseUnit) || 0,
                        editForm.qtyUOM,
                        editForm.innerQty ? parseFloat(editForm.innerQty) : null,
                        parseFloat(editForm.packSize) || 1,
                        editForm.packUOM,
                      )
                      return (
                        <p className="text-xs text-gray-400 italic">= {desc}</p>
                      )
                    })()}

                    {/* Purchase Price */}
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Purchase Price ($)</label>
                      <input type="number" step="any" value={editForm.purchasePrice}
                        onChange={e => setEditForm(f => ({ ...f, purchasePrice: e.target.value }))}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold" />
                    </div>
                  </div>
                )}

                {/* Stock + Count fields */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      Count UOM
                      {item.recipe && (
                        <span className="ml-1 text-purple-500 font-normal">
                          ({getUnitDimension(item.baseUnit)}-compatible)
                        </span>
                      )}
                    </label>
                    <select value={editForm.countUOM} onChange={e => setEditForm(f => ({ ...f, countUOM: e.target.value }))}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold bg-white">
                      {(item.recipe
                        ? compatibleCountUnits(item.baseUnit)
                        : COUNT_UOMS
                      ).map(u => <option key={u}>{u}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Stock On Hand ({editForm.countUOM})</label>
                    <input type="number" step="any" value={editForm.stockOnHand}
                      onChange={e => setEditForm(f => ({ ...f, stockOnHand: e.target.value }))}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold" />
                  </div>
                </div>

                {/* Barcode */}
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Barcode</label>
                  <input
                    type="text"
                    value={editForm.barcode ?? ''}
                    onChange={e => setEditForm(f => ({ ...f, barcode: e.target.value || null }))}
                    placeholder="Scan or type barcode"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold"
                  />
                </div>

                {/* Allergens */}
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
                  const isPrep = !!item.recipe
                  const pp  = parseFloat(editForm.purchasePrice) || 0
                  const qty = parseFloat(editForm.qtyPerPurchaseUnit) || 1
                  const ps  = parseFloat(editForm.packSize) || 1
                  const pu  = editForm.packUOM
                  const cu  = editForm.countUOM
                  const qu  = editForm.qtyUOM ?? 'each'
                  const iq  = editForm.innerQty ? parseFloat(editForm.innerQty) : null
                  const bu  = isPrep ? (item.baseUnit ?? deriveBaseUnit(qu, pu)) : deriveBaseUnit(qu, pu)
                  const ppbu = isPrep
                    ? parseFloat(String(item.pricePerBaseUnit ?? 0))
                    : calcPricePerBaseUnit(pp, qty, qu, iq, ps, pu)
                  const cf = isPrep
                    ? parseFloat(String(item.conversionFactor ?? 1))
                    : calcConversionFactor(cu, qty, qu, iq, ps, pu)
                  return (
                    <div className={`rounded-lg p-3 space-y-1.5 ${isPrep ? 'bg-purple-50' : 'bg-gold/10'}`}>
                      <div className={`text-xs font-semibold uppercase tracking-wide ${isPrep ? 'text-purple-700' : 'text-gold'}`}>
                        {isPrep ? 'Recipe-derived cost' : 'Auto-calculated'}
                      </div>
                      <div className="flex items-baseline gap-1.5">
                        <span className={`text-xs ${isPrep ? 'text-purple-600' : 'text-gold'}`}>Price per {bu}:</span>
                        <span className={`text-lg font-bold ${isPrep ? 'text-purple-700' : 'text-gold'}`}>{formatUnitPrice(ppbu)}</span>
                      </div>
                      <div className="flex items-baseline gap-1.5">
                        <span className={`text-xs ${isPrep ? 'text-purple-600' : 'text-gold'}`}>1 {cu} =</span>
                        <span className={`font-semibold ${isPrep ? 'text-purple-700' : 'text-gold'}`}>{cf.toFixed(4)} {bu}</span>
                      </div>
                      <div className={`text-xs ${isPrep ? 'text-purple-500' : 'text-blue-500'}`}>
                        {isPrep
                          ? `Recipe total ÷ ${ps.toLocaleString()} ${bu} yield = ${formatUnitPrice(ppbu)}/${bu}`
                          : ['kg','g','lb','oz','l','ml'].includes(qu)
                            ? `$${pp.toFixed(2)} ÷ (${qty} ${qu}) = ${formatUnitPrice(ppbu)}/${bu}`
                            : qu === 'pack' && iq != null
                            ? `$${pp.toFixed(2)} ÷ (${qty} × ${iq} × ${ps} ${pu}) = ${formatUnitPrice(ppbu)}/${bu}`
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
                  <CategoryBadge category={item.category} />
                  <StockStatus stock={displayStock(item)} />
                  {item.allergens && item.allergens.length > 0 && item.allergens.map(a => (
                    <span key={a} className="px-2 py-0.5 rounded-full text-xs bg-orange-100 text-orange-700 font-medium">⚠ {a}</span>
                  ))}
                  {item.isActive
                    ? <span className="px-2 py-0.5 rounded-full text-xs bg-green-100 text-green-700 font-medium">Active</span>
                    : <span className="px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-500">Inactive</span>
                  }
                </div>

                <div className="grid grid-cols-2 gap-3 text-sm">
                  {(() => {
                    const rows: [string, string][] = item.recipe ? [
                      ['Supplier',      item.supplier?.name || '—'],
                      ['Storage Area',  item.storageArea?.name || '—'],
                      ['Linked Recipe', item.recipe.name],
                      ['Yield',         `${parseFloat(String(item.packSize ?? 1)).toLocaleString()} ${item.baseUnit}`],
                      ['Batch Cost',    formatCurrency(parseFloat(String(item.purchasePrice)))],
                      ['Count UOM',     item.countUOM ?? item.baseUnit],
                    ] : [
                      ['Supplier',       item.supplier?.name || '—'],
                      ['Storage Area',   item.storageArea?.name || '—'],
                      ['Purchase Unit',  item.purchaseUnit],
                      ['Qty per Case',   parseFloat(String(item.qtyPerPurchaseUnit)).toFixed(0)],
                      ['Purchase Price', formatCurrency(parseFloat(String(item.purchasePrice)))],
                      ['Pack Size',      `${parseFloat(String(item.packSize ?? 1))} ${item.packUOM ?? 'each'}`],
                      ['Count UOM',      item.countUOM ?? 'each'],
                      ...(item.barcode ? [['Barcode', item.barcode] as [string, string]] : []),
                    ]
                    return rows.map(([label, value]) => (
                      <div key={label} className="bg-gray-50 rounded-lg p-3">
                        <div className="text-xs text-gray-500">{label}</div>
                        <div className="font-medium text-gray-800 mt-0.5">{value}</div>
                      </div>
                    ))
                  })()}

                  <div className={`rounded-lg p-3 col-span-2 ${item.recipe ? 'bg-purple-50' : 'bg-gold/10'}`}>
                    {item.recipe && (
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <span className="text-[10px] font-bold uppercase tracking-wide bg-purple-200 text-purple-800 px-1.5 py-0.5 rounded-full">Recipe</span>
                        <span className="text-xs text-purple-700 font-medium">{item.recipe.name}</span>
                      </div>
                    )}
                    <div className={`text-xs font-medium ${item.recipe ? 'text-purple-600' : 'text-gold'}`}>
                      Price per {item.baseUnit}
                    </div>
                    <div className={`text-lg font-bold mt-0.5 ${item.recipe ? 'text-purple-700' : 'text-gold'}`}>
                      {formatUnitPrice(parseFloat(String(item.pricePerBaseUnit)))} / {item.baseUnit}
                    </div>
                    <div className={`text-xs mt-1 ${item.recipe ? 'text-purple-500' : 'text-blue-500'}`}>
                      {item.recipe
                        ? <>Recipe total {formatCurrency(parseFloat(String(item.purchasePrice)))} ÷ {parseFloat(String(item.packSize ?? 1)).toLocaleString()} {item.baseUnit} yield</>
                        : <>{formatCurrency(parseFloat(String(item.purchasePrice)))} ÷ ({parseFloat(String(item.qtyPerPurchaseUnit))} × {parseFloat(String(item.packSize ?? 1))} {item.packUOM ?? 'each'})</>
                      }
                      &nbsp;|&nbsp; 1 {item.countUOM ?? 'each'} = {parseFloat(String(item.conversionFactor)).toFixed(4)} {item.baseUnit}
                    </div>
                  </div>
                </div>

                {/* Stock Overview */}
                <div className="space-y-2">
                  <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Stock</div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-gray-50 rounded-lg p-3">
                      <div className="text-xs text-gray-500">Last Count</div>
                      <div className="font-bold text-gray-900 mt-0.5">
                        {stockMovements
                          ? `${stockMovements.lastCount.qty.toFixed(2)} ${stockMovements.lastCount.unit}`
                          : '—'}
                      </div>
                      <div className="text-xs text-gray-400 mt-0.5">
                        {stockMovements?.lastCount.date
                          ? new Date(stockMovements.lastCount.date).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })
                          : 'Never counted'}
                      </div>
                    </div>
                    <div className="bg-blue-50 rounded-lg p-3">
                      <div className="text-xs text-blue-600">Theoretical Stock</div>
                      <div className="font-bold text-blue-800 mt-0.5">
                        {stockMovements
                          ? `${stockMovements.theoretical.qty.toFixed(2)} ${stockMovements.theoretical.unit}`
                          : '—'}
                      </div>
                      <div className="text-xs text-blue-400 mt-0.5">Estimated current</div>
                    </div>
                  </div>

                  {/* Movement Log */}
                  {stockMovements && stockMovements.movements.length > 0 && (
                    <div className="space-y-0.5 mt-1">
                      {stockMovements.movements.slice(0, 12).map(m => {
                        const isPositive = m.qty >= 0
                        const typeConfig: Record<MovementType, { label: string; color: string }> = {
                          SALE:     { label: 'Sale',        color: 'text-red-500' },
                          WASTAGE:  { label: 'Wastage',     color: 'text-orange-500' },
                          PREP_IN:  { label: 'Prep (used)', color: 'text-purple-600' },
                          PREP_OUT: { label: 'Prep (yield)',color: 'text-green-600' },
                          PURCHASE: { label: 'Purchase',    color: 'text-blue-600' },
                        }
                        const cfg = typeConfig[m.type] ?? { label: m.type, color: 'text-gray-600' }
                        return (
                          <div key={m.id} className="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-gray-50 text-xs">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className={`shrink-0 font-medium ${cfg.color}`}>{cfg.label}</span>
                              <span className="text-gray-400 truncate">{m.description}</span>
                            </div>
                            <div className="flex items-center gap-2 shrink-0 ml-2">
                              <span className={`font-semibold ${isPositive ? 'text-green-600' : 'text-red-500'}`}>
                                {isPositive ? '+' : ''}{m.qty.toFixed(2)} {m.unit}
                              </span>
                              <span className="text-gray-400 w-14 text-right">
                                {new Date(m.date).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}
                              </span>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                  {stockMovements && stockMovements.movements.length === 0 && (
                    <div className="text-xs text-gray-400 text-center py-2">No movements recorded</div>
                  )}
                </div>

                {/* RC Allocation Panel */}
                {revenueCenters.length > 1 && (
                  <RcAllocationPanel
                    itemId={item.id}
                    stockOnHand={displayStock(item)}
                    countUOM={item.countUOM || item.baseUnit}
                    defaultRcId={defaultRcId}
                    onPulled={() => {
                      fetch(`/api/inventory/${item.id}`).then(r => r.json()).then(setItem)
                      onUpdated?.()
                    }}
                  />
                )}

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
          </>
        )}
      </div>
    </div>
  )
}
