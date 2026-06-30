'use client'
// Phase 5 — InvoiceReviewDrawer: the top-level container.
// Owns all shared state, provides DrawerContext, and renders the drawer panel.

import {
  useState, useEffect, useCallback, useMemo, useRef,
} from 'react'
import { X, Check, Loader2, AlertTriangle, ChevronUp, ChevronDown, TrendingUp, TrendingDown, RotateCcw, Package, BookOpen, Tag, Search, Plus } from 'lucide-react'
import { DrawerContext, type DrawerContextValue } from './context'
import { LineItemCard } from './card'
import { type ReconcileResult } from './composites'
import { ActButton, IssueBadge } from './atoms'
import { ImpactStrip, AlertBanner, ReviewProgress, SectionDivider, type ImpactMetric, type ReviewSegment } from './chrome'
import { ImageViewerV2, type BBox } from './ImageViewer'
import { useRc } from '@/contexts/RevenueCenterContext'
import { InventoryItemDrawer } from '@/components/inventory/InventoryItemDrawer'
import { AdoptFormatModal } from './AdoptFormatModal'
import type { Session, ScanItem, SessionSummary, SessionStatus } from '@/components/invoices/types'
import type { RevenueCenter } from '@/contexts/RevenueCenterContext'
import { reconcileInvoiceTotals } from '@/lib/invoice/calculations'
import {
  type FilterKey, type SortMode,
} from '@/lib/invoice/filters'
import {
  isUnlinked, hasMathCheck, hasDimensionConflict, needsTrustCheck,
} from '@/lib/invoice/predicates'
import { lineUnresolved, isCharge, isBigPriceChange, hasInvalidRcSplit } from '@/lib/invoice/resolution'
import { isBridgeable } from '@/lib/invoice/classify'
import { formatCurrency } from '@/lib/invoice/formatters'
import { formatPricePerBase } from '@/lib/utils'
import {
  DIMENSION_BASE, pricePerBaseUnit, basePerUnit, validateChainItem,
  type Dimension, type PackLink, type Pricing,
} from '@/lib/item-model'
import { formToChain } from '@/lib/item-model-form'
import { canonicalUom } from '@/lib/uom'
import {
  DIM_UNITS, countUnitOptions, DimensionToggle, PackChainEditor, PricingEditor,
} from '@/components/inventory/ItemChainEditor'

// ─── InvoiceHeader ─────────────────────────────────────────────────────────────

