'use client'
import { useEffect, useRef, useState } from 'react'
import { X, Pencil, Loader2, ClipboardCheck } from 'lucide-react'
import {
  formatCurrency, formatPricePerBase,
} from '@/lib/utils'
import {
  DIMENSION_BASE, pricePerBaseUnit, basePerUnit, levelBaseUnits,
  type Dimension, type PackLink, type Pricing,
} from '@/lib/item-model'
import { convertBaseToCountUom, resolveCountUom } from '@/lib/count-uom'
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
  purchasePrice: number; baseUnit: string
  pricePerBaseUnit: number
  stockOnHand: number
  allergens?: string[]
  barcode?: string | null
  isActive: boolean
  isStocked?: boolean
  needsReview?: boolean | null
  lastCountDate?: string | null; lastCountQty?: number | null
  recipe?: { id: string; name: string } | null
  // Chain model (authoritative)
  dimension?: Dimension | null
  packChain?: PackLink[] | null
  pricing?: Pricing | null
  countUnit?: string | null
}

interface EditForm {
  itemName: string; category: string
  supplierId: string; supplierName: string
  storageAreaId: string; storageAreaName: string
  // Chain pricing model
  dimension: Dimension
  chain: PackLink[]
  pricing: Pricing
  countUnit: string
  stockOnHand: string
  isActive: boolean
  isStocked: boolean
  allergens: string[]
  barcode: string | null
}

// Default chain state for a brand-new item.
const DEFAULT_CHAIN: PackLink[] = [{ unit: 'case', per: 1 }]
const DEFAULT_PRICING: Pricing = { mode: 'PACK', purchasePrice: 0 }

// Derive the chain-form pieces from an item, falling back to safe defaults so a
// row missing chain columns still opens cleanly.
function chainFromItem(item: InventoryItem): Pick<EditForm, 'dimension' | 'chain' | 'pricing' | 'countUnit'> {
  const dimension = (item.dimension ?? 'COUNT') as Dimension
  const chain = Array.isArray(item.packChain) && item.packChain.length
    ? item.packChain.map(l => ({ unit: l.unit, per: Number(l.per) }))
    : [...DEFAULT_CHAIN]
  const pricing = item.pricing ?? DEFAULT_PRICING
  const countUnit = item.countUnit ?? 'each'
  return { dimension, chain, pricing, countUnit }
}

// Count-unit options: chain level names + same-dimension units, deduped.
function countUnitOptions(dimension: Dimension, chain: PackLink[]): string[] {
  return [...new Set([...chain.map(l => l.unit), ...DIM_UNITS[dimension]])]
}

// Build a fresh EditForm (chain pricing + non-pricing fields) from an item.
function buildEditForm(item: InventoryItem): EditForm {
  const c = chainFromItem(item)
  const ci = { dimension: c.dimension, baseUnit: DIMENSION_BASE[c.dimension], packChain: c.chain, pricing: c.pricing, countUnit: c.countUnit }
  const perCount = basePerUnit(ci, c.countUnit) || 1
  const stockInCountUnit = Number(item.stockOnHand) / perCount
  return {
    itemName: item.itemName,
    category: item.category,
    supplierId: item.supplierId || '',
    supplierName: item.supplier?.name || '',
    storageAreaId: item.storageAreaId || '',
    storageAreaName: item.storageArea?.name || '',
    dimension: c.dimension,
    chain: c.chain,
    pricing: c.pricing,
    countUnit: c.countUnit,
    stockOnHand: String(parseFloat(stockInCountUnit.toFixed(4))),
    isActive: item.isActive,
    isStocked: item.isStocked ?? true,
    allergens: item.allergens ?? [],
    barcode: item.barcode ?? null,
  }
}

