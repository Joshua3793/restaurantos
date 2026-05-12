'use client'
// Phase 5 — InvoiceReviewDrawer: the top-level container.
// Owns all shared state, provides DrawerContext, and renders the drawer panel.

import {
  useState, useEffect, useCallback, useMemo, useRef,
} from 'react'
import { X, Check, Loader2, AlertTriangle } from 'lucide-react'
import { DrawerContext, type DrawerContextValue } from './context'
import { LineItemCard } from './card'
import { ChipRow, ReconcileBanner, type ReconcileResult } from './composites'
import { ImageViewerV2, type BBox } from './ImageViewer'
import { useRc } from '@/contexts/RevenueCenterContext'
import { InventoryItemDrawer } from '@/components/inventory/InventoryItemDrawer'
import type { Session, ScanItem } from '@/components/invoices/types'
import type { RevenueCenter } from '@/contexts/RevenueCenterContext'
import { reconcileInvoiceTotals } from '@/lib/invoice/calculations'
import {
  getFilterCounts, matchesFilter, sortComparator,
  type FilterKey, type SortMode,
} from '@/lib/invoice/filters'
import {
  isUnlinked, hasMathCheck, hasModeMismatch, hasFormatMismatch,
} from '@/lib/invoice/predicates'
import { formatCurrency } from '@/lib/invoice/formatters'
import { PACK_UOMS, PURCHASE_UNITS, calcPricePerBaseUnit } from '@/lib/utils'

// ─── InvoiceHeader ─────────────────────────────────────────────────────────────

function InvoiceHeader({
  session,
  reconciliation,
  onClose,
}: {
  session: Session
  reconciliation: ReconcileResult | null
  onClose: () => void
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
    <div className="px-[22px] pt-[18px] pb-[14px] border-b border-stone-200">
      <div className="flex items-start justify-between gap-4">
        {/* Left: supplier + meta */}
        <div className="min-w-0">
          <h2 className="text-[19px] font-semibold text-stone-900 leading-[1.2] truncate">
            {session.supplierName ?? 'Unknown supplier'}
          </h2>
          <p className="text-[12.5px] text-stone-400 mt-[3px]">
            {metaParts.join(' · ')}
          </p>
        </div>

        {/* Right: total */}
        <div className="text-right shrink-0">
          <div className="text-[24px] font-semibold text-stone-900 leading-none tabular-nums">
            {total !== null ? formatCurrency(total) : '—'}
          </div>
          {(subtotal !== null || tax !== null) && (
            <div className="text-[11.5px] text-stone-400 mt-[4px] tabular-nums">
              {subtotal !== null && `sub ${formatCurrency(subtotal)}`}
              {subtotal !== null && tax !== null && ' · '}
              {tax !== null && `tax ${formatCurrency(tax)}`}
            </div>
          )}
        </div>

        {/* Close button */}
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 p-1.5 rounded-lg text-stone-400 hover:text-stone-700 hover:bg-stone-100 transition-colors"
          aria-label="Close drawer"
        >
          <X size={18} />
        </button>
      </div>

      {/* Reconcile banner */}
      {reconciliation && <ReconcileBanner reconciliation={reconciliation} />}
    </div>
  )
}

// ─── DrawerFooter ──────────────────────────────────────────────────────────────