function supplierInitials(name: string | null): string {
  if (!name) return '??'
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '??'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

function InvoiceHeader({
  session,
  revenueCenters,
  onRcChange,
  onClose,
  queuePos,
  onPrev,
  onNext,
}: {
  session: Session
  revenueCenters: RevenueCenter[]
  onRcChange: (rcId: string) => void
  onClose: () => void
  queuePos: { idx: number; total: number }
  onPrev?: () => void
  onNext?: () => void
}) {
  const total    = session.total    ? Number(session.total)    : null
  const subtotal = session.subtotal ? Number(session.subtotal) : null
  const tax      = session.tax      ? Number(session.tax)      : null
  const itemCount = session.scanItems.filter(i => i.action !== 'SKIP').length

  const metaParts: string[] = []
  if (session.invoiceNumber) metaParts.push(`#${session.invoiceNumber}`)
  if (session.invoiceDate)   metaParts.push(session.invoiceDate)
  metaParts.push(`${itemCount} line${itemCount !== 1 ? 's' : ''}`)

  return (
    <div
      className="grid grid-cols-[32px_1fr_auto_auto] items-center gap-2.5 sm:gap-4 px-4 sm:px-[22px] py-[16px] bg-paper border-b border-line"
      style={{ paddingTop: 'calc(16px + env(safe-area-inset-top, 0px))' }}
    >
      {/* Close */}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close drawer"
        className="w-8 h-8 grid place-items-center rounded-lg border border-line text-ink-3 hover:border-ink-4 hover:text-ink-2 transition-colors"
      >
        <X size={16} />
      </button>

      {/* Avatar + title + meta */}
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-9 h-9 rounded-[9px] bg-ink text-paper grid place-items-center font-mono text-[12px] font-semibold shrink-0">
          {supplierInitials(session.supplierName)}
        </div>
        <div className="min-w-0">
          <h2 className="font-medium text-[18px] sm:text-[23px] leading-[1.1] tracking-[-0.02em] text-ink truncate">
            {session.supplierName ?? 'Unknown supplier'}
          </h2>
          <div className="font-mono text-[11px] text-ink-4 mt-[3px] truncate" title={metaParts.join('  ·  ')}>
            {metaParts.join('  ·  ')}
          </div>
          <div className="mt-2">
            <select
              value={session.revenueCenterId ?? ''}
              onChange={e => onRcChange(e.target.value)}
              aria-label="Invoice revenue center"
              className="font-mono text-[11px] text-ink-3 bg-bg border border-line rounded px-1.5 py-[3px] hover:bg-bg-2 focus:outline-none focus:ring-1 focus:ring-gold/40 cursor-pointer"
            >
              {revenueCenters.map(r => (
                <option key={r.id} value={r.id}>{r.name}{r.isDefault ? ' (default)' : ''}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Total */}
      <div className="text-right pr-1.5">
        <div className="font-mono text-[20px] sm:text-[28px] font-semibold tracking-[-0.02em] text-ink tabular-nums leading-none">
          {total !== null ? formatCurrency(total) : '—'}
        </div>
        {(subtotal !== null || tax !== null) && (
          <div className="font-mono text-[10.5px] text-ink-4 mt-[3px] tabular-nums">
            {subtotal !== null && `sub ${formatCurrency(subtotal)}`}
            {subtotal !== null && tax !== null && ' · '}
            {tax !== null && `tax ${formatCurrency(tax)}`}
          </div>
        )}
      </div>

      {/* Prev / next in queue */}
      <div className="hidden md:flex items-center gap-1">
        <button
          type="button"
          onClick={onPrev}
          disabled={!onPrev}
          aria-label="Previous invoice"
          className="w-7 h-7 grid place-items-center rounded-[7px] border border-line text-ink-4 hover:border-ink-4 hover:text-ink-2 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronUp size={13} className="-rotate-90" />
        </button>
        <span className="font-mono text-[10.5px] text-ink-4 px-1.5 tabular-nums">{queuePos.idx} / {queuePos.total}</span>
        <button
          type="button"
          onClick={onNext}
          disabled={!onNext}
          aria-label="Next invoice"
          className="w-7 h-7 grid place-items-center rounded-[7px] border border-line text-ink-4 hover:border-ink-4 hover:text-ink-2 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronDown size={13} className="-rotate-90" />
        </button>
      </div>
    </div>
  )
}

// ─── DrawerFooter ──────────────────────────────────────────────────────────────
// Commits, doesn't decide (mock §4). Left = a plain-English summary of exactly
// what approving writes; right = Reject + the one ink-on-gold Approve & post.

function DrawerFooter({
  priceWrites,
  newItems,
  supplierLink,
  canApprove,
  disabledReason,
  onApprove,
  onReject,
  saveStatus,
}: {
  priceWrites: number
  newItems: number
  supplierLink: boolean
  canApprove: boolean
  disabledReason: string
  onApprove: () => void
  onReject: () => void
  saveStatus: 'idle' | 'saving' | 'error'
}) {
  const parts: string[] = []
  parts.push(`${priceWrites} price${priceWrites !== 1 ? 's' : ''} to inventory`)
  if (newItems > 0) parts.push(`creates ${newItems} new item${newItems !== 1 ? 's' : ''}`)
  if (supplierLink) parts.push('links 1 supplier')

  return (
    <div
      className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto] sm:gap-4 sm:items-center px-[22px] py-3 bg-paper border-t border-line shrink-0"
      style={{ paddingBottom: 'calc(14px + env(safe-area-inset-bottom, 0px))' }}
    >
      <div className="min-w-0">
        <div className="text-[12.5px] text-ink-3 leading-[1.5]">
          Approve writes <b className="text-ink-2 font-medium">{parts.join(', ')}</b>, and re-costs the recipes that use them.
        </div>
        <div className="font-mono text-[10.5px] text-ink-4 mt-[3px] flex items-center gap-2.5">
          <span className="inline-flex items-center gap-1.5"><span className="w-[5px] h-[5px] rounded-full bg-gold" /> Reversible — re-open any time</span>
          {saveStatus === 'saving' && <span className="inline-flex items-center gap-1 text-ink-4"><Loader2 size={11} className="animate-spin" /> saving</span>}
          {saveStatus === 'error'  && <span className="inline-flex items-center gap-1 text-red"><AlertTriangle size={11} /> save failed</span>}
        </div>
      </div>
      <div className="flex gap-2 w-full sm:w-auto sm:shrink-0">
        <button
          type="button"
          onClick={onReject}
          className="flex-1 sm:flex-none justify-center px-4 py-2.5 text-[13.5px] font-medium text-ink-3 bg-paper border border-line rounded-[9px] hover:border-ink-4 hover:text-ink transition-colors"
        >
          Reject invoice
        </button>
        <button
          type="button"
          onClick={onApprove}
          disabled={!canApprove}
          title={disabledReason}
          className={`flex-1 sm:flex-none inline-flex items-center justify-center gap-2 px-[18px] py-2.5 text-[13.5px] font-medium rounded-[9px] transition-colors ${
            canApprove
              ? 'bg-ink text-paper hover:bg-ink-2'
              : 'bg-line text-ink-4 cursor-not-allowed'
          }`}
        >
          <Check size={14} className={canApprove ? 'text-gold' : ''} />
          Approve &amp; post
          <span className="hidden sm:inline font-mono text-[9.5px] px-1.5 py-0.5 rounded bg-paper/15 text-bg">⌘ ⏎</span>
        </button>
      </div>
    </div>
  )
}

// ─── InvoiceReviewDrawer ───────────────────────────────────────────────────────

export function InvoiceReviewDrawer({
  sessionId,
  onClose,
  onApproveOrReject,
  onNavigate,
  allSessions = [],
}: {
  sessionId: string | null
  onClose: () => void
  onApproveOrReject: (optimistic?: { id: string; status: SessionStatus }) => void
  onNavigate?: (id: string) => void
  allSessions?: SessionSummary[]
}) {
  const { revenueCenters } = useRc()

  // Lock background scroll while the drawer is open — otherwise wheel events over
  // a non-scrolling area of the drawer (PDF pane, header, gaps) chain through to
  // the page behind it. The page's scroll container is <html>, not <body>, so we
  // must lock the documentElement (locking body alone has no effect here).
  useEffect(() => {
    if (sessionId === null) return
    const html = document.documentElement
    const prevHtml = html.style.overflow
    const prevBody = document.body.style.overflow
    html.style.overflow = 'hidden'
    document.body.style.overflow = 'hidden'
    return () => { html.style.overflow = prevHtml; document.body.style.overflow = prevBody }
  }, [sessionId])

  // ── Session data ────────────────────────────────────────────────────────────
  const [session,     setSession]     = useState<Session | null>(null)
  const [loading,     setLoading]     = useState(false)
  const [saveStatus,  setSaveStatus]  = useState<'idle' | 'saving' | 'error'>('idle')
  const [approving,   setApproving]   = useState(false)
  const [approved,    setApproved]    = useState(false)

  // ── Supplier linking ────────────────────────────────────────────────────────
  const [linkedSupplierId,  setLinkedSupplierId]  = useState<string | null>(null)
  const [supplierComboOpen, setSupplierComboOpen] = useState(false)
  const [supplierSearch,    setSupplierSearch]    = useState('')
  const [allSuppliers, setAllSuppliers] = useState<Array<{ id: string; name: string }>>([])

  const loadSuppliers = useCallback(async () => {
    if (allSuppliers.length > 0) return
    try {
      const data = await fetch('/api/suppliers').then(r => r.ok ? r.json() : [])
      setAllSuppliers(Array.isArray(data) ? data : (data.suppliers ?? []))
    } catch {}
  }, [allSuppliers.length])

  const handleLinkSupplier = useCallback(async (supplierId: string) => {
    if (!session) return
    setLinkedSupplierId(supplierId)
    setSupplierComboOpen(false)
    setSupplierSearch('')
    await fetch(`/api/invoices/sessions/${session.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ supplierId }),
    })
  }, [session])

  const handleSessionRcChange = useCallback(async (rcId: string) => {
    if (!session) return
    const prevRcId = session.revenueCenterId ?? null
    setSession(prev => (prev ? { ...prev, revenueCenterId: rcId } : prev))
    try {
      const res = await fetch(`/api/invoices/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revenueCenterId: rcId }),
      })
      if (!res.ok) {
        // Revert the optimistic update so the UI never shows an RC the server rejected.
        setSession(prev => (prev ? { ...prev, revenueCenterId: prevRcId } : prev))
      }
    } catch {
      setSession(prev => (prev ? { ...prev, revenueCenterId: prevRcId } : prev))
    }
  }, [session])

  // Create a brand-new supplier from the unmatched invoice, then link it.
  // The OCR name is stored as an alias so future invoices match automatically;
  // linking (PATCH) backfills any orphaned offers stored under that name.
  const handleCreateSupplier = useCallback(async (fields: {
    name: string; contactName?: string; phone?: string; email?: string; orderPlatform?: string
  }) => {
    if (!session) return
    const res = await fetch('/api/suppliers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...fields,
        aliases: session.supplierName ? [session.supplierName] : [],
      }),
    })
    if (!res.ok) throw new Error('Could not create supplier')
    const created = await res.json()
    setAllSuppliers(prev => [...prev, { id: created.id, name: created.name }])
    await handleLinkSupplier(created.id)
  }, [session, handleLinkSupplier])

  const fetchSession = useCallback(async (id: string) => {
    setLoading(true)
    try {
      const res  = await fetch(`/api/invoices/sessions/${id}`)
      const data = await res.json()
      setSession(data)
      setLinkedSupplierId(data.supplierId ?? null)
    } finally {
      setLoading(false)
    }
  }, [])

  // Silent refresh — updates session data without showing the loading spinner,
  // so child component state (expanded cards, staged edits) is preserved.
  const refreshSession = useCallback(async (id: string) => {
    try {
      const res  = await fetch(`/api/invoices/sessions/${id}`)
      const data = await res.json()
      setSession(data)
    } catch { /* ignore — stale session data stays on screen */ }
  }, [])

  useEffect(() => {
    if (!sessionId) { setSession(null); return }
    setApproved(false)
    fetchSession(sessionId)
  }, [sessionId, fetchSession])

  // ── UI state ────────────────────────────────────────────────────────────────
  const [editedLines,       setEditedLines]       = useState<Map<string, Partial<ScanItem>>>(new Map())
  const [expandedLineIds,   setExpandedLineIds]   = useState<Set<string>>(new Set())
  const [flashingLineIds,   setFlashingLineIds]   = useState<Set<string>>(new Set())
  const [activeFilters,     setActiveFilters]     = useState<Set<FilterKey>>(new Set())
  const [sortMode,          setSortMode]          = useState<SortMode>('invoice')
  const [pickingLinkForId,  setPickingLinkForId]  = useState<string | null>(null)
  const [acknowledgedPriceLines, setAcknowledgedPriceLines] = useState<Set<string>>(new Set())
  const [acknowledgedConfLines, setAcknowledgedConfLines] = useState<Set<string>>(new Set())
  const [creatingNewForItem,      setCreatingNewForItem]      = useState<ScanItem | null>(null)
  const [editingInventoryItemId,  setEditingInventoryItemId]  = useState<string | null>(null)
  const [adoptingForItem,         setAdoptingForItem]         = useState<ScanItem | null>(null)
  const [activeBboxItemId,   setActiveBboxItemId]    = useState<string | null>(null)
  const [mobileTab,          setMobileTab]          = useState<'review' | 'image'>('review')
  const [reviewSegment,      setReviewSegment]      = useState<ReviewSegment>('all')
  const [supplierSkipped,    setSupplierSkipped]    = useState(false)
  const [bannerDismissed,    setBannerDismissed]    = useState(false)
  // Snapshot of which lines needed attention at load — the stable denominator
  // for the "X of N resolved" progress bar.
  const [initialAttention,   setInitialAttention]   = useState<{ lineIds: Set<string>; supplier: boolean }>({ lineIds: new Set(), supplier: false })

  // Ref for the scrollable list container
  const listRef = useRef<HTMLDivElement>(null)
  // Line id to scroll to the top of the list after it opens (set on click-expand).
  const expandScrollRef = useRef<string | null>(null)
  // The session id we've already initialised review state for. Guards the reset
  // below so it runs ONCE per session — refreshSession() after creating an item,
  // editing a line, etc. produces a new `session` object but must NOT wipe the
  // user's in-flight progress (acks, mode writebacks, edits, expansions).
  const initializedSessionRef = useRef<string | null>(null)

  // ── Initialise review state once per session (first load only) ──────────────
  useEffect(() => {
    if (!session) return
    if (initializedSessionRef.current === session.id) return // refetch — keep progress
    initializedSessionRef.current = session.id
    const toExpand = new Set(
      session.scanItems
        .filter(i => i.action !== 'SKIP' && (isUnlinked(i) || hasMathCheck(i) || hasDimensionConflict(i) || isBridgeable(i)))
        .map(i => i.id),
    )
    setExpandedLineIds(toExpand)
    setEditedLines(new Map())
    setActiveFilters(new Set())
    setSortMode('invoice')
    setPickingLinkForId(null)
    setAcknowledgedPriceLines(new Set())
    setAcknowledgedConfLines(new Set())
    setActiveBboxItemId(null)
    setMobileTab('review')
    setReviewSegment('all')
    setSupplierSkipped(false)
    setBannerDismissed(false)

    // Snapshot the lines that need a decision at load — the progress denominator.
    const attentionIds = new Set(
      session.scanItems
        .filter(i => i.action !== 'SKIP' && (
          isUnlinked(i) || hasMathCheck(i) || hasDimensionConflict(i) || isBridgeable(i) || isBigPriceChange(i, { supplierId: session.supplierId, supplierName: session.supplierName }) || needsTrustCheck(i)
        ))
        .map(i => i.id),
    )
    setInitialAttention({ lineIds: attentionIds, supplier: !session.supplierId })
  }, [session])

  // ── Computed data ────────────────────────────────────────────────────────────
  const effectiveLines = useMemo(() => {
    if (!session) return []
    return session.scanItems.map(item => {
      const edits = editedLines.get(item.id)
      return edits ? { ...item, ...edits } : item
    })
  }, [session, editedLines])

  const reconciliation = useMemo<ReconcileResult | null>(() => {
    if (!session) return null
    const sub = session.subtotal ? Number(session.subtotal) : null
    const r   = reconcileInvoiceTotals(effectiveLines, sub)
    return r
  }, [session, effectiveLines])

  // Per-line resolution options (price / low-trust acknowledgement).
  const optsFor = useCallback(
    (id: string) => ({
      priceAck: acknowledgedPriceLines.has(id),
      confAck: acknowledgedConfLines.has(id),
    }),
    [acknowledgedPriceLines, acknowledgedConfLines],
  )

  const lineIsAttention = useCallback((i: ScanItem) =>
    isUnlinked(i) || hasDimensionConflict(i) || isBridgeable(i) || hasMathCheck(i) || isBigPriceChange(i, { supplierId: session?.supplierId ?? null, supplierName: session?.supplierName ?? null }) || needsTrustCheck(i) || hasInvalidRcSplit(i),
  [session?.supplierId, session?.supplierName])

  // Group lines into the mock's three sections + per-line invoice numbering.
  const sections = useMemo(() => {
    const active  = effectiveLines.filter(i => !isCharge(i))
    const charges = effectiveLines.filter(i => isCharge(i))
    const ordered        = [...active].sort((a, b) => a.sortOrder - b.sortOrder)
    const orderedCharges = [...charges].sort((a, b) => a.sortOrder - b.sortOrder)
    const displayNo = new Map<string, number>()
    ordered.forEach((i, idx) => displayNo.set(i.id, idx + 1))
    orderedCharges.forEach((i, idx) => displayNo.set(i.id, ordered.length + idx + 1))
    return {
      attention: ordered.filter(lineIsAttention),
      matched:   ordered.filter(i => !lineIsAttention(i)),
      charges:   orderedCharges,
      displayNo,
      activeCount: active.length,
    }
  }, [effectiveLines, lineIsAttention])

  const supplierNeedsLink = !linkedSupplierId && !supplierSkipped

  // Progress bar — stable denominator from the load-time snapshot.
  const progress = useMemo(() => {
    const total = initialAttention.lineIds.size + (initialAttention.supplier ? 1 : 0)
    let resolved = 0
    for (const id of initialAttention.lineIds) {
      const line = effectiveLines.find(l => l.id === id)
      if (!line || isCharge(line) || !lineUnresolved(line, optsFor(id), { supplierId: session?.supplierId ?? null, supplierName: session?.supplierName ?? null })) resolved++
    }
    if (initialAttention.supplier && (linkedSupplierId || supplierSkipped)) resolved++
    return { total, resolved }
  }, [effectiveLines, initialAttention, optsFor, linkedSupplierId, supplierSkipped, session?.supplierId, session?.supplierName])

  // Approve gate — computed over CURRENT state so edits that introduce a new
  // issue re-block approval (the snapshot above only fixes the progress total).
  const currentlyUnresolved =
    sections.attention.filter(i => lineUnresolved(i, optsFor(i.id), { supplierId: session?.supplierId ?? null, supplierName: session?.supplierName ?? null })).length +
    (supplierNeedsLink && initialAttention.supplier ? 1 : 0)
  const canApprove = currentlyUnresolved === 0
  const disabledReason = canApprove
    ? ''
    : `${currentlyUnresolved} ${currentlyUnresolved === 1 ? 'issue needs' : 'issues need'} a decision`

  // Impact-strip + footer metrics (only what's computable before approve).
  const priceWrites   = effectiveLines.filter(i => i.action !== 'SKIP' && i.matchedItemId).length
  const newItemsCount = effectiveLines.filter(i => i.action === 'CREATE_NEW').length
  const impactMetrics: ImpactMetric[] = [
    { label: 'Inventory writes', value: `${priceWrites} price${priceWrites !== 1 ? 's' : ''}` },
    ...(newItemsCount > 0 ? [{ label: 'New items', value: String(newItemsCount) }] : []),
    {
      label: 'Supplier',
      value: linkedSupplierId ? 'linked' : supplierSkipped ? 'skipped' : 'link pending',
      tone: (linkedSupplierId || supplierSkipped) ? undefined : ('warn' as const),
    },
  ]

  const segmentCounts = { all: sections.activeCount, issues: sections.attention.length, matched: sections.matched.length }

  // ── Review queue navigation (prev/next invoice in the inbox) ────────────────
  const reviewQueueIds = useMemo(
    () => allSessions.filter(s => s.status === 'REVIEW').map(s => s.id),
    [allSessions],
  )
  const queueIdx  = session ? reviewQueueIds.indexOf(session.id) : -1
  const queuePos  = { idx: queueIdx >= 0 ? queueIdx + 1 : 1, total: Math.max(reviewQueueIds.length, 1) }
  const navPrev   = onNavigate && queueIdx > 0 ? () => onNavigate(reviewQueueIds[queueIdx - 1]) : undefined
  const navNext   = onNavigate && queueIdx >= 0 && queueIdx < reviewQueueIds.length - 1
    ? () => onNavigate(reviewQueueIds[queueIdx + 1]) : undefined

  // ── Duplicate detection ─────────────────────────────────────────────────────
  const duplicateSessions = useMemo(() => {
    if (!session?.invoiceNumber) return []
    return allSessions.filter(s =>
      s.id !== session.id && s.invoiceNumber === session.invoiceNumber
    )
  }, [session, allSessions])

  // ── Context helpers ─────────────────────────────────────────────────────────
  const getEffectiveLine = useCallback((id: string): ScanItem => {
    const base  = session?.scanItems.find(i => i.id === id)
    if (!base) throw new Error(`Line ${id} not found`)
    const edits = editedLines.get(id)
    return edits ? { ...base, ...edits } : base
  }, [session, editedLines])

  const getItemRc = useCallback((id: string): RevenueCenter | null => {
    const line = getEffectiveLine(id)
    if (!line.revenueCenterId) return null
    return revenueCenters.find(rc => rc.id === line.revenueCenterId) ?? null
  }, [getEffectiveLine, revenueCenters])

  // ── Line mutations ──────────────────────────────────────────────────────────
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Patches staged locally but not yet PATCHed to the server. Keyed by line id;
  // merged per line so rapid edits to different lines/fields can't clobber
  // each other (a single "latest patch" timer used to drop earlier edits).
  const pendingEditsRef = useRef<Map<string, Partial<ScanItem>>>(new Map())

  const persistEdit = useCallback(async (id: string, patch: Partial<ScanItem>) => {
    if (!session) return
    setSaveStatus('saving')
    try {
      const res = await fetch(`/api/invoices/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanItemId: id, ...patch }),
      })
      if (!res.ok) setSaveStatus('error')
      else setSaveStatus('idle')
    } catch {
      setSaveStatus('error')
    }
  }, [session])

  // Send every staged patch now. Used by the debounce timer and awaited by
  // handleApprove so a consent/edit clicked moments before Approve is never
  // lost to the debounce window.
  const flushPendingEdits = useCallback(async () => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    const pending = pendingEditsRef.current
    if (pending.size === 0) return
    pendingEditsRef.current = new Map()
    await Promise.all(
      Array.from(pending.entries()).map(([id, patch]) => persistEdit(id, patch))
    )
  }, [persistEdit])

  const updateLine = useCallback((id: string, patch: Partial<ScanItem>) => {
    setEditedLines(prev => {
      const next = new Map(prev)
      next.set(id, { ...prev.get(id), ...patch })
      return next
    })
    // Stage the patch (merged per line) and debounce the server save by 600ms
    pendingEditsRef.current.set(id, { ...pendingEditsRef.current.get(id), ...patch })
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => { void flushPendingEdits() }, 600)
  }, [flushPendingEdits])

  const clearLineEdits = useCallback((id: string) => {
    setEditedLines(prev => {
      const next = new Map(prev)
      next.delete(id)
      return next
    })
  }, [])

  // ── Expand / collapse ───────────────────────────────────────────────────────
  const toggleExpand = useCallback((id: string, forceOpen?: boolean) => {
    setExpandedLineIds(prev => {
      const next = new Set(prev)
      const willOpen = forceOpen || !next.has(id)
      if (willOpen) { next.add(id); expandScrollRef.current = id }
      else next.delete(id)
      // Track which item to highlight in the image viewer
      setActiveBboxItemId(willOpen ? id : null)
      return next
    })
  }, [])

  // Pending scroll target — set by J/K navigation, consumed after expand.
  const scrollPendingRef = useRef<string | null>(null)

  // After expandedLineIds updates, scroll the opened line to the top of the list
  // so its full details (down to the Skip row) are reachable, not stranded below
  // the fold. J/K navigation also flashes the row; a plain click just scrolls.
  useEffect(() => {
    const flashId  = scrollPendingRef.current
    const scrollId = flashId ?? expandScrollRef.current
    scrollPendingRef.current = null
    expandScrollRef.current  = null
    if (!scrollId) return
    const el = listRef.current?.querySelector(`[data-line-id="${scrollId}"]`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    if (!flashId) return
    setFlashingLineIds(prev => new Set(prev).add(flashId))
    setTimeout(() => {
      setFlashingLineIds(prev => {
        const next = new Set(prev)
        next.delete(flashId)
        return next
      })
    }, 1400)
  }, [expandedLineIds])

  // ── RC assignment ───────────────────────────────────────────────────────────
  const setLineRc = useCallback((id: string, rc: RevenueCenter | null) => {
    updateLine(id, { revenueCenterId: rc?.id ?? null })
  }, [updateLine])

  // ── Filters / sort ──────────────────────────────────────────────────────────
  const toggleFilter = useCallback((k: FilterKey) => {
    setActiveFilters(prev => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }, [])

  // ── Price-change acknowledgement ─────────────────────────────────────────────
  const acknowledgePrice = useCallback((id: string) => {
    setAcknowledgedPriceLines(prev => new Set(prev).add(id))
  }, [])

  // ── Low-trust line confirmation ──────────────────────────────────────────────
  const acknowledgeConf = useCallback((id: string) => {
    setAcknowledgedConfLines(prev => new Set(prev).add(id))
  }, [])

  // ── Mobile: jump to the image tab with a line's bbox highlighted ─────────────
  const showLineOnImage = useCallback((id: string) => {
    setActiveBboxItemId(id)
    setMobileTab('image')
  }, [])

  // ── Approve ─────────────────────────────────────────────────────────────────
  const handleApprove = async (force = false) => {
    if (!session) return

    // Untracked-spend guard: a PENDING line (unmatched, or a low-confidence match the
    // user never confirmed) is SKIPPED by approve — its money is paid but its stock is
    // never credited. Surface it so purchases can't silently fail to reach inventory.
    // (SKIP lines are intentional — cleaning supplies etc. — so they're excluded.)
    if (!force) {
      const untracked = session.scanItems.filter(
        i => i.action === 'PENDING' && Number(i.rawLineTotal ?? 0) > 0,
      )
      if (untracked.length > 0) {
        const total = untracked.reduce((s, i) => s + Number(i.rawLineTotal ?? 0), 0)
        const list = untracked
          .slice(0, 8)
          .map(i => `• ${formatCurrency(Number(i.rawLineTotal ?? 0))}  ${(i.rawDescription ?? '').slice(0, 42)}`)
          .join('\n')
        const more = untracked.length > 8 ? `\n…and ${untracked.length - 8} more` : ''
        const ok = window.confirm(
          `${untracked.length} unmatched line${untracked.length > 1 ? 's' : ''} (${formatCurrency(total)}) ` +
            `won't be tracked in stock — the purchase won't add to inventory:\n\n${list}${more}\n\n` +
            `Match them first, or approve anyway?`,
        )
        if (!ok) return
      }
    }

    setApproving(true)
    try {
      // Make sure staged line edits (e.g. a just-clicked format consent) are
      // on the server before it snapshots the scan items.
      await flushPendingEdits()
      const res = await fetch(`/api/invoices/sessions/${session.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force }),
      })
      const result = await res.json()
      if (res.status === 409 && result.duplicate && !force) {
        const ok = window.confirm(`${result.error}\n\nApprove anyway?`)
        if (ok) { return await handleApprove(true) }
        return
      }
      if (!res.ok) {
        alert(`Approval failed: ${result.error ?? res.statusText}`)
        return
      }
      setApproved(true)
      // Optimistically flip the list row to APPROVING so the user sees the
      // transient state immediately AND the parent's fast (3s) poll engages.
      onApproveOrReject({ id: session.id, status: 'APPROVING' })
      if (result.queued) onClose()
    } catch {
      alert('Network error — please try again.')
    } finally {
      setApproving(false)
    }
  }

  // ── Reject ──────────────────────────────────────────────────────────────────
  const handleReject = async () => {
    if (!session) return
    const ok = window.confirm('Reject this invoice? It will be marked as rejected and no prices will be updated.')
    if (!ok) return
    await fetch(`/api/invoices/sessions/${session.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'REJECTED' }),
    })
    onApproveOrReject()
    onClose()
  }

  // ── Keyboard model (mock §6): Esc close · ⌘⏎ approve · R reject · J/K nav ────
  const visibleIdsRef = useRef<string[]>([])
  const focusedIdRef  = useRef<string | null>(null)

  const focusLine = useCallback((id: string) => {
    focusedIdRef.current = id
    scrollPendingRef.current = id
    toggleExpand(id, true)
  }, [toggleExpand])

  useEffect(() => {
    const reviewing = !!session && !approved && !approving
      && session.status !== 'APPROVED' && session.status !== 'REJECTED'
    if (!reviewing) return
    // Don't steal keys while a nested modal is open.
    if (creatingNewForItem || editingInventoryItemId) return

    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)

      if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        if (canApprove) handleApprove()
        return
      }
      if (typing) return
      if (e.key === 'r' || e.key === 'R') { e.preventDefault(); handleReject(); return }
      if (e.key === '[' && navPrev) { e.preventDefault(); navPrev(); return }
      if (e.key === ']' && navNext) { e.preventDefault(); navNext(); return }
      if (e.key === 'j' || e.key === 'J' || e.key === 'k' || e.key === 'K' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const ids = visibleIdsRef.current
        if (ids.length === 0) return
        e.preventDefault()
        const down = e.key === 'j' || e.key === 'J' || e.key === 'ArrowDown'
        const cur  = focusedIdRef.current ? ids.indexOf(focusedIdRef.current) : -1
        const next = down
          ? ids[Math.min(cur + 1, ids.length - 1)] ?? ids[0]
          : ids[Math.max(cur - 1, 0)] ?? ids[0]
        focusLine(next)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [session, approved, approving, creatingNewForItem, editingInventoryItemId, canApprove, navPrev, navNext, focusLine, onClose]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the J/K navigation order in sync with what's actually rendered.
  useEffect(() => {
    const ids: string[] = []
    if (reviewSegment !== 'matched') ids.push(...sections.attention.map(i => i.id))
    if (reviewSegment !== 'issues')  ids.push(...sections.matched.map(i => i.id))
    if (reviewSegment === 'all')     ids.push(...sections.charges.map(i => i.id))
    visibleIdsRef.current = ids
  }, [sections, reviewSegment])

  // ── Compute active bbox for the image viewer ────────────────────────────────
  const activeBbox = useMemo<BBox | null>(() => {
    if (!activeBboxItemId) return null
    const line = session?.scanItems.find(i => i.id === activeBboxItemId)
    const edits = editedLines.get(activeBboxItemId)
    const effective = edits ? { ...line, ...edits } : line
    const b = effective?.bbox
    if (!b || typeof b !== 'object') return null
    const bb = b as Record<string, unknown>
    if (
      typeof bb.x !== 'number' || typeof bb.y !== 'number' ||
      typeof bb.w !== 'number' || typeof bb.h !== 'number'
    ) return null
    return { page: typeof bb.page === 'number' ? bb.page : 0, x: bb.x, y: bb.y, w: bb.w, h: bb.h }
  }, [activeBboxItemId, session, editedLines])

  // ── Non-destructive dimension-conflict resolver ──────────────────────────────
  // Sets the item's eachMeasure bridge so 1 each = N unit (e.g. 1100 g), without
  // changing the item's dimension, packChain, stock, or recipes. After the write
  // the session is silently refreshed so hasDimensionConflict re-evaluates to false
  // and the line falls through to the normal PACK approval path.
  const bridgeAndReceiveAsCount = useCallback(async (item: ScanItem, measure?: { qty: number; unit: string }) => {
    const md = item.matchedItem
    if (!md?.id) return
    // Per-each measure: prefer the user's explicit override (the editable resolver),
    // else derive from the scan item. For a per_weight (RATE) line the rateUOM is
    // the unit; for a per_case (PACK) line the pack UOM is the unit; the quantity
    // is how much mass/volume is in one each.
    const rawQty  = measure ? measure.qty : (item.invoicePackSize != null ? Number(item.invoicePackSize) : null)
    const rawUnit = measure ? measure.unit.toLowerCase() : (item.invoicePackUOM ?? item.rateUOM ?? null)?.toLowerCase() ?? null
    if (!(rawQty != null && rawQty > 0) || !rawUnit) return

    await fetch(`/api/inventory/${md.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dimension:  md.dimension ?? 'COUNT',   // unchanged
        packChain:  md.packChain,              // unchanged — route 400s if missing
        pricing:    md.pricing,               // unchanged
        countUnit:  md.countUnit ?? null,     // unchanged
        eachMeasureQty:  rawQty,
        eachMeasureUnit: rawUnit,
      }),
    })
    if (session) await refreshSession(session.id)
  }, [session, refreshSession])

  // ── Non-destructive weight↔volume resolver ──────────────────────────────────
  // Sets the item's densityGPerMl so a measured invoice in the other dimension
  // (e.g. a weight invoice on a volume item, or vice-versa) costs correctly,
  // without changing the item's dimension, packChain, stock, or recipes.
  const setItemDensity = useCallback(async (item: ScanItem, gPerMl: number) => {
    const md = item.matchedItem
    if (!md?.id || !(gPerMl > 0)) return
    await fetch(`/api/inventory/${md.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dimension:  md.dimension,        // unchanged
        packChain:  md.packChain,        // unchanged
        pricing:    md.pricing,          // unchanged
        countUnit:  md.countUnit ?? null,// unchanged
        densityGPerMl: gPerMl,           // ← the only meaningful write
      }),
    })
    if (session) await refreshSession(session.id)
  }, [session, refreshSession])

  // ── Context value ────────────────────────────────────────────────────────────
  const ctxValue = useMemo<DrawerContextValue>(() => ({
    lines: session?.scanItems ?? [],
    revenueCenters,
    sessionSupplierName: session?.supplierName ?? null,
    sessionSupplierId: session?.supplierId ?? null,
    sessionRcId: session?.revenueCenterId ?? null,
    editedLines,
    expandedLineIds,
    flashingLineIds,
    activeFilters,
    sortMode,
    pickingLinkForId,
    acknowledgedPriceLines,
    acknowledgedConfLines,
    reconciliation,
    getEffectiveLine,
    getItemRc,
    updateLine,
    clearLineEdits,
    toggleExpand,
    setLineRc,
    startLinkPicker: (id) => setPickingLinkForId(id),
    closeLinkPicker: ()   => setPickingLinkForId(null),
    openCreateNew:          (item) => setCreatingNewForItem(item),
    openInventoryEdit:      (id)   => setEditingInventoryItemId(id),
    adoptInvoiceFormat:     (item) => setAdoptingForItem(item),
    bridgeAndReceiveAsCount,
    setItemDensity,
    acknowledgePrice,
    acknowledgeConf,
    activeBboxItemId,
    showLineOnImage,
    toggleFilter,
    setSortMode,
  }), [
    session, revenueCenters, editedLines, expandedLineIds, flashingLineIds,
    activeFilters, sortMode, pickingLinkForId, acknowledgedPriceLines, acknowledgedConfLines, reconciliation,
    getEffectiveLine, getItemRc, updateLine, clearLineEdits, toggleExpand,
    setLineRc, bridgeAndReceiveAsCount, setItemDensity, acknowledgePrice, acknowledgeConf, activeBboxItemId, showLineOnImage, toggleFilter,
  ])

  // ── Panel open/close animation ───────────────────────────────────────────────
  const isOpen = sessionId !== null

  return (
    <>
      {/* Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/25 z-40 transition-opacity"
          onClick={onClose}
        />
      )}

      {/* Drawer panel — wider to fit image viewer + review side by side */}
      <div
        className={`fixed inset-y-0 right-0 z-[60] bg-paper shadow-2xl flex flex-col transition-transform duration-300 ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
        style={{
          width: (!approved && session?.status !== 'APPROVED' && session?.status !== 'REJECTED' && session?.files?.length)
            ? '1340px' : '620px',
          maxWidth: '100vw',
        }}
      >
        {loading || !session ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 size={28} className="text-line-2 animate-spin" />
          </div>
        ) : approved || session.status === 'APPROVED' || session.status === 'REJECTED' ? (
          <ApprovedView
            session={session}
            onClose={onClose}
            onReviewAgain={() => {
              setApproved(false)
              onApproveOrReject()
              fetchSession(session.id)
            }}
          />
        ) : (
          <DrawerContext.Provider value={ctxValue}>
            {/* Full-width header */}
            <InvoiceHeader
              session={session}
              revenueCenters={revenueCenters}
              onRcChange={handleSessionRcChange}
              onClose={onClose}
              queuePos={queuePos}
              onPrev={navPrev}
              onNext={navNext}
            />

            {/* Cost-chrome impact strip — Principle 01 */}
            <ImpactStrip metrics={impactMetrics} helper="on approve" />

            {/* Invoice-wide banners */}
            {duplicateSessions.length > 0 && !bannerDismissed && (
              <div className="flex items-center gap-3 bg-red-soft border-b border-[#fecaca] px-[22px] py-[11px] text-[13px] text-red-text">
                <AlertTriangle size={16} className="text-red shrink-0" strokeWidth={2.2} />
                <span className="flex-1 min-w-0">
                  <b className="font-semibold">Possible duplicate.</b>{' '}
                  Invoice #{session.invoiceNumber} was already scanned
                  {duplicateSessions[0].supplierName ? ` from ${duplicateSessions[0].supplierName}` : ''}{' '}
                  ({duplicateSessions[0].status.toLowerCase()}). Review carefully.
                </span>
                <button
                  type="button"
                  onClick={() => setBannerDismissed(true)}
                  className="font-mono text-[10.5px] font-semibold px-2.5 py-1 rounded-full bg-red/10 text-red-text hover:bg-red/20 transition-colors shrink-0"
                >
                  Dismiss
                </button>
              </div>
            )}
            {reconciliation?.status === 'mismatch' && !bannerDismissed && (
              <AlertBanner
                onIgnore={() => setBannerDismissed(true)}
                onShowFix={reconciliation.suggestedFixItemId ? () => setActiveBboxItemId(reconciliation.suggestedFixItemId) : undefined}
              >
                <b className="font-semibold">{formatCurrency(Math.abs(reconciliation.delta))} mismatch</b>
                {' '}— sum of lines doesn&rsquo;t tie to the invoice subtotal.
                {reconciliation.suggestedFixItemId && ' One line looks off.'}
              </AlertBanner>
            )}

            {/* Mobile tab bar — only shown on small screens when files exist */}
            {session.files.length > 0 && (
              <div className="md:hidden flex border-b border-line shrink-0">
                <button
                  onClick={() => setMobileTab('review')}
                  className={`flex-1 py-2.5 text-[13px] font-medium transition-colors ${
                    mobileTab === 'review'
                      ? 'text-ink border-b-2 border-ink'
                      : 'text-ink-4'
                  }`}
                >
                  Review items
                </button>
                <button
                  onClick={() => setMobileTab('image')}
                  className={`flex-1 py-2.5 text-[13px] font-medium transition-colors ${
                    mobileTab === 'image'
                      ? 'text-ink border-b-2 border-ink'
                      : 'text-ink-4'
                  }`}
                >
                  Invoice image
                </button>
              </div>
            )}

            {/* Body: image viewer (left) + review panel (right) on desktop;
                    tabs control which panel is visible on mobile */}
            <div className="flex flex-1 min-h-0 overflow-hidden">

              {/* ── Image viewer ───────────────────────────────────────────── */}
              {session.files.length > 0 && (
                <>
                  <div className={mobileTab === 'review' ? 'hidden md:contents' : 'contents'}>
                    <ImageViewerV2
                      files={session.files}
                      activeBbox={activeBbox}
                      sessionId={session.id}
                      activeBboxItemId={activeBboxItemId}
                      onPickRegion={(id) => { toggleExpand(id, true); setMobileTab('review') }}
                      onFileRotated={(fileId, displayRotation) =>
                        setSession(prev => prev ? {
                          ...prev,
                          files: prev.files.map(f => f.id === fileId ? { ...f, displayRotation } : f),
                        } : prev)
                      }
                    />
                  </div>
                  <div className="hidden md:block w-px bg-line shrink-0" />
                </>
              )}

              {/* ── Review panel ───────────────────────────────────────────── */}
              <div className={`flex flex-col flex-1 min-w-0 min-h-0 md:flex-none md:w-[680px] overflow-hidden ${
                session.files.length > 0 && mobileTab === 'image' ? 'hidden md:flex' : 'flex'
              }`}>
                {/* Review progress + segmented filter */}
                <ReviewProgress
                  resolved={progress.resolved}
                  total={progress.total}
                  segment={reviewSegment}
                  onSegment={setReviewSegment}
                  counts={segmentCounts}
                />

                {/* Line item list — grouped by section */}
                <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-[18px] pt-3 pb-10 scroll-pt-3 flex flex-col gap-1.5 [&>*]:shrink-0">
                  {/* Needs your attention */}
                  {(reviewSegment === 'all' || reviewSegment === 'issues') && (sections.attention.length > 0 || supplierNeedsLink) && (
                    <>
                      <SectionDivider
                        tone="red"
                        label="Needs your attention"
                        count={`${sections.attention.length + (supplierNeedsLink ? 1 : 0)} item${sections.attention.length + (supplierNeedsLink ? 1 : 0) !== 1 ? 's' : ''}`}
                      />
                      {supplierNeedsLink && (
                        <SupplierLinkCard
                          supplierName={session.supplierName}
                          comboOpen={supplierComboOpen}
                          suppliers={allSuppliers}
                          search={supplierSearch}
                          onSearch={setSupplierSearch}
                          onOpenCombo={() => { loadSuppliers(); setSupplierComboOpen(v => !v) }}
                          onPick={handleLinkSupplier}
                          onCreate={handleCreateSupplier}
                          onSkip={() => { setSupplierSkipped(true); setSupplierComboOpen(false) }}
                        />
                      )}
                      {sections.attention.map(i => (
                        <LineItemCard key={i.id} lineId={i.id} displayNo={sections.displayNo.get(i.id) ?? 0} />
                      ))}
                    </>
                  )}

                  {/* Auto-matched */}
                  {(reviewSegment === 'all' || reviewSegment === 'matched') && sections.matched.length > 0 && (
                    <>
                      <SectionDivider tone="green" label="Auto-matched" count={`${sections.matched.length} line${sections.matched.length !== 1 ? 's' : ''}`} />
                      {sections.matched.map(i => (
                        <LineItemCard key={i.id} lineId={i.id} displayNo={sections.displayNo.get(i.id) ?? 0} />
                      ))}
                    </>
                  )}

                  {/* Other line items (skipped / non-inventory) */}
                  {reviewSegment === 'all' && sections.charges.length > 0 && (
                    <>
                      <SectionDivider tone="neutral" label="Other line items" count={`${sections.charges.length} not inventory`} />
                      {sections.charges.map(i => (
                        <LineItemCard key={i.id} lineId={i.id} displayNo={sections.displayNo.get(i.id) ?? 0} />
                      ))}
                    </>
                  )}

                  {sections.attention.length === 0 && sections.matched.length === 0 && sections.charges.length === 0 && (
                    <div className="flex items-center justify-center h-32 text-[13px] text-ink-4">No line items.</div>
                  )}
                </div>

                {/* Footer */}
                {!approving ? (
                  <DrawerFooter
                    priceWrites={priceWrites}
                    newItems={newItemsCount}
                    supplierLink={initialAttention.supplier && !!linkedSupplierId}
                    canApprove={canApprove}
                    disabledReason={disabledReason}
                    onApprove={() => handleApprove()}
                    onReject={handleReject}
                    saveStatus={saveStatus}
                  />
                ) : (
                  <div
                    className="border-t border-line px-[18px] py-[13px] flex items-center justify-center gap-3 shrink-0"
                    style={{ paddingBottom: 'calc(13px + env(safe-area-inset-bottom, 0px))' }}
                  >
                    <Loader2 size={16} className="animate-spin text-ink-3" />
                    <span className="text-[13px] text-ink-3">Approving…</span>
                  </div>
                )}
              </div>
            </div>
          </DrawerContext.Provider>
        )}
      </div>

      {/* Inventory item edit — overlays the invoice drawer */}
      {editingInventoryItemId && (
        <InventoryItemDrawer
          itemId={editingInventoryItemId}
          onClose={() => setEditingInventoryItemId(null)}
          onUpdated={() => { if (session) refreshSession(session.id) }}
        />
      )}

      {/* Dimension-conflict resolver — change the item to match the invoice line */}
      {adoptingForItem && (
        <AdoptFormatModal
          scanItem={adoptingForItem}
          onClose={() => setAdoptingForItem(null)}
          onSaved={() => { setAdoptingForItem(null); if (session) refreshSession(session.id) }}
        />
      )}

      {/* Create new item mini-modal */}
      {creatingNewForItem && (
        <AddNewItemModal
          item={creatingNewForItem}
          sessionId={session?.id ?? ''}
          sessionSupplierId={session?.supplierId ?? null}
          sessionSupplierName={session?.supplierName ?? null}
          onSaved={(newItemDataJson) => {
            if (creatingNewForItem) {
              updateLine(creatingNewForItem.id, {
                action: 'CREATE_NEW',
                isNewItem: true,
                matchedItemId: null,
                matchedItem: null,
                // staged locally so the card reads as configured immediately —
                // isUnlinked/isCreateNew key off newItemData being present
                newItemData: newItemDataJson,
              })
            }
            setCreatingNewForItem(null)
            if (session) refreshSession(session.id)
          }}
          onClose={() => setCreatingNewForItem(null)}
        />
      )}
    </>
  )
}