interface Props {
  itemId: string
  onClose: () => void
  onUpdated?: () => void
  zClassName?: string
  initialEditMode?: boolean
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

// ─── Chain editor (module scope — must not be redefined per render) ───────────

const DIM_UNITS: Record<Dimension, string[]> = {
  MASS:   ['g', 'kg', 'lb', 'oz'],
  VOLUME: ['ml', 'l', 'fl oz', 'cup'],
  COUNT:  ['each'],
}

const inputCls =
  'w-full border border-line rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-gold'

function DimensionToggle({ dimension, onChange }: {
  dimension: Dimension
  onChange: (d: Dimension) => void
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-ink-3 mb-1">Dimension</label>
      <div className="flex gap-2 p-1 bg-bg-2 rounded-xl">
        {(['MASS', 'VOLUME', 'COUNT'] as Dimension[]).map(d => (
          <button
            key={d}
            type="button"
            onClick={() => onChange(d)}
            className={`flex-1 py-2 rounded-lg text-xs font-medium transition-all ${
              dimension === d ? 'bg-white text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2'
            }`}
          >
            {d === 'MASS' ? 'Weight' : d === 'VOLUME' ? 'Volume' : 'Count'}
          </button>
        ))}
      </div>
      <p className="text-[10px] text-ink-4 mt-1">Base unit: <span className="font-mono">{DIMENSION_BASE[dimension]}</span></p>
    </div>
  )
}

function PackChainEditor({ chain, baseUnit, onChange }: {
  chain: PackLink[]
  baseUnit: string
  onChange: (chain: PackLink[]) => void
}) {
  const setLink = (i: number, patch: Partial<PackLink>) =>
    onChange(chain.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
  const removeLink = (i: number) => onChange(chain.filter((_, idx) => idx !== i))
  const addLink = () => onChange([...chain, { unit: 'unit', per: 1 }])

  return (
    <div className="space-y-2">
      <label className="block text-xs font-medium text-ink-3">Pack chain <span className="text-ink-4 normal-case font-normal">(outer → inner)</span></label>
      {chain.map((link, i) => {
        const isLeaf = i === chain.length - 1
        return (
          <div key={i} className="flex items-center gap-2">
            <input
              value={link.unit}
              onChange={e => setLink(i, { unit: e.target.value })}
              placeholder="unit"
              className="flex-1 border border-line rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-gold"
            />
            <div className="flex items-center">
              <input
                type="number"
                step="any"
                min="0"
                value={link.per}
                onChange={e => setLink(i, { per: parseFloat(e.target.value) || 0 })}
                className="w-24 border border-line rounded-l-lg px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-gold border-r-0"
              />
              <span className="border border-line rounded-r-lg px-2 py-2 text-sm text-ink-3 bg-bg min-w-[2.5rem] text-center">
                {isLeaf ? baseUnit : '×'}
              </span>
            </div>
            <button
              type="button"
              onClick={() => removeLink(i)}
              disabled={chain.length <= 1}
              aria-label="Remove level"
              className="w-8 h-8 shrink-0 grid place-items-center rounded-lg border border-line text-ink-3 hover:border-red-text hover:text-red-text disabled:opacity-30 disabled:hover:border-line disabled:hover:text-ink-3 transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        )
      })}
      <button
        type="button"
        onClick={addLink}
        className="text-xs font-medium text-gold-2 hover:text-gold transition-colors"
      >
        + add level
      </button>
    </div>
  )
}

function PricingEditor({ dimension, pricing, onChange }: {
  dimension: Dimension
  pricing: Pricing
  onChange: (p: Pricing) => void
}) {
  const setMode = (mode: 'PACK' | 'RATE') => {
    if (mode === pricing.mode) return
    onChange(
      mode === 'PACK'
        ? { mode: 'PACK', purchasePrice: 0 }
        : { mode: 'RATE', rate: 0, rateUnit: DIM_UNITS[dimension][0] },
    )
  }
  return (
    <div className="space-y-3">
      <div className="flex gap-2 p-1 bg-bg-2 rounded-xl">
        {(['PACK', 'RATE'] as const).map(m => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`flex-1 py-2 rounded-lg text-xs font-medium transition-all ${
              pricing.mode === m ? 'bg-white text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2'
            }`}
          >
            {m === 'PACK' ? 'Per pack' : 'Per unit (rate)'}
          </button>
        ))}
      </div>
      {pricing.mode === 'PACK' ? (
        <div>
          <label className="block text-xs font-medium text-ink-3 mb-1">Purchase price ($)</label>
          <input
            type="number"
            step="any"
            value={pricing.purchasePrice}
            onChange={e => onChange({ mode: 'PACK', purchasePrice: parseFloat(e.target.value) || 0 })}
            className={inputCls}
          />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-ink-3 mb-1">Rate ($)</label>
            <input
              type="number"
              step="any"
              value={pricing.rate}
              onChange={e => onChange({ mode: 'RATE', rate: parseFloat(e.target.value) || 0, rateUnit: pricing.rateUnit })}
              className={inputCls}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-3 mb-1">Per</label>
            <select
              value={pricing.rateUnit}
              onChange={e => onChange({ mode: 'RATE', rate: pricing.rate, rateUnit: e.target.value })}
              className={`${inputCls} bg-white`}
            >
              {DIM_UNITS[dimension].map(u => <option key={u}>{u}</option>)}
            </select>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function itemChainDims(item: InventoryItem) {
  return {
    dimension: (item.dimension ?? 'COUNT') as string,
    baseUnit:  item.baseUnit,
    packChain: (Array.isArray(item.packChain) ? item.packChain : []) as unknown,
    countUnit: item.countUnit ?? null,
  }
}

function normalizeItem(item: InventoryItem): InventoryItem {
  return { ...item, countUnit: resolveCountUom(itemChainDims(item)) }
}

// Convert any baseUnit quantity to the item's count unit for display.
function baseToDisplay(item: InventoryItem, base: number): number {
  return convertBaseToCountUom(base, resolveCountUom(itemChainDims(item)), itemChainDims(item))
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
    storageAreaId: '', storageAreaName: '',
    dimension: 'COUNT', chain: [...DEFAULT_CHAIN], pricing: { ...DEFAULT_PRICING },
    countUnit: 'each',
    stockOnHand: '0', isActive: true, isStocked: true, allergens: [], barcode: null,
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
        setEditForm(buildEditForm(normalized))
        setEditMode(true)
      }
    })
  }, [itemId])

