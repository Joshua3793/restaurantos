'use client'
import { useEffect, useState, useRef, useCallback } from 'react'
import {
  X, ScanLine, CheckCircle2, AlertTriangle, Loader2,
  FileText, Image, FileSpreadsheet, TrendingUp, TrendingDown,
  Plus, Bell, Package, ClipboardList, ChevronRight, Pencil,
  AlertCircle, Hash, CalendarDays, ArrowRight, Trash2,
  Building2, ChevronDown, RotateCcw,
} from 'lucide-react'
import { formatCurrency, PACK_UOMS, COUNT_UOMS, calcPricePerBaseUnit, deriveBaseUnit, calcConversionFactor } from '@/lib/utils'
import { comparePricesNormalized, calcNewPurchasePrice } from '@/lib/invoice-format'
import type { Session, ScanItem, ApproveResult, MatchConfidence, LineItemAction, SessionSummary } from './types'
import { useRc } from '@/contexts/RevenueCenterContext'
import { rcHex } from '@/lib/rc-colors'

// Units where "unit price" on the invoice means $/packUOM (not $/case)
// e.g. $9.90/kg — total = qty × packQty × packSize × unitPrice
const WEIGHT_VOL_UOMS = new Set(['kg', 'g', 'lb', 'oz', 'l', 'ml'])
const isWeightVol = (uom: string | null | undefined) =>
  !!uom && WEIGHT_VOL_UOMS.has(uom.toLowerCase())

// ── Keyword helper ─────────────────────────────────────────────────────────────

function descriptionToKeywords(desc: string): string {
  return desc
    .replace(/\d+\s*[\/x]\s*\d+(?:\.\d+)?\s*(?:l|ml|kg|g|lb|oz)\b/gi, '')
    .replace(/\d+(?:\.\d+)?\s*(?:l|ml|kg|g|lb|oz)\b/gi, '')
    .replace(/[-–—]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join(' ')
}

// ── Badge helpers ─────────────────────────────────────────────────────────────

const confidenceBadge = (c: MatchConfidence) => {
  if (c === 'HIGH')   return <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-green-100 text-green-700">HIGH</span>
  if (c === 'MEDIUM') return <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-yellow-100 text-yellow-700">MEDIUM</span>
  if (c === 'LOW')    return <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-orange-100 text-orange-700">LOW</span>
  return <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-gray-100 text-gray-500">NO MATCH</span>
}

const fileIcon = (fileType: string) => {
  if (fileType.includes('pdf')) return <FileText size={16} className="text-red-500" />
  if (fileType.includes('csv') || fileType.includes('text')) return <FileSpreadsheet size={16} className="text-green-500" />
  return <Image size={16} className="text-blue-500" />
}

const ocrStatusBadge = (status: string) => {
  if (status === 'COMPLETE') return <span className="text-[10px] font-semibold text-green-600 flex items-center gap-1"><CheckCircle2 size={10} />Done</span>
  if (status === 'PROCESSING') return <span className="text-[10px] font-semibold text-blue-600 flex items-center gap-1"><Loader2 size={10} className="animate-spin" />Processing</span>
  if (status === 'ERROR') return <span className="text-[10px] font-semibold text-red-600 flex items-center gap-1"><AlertTriangle size={10} />Error</span>
  return <span className="text-[10px] font-semibold text-gray-400">Pending</span>
}

// ── Local types ───────────────────────────────────────────────────────────────

interface InventorySearchResult {
  id: string
  itemName: string
  abbreviation: string | null
  purchaseUnit: string
  purchasePrice: number
  pricePerBaseUnit: number
  baseUnit: string
  category: string
  qtyPerPurchaseUnit: number
  packSize: number
  packUOM: string
}

interface InventoryFullItem {
  id: string
  itemName: string
  category: string
  abbreviation: string | null
  location: string | null
  purchaseUnit: string
  purchasePrice: number
  qtyPerPurchaseUnit: number
  packSize: number
  packUOM: string
  baseUnit: string
  countUOM: string
  conversionFactor: number
  stockOnHand: number
  isActive: boolean
}

// ── AddItemModal ───────────────────────────────────────────────────────────────

function AddItemModal({
  onAdd,
  onClose,
}: {
  onAdd: (desc: string, qty: number | null, unitPrice: number | null) => Promise<void>
  onClose: () => void
}) {
  const [desc, setDesc]           = useState('')
  const [qty, setQty]             = useState('')
  const [unitPrice, setUnitPrice] = useState('')
  const [saving, setSaving]       = useState(false)

  const total = parseFloat(qty) > 0 && parseFloat(unitPrice) > 0
    ? parseFloat(qty) * parseFloat(unitPrice)
    : null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!desc.trim()) return
    setSaving(true)
    await onAdd(
      desc.trim(),
      parseFloat(qty) || null,
      parseFloat(unitPrice) || null,
    )
    setSaving(false)
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-[60]" onClick={onClose} />
      <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <div>
              <h3 className="font-semibold text-gray-900">Add Line Item</h3>
              <p className="text-xs text-gray-400 mt-0.5">Manually add a missing item to this invoice</p>
            </div>
            <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600"><X size={18} /></button>
          </div>

          <form onSubmit={handleSubmit} className="p-5 space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Description <span className="text-red-400">*</span></label>
              <input
                autoFocus
                value={desc}
                onChange={e => setDesc(e.target.value)}
                placeholder="e.g. Cream 4/4L, Chicken Breast, Olive Oil 3L…"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Qty ordered</label>
                <input
                  type="number"
                  step="any"
                  min="0"
                  value={qty}
                  onChange={e => setQty(e.target.value)}
                  placeholder="1"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Unit price ($)</label>
                <input
                  type="number"
                  step="any"
                  min="0"
                  value={unitPrice}
                  onChange={e => setUnitPrice(e.target.value)}
                  placeholder="0.00"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            {total !== null && (
              <div className="flex items-center justify-between text-sm bg-blue-50 rounded-lg px-3 py-2">
                <span className="text-blue-600">Line total</span>
                <span className="font-bold text-blue-800">{new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(total)}</span>
              </div>
            )}

            <p className="text-xs text-gray-400">
              You can fill in the pack format and match it to inventory after adding.
            </p>

            <div className="flex gap-2 pt-1">
              <button
                type="submit"
                disabled={!desc.trim() || saving}
                className="flex-1 bg-blue-600 text-white rounded-lg py-2 text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                {saving ? 'Adding…' : 'Add to Invoice'}
              </button>
              <button type="button" onClick={onClose}
                className="border border-gray-200 text-gray-600 rounded-lg py-2 px-4 text-sm hover:bg-gray-50">
                Cancel
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  )
}

// ── ScanItemCard ───────────────────────────────────────────────────────────────

