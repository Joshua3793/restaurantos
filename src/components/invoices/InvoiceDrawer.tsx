'use client'
import { useEffect, useState, useRef, useCallback } from 'react'
import {
  X, ScanLine, CheckCircle2, AlertTriangle, Loader2,
  FileText, Image, FileSpreadsheet, TrendingUp, TrendingDown,
  Plus, Bell, Package, ClipboardList, ChevronRight, Pencil,
  AlertCircle, Hash, CalendarDays, ArrowRight, Trash2,
  Building2, ChevronDown, RotateCcw, RotateCw, Minus, Maximize2,
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
  if (c === 'HIGH')   return <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-green-soft text-green-text">HIGH</span>
  if (c === 'MEDIUM') return <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-yellow-100 text-yellow-700">MEDIUM</span>
  if (c === 'LOW')    return <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-gold-soft text-gold-2">LOW</span>
  return <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-bg-2 text-ink-3">NO MATCH</span>
}

const fileIcon = (fileType: string) => {
  if (fileType.includes('pdf')) return <FileText size={16} className="text-red" />
  if (fileType.includes('csv') || fileType.includes('text')) return <FileSpreadsheet size={16} className="text-green" />
  return <Image size={16} className="text-blue" />
}

const ocrStatusBadge = (status: string) => {
  if (status === 'COMPLETE') return <span className="text-[10px] font-semibold text-green flex items-center gap-1"><CheckCircle2 size={10} />Done</span>
  if (status === 'PROCESSING') return <span className="text-[10px] font-semibold text-gold flex items-center gap-1"><Loader2 size={10} className="animate-spin" />Processing</span>
  if (status === 'ERROR') return <span className="text-[10px] font-semibold text-red flex items-center gap-1"><AlertTriangle size={10} />Error</span>
  return <span className="text-[10px] font-semibold text-ink-4">Pending</span>
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
  priceType: string | null
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
          <div className="flex items-center justify-between px-5 py-4 border-b border-line">
            <div>
              <h3 className="font-semibold text-ink">Add Line Item</h3>
              <p className="text-xs text-ink-4 mt-0.5">Manually add a missing item to this invoice</p>
            </div>
            <button onClick={onClose} className="p-2.5 flex items-center justify-center text-ink-4 hover:text-ink-3"><X size={18} /></button>
          </div>

          <form onSubmit={handleSubmit} className="p-5 space-y-4">
            <div>
              <label className="block text-xs font-medium text-ink-3 mb-1">Description <span className="text-red">*</span></label>
              <input
                autoFocus
                value={desc}
                onChange={e => setDesc(e.target.value)}
                placeholder="e.g. Cream 4/4L, Chicken Breast, Olive Oil 3L…"
                className="w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-ink-3 mb-1">Qty ordered</label>
                <input
                  type="number"
                  step="any"
                  min="0"
                  value={qty}
                  onChange={e => setQty(e.target.value)}
                  placeholder="1"
                  className="w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-3 mb-1">Unit price ($)</label>
                <input
                  type="number"
                  step="any"
                  min="0"
                  value={unitPrice}
                  onChange={e => setUnitPrice(e.target.value)}
                  placeholder="0.00"
                  className="w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                />
              </div>
            </div>

            {total !== null && (
              <div className="flex items-center justify-between text-sm bg-gold/10 rounded-lg px-3 py-2">
                <span className="text-gold">Line total</span>
                <span className="font-bold text-blue-text">{new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(total)}</span>
              </div>
            )}

            <p className="text-xs text-ink-4">
              You can fill in the pack format and match it to inventory after adding.
            </p>

            <div className="flex gap-2 pt-1">
              <button
                type="submit"
                disabled={!desc.trim() || saving}
                className="flex-1 bg-ink text-paper [&_svg]:text-gold rounded-lg py-2 text-sm font-semibold hover:bg-ink-2 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                {saving ? 'Adding…' : 'Add to Invoice'}
              </button>
              <button type="button" onClick={onClose}
                className="border border-line text-ink-3 rounded-lg py-2 px-4 text-sm hover:bg-bg">
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

// ── Item status taxonomy ──────────────────────────────────────────────────
// Single source of truth for: card border colour, status pill, and filter
// counts. Order is preserved (invoice order); status only changes appearance.

type ItemStatus = 'OK' | 'PRICE_SMALL' | 'PRICE_BIG' | 'NEW' | 'UNMATCHED' | 'SKIPPED'

interface StatusInfo {
  kind: ItemStatus
  borderClass: string
  pillClass: string
  label: string
  short: string  // short label for filter chips
}

const PRICE_SMALL_THRESHOLD = 5    // |Δ%| ≤ 5  → quiet
const PRICE_BIG_THRESHOLD   = 15   // |Δ%| > 15 → loud

function getItemStatus(item: ScanItem): StatusInfo {
  if (item.action === 'SKIP') {
    return { kind: 'SKIPPED', borderClass: 'border-l-gray-200', pillClass: 'bg-bg-2 text-ink-3', label: 'Skipped', short: 'Skipped' }
  }
  if (item.action === 'CREATE_NEW') {
    return { kind: 'NEW', borderClass: 'border-l-purple-400', pillClass: 'bg-blue-soft text-blue-text border border-blue-soft', label: 'New item', short: 'New' }
  }
  if (!item.matchedItemId) {
    return { kind: 'UNMATCHED', borderClass: 'border-l-gray-300', pillClass: 'bg-bg text-ink-3 border border-line', label: 'No match', short: 'Unmatched' }
  }
  const diff = item.priceDiffPct !== null && item.priceDiffPct !== undefined ? Math.abs(Number(item.priceDiffPct)) : 0
  if (item.formatMismatch || diff > PRICE_BIG_THRESHOLD) {
    return { kind: 'PRICE_BIG', borderClass: 'border-l-red-400', pillClass: 'bg-red-soft text-red-text border border-red-soft', label: item.formatMismatch ? 'Format mismatch' : `${diff > 0 ? '+' : ''}${(item.priceDiffPct ? Number(item.priceDiffPct) : 0).toFixed(1)}%`, short: 'Price ↑↑' }
  }
  if (diff > PRICE_SMALL_THRESHOLD) {
    const sign = item.priceDiffPct && Number(item.priceDiffPct) > 0 ? '+' : ''
    return { kind: 'PRICE_SMALL', borderClass: 'border-l-amber-400', pillClass: 'bg-gold-soft text-gold-2 border border-gold-soft', label: `${sign}${(item.priceDiffPct ? Number(item.priceDiffPct) : 0).toFixed(1)}%`, short: 'Price changed' }
  }
  return { kind: 'OK', borderClass: 'border-l-emerald-400', pillClass: 'bg-green-soft text-green-text border border-green-soft', label: 'Match', short: 'Unchanged' }
}

// ── PriceHistorySparkline ─────────────────────────────────────────────────────
// Compact inline SVG showing the last several unit prices for a matched item.
// Renders nothing if there are fewer than 2 points.
type PricePoint = { date: string | null; supplierName: string | null; unitPrice: number }
function PriceHistorySparkline({ points }: { points: PricePoint[] }) {
  if (!points || points.length < 2) return null

  // Points come newest-first from the API; reverse to chronological for the line.
  const chrono = [...points].reverse()
  const W = 60, H = 16, PAD = 2
  const prices = chrono.map(p => p.unitPrice)
  const min = Math.min(...prices), max = Math.max(...prices)
  const range = max - min || 1
  const step = chrono.length > 1 ? (W - PAD * 2) / (chrono.length - 1) : 0

  const x = (i: number) => PAD + i * step
  const y = (v: number) => H - PAD - ((v - min) / range) * (H - PAD * 2)
  const path = chrono.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p.unitPrice).toFixed(1)}`).join(' ')

  // Trend color from first→last
  const trend = chrono[chrono.length - 1].unitPrice - chrono[0].unitPrice
  const stroke = Math.abs(trend) < 0.01 * chrono[0].unitPrice ? '#9ca3af' : trend > 0 ? '#ef4444' : '#10b981'

  const tooltip = chrono.map(p =>
    `${p.date ? p.date.slice(0, 10) : '?'}: $${p.unitPrice.toFixed(2)}${p.supplierName ? ` · ${p.supplierName}` : ''}`
  ).join('\n')

  return (
    <span title={tooltip} className="inline-flex items-center shrink-0" aria-label={`Price trend: ${chrono.length} points`}>
      <svg width={W} height={H} className="opacity-80">
        <path d={path} stroke={stroke} strokeWidth={1.25} fill="none" strokeLinejoin="round" strokeLinecap="round" />
        {chrono.map((p, i) => (
          <circle key={i} cx={x(i)} cy={y(p.unitPrice)} r={1.2} fill={stroke} />
        ))}
      </svg>
    </span>
  )
}

function ScanItemCard({
  item,
  onUpdate,
  onOpenDetail,
  onEditInventory,
  revenueCenters,
  sessionRcId,
  onRcChange,
  compactOk = false,
  editRequestId = null,
  editRequestTick = 0,
  onRequestNextAttention,
  priceHistory,
}: {
  item: ScanItem
  onUpdate: (updates: Partial<Omit<ScanItem, 'newItemData'> & { newItemData?: Record<string, unknown> | string | null }>) => void
  onOpenDetail: () => void
  onEditInventory: (inventoryItemId: string, scanItem: ScanItem) => void
  revenueCenters: Array<{ id: string; name: string; color: string }>
  sessionRcId: string | null
  onRcChange: (rcId: string) => void
  compactOk?: boolean
  editRequestId?: string | null
  editRequestTick?: number
  onRequestNextAttention?: (currentId: string) => void
  priceHistory?: PricePoint[]
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
  const [localTotalQty, setLocalTotalQty] = useState(String(item.totalQty ?? ''))
  const [localTotalQtyUOM, setLocalTotalQtyUOM] = useState(item.totalQtyUOM ?? item.invoicePackUOM ?? '')
  const [localUnitPrice, setLocalUnitPrice] = useState(String(item.rawUnitPrice ?? ''))
  const [localLineTotal, setLocalLineTotal] = useState(() => {
    if (item.rawLineTotal !== null) return String(item.rawLineTotal)
    if (item.rawQty !== null && item.rawUnitPrice !== null) {
      const pq = Number(item.invoicePackQty) || 1
      const ps = Number(item.invoicePackSize) || 1
      const pt = item.rawPriceType ?? 'CASE'
      let total: number
      if (pt === 'PKG') total = Number(item.rawQty) * pq * Number(item.rawUnitPrice)
      else if (pt === 'UOM') total = Number(item.rawQty) * pq * ps * Number(item.rawUnitPrice)
      else total = Number(item.rawQty) * Number(item.rawUnitPrice)
      return String(total.toFixed(2))
    }
    return ''
  })
  const [localPriceType, setLocalPriceType] = useState<'CASE' | 'PKG' | 'UOM'>(
    item.rawPriceType ?? 'CASE'
  )

  // ── Reactive recomputation control ──
  // priceDriver tracks which of unitPrice/lineTotal is the user's latest input;
  // the other is auto-derived. Flipping this lets the user edit either field
  // and have the other update live.
  const [priceDriver, setPriceDriver] = useState<'unit' | 'total'>('unit')
  // totalQtyMode tracks whether totalQty is auto-computed (cases × pq × ps)
  // or user-overridden (e.g. "actual weight delivered = 4.8 kg per bottle").
  const [totalQtyMode, setTotalQtyMode] = useState<'nominal' | 'override'>(
    item.totalQty !== null && item.totalQty !== undefined ? 'override' : 'nominal'
  )
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
      const invoicePricePerPackUOM =
        localPriceType === 'PKG' ? rawPrice / Number(ps)
        : localPriceType === 'UOM' ? rawPrice
        : rawPrice / (Number(pq) * Number(ps))  // CASE
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

    onUpdate({ matchedItemId: inv.id, action, previousPrice: newPrice !== null ? String(Number(inv.purchasePrice)) : null, newPrice: newPrice !== null ? String(newPrice) : null, priceDiffPct: priceDiffPct !== null ? String(priceDiffPct) : null, matchConfidence: 'HIGH', matchScore: 100, rawPriceType: localPriceType })
    setShowDropdown(false)
  }

  const handleSelectCreateNew = () => {
    onUpdate({ matchedItemId: null, action: 'CREATE_NEW', previousPrice: null, priceDiffPct: null })
    setShowDropdown(false)
  }

  // ── Linked calculators ────────────────────────────────────────────────────
  // Pure formula helpers — kept side-effect-free.
  const calcTotal = (cases: number, price: number, pq: number, ps: number, pt: 'CASE' | 'PKG' | 'UOM') => {
    if (pt === 'PKG') return cases * pq * price
    if (pt === 'UOM') return cases * pq * ps * price
    return cases * price  // CASE
  }
  const calcUnitPrice = (cases: number, total: number, pq: number, ps: number, pt: 'CASE' | 'PKG' | 'UOM') => {
    if (pt === 'PKG') return total / (cases * pq)
    if (pt === 'UOM') return total / (cases * pq * ps)
    return total / cases  // CASE
  }
  const trimZeros = (s: string) => s.replace(/\.?0+$/, '')

  // Single source of truth for derived fields.
  // Whenever any primary input changes, the non-driver price field and
  // the nominal totalQty are recomputed in lock-step. This guarantees the
  // visible math is always self-consistent without fragile per-handler chains.
  const recomputingRef = useRef(false)
  useEffect(() => {
    if (!editingPurchase) return
    if (recomputingRef.current) return
    recomputingRef.current = true
    try {
      const cases = parseFloat(localCases)
      const pq    = parseFloat(localPackQty)  || 1
      const ps    = parseFloat(localPackSize) || 1

      // ── Recompute the non-driver of (unitPrice, lineTotal) ──
      if (priceDriver === 'unit') {
        const price = parseFloat(localUnitPrice)
        if (cases > 0 && price > 0) {
          const next = calcTotal(cases, price, pq, ps, localPriceType).toFixed(2)
          if (next !== localLineTotal) setLocalLineTotal(next)
        }
      } else {
        const total = parseFloat(localLineTotal)
        if (cases > 0 && total > 0) {
          const next = calcUnitPrice(cases, total, pq, ps, localPriceType).toFixed(4)
          if (next !== localUnitPrice) setLocalUnitPrice(next)
        }
      }

      // ── Recompute nominal totalQty (only if not user-overridden) ──
      if (totalQtyMode === 'nominal' && cases > 0 && pq > 0 && ps > 0) {
        const next = trimZeros((cases * pq * ps).toFixed(3))
        if (next !== localTotalQty) setLocalTotalQty(next)
      }
    } finally {
      recomputingRef.current = false
    }
  }, [
    localCases, localPackQty, localPackSize, localPriceType,
    localUnitPrice, localLineTotal, priceDriver, totalQtyMode,
    editingPurchase,
  ])

  // ── Input handlers ────────────────────────────────────────────────────────
  // Keep state writes minimal — the useEffect above handles all ripple updates.
  const onUnitPriceChange = (v: string) => { setLocalUnitPrice(v); setPriceDriver('unit') }
  const onLineTotalChange = (v: string) => { setLocalLineTotal(v); setPriceDriver('total') }
  // User-typed totalQty enters override mode; clearing it returns to nominal.
  const onTotalQtyChange = (v: string) => {
    setLocalTotalQty(v)
    setTotalQtyMode(v.trim() === '' ? 'nominal' : 'override')
  }

  // ── Auto-save infrastructure ──────────────────────────────────────────────
  // Pure: builds the persistable updates from current local state.
  type SaveUpdates = Parameters<typeof onUpdate>[0]
  const buildUpdates = useCallback((): SaveUpdates => {
    const cases     = parseFloat(localCases)     || null
    const unitPrice = parseFloat(localUnitPrice) || null
    const manualTotal = parseFloat(localLineTotal) || null
    const pq   = parseFloat(localPackQty)  || null
    const ps   = parseFloat(localPackSize) || null
    const pUOM = localPackUOM || null
    const lineTotal = manualTotal ?? (
      cases !== null && unitPrice !== null
        ? (() => {
            const pqN = pq ?? 1, psN = ps ?? 1
            if (localPriceType === 'PKG') return cases * pqN * unitPrice
            if (localPriceType === 'UOM') return cases * pqN * psN * unitPrice
            return cases * unitPrice
          })()
        : null
    )
    let newPrice: number | null = unitPrice
    let priceDiffPct: number | null = null

    if (unitPrice !== null && item.matchedItem) {
      if (pq && ps && Number(ps) > 0 && pUOM) {
        const invoicePPU =
          localPriceType === 'PKG' ? unitPrice / ps
          : localPriceType === 'UOM' ? unitPrice
          : unitPrice / (pq * ps)  // CASE
        const invPackTotal2 = Number(item.matchedItem.qtyPerPurchaseUnit) * Number(item.matchedItem.packSize)
        const invPPU2 = invPackTotal2 > 0 ? Number(item.matchedItem.purchasePrice) / invPackTotal2 : 0
        const normalized = comparePricesNormalized(invoicePPU, pUOM, invPPU2, item.matchedItem.packUOM)
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

    const tq    = parseFloat(localTotalQty) || null
    const tqUOM = localTotalQtyUOM || pUOM || null
    return {
      rawQty:       cases !== null ? String(cases) : null,
      rawUnit:      localUnit || null,
      rawUnitPrice: unitPrice !== null ? String(unitPrice) : null,
      rawLineTotal: lineTotal !== null ? String(lineTotal) : null,
      invoicePackQty:  pq !== null ? String(pq) : null,
      invoicePackSize: ps !== null ? String(ps) : null,
      invoicePackUOM:  pUOM,
      rawPriceType: localPriceType,
      needsFormatConfirm: false,
      totalQty:    tq  !== null ? String(tq)  : null,
      totalQtyUOM: tqUOM,
      newPrice:     newPrice !== null ? String(newPrice) : null,
      priceDiffPct: priceDiffPct !== null ? String(priceDiffPct) : null,
      action: Math.abs(Number(priceDiffPct ?? 0)) > 0.1 ? 'UPDATE_PRICE'
            : (item.matchedItemId ? 'ADD_SUPPLIER' : item.action),
    }
  }, [localCases, localUnit, localPackQty, localPackSize, localPackUOM,
      localUnitPrice, localLineTotal, localPriceType, localTotalQty,
      localTotalQtyUOM, item, onUpdate])

  // Save-status tracking for the auto-save indicator.
  const [saveStatus, setSaveStatus] = useState<'idle' | 'pending' | 'saving' | 'saved'>('idle')
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savedFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const initialSnapshotRef = useRef<string | null>(null)

  const savePurchase = useCallback(async () => {
    setSaveStatus('saving')
    try {
      await Promise.resolve(onUpdate(buildUpdates()))
      setSaveStatus('saved')
      if (savedFlashTimerRef.current) clearTimeout(savedFlashTimerRef.current)
      savedFlashTimerRef.current = setTimeout(() => setSaveStatus('idle'), 1500)
    } catch {
      // onUpdate has its own error handling; if it throws we just stay 'saving'
      setSaveStatus('idle')
    }
  }, [buildUpdates, onUpdate])

  // Watch local state while editing; debounce-save on changes.
  // Take an initial snapshot when entering edit mode so we don't auto-save
  // immediately just because the inputs were rendered.
  useEffect(() => {
    if (!editingPurchase) {
      initialSnapshotRef.current = null
      return
    }
    const signature = JSON.stringify([
      localCases, localUnit, localPackQty, localPackSize, localPackUOM,
      localUnitPrice, localLineTotal, localPriceType, localTotalQty, localTotalQtyUOM,
    ])
    if (initialSnapshotRef.current === null) {
      initialSnapshotRef.current = signature
      return
    }
    if (initialSnapshotRef.current === signature) return
    initialSnapshotRef.current = signature

    setSaveStatus('pending')
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => { savePurchase() }, 1200)
  }, [localCases, localUnit, localPackQty, localPackSize, localPackUOM,
      localUnitPrice, localLineTotal, localPriceType, localTotalQty,
      localTotalQtyUOM, editingPurchase, savePurchase])

  // Cleanup timers on unmount.
  useEffect(() => () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    if (savedFlashTimerRef.current) clearTimeout(savedFlashTimerRef.current)
  }, [])

  // Done = flush any pending save immediately, then close edit mode.
  const handleDone = async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
      await savePurchase()
    }
    setEditingPurchase(false)
  }

  // Parent can request this card to enter edit mode (used by "save & next").
  const lastEditTickRef = useRef(0)
  useEffect(() => {
    if (editRequestId === item.id && editRequestTick !== lastEditTickRef.current && editRequestTick > 0) {
      lastEditTickRef.current = editRequestTick
      setEditingPurchase(true)
    }
  }, [editRequestId, editRequestTick, item.id])

  // Keyboard nav inside edit mode: Esc closes, Cmd/Ctrl+Enter saves & jumps.
  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      handleDone()
      return
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      ;(async () => {
        await handleDone()
        onRequestNextAttention?.(item.id)
      })()
    }
  }

  const status = getItemStatus(item)
  const accentClass = `${status.borderClass}${item.action === 'SKIP' ? ' opacity-50' : ''}`

  const priceDiff     = item.priceDiffPct ? Number(item.priceDiffPct) : null
  const newItemFilled = item.action === 'CREATE_NEW' && item.newItemData
  const displayName   = item.matchedItem?.itemName ?? null

  // Derived display values (from saved item props — shown in view mode)
  const savedLineTotal = (() => {
    if (item.rawLineTotal !== null) return Number(item.rawLineTotal)
    if (item.rawQty !== null && item.rawUnitPrice !== null) {
      const pq = Number(item.invoicePackQty) || 1
      const ps = Number(item.invoicePackSize) || 1
      const pt = item.rawPriceType ?? 'CASE'
      if (pt === 'PKG') return Number(item.rawQty) * pq * Number(item.rawUnitPrice)
      if (pt === 'UOM') return Number(item.rawQty) * pq * ps * Number(item.rawUnitPrice)
      return Number(item.rawQty) * Number(item.rawUnitPrice)  // CASE
    }
    return null
  })()

  // ── Base cost ($/packUOM) — single universal formula ──────────────────────
  // baseCost = totalInvoiceAmount / totalVolume
  // where totalInvoiceAmount = cases × factor × unitPrice
  // and   totalVolume       = totalQty (override) OR cases × pq × ps (nominal)
  // factor depends on priceType: CASE=1, PKG=pq, UOM=pq*ps
  const computeBaseCost = (
    cases: number, price: number, pq: number, ps: number,
    priceType: 'CASE' | 'PKG' | 'UOM',
    overrideTotalQty: number | null,
  ): number | null => {
    if (!(price > 0) || !(cases > 0) || !(pq > 0) || !(ps > 0)) return null
    const factor = priceType === 'CASE' ? 1 : priceType === 'PKG' ? pq : pq * ps
    const totalAmount = cases * factor * price
    const totalVolume = overrideTotalQty && overrideTotalQty > 0 ? overrideTotalQty : cases * pq * ps
    return totalVolume > 0 ? totalAmount / totalVolume : null
  }

  const liveBaseCost = (() => {
    const cases = parseFloat(localCases) || 1
    const price = parseFloat(localUnitPrice)
    const pq    = parseFloat(localPackQty)  || 1
    const ps    = parseFloat(localPackSize) || 1
    const tqOverride = totalQtyMode === 'override' ? (parseFloat(localTotalQty) || null) : null
    return computeBaseCost(cases, price, pq, ps, localPriceType, tqOverride)
  })()

  const savedBaseCost = (() => {
    if (!item.rawUnitPrice || !item.invoicePackQty || !item.invoicePackSize) return null
    const cases = Number(item.rawQty) || 1
    const pq    = Number(item.invoicePackQty)
    const ps    = Number(item.invoicePackSize)
    const price = Number(item.rawUnitPrice)
    const pt    = item.rawPriceType ?? 'CASE'
    const tqOverride = item.totalQty ? Number(item.totalQty) : null
    return computeBaseCost(cases, price, pq, ps, pt, tqOverride)
  })()

  return (
    <div id={`scanitem-${item.id}`} className={`bg-white rounded-xl border border-line border-l-4 ${accentClass} px-3 py-2.5 transition-all`}>

      {/* ── Row 1: Description + status pill + skip ── */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <span className={`font-medium text-sm leading-snug ${item.action === 'SKIP' ? 'line-through text-ink-4' : 'text-ink'}`}>
            {item.rawDescription}
          </span>
          {/* OCR low-confidence indicator — surfaces Claude's own uncertainty */}
          {item.ocrConfidence === 'low' && (
            <span
              className="inline-flex items-center align-middle ml-1.5 text-gold"
              title={item.ocrNotes ? `OCR uncertain: ${item.ocrNotes}` : 'OCR uncertain — double-check the values below'}
            >
              <AlertCircle size={12} />
            </span>
          )}
          {/* In compact-OK mode, show matched inventory name inline so users
              still know what it resolved to without expanding rows 2/3 */}
          {compactOk && status.kind === 'OK' && displayName && (
            <span className="text-xs text-ink-4 ml-1.5">→ {displayName}</span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap ${status.pillClass}`}>
            {status.label}
          </span>
          <button
            onClick={() => onUpdate({ action: item.action === 'SKIP' ? (item.matchedItemId ? 'UPDATE_PRICE' : 'CREATE_NEW') : 'SKIP' })}
            className={`p-0.5 rounded transition-colors ${item.action === 'SKIP' ? 'text-ink-3 bg-bg-2' : 'text-ink-4 hover:text-red'}`}
            title={item.action === 'SKIP' ? 'Restore' : 'Skip'}
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* ── Row 2: Purchase details (view or edit) ──
          Hidden in compact-OK mode unless the user opens edit mode. */}
      {item.action !== 'SKIP' && (status.kind !== 'OK' || !compactOk || editingPurchase) && (
        <div className="mt-1">
          {/* VIEW MODE — compact summary. Tap anywhere to enter edit mode. */}
          {!editingPurchase && (
            <div
              className="flex items-center gap-1.5 text-xs flex-wrap cursor-pointer rounded-lg -mx-1 px-2 py-1.5 hover:bg-blue-soft/60 border border-transparent hover:border-blue-soft transition-all group"
              onClick={() => setEditingPurchase(true)}
              role="button"
              tabIndex={0}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEditingPurchase(true) } }}
            >
              {/* By Case / By Weight pill */}
              <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-bold border shrink-0 ${
                isWeightVol(item.invoicePackUOM)
                  ? 'bg-blue-soft text-blue border-blue-soft'
                  : 'bg-gold-soft text-gold-2 border-gold-soft'
              }`}>
                {isWeightVol(item.invoicePackUOM) ? 'By Weight' : 'By Case'}
              </span>
              {/* cases */}
              {item.rawQty !== null && (
                <span className="font-semibold text-ink-2">{item.rawQty} {item.rawUnit || 'cs'}</span>
              )}
              {/* pack format */}
              {item.invoicePackQty && item.invoicePackSize && (
                <>
                  <span className="text-ink-4">·</span>
                  <span className="text-ink-3">
                    {Number(item.invoicePackQty)} × {Number(item.invoicePackSize)}{item.invoicePackUOM}
                  </span>
                </>
              )}
              {/* unit price */}
              {item.rawUnitPrice !== null && (
                <>
                  <span className="text-ink-4">·</span>
                  <span className="text-ink-3">
                    {formatCurrency(Number(item.rawUnitPrice))}/{
                      item.rawPriceType === 'PKG' ? 'pkg'
                      : item.rawPriceType === 'UOM' ? (item.invoicePackUOM || 'uom')
                      : 'case'
                    }
                  </span>
                </>
              )}
              {/* total */}
              {savedLineTotal !== null && (
                <>
                  <span className="text-ink-4">=</span>
                  <span className="font-bold text-ink-2">{formatCurrency(savedLineTotal)}</span>
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
                      <span className="text-ink-4">·</span>
                      <span className={`font-semibold ${priceDiff !== null && priceDiff > 0 ? 'text-red' : priceDiff !== null ? 'text-green' : 'text-ink-3'}`}>
                        {formatCurrency(norm.invoicePPB)}/{norm.baseUnit}
                      </span>
                    </>
                  )
                }
                return (
                  <>
                    <span className="text-ink-4">·</span>
                    <span className="text-ink-3">{formatCurrency(savedBaseCost)}/{pUOM}</span>
                  </>
                )
              })()}
              <ChevronDown size={13} className="text-ink-4 group-hover:text-blue ml-auto shrink-0 transition-colors" />
            </div>
          )}

          {/* EDIT MODE — vertical labeled form */}
          {editingPurchase && (
            <div
              className="mt-2 rounded-xl border border-blue-soft bg-blue-soft/40 p-3 space-y-3 text-xs"
              onKeyDown={handleEditKeyDown}
            >

              {/* ── Mode toggle: By Case / By Weight ── */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (isWeightVol(localPackUOM)) {
                      setLocalPackUOM('')
                      setLocalPriceType('CASE')
                    }
                  }}
                  className={`px-3 py-1 rounded-full text-xs font-semibold border transition-colors ${
                    !isWeightVol(localPackUOM)
                      ? 'bg-ink text-paper border-ink [&_svg]:text-gold shadow-sm'
                      : 'bg-white text-ink-3 border-line hover:border-gold-soft hover:text-gold'
                  }`}
                >By Case</button>
                <button
                  type="button"
                  onClick={() => {
                    if (!isWeightVol(localPackUOM)) {
                      const defaultUOM = 'kg'
                      setLocalPackUOM(defaultUOM)
                      if (!localTotalQtyUOM || !isWeightVol(localTotalQtyUOM)) setLocalTotalQtyUOM(defaultUOM)
                    }
                  }}
                  className={`px-3 py-1 rounded-full text-xs font-semibold border transition-colors ${
                    isWeightVol(localPackUOM)
                      ? 'bg-blue text-white border-blue shadow-sm'
                      : 'bg-white text-ink-3 border-line hover:border-blue hover:text-blue'
                  }`}
                >By Weight</button>
              </div>

              {/* ── Section: How they sold it ── */}
              <div className="space-y-2">
                <p className="text-[9px] font-semibold text-ink-4 uppercase tracking-wider">How they sold it</p>

                {/* Qty ordered */}
                <div className="flex items-center gap-2">
                  <span className="w-28 text-ink-3 shrink-0">Qty ordered</span>
                  <div className="flex items-center gap-1">
                    <input type="number" step="any" min="0" value={localCases}
                      onChange={e => setLocalCases(e.target.value)}
                      className="w-14 border border-blue-soft rounded-lg px-2 py-1 text-center bg-white focus:outline-none focus:ring-1 focus:ring-blue" />
                    <input value={localUnit} onChange={e => setLocalUnit(e.target.value)}
                      placeholder="cs"
                      className="w-12 border border-blue-soft rounded-lg px-2 py-1 text-center bg-white focus:outline-none focus:ring-1 focus:ring-blue" />
                  </div>
                </div>

                {/* Units per case */}
                <div className="flex items-center gap-2">
                  <span className="w-28 text-ink-3 shrink-0">Units per {localUnit || 'case'}</span>
                  <input type="number" step="any" min="0" value={localPackQty}
                    onChange={e => setLocalPackQty(e.target.value)}
                    className="w-14 border border-blue-soft rounded-lg px-2 py-1 text-center bg-white focus:outline-none focus:ring-1 focus:ring-blue" />
                </div>

                {/* Unit size */}
                <div className="flex items-center gap-2">
                  <span className="w-28 text-ink-3 shrink-0">Each unit is</span>
                  <div className="flex items-center gap-1">
                    <input type="number" step="any" min="0" value={localPackSize}
                      onChange={e => setLocalPackSize(e.target.value)}
                      className="w-14 border border-blue-soft rounded-lg px-2 py-1 text-center bg-white focus:outline-none focus:ring-1 focus:ring-blue" />
                    <select value={localPackUOM}
                      onChange={e => {
                        setLocalPackUOM(e.target.value)
                        // Mirror packUOM into totalQtyUOM unless the user has chosen a different UOM
                        if (!localTotalQtyUOM || localTotalQtyUOM === localPackUOM) setLocalTotalQtyUOM(e.target.value)
                      }}
                      className="border border-blue-soft rounded-lg px-2 py-1 bg-white focus:outline-none">
                      <option value="">—</option>
                      {PACK_UOMS.map(u => <option key={u} value={u}>{u}</option>)}
                    </select>
                  </div>
                </div>
              </div>

              <div className="border-t border-blue-soft" />

              {/* ── Section: Pricing ── */}
              <div className="space-y-2">
                <p className="text-[9px] font-semibold text-ink-4 uppercase tracking-wider">Pricing</p>

                {/* Charged per */}
                <div className="flex items-center gap-2">
                  <span className="w-28 text-ink-3 shrink-0">Charged per</span>
                  <div className="flex items-center gap-3">
                    {(['CASE', 'PKG', 'UOM'] as const).map(pt => (
                      <label key={pt} className="flex items-center gap-1 cursor-pointer">
                        <input type="radio" name={`priceType-${item.id}`} value={pt}
                          checked={localPriceType === pt}
                          onChange={() => setLocalPriceType(pt)}
                          className="accent-blue-500" />
                        <span className="text-ink-3">
                          {pt === 'CASE' ? (localUnit || 'case') : pt === 'PKG' ? 'pkg' : (localPackUOM || 'unit')}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                {/* Price */}
                <div className="flex items-center gap-2">
                  <span className="w-28 text-ink-3 shrink-0">Price</span>
                  <div className="flex items-center gap-1">
                    <span className="text-ink-4">$</span>
                    <input type="number" step="any" min="0" value={localUnitPrice}
                      onChange={e => onUnitPriceChange(e.target.value)}
                      className="w-20 border border-blue-soft rounded-lg px-2 py-1 text-center bg-white focus:outline-none focus:ring-1 focus:ring-blue" />
                  </div>
                </div>

                {/* Line total */}
                <div className="flex items-center gap-2">
                  <span className="w-28 text-ink-3 shrink-0">Line total</span>
                  <div className="flex items-center gap-1">
                    <span className="text-ink-4">$</span>
                    <input type="number" step="any" min="0" value={localLineTotal}
                      onChange={e => onLineTotalChange(e.target.value)}
                      className="w-20 border border-blue-soft rounded-lg px-2 py-1 text-center bg-white focus:outline-none focus:ring-1 focus:ring-blue font-semibold" />
                  </div>
                </div>
              </div>

              {/* ── Actual weight (weight/vol items only) ── */}
              {isWeightVol(localPackUOM) && (
                <>
                  <div className="border-t border-blue-soft" />
                  <div className="space-y-1">
                    <p className="text-[9px] font-semibold text-ink-4 uppercase tracking-wider">Actual weight / volume</p>
                    <div className="flex items-center gap-2">
                      <span className="w-28 text-ink-3 shrink-0">Measured total</span>
                      <div className="flex items-center gap-1">
                        <input type="number" step="any" min="0" value={localTotalQty}
                          onChange={e => onTotalQtyChange(e.target.value)}
                          placeholder={(() => {
                            const c = parseFloat(localCases), pq = parseFloat(localPackQty), ps = parseFloat(localPackSize)
                            return c > 0 && pq > 0 && ps > 0 ? `nominal: ${trimZeros((c * pq * ps).toFixed(3))}` : 'e.g. 4.8'
                          })()}
                          className={`w-24 border rounded-lg px-2 py-1 text-center focus:outline-none focus:ring-1 focus:ring-blue ${
                            totalQtyMode === 'override' ? 'border-gold-soft bg-gold-soft' : 'border-blue-soft bg-white'
                          }`} />
                        <select value={localTotalQtyUOM} onChange={e => setLocalTotalQtyUOM(e.target.value)}
                          className="border border-blue-soft rounded-lg px-2 py-1 bg-white focus:outline-none">
                          <option value="">—</option>
                          {PACK_UOMS.filter(u => isWeightVol(u)).map(u => <option key={u} value={u}>{u}</option>)}
                        </select>
                        {totalQtyMode === 'override' && (
                          <button
                            type="button"
                            onClick={() => onTotalQtyChange('')}
                            className="text-[10px] text-gold hover:text-gold-2 underline"
                            title="Reset to nominal"
                          >reset</button>
                        )}
                      </div>
                      <span className="text-[9px] text-ink-4">overrides nominal</span>
                    </div>
                  </div>
                </>
              )}

              {/* ── Live base cost preview ── */}
              {liveBaseCost !== null && localPackUOM && (
                <>
                  <div className="border-t border-blue-soft" />
                  <div className="space-y-1.5">
                    <p className="text-[9px] font-semibold text-ink-4 uppercase tracking-wider">Result for inventory</p>
                    {(() => {
                      if (item.matchedItem) {
                        const _livePkgTotal = Number(item.matchedItem.qtyPerPurchaseUnit) * Number(item.matchedItem.packSize)
                        const _livePPU = _livePkgTotal > 0 ? Number(item.matchedItem.purchasePrice) / _livePkgTotal : 0
                        const norm = comparePricesNormalized(liveBaseCost, localPackUOM, _livePPU, item.matchedItem.packUOM)
                        if (norm) {
                          const delta = norm.invoicePPB - norm.inventoryPPB
                          const isUp = norm.pctDiff > 0.1
                          const isDown = norm.pctDiff < -0.1
                          const badgeBg = isUp ? 'bg-red-soft text-red-text border-red-soft'
                            : isDown ? 'bg-green-soft text-green-text border-green-soft'
                            : 'bg-bg-2 text-ink-3 border-line'
                          return (
                            <div className="space-y-1.5">
                              <div className="flex items-center gap-2 text-[11px]">
                                <span className="w-24 text-ink-4 shrink-0">New cost</span>
                                <span className="font-bold text-ink text-sm">{formatCurrency(norm.invoicePPB)}</span>
                                <span className="text-ink-4">/{norm.baseUnit}</span>
                              </div>
                              <div className="flex items-center gap-2 text-[11px]">
                                <span className="w-24 text-ink-4 shrink-0">Was</span>
                                <span className="text-ink-3">{formatCurrency(norm.inventoryPPB)}/{norm.baseUnit}</span>
                              </div>
                              <div className="flex items-center gap-2 text-[11px] pt-0.5">
                                <span className="w-24 text-ink-4 shrink-0">Change</span>
                                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-bold text-[11px] border ${badgeBg}`}>
                                  {isUp ? <TrendingUp size={10} /> : isDown ? <TrendingDown size={10} /> : null}
                                  {norm.pctDiff > 0 ? '+' : ''}{norm.pctDiff.toFixed(1)}%
                                </span>
                                <span className={`text-[10px] ${isUp ? 'text-red' : isDown ? 'text-green' : 'text-ink-4'}`}>
                                  {delta > 0 ? '+' : ''}{formatCurrency(delta)}/{norm.baseUnit}
                                </span>
                              </div>
                            </div>
                          )
                        }
                      }
                      return (
                        <div className="flex items-center gap-2 text-[11px]">
                          <span className="w-24 text-ink-4 shrink-0">New cost</span>
                          <span className="font-bold text-ink text-sm">{formatCurrency(liveBaseCost)}</span>
                          <span className="text-ink-4">/{localPackUOM}</span>
                        </div>
                      )
                    })()}
                  </div>
                </>
              )}

              {/* Done + auto-save status */}
              <div className="flex items-center gap-2 pt-1">
                <span className="flex-1 flex items-center gap-1.5 text-[10px] text-ink-4">
                  {saveStatus === 'pending' && <><span className="w-1.5 h-1.5 rounded-full bg-gold" /> unsaved…</>}
                  {saveStatus === 'saving'  && <><Loader2 size={10} className="animate-spin text-blue" /> saving</>}
                  {saveStatus === 'saved'   && <><CheckCircle2 size={10} className="text-green" /> saved</>}
                  {saveStatus === 'idle'    && <span className="text-ink-4">auto-saves as you type</span>}
                </span>
                <span className="hidden sm:inline text-[10px] text-ink-4">
                  <kbd className="px-1 py-0.5 rounded bg-bg-2 text-ink-3 font-mono text-[9px]">⌘↵</kbd> next ·{' '}
                  <kbd className="px-1 py-0.5 rounded bg-bg-2 text-ink-3 font-mono text-[9px]">Esc</kbd> close
                </span>
                <button onClick={handleDone}
                  className="px-4 py-1.5 rounded-lg text-xs bg-ink text-paper [&_svg]:text-gold hover:bg-ink-2 transition-colors font-semibold">
                  Done
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Row 3: Inventory match ──
          Three visual states: matched, unmatched/searching, create-new.
          Hidden in compact-OK mode (matched name already shown inline in row 1). */}
      {item.action !== 'SKIP' && (status.kind !== 'OK' || !compactOk) && (
        <div ref={searchRef} className="relative mt-2">

          {/* ── CREATE NEW state ── */}
          {item.action === 'CREATE_NEW' && !showDropdown && (
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-blue-soft border border-blue-soft">
                <Plus size={12} className="text-blue shrink-0" />
                <span className="text-xs font-medium text-blue-text truncate">Will create new inventory item</span>
              </div>
              <button
                onClick={onOpenDetail}
                className={`shrink-0 text-[11px] px-2.5 py-1.5 rounded-lg font-semibold transition-colors ${
                  newItemFilled
                    ? 'bg-blue-soft text-blue-text hover:bg-blue-soft'
                    : 'bg-gold-soft text-gold-2 hover:bg-gold-soft'
                }`}
              >
                {newItemFilled ? 'Edit details' : 'Fill in ⚠'}
              </button>
              <button
                onClick={() => handleSearchFocus()}
                className="shrink-0 text-[11px] px-2.5 py-1.5 rounded-lg font-medium text-ink-3 hover:bg-bg-2 border border-line transition-colors"
                title="Search inventory instead"
              >
                Link instead
              </button>
            </div>
          )}

          {/* ── MATCHED state ── */}
          {item.matchedItemId && item.action !== 'CREATE_NEW' && !showDropdown && (
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 flex-1 min-w-0">
                <ArrowRight size={11} className="text-ink-4 shrink-0" />
                <button
                  onClick={() => handleSearchFocus()}
                  className="flex items-center gap-1.5 min-w-0 group"
                >
                  <span className="text-xs font-semibold text-ink-2 truncate group-hover:text-blue transition-colors">
                    {displayName}
                  </span>
                  <span className="text-[10px] text-ink-4 group-hover:text-blue shrink-0 transition-colors">change</span>
                </button>
                {priceHistory && priceHistory.length >= 2 && (
                  <PriceHistorySparkline points={priceHistory} />
                )}
              </div>

              {/* Price diff */}
              {item.action === 'UPDATE_PRICE' && priceDiff !== null && item.previousPrice !== null && item.newPrice !== null && (
                <div className="flex items-center gap-1 shrink-0">
                  <span className="text-[11px] text-ink-4 line-through">{formatCurrency(Number(item.previousPrice))}</span>
                  <ArrowRight size={9} className="text-ink-4" />
                  <span className={`text-[11px] font-bold ${priceDiff > 0 ? 'text-red' : 'text-green'}`}>
                    {formatCurrency(Number(item.newPrice))}
                  </span>
                  <span className={`text-[10px] font-semibold flex items-center ${priceDiff > 0 ? 'text-red' : 'text-green'}`}>
                    {priceDiff > 0 ? <TrendingUp size={9} /> : <TrendingDown size={9} />}
                    {Math.abs(priceDiff).toFixed(1)}%
                  </span>
                </div>
              )}

              {/* Edit inventory item button */}
              {(item.action === 'UPDATE_PRICE' || item.action === 'ADD_SUPPLIER') && (
                <button
                  onClick={() => onEditInventory(item.matchedItemId!, item)}
                  className="shrink-0 text-ink-4 hover:text-blue transition-colors"
                  title="Edit inventory item"
                >
                  <Pencil size={11} />
                </button>
              )}
            </div>
          )}

          {/* ── UNMATCHED state (no match, not create-new, not searching) ── */}
          {!item.matchedItemId && item.action !== 'CREATE_NEW' && !showDropdown && (
            <button
              onClick={() => handleSearchFocus()}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-line hover:border-blue hover:bg-blue-soft/40 text-ink-4 hover:text-blue transition-colors group"
            >
              <ArrowRight size={12} className="shrink-0" />
              <span className="flex-1 text-left text-xs font-medium">Link to inventory item…</span>
              <ChevronRight size={12} className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
            </button>
          )}

          {/* ── SEARCH state (dropdown open) ── */}
          {showDropdown && (
            <>
              <div className="flex items-center gap-1.5 border border-blue rounded-lg bg-white px-2.5 py-1.5 focus-within:ring-2 focus-within:ring-blue">
                {isSearching
                  ? <Loader2 size={12} className="animate-spin text-blue shrink-0" />
                  : <ArrowRight size={12} className="text-blue shrink-0" />
                }
                <input
                  autoFocus
                  className="flex-1 text-xs font-medium outline-none bg-transparent min-w-0"
                  placeholder="Search inventory…"
                  value={searchQuery}
                  onChange={e => handleSearchInput(e.target.value)}
                  onFocus={handleSearchFocus}
                />
                <button
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => setShowDropdown(false)}
                  className="text-ink-4 hover:text-ink-3 shrink-0"
                >
                  <X size={12} />
                </button>
              </div>

              <div className="absolute z-30 top-full left-0 right-0 mt-1 bg-white border border-line rounded-xl shadow-lg overflow-hidden max-h-56 overflow-y-auto">
                {searchResults.length === 0 && !isSearching && (
                  <p className="text-xs text-ink-4 px-3 py-2.5">No items found</p>
                )}
                {searchResults.map(inv => (
                  <button
                    key={inv.id}
                    onMouseDown={e => { e.preventDefault(); handleSelectItem(inv) }}
                    className="w-full text-left px-3 py-2 hover:bg-gold/10 transition-colors border-b border-line last:border-0"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-ink truncate">{inv.itemName}</p>
                        <p className="text-[10px] text-ink-4">{inv.purchaseUnit} · {inv.category}</p>
                      </div>
                      <span className="text-xs text-ink-3 shrink-0">{formatCurrency(Number(inv.purchasePrice))}</span>
                    </div>
                  </button>
                ))}
                <button
                  onMouseDown={e => { e.preventDefault(); handleSelectCreateNew() }}
                  className="w-full text-left px-3 py-2.5 hover:bg-blue-soft transition-colors flex items-center gap-2 border-t border-line"
                >
                  <Plus size={12} className="text-blue shrink-0" />
                  <span className="text-xs font-semibold text-blue-text">Create new inventory item</span>
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {revenueCenters.length > 1 && (
        <div className="flex items-center gap-2 mt-2 pt-2 border-t border-line">
          <span className="text-[10px] text-ink-4 shrink-0">RC:</span>
          <select
            value={item.revenueCenterId ?? sessionRcId ?? ''}
            onChange={e => onRcChange(e.target.value)}
            className="text-[10px] border border-line rounded px-1.5 py-0.5 text-ink-3 bg-white focus:outline-none"
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
    PENDING:       'bg-bg-2 text-ink-3',
    UPDATE_PRICE:  'bg-gold/15 text-gold',
    ADD_SUPPLIER:  'bg-green-soft text-green-text',
    CREATE_NEW:    'bg-blue-soft text-blue-text',
    SKIP:          'bg-bg-2 text-ink-4',
  }

  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value as LineItemAction)}
      className={`text-xs font-semibold rounded-lg px-2 py-1 border-0 cursor-pointer focus:outline-none focus:ring-2 focus:ring-gold ${colorMap[value]}`}
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
    priceType:          String(existing?.priceType ?? 'CASE'),
  })

  const pp   = parseFloat(form.purchasePrice) || 0
  const qty  = parseFloat(form.qtyPerPurchaseUnit) || 1
  const ps   = parseFloat(form.packSize) || 1
  const priceTypePt = form.priceType === 'UOM' ? 'UOM' : 'CASE' as const
  const ppbu = calcPricePerBaseUnit(pp, qty, 'each', null, ps, form.packUOM, priceTypePt)
  const cf   = calcConversionFactor(form.countUOM, qty, 'each', null, ps, form.packUOM)
  const bu   = deriveBaseUnit('each', form.packUOM)

  const isNew = item.action === 'CREATE_NEW'

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/30 z-[60]" onClick={onClose} />

      {/* Panel */}
      <div className="fixed inset-y-0 right-0 z-[70] w-full max-w-md bg-white shadow-xl overflow-y-auto flex flex-col">
        {/* Header */}
        <div
          className="sticky top-0 bg-white border-b border-line px-4 py-3 flex items-center justify-between gap-2"
          style={{ paddingTop: 'calc(0.75rem + env(safe-area-inset-top, 0px))' }}
        >
          <div className="flex-1 min-w-0">
            <p className="text-xs text-ink-4 uppercase tracking-wide font-medium">
              {isNew ? 'New Inventory Item' : 'Matched Item'}
            </p>
            <h3 className="font-semibold text-ink text-sm truncate mt-0.5">{item.rawDescription}</h3>
          </div>
          <button onClick={onClose} className="p-2.5 flex items-center justify-center text-ink-4 hover:text-ink-3">
            <X size={18} />
          </button>
        </div>

        {/* Invoice line summary */}
        <div className="px-4 py-3 bg-bg border-b border-line flex items-center gap-4 text-xs text-ink-3">
          {item.rawQty !== null && <span><span className="font-medium text-ink-2">{item.rawQty}</span> {item.rawUnit || ''}</span>}
          {item.rawUnitPrice !== null && <span>Unit price: <span className="font-medium text-ink-2">{formatCurrency(Number(item.rawUnitPrice))}</span></span>}
          {item.rawLineTotal !== null && <span>Line total: <span className="font-medium text-ink-2">{formatCurrency(Number(item.rawLineTotal))}</span></span>}
        </div>

        {isNew ? (
          /* ── CREATE_NEW form ──────────────────────────────────────────────── */
          <div className="flex-1 p-4 space-y-4">
            {/* Item name */}
            <div>
              <label className="block text-xs font-medium text-ink-3 mb-1">Item Name</label>
              <input
                value={form.itemName}
                onChange={e => setForm(f => ({ ...f, itemName: e.target.value }))}
                className="w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
              />
            </div>

            {/* Category */}
            <div>
              <label className="block text-xs font-medium text-ink-3 mb-1">Category</label>
              <select
                value={form.category}
                onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                className="w-full border border-line rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gold"
              >
                {ITEM_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>

            {/* Purchase structure */}
            <div>
              <label className="block text-xs font-medium text-ink-3 mb-2">Purchase Structure</label>

              {/* Per Case / Per UOM toggle */}
              <div className="flex gap-2 p-1 bg-bg-2 rounded-xl mb-3">
                {(['CASE', 'UOM'] as const).map(pt => (
                  <button
                    key={pt}
                    type="button"
                    onClick={() => setForm(f => ({
                      ...f,
                      priceType: pt,
                      ...(pt === 'UOM' && !['kg','g','lb','oz','l','ml'].includes(f.packUOM) ? { packUOM: 'kg' } : {}),
                    }))}
                    className={`flex-1 py-2 rounded-lg text-xs font-medium transition-all ${
                      form.priceType === pt
                        ? 'bg-white text-ink shadow-sm'
                        : 'text-ink-3 hover:text-ink-2'
                    }`}
                  >
                    {pt === 'CASE' ? 'Per Case' : 'Per UOM'}
                  </button>
                ))}
              </div>

              {form.priceType === 'CASE' && (
                <div className="space-y-3">
                  <p className="text-[11px] text-ink-4">
                    Example: Meadow Milk 4/4L → Purchase Unit = <em>case</em>, Qty per case = <em>4</em>, Pack size = <em>4</em>, Pack UOM = <em>L</em>
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-ink-3 mb-1">Purchase Unit</label>
                      <input
                        value={form.purchaseUnit}
                        onChange={e => setForm(f => ({ ...f, purchaseUnit: e.target.value }))}
                        placeholder="case, bag, box…"
                        className="w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-ink-3 mb-1">Qty per case</label>
                      <input
                        type="number"
                        step="any"
                        min="0"
                        value={form.qtyPerPurchaseUnit}
                        onChange={e => setForm(f => ({ ...f, qtyPerPurchaseUnit: e.target.value }))}
                        className="w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-ink-3 mb-1">Pack Size</label>
                      <input
                        type="number"
                        step="any"
                        min="0"
                        value={form.packSize}
                        onChange={e => setForm(f => ({ ...f, packSize: e.target.value }))}
                        placeholder="4, 500, 1…"
                        className="w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-ink-3 mb-1">Pack UOM</label>
                      <select
                        value={form.packUOM}
                        onChange={e => setForm(f => ({ ...f, packUOM: e.target.value }))}
                        className="w-full border border-line rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gold"
                      >
                        {PACK_UOMS.map(u => <option key={u} value={u}>{u}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-ink-3 mb-1">Purchase Price ($)</label>
                      <input
                        type="number"
                        step="any"
                        min="0"
                        value={form.purchasePrice}
                        onChange={e => setForm(f => ({ ...f, purchasePrice: e.target.value }))}
                        className="w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-ink-3 mb-1">Count UOM</label>
                      <select
                        value={form.countUOM}
                        onChange={e => setForm(f => ({ ...f, countUOM: e.target.value }))}
                        className="w-full border border-line rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gold"
                      >
                        {COUNT_UOMS.map(u => <option key={u} value={u}>{u}</option>)}
                      </select>
                    </div>
                  </div>
                </div>
              )}

              {form.priceType === 'UOM' && (
                <div className="space-y-3 mt-3">
                  <p className="text-[11px] text-ink-4">
                    Priced by rate (e.g. $/kg). Enter the unit the supplier quotes per.
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-ink-3 mb-1">Price Unit</label>
                      <select
                        value={form.packUOM}
                        onChange={e => setForm(f => ({ ...f, packUOM: e.target.value }))}
                        className="w-full border border-line rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gold"
                      >
                        {(['kg', 'g', 'lb', 'oz', 'l', 'ml']).map(u => <option key={u} value={u}>{u}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-ink-3 mb-1">Price / {form.packUOM} ($)</label>
                      <input
                        type="number" step="any"
                        value={form.purchasePrice}
                        onChange={e => setForm(f => ({ ...f, purchasePrice: e.target.value }))}
                        className="w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-ink-3 mb-1">Count UOM</label>
                      <select
                        value={form.countUOM}
                        onChange={e => setForm(f => ({ ...f, countUOM: e.target.value }))}
                        className="w-full border border-line rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gold"
                      >
                        {COUNT_UOMS.map(u => <option key={u} value={u}>{u}</option>)}
                      </select>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Auto-calculated preview */}
            <div className="bg-gold/10 rounded-lg p-3 space-y-1">
              <p className="text-xs font-semibold text-gold uppercase tracking-wide">Auto-calculated</p>
              <div className="flex justify-between text-xs">
                <span className="text-gold">Base unit:</span>
                <span className="font-medium text-blue-text">{bu}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-gold">Price per {bu}:</span>
                <span className="font-medium text-blue-text">{formatCurrency(ppbu)}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-gold">Total base units per case:</span>
                <span className="font-medium text-blue-text">{(qty * ps).toFixed(2)} {bu}</span>
              </div>
              {cf !== 1 && (
                <div className="flex justify-between text-xs">
                  <span className="text-gold">Conversion factor:</span>
                  <span className="font-medium text-blue-text">{cf.toFixed(4)}</span>
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
                  <Package size={14} className="text-blue" />
                  <span className="font-semibold text-ink text-sm">{item.matchedItem.itemName}</span>
                  {confidenceBadge(item.matchConfidence)}
                </div>

                <div className="bg-bg rounded-xl p-4 space-y-3">
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <p className="text-xs text-ink-4">Purchase Unit</p>
                      <p className="font-medium text-ink">{item.matchedItem.purchaseUnit}</p>
                    </div>
                    <div>
                      <p className="text-xs text-ink-4">Price Type</p>
                      <p className="font-medium text-ink">
                        {item.matchedItem.priceType === 'UOM'
                          ? `Per ${item.matchedItem.packUOM}`
                          : 'Per Case'}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-ink-4">
                        {item.matchedItem.priceType === 'UOM'
                          ? `Current Price / ${item.matchedItem.packUOM}`
                          : 'Current Price'}
                      </p>
                      <p className="font-medium text-ink">{formatCurrency(Number(item.matchedItem.purchasePrice))}</p>
                    </div>
                    <div>
                      <p className="text-xs text-ink-4">Price / Base Unit</p>
                      <p className="font-medium text-ink">{formatCurrency(Number(item.matchedItem.pricePerBaseUnit))}</p>
                    </div>
                  </div>
                </div>

                {item.action === 'UPDATE_PRICE' && item.newPrice !== null && (
                  <div className="bg-gold/10 rounded-xl p-4 space-y-2">
                    <p className="text-xs font-semibold text-gold uppercase tracking-wide">Proposed Price Change</p>
                    <div className="flex items-center gap-3">
                      <div className="text-center">
                        <p className="text-xs text-ink-4">Current</p>
                        <p className="text-lg font-bold text-ink-3">{formatCurrency(Number(item.previousPrice))}</p>
                      </div>
                      <ArrowRight size={16} className="text-ink-4" />
                      <div className="text-center">
                        <p className="text-xs text-ink-4">New</p>
                        <p className="text-lg font-bold text-gold">{formatCurrency(Number(item.newPrice))}</p>
                      </div>
                      {item.priceDiffPct !== null && (
                        <div className={`ml-auto flex items-center gap-1 font-bold text-sm ${Number(item.priceDiffPct) > 0 ? 'text-red' : 'text-green'}`}>
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
        <div className="sticky bottom-0 bg-white border-t border-line px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] flex gap-2">
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
                    priceType:          form.priceType,
                  },
                })
              }}
              className="flex-1 bg-ink text-paper [&_svg]:text-gold rounded-lg py-2 text-sm font-semibold hover:bg-ink-2 transition-colors"
            >
              Save Item Details
            </button>
          )}
          <button
            onClick={onClose}
            className={`${isNew ? '' : 'flex-1'} border border-line text-ink-3 rounded-lg py-2 px-4 text-sm hover:bg-bg transition-colors`}
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
    priceType: 'CASE',
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
          priceType:          data.priceType ?? 'CASE',
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
  const bu   = deriveBaseUnit('each', form.packUOM)
  const ppbu = calcPricePerBaseUnit(pp, qty, 'each', null, ps, form.packUOM, (form.priceType ?? 'CASE') as 'CASE' | 'UOM')

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
          priceType:          form.priceType,
          conversionFactor:   calcConversionFactor(form.countUOM, qty, 'each', null, ps, form.packUOM),
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
        <div
          className="sticky top-0 bg-white border-b border-line px-4 py-3 flex items-center justify-between gap-2"
          style={{ paddingTop: 'calc(0.75rem + env(safe-area-inset-top, 0px))' }}
        >
          <div>
            <p className="text-xs text-ink-4 uppercase tracking-wide font-medium">Edit Inventory Item</p>
            <h3 className="font-semibold text-ink text-sm mt-0.5 truncate">{form.itemName || '…'}</h3>
          </div>
          <button onClick={onClose} className="p-2.5 flex items-center justify-center text-ink-4 hover:text-ink-3"><X size={18} /></button>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 size={24} className="animate-spin text-blue" />
          </div>
        ) : (
          <div className="flex-1 p-4 space-y-4">
            {/* Item Name */}
            <div>
              <label className="block text-xs font-medium text-ink-3 mb-1">Item Name</label>
              <input value={form.itemName} onChange={e => setForm(f => ({ ...f, itemName: e.target.value }))}
                className="w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
            </div>

            {/* Category + Abbreviation */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-ink-3 mb-1">Category</label>
                <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                  className="w-full border border-line rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gold">
                  {ITEM_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-3 mb-1">Abbreviation</label>
                <input value={form.abbreviation} onChange={e => setForm(f => ({ ...f, abbreviation: e.target.value }))}
                  placeholder="optional"
                  className="w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
              </div>
            </div>

            {/* Purchase Structure */}
            <div>
              <label className="block text-xs font-medium text-ink-3 mb-2">Purchase Structure</label>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-ink-3 mb-1">Purchase Unit</label>
                  <input value={form.purchaseUnit} onChange={e => setForm(f => ({ ...f, purchaseUnit: e.target.value }))}
                    placeholder="case, bag…"
                    className="w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                </div>
                <div>
                  <label className="block text-xs text-ink-3 mb-1">Qty per case</label>
                  <input type="number" step="any" min="0" value={form.qtyPerPurchaseUnit}
                    onChange={e => setForm(f => ({ ...f, qtyPerPurchaseUnit: e.target.value }))}
                    className="w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                </div>
                <div>
                  <label className="block text-xs text-ink-3 mb-1">Pack Size</label>
                  <input type="number" step="any" min="0" value={form.packSize}
                    onChange={e => setForm(f => ({ ...f, packSize: e.target.value }))}
                    className="w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                </div>
                <div>
                  <label className="block text-xs text-ink-3 mb-1">Pack UOM</label>
                  <select value={form.packUOM} onChange={e => setForm(f => ({ ...f, packUOM: e.target.value }))}
                    className="w-full border border-line rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gold">
                    {PACK_UOMS.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-ink-3 mb-1">Purchase Price ($)</label>
                  <input type="number" step="any" min="0" value={form.purchasePrice}
                    onChange={e => setForm(f => ({ ...f, purchasePrice: e.target.value }))}
                    className="w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                </div>
                <div>
                  <label className="block text-xs text-ink-3 mb-1">Count UOM</label>
                  <select value={form.countUOM} onChange={e => setForm(f => ({ ...f, countUOM: e.target.value }))}
                    className="w-full border border-line rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gold">
                    {COUNT_UOMS.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
              </div>
            </div>

            {/* Auto-calculated preview */}
            <div className="bg-green-soft rounded-lg p-3 space-y-1">
              <p className="text-xs font-semibold text-green-text uppercase tracking-wide">Auto-calculated</p>
              <div className="flex justify-between text-xs">
                <span className="text-green">Base unit:</span>
                <span className="font-medium text-green-text">{bu}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-green">Price per {bu}:</span>
                <span className="font-medium text-green-text">{formatCurrency(ppbu)}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-green">Total base units:</span>
                <span className="font-medium text-green-text">{(qty * ps).toFixed(2)} {bu}</span>
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="sticky bottom-0 bg-white border-t border-line px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] flex gap-2">
          <button
            onClick={handleSave}
            disabled={saving || loading}
            className="flex-1 bg-green text-white rounded-lg py-2 text-sm font-semibold hover:bg-green transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
            {saving ? 'Saving…' : 'Save & Update Prices'}
          </button>
          <button onClick={onClose}
            className="border border-line text-ink-3 rounded-lg py-2 px-4 text-sm hover:bg-bg transition-colors">
            Cancel
          </button>
        </div>
      </div>
    </>
  )
}

// ── InvoiceImageViewer ────────────────────────────────────────────────────────

export function InvoiceImageViewer({ files }: { files: Array<{ id: string; fileName: string; fileType: string; fileUrl: string }> }) {
  const [activeIdx, setActiveIdx] = useState(0)
  const file = files[activeIdx]
  const isPdf = file?.fileType === 'application/pdf' || file?.fileName?.endsWith('.pdf')
  const isImage = file?.fileType?.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif)$/i.test(file?.fileName ?? '')

  // Per-file viewer state (resets when switching pages)
  const [zoom, setZoom] = useState(1)
  const [rotation, setRotation] = useState(0)   // 0 / 90 / 180 / 270
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const dragStart = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Reset transforms when switching files
  useEffect(() => {
    setZoom(1); setRotation(0); setPan({ x: 0, y: 0 })
  }, [activeIdx])

  const ZOOM_STEP = 0.25
  const ZOOM_MIN = 0.25
  const ZOOM_MAX = 5
  const zoomIn  = () => setZoom(z => Math.min(ZOOM_MAX, +(z + ZOOM_STEP).toFixed(2)))
  const zoomOut = () => setZoom(z => Math.max(ZOOM_MIN, +(z - ZOOM_STEP).toFixed(2)))
  const rotateRight = () => setRotation(r => (r + 90) % 360)
  const rotateLeft  = () => setRotation(r => (r + 270) % 360)
  const reset = () => { setZoom(1); setRotation(0); setPan({ x: 0, y: 0 }) }

  const fitWidth = () => {
    const el = containerRef.current
    if (!el) return
    // Image natural size unknown without onLoad; just zoom to 1 and let max-w-full handle it
    setZoom(1); setRotation(0); setPan({ x: 0, y: 0 })
  }

  // Mouse wheel zoom (Ctrl/Cmd + scroll for safety, plain scroll passes through)
  const handleWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    if (e.deltaY < 0) zoomIn(); else zoomOut()
  }

  // Drag-to-pan when zoomed
  const handleMouseDown = (e: React.MouseEvent) => {
    if (zoom <= 1) return
    setIsDragging(true)
    dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y }
  }
  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || !dragStart.current) return
    setPan({
      x: dragStart.current.panX + (e.clientX - dragStart.current.x),
      y: dragStart.current.panY + (e.clientY - dragStart.current.y),
    })
  }
  const stopDrag = () => { setIsDragging(false); dragStart.current = null }

  const Btn = ({ onClick, children, title, disabled }: { onClick: () => void; children: React.ReactNode; title: string; disabled?: boolean }) => (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className="p-1.5 rounded-md text-ink-3 hover:bg-bg-2 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
    >
      {children}
    </button>
  )

  return (
    <div className="flex flex-col bg-bg shrink-0 w-full sm:w-[460px]">
      {/* File tabs (only if multiple files) */}
      {files.length > 1 && (
        <div className="flex gap-1 px-3 py-2 border-b border-line bg-white overflow-x-auto shrink-0">
          {files.map((f, i) => (
            <button
              key={f.id}
              onClick={() => setActiveIdx(i)}
              className={`px-3 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
                activeIdx === i ? 'bg-gold/15 text-gold' : 'text-ink-3 hover:bg-bg-2'
              }`}
            >
              Page {i + 1}
            </button>
          ))}
        </div>
      )}

      {/* Toolbar — only for images (PDFs use browser-native controls inside iframe) */}
      {isImage && file?.fileUrl && (
        <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-line bg-white shrink-0">
          <Btn onClick={zoomOut} title="Zoom out (Cmd/Ctrl + scroll)" disabled={zoom <= ZOOM_MIN}><Minus size={14} /></Btn>
          <span className="text-xs font-mono text-ink-3 w-12 text-center select-none">{Math.round(zoom * 100)}%</span>
          <Btn onClick={zoomIn} title="Zoom in" disabled={zoom >= ZOOM_MAX}><Plus size={14} /></Btn>
          <div className="w-px h-4 bg-line mx-1" />
          <Btn onClick={rotateLeft} title="Rotate left"><RotateCcw size={14} /></Btn>
          <Btn onClick={rotateRight} title="Rotate right"><RotateCw size={14} /></Btn>
          <div className="w-px h-4 bg-line mx-1" />
          <Btn onClick={fitWidth} title="Fit to width"><Maximize2 size={14} /></Btn>
          <button
            onClick={reset}
            className="px-2 py-1 ml-auto rounded-md text-[11px] font-medium text-ink-3 hover:text-ink-2 hover:bg-bg-2 transition-colors"
            title="Reset view"
          >
            Reset
          </button>
        </div>
      )}

      {/* Image/PDF display */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden flex items-start justify-center p-4 select-none relative"
        style={{ cursor: isImage && zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default' }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={stopDrag}
        onMouseLeave={stopDrag}
      >
        {isImage && file?.fileUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={file.fileUrl}
            alt={file.fileName}
            draggable={false}
            className="max-w-full rounded-lg shadow-sm border border-line object-contain transition-transform duration-100"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rotation}deg)`,
              transformOrigin: 'center center',
            }}
          />
        ) : isPdf && file?.fileUrl ? (
          <iframe
            src={file.fileUrl}
            title={file.fileName}
            className="w-full rounded-lg border border-line bg-white"
            style={{ height: '100%', minHeight: '600px' }}
          />
        ) : (
          <div className="flex flex-col items-center justify-center gap-3 text-ink-4 h-full">
            <FileText size={40} className="text-ink-4" />
            <p className="text-sm">{file?.fileName ?? 'No file'}</p>
            {file?.fileUrl && (
              <a href={file.fileUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue hover:underline">
                Open file ↗
              </a>
            )}
          </div>
        )}
      </div>

      {/* File name footer */}
      <div className="px-3 py-2 border-t border-line bg-white shrink-0">
        <p className="text-[10px] text-ink-4 truncate">{file?.fileName}</p>
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
  const [isRetrying, setIsRetrying] = useState(false)
  // Map of inventoryItemId → recent price points, used for inline sparklines
  const [priceHistoryMap, setPriceHistoryMap] = useState<Record<string, PricePoint[]>>({})
  const [approvedBy, setApprovedBy] = useState(() =>
    typeof window !== 'undefined' ? localStorage.getItem('approvedBy') ?? '' : ''
  )
  const [editingItem, setEditingItem] = useState<ScanItem | null>(null)
  const [editingInventory, setEditingInventory] = useState<{ inventoryItemId: string; scanItem: ScanItem } | null>(null)
  const [isAddingItem, setIsAddingItem] = useState(false)
  const [open, setOpen] = useState(false)
  const [mobileTab, setMobileTab] = useState<'review' | 'image'>('review')
  const [statusFilter, setStatusFilter] = useState<ItemStatus | 'ALL'>('ALL')
  const [compactOk, setCompactOk] = useState(true)
  const [sortMode, setSortMode] = useState<'invoice' | 'alerts'>('invoice')
  const [editRequest, setEditRequest] = useState<{ id: string | null; tick: number }>({ id: null, tick: 0 })

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
    const res = await fetch(`/api/invoices/sessions/${id}`)
    if (!res.ok) {
      console.error('fetchSession failed', res.status, await res.text().catch(() => ''))
      return null
    }
    const data: Session = await res.json()
    if (!data?.status) {
      console.error('fetchSession returned unexpected data', data)
      return null
    }
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
      setPriceHistoryMap({})
      fetchSession(sessionId)
    } else {
      setOpen(false)
      // Give animation time to complete before clearing session
      const t = setTimeout(() => { setSession(null); setPriceHistoryMap({}) }, 200)
      return () => clearTimeout(t)
    }
  }, [sessionId, fetchSession])

  // Batch-fetch price history once we have matched item IDs.
  // Re-fetches when the matched-item set changes (e.g. user changes a match).
  useEffect(() => {
    if (!session) return
    const ids = Array.from(new Set(
      session.scanItems.map(i => i.matchedItemId).filter((x): x is string => !!x)
    ))
    if (ids.length === 0) return
    // Skip ids already loaded
    const missing = ids.filter(id => !(id in priceHistoryMap))
    if (missing.length === 0) return
    let cancelled = false
    fetch(`/api/inventory/price-history?ids=${encodeURIComponent(missing.join(','))}`)
      .then(r => r.ok ? r.json() : {})
      .then((data: Record<string, PricePoint[]>) => {
        if (cancelled) return
        setPriceHistoryMap(prev => ({ ...prev, ...data }))
      })
      .catch(() => {})
    return () => { cancelled = true }
    // We intentionally only depend on the set of matched ids, not priceHistoryMap,
    // to avoid re-fetching every time the map updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [(session?.scanItems ?? []).map(i => i.matchedItemId).filter(Boolean).sort().join(',')])

  // Poll while uploading, processing, or approving
  useEffect(() => {
    const shouldPoll = session?.status === 'PROCESSING' || session?.status === 'UPLOADING' || session?.status === 'APPROVING'
    if (shouldPoll) {
      pollRef.current = setInterval(async () => {
        const s = await fetchSession(session!.id)
        if (!s || (s.status !== 'PROCESSING' && s.status !== 'UPLOADING' && s.status !== 'APPROVING')) {
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

    // Block approval if scanned items don't match the invoice's stated subtotal
    // / total by more than $5 — usually means a missing line item, OCR'd
    // qty / price wrong, or the wrong invoice was uploaded.
    const WV = new Set(['kg', 'g', 'lb', 'oz', 'l', 'ml'])
    const scannedTotal = session.scanItems
      .filter(i => i.action !== 'SKIP')
      .reduce((sum, i) => {
        if (i.rawLineTotal !== null) return sum + Number(i.rawLineTotal)
        if (i.rawQty !== null && i.rawUnitPrice !== null) {
          const wv = !!i.invoicePackUOM && WV.has(i.invoicePackUOM.toLowerCase())
          const lt = wv && i.invoicePackQty && i.invoicePackSize
            ? Number(i.rawQty) * Number(i.invoicePackQty) * Number(i.invoicePackSize) * Number(i.rawUnitPrice)
            : Number(i.rawQty) * Number(i.rawUnitPrice)
          return sum + lt
        }
        return sum
      }, 0)
    const sub  = session.subtotal ? Number(session.subtotal) : null
    const tot  = session.total    ? Number(session.total)    : null
    const target = sub ?? tot
    if (target !== null && Math.abs(target - scannedTotal) > 5) {
      const fmt = (n: number) => `$${n.toFixed(2)}`
      const ok = window.confirm(
        `Heads up: scanned items add up to ${fmt(scannedTotal)} but the invoice ${sub ? 'subtotal' : 'total'} on file is ${fmt(target)} — a difference of ${fmt(Math.abs(target - scannedTotal))}.\n\nThis usually means a line item is missing, an OCR price is wrong, or the wrong invoice was uploaded.\n\nApprove anyway?`
      )
      if (!ok) return
    }

    setIsApproving(true)
    try {
      const res = await fetch(`/api/invoices/sessions/${session.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const result = await res.json()
      if (!res.ok) {
        alert(`Approval failed: ${result.error ?? res.statusText}`)
        return
      }
      if (result.queued) {
        // Background approval started — close drawer so user can review other invoices
        onApproveOrReject()
        onClose()
      } else {
        setApproveResult(result)
        onApproveOrReject()
      }
    } catch (err) {
      alert('Network error — please try again.')
    } finally {
      setIsApproving(false)
    }
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
  const drawerState: 'loading' | 'processing' | 'approving' | 'review' | 'done' | 'error' =
    approveResult ? 'done'
    : !session ? 'loading'
    : session.status === 'PROCESSING' ? 'processing'
    : session.status === 'UPLOADING' ? 'processing'
    : session.status === 'APPROVING' ? 'approving'
    : session.status === 'REVIEW' ? 'review'
    : (session.status === 'APPROVED' || session.status === 'REJECTED') ? 'done'
    : session.status === 'ERROR' ? 'error'
    : 'loading'

  const isReview = drawerState === 'review'

  if (!sessionId && !open && !session) return null

  // ── renderProcessing ────────────────────────────────────────────────────────

  const renderProcessing = () => (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-xl mx-auto space-y-6 text-center">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gold/15 animate-pulse mb-2">
          <ScanLine size={32} className="text-gold" />
        </div>
        <h2 className="text-xl font-bold text-ink">Scanning Invoice…</h2>
        {(session?.supplierName || session?.invoiceDate || session?.invoiceNumber) && (
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 mt-1">
            {session.supplierName && (
              <span className="text-sm font-semibold text-ink-2">{session.supplierName}</span>
            )}
            {session.invoiceDate && (
              <span className="text-sm text-ink-3">
                {new Date(session.invoiceDate + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}
              </span>
            )}
            {session.invoiceNumber && (
              <span className="text-xs text-ink-4">#{session.invoiceNumber}</span>
            )}
          </div>
        )}
        <p className="text-sm text-ink-3">
          {session?.files && session.files.length > 1
            ? `Sending all ${session.files.length} pages to Claude at once — usually 15–30 seconds.`
            : 'Claude is reading and extracting line items. Usually 10–20 seconds.'}
        </p>

        <div className="bg-white rounded-xl border border-line divide-y divide-line text-left">
          {session?.files.map(f => (
            <div key={f.id} className="flex items-center gap-3 px-4 py-3">
              {fileIcon(f.fileType)}
              <span className="flex-1 text-sm text-ink-2 truncate">{f.fileName}</span>
              {ocrStatusBadge(f.ocrStatus)}
            </div>
          ))}
        </div>

        <div className="flex items-center justify-center gap-3">
          <div className="flex items-center gap-2 text-sm text-ink-4">
            <Loader2 size={14} className="animate-spin" />
            Processing…
          </div>
          <button
            onClick={handleCancelProcessing}
            disabled={isCancelling}
            className="flex items-center gap-1.5 text-sm text-red hover:text-red-text border border-red-soft hover:border-red rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50"
          >
            {isCancelling ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />}
            {isCancelling ? 'Cancelling…' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  )

  // ── renderApproving ─────────────────────────────────────────────────────────

  const handleResetApproving = async () => {
    if (!session) return
    await fetch(`/api/invoices/sessions/${session.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'REVIEW' }),
    })
    await fetchSession(session.id)
  }

  const renderApproving = () => (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-xl mx-auto space-y-6 text-center">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gold-soft animate-pulse mb-2">
          <CheckCircle2 size={32} className="text-gold" />
        </div>
        <h2 className="text-xl font-bold text-ink">Applying Invoice…</h2>
        <p className="text-sm text-ink-3">
          Updating inventory prices and recipe costs in the background. You can work on other invoices.
        </p>
        <div className="flex items-center justify-center gap-2 text-sm text-ink-4">
          <Loader2 size={14} className="animate-spin" />
          Working…
        </div>
        <button
          onClick={handleResetApproving}
          className="text-xs text-ink-4 underline hover:text-ink-3 mt-4"
        >
          Stuck? Reset to review
        </button>
      </div>
    </div>
  )

  // ── renderError ─────────────────────────────────────────────────────────────

  const handleRetry = async () => {
    if (!session) return
    setIsRetrying(true)
    await fetch(`/api/invoices/sessions/${session.id}/process`, { method: 'POST' })
    await fetchSession(session.id)
    setIsRetrying(false)
  }

  const renderError = () => (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-xl mx-auto space-y-6 text-center">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-red-soft mb-2">
          <AlertCircle size={32} className="text-red" />
        </div>
        <h2 className="text-xl font-bold text-ink">Scan Failed</h2>
        {session?.errorMessage && (
          <p className="text-sm text-red bg-red-soft border border-red-soft rounded-xl px-4 py-3 text-left">
            {session.errorMessage}
          </p>
        )}
        <p className="text-sm text-ink-3">
          You can retry the scan or delete this session and try again.
        </p>
        <button
          onClick={handleRetry}
          disabled={isRetrying}
          className="flex items-center gap-2 mx-auto px-5 py-2.5 bg-ink text-paper [&_svg]:text-gold rounded-xl font-semibold text-sm hover:bg-ink-2 disabled:opacity-50 transition-colors"
        >
          {isRetrying ? <Loader2 size={15} className="animate-spin" /> : <RotateCcw size={15} />}
          {isRetrying ? 'Retrying…' : 'Retry Scan'}
        </button>
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

    // Status taxonomy counts (for filter chips). Uses the same getItemStatus()
    // helper as the cards so badges and chips always agree.
    const statusOf = session.scanItems.map(i => ({ id: i.id, kind: getItemStatus(i).kind }))
    const statusCounts: Record<ItemStatus, number> = {
      OK: 0, PRICE_SMALL: 0, PRICE_BIG: 0, NEW: 0, UNMATCHED: 0, SKIPPED: 0,
    }
    for (const s of statusOf) statusCounts[s.kind]++
    const filteredItems = (() => {
      const base = statusFilter === 'ALL'
        ? session.scanItems
        : session.scanItems.filter(i => getItemStatus(i).kind === statusFilter)
      if (sortMode === 'invoice') return base
      // 'alerts' sort: most-attention-needed first, ties broken by invoice order.
      const priority: Record<ItemStatus, number> = {
        PRICE_BIG: 0, UNMATCHED: 1, NEW: 2, PRICE_SMALL: 3, OK: 4, SKIPPED: 5,
      }
      return [...base].sort((a, b) => {
        const pa = priority[getItemStatus(a).kind]
        const pb = priority[getItemStatus(b).kind]
        if (pa !== pb) return pa - pb
        return a.sortOrder - b.sortOrder
      })
    })()

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
          <div className="bg-white rounded-2xl border border-line shadow-sm overflow-hidden">

            {/* Invoice header band */}
            <div className="bg-gradient-to-r from-ink-2 to-ink px-5 py-4 text-white">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] font-bold text-ink-4 uppercase tracking-widest mb-0.5">Invoice Review</p>
                  <h2 className="text-lg font-bold leading-tight truncate">{session.supplierName || 'Unknown Supplier'}</h2>
                </div>
                <div className="text-right shrink-0 flex flex-col items-end gap-1">
                  {session.invoiceNumber && !editingHeader && (
                    <div className="flex items-center gap-1 justify-end text-ink-4 text-xs">
                      <Hash size={10} /><span className="font-mono font-semibold text-white">{session.invoiceNumber}</span>
                    </div>
                  )}
                  {session.total && !editingHeader && (
                    <div className="text-xl font-bold text-white">{formatCurrency(Number(session.total))}</div>
                  )}
                  {(session.subtotal || session.tax) && !editingHeader && (
                    <div className="flex items-center gap-2 text-[10px] text-ink-4">
                      {session.subtotal && <span>Sub: {formatCurrency(Number(session.subtotal))}</span>}
                      {session.tax && <span>Tax: {formatCurrency(Number(session.tax))}</span>}
                    </div>
                  )}
                  {!editingHeader && (
                    <button
                      onClick={openHeaderEdit}
                      className="mt-1 flex items-center gap-1 text-ink-4 hover:text-white text-[10px] transition-colors"
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
                      <label className="block text-[10px] text-ink-4 mb-0.5 font-semibold uppercase tracking-wide">Invoice #</label>
                      <input
                        value={headerNumber}
                        onChange={e => setHeaderNumber(e.target.value)}
                        placeholder="e.g. INV-1234"
                        className="w-full bg-ink-3/60 border border-ink-3 rounded-lg px-2 py-1.5 text-sm text-white placeholder-ink-4 focus:outline-none focus:border-blue"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] text-ink-4 mb-0.5 font-semibold uppercase tracking-wide">Date</label>
                      <input
                        type="date"
                        value={headerDate}
                        onChange={e => setHeaderDate(e.target.value)}
                        className="w-full bg-ink-3/60 border border-ink-3 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-blue"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[10px] text-ink-4 mb-0.5 font-semibold uppercase tracking-wide">Subtotal ($)</label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={headerSubtotal}
                        onChange={e => setHeaderSubtotal(e.target.value)}
                        placeholder="0.00"
                        className="w-full bg-ink-3/60 border border-ink-3 rounded-lg px-2 py-1.5 text-sm text-white placeholder-ink-4 focus:outline-none focus:border-blue"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] text-ink-4 mb-0.5 font-semibold uppercase tracking-wide">Tax ($)</label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={headerTax}
                        onChange={e => setHeaderTax(e.target.value)}
                        placeholder="0.00"
                        className="w-full bg-ink-3/60 border border-ink-3 rounded-lg px-2 py-1.5 text-sm text-white placeholder-ink-4 focus:outline-none focus:border-blue"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-[10px] text-ink-4 mb-0.5 font-semibold uppercase tracking-wide">Invoice Total ($)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={headerTotal}
                      onChange={e => setHeaderTotal(e.target.value)}
                      placeholder="0.00"
                      className="w-full bg-ink-3/60 border border-ink-3 rounded-lg px-2 py-1.5 text-sm text-white placeholder-ink-4 focus:outline-none focus:border-blue"
                    />
                  </div>
                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={() => setEditingHeader(false)}
                      className="flex-1 py-1.5 rounded-lg text-xs font-medium text-ink-4 hover:text-white border border-ink-3 hover:border-line-2 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={saveHeader}
                      disabled={savingHeader}
                      className="flex-[2] py-1.5 rounded-lg text-xs font-semibold bg-gold hover:bg-gold/100 text-white disabled:opacity-50 transition-colors"
                    >
                      {savingHeader ? 'Saving…' : 'Save changes'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-5 mt-3 text-xs">
                  {session.invoiceDate && (
                    <div className="flex items-center gap-1 text-ink-4">
                      <CalendarDays size={11} />
                      <span>{session.invoiceDate}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-1 text-ink-4">
                    <Package size={11} />
                    <span>{totalItems} line item{totalItems !== 1 ? 's' : ''}</span>
                  </div>
                  {actionCounts['UPDATE_PRICE'] > 0 && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-gold/20 text-[#fcd34d] border border-gold/30">
                      {actionCounts['UPDATE_PRICE']} price update{actionCounts['UPDATE_PRICE'] !== 1 ? 's' : ''}
                    </span>
                  )}
                  {actionCounts['CREATE_NEW'] > 0 && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue/20 text-[#93c5fd] border border-blue/30">
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
                <div className="border-b border-line">
                  {linkedSupplierId && linked ? (
                    <div className="flex items-center gap-3 px-4 py-2 bg-green-soft">
                      <Building2 size={14} className="text-green shrink-0" />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-semibold text-ink">{linked.name}</span>
                        <span className="ml-2 text-xs text-ink-4">
                          {supplierLinkMode === 'auto' ? '✓ auto-matched' : '(linked)'}
                        </span>
                      </div>
                      <button
                        onClick={() => { loadSuppliers(); setSupplierComboOpen(true) }}
                        className="text-xs text-gold hover:text-blue-text shrink-0 flex items-center gap-0.5"
                      >
                        Change <ChevronDown size={12} />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 px-4 py-2 bg-gold-soft">
                      <AlertTriangle size={14} className="text-gold shrink-0" />
                      <p className="flex-1 min-w-0 text-xs text-ink-2 truncate">
                        {ocrName
                          ? <><span className="font-mono font-semibold">&ldquo;{ocrName}&rdquo;</span> — link to a supplier</>
                          : 'No supplier detected — link to a supplier'}
                      </p>
                      <button
                        onClick={() => { loadSuppliers(); setSupplierComboOpen(true) }}
                        className="text-xs font-semibold text-gold hover:text-blue-text shrink-0 flex items-center gap-0.5"
                      >
                        Link <ArrowRight size={12} />
                      </button>
                    </div>
                  )}

                  {supplierComboOpen && (
                    <div className="bg-white border border-line rounded-lg shadow-lg mx-4 mb-2 overflow-hidden">
                      <input
                        autoFocus
                        value={supplierSearch}
                        onChange={e => setSupplierSearch(e.target.value)}
                        placeholder="Search suppliers…"
                        className="w-full px-3 py-2 text-sm border-b border-line focus:outline-none"
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
                              className="w-full text-left px-3 py-2 text-sm hover:bg-gold/10 transition-colors"
                            >
                              <span className="font-medium text-ink">{s.name}</span>
                              {s.aliases && s.aliases.length > 0 && (
                                <span className="ml-2 text-xs text-ink-4 font-mono">
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
                          className="w-full text-left px-3 py-2 text-sm text-gold hover:bg-gold/10 border-t border-line font-semibold transition-colors"
                        >
                          + Create &ldquo;{session.supplierName || 'new supplier'}&rdquo; as new supplier
                        </button>
                      </div>
                      <button
                        onClick={() => setSupplierComboOpen(false)}
                        className="w-full py-1.5 text-xs text-ink-4 hover:bg-bg border-t border-line"
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
              <div className="flex items-center gap-3 px-4 py-2 border-b border-line bg-bg">
                <span className="text-xs text-ink-3 shrink-0">Revenue Center:</span>
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
                  className="text-xs border border-line rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-gold bg-white"
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
              <div className="flex items-start gap-2 px-4 py-2.5 bg-red-soft border-b border-red-soft">
                <AlertTriangle size={14} className="text-red mt-0.5 shrink-0" />
                <div className="text-xs text-red-text">
                  <span className="font-semibold">Possible duplicate.</span>{' '}
                  Invoice #{session.invoiceNumber} was already scanned
                  {duplicateSessions[0].invoiceDate ? ` on ${duplicateSessions[0].invoiceDate}` : ''}
                  {duplicateSessions[0].supplierName ? ` from ${duplicateSessions[0].supplierName}` : ''}{' '}
                  <span className={`font-semibold ${
                    duplicateSessions[0].status === 'APPROVED' ? 'text-green-text' :
                    duplicateSessions[0].status === 'REJECTED' ? 'text-red-text' : 'text-gold-2'
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
                  subtotalIsOver ? 'bg-red-soft border-red-soft' :
                  subtotalIsOk   ? 'bg-green-soft border-green-soft' :
                                   'bg-bg border-line'
                }`}>
                  <div className="flex items-center gap-2 flex-1 flex-wrap">
                    <span className="text-ink-3">Scanned:</span>
                    <span className={`font-bold ${subtotalIsOver ? 'text-red-text' : 'text-ink-2'}`}>{formatCurrency(scannedTotal)}</span>
                    {ocrSubtotal !== null && (
                      <>
                        <span className="text-ink-4">·</span>
                        <span className="text-ink-3">Subtotal:</span>
                        <span className="font-bold text-ink-2">{formatCurrency(ocrSubtotal)}</span>
                      </>
                    )}
                    {ocrTax !== null && (
                      <>
                        <span className="text-ink-4">·</span>
                        <span className="text-ink-3">Tax:</span>
                        <span className="font-bold text-ink-2">{formatCurrency(ocrTax)}</span>
                      </>
                    )}
                    {invoiceTotal !== null && (
                      <>
                        <span className="text-ink-4">·</span>
                        <span className="text-ink-3">{ocrSubtotal ? 'Total:' : 'Invoice total:'}</span>
                        <span className="font-bold text-ink-2">{formatCurrency(invoiceTotal)}</span>
                      </>
                    )}
                    {subtotalDiff !== null && !subtotalIsOk && (
                      <>
                        <span className="text-ink-4">·</span>
                        <span className={`font-medium ${subtotalIsOver ? 'text-red' : 'text-ink-4'}`}>
                          {subtotalIsOver
                            ? `⚠ Items exceed by ${formatCurrency(Math.abs(subtotalDiff))}`
                            : ocrSubtotal
                              ? `${formatCurrency(subtotalDiff)} unscanned`
                              : `${formatCurrency(subtotalDiff)} in taxes/fees`}
                        </span>
                      </>
                    )}
                  </div>
                  {subtotalIsOk && <span className="text-green font-semibold">✓ Match</span>}
                </div>
              )
            })()}

            {/* Filter chips + sort toggle + view options */}
            {session.scanItems.length > 0 && (() => {
              const Chip = ({ value, label, count, dot }: { value: ItemStatus | 'ALL'; label: string; count: number; dot?: string }) => (
                count === 0 && value !== 'ALL' ? null : (
                  <button
                    onClick={() => setStatusFilter(value)}
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors border ${
                      statusFilter === value
                        ? 'bg-ink text-white border-ink'
                        : 'bg-white text-ink-3 border-line hover:bg-bg'
                    }`}
                  >
                    {dot && <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />}
                    {label} <span className={statusFilter === value ? 'text-ink-4' : 'text-ink-4'}>{count}</span>
                  </button>
                )
              )
              return (
                <div className="px-3 py-2 flex items-center gap-1.5 flex-wrap border-t border-line bg-bg/50">
                  <Chip value="ALL"          label="All"        count={totalItems} />
                  <Chip value="OK"           label="Unchanged"  count={statusCounts.OK}          dot="bg-green" />
                  <Chip value="PRICE_SMALL"  label="Price Δ"    count={statusCounts.PRICE_SMALL} dot="bg-gold" />
                  <Chip value="PRICE_BIG"    label="Price ↑↑"   count={statusCounts.PRICE_BIG}   dot="bg-red" />
                  <Chip value="NEW"          label="New"        count={statusCounts.NEW}         dot="bg-blue" />
                  <Chip value="UNMATCHED"    label="Unmatched"  count={statusCounts.UNMATCHED}   dot="bg-line-2" />
                  <Chip value="SKIPPED"      label="Skipped"    count={statusCounts.SKIPPED}     dot="bg-line-2" />

                  <div className="ml-auto flex items-center gap-2.5">
                    {/* Sort toggle */}
                    <button
                      onClick={() => setSortMode(sortMode === 'invoice' ? 'alerts' : 'invoice')}
                      className="flex items-center gap-1 text-[11px] text-ink-3 hover:text-ink-2 transition-colors"
                      title={sortMode === 'invoice' ? 'Showing in invoice order' : 'Showing alerts first'}
                    >
                      {sortMode === 'invoice' ? '⇣ Invoice order' : '⚠ Alerts first'}
                    </button>

                    {statusCounts.OK > 0 && (
                      <label className="flex items-center gap-1.5 text-[11px] text-ink-3 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={compactOk}
                          onChange={e => setCompactOk(e.target.checked)}
                          className="w-3 h-3 rounded border-line-2 text-ink-2 focus:ring-1 focus:ring-gold"
                        />
                        Compact unchanged
                      </label>
                    )}
                  </div>
                </div>
              )
            })()}

            {/* Contextual bulk action bar — appears when filter is active */}
            {statusFilter !== 'ALL' && filteredItems.length > 0 && (() => {
              const filterLabel = ({
                OK: 'unchanged', PRICE_SMALL: 'with small price changes',
                PRICE_BIG: 'with big price changes', NEW: 'new', UNMATCHED: 'unmatched',
                SKIPPED: 'skipped',
              } as Record<ItemStatus, string>)[statusFilter as ItemStatus]
              const isSkipped = statusFilter === 'SKIPPED'
              const handleBulkSkip = async () => {
                const visibleIds = filteredItems.map(i => i.id)
                await Promise.all(visibleIds.map(id =>
                  fetch(`/api/invoices/sessions/${session.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ scanItemId: id, action: 'SKIP' }),
                  })
                ))
                await fetchSession(session.id)
              }
              const handleBulkRestore = async () => {
                const visibleIds = filteredItems.map(i => i.id)
                await Promise.all(visibleIds.map(id => {
                  const it = filteredItems.find(x => x.id === id)
                  const restoreAction: LineItemAction = it?.matchedItemId ? 'UPDATE_PRICE' : 'CREATE_NEW'
                  return fetch(`/api/invoices/sessions/${session.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ scanItemId: id, action: restoreAction }),
                  })
                }))
                await fetchSession(session.id)
              }
              return (
                <div className="px-3 py-2 flex items-center gap-2 border-t border-gold-soft bg-gold-soft/40 text-[11px]">
                  <span className="text-ink-3">
                    Showing <span className="font-semibold text-ink-2">{filteredItems.length}</span> {filterLabel} item{filteredItems.length !== 1 ? 's' : ''}.
                  </span>
                  {isSkipped ? (
                    <button onClick={handleBulkRestore}
                      className="ml-auto px-2.5 py-1 rounded-md bg-white border border-line text-ink-2 hover:bg-bg text-[11px] font-medium">
                      Restore all
                    </button>
                  ) : (
                    <button onClick={handleBulkSkip}
                      className="ml-auto px-2.5 py-1 rounded-md bg-white border border-red-soft text-red hover:bg-red-soft text-[11px] font-medium">
                      Skip all {filterLabel}
                    </button>
                  )}
                </div>
              )
            })()}

            {/* Line items — invoice order preserved */}
            <div className="divide-y divide-line">
              {filteredItems.map(item => (
                <div key={item.id} className="px-3 py-0.5">
                  <ScanItemCard
                    item={item}
                    onUpdate={(updates) => updateScanItem(item.id, updates)}
                    onOpenDetail={() => setEditingItem(item)}
                    onEditInventory={(invId, scanItem) => setEditingInventory({ inventoryItemId: invId, scanItem })}
                    revenueCenters={revenueCenters}
                    sessionRcId={sessionRcId}
                    onRcChange={(rcId) => updateScanItem(item.id, { revenueCenterId: rcId })}
                    compactOk={compactOk}
                    priceHistory={item.matchedItemId ? priceHistoryMap[item.matchedItemId] : undefined}
                    editRequestId={editRequest.id}
                    editRequestTick={editRequest.tick}
                    onRequestNextAttention={(currentId) => {
                      const ATTENTION = new Set<ItemStatus>(['PRICE_BIG', 'UNMATCHED', 'NEW', 'PRICE_SMALL'])
                      const idx = filteredItems.findIndex(i => i.id === currentId)
                      const search = [...filteredItems.slice(idx + 1), ...filteredItems.slice(0, idx)]
                      const next = search.find(i => ATTENTION.has(getItemStatus(i).kind))
                      if (next) {
                        setEditRequest({ id: next.id, tick: Date.now() })
                        setTimeout(() => {
                          document.getElementById(`scanitem-${next.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                        }, 50)
                      }
                    }}
                  />
                </div>
              ))}
              {filteredItems.length === 0 && session.scanItems.length > 0 && (
                <div className="py-8 text-center text-sm text-ink-4">
                  No items in this filter. <button onClick={() => setStatusFilter('ALL')} className="text-blue hover:underline">Show all</button>
                </div>
              )}
              {session.scanItems.length === 0 && (
                <div className="py-8 text-center text-sm text-ink-4">
                  {session.files?.some(f => f.ocrStatus === 'ERROR')
                    ? <span className="text-red">OCR failed — the invoice couldn&apos;t be read. Check the image quality and try scanning again.</span>
                    : 'No items scanned yet — add line items manually or start a new scan.'}
                </div>
              )}
            </div>

            {/* Add line item row */}
            <div className="px-4 py-3 border-t border-line bg-bg">
              <button
                onClick={() => setIsAddingItem(true)}
                className="flex items-center gap-2 text-sm text-gold hover:text-blue-text font-medium transition-colors"
              >
                <Plus size={15} className="border border-blue rounded" /> Add line item manually
              </button>
            </div>

            {/* Invoice totals footer */}
            {(scannedTotal > 0 || invoiceTotal !== null) && (() => {
              const ocrSub = session.subtotal ? Number(session.subtotal) : null
              const ocrTax = session.tax      ? Number(session.tax)      : null
              const taxLine = ocrTax ?? (invoiceTotal !== null ? invoiceTotal - scannedTotal : null)
              return (
                <div className="px-5 py-4 bg-bg border-t border-line">
                  <div className="flex flex-col items-end gap-1 text-sm">
                    <div className="flex items-center gap-6">
                      <span className="text-ink-3">Subtotal (scanned items)</span>
                      <span className="font-semibold text-ink-2 w-24 text-right">{formatCurrency(scannedTotal)}</span>
                    </div>
                    {ocrSub !== null && Math.abs(ocrSub - scannedTotal) > 0.01 && (
                      <div className="flex items-center gap-6 text-ink-4 text-xs">
                        <span>Invoice subtotal</span>
                        <span className="w-24 text-right">{formatCurrency(ocrSub)}</span>
                      </div>
                    )}
                    {taxLine !== null && taxLine > 0.01 && (
                      <div className="flex items-center gap-6 text-ink-4">
                        <span>Taxes &amp; fees</span>
                        <span className="w-24 text-right">{formatCurrency(taxLine)}</span>
                      </div>
                    )}
                    {invoiceTotal !== null && (
                      <div className="flex items-center gap-6 border-t border-line pt-1 mt-1">
                        <span className="font-bold text-ink-2">Invoice Total</span>
                        <span className="font-bold text-ink w-24 text-right">{formatCurrency(invoiceTotal)}</span>
                      </div>
                    )}
                  </div>
                </div>
              )
            })()}
          </div>
        </div>

        {/* Sticky approve bar */}
        <div className="sticky bottom-0 bg-white border-t border-line px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] flex flex-col sm:flex-row items-center gap-3">
          <div className="flex-1 flex items-center gap-2 flex-wrap">
            <span className="text-sm text-ink-3">{activeItems} items to apply</span>
            {actionCounts['UPDATE_PRICE'] > 0 && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-gold/15 text-gold border border-gold/30">
                {actionCounts['UPDATE_PRICE']} price update{actionCounts['UPDATE_PRICE'] !== 1 ? 's' : ''}
              </span>
            )}
            {actionCounts['CREATE_NEW'] > 0 && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-soft text-blue-text border border-blue-soft">
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
              className={`border rounded-lg px-3 py-1.5 text-sm w-36 focus:outline-none focus:ring-2 focus:ring-gold ${!approvedBy ? 'border-gold-soft bg-gold-soft' : 'border-line'}`}
            />
            <button
              onClick={handleReject}
              disabled={isApproving}
              className="border border-red text-red rounded-lg px-4 py-2 text-sm font-semibold flex items-center gap-2 hover:bg-red-soft disabled:opacity-50 transition-colors"
            >
              Reject
            </button>
            <button
              onClick={handleApproveAll}
              disabled={isApproving}
              className="bg-green text-white rounded-lg px-4 py-2 text-sm font-semibold flex items-center gap-2 hover:bg-green disabled:opacity-50 transition-colors"
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
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-green-soft mb-2">
              <CheckCircle2 size={32} className="text-green" />
            </div>
            <h2 className="text-xl font-bold text-ink">Invoice Applied!</h2>
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: 'Prices Updated', value: approveResult.itemsUpdated, icon: <Package size={20} className="text-blue" />, color: 'blue' },
                { label: 'Items Created', value: approveResult.newItemsCreated, icon: <Plus size={20} className="text-blue" />, color: 'purple' },
                { label: 'Price Alerts', value: approveResult.priceAlerts, icon: <TrendingUp size={20} className="text-gold" />, color: 'amber' },
                { label: 'Recipe Alerts', value: approveResult.recipeAlerts, icon: <ClipboardList size={20} className="text-red" />, color: 'red' },
              ].map(({ label, value, icon }) => (
                <div key={label} className="bg-white rounded-xl border border-line p-4 flex flex-col items-center gap-2">
                  {icon}
                  <div className="text-2xl font-bold text-ink">{value}</div>
                  <div className="text-xs text-ink-3">{label}</div>
                </div>
              ))}
            </div>
            {(approveResult.priceAlerts > 0 || approveResult.recipeAlerts > 0) && (
              <div className="bg-gold-soft border border-gold-soft rounded-xl p-3 flex items-center gap-2 text-sm text-gold-2">
                <Bell size={16} className="shrink-0" />
                {approveResult.priceAlerts + approveResult.recipeAlerts} alert(s) generated — check the bell icon in the header
              </div>
            )}
            <button
              onClick={onClose}
              className="w-full bg-ink text-paper [&_svg]:text-gold rounded-xl py-3 font-semibold flex items-center justify-center gap-2 hover:bg-ink-2 transition-colors"
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
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-2 bg-red-soft">
              <AlertCircle size={32} className="text-red" />
            </div>
            <h2 className="text-xl font-bold text-ink">
              {isRejected ? 'Invoice Rejected' : 'Invoice'}
            </h2>
            {session && (
              <div className="bg-white rounded-xl border border-line p-4 text-left space-y-2 text-sm">
                {session.supplierName && (
                  <div className="flex justify-between">
                    <span className="text-ink-3">Supplier</span>
                    <span className="font-medium text-ink">{session.supplierName}</span>
                  </div>
                )}
                {session.invoiceNumber && (
                  <div className="flex justify-between">
                    <span className="text-ink-3">Invoice #</span>
                    <span className="font-mono font-medium text-ink">{session.invoiceNumber}</span>
                  </div>
                )}
                {session.invoiceDate && (
                  <div className="flex justify-between">
                    <span className="text-ink-3">Date</span>
                    <span className="font-medium text-ink">{session.invoiceDate}</span>
                  </div>
                )}
                {session.total && (
                  <div className="flex justify-between">
                    <span className="text-ink-3">Total</span>
                    <span className="font-bold text-ink">{formatCurrency(Number(session.total))}</span>
                  </div>
                )}
              </div>
            )}
            <button
              onClick={onClose}
              className="w-full border border-line text-ink-3 rounded-xl py-3 font-semibold hover:bg-bg transition-colors"
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
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-gold/15 text-gold border border-gold/30">price update</span>
      )
      if (action === 'CREATE_NEW' || isNewItem) return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-soft text-blue-text border border-blue-soft">new item</span>
      )
      if (action === 'ADD_SUPPLIER') return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-gold-soft text-gold-2 border border-gold-soft">supplier added</span>
      )
      return null
    }

    return (
      <div className="flex-1 overflow-y-auto flex flex-col">
        {/* Header band */}
        <div className="bg-gradient-to-r from-ink-2 to-ink px-5 py-4 text-white shrink-0">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-bold text-ink-4 uppercase tracking-widest mb-0.5">Approved Invoice</p>
              <h2 className="text-lg font-bold leading-tight truncate">{session.supplierName || 'Unknown Supplier'}</h2>
            </div>
            <div className="text-right shrink-0 flex flex-col items-end gap-1">
              {session.invoiceNumber && (
                <div className="flex items-center gap-1 justify-end text-ink-4 text-xs">
                  <Hash size={10} /><span className="font-mono font-semibold text-white">{session.invoiceNumber}</span>
                </div>
              )}
              {session.total && (
                <div className="text-xl font-bold text-white">{formatCurrency(Number(session.total))}</div>
              )}
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-green/20 text-[#86efac] border border-green/30">
                <CheckCircle2 size={10} className="mr-1" />Approved
              </span>
            </div>
          </div>
          <div className="flex items-center gap-5 mt-3 text-xs">
            {session.invoiceDate && (
              <div className="flex items-center gap-1 text-ink-4">
                <CalendarDays size={11} />
                <span>{session.invoiceDate}</span>
              </div>
            )}
            <div className="flex items-center gap-1 text-ink-4">
              <Package size={11} />
              <span>{visibleItems.length} line item{visibleItems.length !== 1 ? 's' : ''}</span>
            </div>
          </div>
        </div>

        {/* Line items */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="space-y-1">
            {visibleItems.map(si => (
              <div key={si.id} className="bg-white border border-line rounded-xl px-4 py-3 flex flex-col gap-1.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-ink-4 truncate">{si.rawDescription}</p>
                    <p className="text-sm font-semibold text-ink truncate">
                      {si.matchedItem ? si.matchedItem.itemName : <span className="text-ink-4 italic">Unmatched</span>}
                    </p>
                  </div>
                  <div className="shrink-0">
                    {actionBadge(si.action, si.isNewItem)}
                  </div>
                </div>
                <div className="flex items-center gap-4 text-xs text-ink-3">
                  {si.rawQty != null && (
                    <span>Qty: <span className="font-medium text-ink-2">{si.rawQty}</span></span>
                  )}
                  {si.rawUnitPrice != null && (
                    <span>Unit: <span className="font-medium text-ink-2">{formatCurrency(Number(si.rawUnitPrice))}</span></span>
                  )}
                  {si.rawLineTotal != null && (
                    <span className="ml-auto font-semibold text-ink">{formatCurrency(Number(si.rawLineTotal))}</span>
                  )}
                </div>
              </div>
            ))}
          </div>

          {skippedItems.length > 0 && (
            <details className="group">
              <summary className="cursor-pointer text-xs text-ink-4 hover:text-ink-3 flex items-center gap-1 select-none">
                <ChevronRight size={12} className="group-open:rotate-90 transition-transform" />
                Skipped items ({skippedItems.length})
              </summary>
              <div className="mt-2 space-y-1 pl-4">
                {skippedItems.map(si => (
                  <div key={si.id} className="bg-bg border border-line rounded-lg px-3 py-2">
                    <p className="text-xs text-ink-4 truncate">{si.rawDescription}</p>
                  </div>
                ))}
              </div>
            </details>
          )}

          {/* Alerts section */}
          <div className="space-y-3 pt-2">
            <h3 className="text-xs font-bold text-ink-3 uppercase tracking-widest flex items-center gap-2">
              <Bell size={12} />Alerts
            </h3>

            {session.priceAlerts.length === 0 && session.recipeAlerts.length === 0 ? (
              <p className="text-xs text-ink-4 italic">No alerts generated</p>
            ) : (
              <>
                {session.priceAlerts.map(alert => {
                  const pct = Number(alert.changePct)
                  const isUp = alert.direction === 'UP'
                  return (
                    <div key={alert.id} className="bg-white border border-line rounded-xl px-4 py-3 flex items-center justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-ink truncate">{alert.inventoryItem.itemName}</p>
                        <p className="text-xs text-ink-3">
                          {formatCurrency(Number(alert.previousPrice))} → {formatCurrency(Number(alert.newPrice))}
                        </p>
                      </div>
                      <div className={`flex items-center gap-1 text-sm font-bold shrink-0 ${isUp ? 'text-red' : 'text-green'}`}>
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
                    <div key={alert.id} className="bg-white border border-line rounded-xl px-4 py-3 flex items-center justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1">
                          <p className="text-sm font-semibold text-ink truncate">{alert.recipe.name}</p>
                          {alert.exceededThreshold && <AlertCircle size={13} className="text-red shrink-0" />}
                        </div>
                        <p className="text-xs text-ink-3">
                          {formatCurrency(Number(alert.previousCost))} → {formatCurrency(Number(alert.newCost))}
                          {alert.newFoodCostPct != null && (
                            <span className="ml-1 text-ink-4">· food cost {Number(alert.newFoodCostPct).toFixed(1)}%</span>
                          )}
                        </p>
                      </div>
                      <div className={`flex items-center gap-1 text-sm font-bold shrink-0 ${isUp ? 'text-red' : 'text-green'}`}>
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
        <div
          className="shrink-0 border-t border-line p-4"
          style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))' }}
        >
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
            className="w-full bg-gold hover:bg-gold disabled:opacity-50 text-white rounded-xl py-3 font-semibold flex items-center justify-center gap-2 transition-colors"
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
              <h3 className="text-sm font-bold text-ink">Create New Supplier</h3>
              <button onClick={() => setCreateSupplierOpen(false)} className="p-2.5 flex items-center justify-center rounded-lg text-ink-4 hover:bg-bg-2">
                <X size={14} />
              </button>
            </div>
            <p className="text-xs text-ink-3 mb-3">
              A new supplier will be created and this invoice will be linked to it.
              The OCR name will be saved as an alias for future auto-matching.
            </p>
            <label className="block text-xs font-medium text-ink-3 mb-1">Supplier Name *</label>
            <input
              autoFocus
              value={newSupplierName}
              onChange={e => setNewSupplierName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCreateAndLinkSupplier() }}
              placeholder="e.g. Legends Haul"
              className="w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold mb-3"
            />
            <div className="flex gap-2">
              <button
                onClick={() => setCreateSupplierOpen(false)}
                className="flex-1 border border-line rounded-lg py-2 text-sm hover:bg-bg"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateAndLinkSupplier}
                disabled={savingSupplier || !newSupplierName.trim()}
                className="flex-1 bg-ink text-paper [&_svg]:text-gold rounded-lg py-2 text-sm font-semibold hover:bg-ink-2 disabled:opacity-50"
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
        <div className="flex items-center justify-between px-5 py-4 border-b border-line shrink-0">
          <div className="flex items-center gap-2">
            <ScanLine size={18} className="text-gold" />
            <span className="font-semibold text-ink">
              {drawerState === 'processing' ? 'Scanning…'
                : drawerState === 'approving' ? 'Applying Invoice…'
                : drawerState === 'error' ? 'Scan Failed'
                : drawerState === 'review' ? 'Review Invoice'
                : drawerState === 'done' ? 'Invoice'
                : 'Loading…'}
            </span>
          </div>
          <button onClick={onClose} className="p-1.5 text-ink-4 hover:text-ink-3 hover:bg-bg-2 rounded-lg transition-colors">
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
          <div className={`flex-1 overflow-y-auto flex flex-col ${drawerState === 'review' ? 'border-l border-line' : ''}`}>
            {drawerState === 'loading' && (
              <div className="flex-1 flex items-center justify-center">
                <Loader2 size={28} className="animate-spin text-blue" />
              </div>
            )}
            {drawerState === 'processing' && renderProcessing()}
            {drawerState === 'approving' && renderApproving()}
            {drawerState === 'error' && renderError()}
            {drawerState === 'review' && renderReview()}
            {drawerState === 'done' && renderDone()}
          </div>
        </div>
      </div>

      {/* Mobile: bottom sheet */}
      <div
        className="sm:hidden fixed inset-0 z-[60] flex items-end"
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
            <div className="w-10 h-1 rounded-full bg-line" />
          </div>

          {/* Header */}
          <div
            className="flex items-center justify-between px-5 py-3 border-b border-line shrink-0"
            style={{ paddingTop: 'calc(0.75rem + env(safe-area-inset-top, 0px))' }}
          >
            <div className="flex items-center gap-2">
              <ScanLine size={16} className="text-gold" />
              <span className="font-semibold text-ink text-sm">
                {drawerState === 'processing' ? 'Scanning…'
                  : drawerState === 'approving' ? 'Applying Invoice…'
                  : drawerState === 'review' ? 'Review Invoice'
                  : drawerState === 'done' ? 'Invoice'
                  : 'Loading…'}
              </span>
            </div>
            <button onClick={onClose} className="p-2.5 flex items-center justify-center text-ink-4 hover:text-ink-3">
              <X size={16} />
            </button>
          </div>

          {/* Mobile tab bar (review state only, when files exist) */}
          {drawerState === 'review' && session?.files && session.files.length > 0 && (
            <div className="flex border-b border-line shrink-0">
              <button
                onClick={() => setMobileTab('review')}
                className={`flex-1 py-2 text-xs font-medium ${mobileTab === 'review' ? 'text-gold border-b-2 border-gold' : 'text-ink-3'}`}
              >
                Review
              </button>
              <button
                onClick={() => setMobileTab('image')}
                className={`flex-1 py-2 text-xs font-medium ${mobileTab === 'image' ? 'text-gold border-b-2 border-gold' : 'text-ink-3'}`}
              >
                Invoice Image
              </button>
            </div>
          )}

          {/* Content */}
          <div className="flex-1 overflow-y-auto">
            {drawerState === 'loading' && (
              <div className="flex items-center justify-center py-20">
                <Loader2 size={24} className="animate-spin text-ink-4" />
              </div>
            )}
            {drawerState === 'processing' && renderProcessing()}
            {drawerState === 'approving' && renderApproving()}
            {drawerState === 'error' && renderError()}
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