function DrawerFooter({
  session,
  items,
  modeWritebackItems,
  onApprove,
  onReject,
  saveStatus,
  goToTask,
}: {
  session: Session
  items: ScanItem[]
  modeWritebackItems: Set<string>
  onApprove: () => void
  onReject: () => void
  saveStatus: 'idle' | 'saving' | 'error'
  goToTask: (key: 'link' | 'math' | 'mismatch') => void
}) {
  const unlinkedCount  = items.filter(i => isUnlinked(i)).length
  const mathCount      = items.filter(i => hasMathCheck(i)).length
  // Mode mismatches acknowledged by the writeback checkbox don't need manual resolution
  const mismatchCount  = items.filter(i =>
    (hasModeMismatch(i) && !modeWritebackItems.has(i.id)) || hasFormatMismatch(i)
  ).length

  const canApprove = unlinkedCount === 0 && mathCount === 0
  const disabledReason = !canApprove
    ? [
        unlinkedCount > 0 && `${unlinkedCount} unlinked item${unlinkedCount > 1 ? 's' : ''}`,
        mathCount > 0     && `${mathCount} math check${mathCount > 1 ? 's' : ''}`,
      ].filter(Boolean).join(', ')
    : ''

  return (
    <div className="border-t border-stone-200 px-[18px] py-[13px] flex items-center gap-3 bg-white">
      {/* Left: outstanding task count + tappable links */}
      <div className="flex-1 min-w-0">
        <div className="text-[12px] text-stone-500 truncate">
          {unlinkedCount + mathCount + mismatchCount === 0 ? (
            <span className="flex items-center gap-1.5 text-green-700">
              <Check size={13} /> All items reviewed
            </span>
          ) : (
            <span className="flex flex-wrap items-center gap-x-[10px] gap-y-1">
              {unlinkedCount > 0 && (
                <button
                  type="button"
                  onClick={() => goToTask('link')}
                  className="underline underline-offset-2 decoration-stone-300 hover:text-stone-800 transition-colors"
                >
                  Link {unlinkedCount} product{unlinkedCount > 1 ? 's' : ''}
                </button>
              )}
              {mathCount > 0 && (
                <button
                  type="button"
                  onClick={() => goToTask('math')}
                  className="underline underline-offset-2 decoration-stone-300 hover:text-stone-800 transition-colors"
                >
                  Fix {mathCount} math check{mathCount > 1 ? 's' : ''}
                </button>
              )}
              {mismatchCount > 0 && (
                <button
                  type="button"
                  onClick={() => goToTask('mismatch')}
                  className="underline underline-offset-2 decoration-stone-300 hover:text-stone-800 transition-colors"
                >
                  Resolve {mismatchCount} mismatch{mismatchCount > 1 ? 'es' : ''}
                </button>
              )}
            </span>
          )}
        </div>
      </div>

      {/* Save status */}
      {saveStatus === 'saving' && (
        <Loader2 size={14} className="text-stone-400 animate-spin shrink-0" />
      )}
      {saveStatus === 'error' && (
        <AlertTriangle size={14} className="text-red-400 shrink-0" />
      )}

      {/* Reject */}
      <button
        type="button"
        onClick={onReject}
        className="px-[13px] py-[7px] text-[13px] text-red-500 hover:text-red-700 transition-colors rounded-lg hover:bg-red-50"
      >
        Reject
      </button>

      {/* Approve */}
      <button
        type="button"
        onClick={onApprove}
        disabled={!canApprove}
        title={disabledReason}
        className={`inline-flex items-center gap-1.5 px-[16px] py-[7px] text-[13px] font-medium rounded-lg transition-colors ${
          canApprove
            ? 'bg-stone-900 text-white hover:bg-stone-700'
            : 'bg-stone-200 text-stone-400 cursor-not-allowed'
        }`}
      >
        <Check size={14} />
        Approve
      </button>
    </div>
  )
}

// ─── InvoiceReviewDrawer ───────────────────────────────────────────────────────