function ScanItemCard({
  item,
  onUpdate,
  onOpenDetail,
  onEditInventory,
  revenueCenters,
  sessionRcId,
  onRcChange,
}: {
  item: ScanItem
  onUpdate: (updates: Partial<Omit<ScanItem, 'newItemData'> & { newItemData?: Record<string, unknown> | string | null }>) => void
  onOpenDetail: () => void
  onEditInventory: (inventoryItemId: string, scanItem: ScanItem) => void
  revenueCenters: Array<{ id: string; name: string; color: string }>
  sessionRcId: string | null
  onRcChange: (rcId: string) => void
}) {
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<InventorySearchResult[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [showDropdown, setShowDropdown] = useState(false)
  // Unified purchase details (cases + pack format + pricing — all linked)
  const [editingPurchase, setEditingPurchase] = useState(
    item.needsFormatConfirm || item.rawUnitPrice === null
  )
  const [localCases, setLocalCases]       = useState(String(item.rawQty ?? ''))
  const [localUnit, setLocalUnit]         = useState(item.rawUnit ?? 'cs')
  const [localPackQty, setLocalPackQty]   = useState(String(item.invoicePackQty ?? ''))
  const [localPackSize, setLocalPackSize] = useState(String(item.invoicePackSize ?? ''))
  const [localPackUOM, setLocalPackUOM]   = useState(item.invoicePackUOM ?? '')
  const [localUnitPrice, setLocalUnitPrice] = useState(String(item.rawUnitPrice ?? ''))
  const [localLineTotal, setLocalLineTotal] = useState(() => {
    if (item.rawLineTotal !== null) return String(item.rawLineTotal)
    if (item.rawQty !== null && item.rawUnitPrice !== null) {
      const total = Number(item.rawQty) * Number(item.rawUnitPrice)
      return String(total.toFixed(2))
    }
    return ''
  })
  const searchRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Close dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const search = (q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      setIsSearching(true)
      const res = await fetch(`/api/inventory/search?q=${encodeURIComponent(q)}&limit=8`)
      const data = await res.json()
      setSearchResults(data)
      setIsSearching(false)
    }, 200)
  }

  const handleSearchFocus = () => {
    // Pre-populate with current match name or item description
    const defaultQ = item.matchedItem?.itemName ?? descriptionToKeywords(item.rawDescription)
    setSearchQuery(defaultQ)
    search(defaultQ)
    setShowDropdown(true)
  }

  const handleSearchInput = (q: string) => {
    setSearchQuery(q)
    search(q)
    setShowDropdown(true)
  }

  const handleSelectItem = (inv: InventorySearchResult) => {
    const pq = parseFloat(localPackQty) || null
    const ps = parseFloat(localPackSize) || null
    const pUOM = localPackUOM || null
    const rawPrice = parseFloat(localUnitPrice) || (item.rawUnitPrice !== null ? Number(item.rawUnitPrice) : null)

    let newPrice: number | null = rawPrice
    let priceDiffPct: number | null = null

    if (pq && ps && ps > 0 && pUOM && rawPrice !== null) {
      // unitPrice from OCR is always $/case; divide by pack to get $/packUOM for comparison
      const invoicePricePerPackUOM = rawPrice / (Number(pq) * Number(ps))
      const invPackTotal = Number(inv.qtyPerPurchaseUnit) * Number(inv.packSize)
      const invPricePerPackUOM = invPackTotal > 0 ? Number(inv.purchasePrice) / invPackTotal : 0
      const normalized = comparePricesNormalized(
        invoicePricePerPackUOM, pUOM,
        invPricePerPackUOM, inv.packUOM
      )
      if (normalized) {
        priceDiffPct = normalized.pctDiff
        const calcPrice = calcNewPurchasePrice(invoicePricePerPackUOM, pUOM, Number(inv.qtyPerPurchaseUnit), Number(inv.packSize), inv.packUOM)
        if (calcPrice !== null) newPrice = calcPrice
      } else {
        // Incompatible units — fall back to direct comparison
        const prevPrice = Number(inv.purchasePrice)
        priceDiffPct = prevPrice > 0 ? Math.round(((rawPrice - prevPrice) / prevPrice) * 10000) / 100 : null
      }
    } else {
      // No format info — direct comparison
      const prevPrice = Number(inv.purchasePrice)
      priceDiffPct = prevPrice > 0 && rawPrice !== null
        ? Math.round(((rawPrice - prevPrice) / prevPrice) * 10000) / 100
        : null
    }

    const action: LineItemAction = newPrice !== null && Math.abs(Number(priceDiffPct ?? 0)) > 0.1
      ? 'UPDATE_PRICE' : 'ADD_SUPPLIER'

    onUpdate({ matchedItemId: inv.id, action, previousPrice: newPrice !== null ? String(Number(inv.purchasePrice)) : null, newPrice: newPrice !== null ? String(newPrice) : null, priceDiffPct: priceDiffPct !== null ? String(priceDiffPct) : null, matchConfidence: 'HIGH', matchScore: 100 })
    setShowDropdown(false)
  }

  const handleSelectCreateNew = () => {
    onUpdate({ matchedItemId: null, action: 'CREATE_NEW', previousPrice: null, priceDiffPct: null })
    setShowDropdown(false)
  }

  // ── Linked calculators ────────────────────────────────────────────────────
  // unitPrice from OCR is always $/case — total = qty × unitPrice
  const calcTotal = (cases: number, price: number) => cases * price

  const handleCasesChange = (v: string) => {
    setLocalCases(v)
    const cases = parseFloat(v), price = parseFloat(localUnitPrice)
    if (cases > 0 && price > 0) setLocalLineTotal(calcTotal(cases, price).toFixed(2))
  }
  const handleUnitPriceChange = (v: string) => {
    setLocalUnitPrice(v)
    const cases = parseFloat(localCases), price = parseFloat(v)
    if (cases > 0 && price > 0) setLocalLineTotal(calcTotal(cases, price).toFixed(2))
  }
  const handleLineTotalChange = (v: string) => {
    setLocalLineTotal(v)
    const cases = parseFloat(localCases), total = parseFloat(v)
    if (cases > 0 && total > 0) setLocalUnitPrice((total / cases).toFixed(4))
  }

  // ── Unified save (purchases + format + price diff all at once) ────────────
  const handlePurchaseSave = () => {
    const cases     = parseFloat(localCases)     || null
    const unitPrice = parseFloat(localUnitPrice) || null
    const manualTotal = parseFloat(localLineTotal) || null
    const pq  = parseFloat(localPackQty)  || null
    const ps  = parseFloat(localPackSize) || null
    const pUOM = localPackUOM || null
    // unitPrice is always $/case
    const lineTotal = manualTotal ?? (cases !== null && unitPrice !== null ? cases * unitPrice : null)
    let newPrice: number | null = unitPrice
    let priceDiffPct: number | null = null

    if (unitPrice !== null && item.matchedItem) {
      if (pq && ps && Number(ps) > 0 && pUOM) {
        // unitPrice is always $/case; divide by pack to get $/packUOM for comparison
        const invoicePPU = unitPrice / (pq * ps)
        const invPackTotal2 = Number(item.matchedItem.qtyPerPurchaseUnit) * Number(item.matchedItem.packSize)
        const invPPU2 = invPackTotal2 > 0 ? Number(item.matchedItem.purchasePrice) / invPackTotal2 : 0
        const normalized = comparePricesNormalized(
          invoicePPU, pUOM,
          invPPU2, item.matchedItem.packUOM
        )
        if (normalized) {
          priceDiffPct = normalized.pctDiff
          const calcPrice = calcNewPurchasePrice(invoicePPU, pUOM, Number(item.matchedItem.qtyPerPurchaseUnit), Number(item.matchedItem.packSize), item.matchedItem.packUOM)
          if (calcPrice !== null) newPrice = calcPrice
        } else {
          const prevPrice = Number(item.matchedItem.purchasePrice)
          priceDiffPct = prevPrice > 0 ? Math.round(((unitPrice - prevPrice) / prevPrice) * 10000) / 100 : null
        }
      } else {
        const prevPrice = Number(item.matchedItem.purchasePrice)
        priceDiffPct = prevPrice > 0 ? Math.round(((unitPrice - prevPrice) / prevPrice) * 10000) / 100 : null
      }
    }

    onUpdate({
      rawQty:       cases !== null ? String(cases) : null,
      rawUnit:      localUnit || null,
      rawUnitPrice: unitPrice !== null ? String(unitPrice) : null,
      rawLineTotal: lineTotal !== null ? String(lineTotal) : null,
      invoicePackQty:  pq !== null ? String(pq) : null,
      invoicePackSize: ps !== null ? String(ps) : null,
      invoicePackUOM:  pUOM,
      needsFormatConfirm: false,
      newPrice:     newPrice !== null ? String(newPrice) : null,
      priceDiffPct: priceDiffPct !== null ? String(priceDiffPct) : null,
      action: Math.abs(Number(priceDiffPct ?? 0)) > 0.1 ? 'UPDATE_PRICE'
            : (item.matchedItemId ? 'ADD_SUPPLIER' : item.action),
    })
    setEditingPurchase(false)
  }

  const accentClass =
    item.action === 'SKIP'           ? 'border-l-gray-200 opacity-50' :
    item.action === 'CREATE_NEW'     ? 'border-l-purple-400' :
    editingPurchase                  ? 'border-l-amber-400' :
    item.action === 'UPDATE_PRICE'   ? 'border-l-blue-400' :
    item.action === 'ADD_SUPPLIER'   ? 'border-l-green-400' :
    item.matchConfidence === 'HIGH'  ? 'border-l-green-300' :
    item.matchConfidence === 'MEDIUM'? 'border-l-yellow-300' :
    item.matchConfidence === 'LOW'   ? 'border-l-orange-300' :
                                       'border-l-gray-200'

  const priceDiff     = item.priceDiffPct ? Number(item.priceDiffPct) : null
  const newItemFilled = item.action === 'CREATE_NEW' && item.newItemData
  const displayName   = item.matchedItem?.itemName ?? null

  // Derived display values (from saved item props — shown in view mode)
  // rawUnitPrice is always $/case per OCR prompt spec
  const savedLineTotal = (() => {
    if (item.rawLineTotal !== null) return Number(item.rawLineTotal)
    if (item.rawQty !== null && item.rawUnitPrice !== null)
      return Number(item.rawQty) * Number(item.rawUnitPrice)
    return null
  })()

  // Base cost = $/packUOM — unitPrice is always $/case, divide by pack
  const liveBaseCost = (() => {
    const price = parseFloat(localUnitPrice)
    const pq    = parseFloat(localPackQty)
    const ps    = parseFloat(localPackSize)
    if (price > 0 && pq > 0 && ps > 0) return price / (pq * ps)
    return null
  })()

  const savedBaseCost = (() => {
    if (!item.rawUnitPrice || !item.invoicePackQty || !item.invoicePackSize) return null
    const pq = Number(item.invoicePackQty), ps = Number(item.invoicePackSize)
    if (pq <= 0 || ps <= 0) return null
    return Number(item.rawUnitPrice) / (pq * ps)
  })()

  return (
    <div className={`bg-white rounded-xl border border-gray-100 border-l-4 ${accentClass} px-3 py-2.5 transition-all`}>

      {/* ── Row 1: Description + skip ── */}
      <div className="flex items-start justify-between gap-2">
        <span className={`font-medium text-sm leading-snug flex-1 min-w-0 ${item.action === 'SKIP' ? 'line-through text-gray-400' : 'text-gray-900'}`}>
          {item.rawDescription}
        </span>
        <button
          onClick={() => onUpdate({ action: item.action === 'SKIP' ? (item.matchedItemId ? 'UPDATE_PRICE' : 'CREATE_NEW') : 'SKIP' })}
          className={`shrink-0 p-0.5 rounded transition-colors ${item.action === 'SKIP' ? 'text-gray-500 bg-gray-100' : 'text-gray-200 hover:text-red-400'}`}
          title={item.action === 'SKIP' ? 'Restore' : 'Skip'}
        >
          <X size={13} />
        </button>
      </div>

      {/* ── Row 2: Purchase details (view or edit) ── */}
      {item.action !== 'SKIP' && (
        <div className="mt-1">
          {/* VIEW MODE — compact summary */}
          {!editingPurchase && (
            <div className="flex items-center gap-1.5 text-xs flex-wrap">
              {/* cases */}
              {item.rawQty !== null && (
                <span className="font-semibold text-gray-700">{item.rawQty} {item.rawUnit || 'cs'}</span>
              )}
              {/* pack format */}
              {item.invoicePackQty && item.invoicePackSize && (
                <>
                  <span className="text-gray-300">·</span>
                  <span className="text-gray-600">
                    {Number(item.invoicePackQty)} × {Number(item.invoicePackSize)}{item.invoicePackUOM}
                  </span>
                </>
              )}
              {/* unit price */}
              {item.rawUnitPrice !== null && (
                <>
                  <span className="text-gray-300">·</span>
                  <span className="text-gray-600">
                    {formatCurrency(Number(item.rawUnitPrice))}/case
                  </span>
                </>
              )}
              {/* total */}
              {savedLineTotal !== null && (
                <>
                  <span className="text-gray-400">=</span>
                  <span className="font-bold text-gray-800">{formatCurrency(savedLineTotal)}</span>
                </>
              )}
              {/* base cost */}
              {savedBaseCost !== null && item.invoicePackUOM && (() => {
                const pUOM = item.invoicePackUOM!
                if (item.matchedItem) {
                  const _invPkgTotal = Number(item.matchedItem.qtyPerPurchaseUnit) * Number(item.matchedItem.packSize)
                  const _invPPU = _invPkgTotal > 0 ? Number(item.matchedItem.purchasePrice) / _invPkgTotal : 0
                  const norm = comparePricesNormalized(savedBaseCost, pUOM, _invPPU, item.matchedItem.packUOM)
                  if (norm) return (
                    <>
                      <span className="text-gray-300">·</span>
                      <span className={`font-semibold ${priceDiff !== null && priceDiff > 0 ? 'text-red-500' : priceDiff !== null ? 'text-green-500' : 'text-gray-600'}`}>
                        {formatCurrency(norm.invoicePPB)}/{norm.baseUnit}
                      </span>
                    </>
                  )
                }
                return (
                  <>
                    <span className="text-gray-300">·</span>
                    <span className="text-gray-500">{formatCurrency(savedBaseCost)}/{pUOM}</span>
                  </>
                )
              })()}
              <button onClick={() => setEditingPurchase(true)} className="text-gray-200 hover:text-blue-400 ml-0.5" title="Edit"><Pencil size={10} /></button>
            </div>
          )}

          {/* EDIT MODE — labeled linked calculator */}
          {editingPurchase && (
            <div className="mt-1 space-y-1.5">
              <div className="flex items-end gap-1.5 flex-wrap text-xs">
                {/* Qty Ordered */}
                <div className="flex flex-col items-center gap-0.5">
                  <span className="text-[9px] text-gray-400 uppercase tracking-wide">Qty ordered</span>
                  <div className="flex items-center gap-0.5">
                    <input type="number" step="any" min="0" value={localCases}
                      onChange={e => handleCasesChange(e.target.value)}
                      className="w-12 border border-blue-300 rounded px-1 py-1 text-center bg-blue-50 focus:outline-none focus:ring-1 focus:ring-blue-400" />
                    <input value={localUnit} onChange={e => setLocalUnit(e.target.value)}
                      placeholder="cs"
                      className="w-9 border border-blue-300 rounded px-1 py-1 text-center bg-blue-50 focus:outline-none focus:ring-1 focus:ring-blue-400" />
                  </div>
                </div>
                <span className="text-gray-400 pb-1">×</span>
                {/* Qty per case */}
                <div className="flex flex-col items-center gap-0.5">
                  <span className="text-[9px] text-gray-400 uppercase tracking-wide">Qty/case</span>
                  <input type="number" step="any" min="0" value={localPackQty}
                    onChange={e => setLocalPackQty(e.target.value)}
                    className="w-14 border border-blue-300 rounded px-1 py-1 text-center bg-blue-50 focus:outline-none focus:ring-1 focus:ring-blue-400" />
                </div>
                <span className="text-gray-400 pb-1">×</span>
                {/* Pack size + UOM */}
                <div className="flex flex-col items-center gap-0.5">
                  <span className="text-[9px] text-gray-400 uppercase tracking-wide">Pack size</span>
                  <div className="flex items-center gap-0.5">
                    <input type="number" step="any" min="0" value={localPackSize}
                      onChange={e => setLocalPackSize(e.target.value)}
                      className="w-14 border border-blue-300 rounded px-1 py-1 text-center bg-blue-50 focus:outline-none focus:ring-1 focus:ring-blue-400" />
                    <select value={localPackUOM} onChange={e => setLocalPackUOM(e.target.value)}
                      className="border border-blue-300 rounded px-1 py-1 bg-blue-50 focus:outline-none text-xs">
                      <option value="">—</option>
                      {PACK_UOMS.map(u => <option key={u} value={u}>{u}</option>)}
                    </select>
                  </div>
                </div>
                <span className="text-gray-400 pb-1">@</span>
                {/* Unit price */}
                <div className="flex flex-col items-center gap-0.5">
                  <span className="text-[9px] text-gray-400 uppercase tracking-wide">
                    $/case
                  </span>
                  <input type="number" step="any" min="0" value={localUnitPrice}
                    onChange={e => handleUnitPriceChange(e.target.value)}
                    className="w-18 border border-blue-300 rounded px-1 py-1 text-center bg-blue-50 focus:outline-none focus:ring-1 focus:ring-blue-400" />
                </div>
                <span className="text-gray-400 pb-1">=</span>
                {/* Total */}
                <div className="flex flex-col items-center gap-0.5">
                  <span className="text-[9px] text-gray-400 uppercase tracking-wide">Total</span>
                  <input type="number" step="any" min="0" value={localLineTotal}
                    onChange={e => handleLineTotalChange(e.target.value)}
                    className="w-20 border border-blue-300 rounded px-1 py-1 text-center bg-blue-50 focus:outline-none focus:ring-1 focus:ring-blue-400 font-semibold" />
                </div>
                {/* Save / cancel */}
                <div className="flex items-center gap-1 pb-0.5">
                  <button onClick={handlePurchaseSave}
                    className="bg-blue-600 text-white px-2 py-1 rounded text-xs hover:bg-blue-700 transition-colors font-medium">✓</button>
                  <button onClick={() => setEditingPurchase(false)}
                    className="text-gray-400 hover:text-gray-600 px-1 text-xs">✕</button>
                </div>
              </div>
              {/* Live base cost preview */}
              {liveBaseCost !== null && localPackUOM && (
                <div className="text-[10px] text-gray-500 ml-0.5">
                  {(() => {
                    if (item.matchedItem) {
                      const _livePkgTotal = Number(item.matchedItem.qtyPerPurchaseUnit) * Number(item.matchedItem.packSize)
                      const _livePPU = _livePkgTotal > 0 ? Number(item.matchedItem.purchasePrice) / _livePkgTotal : 0
                      const norm = comparePricesNormalized(liveBaseCost, localPackUOM, _livePPU, item.matchedItem.packUOM)
                      if (norm) return (
                        <span>
                          base cost: <span className="font-semibold text-gray-700">{formatCurrency(norm.invoicePPB)}/{norm.baseUnit}</span>
                          {' · '}inv: {formatCurrency(norm.inventoryPPB)}/{norm.baseUnit}
                          {' '}
                          <span className={`font-semibold ${norm.pctDiff > 0 ? 'text-red-500' : 'text-green-500'}`}>
                            {norm.pctDiff > 0 ? '+' : ''}{norm.pctDiff.toFixed(1)}%
                          </span>
                        </span>
                      )
                    }
                    return <span>base cost: <span className="font-semibold text-gray-700">{formatCurrency(liveBaseCost)}/{localPackUOM}</span></span>
                  })()}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Row 3: Inventory match + price diff ── */}
      {item.action !== 'SKIP' && (
        <div className="flex items-center gap-2 mt-1.5">
          {item.action === 'CREATE_NEW'
            ? <Plus size={11} className="text-purple-400 shrink-0" />
            : <ArrowRight size={11} className="text-gray-300 shrink-0" />
          }

          {/* Search combobox */}
          <div ref={searchRef} className="relative flex-1 min-w-0">
            <div
              className="flex items-center gap-1.5 cursor-pointer group"
              onClick={() => { if (!showDropdown) handleSearchFocus() }}
            >
              <input
                className={`flex-1 text-xs font-medium outline-none bg-transparent min-w-0 truncate ${
                  item.action === 'CREATE_NEW' ? 'text-purple-700 placeholder-purple-300' :
                  item.matchedItemId ? 'text-gray-800' : 'text-gray-400'
                } ${showDropdown ? 'cursor-text' : 'cursor-pointer'}`}
                placeholder={item.action === 'CREATE_NEW' ? 'Create new item…' : 'Search inventory…'}
                value={showDropdown ? searchQuery : (displayName ?? (item.action === 'CREATE_NEW' ? 'Create new inventory item' : 'No match — tap to search'))}
                onChange={e => handleSearchInput(e.target.value)}
                onFocus={handleSearchFocus}
              />
              {isSearching
                ? <Loader2 size={10} className="animate-spin text-gray-300 shrink-0" />
                : <ChevronRight size={10} className={`text-gray-200 group-hover:text-gray-400 shrink-0 transition-transform ${showDropdown ? 'rotate-90' : ''}`} />
              }
            </div>

            {/* Dropdown */}
            {showDropdown && (
              <div className="absolute z-30 top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden max-h-56 overflow-y-auto">
                {searchResults.length === 0 && !isSearching && (
                  <p className="text-xs text-gray-400 px-3 py-2">No items found</p>
                )}
                {searchResults.map(inv => (
                  <button
                    key={inv.id}
                    onMouseDown={e => { e.preventDefault(); handleSelectItem(inv) }}
                    className="w-full text-left px-3 py-2 hover:bg-blue-50 transition-colors border-b border-gray-50 last:border-0"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-gray-900 truncate">{inv.itemName}</p>
                        <p className="text-[10px] text-gray-400">{inv.purchaseUnit} · {inv.category}</p>
                      </div>
                      <span className="text-xs text-gray-500 shrink-0">{formatCurrency(Number(inv.purchasePrice))}</span>
                    </div>
                  </button>
                ))}
                <button
                  onMouseDown={e => { e.preventDefault(); handleSelectCreateNew() }}
                  className="w-full text-left px-3 py-2 hover:bg-purple-50 transition-colors flex items-center gap-2"
                >
                  <Plus size={12} className="text-purple-500" />
                  <span className="text-xs font-medium text-purple-700">Create new inventory item</span>
                </button>
              </div>
            )}
          </div>

          {/* Price diff: old → new + % */}
          {item.action === 'UPDATE_PRICE' && priceDiff !== null && item.previousPrice !== null && item.newPrice !== null && (
            <div className="flex items-center gap-1 shrink-0 text-xs">
              <span className="text-gray-400">{formatCurrency(Number(item.previousPrice))}</span>
              <ArrowRight size={9} className="text-gray-300" />
              <span className={`font-semibold ${priceDiff > 0 ? 'text-red-600' : 'text-green-600'}`}>
                {formatCurrency(Number(item.newPrice))}
              </span>
              <span className={`flex items-center font-bold text-[10px] ${priceDiff > 0 ? 'text-red-500' : 'text-green-500'}`}>
                {priceDiff > 0 ? <TrendingUp size={9} /> : <TrendingDown size={9} />}
                {Math.abs(priceDiff).toFixed(1)}%
              </span>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-1 shrink-0">
            {item.action === 'CREATE_NEW' && (
              <button
                onClick={onOpenDetail}
                className={`text-[10px] px-2 py-0.5 rounded-lg font-medium transition-colors ${
                  newItemFilled ? 'bg-purple-100 text-purple-700 hover:bg-purple-200' : 'bg-amber-100 text-amber-700 hover:bg-amber-200'
                }`}
              >
                {newItemFilled ? 'Edit' : 'Fill in'}
              </button>
            )}
            {(item.action === 'UPDATE_PRICE' || item.action === 'ADD_SUPPLIER') && item.matchedItemId && (
              <button
                onClick={() => onEditInventory(item.matchedItemId!, item)}
                className="text-gray-200 hover:text-blue-500 transition-colors"
                title="Edit inventory item"
              >
                <Pencil size={11} />
              </button>
            )}
          </div>
        </div>
      )}

      {revenueCenters.length > 1 && (
        <div className="flex items-center gap-2 mt-2 pt-2 border-t border-gray-50">
          <span className="text-[10px] text-gray-400 shrink-0">RC:</span>
          <select
            value={item.revenueCenterId ?? sessionRcId ?? ''}
            onChange={e => onRcChange(e.target.value)}
            className="text-[10px] border border-gray-100 rounded px-1.5 py-0.5 text-gray-500 bg-white focus:outline-none"
          >
            {revenueCenters.map(rc => (
              <option key={rc.id} value={rc.id}>{rc.name}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  )
}

// ── ActionSelect ───────────────────────────────────────────────────────────────

function ActionSelect({
  value,
  hasMatch,
  onChange,
}: {
  value: LineItemAction
  hasMatch: boolean
  onChange: (v: LineItemAction) => void
}) {
  const options: { value: LineItemAction; label: string }[] = [
    { value: 'UPDATE_PRICE', label: 'Update Price' },
    { value: 'ADD_SUPPLIER', label: 'Add Supplier' },
    { value: 'CREATE_NEW',   label: 'Create New' },
    { value: 'SKIP',         label: 'Skip' },
  ]

  const colorMap: Record<LineItemAction, string> = {
    PENDING:       'bg-gray-100 text-gray-600',
    UPDATE_PRICE:  'bg-blue-100 text-blue-700',
    ADD_SUPPLIER:  'bg-teal-100 text-teal-700',
    CREATE_NEW:    'bg-purple-100 text-purple-700',
    SKIP:          'bg-gray-100 text-gray-400',
  }

  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value as LineItemAction)}
      className={`text-xs font-semibold rounded-lg px-2 py-1 border-0 cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-400 ${colorMap[value]}`}
    >
      {options.filter(o => hasMatch || o.value === 'CREATE_NEW' || o.value === 'SKIP').map(o => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  )
}

// ── parseDescriptionHints ─────────────────────────────────────────────────────

function parseDescriptionHints(description: string): { qty: number; packSize: number; packUOM: string } {
  // Parse patterns like "4/4L", "1KG", "2.5kg", "4x500ml" from description
  const lower = description.toLowerCase()

  // Pattern: 4/4L or 4/4l (qty per case / pack size + UOM)
  const slashMatch = lower.match(/(\d+)\s*\/\s*(\d+(?:\.\d+)?)\s*(l|ml|kg|g|lb|oz)\b/)
  if (slashMatch) {
    return { qty: Number(slashMatch[1]), packSize: Number(slashMatch[2]), packUOM: slashMatch[3] }
  }

  // Pattern: 4x500ml or 4x500g
  const xMatch = lower.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(l|ml|kg|g|lb|oz)\b/)
  if (xMatch) {
    return { qty: Number(xMatch[1]), packSize: Number(xMatch[2]), packUOM: xMatch[3] }
  }

  // Pattern: standalone "1KG", "500ML" etc.
  const singleMatch = lower.match(/(\d+(?:\.\d+)?)\s*(l|ml|kg|g|lb|oz)\b/)
  if (singleMatch) {
    return { qty: 1, packSize: Number(singleMatch[1]), packUOM: singleMatch[2] }
  }

  return { qty: 1, packSize: 1, packUOM: 'each' }
}

const ITEM_CATEGORIES = ['BREAD', 'DAIRY', 'DRY', 'FISH', 'MEAT', 'PREPD', 'PROD', 'CHM', 'OTHER'] as const

// ── ItemDetailPanel ───────────────────────────────────────────────────────────

function ItemDetailPanel({
  item,
  onSave,
  onClose,
}: {
  item: ScanItem
  onSave: (updates: Partial<Omit<ScanItem, 'newItemData'> & { newItemData?: Record<string, unknown> }>) => void
  onClose: () => void
}) {
  const hints = parseDescriptionHints(item.rawDescription)

  // Pre-populate from saved newItemData or from scan hints
  const existing = item.newItemData ? (typeof item.newItemData === 'string' ? JSON.parse(item.newItemData) : item.newItemData) as Record<string, unknown> : null

  const [form, setForm] = useState({
    itemName:           String(existing?.itemName ?? item.rawDescription),
    category:           String(existing?.category ?? 'DRY'),
    purchaseUnit:       String(existing?.purchaseUnit ?? (item.rawUnit || 'case')),
    qtyPerPurchaseUnit: String(existing?.qtyPerPurchaseUnit ?? hints.qty),
    packSize:           String(existing?.packSize ?? hints.packSize),
    packUOM:            String(existing?.packUOM ?? hints.packUOM),
    purchasePrice:      String(existing?.purchasePrice ?? (item.newPrice !== null ? Number(item.newPrice) : '')),
    countUOM:           String(existing?.countUOM ?? hints.packUOM),
  })

  const pp   = parseFloat(form.purchasePrice) || 0
  const qty  = parseFloat(form.qtyPerPurchaseUnit) || 1
  const ps   = parseFloat(form.packSize) || 1
  const ppbu = calcPricePerBaseUnit(pp, qty, ps, form.packUOM)
  const cf   = calcConversionFactor(form.countUOM, qty, ps, form.packUOM)
  const bu   = deriveBaseUnit(form.packUOM)

  const isNew = item.action === 'CREATE_NEW'

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/30 z-[60]" onClick={onClose} />

      {/* Panel */}
      <div className="fixed inset-y-0 right-0 z-[70] w-full max-w-md bg-white shadow-xl overflow-y-auto flex flex-col">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-gray-100 px-4 py-3 flex items-center justify-between gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-xs text-gray-400 uppercase tracking-wide font-medium">
              {isNew ? 'New Inventory Item' : 'Matched Item'}
            </p>
            <h3 className="font-semibold text-gray-900 text-sm truncate mt-0.5">{item.rawDescription}</h3>
          </div>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>

        {/* Invoice line summary */}
        <div className="px-4 py-3 bg-gray-50 border-b border-gray-100 flex items-center gap-4 text-xs text-gray-500">
          {item.rawQty !== null && <span><span className="font-medium text-gray-700">{item.rawQty}</span> {item.rawUnit || ''}</span>}
          {item.rawUnitPrice !== null && <span>Unit price: <span className="font-medium text-gray-700">{formatCurrency(Number(item.rawUnitPrice))}</span></span>}
          {item.rawLineTotal !== null && <span>Line total: <span className="font-medium text-gray-700">{formatCurrency(Number(item.rawLineTotal))}</span></span>}
        </div>

        {isNew ? (
          /* ── CREATE_NEW form ──────────────────────────────────────────────── */
          <div className="flex-1 p-4 space-y-4">
            {/* Item name */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Item Name</label>
              <input
                value={form.itemName}
                onChange={e => setForm(f => ({ ...f, itemName: e.target.value }))}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* Category */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Category</label>
              <select
                value={form.category}
                onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {ITEM_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>

            {/* Purchase structure */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-2">Purchase Structure</label>
              <p className="text-[11px] text-gray-400 mb-2">
                Example: Meadow Milk 4/4L → Purchase Unit = <em>case</em>, Qty per case = <em>4</em>, Pack size = <em>4</em>, Pack UOM = <em>L</em>
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Purchase Unit</label>
                  <input
                    value={form.purchaseUnit}
                    onChange={e => setForm(f => ({ ...f, purchaseUnit: e.target.value }))}
                    placeholder="case, bag, box…"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Qty per case</label>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={form.qtyPerPurchaseUnit}
                    onChange={e => setForm(f => ({ ...f, qtyPerPurchaseUnit: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Pack Size</label>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={form.packSize}
                    onChange={e => setForm(f => ({ ...f, packSize: e.target.value }))}
                    placeholder="4, 500, 1…"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Pack UOM</label>
                  <select
                    value={form.packUOM}
                    onChange={e => setForm(f => ({ ...f, packUOM: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {PACK_UOMS.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Purchase Price ($)</label>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={form.purchasePrice}
                    onChange={e => setForm(f => ({ ...f, purchasePrice: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Count UOM</label>
                  <select
                    value={form.countUOM}
                    onChange={e => setForm(f => ({ ...f, countUOM: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {COUNT_UOMS.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
              </div>
            </div>

            {/* Auto-calculated preview */}
            <div className="bg-blue-50 rounded-lg p-3 space-y-1">
              <p className="text-xs font-semibold text-blue-700 uppercase tracking-wide">Auto-calculated</p>
              <div className="flex justify-between text-xs">
                <span className="text-blue-600">Base unit:</span>
                <span className="font-medium text-blue-800">{bu}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-blue-600">Price per {bu}:</span>
                <span className="font-medium text-blue-800">{formatCurrency(ppbu)}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-blue-600">Total base units per case:</span>
                <span className="font-medium text-blue-800">{(qty * ps).toFixed(2)} {bu}</span>
              </div>
              {cf !== 1 && (
                <div className="flex justify-between text-xs">
                  <span className="text-blue-600">Conversion factor:</span>
                  <span className="font-medium text-blue-800">{cf.toFixed(4)}</span>
                </div>
              )}
            </div>
          </div>
        ) : (
          /* ── Matched item read-only view ──────────────────────────────────── */
          <div className="flex-1 p-4 space-y-4">
            {item.matchedItem && (
              <>
                <div className="flex items-center gap-2">
                  <Package size={14} className="text-blue-500" />
                  <span className="font-semibold text-gray-900 text-sm">{item.matchedItem.itemName}</span>
                  {confidenceBadge(item.matchConfidence)}
                </div>

                <div className="bg-gray-50 rounded-xl p-4 space-y-3">
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <p className="text-xs text-gray-400">Purchase Unit</p>
                      <p className="font-medium text-gray-900">{item.matchedItem.purchaseUnit}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-400">Current Price</p>
                      <p className="font-medium text-gray-900">{formatCurrency(Number(item.matchedItem.purchasePrice))}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-400">Price / Base Unit</p>
                      <p className="font-medium text-gray-900">{formatCurrency(Number(item.matchedItem.pricePerBaseUnit))}</p>
                    </div>
                  </div>
                </div>

                {item.action === 'UPDATE_PRICE' && item.newPrice !== null && (
                  <div className="bg-blue-50 rounded-xl p-4 space-y-2">
                    <p className="text-xs font-semibold text-blue-700 uppercase tracking-wide">Proposed Price Change</p>
                    <div className="flex items-center gap-3">
                      <div className="text-center">
                        <p className="text-xs text-gray-400">Current</p>
                        <p className="text-lg font-bold text-gray-600">{formatCurrency(Number(item.previousPrice))}</p>
                      </div>
                      <ArrowRight size={16} className="text-gray-300" />
                      <div className="text-center">
                        <p className="text-xs text-gray-400">New</p>
                        <p className="text-lg font-bold text-blue-700">{formatCurrency(Number(item.newPrice))}</p>
                      </div>
                      {item.priceDiffPct !== null && (
                        <div className={`ml-auto flex items-center gap-1 font-bold text-sm ${Number(item.priceDiffPct) > 0 ? 'text-red-600' : 'text-green-600'}`}>
                          {Number(item.priceDiffPct) > 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                          {Math.abs(Number(item.priceDiffPct)).toFixed(1)}%
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="sticky bottom-0 bg-white border-t border-gray-100 px-4 py-3 flex gap-2">
          {isNew && (
            <button
              onClick={() => {
                onSave({
                  newItemData: {
                    itemName:           form.itemName,
                    category:           form.category,
                    purchaseUnit:       form.purchaseUnit,
                    qtyPerPurchaseUnit: parseFloat(form.qtyPerPurchaseUnit) || 1,
                    packSize:           parseFloat(form.packSize) || 1,
                    packUOM:            form.packUOM,
                    purchasePrice:      parseFloat(form.purchasePrice) || 0,
                    countUOM:           form.countUOM,
                    baseUnit:           bu,
                    pricePerBaseUnit:   ppbu,
                    conversionFactor:   cf,
                  },
                })
              }}
              className="flex-1 bg-blue-600 text-white rounded-lg py-2 text-sm font-semibold hover:bg-blue-700 transition-colors"
            >
              Save Item Details
            </button>
          )}
          <button
            onClick={onClose}
            className={`${isNew ? '' : 'flex-1'} border border-gray-200 text-gray-600 rounded-lg py-2 px-4 text-sm hover:bg-gray-50 transition-colors`}
          >
            {isNew ? 'Cancel' : 'Close'}
          </button>
        </div>
      </div>
    </>
  )
}

// ── InventoryEditModal ────────────────────────────────────────────────────────

function InventoryEditModal({
  inventoryItemId,
  scanItem,
  onSaved,
  onClose,
}: {
  inventoryItemId: string
  scanItem: ScanItem
  onSaved: (updates: Partial<Omit<ScanItem, 'newItemData'>>) => void
  onClose: () => void
}) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    itemName: '',
    category: 'DRY',
    purchaseUnit: 'each',
    qtyPerPurchaseUnit: '1',
    packSize: '1',
    packUOM: 'each',
    countUOM: 'each',
    purchasePrice: '',
    abbreviation: '',
    location: '',
  })

  // Load the current inventory item
  useEffect(() => {
    fetch(`/api/inventory/${inventoryItemId}`)
      .then(r => r.json())
      .then((data: InventoryFullItem) => {
        setForm({
          itemName:           data.itemName ?? '',
          category:           data.category ?? 'DRY',
          purchaseUnit:       data.purchaseUnit ?? 'each',
          qtyPerPurchaseUnit: String(data.qtyPerPurchaseUnit ?? 1),
          packSize:           String(data.packSize ?? 1),
          packUOM:            data.packUOM ?? 'each',
          countUOM:           data.countUOM ?? 'each',
          purchasePrice:      String(data.purchasePrice ?? ''),
          abbreviation:       data.abbreviation ?? '',
          location:           data.location ?? '',
        })
        setLoading(false)
      })
      .catch(() => {
        setLoading(false)
        onClose()
      })
  }, [inventoryItemId, onClose])

  const pp   = parseFloat(form.purchasePrice) || 0
  const qty  = parseFloat(form.qtyPerPurchaseUnit) || 1
  const ps   = parseFloat(form.packSize) || 1
  const bu   = deriveBaseUnit(form.packUOM)
  const ppbu = calcPricePerBaseUnit(pp, qty, ps, form.packUOM)

  const handleSave = async () => {
    setSaving(true)
    let res: Response
    try {
      res = await fetch(`/api/inventory/${inventoryItemId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          itemName:           form.itemName,
          category:           form.category,
          purchaseUnit:       form.purchaseUnit,
          qtyPerPurchaseUnit: qty,
          packSize:           ps,
          packUOM:            form.packUOM,
          countUOM:           form.countUOM,
          purchasePrice:      pp,
          abbreviation:       form.abbreviation || null,
          location:           form.location || null,
          pricePerBaseUnit:   ppbu,
          baseUnit:           bu,
          conversionFactor:   calcConversionFactor(form.countUOM, qty, ps, form.packUOM),
        }),
      })
    } catch {
      setSaving(false)
      return
    }
    if (!res.ok) {
      setSaving(false)
      return
    }
    const updatedInv = await res.json()
    setSaving(false)

    // Recalculate scan item price comparison with updated inventory data
    const rawPrice = scanItem.rawUnitPrice !== null ? Number(scanItem.rawUnitPrice) : null
    let newScanPrice: number | null = rawPrice
    let newPriceDiff: number | null = null

    const pq   = scanItem.invoicePackQty  ?? null
    const invPs = scanItem.invoicePackSize ?? null
    const pUOM  = scanItem.invoicePackUOM  ?? null

    if (rawPrice !== null) {
      if (pq && invPs && Number(invPs) > 0 && pUOM) {
        const invoicePPU = rawPrice / (Number(pq) * Number(invPs))
        const updatedInvPkgTotal = Number(updatedInv.qtyPerPurchaseUnit) * Number(updatedInv.packSize)
        const updatedInvPPU = updatedInvPkgTotal > 0 ? Number(updatedInv.purchasePrice) / updatedInvPkgTotal : 0
        const normalized = comparePricesNormalized(
          invoicePPU, pUOM,
          updatedInvPPU, updatedInv.packUOM
        )
        if (normalized) {
          newPriceDiff = normalized.pctDiff
          const calcPrice = calcNewPurchasePrice(
            invoicePPU, pUOM,
            Number(updatedInv.qtyPerPurchaseUnit), Number(updatedInv.packSize), updatedInv.packUOM
          )
          if (calcPrice !== null) newScanPrice = calcPrice
        }
      } else {
        const prevPrice = Number(updatedInv.purchasePrice)
        newPriceDiff = prevPrice > 0 ? Math.round(((rawPrice - prevPrice) / prevPrice) * 10000) / 100 : null
      }
    }

    onSaved({
      previousPrice: String(Number(updatedInv.purchasePrice)),
      newPrice: newScanPrice !== null ? String(newScanPrice) : null,
      priceDiffPct: newPriceDiff !== null ? String(newPriceDiff) : null,
      action: Math.abs(Number(newPriceDiff ?? 0)) > 0.1 ? 'UPDATE_PRICE' : 'ADD_SUPPLIER',
    })
    onClose()
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-[60]" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 z-[70] w-full max-w-md bg-white shadow-xl overflow-y-auto flex flex-col">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-gray-100 px-4 py-3 flex items-center justify-between gap-2">
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wide font-medium">Edit Inventory Item</p>
            <h3 className="font-semibold text-gray-900 text-sm mt-0.5 truncate">{form.itemName || '…'}</h3>
          </div>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 size={24} className="animate-spin text-blue-500" />
          </div>
        ) : (
          <div className="flex-1 p-4 space-y-4">
            {/* Item Name */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Item Name</label>
              <input value={form.itemName} onChange={e => setForm(f => ({ ...f, itemName: e.target.value }))}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>

            {/* Category + Abbreviation */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Category</label>
                <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                  {ITEM_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Abbreviation</label>
                <input value={form.abbreviation} onChange={e => setForm(f => ({ ...f, abbreviation: e.target.value }))}
                  placeholder="optional"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>

            {/* Purchase Structure */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-2">Purchase Structure</label>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Purchase Unit</label>
                  <input value={form.purchaseUnit} onChange={e => setForm(f => ({ ...f, purchaseUnit: e.target.value }))}
                    placeholder="case, bag…"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Qty per case</label>
                  <input type="number" step="any" min="0" value={form.qtyPerPurchaseUnit}
                    onChange={e => setForm(f => ({ ...f, qtyPerPurchaseUnit: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Pack Size</label>
                  <input type="number" step="any" min="0" value={form.packSize}
                    onChange={e => setForm(f => ({ ...f, packSize: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Pack UOM</label>
                  <select value={form.packUOM} onChange={e => setForm(f => ({ ...f, packUOM: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                    {PACK_UOMS.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Purchase Price ($)</label>
                  <input type="number" step="any" min="0" value={form.purchasePrice}
                    onChange={e => setForm(f => ({ ...f, purchasePrice: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Count UOM</label>
                  <select value={form.countUOM} onChange={e => setForm(f => ({ ...f, countUOM: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                    {COUNT_UOMS.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
              </div>
            </div>

            {/* Auto-calculated preview */}
            <div className="bg-green-50 rounded-lg p-3 space-y-1">
              <p className="text-xs font-semibold text-green-700 uppercase tracking-wide">Auto-calculated</p>
              <div className="flex justify-between text-xs">
                <span className="text-green-600">Base unit:</span>
                <span className="font-medium text-green-800">{bu}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-green-600">Price per {bu}:</span>
                <span className="font-medium text-green-800">{formatCurrency(ppbu)}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-green-600">Total base units:</span>
                <span className="font-medium text-green-800">{(qty * ps).toFixed(2)} {bu}</span>
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="sticky bottom-0 bg-white border-t border-gray-100 px-4 py-3 flex gap-2">
          <button
            onClick={handleSave}
            disabled={saving || loading}
            className="flex-1 bg-green-600 text-white rounded-lg py-2 text-sm font-semibold hover:bg-green-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
            {saving ? 'Saving…' : 'Save & Update Prices'}
          </button>
          <button onClick={onClose}
            className="border border-gray-200 text-gray-600 rounded-lg py-2 px-4 text-sm hover:bg-gray-50 transition-colors">
            Cancel
          </button>
        </div>
      </div>
    </>
  )
}

// ── InvoiceImageViewer ────────────────────────────────────────────────────────

function InvoiceImageViewer({ files }: { files: Array<{ id: string; fileName: string; fileType: string; fileUrl: string }> }) {
  const [activeIdx, setActiveIdx] = useState(0)
  const file = files[activeIdx]
  const isPdf = file?.fileType === 'application/pdf' || file?.fileName?.endsWith('.pdf')
  const isImage = file?.fileType?.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif)$/i.test(file?.fileName ?? '')

  return (
    <div className="flex flex-col bg-gray-50 shrink-0" style={{ width: '460px' }}>
      {/* File tabs (only if multiple files) */}
      {files.length > 1 && (
        <div className="flex gap-1 px-3 py-2 border-b border-gray-200 bg-white overflow-x-auto shrink-0">
          {files.map((f, i) => (
            <button
              key={f.id}
              onClick={() => setActiveIdx(i)}
              className={`px-3 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
                activeIdx === i ? 'bg-blue-100 text-blue-700' : 'text-gray-500 hover:bg-gray-100'
              }`}
            >
              Page {i + 1}
            </button>
          ))}
        </div>
      )}

      {/* Image/PDF display */}
      <div className="flex-1 overflow-auto flex items-start justify-center p-4">
        {isImage && file?.fileUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={file.fileUrl}
            alt={file.fileName}
            className="max-w-full rounded-lg shadow-sm border border-gray-200 object-contain"
          />
        ) : isPdf && file?.fileUrl ? (
          <iframe
            src={file.fileUrl}
            title={file.fileName}
            className="w-full rounded-lg border border-gray-200 bg-white"
            style={{ height: '100%', minHeight: '600px' }}
          />
        ) : (
          <div className="flex flex-col items-center justify-center gap-3 text-gray-400 h-full">
            <FileText size={40} className="text-gray-300" />
            <p className="text-sm">{file?.fileName ?? 'No file'}</p>
            {file?.fileUrl && (
              <a href={file.fileUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-500 hover:underline">
                Open file ↗
              </a>
            )}
          </div>
        )}
      </div>

      {/* File name footer */}
      <div className="px-3 py-2 border-t border-gray-200 bg-white shrink-0">
        <p className="text-[10px] text-gray-400 truncate">{file?.fileName}</p>
      </div>
    </div>
  )
}

// ── InvoiceDrawer ─────────────────────────────────────────────────────────────

interface Props {
  sessionId: string | null
  onClose: () => void
  onApproveOrReject: () => void
  allSessions?: SessionSummary[]
}

export function InvoiceDrawer({ sessionId, onClose, onApproveOrReject, allSessions = [] }: Props) {
  const [session, setSession] = useState<Session | null>(null)
  const [approveResult, setApproveResult] = useState<ApproveResult | null>(null)
  const [isApproving, setIsApproving] = useState(false)
  const [isCancelling, setIsCancelling] = useState(false)
  const [approvedBy, setApprovedBy] = useState(() =>
    typeof window !== 'undefined' ? localStorage.getItem('approvedBy') ?? '' : ''
  )
  const [editingItem, setEditingItem] = useState<ScanItem | null>(null)
  const [editingInventory, setEditingInventory] = useState<{ inventoryItemId: string; scanItem: ScanItem } | null>(null)
  const [isAddingItem, setIsAddingItem] = useState(false)
  const [open, setOpen] = useState(false)
  const [mobileTab, setMobileTab] = useState<'review' | 'image'>('review')

  // Editable header fields
  const [editingHeader, setEditingHeader]   = useState(false)
  const [headerNumber,  setHeaderNumber]    = useState('')
  const [headerDate,    setHeaderDate]      = useState('')
  const [headerSubtotal, setHeaderSubtotal] = useState('')
  const [headerTax,      setHeaderTax]      = useState('')
  const [headerTotal,   setHeaderTotal]     = useState('')
  const [savingHeader,  setSavingHeader]    = useState(false)

  const { revenueCenters, activeRcId } = useRc()
  const [sessionRcId, setSessionRcId] = useState<string | null>(null)

  // ── Supplier selector state ─────────────────────────────────────────────────
  const [allSuppliers, setAllSuppliers] = useState<Array<{
    id: string; name: string; aliases: Array<{ id: string; name: string }>
  }>>([])
  const [supplierComboOpen, setSupplierComboOpen] = useState(false)
  const [supplierSearch, setSupplierSearch] = useState('')
  const [linkedSupplierId, setLinkedSupplierId] = useState<string | null>(null)
  const [supplierLinkMode, setSupplierLinkMode] = useState<'auto' | 'manual' | 'none'>('none')
  const [createSupplierOpen, setCreateSupplierOpen] = useState(false)
  const [newSupplierName, setNewSupplierName] = useState('')
  const [savingSupplier, setSavingSupplier] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchSession = useCallback(async (id: string) => {
    const data: Session = await fetch(`/api/invoices/sessions/${id}`).then(r => r.json())
    setSession(data)
    // Sync supplier link state from session
    setLinkedSupplierId(data.supplierId ?? null)
    setSupplierLinkMode(data.supplierId ? 'auto' : 'none')
    setSessionRcId(data.revenueCenterId ?? activeRcId)
    return data
  }, [activeRcId])

  const openHeaderEdit = () => {
    if (!session) return
    setHeaderNumber(session.invoiceNumber ?? '')
    setHeaderDate(session.invoiceDate ?? '')
    setHeaderSubtotal(session.subtotal ? String(Number(session.subtotal)) : '')
    setHeaderTax(session.tax ? String(Number(session.tax)) : '')
    setHeaderTotal(session.total ? String(Number(session.total)) : '')
    setEditingHeader(true)
  }

  const saveHeader = async () => {
    if (!session) return
    setSavingHeader(true)
    await fetch(`/api/invoices/sessions/${session.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        invoiceNumber: headerNumber.trim() || null,
        invoiceDate:   headerDate || null,
        subtotal:      headerSubtotal ? parseFloat(headerSubtotal) : null,
        tax:           headerTax      ? parseFloat(headerTax)      : null,
        total:         headerTotal    ? parseFloat(headerTotal)    : null,
      }),
    })
    await fetchSession(session.id)
    setSavingHeader(false)
    setEditingHeader(false)
  }

  // Fetch session when sessionId changes
  useEffect(() => {
    if (sessionId) {
      setOpen(true)
      setApproveResult(null)
      fetchSession(sessionId)
    } else {
      setOpen(false)
      // Give animation time to complete before clearing session
      const t = setTimeout(() => setSession(null), 200)
      return () => clearTimeout(t)
    }
  }, [sessionId, fetchSession])

  // Poll while processing
  useEffect(() => {
    if (session?.status === 'PROCESSING') {
      pollRef.current = setInterval(async () => {
        const s = await fetchSession(session.id)
        if (s.status !== 'PROCESSING') {
          if (pollRef.current) clearInterval(pollRef.current)
        }
      }, 2000)
    } else {
      if (pollRef.current) clearInterval(pollRef.current)
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [session?.status, session?.id, fetchSession])

  const updateScanItem = async (itemId: string, updates: Partial<Omit<ScanItem, 'newItemData'> & { newItemData?: Record<string, unknown> | string | null }>) => {
    if (!session) return
    await fetch(`/api/invoices/sessions/${session.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scanItemId: itemId, ...updates }),
    })
    await fetchSession(session.id)
  }

  const handleApproveAll = async () => {
    if (!session) return
    setIsApproving(true)
    const res = await fetch(`/api/invoices/sessions/${session.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approvedBy: approvedBy || 'Manager' }),
    })
    const result = await res.json()
    setApproveResult(result)
    setIsApproving(false)
    onApproveOrReject()
  }

  const handleReject = async () => {
    if (!session) return
    await fetch(`/api/invoices/sessions/${session.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'REJECTED' }),
    })
    onApproveOrReject()
    onClose()
  }

  const handleCancelProcessing = async () => {
    if (!session) return
    setIsCancelling(true)
    await fetch(`/api/invoices/sessions/${session.id}/process`, { method: 'DELETE' })
    await fetchSession(session.id)
    setIsCancelling(false)
  }

  const handleAddItem = async (desc: string, qty: number | null, unitPrice: number | null) => {
    if (!session || !desc.trim()) return
    await fetch(`/api/invoices/sessions/${session.id}/scanitems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: desc, qty, unitPrice }),
    })
    await fetchSession(session.id)
    setIsAddingItem(false)
  }

  const loadSuppliers = async () => {
    if (allSuppliers.length > 0) return
    const res = await fetch('/api/suppliers')
    if (res.ok) {
      const data = await res.json()
      setAllSuppliers(data)
    }
  }

  const handleLinkSupplier = async (supplierId: string) => {
    if (!session) return
    setSupplierComboOpen(false)
    setLinkedSupplierId(supplierId)
    setSupplierLinkMode('manual')
    await fetch(`/api/invoices/sessions/${session.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ supplierId }),
    })
  }

  const handleCreateAndLinkSupplier = async () => {
    const name = newSupplierName.trim()
    if (!name || !session) return
    setSavingSupplier(true)
    try {
      const res = await fetch('/api/suppliers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) throw new Error('Failed to create supplier')
      const newSupplier = await res.json()
      setAllSuppliers(prev => [...prev, { ...newSupplier, aliases: newSupplier.aliases ?? [] }])
      await handleLinkSupplier(newSupplier.id)
      setCreateSupplierOpen(false)
      setNewSupplierName('')
    } catch {
      alert('Failed to create supplier. Please try again.')
    } finally {
      setSavingSupplier(false)
    }
  }

  // Determine drawer state
  const drawerState: 'loading' | 'processing' | 'review' | 'done' =
    approveResult ? 'done'
    : !session ? 'loading'
    : session.status === 'PROCESSING' ? 'processing'
    : session.status === 'REVIEW' ? 'review'
    : (session.status === 'APPROVED' || session.status === 'REJECTED') ? 'done'
    : 'loading'

  const isReview = drawerState === 'review'

  if (!sessionId && !open && !session) return null

  // ── renderProcessing ────────────────────────────────────────────────────────

  const renderProcessing = () => (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-xl mx-auto space-y-6 text-center">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-blue-100 animate-pulse mb-2">
          <ScanLine size={32} className="text-blue-600" />
        </div>
        <h2 className="text-xl font-bold text-gray-900">Scanning Invoice…</h2>
        <p className="text-sm text-gray-500">
          {session?.files && session.files.length > 1
            ? `Sending all ${session.files.length} pages to Claude at once — usually 15–30 seconds.`
            : 'Claude is reading and extracting line items. Usually 10–20 seconds.'}
        </p>

        <div className="bg-white rounded-xl border border-gray-100 divide-y divide-gray-50 text-left">
          {session?.files.map(f => (
            <div key={f.id} className="flex items-center gap-3 px-4 py-3">
              {fileIcon(f.fileType)}
              <span className="flex-1 text-sm text-gray-700 truncate">{f.fileName}</span>
              {ocrStatusBadge(f.ocrStatus)}
            </div>
          ))}
        </div>

        <div className="flex items-center justify-center gap-3">
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <Loader2 size={14} className="animate-spin" />
            Processing…
          </div>
          <button
            onClick={handleCancelProcessing}
            disabled={isCancelling}
            className="flex items-center gap-1.5 text-sm text-red-500 hover:text-red-700 border border-red-200 hover:border-red-400 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50"
          >
            {isCancelling ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />}
            {isCancelling ? 'Cancelling…' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  )

  // ── renderReview ────────────────────────────────────────────────────────────

  const renderReview = () => {
    if (!session) return null

    const actionCounts = session.scanItems.reduce(
      (acc, item) => { acc[item.action] = (acc[item.action] || 0) + 1; return acc },
      {} as Record<string, number>
    )
    const totalItems = session.scanItems.length
    const skipCount = actionCounts['SKIP'] || 0
    const activeItems = totalItems - skipCount

    // Invoice total validation
    const WVSET = new Set(['kg', 'g', 'lb', 'oz', 'l', 'ml'])
    const scannedTotal = session.scanItems
      .filter(i => i.action !== 'SKIP')
      .reduce((sum, i) => {
        let lt: number
        if (i.rawLineTotal !== null) {
          lt = Number(i.rawLineTotal)
        } else if (i.rawQty !== null && i.rawUnitPrice !== null) {
          const wv = !!i.invoicePackUOM && WVSET.has(i.invoicePackUOM.toLowerCase())
          lt = wv && i.invoicePackQty && i.invoicePackSize
            ? Number(i.rawQty) * Number(i.invoicePackQty) * Number(i.invoicePackSize) * Number(i.rawUnitPrice)
            : Number(i.rawQty) * Number(i.rawUnitPrice)
        } else {
          lt = 0
        }
        return sum + lt
      }, 0)
    const invoiceTotal = session.total ? Number(session.total) : null

    // Duplicate invoice number detection
    const duplicateSessions = session.invoiceNumber
      ? (allSessions as Array<{ id: string; status: string; invoiceNumber: string | null; invoiceDate: string | null; supplierName: string | null }>)
          .filter(s => s.id !== session.id && s.invoiceNumber === session.invoiceNumber)
      : []

    return (
      <div className="flex-1 overflow-y-auto">
        <div className="p-4 space-y-4">

          {/* ── Invoice document ── */}
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">

            {/* Invoice header band */}
            <div className="bg-gradient-to-r from-slate-700 to-slate-800 px-5 py-4 text-white">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-0.5">Invoice Review</p>
                  <h2 className="text-lg font-bold leading-tight truncate">{session.supplierName || 'Unknown Supplier'}</h2>
                </div>
                <div className="text-right shrink-0 flex flex-col items-end gap-1">
                  {session.invoiceNumber && !editingHeader && (
                    <div className="flex items-center gap-1 justify-end text-slate-300 text-xs">
                      <Hash size={10} /><span className="font-mono font-semibold text-white">{session.invoiceNumber}</span>
                    </div>
                  )}
                  {session.total && !editingHeader && (
                    <div className="text-xl font-bold text-white">{formatCurrency(Number(session.total))}</div>
                  )}
                  {(session.subtotal || session.tax) && !editingHeader && (
                    <div className="flex items-center gap-2 text-[10px] text-slate-400">
                      {session.subtotal && <span>Sub: {formatCurrency(Number(session.subtotal))}</span>}
                      {session.tax && <span>Tax: {formatCurrency(Number(session.tax))}</span>}
                    </div>
                  )}
                  {!editingHeader && (
                    <button
                      onClick={openHeaderEdit}
                      className="mt-1 flex items-center gap-1 text-slate-400 hover:text-white text-[10px] transition-colors"
                    >
                      <Pencil size={10} /> Edit details
                    </button>
                  )}
                </div>
              </div>

              {/* Editable header form */}
              {editingHeader ? (
                <div className="mt-3 space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[10px] text-slate-400 mb-0.5 font-semibold uppercase tracking-wide">Invoice #</label>
                      <input
                        value={headerNumber}
                        onChange={e => setHeaderNumber(e.target.value)}
                        placeholder="e.g. INV-1234"
                        className="w-full bg-slate-600/60 border border-slate-500 rounded-lg px-2 py-1.5 text-sm text-white placeholder-slate-400 focus:outline-none focus:border-blue-400"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] text-slate-400 mb-0.5 font-semibold uppercase tracking-wide">Date</label>
                      <input
                        type="date"
                        value={headerDate}
                        onChange={e => setHeaderDate(e.target.value)}
                        className="w-full bg-slate-600/60 border border-slate-500 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-blue-400"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[10px] text-slate-400 mb-0.5 font-semibold uppercase tracking-wide">Subtotal ($)</label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={headerSubtotal}
                        onChange={e => setHeaderSubtotal(e.target.value)}
                        placeholder="0.00"
                        className="w-full bg-slate-600/60 border border-slate-500 rounded-lg px-2 py-1.5 text-sm text-white placeholder-slate-400 focus:outline-none focus:border-blue-400"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] text-slate-400 mb-0.5 font-semibold uppercase tracking-wide">Tax ($)</label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={headerTax}
                        onChange={e => setHeaderTax(e.target.value)}
                        placeholder="0.00"
                        className="w-full bg-slate-600/60 border border-slate-500 rounded-lg px-2 py-1.5 text-sm text-white placeholder-slate-400 focus:outline-none focus:border-blue-400"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-400 mb-0.5 font-semibold uppercase tracking-wide">Invoice Total ($)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={headerTotal}
                      onChange={e => setHeaderTotal(e.target.value)}
                      placeholder="0.00"
                      className="w-full bg-slate-600/60 border border-slate-500 rounded-lg px-2 py-1.5 text-sm text-white placeholder-slate-400 focus:outline-none focus:border-blue-400"
                    />
                  </div>
                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={() => setEditingHeader(false)}
                      className="flex-1 py-1.5 rounded-lg text-xs font-medium text-slate-300 hover:text-white border border-slate-600 hover:border-slate-400 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={saveHeader}
                      disabled={savingHeader}
                      className="flex-[2] py-1.5 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50 transition-colors"
                    >
                      {savingHeader ? 'Saving…' : 'Save changes'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-5 mt-3 text-xs">
                  {session.invoiceDate && (
                    <div className="flex items-center gap-1 text-slate-300">
                      <CalendarDays size={11} />
                      <span>{session.invoiceDate}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-1 text-slate-300">
                    <Package size={11} />
                    <span>{totalItems} line item{totalItems !== 1 ? 's' : ''}</span>
                  </div>
                  {actionCounts['UPDATE_PRICE'] > 0 && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/20 text-amber-200 border border-amber-400/30">
                      {actionCounts['UPDATE_PRICE']} price update{actionCounts['UPDATE_PRICE'] !== 1 ? 's' : ''}
                    </span>
                  )}
                  {actionCounts['CREATE_NEW'] > 0 && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-purple-500/20 text-purple-200 border border-purple-400/30">
                      {actionCounts['CREATE_NEW']} new item{actionCounts['CREATE_NEW'] !== 1 ? 's' : ''}
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* ── Supplier strip ── */}
            {(() => {
              const linked = allSuppliers.find(s => s.id === linkedSupplierId)
              const ocrName = session.supplierName

              return (
                <div className="border-b border-gray-100">
                  {linkedSupplierId && linked ? (
                    <div className="flex items-center gap-3 px-4 py-2 bg-green-50">
                      <Building2 size={14} className="text-green-600 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-semibold text-gray-900">{linked.name}</span>
                        <span className="ml-2 text-xs text-gray-400">
                          {supplierLinkMode === 'auto' ? '✓ auto-matched' : '(linked)'}
                        </span>
                      </div>
                      <button
                        onClick={() => { loadSuppliers(); setSupplierComboOpen(true) }}
                        className="text-xs text-blue-600 hover:text-blue-800 shrink-0 flex items-center gap-0.5"
                      >
                        Change <ChevronDown size={12} />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 px-4 py-2 bg-amber-50">
                      <AlertTriangle size={14} className="text-amber-500 shrink-0" />
                      <p className="flex-1 min-w-0 text-xs text-gray-700 truncate">
                        {ocrName
                          ? <><span className="font-mono font-semibold">&ldquo;{ocrName}&rdquo;</span> — link to a supplier</>
                          : 'No supplier detected — link to a supplier'}
                      </p>
                      <button
                        onClick={() => { loadSuppliers(); setSupplierComboOpen(true) }}
                        className="text-xs font-semibold text-blue-600 hover:text-blue-800 shrink-0 flex items-center gap-0.5"
                      >
                        Link <ArrowRight size={12} />
                      </button>
                    </div>
                  )}

                  {supplierComboOpen && (
                    <div className="bg-white border border-gray-200 rounded-lg shadow-lg mx-4 mb-2 overflow-hidden">
                      <input
                        autoFocus
                        value={supplierSearch}
                        onChange={e => setSupplierSearch(e.target.value)}
                        placeholder="Search suppliers…"
                        className="w-full px-3 py-2 text-sm border-b border-gray-100 focus:outline-none"
                      />
                      <div className="max-h-48 overflow-y-auto">
                        {allSuppliers
                          .filter(s => {
                            const q = supplierSearch.toLowerCase()
                            return (
                              s.name.toLowerCase().includes(q) ||
                              s.aliases?.some(a => a.name.toLowerCase().includes(q))
                            )
                          })
                          .map(s => (
                            <button
                              key={s.id}
                              onClick={() => handleLinkSupplier(s.id)}
                              className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 transition-colors"
                            >
                              <span className="font-medium text-gray-900">{s.name}</span>
                              {s.aliases && s.aliases.length > 0 && (
                                <span className="ml-2 text-xs text-gray-400 font-mono">
                                  {s.aliases.length} alias{s.aliases.length !== 1 ? 'es' : ''}
                                </span>
                              )}
                            </button>
                          ))
                        }
                        <button
                          onClick={() => {
                            setNewSupplierName(session.supplierName ?? '')
                            setCreateSupplierOpen(true)
                            setSupplierComboOpen(false)
                          }}
                          className="w-full text-left px-3 py-2 text-sm text-blue-600 hover:bg-blue-50 border-t border-gray-100 font-semibold transition-colors"
                        >
                          + Create &ldquo;{session.supplierName || 'new supplier'}&rdquo; as new supplier
                        </button>
                      </div>
                      <button
                        onClick={() => setSupplierComboOpen(false)}
                        className="w-full py-1.5 text-xs text-gray-400 hover:bg-gray-50 border-t border-gray-100"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              )
            })()}

            {/* RC selector strip */}
            {revenueCenters.length > 1 && (
              <div className="flex items-center gap-3 px-4 py-2 border-b border-gray-100 bg-gray-50">
                <span className="text-xs text-gray-500 shrink-0">Revenue Center:</span>
                <select
                  value={sessionRcId ?? ''}
                  onChange={async e => {
                    const rcId = e.target.value
                    setSessionRcId(rcId)
                    await fetch(`/api/invoices/sessions/${session.id}`, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ revenueCenterId: rcId }),
                    })
                  }}
                  className="text-xs border border-gray-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white"
                >
                  {revenueCenters.map(rc => (
                    <option key={rc.id} value={rc.id}>{rc.name}</option>
                  ))}
                </select>
                {sessionRcId && revenueCenters.find(rc => rc.id === sessionRcId) && (
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: rcHex(revenueCenters.find(rc => rc.id === sessionRcId)!.color) }}
                  />
                )}
              </div>
            )}

            {/* Duplicate invoice warning */}
            {duplicateSessions.length > 0 && (
              <div className="flex items-start gap-2 px-4 py-2.5 bg-red-50 border-b border-red-200">
                <AlertTriangle size={14} className="text-red-500 mt-0.5 shrink-0" />
                <div className="text-xs text-red-700">
                  <span className="font-semibold">Possible duplicate.</span>{' '}
                  Invoice #{session.invoiceNumber} was already scanned
                  {duplicateSessions[0].invoiceDate ? ` on ${duplicateSessions[0].invoiceDate}` : ''}
                  {duplicateSessions[0].supplierName ? ` from ${duplicateSessions[0].supplierName}` : ''}{' '}
                  <span className={`font-semibold ${
                    duplicateSessions[0].status === 'APPROVED' ? 'text-green-700' :
                    duplicateSessions[0].status === 'REJECTED' ? 'text-red-700' : 'text-amber-700'
                  }`}>({duplicateSessions[0].status.toLowerCase()})</span>.
                  Review carefully before approving.
                </div>
              </div>
            )}

            {/* Total validation bar */}
            {(invoiceTotal !== null || scannedTotal > 0) && (() => {
              const ocrSubtotal = session.subtotal ? Number(session.subtotal) : null
              const ocrTax      = session.tax      ? Number(session.tax)      : null
              // Match scanned against subtotal (before tax) when available, otherwise against total
              const compareTarget = ocrSubtotal ?? invoiceTotal
              const subtotalDiff  = compareTarget !== null ? compareTarget - scannedTotal : null
              const subtotalIsOk  = subtotalDiff !== null && Math.abs(subtotalDiff) < 0.50
              const subtotalIsOver= subtotalDiff !== null && subtotalDiff < -0.50
              return (
                <div className={`flex items-center gap-2 px-4 py-2 border-b text-xs ${
                  subtotalIsOver ? 'bg-red-50 border-red-200' :
                  subtotalIsOk   ? 'bg-green-50 border-green-200' :
                                   'bg-gray-50 border-gray-200'
                }`}>
                  <div className="flex items-center gap-2 flex-1 flex-wrap">
                    <span className="text-gray-500">Scanned:</span>
                    <span className={`font-bold ${subtotalIsOver ? 'text-red-700' : 'text-gray-800'}`}>{formatCurrency(scannedTotal)}</span>
                    {ocrSubtotal !== null && (
                      <>
                        <span className="text-gray-300">·</span>
                        <span className="text-gray-500">Subtotal:</span>
                        <span className="font-bold text-gray-800">{formatCurrency(ocrSubtotal)}</span>
                      </>
                    )}
                    {ocrTax !== null && (
                      <>
                        <span className="text-gray-300">·</span>
                        <span className="text-gray-500">Tax:</span>
                        <span className="font-bold text-gray-800">{formatCurrency(ocrTax)}</span>
                      </>
                    )}
                    {invoiceTotal !== null && (
                      <>
                        <span className="text-gray-300">·</span>
                        <span className="text-gray-500">{ocrSubtotal ? 'Total:' : 'Invoice total:'}</span>
                        <span className="font-bold text-gray-800">{formatCurrency(invoiceTotal)}</span>
                      </>
                    )}
                    {subtotalDiff !== null && !subtotalIsOk && (
                      <>
                        <span className="text-gray-300">·</span>
                        <span className={`font-medium ${subtotalIsOver ? 'text-red-600' : 'text-gray-400'}`}>
                          {subtotalIsOver
                            ? `⚠ Items exceed by ${formatCurrency(Math.abs(subtotalDiff))}`
                            : ocrSubtotal
                              ? `${formatCurrency(subtotalDiff)} unscanned`
                              : `${formatCurrency(subtotalDiff)} in taxes/fees`}
                        </span>
                      </>
                    )}
                  </div>
                  {subtotalIsOk && <span className="text-green-600 font-semibold">✓ Match</span>}
                </div>
              )
            })()}

            {/* Line items */}
            <div className="divide-y divide-gray-50">
              {session.scanItems.map(item => (
                <div key={item.id} className="px-3 py-0.5">
                  <ScanItemCard
                    item={item}
                    onUpdate={(updates) => updateScanItem(item.id, updates)}
                    onOpenDetail={() => setEditingItem(item)}
                    onEditInventory={(invId, scanItem) => setEditingInventory({ inventoryItemId: invId, scanItem })}
                    revenueCenters={revenueCenters}
                    sessionRcId={sessionRcId}
                    onRcChange={(rcId) => updateScanItem(item.id, { revenueCenterId: rcId })}
                  />
                </div>
              ))}
              {session.scanItems.length === 0 && (
                <div className="py-8 text-center text-sm text-gray-400">
                  {session.files?.some(f => f.ocrStatus === 'ERROR')
                    ? <span className="text-red-500">OCR failed — the invoice couldn&apos;t be read. Check the image quality and try scanning again.</span>
                    : 'No items scanned yet — add line items manually or start a new scan.'}
                </div>
              )}
            </div>

            {/* Add line item row */}
            <div className="px-4 py-3 border-t border-gray-100 bg-gray-50">
              <button
                onClick={() => setIsAddingItem(true)}
                className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-800 font-medium transition-colors"
              >
                <Plus size={15} className="border border-blue-300 rounded" /> Add line item manually
              </button>
            </div>

            {/* Invoice totals footer */}
            {(scannedTotal > 0 || invoiceTotal !== null) && (() => {
              const ocrSub = session.subtotal ? Number(session.subtotal) : null
              const ocrTax = session.tax      ? Number(session.tax)      : null
              const taxLine = ocrTax ?? (invoiceTotal !== null ? invoiceTotal - scannedTotal : null)
              return (
                <div className="px-5 py-4 bg-gray-50 border-t border-gray-200">
                  <div className="flex flex-col items-end gap-1 text-sm">
                    <div className="flex items-center gap-6">
                      <span className="text-gray-500">Subtotal (scanned items)</span>
                      <span className="font-semibold text-gray-800 w-24 text-right">{formatCurrency(scannedTotal)}</span>
                    </div>
                    {ocrSub !== null && Math.abs(ocrSub - scannedTotal) > 0.01 && (
                      <div className="flex items-center gap-6 text-gray-400 text-xs">
                        <span>Invoice subtotal</span>
                        <span className="w-24 text-right">{formatCurrency(ocrSub)}</span>
                      </div>
                    )}
                    {taxLine !== null && taxLine > 0.01 && (
                      <div className="flex items-center gap-6 text-gray-400">
                        <span>Taxes &amp; fees</span>
                        <span className="w-24 text-right">{formatCurrency(taxLine)}</span>
                      </div>
                    )}
                    {invoiceTotal !== null && (
                      <div className="flex items-center gap-6 border-t border-gray-200 pt-1 mt-1">
                        <span className="font-bold text-gray-700">Invoice Total</span>
                        <span className="font-bold text-gray-900 w-24 text-right">{formatCurrency(invoiceTotal)}</span>
                      </div>
                    )}
                  </div>
                </div>
              )
            })()}
          </div>
        </div>

        {/* Sticky approve bar */}
        <div className="sticky bottom-0 bg-white border-t border-gray-200 px-4 py-3 flex flex-col sm:flex-row items-center gap-3">
          <div className="flex-1 flex items-center gap-2 flex-wrap">
            <span className="text-sm text-gray-500">{activeItems} items to apply</span>
            {actionCounts['UPDATE_PRICE'] > 0 && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-100 text-blue-700 border border-blue-200">
                {actionCounts['UPDATE_PRICE']} price update{actionCounts['UPDATE_PRICE'] !== 1 ? 's' : ''}
              </span>
            )}
            {actionCounts['CREATE_NEW'] > 0 && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-purple-100 text-purple-700 border border-purple-200">
                {actionCounts['CREATE_NEW']} new item{actionCounts['CREATE_NEW'] !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Your name"
              value={approvedBy}
              onChange={e => { setApprovedBy(e.target.value); localStorage.setItem('approvedBy', e.target.value) }}
              className={`border rounded-lg px-3 py-1.5 text-sm w-36 focus:outline-none focus:ring-2 focus:ring-blue-500 ${!approvedBy ? 'border-amber-300 bg-amber-50' : 'border-gray-200'}`}
            />
            <button
              onClick={handleReject}
              disabled={isApproving}
              className="border border-red-500 text-red-600 rounded-lg px-4 py-2 text-sm font-semibold flex items-center gap-2 hover:bg-red-50 disabled:opacity-50 transition-colors"
            >
              Reject
            </button>
            <button
              onClick={handleApproveAll}
              disabled={isApproving}
              className="bg-green-600 text-white rounded-lg px-4 py-2 text-sm font-semibold flex items-center gap-2 hover:bg-green-700 disabled:opacity-50 transition-colors"
            >
              {isApproving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
              {isApproving ? 'Approving…' : 'Approve & Apply'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── renderDone ──────────────────────────────────────────────────────────────

  const renderDone = () => {
    // If we just approved, show results
    if (approveResult) {
      return (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-xl mx-auto space-y-6 text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-green-100 mb-2">
              <CheckCircle2 size={32} className="text-green-600" />
            </div>
            <h2 className="text-xl font-bold text-gray-900">Invoice Applied!</h2>
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: 'Prices Updated', value: approveResult.itemsUpdated, icon: <Package size={20} className="text-blue-500" />, color: 'blue' },
                { label: 'Items Created', value: approveResult.newItemsCreated, icon: <Plus size={20} className="text-purple-500" />, color: 'purple' },
                { label: 'Price Alerts', value: approveResult.priceAlerts, icon: <TrendingUp size={20} className="text-amber-500" />, color: 'amber' },
                { label: 'Recipe Alerts', value: approveResult.recipeAlerts, icon: <ClipboardList size={20} className="text-red-500" />, color: 'red' },
              ].map(({ label, value, icon }) => (
                <div key={label} className="bg-white rounded-xl border border-gray-100 p-4 flex flex-col items-center gap-2">
                  {icon}
                  <div className="text-2xl font-bold text-gray-900">{value}</div>
                  <div className="text-xs text-gray-500">{label}</div>
                </div>
              ))}
            </div>
            {(approveResult.priceAlerts > 0 || approveResult.recipeAlerts > 0) && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-center gap-2 text-sm text-amber-800">
                <Bell size={16} className="shrink-0" />
                {approveResult.priceAlerts + approveResult.recipeAlerts} alert(s) generated — check the bell icon in the header
              </div>
            )}
            <button
              onClick={onClose}
              className="w-full bg-blue-600 text-white rounded-xl py-3 font-semibold flex items-center justify-center gap-2 hover:bg-blue-700 transition-colors"
            >
              <ScanLine size={18} /> Close
            </button>
          </div>
        </div>
      )
    }

    // Opened from list — session is APPROVED or REJECTED
    const isApproved = session?.status === 'APPROVED'

    if (!isApproved || !session) {
      // Simple view for REJECTED (or unknown status)
      const isRejected = session?.status === 'REJECTED'
      return (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-xl mx-auto space-y-6 text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-2 bg-red-100">
              <AlertCircle size={32} className="text-red-500" />
            </div>
            <h2 className="text-xl font-bold text-gray-900">
              {isRejected ? 'Invoice Rejected' : 'Invoice'}
            </h2>
            {session && (
              <div className="bg-white rounded-xl border border-gray-100 p-4 text-left space-y-2 text-sm">
                {session.supplierName && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">Supplier</span>
                    <span className="font-medium text-gray-900">{session.supplierName}</span>
                  </div>
                )}
                {session.invoiceNumber && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">Invoice #</span>
                    <span className="font-mono font-medium text-gray-900">{session.invoiceNumber}</span>
                  </div>
                )}
                {session.invoiceDate && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">Date</span>
                    <span className="font-medium text-gray-900">{session.invoiceDate}</span>
                  </div>
                )}
                {session.total && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">Total</span>
                    <span className="font-bold text-gray-900">{formatCurrency(Number(session.total))}</span>
                  </div>
                )}
              </div>
            )}
            <button
              onClick={onClose}
              className="w-full border border-gray-200 text-gray-600 rounded-xl py-3 font-semibold hover:bg-gray-50 transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      )
    }

    // Full read-only view for APPROVED sessions
    const visibleItems = session.scanItems.filter(si => si.action !== 'SKIP')
    const skippedItems = session.scanItems.filter(si => si.action === 'SKIP')

    const actionBadge = (action: string, isNewItem: boolean) => {
      if (action === 'UPDATE_PRICE') return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-100 text-blue-700 border border-blue-200">price update</span>
      )
      if (action === 'CREATE_NEW' || isNewItem) return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-purple-100 text-purple-700 border border-purple-200">new item</span>
      )
      if (action === 'ADD_SUPPLIER') return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700 border border-amber-200">supplier added</span>
      )
      return null
    }

    return (
      <div className="flex-1 overflow-y-auto flex flex-col">
        {/* Header band */}
        <div className="bg-gradient-to-r from-slate-700 to-slate-800 px-5 py-4 text-white shrink-0">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-0.5">Approved Invoice</p>
              <h2 className="text-lg font-bold leading-tight truncate">{session.supplierName || 'Unknown Supplier'}</h2>
            </div>
            <div className="text-right shrink-0 flex flex-col items-end gap-1">
              {session.invoiceNumber && (
                <div className="flex items-center gap-1 justify-end text-slate-300 text-xs">
                  <Hash size={10} /><span className="font-mono font-semibold text-white">{session.invoiceNumber}</span>
                </div>
              )}
              {session.total && (
                <div className="text-xl font-bold text-white">{formatCurrency(Number(session.total))}</div>
              )}
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-green-500/20 text-green-300 border border-green-400/30">
                <CheckCircle2 size={10} className="mr-1" />Approved
              </span>
            </div>
          </div>
          <div className="flex items-center gap-5 mt-3 text-xs">
            {session.invoiceDate && (
              <div className="flex items-center gap-1 text-slate-300">
                <CalendarDays size={11} />
                <span>{session.invoiceDate}</span>
              </div>
            )}
            <div className="flex items-center gap-1 text-slate-300">
              <Package size={11} />
              <span>{visibleItems.length} line item{visibleItems.length !== 1 ? 's' : ''}</span>
            </div>
          </div>
        </div>

        {/* Line items */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="space-y-1">
            {visibleItems.map(si => (
              <div key={si.id} className="bg-white border border-gray-100 rounded-xl px-4 py-3 flex flex-col gap-1.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-gray-400 truncate">{si.rawDescription}</p>
                    <p className="text-sm font-semibold text-gray-900 truncate">
                      {si.matchedItem ? si.matchedItem.itemName : <span className="text-gray-400 italic">Unmatched</span>}
                    </p>
                  </div>
                  <div className="shrink-0">
                    {actionBadge(si.action, si.isNewItem)}
                  </div>
                </div>
                <div className="flex items-center gap-4 text-xs text-gray-500">
                  {si.rawQty != null && (
                    <span>Qty: <span className="font-medium text-gray-700">{si.rawQty}</span></span>
                  )}
                  {si.rawUnitPrice != null && (
                    <span>Unit: <span className="font-medium text-gray-700">{formatCurrency(Number(si.rawUnitPrice))}</span></span>
                  )}
                  {si.rawLineTotal != null && (
                    <span className="ml-auto font-semibold text-gray-900">{formatCurrency(Number(si.rawLineTotal))}</span>
                  )}
                </div>
              </div>
            ))}
          </div>

          {skippedItems.length > 0 && (
            <details className="group">
              <summary className="cursor-pointer text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1 select-none">
                <ChevronRight size={12} className="group-open:rotate-90 transition-transform" />
                Skipped items ({skippedItems.length})
              </summary>
              <div className="mt-2 space-y-1 pl-4">
                {skippedItems.map(si => (
                  <div key={si.id} className="bg-gray-50 border border-gray-100 rounded-lg px-3 py-2">
                    <p className="text-xs text-gray-400 truncate">{si.rawDescription}</p>
                  </div>
                ))}
              </div>
            </details>
          )}

          {/* Alerts section */}
          <div className="space-y-3 pt-2">
            <h3 className="text-xs font-bold text-gray-500 uppercase tracking-widest flex items-center gap-2">
              <Bell size={12} />Alerts
            </h3>

            {session.priceAlerts.length === 0 && session.recipeAlerts.length === 0 ? (
              <p className="text-xs text-gray-400 italic">No alerts generated</p>
            ) : (
              <>
                {session.priceAlerts.map(alert => {
                  const pct = Number(alert.changePct)
                  const isUp = alert.direction === 'UP'
                  return (
                    <div key={alert.id} className="bg-white border border-gray-100 rounded-xl px-4 py-3 flex items-center justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-gray-900 truncate">{alert.inventoryItem.itemName}</p>
                        <p className="text-xs text-gray-500">
                          {formatCurrency(Number(alert.previousPrice))} → {formatCurrency(Number(alert.newPrice))}
                        </p>
                      </div>
                      <div className={`flex items-center gap-1 text-sm font-bold shrink-0 ${isUp ? 'text-red-500' : 'text-green-600'}`}>
                        {isUp ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                        {isUp ? '+' : '-'}{Math.abs(pct).toFixed(1)}%
                      </div>
                    </div>
                  )
                })}

                {session.recipeAlerts.map(alert => {
                  const pct = Number(alert.changePct)
                  const isUp = pct > 0
                  return (
                    <div key={alert.id} className="bg-white border border-gray-100 rounded-xl px-4 py-3 flex items-center justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1">
                          <p className="text-sm font-semibold text-gray-900 truncate">{alert.recipe.name}</p>
                          {alert.exceededThreshold && <AlertCircle size={13} className="text-red-500 shrink-0" />}
                        </div>
                        <p className="text-xs text-gray-500">
                          {formatCurrency(Number(alert.previousCost))} → {formatCurrency(Number(alert.newCost))}
                          {alert.newFoodCostPct != null && (
                            <span className="ml-1 text-gray-400">· food cost {Number(alert.newFoodCostPct).toFixed(1)}%</span>
                          )}
                        </p>
                      </div>
                      <div className={`flex items-center gap-1 text-sm font-bold shrink-0 ${isUp ? 'text-red-500' : 'text-green-600'}`}>
                        {isUp ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                        {isUp ? '+' : '-'}{Math.abs(pct).toFixed(1)}%
                      </div>
                    </div>
                  )
                })}
              </>
            )}
          </div>
        </div>

        {/* Footer: Review Again button */}
        <div className="shrink-0 border-t border-gray-100 p-4">
          <button
            onClick={async () => {
              setIsApproving(true)
              try {
                await fetch(`/api/invoices/sessions/${session.id}`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ status: 'REVIEW' }),
                })
                onApproveOrReject()
              } finally {
                setIsApproving(false)
              }
            }}
            disabled={isApproving}
            className="w-full bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white rounded-xl py-3 font-semibold flex items-center justify-center gap-2 transition-colors"
          >
            {isApproving ? <Loader2 size={16} className="animate-spin" /> : <RotateCcw size={16} />}
            {isApproving ? 'Reverting…' : 'Review Again'}
          </button>
        </div>
      </div>
    )
  }

  // ── Drawer layout ───────────────────────────────────────────────────────────

  return (
    <>
      {/* ── Create New Supplier Modal ─────────────────────────────────── */}
      {createSupplierOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/40">
          <div className="bg-white rounded-2xl p-5 w-full max-w-sm shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold text-gray-900">Create New Supplier</h3>
              <button onClick={() => setCreateSupplierOpen(false)} className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100">
                <X size={14} />
              </button>
            </div>
            <p className="text-xs text-gray-500 mb-3">
              A new supplier will be created and this invoice will be linked to it.
              The OCR name will be saved as an alias for future auto-matching.
            </p>
            <label className="block text-xs font-medium text-gray-600 mb-1">Supplier Name *</label>
            <input
              autoFocus
              value={newSupplierName}
              onChange={e => setNewSupplierName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCreateAndLinkSupplier() }}
              placeholder="e.g. Legends Haul"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mb-3"
            />
            <div className="flex gap-2">
              <button
                onClick={() => setCreateSupplierOpen(false)}
                className="flex-1 border border-gray-200 rounded-lg py-2 text-sm hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateAndLinkSupplier}
                disabled={savingSupplier || !newSupplierName.trim()}
                className="flex-1 bg-blue-600 text-white rounded-lg py-2 text-sm font-semibold hover:bg-blue-700 disabled:opacity-50"
              >
                {savingSupplier ? 'Creating…' : 'Create & Link'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/40"
        onClick={onClose}
        style={{ opacity: open ? 1 : 0, transition: 'opacity 150ms ease-out' }}
      />

      {/* Desktop: right-side drawer */}
      <div
        className={`hidden sm:flex fixed top-0 right-0 h-full z-50 bg-white shadow-2xl flex-col transition-all duration-150 ease-out ${isReview ? 'w-[960px]' : drawerState === 'done' && !approveResult && session?.status === 'APPROVED' ? 'w-[640px]' : 'w-[480px]'}`}
        style={{ transform: open ? 'translateX(0)' : 'translateX(100%)', transition: 'transform 150ms ease-out' }}
      >
        {/* Drawer header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 shrink-0">
          <div className="flex items-center gap-2">
            <ScanLine size={18} className="text-blue-600" />
            <span className="font-semibold text-gray-900">
              {drawerState === 'processing' ? 'Scanning…'
                : drawerState === 'review' ? 'Review Invoice'
                : drawerState === 'done' ? 'Invoice'
                : 'Loading…'}
            </span>
          </div>
          <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors">
            <X size={18} />
          </button>
        </div>

        {/* Drawer body */}
        <div className="flex-1 overflow-hidden flex min-h-0">
          {/* Left: image viewer (only in review state) */}
          {drawerState === 'review' && session?.files && session.files.length > 0 && (
            <InvoiceImageViewer files={session.files} />
          )}

          {/* Right: content */}
          <div className={`flex-1 overflow-y-auto flex flex-col ${drawerState === 'review' ? 'border-l border-gray-100' : ''}`}>
            {drawerState === 'loading' && (
              <div className="flex-1 flex items-center justify-center">
                <Loader2 size={28} className="animate-spin text-blue-500" />
              </div>
            )}
            {drawerState === 'processing' && renderProcessing()}
            {drawerState === 'review' && renderReview()}
            {drawerState === 'done' && renderDone()}
          </div>
        </div>
      </div>

      {/* Mobile: bottom sheet */}
      <div
        className="sm:hidden fixed inset-0 z-50 flex items-end"
        style={{ pointerEvents: open ? 'auto' : 'none' }}
      >
        <div
          className="relative bg-white w-full rounded-t-2xl shadow-2xl flex flex-col"
          style={{
            maxHeight: '92vh',
            transform: open ? 'translateY(0)' : 'translateY(100%)',
            transition: 'transform 150ms ease-out',
          }}
        >
          {/* Handle bar */}
          <div className="flex justify-center pt-3 pb-1 shrink-0">
            <div className="w-10 h-1 rounded-full bg-gray-200" />
          </div>

          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 shrink-0">
            <div className="flex items-center gap-2">
              <ScanLine size={16} className="text-blue-600" />
              <span className="font-semibold text-gray-900 text-sm">
                {drawerState === 'processing' ? 'Scanning…'
                  : drawerState === 'review' ? 'Review Invoice'
                  : drawerState === 'done' ? 'Invoice'
                  : 'Loading…'}
              </span>
            </div>
            <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-600">
              <X size={16} />
            </button>
          </div>

          {/* Mobile tab bar (review state only, when files exist) */}
          {drawerState === 'review' && session?.files && session.files.length > 0 && (
            <div className="flex border-b border-gray-100 shrink-0">
              <button
                onClick={() => setMobileTab('review')}
                className={`flex-1 py-2 text-xs font-medium ${mobileTab === 'review' ? 'text-blue-600 border-b-2 border-blue-500' : 'text-gray-500'}`}
              >
                Review
              </button>
              <button
                onClick={() => setMobileTab('image')}
                className={`flex-1 py-2 text-xs font-medium ${mobileTab === 'image' ? 'text-blue-600 border-b-2 border-blue-500' : 'text-gray-500'}`}
              >
                Invoice Image
              </button>
            </div>
          )}

          {/* Content */}
          <div className="flex-1 overflow-y-auto">
            {drawerState === 'loading' && (
              <div className="flex items-center justify-center py-20">
                <Loader2 size={24} className="animate-spin text-gray-300" />
              </div>
            )}
            {drawerState === 'processing' && renderProcessing()}
            {drawerState === 'review' && (
              mobileTab === 'image' && session?.files?.length ? (
                <InvoiceImageViewer files={session.files} />
              ) : renderReview()
            )}
            {drawerState === 'done' && renderDone()}
          </div>
        </div>
      </div>

      {/* Sub-panels — rendered above the drawer (z-60/70) */}
      {editingItem && (
        <ItemDetailPanel
          item={editingItem}
          onSave={async (updates) => {
            await updateScanItem(editingItem.id, updates)
            setEditingItem(null)
          }}
          onClose={() => setEditingItem(null)}
        />
      )}

      {editingInventory && (
        <InventoryEditModal
          inventoryItemId={editingInventory.inventoryItemId}
          scanItem={editingInventory.scanItem}
          onSaved={async (updates) => {
            await updateScanItem(editingInventory.scanItem.id, updates)
            setEditingInventory(null)
          }}
          onClose={() => setEditingInventory(null)}
        />
      )}

      {isAddingItem && (
        <AddItemModal
          onAdd={handleAddItem}
          onClose={() => setIsAddingItem(false)}
        />
      )}
    </>
  )
}

// Keep ActionSelect in scope to suppress unused warning — it's available for consumer use
export { ActionSelect }