  const openEdit = () => {
    if (!item) return
    setEditForm(buildEditForm(item))
    setEditMode(true)
  }

  const handleSave = async () => {
    if (!item) return
    setSaving(true)
    // Chain item for the conversion: stock is entered in countUnit, stored in base.
    const ci = {
      dimension: editForm.dimension,
      baseUnit: DIMENSION_BASE[editForm.dimension],
      packChain: editForm.chain,
      pricing: editForm.pricing,
      countUnit: editForm.countUnit,
    }
    const perCount = basePerUnit(ci, editForm.countUnit) || 1
    const stockInBase = (parseFloat(editForm.stockOnHand) || 0) * perCount
    const res = await fetch(`/api/inventory/${item.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        itemName: editForm.itemName,
        category: editForm.category,
        supplierId: editForm.supplierId || null,
        storageAreaId: editForm.storageAreaId || null,
        // Chain shape (new body) — route derives all legacy fields.
        dimension: editForm.dimension,
        packChain: editForm.chain,
        pricing: editForm.pricing,
        countUnit: editForm.countUnit,
        stockOnHand: stockInBase,
        isActive: editForm.isActive,
        isStocked: editForm.isStocked,
        allergens: editForm.allergens,
        barcode: editForm.barcode,
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

                {/* Pricing chain (hidden for PREP-linked items — managed by recipe sync) */}
                {!item.recipe && (
                  <div className="space-y-3">
                    <DimensionToggle
                      dimension={editForm.dimension}
                      onChange={d => setEditForm(f => {
                        // Switching dimension invalidates pricing rateUnit + may invalidate countUnit.
                        const pricing: Pricing = f.pricing.mode === 'RATE'
                          ? { mode: 'RATE', rate: f.pricing.rate, rateUnit: DIM_UNITS[d][0] }
                          : f.pricing
                        const opts = countUnitOptions(d, f.chain)
                        return { ...f, dimension: d, pricing, countUnit: opts.includes(f.countUnit) ? f.countUnit : opts[0] }
                      })}
                    />

                    <PackChainEditor
                      chain={editForm.chain}
                      baseUnit={DIMENSION_BASE[editForm.dimension]}
                      onChange={chain => setEditForm(f => {
                        const opts = countUnitOptions(f.dimension, chain)
                        return { ...f, chain, countUnit: opts.includes(f.countUnit) ? f.countUnit : opts[0] }
                      })}
                    />

                    <PricingEditor
                      dimension={editForm.dimension}
                      pricing={editForm.pricing}
                      onChange={pricing => setEditForm(f => ({ ...f, pricing }))}
                    />
                  </div>
                )}

                {/* Stock + Count fields */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-ink-3 mb-1">Count unit</label>
                    <select value={editForm.countUnit} onChange={e => setEditForm(f => ({ ...f, countUnit: e.target.value }))}
                      className="w-full border border-line rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-gold bg-white">
                      {countUnitOptions(editForm.dimension, editForm.chain).map(u => <option key={u} value={u}>{u}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-ink-3 mb-1">Stock On Hand ({editForm.countUnit})</label>
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

                {/* Live preview */}
                {(() => {
                  const isPrep = !!item.recipe
                  const ci = {
                    dimension: editForm.dimension,
                    baseUnit: DIMENSION_BASE[editForm.dimension],
                    packChain: editForm.chain,
                    pricing: editForm.pricing,
                    countUnit: editForm.countUnit,
                  }
                  const ppbu = isPrep ? Number(item.pricePerBaseUnit ?? 0) : pricePerBaseUnit(ci)
                  const perCount = basePerUnit(ci, editForm.countUnit)
                  const stockQty = parseFloat(editForm.stockOnHand) || 0
                  const stockVal = stockQty * perCount * ppbu
                  return (
                    <div className={`rounded-lg p-3 space-y-1.5 ${isPrep ? 'bg-blue-soft' : 'bg-gold-soft'}`}>
                      <div className={`text-xs font-semibold uppercase tracking-wide ${isPrep ? 'text-blue-text' : 'text-gold-2'}`}>
                        {isPrep ? 'Recipe-derived cost' : 'Live preview'}
                      </div>
                      <div className="flex items-baseline gap-1.5">
                        <span className={`text-xs ${isPrep ? 'text-blue' : 'text-gold-2'}`}>Price:</span>
                        <span className={`text-lg font-bold ${isPrep ? 'text-blue-text' : 'text-gold-2'}`}>{formatPricePerBase(ppbu, ci.baseUnit)}</span>
                      </div>
                      <div className={`text-xs ${isPrep ? 'text-blue' : 'text-gold-2'}`}>
                        1 {editForm.countUnit} = {perCount.toLocaleString()} {ci.baseUnit}
                      </div>
                      {stockQty > 0 && (
                        <div className={`text-xs ${isPrep ? 'text-blue' : 'text-gold-2'}`}>
                          Stock value: <span className="font-semibold">{formatCurrency(stockVal)}</span>
                        </div>
                      )}
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
                  const c = chainFromItem(item)
                  const ci = { dimension: c.dimension, baseUnit: DIMENSION_BASE[c.dimension], packChain: c.chain, pricing: c.pricing, countUnit: c.countUnit }
                  const ppb = pricePerBaseUnit(ci)
                  const lv = levelBaseUnits(c.chain)
                  const dimLabel = c.dimension === 'MASS' ? 'Weight' : c.dimension === 'VOLUME' ? 'Volume' : 'Count'
                  return (
                <div className="grid grid-cols-2 gap-3 text-[13px]">
                  {(() => {
                    const rows: [string, string][] = item.recipe ? [
                      ['Supplier',      item.supplier?.name || '—'],
                      ['Storage area',  item.storageArea?.name || '—'],
                      ['Linked recipe', item.recipe.name],
                      ['Dimension',     `${dimLabel} · ${ci.baseUnit}`],
                      ['Count unit',    c.countUnit],
                    ] : [
                      ['Supplier',       item.supplier?.name || '—'],
                      ['Storage area',   item.storageArea?.name || '—'],
                      ['Dimension',      `${dimLabel} · ${ci.baseUnit}`],
                      ['Pricing',        c.pricing.mode === 'RATE' ? `Rate · per ${c.pricing.rateUnit}` : 'Per pack'],
                      ['Count unit',     c.countUnit],
                      ...(item.barcode ? [['Barcode', item.barcode] as [string, string]] : []),
                    ]
                    return rows.map(([label, value]) => (
                      <div key={label} className="bg-paper border border-line rounded-[10px] p-3">
                        <div className="font-mono text-[10px] text-ink-3 uppercase tracking-[0.04em]">{label}</div>
                        <div className="font-medium text-ink mt-1 tracking-[-0.005em]">{value}</div>
                      </div>
                    ))
                  })()}

                  {/* Pack chain readout */}
                  <div className="bg-paper border border-line rounded-[10px] p-3 col-span-2">
                    <div className="font-mono text-[10px] text-ink-3 uppercase tracking-[0.04em] mb-1.5">Pack chain</div>
                    <div className="space-y-1">
                      {c.chain.map((link, i) => (
                        <div key={i} className="flex items-center justify-between text-[12px]">
                          <span className="font-medium text-ink">1 {link.unit}</span>
                          <span className="font-mono text-ink-3 tabular-nums">
                            = {Number(link.per).toLocaleString()} {i === c.chain.length - 1 ? ci.baseUnit : c.chain[i + 1]?.unit}
                            <span className="text-ink-4"> &nbsp;({(lv[link.unit] ?? 0).toLocaleString()} {ci.baseUnit})</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className={`rounded-[10px] p-3 col-span-2 border ${item.recipe ? 'bg-blue-soft border-blue-soft' : 'bg-gold-soft border-[#fcd34d]'}`}>
                    {item.recipe && (
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.02em] bg-blue-soft text-blue-text px-1.5 py-0.5 rounded-full">Recipe</span>
                        <span className="text-[11px] text-blue-text font-medium">{item.recipe.name}</span>
                      </div>
                    )}
                    <div className={`font-mono text-[10px] font-semibold uppercase tracking-[0.04em] ${item.recipe ? 'text-blue' : 'text-gold-2'}`}>
                      Price
                    </div>
                    <div className={`font-mono text-[17px] font-semibold tabular-nums mt-1 tracking-[-0.01em] ${item.recipe ? 'text-blue-text' : 'text-gold-2'}`}>
                      {formatPricePerBase(ppb, ci.baseUnit)}
                    </div>
                    <div className={`font-mono text-[11px] mt-1.5 tracking-[0] ${item.recipe ? 'text-blue' : 'text-[#92722f]'}`}>
                      {c.pricing.mode === 'RATE'
                        ? <>{formatCurrency(c.pricing.rate)} / {c.pricing.rateUnit}</>
                        : <>{formatCurrency(c.pricing.purchasePrice)} per {c.chain[0]?.unit ?? 'pack'} &nbsp;|&nbsp; 1 {c.countUnit} = {basePerUnit(ci, c.countUnit).toLocaleString()} {ci.baseUnit}</>
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
                    countUOM={resolveCountUom(itemChainDims(item)) || item.baseUnit}
                    defaultRcId={defaultRcId}
                    toDisplay={(base) => baseToDisplay(item, base)}
                    onPulled={() => {
                      fetch(`/api/inventory/${item.id}`).then(r => r.json()).then(setItem)
                      onUpdated?.()
                    }}
                  />
                )}

                {/* Supplier offers */}
                <SupplierOffersSection itemId={item.id} baseUnit={item.baseUnit ?? null} onRepriced={() => { fetch(`/api/inventory/${item.id}`).then(r => r.json()).then(d => setItem(normalizeItem(d))); onUpdated?.() }} />

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
