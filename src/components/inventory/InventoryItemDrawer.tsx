'use client'
import { useEffect, useRef, useState } from 'react'
import { X, Pencil, Loader2, ClipboardCheck } from 'lucide-react'
import {
  formatCurrency, formatUnitPrice,
  PACK_UOMS, COUNT_UOMS, PURCHASE_UNITS, QTY_UOMS,
  calcPricePerBaseUnit, calcConversionFactor, deriveBaseUnit,
  getUnitDimension, compatibleCountUnits, getUnitConv, isMeasuredUnit,
} from '@/lib/utils'
import { convertCountQtyToBase, convertBaseToCountUom, getCountableUoms, resolveCountUom, formatPurchaseDisplay } from '@/lib/count-uom'
import { purchaseUnitToken } from '@/lib/uom'
import { CategoryBadge } from '@/components/CategoryBadge'
import { StockStatus } from '@/components/StockStatus'
import { RcAllocationPanel } from '@/components/inventory/RcAllocationPanel'
import { SupplierOffersSection } from './SupplierOffersSection'
import { QuickCountSheet } from './QuickCountSheet'
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
  isStocked?: boolean
  qtyUOM?: string | null
  innerQty?: number | string | null
  needsReview?: boolean | null
  lastCountDate?: string | null; lastCountQty?: number | null
  recipe?: { id: string; name: string } | null
  priceType?: 'CASE' | 'UOM' | null
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
  isStocked: boolean
  allergens: string[]
  barcode: string | null
  priceType: 'CASE' | 'UOM'
}

interface Props {
  itemId: string
  onClose: () => void
  onUpdated?: () => void
  zClassName?: string
  initialEditMode?: boolean
}

// ─── Purchase description ─────────────────────────────────────────────────────