export function InvoiceReviewDrawer({
  sessionId,
  onClose,
  onApproveOrReject,
}: {
  sessionId: string | null
  onClose: () => void
  onApproveOrReject: () => void
}) {
  const { revenueCenters } = useRc()

  // ── Session data ────────────────────────────────────────────────────────────
  const [session,     setSession]     = useState<Session | null>(null)
  const [loading,     setLoading]     = useState(false)
  const [saveStatus,  setSaveStatus]  = useState<'idle' | 'saving' | 'error'>('idle')
  const [approving,   setApproving]   = useState(false)
  const [approved,    setApproved]    = useState(false)

  const fetchSession = useCallback(async (id: string) => {
    setLoading(true)
    try {
      const res  = await fetch(`/api/invoices/sessions/${id}`)
      const data = await res.json()
      setSession(data)
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
  const [modeWritebackItems, setModeWritebackItems] = useState<Set<string>>(new Set())
  const [creatingNewForItem,      setCreatingNewForItem]      = useState<ScanItem | null>(null)
  const [editingInventoryItemId,  setEditingInventoryItemId]  = useState<string | null>(null)
  const [activeBboxItemId,   setActiveBboxItemId]    = useState<string | null>(null)

  // Ref for the scrollable list container
  const listRef = useRef<HTMLDivElement>(null)

  // ── Auto-expand attention items when session first loads ────────────────────
  useEffect(() => {
    if (!session) return
    const toExpand = new Set(
      session.scanItems
        .filter(i => isUnlinked(i) || hasMathCheck(i) || hasModeMismatch(i))
        .map(i => i.id),
    )
    setExpandedLineIds(toExpand)
    setEditedLines(new Map())
    setActiveFilters(new Set())
    setSortMode('invoice')
    setPickingLinkForId(null)
    setModeWritebackItems(new Set())
    setActiveBboxItemId(null)
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

  const filteredSortedIds = useMemo(() => {
    let items = effectiveLines
    if (activeFilters.size > 0) {
      items = items.filter(item =>
        Array.from(activeFilters).some(f => matchesFilter(item, f)),
      )
    }
    return [...items].sort(sortComparator(sortMode)).map(i => i.id)
  }, [effectiveLines, activeFilters, sortMode])

  const filterCounts = useMemo(() => getFilterCounts(effectiveLines), [effectiveLines])

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

  const updateLine = useCallback((id: string, patch: Partial<ScanItem>) => {
    setEditedLines(prev => {
      const next = new Map(prev)
      next.set(id, { ...prev.get(id), ...patch })
      return next
    })
    // Debounce the server save by 600ms to batch rapid field edits
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => persistEdit(id, patch), 600)
  }, [persistEdit])

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
      if (willOpen) next.add(id)
      else next.delete(id)
      // Track which item to highlight in the image viewer
      setActiveBboxItemId(willOpen ? id : null)
      return next
    })
  }, [])

  // ── goToTask — scroll + expand + flash ─────────────────────────────────────
  const scrollPendingRef = useRef<string | null>(null)

  const goToTask = useCallback((taskKey: 'link' | 'math' | 'mismatch') => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-task="${taskKey}"]`)
    if (!el) return
    const lineId = el.getAttribute('data-line-id')
    if (!lineId) return
    scrollPendingRef.current = lineId
    toggleExpand(lineId, true)
  }, [toggleExpand])

  // After expandedLineIds updates, handle pending scroll + flash
  useEffect(() => {
    const lineId = scrollPendingRef.current
    if (!lineId) return
    scrollPendingRef.current = null
    const el = listRef.current?.querySelector(`[data-line-id="${lineId}"]`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setFlashingLineIds(prev => new Set(prev).add(lineId))
    setTimeout(() => {
      setFlashingLineIds(prev => {
        const next = new Set(prev)
        next.delete(lineId)
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

  // ── Mode writeback ──────────────────────────────────────────────────────────
  const toggleModeWriteback = useCallback((id: string) => {
    setModeWritebackItems(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // ── Approve ─────────────────────────────────────────────────────────────────
  const handleApprove = async () => {
    if (!session) return
    setApproving(true)
    try {
      const res    = await fetch(`/api/invoices/sessions/${session.id}/approve`, { method: 'POST' })
      const result = await res.json()
      if (!res.ok) {
        alert(`Approval failed: ${result.error ?? res.statusText}`)
        return
      }
      setApproved(true)
      onApproveOrReject()
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

  // ── Context value ────────────────────────────────────────────────────────────
  const ctxValue = useMemo<DrawerContextValue>(() => ({
    lines: session?.scanItems ?? [],
    revenueCenters,
    editedLines,
    expandedLineIds,
    flashingLineIds,
    activeFilters,
    sortMode,
    pickingLinkForId,
    modeWritebackItems,
    reconciliation,
    getEffectiveLine,
    getItemRc,
    updateLine,
    clearLineEdits,
    toggleExpand,
    setLineRc,
    startLinkPicker: (id) => setPickingLinkForId(id),
    closeLinkPicker: ()   => setPickingLinkForId(null),
    openCreateNew:        (item) => setCreatingNewForItem(item),
    openInventoryEdit:    (id)   => setEditingInventoryItemId(id),
    toggleModeWriteback,
    activeBboxItemId,
    toggleFilter,
    setSortMode,
  }), [
    session, revenueCenters, editedLines, expandedLineIds, flashingLineIds,
    activeFilters, sortMode, pickingLinkForId, modeWritebackItems, reconciliation,
    getEffectiveLine, getItemRc, updateLine, clearLineEdits, toggleExpand,
    setLineRc, toggleModeWriteback, activeBboxItemId, toggleFilter,
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
        className={`fixed inset-y-0 right-0 z-50 bg-white shadow-2xl flex flex-col transition-transform duration-300 ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
        style={{ width: session?.files?.length ? '1020px' : '600px', maxWidth: '100vw' }}
      >
        {loading || !session ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 size={28} className="text-stone-300 animate-spin" />
          </div>
        ) : approved || session.status === 'APPROVED' || session.status === 'REJECTED' ? (
          <ApprovedSplash onClose={onClose} session={session} />
        ) : (
          <DrawerContext.Provider value={ctxValue}>
            {/* Full-width header */}
            <InvoiceHeader
              session={session}
              reconciliation={reconciliation}
              onClose={onClose}
            />

            {/* Body: image viewer (left) + review panel (right) */}
            <div className="flex flex-1 min-h-0 overflow-hidden">

              {/* ── Image viewer ───────────────────────────────────────────── */}
              {session.files.length > 0 && (
                <>
                  <ImageViewerV2
                    files={session.files}
                    activeBbox={activeBbox}
                  />
                  <div className="w-px bg-stone-200 shrink-0" />
                </>
              )}

              {/* ── Review panel ───────────────────────────────────────────── */}
              <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
                {/* Filter chip row */}
                <ChipRow
                  totalCount={effectiveLines.filter(i => i.action !== 'SKIP').length}
                  counts={filterCounts}
                  activeFilters={activeFilters}
                  onToggle={toggleFilter}
                  sortMode={sortMode}
                  onSort={setSortMode}
                />

                {/* Line item list */}
                <div ref={listRef} className="flex-1 overflow-y-auto px-[14px] py-[10px]">
                  {filteredSortedIds.length === 0 ? (
                    <div className="flex items-center justify-center h-32 text-[13px] text-stone-400">
                      No items match the active filter.
                    </div>
                  ) : (
                    filteredSortedIds.map(id => (
                      <LineItemCard key={id} lineId={id} />
                    ))
                  )}
                </div>

                {/* Footer */}
                {!approving ? (
                  <DrawerFooter
                    session={session}
                    items={effectiveLines}
                    modeWritebackItems={modeWritebackItems}
                    onApprove={handleApprove}
                    onReject={handleReject}
                    saveStatus={saveStatus}
                    goToTask={goToTask}
                  />
                ) : (
                  <div className="border-t border-stone-200 px-[18px] py-[13px] flex items-center justify-center gap-3">
                    <Loader2 size={16} className="animate-spin text-stone-500" />
                    <span className="text-[13px] text-stone-500">Approving…</span>
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

      {/* Create new item mini-modal */}
      {creatingNewForItem && (
        <AddNewItemModal
          item={creatingNewForItem}
          sessionId={session?.id ?? ''}
          onSaved={() => {
            if (creatingNewForItem) {
              updateLine(creatingNewForItem.id, {
                action: 'CREATE_NEW',
                isNewItem: true,
                matchedItemId: null,
                matchedItem: null,
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

// ─── ApprovedSplash ────────────────────────────────────────────────────────────

function ApprovedSplash({ onClose, session }: { onClose: () => void; session?: Session | null }) {
  const rejected = session?.status === 'REJECTED'
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center p-8">
      <div className={`w-14 h-14 rounded-full flex items-center justify-center ${rejected ? 'bg-red-100' : 'bg-green-100'}`}>
        {rejected
          ? <X size={28} className="text-red-600" />
          : <Check size={28} className="text-green-600" />}
      </div>
      <div>
        <h3 className="text-[18px] font-semibold text-stone-900 mb-1">
          {rejected ? 'Invoice rejected' : 'Invoice applied'}
        </h3>
        <p className="text-[13px] text-stone-400">
          {rejected
            ? 'This invoice was rejected and no changes were applied.'
            : 'Inventory prices have been updated and price alerts generated.'}
        </p>
      </div>
      <button
        type="button"
        onClick={onClose}
        className="mt-2 px-5 py-2 text-[13px] bg-stone-900 text-white rounded-lg hover:bg-stone-700 transition-colors"
      >
        Close
      </button>
    </div>
  )
}

// ─── AddNewItemModal ───────────────────────────────────────────────────────────
// Full form to configure a new inventory item before approve creates it.

function AddNewItemModal({
  item,
  sessionId,
  onSaved,
  onClose,
}: {
  item: ScanItem
  sessionId: string
  onSaved: () => void
  onClose: () => void
}) {
  const [saving,          setSaving]          = useState(false)
  const [categories,      setCategories]      = useState<string[]>([])
  const [itemName,        setItemName]        = useState(item.rawDescription ?? '')
  const [category,        setCategory]        = useState('DRY')
  const [purchaseUnit,    setPurchaseUnit]    = useState(item.rawUnit ?? 'case')
  const [qtyPerPurchase,  setQtyPerPurchase]  = useState(item.invoicePackQty ?? '1')
  const [packSize,        setPackSize]        = useState(item.invoicePackSize ?? '1')
  const [packUOM,         setPackUOM]         = useState(item.invoicePackUOM ?? 'each')
  const [priceType,       setPriceType]       = useState<'CASE' | 'UOM'>('CASE')
  const [purchasePrice,   setPurchasePrice]   = useState(item.rawUnitPrice ?? item.newPrice ?? '')

  useEffect(() => {
    fetch('/api/categories').then(r => r.json()).then((data: { name: string }[]) => {
      setCategories(data.map(c => c.name))
    }).catch(() => {})
  }, [])

  const ppb = (() => {
    const price = Number(purchasePrice)
    const qty   = Number(qtyPerPurchase) || 1
    const ps    = Number(packSize) || 1
    if (!price) return null
    return calcPricePerBaseUnit(price, qty, 'each', null, ps, packUOM, priceType)
  })()

  const handleSave = async () => {
    setSaving(true)
    const newItemData = JSON.stringify({
      itemName:           itemName.trim() || item.rawDescription,
      category,
      purchaseUnit,
      qtyPerPurchaseUnit: Number(qtyPerPurchase) || 1,
      packSize:           Number(packSize) || 1,
      packUOM,
      priceType,
      purchasePrice:      Number(purchasePrice) || 0,
      pricePerBaseUnit:   ppb ?? 0,
      baseUnit:           packUOM,
    })
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
    onSaved()
  }

  const inputCls = 'w-full border border-stone-200 rounded-lg px-3 py-[7px] text-[13px] focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 transition-colors'
  const labelCls = 'block text-[11px] font-medium text-stone-500 mb-[5px] uppercase tracking-wide'

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-[60]" onClick={onClose} />
      <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl w-full max-w-md flex flex-col max-h-[90vh]">
          {/* Header */}
          <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-stone-100">
            <div>
              <h3 className="text-[16px] font-semibold text-stone-900">Create new product</h3>
              <p className="text-[12px] text-stone-400 mt-0.5">These fields will be set when the invoice is approved.</p>
            </div>
            <button type="button" onClick={onClose} className="text-stone-400 hover:text-stone-600 transition-colors">
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
              <select value={category} onChange={e => setCategory(e.target.value)} className={inputCls}>
                {(categories.length ? categories : ['DRY', 'DAIRY', 'MEAT', 'PRODUCE', 'FROZEN', 'BEVERAGE', 'OTHER']).map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>

            {/* Purchase unit */}
            <div>
              <label className={labelCls}>Purchase unit</label>
              <select value={purchaseUnit} onChange={e => setPurchaseUnit(e.target.value)} className={inputCls}>
                {(PURCHASE_UNITS as readonly string[]).map(u => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>

            {/* Pack structure */}
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className={labelCls}>Pack qty</label>
                <input type="number" min="1" step="1" value={qtyPerPurchase} onChange={e => setQtyPerPurchase(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Pack size</label>
                <input type="number" min="0" step="any" value={packSize} onChange={e => setPackSize(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Pack UOM</label>
                <select value={packUOM} onChange={e => setPackUOM(e.target.value)} className={inputCls}>
                  {(PACK_UOMS as readonly string[]).map(u => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>
            </div>

            {/* Price type */}
            <div>
              <label className={labelCls}>Pricing mode</label>
              <div className="flex rounded-lg border border-stone-200 overflow-hidden text-[12px]">
                {(['CASE', 'UOM'] as const).map(pt => (
                  <button
                    key={pt}
                    type="button"
                    onClick={() => setPriceType(pt)}
                    className={`flex-1 py-[7px] font-medium transition-colors ${
                      priceType === pt ? 'bg-stone-900 text-white' : 'bg-white text-stone-500 hover:bg-stone-50'
                    }`}
                  >
                    {pt === 'CASE' ? 'Per case' : 'Per weight / UOM'}
                  </button>
                ))}
              </div>
            </div>

            {/* Purchase price */}
            <div>
              <label className={labelCls}>Purchase price</label>
              <div className="flex items-center border border-stone-200 rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:border-blue-400 transition-colors">
                <span className="px-3 text-stone-400 text-[13px]">$</span>
                <input
                  type="number" min="0" step="any"
                  value={purchasePrice}
                  onChange={e => setPurchasePrice(e.target.value)}
                  className="flex-1 py-[7px] pr-3 text-[13px] bg-transparent border-none outline-none"
                />
              </div>
              {ppb !== null && (
                <p className="text-[11px] text-stone-400 mt-1">
                  = {formatCurrency(ppb)}/{packUOM} per base unit
                </p>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="flex justify-end gap-2 px-6 py-4 border-t border-stone-100">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-[13px] text-stone-600 border border-stone-200 rounded-lg hover:bg-stone-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 text-[13px] font-medium bg-stone-900 text-white rounded-lg hover:bg-stone-700 disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving…' : 'Save & flag for approval'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