// ─── ApprovedView ──────────────────────────────────────────────────────────────
// Full read-only view for APPROVED / REJECTED sessions.

function ApprovedView({
  session,
  onClose,
  onReviewAgain,
}: {
  session: Session
  onClose: () => void
  onReviewAgain: () => void
}) {
  const [priceAlertsOpen,  setPriceAlertsOpen]  = useState(true)
  const [recipeAlertsOpen, setRecipeAlertsOpen] = useState(true)
  const [reverting,        setReverting]        = useState(false)

  const rejected  = session.status === 'REJECTED'
  const total     = session.total    ? Number(session.total)    : null
  const subtotal  = session.subtotal ? Number(session.subtotal) : null
  const tax       = session.tax      ? Number(session.tax)      : null

  const activeItems   = session.scanItems.filter(i => i.action !== 'SKIP')
  const updatedItems  = session.scanItems.filter(i => i.action === 'UPDATE_PRICE' && i.approved)
  const newItems      = session.scanItems.filter(i => i.isNewItem && i.approved)
  const skippedItems  = session.scanItems.filter(i => i.action === 'SKIP')

  const metaParts: string[] = []
  if (session.invoiceNumber) metaParts.push(`#${session.invoiceNumber}`)
  if (session.invoiceDate)   metaParts.push(session.invoiceDate)
  metaParts.push(`${activeItems.length} line${activeItems.length !== 1 ? 's' : ''}`)

  const handleReviewAgain = async () => {
    setReverting(true)
    try {
      await fetch(`/api/invoices/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'REVIEW' }),
      })
      onReviewAgain()
    } finally {
      setReverting(false)
    }
  }

  return (
    <div className="flex flex-col h-full">

      {/* ── Header ── */}
      <div
        className={`px-[22px] pt-[18px] pb-[16px] border-b border-line ${rejected ? 'bg-paper' : 'bg-gradient-to-r from-green-soft/60 to-white'}`}
        style={{ paddingTop: 'calc(18px + env(safe-area-inset-top, 0px))' }}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5 mb-[5px]">
              <div className={`flex items-center gap-1.5 px-2.5 py-[3px] rounded-full text-[11px] font-semibold ${
                rejected
                  ? 'bg-red-soft text-red-text'
                  : 'bg-green-soft text-green-text'
              }`}>
                {rejected ? <X size={10} /> : <Check size={10} />}
                {rejected ? 'Rejected' : 'Applied'}
              </div>
            </div>
            <h2 className="text-[19px] font-semibold text-ink leading-[1.2] truncate">
              {session.supplierName ?? 'Unknown supplier'}
            </h2>
            <p className="text-[12.5px] text-ink-4 mt-[3px]">{metaParts.join(' · ')}</p>
          </div>

          <div className="text-right shrink-0">
            <div className="text-[24px] font-semibold text-ink leading-none tabular-nums">
              {total !== null ? formatCurrency(total) : '—'}
            </div>
            {(subtotal !== null || tax !== null) && (
              <div className="text-[11.5px] text-ink-4 mt-[4px] tabular-nums">
                {subtotal !== null && `sub ${formatCurrency(subtotal)}`}
                {subtotal !== null && tax !== null && ' · '}
                {tax !== null && `tax ${formatCurrency(tax)}`}
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={onClose}
            className="shrink-0 p-2.5 flex items-center justify-center rounded-lg text-ink-4 hover:text-ink-2 hover:bg-bg-2 transition-colors"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="flex-1 overflow-y-auto">

        {/* Summary stat cards */}
        {!rejected && (
          <div className="px-[18px] pt-[16px] pb-[4px] grid grid-cols-4 gap-3">
            <div className="bg-bg border border-bg-2 rounded-xl p-3 text-center">
              <div className="text-[22px] font-semibold text-ink tabular-nums leading-none">{updatedItems.length}</div>
              <div className="text-[11px] text-ink-4 mt-1">prices updated</div>
            </div>
            <div className="bg-bg border border-bg-2 rounded-xl p-3 text-center">
              <div className="text-[22px] font-semibold text-ink tabular-nums leading-none">{newItems.length}</div>
              <div className="text-[11px] text-ink-4 mt-1">new items</div>
            </div>
            <div className="bg-bg border border-bg-2 rounded-xl p-3 text-center">
              <div className="text-[22px] font-semibold text-ink tabular-nums leading-none">{session.priceAlerts.length}</div>
              <div className="text-[11px] text-ink-4 mt-1">price alerts</div>
            </div>
            <div className="bg-bg border border-bg-2 rounded-xl p-3 text-center">
              <div className="text-[22px] font-semibold text-ink tabular-nums leading-none">{session.recipeAlerts.length}</div>
              <div className="text-[11px] text-ink-4 mt-1">recipe impacts</div>
            </div>
          </div>
        )}

        {/* ── Line items ── */}
        <div className="px-[18px] pt-[16px]">
          <p className="text-[11px] font-semibold text-ink-4 uppercase tracking-wider mb-2">Line items</p>
          <div className="border border-bg-2 rounded-xl overflow-hidden divide-y divide-bg-2">
            {session.scanItems.map(item => {
              const prevPrice = item.previousPrice ? Number(item.previousPrice) : null
              const newPrice  = item.newPrice      ? Number(item.newPrice)      : null
              const diffPct   = item.priceDiffPct  ? Number(item.priceDiffPct)  : null
              const lineTotal = item.rawLineTotal  ? Number(item.rawLineTotal)  : null
              const isSkip    = item.action === 'SKIP'
              const isNew     = item.isNewItem && item.approved
              const isUpdate  = item.action === 'UPDATE_PRICE' && item.approved

              return (
                <div key={item.id} className={`flex items-center gap-3 px-4 py-3 ${isSkip ? 'opacity-40' : ''}`}>
                  {/* Icon */}
                  <div className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${
                    isNew    ? 'bg-green-soft'  :
                    isUpdate ? 'bg-blue-soft'      :
                    isSkip   ? 'bg-bg-2'    : 'bg-bg'
                  }`}>
                    {isNew    ? <Package  size={13} className="text-green-text" /> :
                     isSkip   ? <X        size={13} className="text-ink-4"   /> :
                                <Tag      size={13} className="text-blue"    />}
                  </div>

                  {/* Name + badge */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[13px] font-medium text-ink-2 truncate">
                        {item.matchedItem?.itemName ?? item.rawDescription}
                      </span>
                      {isNew && (
                        <span className="text-[10px] font-semibold px-1.5 py-[1px] rounded bg-green-soft text-green-text">NEW</span>
                      )}
                      {isSkip && (
                        <span className="text-[10px] font-semibold px-1.5 py-[1px] rounded bg-bg-2 text-ink-4">SKIPPED</span>
                      )}
                    </div>
                    {item.rawDescription !== item.matchedItem?.itemName && item.matchedItem && (
                      <div className="text-[11px] text-ink-4 truncate mt-0.5">{item.rawDescription}</div>
                    )}
                  </div>

                  {/* Price change */}
                  {!isSkip && !isNew && prevPrice !== null && newPrice !== null ? (
                    <div className="shrink-0 text-right">
                      <div className="flex items-center gap-1.5 justify-end">
                        <span className="text-[12px] text-ink-4 line-through tabular-nums">{formatCurrency(prevPrice)}</span>
                        <span className="text-[12px] font-medium text-ink-2 tabular-nums">{formatCurrency(newPrice)}</span>
                        {diffPct !== null && (
                          <span className={`text-[11px] font-semibold ${diffPct > 0 ? 'text-red' : 'text-green-text'}`}>
                            {diffPct > 0 ? '+' : ''}{diffPct.toFixed(1)}%
                          </span>
                        )}
                      </div>
                      {lineTotal !== null && (
                        <div className="text-[11px] text-ink-4 mt-0.5 tabular-nums">{formatCurrency(lineTotal)}</div>
                      )}
                    </div>
                  ) : lineTotal !== null ? (
                    <div className="shrink-0 text-[12px] text-ink-3 tabular-nums">{formatCurrency(lineTotal)}</div>
                  ) : null}
                </div>
              )
            })}
          </div>
        </div>

        {/* ── Price alerts ── */}
        {session.priceAlerts.length > 0 && (
          <div className="px-[18px] pt-[16px]">
            <button
              type="button"
              onClick={() => setPriceAlertsOpen(v => !v)}
              className="w-full flex items-center justify-between mb-2 group"
            >
              <p className="text-[11px] font-semibold text-ink-4 uppercase tracking-wider">
                Price alerts ({session.priceAlerts.length})
              </p>
              {priceAlertsOpen
                ? <ChevronUp   size={14} className="text-ink-4 group-hover:text-ink-3" />
                : <ChevronDown size={14} className="text-ink-4 group-hover:text-ink-3" />}
            </button>
            {priceAlertsOpen && (
              <div className="border border-bg-2 rounded-xl overflow-hidden divide-y divide-bg-2">
                {session.priceAlerts.map(alert => {
                  const prev    = Number(alert.previousPrice)
                  const next    = Number(alert.newPrice)
                  const pct     = Number(alert.changePct)
                  const up      = alert.direction === 'UP'
                  return (
                    <div key={alert.id} className="flex items-center gap-3 px-4 py-3">
                      <div className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${up ? 'bg-red-soft' : 'bg-green-soft'}`}>
                        {up
                          ? <TrendingUp   size={13} className="text-red"     />
                          : <TrendingDown size={13} className="text-green-text" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <span className="text-[13px] font-medium text-ink-2">{alert.inventoryItem.itemName}</span>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="flex items-center gap-1.5 justify-end">
                          <span className="text-[12px] text-ink-4 line-through tabular-nums">{formatCurrency(prev)}</span>
                          <span className="text-[12px] font-medium text-ink-2 tabular-nums">{formatCurrency(next)}</span>
                          <span className={`text-[11px] font-semibold ${up ? 'text-red' : 'text-green-text'}`}>
                            {up ? '+' : ''}{pct.toFixed(1)}%
                          </span>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* ── Recipe impacts ── */}
        {session.recipeAlerts.length > 0 && (
          <div className="px-[18px] pt-[16px]">
            <button
              type="button"
              onClick={() => setRecipeAlertsOpen(v => !v)}
              className="w-full flex items-center justify-between mb-2 group"
            >
              <p className="text-[11px] font-semibold text-ink-4 uppercase tracking-wider">
                Recipe impacts ({session.recipeAlerts.length})
              </p>
              {recipeAlertsOpen
                ? <ChevronUp   size={14} className="text-ink-4 group-hover:text-ink-3" />
                : <ChevronDown size={14} className="text-ink-4 group-hover:text-ink-3" />}
            </button>
            {recipeAlertsOpen && (
              <div className="border border-bg-2 rounded-xl overflow-hidden divide-y divide-bg-2">
                {session.recipeAlerts.map(alert => {
                  const prevCost  = Number(alert.previousCost)
                  const newCost   = Number(alert.newCost)
                  const pct       = Number(alert.changePct)
                  const foodCost  = alert.newFoodCostPct ? Number(alert.newFoodCostPct) : null
                  const up        = pct > 0
                  return (
                    <div key={alert.id} className="flex items-center gap-3 px-4 py-3">
                      <div className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${up ? 'bg-gold-soft' : 'bg-green-soft'}`}>
                        <BookOpen size={13} className={up ? 'text-gold' : 'text-green-text'} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <span className="text-[13px] font-medium text-ink-2">{alert.recipe.name}</span>
                        {foodCost !== null && (
                          <div className="text-[11px] text-ink-4 mt-0.5">food cost {foodCost.toFixed(1)}%</div>
                        )}
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="flex items-center gap-1.5 justify-end">
                          <span className="text-[12px] text-ink-4 line-through tabular-nums">{formatCurrency(prevCost)}</span>
                          <span className="text-[12px] font-medium text-ink-2 tabular-nums">{formatCurrency(newCost)}</span>
                          <span className={`text-[11px] font-semibold ${up ? 'text-gold' : 'text-green-text'}`}>
                            {up ? '+' : ''}{pct.toFixed(1)}%
                          </span>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        <div className="h-6" />
      </div>

      {/* ── Footer ── */}
      <div
        className="border-t border-line px-[18px] py-[13px] flex items-center justify-between gap-3 bg-paper"
        style={{ paddingBottom: 'calc(13px + env(safe-area-inset-bottom, 0px))' }}
      >
        {!rejected ? (
          <button
            type="button"
            onClick={handleReviewAgain}
            disabled={reverting}
            className="flex items-center gap-1.5 text-[13px] text-ink-3 hover:text-ink-2 transition-colors disabled:opacity-50"
          >
            {reverting
              ? <Loader2 size={14} className="animate-spin" />
              : <RotateCcw size={14} />}
            Review again
          </button>
        ) : <div />}
        <button
          type="button"
          onClick={onClose}
          className="px-5 py-2 text-[13px] bg-ink text-paper rounded-lg hover:bg-ink-2 transition-colors"
        >
          Close
        </button>
      </div>
    </div>
  )
}

// ─── AddNewItemModal ───────────────────────────────────────────────────────────
// Full form to configure a new inventory item before approve creates it.

function AddNewItemModal({
  item,
  sessionId,
  sessionSupplierId,
  sessionSupplierName,
  onSaved,
  onClose,
}: {
  item: ScanItem
  sessionId: string
  /** The invoice's supplier — pre-selected so a new product inherits it. */
  sessionSupplierId: string | null
  sessionSupplierName: string | null
  /** Receives the configured newItemData as the stored JSON string. */
  onSaved: (newItemDataJson: string) => void
  onClose: () => void
}) {
  const [saving,     setSaving]     = useState(false)
  const [categories, setCategories] = useState<string[]>([])
  const [suppliers,    setSuppliers]    = useState<{ id: string; name: string }[]>([])
  const [storageAreas, setStorageAreas] = useState<{ id: string; name: string }[]>([])
  const [itemName,     setItemName]     = useState(item.rawDescription ?? '')
  const [category,     setCategory]     = useState('DRY')
  const [supplierId,   setSupplierId]   = useState<string>(sessionSupplierId ?? '')
  const [storageAreaId, setStorageAreaId] = useState<string>('')

  // Seed the chain from the invoice's OCR'd pack fields via the same formToChain
  // helper the approve route uses — so the form opens pre-filled to what the
  // scan saw, and the manager only confirms or tweaks.
  const seed = useMemo(() => formToChain({
    // canonicalize the OCR'd unit (e.g. 'CS' → 'case') so the seeded chain lands
    // on a clean, selectable level unit rather than a raw invoice token.
    purchaseUnit:       canonicalUom(item.rawUnit) || 'case',
    purchasePrice:      Number(item.rate ?? item.rawUnitPrice ?? item.newPrice ?? 0),
    qtyPerPurchaseUnit: Number(item.invoicePackQty) || 1,
    qtyUOM:             'each',
    innerQty:           null,
    packSize:           Number(item.invoicePackSize) || 1,
    packUOM:            item.invoicePackUOM ?? 'each',
    priceType:          item.pricingMode === 'per_weight' ? 'UOM' : 'CASE',
    countUOM:           'each',
  }), [item])

  const [dimension, setDimension] = useState<Dimension>(seed.dimension)
  const [chain,     setChain]     = useState<PackLink[]>(seed.packChain)
  const [pricing,   setPricing]   = useState<Pricing>(seed.pricing)
  const [countUnit, setCountUnit] = useState<string>(seed.countUnit)

  useEffect(() => {
    fetch('/api/categories').then(r => r.json()).then((data: { name: string }[]) => {
      setCategories(data.map(c => c.name))
    }).catch(() => {})
    fetch('/api/suppliers').then(r => r.json()).then((data: { id: string; name: string }[]) => {
      setSuppliers(data)
      // If the invoice's supplier isn't in the directory yet, surface its name as a
      // pre-selected option so it still shows as chosen.
    }).catch(() => {})
    fetch('/api/storage-areas').then(r => r.json()).then((data: { id: string; name: string }[]) => {
      setStorageAreas(data)
    }).catch(() => {})
  }, [])

  const baseUnit = DIMENSION_BASE[dimension]
  const chainItem = { dimension, baseUnit, packChain: chain, pricing, countUnit }
  const ppb = pricePerBaseUnit(chainItem)
  const perCount = basePerUnit(chainItem, countUnit)

  const handleSave = async () => {
    const errors = validateChainItem(chainItem)
    if (errors.length) { alert(errors.join('; ')); return }
    setSaving(true)
    // Chain-shaped newItemData — the approve route stores dimension/packChain/
    // pricing/countUnit directly (with a legacy-field fallback for any session
    // configured before this form was migrated).
    const newItemData = {
      itemName: itemName.trim() || item.rawDescription,
      category,
      supplierId: supplierId || null,
      storageAreaId: storageAreaId || null,
      dimension,
      packChain: chain,
      pricing,
      countUnit,
    }
    await fetch(`/api/invoices/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scanItemId:    item.id,
        action:        'CREATE_NEW',
        isNewItem:     true,
        matchedItemId: null,
        newItemData,
      }),
    })
    setSaving(false)
    onSaved(JSON.stringify(newItemData))
  }

  const inputCls = 'w-full border border-line rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-gold'
  const labelCls = 'block text-xs font-medium text-ink-3 mb-1'

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-[60]" onClick={onClose} />
      <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
        <div className="bg-paper rounded-2xl shadow-xl w-full max-w-md flex flex-col max-h-[90vh]">
          {/* Header */}
          <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-bg-2">
            <div>
              <h3 className="text-[16px] font-semibold text-ink">Create new product</h3>
              <p className="text-[12px] text-ink-4 mt-0.5">These fields will be set when the invoice is approved.</p>
            </div>
            <button type="button" onClick={onClose} className="p-2.5 flex items-center justify-center text-ink-4 hover:text-ink-3 transition-colors">
              <X size={18} />
            </button>
          </div>

          {/* Form */}
          <div className="overflow-y-auto px-6 py-5 space-y-4">
            {/* Item name */}
            <div>
              <label className={labelCls}>Item name</label>
              <input
                type="text"
                value={itemName}
                onChange={e => setItemName(e.target.value)}
                className={inputCls}
                placeholder={item.rawDescription ?? ''}
              />
            </div>

            {/* Category */}
            <div>
              <label className={labelCls}>Category</label>
              <select value={category} onChange={e => setCategory(e.target.value)} className={`${inputCls} bg-white`}>
                {(categories.length ? categories : ['DRY', 'DAIRY', 'MEAT', 'PRODUCE', 'FROZEN', 'BEVERAGE', 'OTHER']).map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>

            {/* Supplier — pre-selected from the invoice */}
            <div>
              <label className={labelCls}>Supplier</label>
              <select value={supplierId} onChange={e => setSupplierId(e.target.value)} className={`${inputCls} bg-white`}>
                <option value="">— None —</option>
                {sessionSupplierId && sessionSupplierName && !suppliers.some(s => s.id === sessionSupplierId) && (
                  <option value={sessionSupplierId}>{sessionSupplierName}</option>
                )}
                {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>

            {/* Location — a storage area already established in the app */}
            <div>
              <label className={labelCls}>Location</label>
              <select value={storageAreaId} onChange={e => setStorageAreaId(e.target.value)} className={`${inputCls} bg-white`}>
                <option value="">— None —</option>
                {storageAreas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>

            {/* Pricing mode first — the top-level structural choice — then how the
                item is measured, then its pack chain. */}
            <PricingEditor dimension={dimension} pricing={pricing} onChange={setPricing} />

            <DimensionToggle
              dimension={dimension}
              onChange={d => {
                setDimension(d)
                setPricing(p => p.mode === 'RATE' ? { mode: 'RATE', rate: p.rate, rateUnit: DIM_UNITS[d][0] } : p)
                const opts = countUnitOptions(d, chain)
                setCountUnit(cu => opts.includes(cu) ? cu : opts[0])
              }}
            />

            <PackChainEditor
              chain={chain}
              baseUnit={baseUnit}
              dimension={dimension}
              onChange={c => {
                setChain(c)
                const opts = countUnitOptions(dimension, c)
                setCountUnit(cu => opts.includes(cu) ? cu : opts[0])
              }}
            />

            {/* Count unit */}
            <div>
              <label className={labelCls}>Count unit</label>
              <select value={countUnit} onChange={e => setCountUnit(e.target.value)} className={`${inputCls} bg-white`}>
                {countUnitOptions(dimension, chain).map(u => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>

            {/* Live preview */}
            <div className="bg-gold-soft rounded-lg p-3 space-y-1.5">
              <div className="text-xs font-semibold uppercase tracking-wide text-gold-2">Live preview</div>
              <div className="flex items-baseline gap-1.5">
                <span className="text-xs text-gold-2">Price:</span>
                <span className="text-lg font-bold text-gold-2">{formatPricePerBase(ppb, baseUnit)}</span>
              </div>
              <div className="text-xs text-gold-2">
                1 {countUnit} = {perCount.toLocaleString()} {baseUnit}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="flex justify-end gap-2 px-6 py-4 border-t border-bg-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-[13px] text-ink-3 border border-line rounded-lg hover:bg-bg transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 text-[13px] font-medium bg-ink text-paper rounded-lg hover:bg-ink-2 disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving…' : 'Save & flag for approval'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

// ─── SupplierLinkCard ────────────────────────────────────────────────────────
// Invoice-wide attention card (mock §2): the supplier isn't in the directory.
// Three explicit decisions — link to existing, create new, or skip.

function SupplierLinkCard({
  supplierName,
  comboOpen,
  suppliers,
  search,
  onSearch,
  onOpenCombo,
  onPick,
  onCreate,
  onSkip,
}: {
  supplierName: string | null
  comboOpen: boolean
  suppliers: Array<{ id: string; name: string }>
  search: string
  onSearch: (v: string) => void
  onOpenCombo: () => void
  onPick: (id: string) => void
  onCreate: (fields: { name: string; contactName?: string; phone?: string; email?: string; orderPlatform?: string }) => Promise<void>
  onSkip: () => void
}) {
  const filtered = suppliers.filter(s => s.name.toLowerCase().includes(search.toLowerCase()))

  // Inline "create new" form state — local to the card.
  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState({ name: '', contactName: '', phone: '', email: '', orderPlatform: '' })
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const openCreate = () => {
    setForm({ name: supplierName ?? '', contactName: '', phone: '', email: '', orderPlatform: '' })
    setCreateError(null)
    setCreateOpen(true)
  }

  const submitCreate = async () => {
    const name = form.name.trim()
    if (!name) { setCreateError('Name is required'); return }
    setCreating(true)
    setCreateError(null)
    try {
      await onCreate({
        name,
        contactName: form.contactName.trim() || undefined,
        phone: form.phone.trim() || undefined,
        email: form.email.trim() || undefined,
        orderPlatform: form.orderPlatform.trim() || undefined,
      })
      // Success unmounts this card (supplier becomes linked) — no reset needed.
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : 'Could not create supplier')
      setCreating(false)
    }
  }

  return (
    <article className="bg-gold-soft/40 border border-[#fcd34d] rounded-lg overflow-hidden">
      <div className="px-4 py-3 flex flex-col gap-2.5">
        <div className="flex items-start gap-2.5">
          <IssueBadge kind="supplier">Supplier</IssueBadge>
          <div className="text-[12.5px] text-ink-2 leading-[1.45] min-w-0">
            {supplierName
              ? <><b className="font-semibold text-ink">&ldquo;{supplierName}&rdquo;</b> isn&rsquo;t linked to a supplier in your directory.</>
              : 'No supplier was detected on this invoice.'}
          </div>
        </div>
        <div className="flex gap-1.5 flex-wrap">
          <ActButton variant="primary" onClick={onOpenCombo}>
            <Search size={12} /> Link to existing
          </ActButton>
          <ActButton variant="default" onClick={createOpen ? () => setCreateOpen(false) : openCreate}>
            <Plus size={12} /> Create new
          </ActButton>
          <ActButton variant="danger" onClick={onSkip}>Skip for this invoice</ActButton>
        </div>

        {comboOpen && (
          <div className="bg-paper border border-line rounded-lg overflow-hidden">
            <input
              autoFocus
              value={search}
              onChange={e => onSearch(e.target.value)}
              placeholder="Search suppliers…"
              className="w-full px-3 py-2 text-[13px] border-b border-bg-2 focus:outline-none"
            />
            <div className="max-h-44 overflow-y-auto">
              {filtered.map(s => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onPick(s.id)}
                  className="w-full text-left px-3 py-2 text-[13px] hover:bg-gold-soft transition-colors font-medium text-ink"
                >
                  {s.name}
                </button>
              ))}
              {filtered.length === 0 && <p className="px-3 py-3 text-[12px] text-ink-4">No suppliers found</p>}
            </div>
          </div>
        )}

        {createOpen && (
          <div className="bg-paper border border-line rounded-lg p-3 flex flex-col gap-2">
            <SupplierField label="Name" value={form.name} autoFocus
              onChange={v => setForm(f => ({ ...f, name: v }))} placeholder="Supplier name" />
            <div className="grid grid-cols-2 gap-2">
              <SupplierField label="Contact" value={form.contactName}
                onChange={v => setForm(f => ({ ...f, contactName: v }))} placeholder="Contact name" />
              <SupplierField label="Phone" value={form.phone}
                onChange={v => setForm(f => ({ ...f, phone: v }))} placeholder="Phone" />
              <SupplierField label="Email" value={form.email}
                onChange={v => setForm(f => ({ ...f, email: v }))} placeholder="Email" />
              <SupplierField label="Order platform" value={form.orderPlatform}
                onChange={v => setForm(f => ({ ...f, orderPlatform: v }))} placeholder="e.g. phone, portal" />
            </div>
            {createError && <p className="text-[11.5px] text-red-text">{createError}</p>}
            <div className="flex gap-1.5 pt-0.5">
              <ActButton variant="primary" onClick={submitCreate} disabled={creating}>
                {creating ? 'Creating…' : 'Create & link'}
              </ActButton>
              <ActButton variant="default" onClick={() => setCreateOpen(false)} disabled={creating}>Cancel</ActButton>
            </div>
          </div>
        )}
      </div>
    </article>
  )
}

// Compact labelled text input for the inline create-supplier form.
function SupplierField({
  label, value, onChange, placeholder, autoFocus,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoFocus?: boolean
}) {
  return (
    <label className="flex flex-col gap-1 min-w-0">
      <span className="text-[10.5px] font-medium uppercase tracking-wide text-ink-4">{label}</span>
      <input
        autoFocus={autoFocus}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-2.5 py-1.5 text-[13px] border border-line rounded-md focus:outline-none focus:border-ink-4"
      />
    </label>
  )
}