function normalizePurchaseUnit(raw: string): string {
  return purchaseUnitToken(raw)
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
  if (isMeasuredUnit(qtyUOM)) return `${pu} of ${qty} ${qtyUOM}`
  const hasWeight = packSize > 0 && packUOM && !['each', ''].includes(packUOM)
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
        className="w-full border border-line rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-gold"
      />
      {open && (
        <div className="absolute z-10 top-full left-0 right-0 bg-white border border-line rounded-lg shadow-lg mt-1 max-h-48 overflow-y-auto">
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
          {filtered.length === 0 && !query && <div className="px-3 py-2 text-xs text-ink-4">No options</div>}
        </div>
      )}
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeItem(item: InventoryItem): InventoryItem {
  const dims = { baseUnit: item.baseUnit, purchaseUnit: item.purchaseUnit, qtyPerPurchaseUnit: Number(item.qtyPerPurchaseUnit), qtyUOM: item.qtyUOM ?? 'each', innerQty: item.innerQty != null ? Number(item.innerQty) : null, packSize: Number(item.packSize ?? 1), packUOM: item.packUOM ?? 'each', countUOM: item.countUOM ?? 'each' }
  return { ...item, countUOM: resolveCountUom(dims) }
}

// Convert any baseUnit quantity to the item's countUOM for display.
function baseToDisplay(item: InventoryItem, base: number): number {
  return convertBaseToCountUom(base, item.countUOM ?? 'each', {
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

function displayStock(item: InventoryItem): number {
  return baseToDisplay(item, Number(item.stockOnHand))
}

// ─── Main component ────────────────────────────────────────────────────────────

export function InventoryItemDrawer({ itemId, onClose, onUpdated, zClassName = 'z-50', initialEditMode = false }: Props) {
  const { revenueCenters, activeRc } = useRc()
  const defaultRcId = revenueCenters.find(rc => rc.isDefault)?.id ?? null

  const [item, setItem] = useState<InventoryItem | null>(null)
  const [loading, setLoading] = useState(true)
  const [showQuick, setShowQuick] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editForm, setEditForm] = useState<EditForm>({
    itemName: '', category: '', supplierId: '', supplierName: '',
    storageAreaId: '', storageAreaName: '', purchaseUnit: 'case',
    qtyPerPurchaseUnit: '1', purchasePrice: '0',
    packSize: '', packUOM: 'each', countUOM: 'each',
    qtyUOM: 'each', innerQty: '',
    stockOnHand: '0', isActive: true, isStocked: true, allergens: [], barcode: null,
    priceType: 'CASE',
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
      const normalized = normalizeItem(fetchedItem)
      setItem(normalized)
      setSuppliers(sups)
      setCategories(cats)
      setStorageAreas(areas)
      setPriceHistory(ph)
      setStockMovements(sm)
      setLoading(false)
      if (initialEditMode) {
        setEditForm({
          itemName: normalized.itemName,
          category: normalized.category,
          supplierId: normalized.supplierId || '',
          supplierName: normalized.supplier?.name || '',
          storageAreaId: normalized.storageAreaId || '',
          storageAreaName: normalized.storageArea?.name || '',
          purchaseUnit: normalizePurchaseUnit(normalized.purchaseUnit),
          qtyPerPurchaseUnit: String(normalized.qtyPerPurchaseUnit),
          purchasePrice: String(normalized.purchasePrice),
          packSize: (Number(normalized.packSize ?? 1) === 1 && (normalized.baseUnit === 'each' || ['each', ''].includes(normalized.packUOM ?? 'each'))) ? '' : String(normalized.packSize ?? 1),
          packUOM: normalized.packUOM ?? 'each',
          countUOM: normalized.countUOM ?? 'each',
          qtyUOM: normalized.qtyUOM ?? 'each',
          innerQty: normalized.innerQty != null ? String(normalized.innerQty) : '',
          stockOnHand: String(parseFloat(displayStock(normalized).toFixed(4))),
          isActive: normalized.isActive,
          isStocked: normalized.isStocked ?? true,
          allergens: normalized.allergens ?? [],
          barcode: normalized.barcode ?? null,
          priceType: normalized.priceType ?? 'CASE',
        })
        setEditMode(true)
      }
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
      purchaseUnit: normalizePurchaseUnit(item.purchaseUnit),
      qtyPerPurchaseUnit: String(item.qtyPerPurchaseUnit),
      purchasePrice: String(item.purchasePrice),
      packSize: (Number(item.packSize ?? 1) === 1 && (item.baseUnit === 'each' || ['each', ''].includes(item.packUOM ?? 'each'))) ? '' : String(item.packSize ?? 1),
      packUOM: item.packUOM ?? 'each',
      countUOM: item.countUOM ?? 'each',
      qtyUOM: item.qtyUOM ?? 'each',
      innerQty: item.innerQty != null ? String(item.innerQty) : '',
      stockOnHand: String(parseFloat(displayStock(item).toFixed(4))),
      isActive: item.isActive,
      isStocked: item.isStocked ?? true,
      allergens: item.allergens ?? [],
      barcode: item.barcode ?? null,
      priceType: item.priceType ?? 'CASE',
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
        qtyPerPurchaseUnit: editForm.priceType === 'UOM' ? '1' : editForm.qtyPerPurchaseUnit,
        purchasePrice: editForm.purchasePrice,
        packSize: editForm.priceType === 'UOM' ? '1' : editForm.packSize,
        packUOM: editForm.packUOM,
        countUOM: editForm.countUOM,
        qtyUOM: editForm.priceType === 'UOM' ? 'each' : editForm.qtyUOM,
        innerQty: editForm.priceType === 'UOM' ? null : (editForm.innerQty ? parseFloat(editForm.innerQty) : null),
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
        isStocked: editForm.isStocked,
        allergens: editForm.allergens,
        barcode: editForm.barcode,
        priceType: editForm.priceType,
      }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => null)
      alert(err?.error ?? `Save failed (${res.status}). Please try again.`)
      setSaving(false)
      return
    }
    const updated = await res.json()
    setItem(normalizeItem({ ...item, ...updated, supplier: updated.supplier, storageArea: updated.storageArea }))
    setEditMode(false)
    setSaving(false)
    onUpdated?.()
  }

  return (
    <div className={`fixed inset-0 ${zClassName} flex items-end sm:items-stretch sm:justify-end`} onClick={onClose}>
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" />
      <div
        className="relative bg-bg w-full max-w-[100vw] sm:max-w-md h-[92vh] sm:h-full overflow-y-auto overflow-x-hidden shadow-2xl rounded-t-2xl sm:rounded-none"
        onClick={e => e.stopPropagation()}
      >
        {loading ? (
          <div className="flex items-center justify-center h-48">
            <Loader2 size={24} className="animate-spin text-line-2" />
          </div>
        ) : !item ? (
          <div className="flex items-center justify-center h-48 text-ink-4 text-sm">Item not found</div>
        ) : (
          <>
            {/* Header */}
            <div
              className="sticky top-0 z-10 bg-paper border-b border-line p-5 flex items-center justify-between gap-2"
              style={{ paddingTop: 'calc(1.25rem + env(safe-area-inset-top, 0px))' }}
            >
              <div className="flex-1 min-w-0">
                {editMode ? (
                  <input
                    value={editForm.itemName}
                    onChange={e => setEditForm(f => ({ ...f, itemName: e.target.value }))}
                    className="w-full font-semibold text-ink border border-line rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                  />
                ) : (
                  <h2 className="font-medium text-ink text-[19px] leading-[1.15] tracking-[-0.02em] truncate">{item.itemName}</h2>
                )}
                {item.storageArea && !editMode && <p className="font-mono text-[10.5px] text-ink-4 uppercase tracking-[0.02em] mt-0.5">{item.storageArea.name}</p>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {editMode ? (
                  <>
                    <button
                      onClick={handleSave}
                      disabled={saving}
                      className="px-3 py-1.5 bg-ink text-paper text-[12px] font-medium rounded-[8px] hover:bg-ink-2 disabled:opacity-50 flex items-center gap-1 transition-colors"
                    >
                      {saving && <Loader2 size={10} className="animate-spin" />}
                      Save
                    </button>
                    <button onClick={() => setEditMode(false)} className="px-3 py-1.5 border border-line text-[12px] font-medium text-ink-2 rounded-[8px] hover:border-ink-3 transition-colors">Cancel</button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => setShowQuick(true)}
                      disabled={!activeRc}
                      title={activeRc ? `Quick count (${activeRc.name})` : 'Pick a revenue center to quick-count'}
                      className="flex items-center gap-1.5 px-3 py-1.5 border border-line text-[12px] font-medium text-ink-2 rounded-[8px] hover:border-ink-3 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <ClipboardCheck size={12} /> Count
                    </button>
                    <button
                      onClick={openEdit}
                      className="flex items-center gap-1.5 px-3 py-1.5 border border-line text-[12px] font-medium text-ink-2 rounded-[8px] hover:border-ink-3 transition-colors"
                    >
                      <Pencil size={12} /> Edit
                    </button>
                  </>
                )}
                <button onClick={onClose} aria-label="Close" className="w-8 h-8 grid place-items-center rounded-[8px] border border-line text-ink-3 hover:border-ink-4 hover:text-ink-2 transition-colors bg-paper"><X size={16} /></button>
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
                    className="w-4 h-4 rounded border-line-2 text-gold focus:ring-gold"
                  />
                  <span className="text-sm font-medium text-ink-2">Active</span>
                  <span className="text-xs text-ink-4">&mdash; uncheck to exclude from inventory totals</span>
                </label>

                {/* Not stocked (recipe-only) */}
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={!editForm.isStocked}
                    onChange={e => setEditForm(f => ({ ...f, isStocked: !e.target.checked }))}
                    className="w-4 h-4 rounded border-line-2 text-gold focus:ring-gold"
                  />
                  <span className="text-sm font-medium text-ink-2">Not stocked (recipe-only)</span>
                  <span className="text-xs text-ink-4">&mdash; e.g. tap water; usable in recipes at $0, hidden from counts &amp; purchasing</span>
                </label>

                {/* Category */}
                <div>
                  <label className="block text-xs font-medium text-ink-3 mb-1">Category</label>
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
                  <label className="block text-xs font-medium text-ink-3 mb-1">Supplier</label>
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
                  <label className="block text-xs font-medium text-ink-3 mb-1">Storage Area</label>
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
                  <div className="bg-blue-soft border border-blue-soft rounded-lg px-3 py-2 text-xs text-blue-text flex items-start gap-2">
                    <span className="text-blue mt-0.5">⟳</span>
                    <span><strong>Price is managed by recipe:</strong> {item.recipe.name}. Edit the recipe to change costs. You can only change Count UOM and stock fields here.</span>
                  </div>
                )}

                {/* Purchase structure */}
                {!item.recipe && (
                  <div className="space-y-3">
                    {/* Per Case / Per UOM toggle */}
                    <div className="flex gap-2 p-1 bg-bg-2 rounded-xl">
                      {(['CASE', 'UOM'] as const).map(pt => (
                        <button
                          key={pt}
                          type="button"
                          onClick={() => setEditForm(f => ({
                            ...f,
                            priceType: pt,
                            ...(pt === 'UOM' && !['kg','g','lb','oz','l','ml'].includes(f.packUOM) ? { packUOM: 'kg' } : {}),
                          }))}
                          className={`flex-1 py-2 rounded-lg text-xs font-medium transition-all ${
                            editForm.priceType === pt
                              ? 'bg-white text-ink shadow-sm'
                              : 'text-ink-3 hover:text-ink-2'
                          }`}
                        >
                          {pt === 'CASE' ? 'Per Case' : 'Per UOM'}
                        </button>
                      ))}
                    </div>

                    {editForm.priceType === 'CASE' && (
                      <>
                        {/* Row 1: Purchase Unit + Qty/Unit pair */}
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs font-medium text-ink-3 mb-1">Purchase Unit</label>
                            <select value={editForm.purchaseUnit} onChange={e => setEditForm(f => ({ ...f, purchaseUnit: e.target.value }))}
                              className="w-full border border-line rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-gold bg-white">
                              {PURCHASE_UNITS.map(u => <option key={u}>{u}</option>)}
                            </select>
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-ink-3 mb-1">Qty per {editForm.purchaseUnit}</label>
                            <div className="flex">
                              <input type="number" step="any" value={editForm.qtyPerPurchaseUnit}
                                onChange={e => setEditForm(f => ({ ...f, qtyPerPurchaseUnit: e.target.value }))}
                                className="w-full border border-line rounded-l-lg px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-gold border-r-0" />
                              <select value={editForm.qtyUOM} onChange={e => setEditForm(f => {
                                  const newQtyUOM = e.target.value
                                  const opts = getCountableUoms({ baseUnit: deriveBaseUnit(newQtyUOM, f.packUOM, parseFloat(f.packSize) || 0), purchaseUnit: f.purchaseUnit, qtyPerPurchaseUnit: parseFloat(f.qtyPerPurchaseUnit) || 1, qtyUOM: newQtyUOM, innerQty: f.innerQty ? parseFloat(f.innerQty) : null, packSize: parseFloat(f.packSize) || 0, packUOM: f.packUOM, countUOM: f.countUOM }).map(u => u.label)
                                  return { ...f, qtyUOM: newQtyUOM, innerQty: newQtyUOM === 'pack' ? f.innerQty : '', countUOM: opts.includes(f.countUOM) ? f.countUOM : opts[0] }
                                })}
                                className="border border-line rounded-r-lg px-2 py-2 text-sm text-ink-2 bg-bg focus:outline-none focus:ring-2 focus:ring-gold">
                                {QTY_UOMS.map(u => <option key={u}>{u}</option>)}
                              </select>
                            </div>
                          </div>
                        </div>

                        {/* Conditional: pack breakdown when qtyUOM = pack */}
                        {editForm.qtyUOM === 'pack' && (
                          <div className="ml-3 pl-3 border-l-2 border-gold-soft space-y-2">
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <label className="block text-xs font-medium text-ink-3 mb-1">Items per Pack</label>
                                <div className="flex">
                                  <input type="number" step="any" min="1" value={editForm.innerQty}
                                    onChange={e => setEditForm(f => ({ ...f, innerQty: e.target.value }))}
                                    className="w-full border border-line rounded-l-lg px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-gold border-r-0" />
                                  <span className="border border-line rounded-r-lg px-3 py-2 text-sm text-ink-3 bg-bg">each</span>
                                </div>
                              </div>
                              <div>
                                <label className="block text-xs font-medium text-ink-3 mb-1">
                                  Weight per Item
                                  <span className="ml-1 text-[10px] font-semibold bg-bg-2 text-ink-4 rounded px-1 py-0.5 normal-case tracking-normal">optional</span>
                                </label>
                                <div className="flex">
                                  <input type="number" step="any" min="0" value={editForm.packSize}
                                    onChange={e => setEditForm(f => ({ ...f, packSize: e.target.value }))}
                                    placeholder="e.g. 100"
                                    className="w-full border border-line rounded-l-lg px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-gold border-r-0" />
                                  <select value={editForm.packUOM} onChange={e => setEditForm(f => ({ ...f, packUOM: e.target.value }))}
                                    className="border border-line rounded-r-lg px-2 py-2 text-sm text-ink-2 bg-bg focus:outline-none focus:ring-2 focus:ring-gold">
                                    {(['g', 'kg', 'ml', 'l', 'lb', 'oz']).map(u => <option key={u}>{u}</option>)}
                                  </select>
                                </div>
                                <p className="text-[10px] text-gold-2 bg-gold-soft rounded px-2 py-1 mt-1">Leave blank → price per each. Fill in → price per g, usable in recipes by weight.</p>
                              </div>
                            </div>
                          </div>
                        )}

                        {/* Conditional: weight per item when qtyUOM = each */}
                        {editForm.qtyUOM === 'each' && (
                          <div className="ml-3 pl-3 border-l-2 border-gold-soft">
                            <label className="block text-xs font-medium text-ink-3 mb-1">
                              Weight per Each
                              <span className="ml-1 text-[10px] font-semibold bg-bg-2 text-ink-4 rounded px-1 py-0.5 normal-case tracking-normal">optional</span>
                            </label>
                            <div className="flex">
                              <input type="number" step="any" min="0" value={editForm.packSize}
                                onChange={e => {
                                  const val = e.target.value
                                  // When weight is cleared, reset countUOM to 'each' (weight options disappear)
                                  const newPs = parseFloat(val) || 0
                                  const wasWeight = parseFloat(editForm.packSize) > 0
                                  setEditForm(f => ({
                                    ...f,
                                    packSize: val,
                                    countUOM: wasWeight && newPs <= 0 ? 'each' : f.countUOM,
                                  }))
                                }}
                                placeholder="e.g. 290"
                                className="w-full border border-line rounded-l-lg px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-gold border-r-0" />
                              <select value={editForm.packUOM} onChange={e => setEditForm(f => ({ ...f, packUOM: e.target.value }))}
                                className="border border-line rounded-r-lg px-2 py-2 text-sm text-ink-2 bg-bg focus:outline-none focus:ring-2 focus:ring-gold">
                                {(['g', 'kg', 'ml', 'l', 'lb', 'oz']).map(u => <option key={u}>{u}</option>)}
                              </select>
                            </div>
                            <p className="text-[10px] text-gold-2 bg-gold-soft rounded px-2 py-1 mt-1">Leave blank → price per each. Fill in → price per g, usable in recipes by weight.</p>
                          </div>
                        )}

                        {/* Generated description label */}
                        {(() => {
                          const desc = buildPurchaseDescription(
                            editForm.purchaseUnit,
                            parseFloat(editForm.qtyPerPurchaseUnit) || 0,
                            editForm.qtyUOM,
                            editForm.innerQty ? parseFloat(editForm.innerQty) : null,
                            parseFloat(editForm.packSize) || 0,
                            editForm.packUOM,
                          )
                          return (
                            <p className="text-xs text-ink-4 italic">= {desc}</p>
                          )
                        })()}
                      </>
                    )}

                    {editForm.priceType === 'UOM' && (
                      <div>
                        <label className="block text-xs font-medium text-ink-3 mb-1">Price Unit</label>
                        <select value={editForm.packUOM} onChange={e => setEditForm(f => ({ ...f, packUOM: e.target.value }))}
                          className="w-full border border-line rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-gold bg-white">
                          {(['kg', 'g', 'lb', 'oz', 'l', 'ml']).map(u => <option key={u}>{u}</option>)}
                        </select>
                        <p className="text-[10px] text-blue bg-blue-soft rounded px-2 py-1 mt-1">Price is entered as cost per {editForm.packUOM} — ideal for produce and bulk items.</p>
                      </div>
                    )}

                    {/* Purchase Price */}
                    <div>
                      <label className="block text-xs font-medium text-ink-3 mb-1">
                        {editForm.priceType === 'UOM' ? `Price / ${editForm.packUOM} ($)` : 'Purchase Price ($)'}
                      </label>
                      <input type="number" step="any" value={editForm.purchasePrice}
                        onChange={e => setEditForm(f => ({ ...f, purchasePrice: e.target.value }))}
                        className="w-full border border-line rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-gold" />
                    </div>
                  </div>
                )}

                {/* Stock + Count fields */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-ink-3 mb-1">
                      Count UOM
                      {item.recipe && (
                        <span className="ml-1 text-blue font-normal">
                          ({getUnitDimension(item.baseUnit)}-compatible)
                        </span>
                      )}
                    </label>
                    <select value={editForm.countUOM} onChange={e => setEditForm(f => ({ ...f, countUOM: e.target.value }))}
                      className="w-full border border-line rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-gold bg-white">
                      {(() => {
                        const rawPs = parseFloat(editForm.packSize) || 0
                        const hasWpe = rawPs > 0
                        const effPu = hasWpe ? editForm.packUOM : 'each'
                        return getCountableUoms({
                          baseUnit: deriveBaseUnit(editForm.qtyUOM, effPu, rawPs),
                          purchaseUnit: editForm.purchaseUnit,
                          qtyPerPurchaseUnit: parseFloat(editForm.qtyPerPurchaseUnit) || 1,
                          qtyUOM: editForm.qtyUOM,
                          innerQty: editForm.innerQty ? parseFloat(editForm.innerQty) : null,
                          packSize: rawPs,
                          packUOM: effPu,
                          countUOM: editForm.countUOM,
                        }).map(u => <option key={u.label} value={u.label}>{u.label}{u.hint ? ` — ${u.hint}` : ''}</option>)
                      })()}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-ink-3 mb-1">Stock On Hand ({editForm.countUOM})</label>
                    <input type="number" step="any" value={editForm.stockOnHand}
                      onChange={e => setEditForm(f => ({ ...f, stockOnHand: e.target.value }))}
                      className="w-full border border-line rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-gold" />
                  </div>
                </div>

                {/* Barcode */}
                <div>
                  <label className="block text-xs font-medium text-ink-3 mb-1">Barcode</label>
                  <input
                    type="text"
                    value={editForm.barcode ?? ''}
                    onChange={e => setEditForm(f => ({ ...f, barcode: e.target.value || null }))}
                    placeholder="Scan or type barcode"
                    className="w-full border border-line rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-gold"
                  />
                </div>

                {/* Allergens */}
                <div>
                  <label className="block text-xs font-medium text-ink-3 mb-2">Allergens (Health Canada Big 9)</label>
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
                  const pp     = parseFloat(editForm.purchasePrice) || 0
                  const qty    = parseFloat(editForm.qtyPerPurchaseUnit) || 1
                  const rawPs  = parseFloat(editForm.packSize) || 0
                  const hasWpe = rawPs > 0
                  const ps     = hasWpe ? rawPs : 1                       // 1 for math (avoid ÷0)
                  const pu     = hasWpe ? editForm.packUOM : 'each'       // 'each' when no weight
                  const cu     = editForm.countUOM
                  const qu     = editForm.qtyUOM ?? 'each'
                  const iq     = editForm.innerQty ? parseFloat(editForm.innerQty) : null
                  const bu     = isPrep ? (item.baseUnit ?? deriveBaseUnit(qu, pu)) : deriveBaseUnit(qu, pu, rawPs)
                  const ppbu = isPrep
                    ? parseFloat(String(item.pricePerBaseUnit ?? 0))
                    : calcPricePerBaseUnit(pp, qty, qu, iq, ps, pu, editForm.priceType === 'UOM' ? 'UOM' : 'CASE')
                  const cf = isPrep
                    ? parseFloat(String(item.conversionFactor ?? 1))
                    : calcConversionFactor(cu, qty, qu, iq, ps, pu)
                  return (
                    <div className={`rounded-lg p-3 space-y-1.5 ${isPrep ? 'bg-blue-soft' : 'bg-gold/10'}`}>
                      <div className={`text-xs font-semibold uppercase tracking-wide ${isPrep ? 'text-blue-text' : 'text-gold'}`}>
                        {isPrep ? 'Recipe-derived cost' : 'Auto-calculated'}
                      </div>
                      <div className="flex items-baseline gap-1.5">
                        <span className={`text-xs ${isPrep ? 'text-blue' : 'text-gold'}`}>Price per {bu}:</span>
                        <span className={`text-lg font-bold ${isPrep ? 'text-blue-text' : 'text-gold'}`}>{formatUnitPrice(ppbu)}</span>
                      </div>
                      <div className="flex items-baseline gap-1.5">
                        <span className={`text-xs ${isPrep ? 'text-blue' : 'text-gold'}`}>1 {cu} =</span>
                        <span className={`font-semibold ${isPrep ? 'text-blue-text' : 'text-gold'}`}>{cf.toFixed(4)} {bu}</span>
                      </div>
                      <div className={`text-xs ${isPrep ? 'text-blue' : 'text-blue'}`}>
                        {(() => {
                          if (isPrep) return `Recipe total ÷ ${ps.toLocaleString()} ${bu} yield = ${formatUnitPrice(ppbu)}/${bu}`
                          if (editForm.priceType === 'UOM') {
                            const conv = getUnitConv(pu)
                            const base = conv > 0 ? pp / conv : 0
                            return `$${pp.toFixed(2)} ÷ conv(${pu}) = $${base.toFixed(4)}/base unit`
                          }
                          if (['kg','g','lb','oz','l','ml'].includes(qu)) return `$${pp.toFixed(2)} ÷ (${qty} ${qu}) = ${formatUnitPrice(ppbu)}/${bu}`
                          if (qu === 'pack' && iq != null) return `$${pp.toFixed(2)} ÷ (${qty} × ${iq} × ${ps} ${pu}) = ${formatUnitPrice(ppbu)}/${bu}`
                          return `$${pp.toFixed(2)} ÷ (${qty} × ${ps} ${pu}) = ${formatUnitPrice(ppbu)}/${bu}`
                        })()}
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
                    <span key={a} className="px-2 py-0.5 rounded-full text-[11px] bg-gold-soft text-gold-2 font-medium">⚠ {a}</span>
                  ))}
                  {item.isActive
                    ? <span className="px-2 py-0.5 rounded-full text-[11px] bg-green-soft text-green-text font-medium">Active</span>
                    : <span className="px-2 py-0.5 rounded-full text-[11px] bg-bg-2 text-ink-4 font-medium">Inactive</span>
                  }
                </div>

                {(() => {
                  const isUom = item.priceType === 'UOM'
                  const pp = parseFloat(String(item.purchasePrice))
                  const ppb = parseFloat(String(item.pricePerBaseUnit))
                  const rateUnit = item.packUOM || item.baseUnit
                  // For per-weight items the conversion is rate-unit → base (g/ml),
                  // derivable from the two prices without re-importing UOM tables.
                  const basesPerRateUnit = ppb > 0 ? pp / ppb : 0
                  return (
                <div className="grid grid-cols-2 gap-3 text-[13px]">
                  {(() => {
                    const rows: [string, string][] = item.recipe ? [
                      ['Supplier',      item.supplier?.name || '—'],
                      ['Storage area',  item.storageArea?.name || '—'],
                      ['Linked recipe', item.recipe.name],
                      ['Yield',         `${parseFloat(String(item.packSize ?? 1)).toLocaleString()} ${item.baseUnit}`],
                      ['Batch cost',    formatCurrency(pp)],
                      ['Count UOM',     item.countUOM ?? item.baseUnit],
                    ] : [
                      ['Supplier',       item.supplier?.name || '—'],
                      ['Storage area',   item.storageArea?.name || '—'],
                      ['Pricing',        isUom ? `By weight · per ${rateUnit}` : 'By case'],
                      ['Purchase price', isUom ? `${formatCurrency(pp)} / ${rateUnit}` : `${formatCurrency(pp)} / ${formatPurchaseDisplay(item)}`],
                      ['Pack',           formatPurchaseDisplay(item)],
                      ['Count UOM',      item.countUOM ?? 'each'],
                      ...(item.barcode ? [['Barcode', item.barcode] as [string, string]] : []),
                    ]
                    return rows.map(([label, value]) => (
                      <div key={label} className="bg-paper border border-line rounded-[10px] p-3">
                        <div className="font-mono text-[10px] text-ink-3 uppercase tracking-[0.04em]">{label}</div>
                        <div className="font-medium text-ink mt-1 tracking-[-0.005em]">{value}</div>
                      </div>
                    ))
                  })()}

                  <div className={`rounded-[10px] p-3 col-span-2 border ${item.recipe ? 'bg-blue-soft border-blue-soft' : 'bg-gold-soft border-[#fcd34d]'}`}>
                    {item.recipe && (
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.02em] bg-blue-soft text-blue-text px-1.5 py-0.5 rounded-full">Recipe</span>
                        <span className="text-[11px] text-blue-text font-medium">{item.recipe.name}</span>
                      </div>
                    )}
                    <div className={`font-mono text-[10px] font-semibold uppercase tracking-[0.04em] ${item.recipe ? 'text-blue' : 'text-gold-2'}`}>
                      Price per {item.baseUnit}
                    </div>
                    <div className={`font-mono text-[17px] font-semibold tabular-nums mt-1 tracking-[-0.01em] ${item.recipe ? 'text-blue-text' : 'text-gold-2'}`}>
                      {formatUnitPrice(ppb)} / {item.baseUnit}
                    </div>
                    <div className={`font-mono text-[11px] mt-1.5 tracking-[0] ${item.recipe ? 'text-blue' : 'text-[#92722f]'}`}>
                      {item.recipe
                        ? <>Recipe total {formatCurrency(pp)} ÷ {parseFloat(String(item.packSize ?? 1)).toLocaleString()} {item.baseUnit} yield</>
                        : isUom
                          ? <>{formatCurrency(pp)} / {rateUnit} · 1 {rateUnit} = {basesPerRateUnit.toFixed(2)} {item.baseUnit}</>
                          : <>{formatCurrency(pp)} ÷ ({parseFloat(String(item.qtyPerPurchaseUnit))} × {parseFloat(String(item.packSize ?? 1))} {item.packUOM ?? 'each'}) &nbsp;|&nbsp; 1 {item.countUOM ?? 'each'} = {parseFloat(String(item.conversionFactor)).toFixed(4)} {item.baseUnit}</>
                      }
                    </div>
                  </div>
                </div>
                  )
                })()}

                {/* Stock Overview */}
                <div className="space-y-2">
                  <div className="font-mono text-[10.5px] font-semibold text-ink-3 uppercase tracking-[0.04em]">Stock</div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-paper border border-line rounded-[10px] p-3">
                      <div className="font-mono text-[10px] text-ink-3 uppercase tracking-[0.04em]">Last count</div>
                      <div className="font-mono text-[15px] font-semibold text-ink tabular-nums mt-1">
                        {stockMovements
                          ? `${stockMovements.lastCount.qty.toFixed(2)} ${stockMovements.lastCount.unit}`
                          : '—'}
                      </div>
                      <div className="font-mono text-[10.5px] text-ink-4 mt-0.5">
                        {stockMovements?.lastCount.date
                          ? new Date(stockMovements.lastCount.date).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })
                          : 'Never counted'}
                      </div>
                    </div>
                    <div className="bg-bg-2 border border-line rounded-[10px] p-3">
                      <div className="font-mono text-[10px] text-ink-3 uppercase tracking-[0.04em]">Theoretical stock</div>
                      <div className="font-mono text-[15px] font-semibold text-ink tabular-nums mt-1">
                        {stockMovements
                          ? `${stockMovements.theoretical.qty.toFixed(2)} ${stockMovements.theoretical.unit}`
                          : '—'}
                      </div>
                      <div className="font-mono text-[10.5px] text-ink-4 mt-0.5">Estimated current</div>
                    </div>
                  </div>

                  {/* Movement Log */}
                  {stockMovements && stockMovements.movements.length > 0 && (
                    <div className="space-y-0.5 mt-1">
                      {stockMovements.movements.slice(0, 12).map(m => {
                        const isPositive = m.qty >= 0
                        const typeConfig: Record<MovementType, { label: string; color: string }> = {
                          SALE:     { label: 'Sale',        color: 'text-red' },
                          WASTAGE:  { label: 'Wastage',     color: 'text-gold' },
                          PREP_IN:  { label: 'Prep (used)', color: 'text-blue' },
                          PREP_OUT: { label: 'Prep (yield)',color: 'text-green' },
                          PURCHASE: { label: 'Purchase',    color: 'text-blue' },
                        }
                        const cfg = typeConfig[m.type] ?? { label: m.type, color: 'text-ink-3' }
                        return (
                          <div key={m.id} className="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-bg text-[12px] transition-colors">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className={`shrink-0 font-medium ${cfg.color}`}>{cfg.label}</span>
                              <span className="text-ink-4 truncate">{m.description}</span>
                            </div>
                            <div className="flex items-center gap-2 shrink-0 ml-2 font-mono tabular-nums">
                              <span className={`font-semibold ${isPositive ? 'text-green' : 'text-red'}`}>
                                {isPositive ? '+' : ''}{m.qty.toFixed(2)} {m.unit}
                              </span>
                              <span className="text-ink-4 w-14 text-right">
                                {new Date(m.date).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}
                              </span>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                  {stockMovements && stockMovements.movements.length === 0 && (
                    <div className="text-[12px] text-ink-4 text-center py-2">No movements recorded</div>
                  )}
                </div>

                {/* RC Allocation Panel */}
                {revenueCenters.length > 1 && (
                  <RcAllocationPanel
                    itemId={item.id}
                    stockOnHand={displayStock(item)}
                    countUOM={item.countUOM || item.baseUnit}
                    defaultRcId={defaultRcId}
                    toDisplay={(base) => baseToDisplay(item, base)}
                    onPulled={() => {
                      fetch(`/api/inventory/${item.id}`).then(r => r.json()).then(setItem)
                      onUpdated?.()
                    }}
                  />
                )}

                {/* Supplier offers */}
                <SupplierOffersSection itemId={item.id} baseUnit={item.baseUnit ?? null} />

                {/* Price History */}
                {priceHistory.length > 0 && (
                  <div className="mt-2">
                    <div className="font-mono text-[10.5px] font-semibold text-ink-3 uppercase tracking-[0.04em] mb-2">Price history</div>
                    <div className="space-y-1.5">
                      {priceHistory.map((h, i) => (
                        <div key={i} className="flex items-center justify-between bg-paper border border-line rounded-[10px] px-3 py-2 text-[12px]">
                          <div className="min-w-0">
                            <div className="font-medium text-ink truncate">{h.supplierName}</div>
                            <div className="font-mono text-[10.5px] text-ink-4 mt-0.5">
                              {new Date(h.invoiceDate).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })}
                              {h.invoiceNumber ? ` · #${h.invoiceNumber}` : ''}
                            </div>
                          </div>
                          <div className="text-right shrink-0 ml-3 font-mono tabular-nums">
                            <div className="font-semibold text-ink">{formatCurrency(h.unitPrice)}</div>
                            <div className="text-ink-4 text-[10.5px]">{formatCurrency(h.lineTotal)} total</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {showQuick && (
              <QuickCountSheet
                item={item}
                onClose={() => setShowQuick(false)}
                onDone={() => { setShowQuick(false); onUpdated?.() }}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}
