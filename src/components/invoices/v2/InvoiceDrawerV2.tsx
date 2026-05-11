'use client'
// V2 invoice review drawer — mode-aware UI for the redesigned OCR pipeline.
// Mounted alongside v1; users toggle via the `?v=2` URL flag on /invoices.
// When ready we swap the dynamic import in page.tsx and delete v1.
//
// What's different vs v1:
//   - Per-line "math expression" card adapts to per_case vs per_weight
//   - Catchweight shown inline ("3.20 lb (ord 3.00) × $19.89/lb = $63.65")
//   - Filter chips driven by mode-aware predicates (mismatch, catchweight, unknown mode)
//   - Header breakdown: sub · fuel · tax with reconcile indicator
//   - Variance pill computed in the linked product's baseUnit, not packUOM

import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import {
  X, ScanLine, CheckCircle2, AlertTriangle, Loader2,
  Package, Scale, Link2, Unlink, TrendingUp, TrendingDown,
  ChevronDown, ChevronUp, Hash, CalendarDays, AlertCircle, Plus,
} from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import { InvoiceImageViewer } from '../InvoiceDrawer'
import { useRc } from '@/contexts/RevenueCenterContext'
import { rcHex } from '@/lib/rc-colors'
import type { Session, ScanItem, ApproveResult, SessionSummary, PricingMode } from '../types'
import {
  TONE, effectiveMode, productDefaultMode, varianceOf,
  mathTokens, packDescription, headerReconciliation, taxAggregate, feesAggregate,
  isPriceDelta, isCatchweight as isCw, isNeedsLink, isModeMismatch,
  isLowConfidence, isUnknownMode, isCrossCheckFail,
  applyFilter, sortByExceptionsFirst,
  type V2Filter,
} from './selectors'

interface Props {
  sessionId: string | null
  onClose: () => void
  onApproveOrReject: () => void
  allSessions?: SessionSummary[]
}

// ── Root drawer ───────────────────────────────────────────────────────────────
export function InvoiceDrawerV2({ sessionId, onClose, onApproveOrReject, allSessions = [] }: Props) {
  const [session, setSession] = useState<Session | null>(null)
  const [approveResult, setApproveResult] = useState<ApproveResult | null>(null)
  const [isApproving, setIsApproving] = useState(false)
  const [open, setOpen] = useState(false)
  const [mobileTab, setMobileTab] = useState<'review' | 'image'>('review')
  const [approvedBy, setApprovedBy] = useState(() =>
    typeof window !== 'undefined' ? localStorage.getItem('approvedBy') ?? '' : ''
  )
  const [filter, setFilter] = useState<V2Filter>('all')
  const [sortMode, setSortMode] = useState<'invoice' | 'exceptions'>('invoice')
  const [expandedIds, setExpandedIds] = useState<Record<string, true>>({})
  const { revenueCenters } = useRc()
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchSession = useCallback(async (id: string) => {
    const res = await fetch(`/api/invoices/sessions/${id}`)
    if (!res.ok) return null
    const data: Session = await res.json()
    setSession(data)
    return data
  }, [])

  useEffect(() => {
    if (sessionId) {
      setOpen(true)
      setApproveResult(null)
      fetchSession(sessionId)
    } else {
      setOpen(false)
      const t = setTimeout(() => setSession(null), 200)
      return () => clearTimeout(t)
    }
  }, [sessionId, fetchSession])

  // Poll while processing/approving
  useEffect(() => {
    const should = session?.status === 'PROCESSING' || session?.status === 'UPLOADING' || session?.status === 'APPROVING'
    if (should) {
      pollRef.current = setInterval(async () => {
        const s = await fetchSession(session!.id)
        if (!s || (s.status !== 'PROCESSING' && s.status !== 'UPLOADING' && s.status !== 'APPROVING')) {
          if (pollRef.current) clearInterval(pollRef.current)
        }
      }, 2000)
    } else if (pollRef.current) {
      clearInterval(pollRef.current)
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [session?.status, session?.id, fetchSession])

  // Esc closes drawer. No unsaved-edits prompt yet — all edits PATCH on blur,
  // so by the time the user hits Esc the server state is already in sync.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const patchItem = useCallback(async (itemId: string, updates: Partial<ScanItem>) => {
    if (!session) return
    await fetch(`/api/invoices/sessions/${session.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scanItemId: itemId, ...updates }),
    })
    await fetchSession(session.id)
  }, [session, fetchSession])

  const handleApprove = async () => {
    if (!session) return
    setIsApproving(true)
    try {
      const res = await fetch(`/api/invoices/sessions/${session.id}/approve`, { method: 'POST' })
      const result = await res.json()
      if (!res.ok) { alert(`Approval failed: ${result.error ?? res.statusText}`); return }
      if (result.queued) { onApproveOrReject(); onClose() }
      else { setApproveResult(result); onApproveOrReject() }
    } finally { setIsApproving(false) }
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

  const isReview = session?.status === 'REVIEW'

  if (!sessionId && !open && !session) return null

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/40"
        onClick={onClose}
        style={{ opacity: open ? 1 : 0, transition: 'opacity 150ms ease-out' }}
      />

      {/* Desktop drawer */}
      <div
        className={`hidden sm:flex fixed top-0 right-0 h-full z-50 bg-white shadow-2xl flex-col transition-all duration-150 ease-out ${isReview ? 'w-[960px]' : 'w-[560px]'}`}
        style={{ transform: open ? 'translateX(0)' : 'translateX(100%)' }}
      >
        <DrawerChrome onClose={onClose} title={session ? labelFor(session.status) : 'Loading…'} />
        <div className="flex-1 overflow-hidden flex min-h-0">
          {isReview && session?.files && session.files.length > 0 && (
            <InvoiceImageViewer files={session.files} />
          )}
          <div className={`flex-1 overflow-y-auto flex flex-col ${isReview ? 'border-l border-gray-100' : ''}`}>
            <DrawerBody
              session={session}
              approveResult={approveResult}
              allSessions={allSessions}
              filter={filter} onFilter={setFilter}
              sortMode={sortMode} onSortMode={setSortMode}
              expandedIds={expandedIds} onToggle={(id) => setExpandedIds(p => ({ ...p, [id]: !p[id] ? true : undefined! }))}
              patchItem={patchItem}
              revenueCenters={revenueCenters}
            />
            {isReview && session && (
              <DrawerFooter
                session={session}
                approvedBy={approvedBy}
                onApprovedByChange={(v) => { setApprovedBy(v); localStorage.setItem('approvedBy', v) }}
                onApprove={handleApprove}
                onReject={handleReject}
                isApproving={isApproving}
              />
            )}
          </div>
        </div>
      </div>

      {/* Mobile bottom sheet — follows the dual-renderer pattern from CLAUDE.md */}
      <div className="sm:hidden fixed inset-0 z-50 flex items-end" style={{ pointerEvents: open ? 'auto' : 'none' }}>
        <div
          className="relative bg-white w-full rounded-t-2xl shadow-2xl flex flex-col"
          style={{ maxHeight: '92vh', transform: open ? 'translateY(0)' : 'translateY(100%)', transition: 'transform 150ms ease-out' }}
        >
          <div className="flex justify-center pt-3 pb-1 shrink-0"><div className="w-10 h-1 rounded-full bg-gray-200" /></div>
          <DrawerChrome onClose={onClose} title={session ? labelFor(session.status) : 'Loading…'} size="sm" />
          {isReview && session?.files && session.files.length > 0 && (
            <div className="flex border-b border-gray-100 shrink-0">
              <button onClick={() => setMobileTab('review')} className={`flex-1 py-2 text-xs font-medium ${mobileTab === 'review' ? 'text-gold border-b-2 border-gold' : 'text-gray-500'}`}>Review</button>
              <button onClick={() => setMobileTab('image')}  className={`flex-1 py-2 text-xs font-medium ${mobileTab === 'image'  ? 'text-gold border-b-2 border-gold' : 'text-gray-500'}`}>Invoice Image</button>
            </div>
          )}
          <div className="flex-1 overflow-y-auto">
            {isReview && mobileTab === 'image' && session?.files?.length
              ? <InvoiceImageViewer files={session.files} />
              : <DrawerBody
                  session={session}
                  approveResult={approveResult}
                  allSessions={allSessions}
                  filter={filter} onFilter={setFilter}
                  sortMode={sortMode} onSortMode={setSortMode}
                  expandedIds={expandedIds} onToggle={(id) => setExpandedIds(p => ({ ...p, [id]: !p[id] ? true : undefined! }))}
                  patchItem={patchItem}
                  revenueCenters={revenueCenters}
                />}
          </div>
          {isReview && session && (
            <DrawerFooter
              session={session}
              approvedBy={approvedBy}
              onApprovedByChange={(v) => { setApprovedBy(v); localStorage.setItem('approvedBy', v) }}
              onApprove={handleApprove}
              onReject={handleReject}
              isApproving={isApproving}
            />
          )}
        </div>
      </div>
    </>
  )
}

function labelFor(status: string): string {
  if (status === 'PROCESSING' || status === 'UPLOADING') return 'Scanning…'
  if (status === 'APPROVING') return 'Applying invoice…'
  if (status === 'ERROR')     return 'Scan failed'
  if (status === 'REVIEW')    return 'Review invoice'
  return 'Invoice'
}

// ── Drawer chrome ─────────────────────────────────────────────────────────────
function DrawerChrome({ onClose, title, size = 'md' }: { onClose: () => void; title: string; size?: 'sm' | 'md' }) {
  return (
    <div className={`flex items-center justify-between border-b border-gray-100 shrink-0 ${size === 'sm' ? 'px-5 py-3' : 'px-5 py-4'}`}>
      <div className="flex items-center gap-2">
        <ScanLine size={size === 'sm' ? 16 : 18} className="text-gold" />
        <span className={`font-semibold text-gray-900 ${size === 'sm' ? 'text-sm' : ''}`}>{title}</span>
      </div>
      <button onClick={onClose} aria-label="Close" className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg">
        <X size={size === 'sm' ? 16 : 18} />
      </button>
    </div>
  )
}

// ── Drawer body — header + chips + lines, or status views ─────────────────────
function DrawerBody({
  session, approveResult, allSessions, filter, onFilter, sortMode, onSortMode,
  expandedIds, onToggle, patchItem, revenueCenters,
}: {
  session: Session | null
  approveResult: ApproveResult | null
  allSessions: SessionSummary[]
  filter: V2Filter
  onFilter: (f: V2Filter) => void
  sortMode: 'invoice' | 'exceptions'
  onSortMode: (m: 'invoice' | 'exceptions') => void
  expandedIds: Record<string, true>
  onToggle: (id: string) => void
  patchItem: (id: string, updates: Partial<ScanItem>) => Promise<void>
  revenueCenters: Array<{ id: string; name: string; color: string }>
}) {
  if (!session) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-[40vh]">
        <Loader2 size={28} className="animate-spin text-gray-300" />
      </div>
    )
  }

  if (approveResult) {
    return (
      <div className="flex-1 p-6 text-center space-y-3">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-emerald-100">
          <CheckCircle2 size={28} className="text-emerald-600" />
        </div>
        <h2 className="text-lg font-semibold text-gray-900">Invoice applied</h2>
        <p className="text-sm text-gray-500">
          {approveResult.itemsUpdated} prices updated · {approveResult.newItemsCreated} new items
        </p>
      </div>
    )
  }

  if (session.status !== 'REVIEW') {
    return (
      <div className="flex-1 p-6 text-center space-y-3">
        <Loader2 size={24} className="animate-spin text-gold mx-auto" />
        <p className="text-sm text-gray-500">{labelFor(session.status)}</p>
        {session.errorMessage && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-left">
            {session.errorMessage}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <DrawerHeader session={session} allSessions={allSessions} />
      <FilterChipsBar
        session={session}
        filter={filter}
        onFilter={onFilter}
        sortMode={sortMode}
        onSortMode={onSortMode}
      />
      <LineItemList
        session={session}
        filter={filter}
        sortMode={sortMode}
        expandedIds={expandedIds}
        onToggle={onToggle}
        patchItem={patchItem}
        revenueCenters={revenueCenters}
      />
    </div>
  )
}

// ── Drawer header ─────────────────────────────────────────────────────────────
function DrawerHeader({ session, allSessions }: { session: Session; allSessions: SessionSummary[] }) {
  const recon = headerReconciliation(session)
  const tax  = taxAggregate(session)
  const fees = feesAggregate(session)
  const sub  = session.subtotal ? Number(session.subtotal) : null
  const total = session.total ? Number(session.total) : null
  const dup = session.invoiceNumber
    ? allSessions.find(s => s.id !== session.id && s.invoiceNumber === session.invoiceNumber)
    : null

  return (
    <div className="bg-white border-b border-gray-100">
      <div className="px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-0.5">Review invoice</p>
            <h2 className="text-[17px] font-medium text-gray-900 leading-tight truncate">
              {session.supplierName || 'Unknown supplier'}
            </h2>
            <div className="flex items-center gap-2 mt-1 text-xs text-gray-500 flex-wrap">
              {session.invoiceNumber && <span className="flex items-center gap-0.5"><Hash size={10} />{session.invoiceNumber}</span>}
              {session.invoiceDate && <span className="flex items-center gap-0.5"><CalendarDays size={10} />{session.invoiceDate}</span>}
              <span>· {session.scanItems.length} line items</span>
            </div>
          </div>
          <div className="text-right shrink-0">
            {total != null && <div className="text-[22px] font-medium text-gray-900 leading-none">{formatCurrency(total)}</div>}
            <div className="flex items-center gap-2 mt-1 text-[11px] text-gray-500 justify-end flex-wrap">
              {sub != null  && <span>sub {formatCurrency(sub)}</span>}
              {fees > 0     && <span>· fuel {formatCurrency(fees)}</span>}
              {tax != null && tax > 0 && <span>· tax {formatCurrency(tax)}</span>}
            </div>
            {recon.match === true && (
              <div role="status" className="mt-1.5 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                <CheckCircle2 size={9} /> totals reconcile
              </div>
            )}
            {recon.match === false && recon.diff != null && (
              <div role="status" className="mt-1.5 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-50 text-amber-700 border border-amber-200">
                <AlertTriangle size={9} /> totals off by {formatCurrency(Math.abs(recon.diff))}
              </div>
            )}
          </div>
        </div>
      </div>

      {dup && (
        <div className="flex items-start gap-2 px-5 py-2.5 bg-amber-50 border-t border-amber-200">
          <AlertTriangle size={13} className="text-amber-500 mt-0.5 shrink-0" />
          <div className="text-xs text-amber-700">
            <span className="font-semibold">Possible duplicate.</span>{' '}
            Invoice #{session.invoiceNumber} was already scanned
            {dup.invoiceDate ? ` on ${dup.invoiceDate}` : ''}
            {' '}<span className="font-semibold">({dup.status.toLowerCase()})</span>. Review carefully before approving.
          </div>
        </div>
      )}
    </div>
  )
}

// ── Filter chips ──────────────────────────────────────────────────────────────
function FilterChipsBar({
  session, filter, onFilter, sortMode, onSortMode,
}: {
  session: Session
  filter: V2Filter
  onFilter: (f: V2Filter) => void
  sortMode: 'invoice' | 'exceptions'
  onSortMode: (m: 'invoice' | 'exceptions') => void
}) {
  const counts = useMemo(() => ({
    all:          session.scanItems.length,
    price_delta:  session.scanItems.filter(isPriceDelta).length,
    catchweight:  session.scanItems.filter(isCw).length,
    needs_link:   session.scanItems.filter(isNeedsLink).length,
    mismatch:     session.scanItems.filter(isModeMismatch).length,
    low_conf:     session.scanItems.filter(isLowConfidence).length,
    unknown_mode: session.scanItems.filter(isUnknownMode).length,
  }), [session.scanItems])

  const Chip = ({ value, label, tone }: { value: V2Filter; label: string; tone?: 'warning' | 'info' | 'danger' }) => {
    const n = counts[value]
    if (value !== 'all' && n === 0) return null
    const active = filter === value
    const dotClass = tone ? TONE[tone].dot : ''
    return (
      <button
        onClick={() => onFilter(value)}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors border ${
          active ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
        }`}
      >
        {tone && <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />}
        {label}
        <span className={active ? 'text-gray-300' : 'text-gray-400'}>{n}</span>
      </button>
    )
  }

  return (
    <div className="px-3 py-2 flex items-center gap-1.5 flex-wrap border-b border-gray-100 bg-gray-50/50">
      <Chip value="all"          label="All" />
      <Chip value="unknown_mode" label="Unknown mode" tone="danger" />
      <Chip value="needs_link"   label="Needs link"   tone="danger" />
      <Chip value="mismatch"     label="Mismatch"     tone="warning" />
      <Chip value="low_conf"     label="Low conf"     tone="warning" />
      <Chip value="price_delta"  label="Price Δ"      tone="warning" />
      <Chip value="catchweight"  label="Catchweight"  tone="info" />

      <div className="ml-auto flex items-center gap-2.5">
        <button
          onClick={() => onSortMode(sortMode === 'invoice' ? 'exceptions' : 'invoice')}
          className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-700"
        >
          {sortMode === 'invoice' ? '⇣ Invoice order' : '⚠ Exceptions first'}
        </button>
      </div>
    </div>
  )
}

// ── Line item list ────────────────────────────────────────────────────────────
function LineItemList({
  session, filter, sortMode, expandedIds, onToggle, patchItem, revenueCenters,
}: {
  session: Session
  filter: V2Filter
  sortMode: 'invoice' | 'exceptions'
  expandedIds: Record<string, true>
  onToggle: (id: string) => void
  patchItem: (id: string, updates: Partial<ScanItem>) => Promise<void>
  revenueCenters: Array<{ id: string; name: string; color: string }>
}) {
  const filtered = applyFilter(session.scanItems, filter)
  const ordered = sortMode === 'exceptions' ? sortByExceptionsFirst(filtered) : [...filtered].sort((a, b) => a.sortOrder - b.sortOrder)

  if (ordered.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-gray-400">
        No items match this filter.
      </div>
    )
  }

  return (
    <div className="px-3 py-3 space-y-2 bg-gray-50/60">
      {ordered.map(item => (
        <LineItemRow
          key={item.id}
          item={item}
          isExpanded={!!expandedIds[item.id]}
          onToggle={() => onToggle(item.id)}
          patchItem={patchItem}
          revenueCenters={revenueCenters}
        />
      ))}
    </div>
  )
}

// ── Line item row ─────────────────────────────────────────────────────────────
function LineItemRow({
  item, isExpanded, onToggle, patchItem, revenueCenters,
}: {
  item: ScanItem
  isExpanded: boolean
  onToggle: () => void
  patchItem: (id: string, updates: Partial<ScanItem>) => Promise<void>
  revenueCenters: Array<{ id: string; name: string; color: string }>
}) {
  const mode    = effectiveMode(item)
  const tokens  = mathTokens(item)
  const v       = varianceOf(item)
  const pdm     = productDefaultMode(item)
  const linked  = item.matchedItem
  const lineTotal = item.rawLineTotal != null ? Number(item.rawLineTotal) : null

  // Row border tone — danger > warning > neutral
  const borderClass =
    isUnknownMode(item)                      ? 'border-red-300' :
    isNeedsLink(item)                        ? 'border-red-300' :
    isCrossCheckFail(item)                   ? 'border-red-300' :
    isModeMismatch(item)                     ? 'border-amber-300' :
    isLowConfidence(item)                    ? 'border-amber-300' :
                                               'border-gray-200'

  return (
    <div className={`bg-white rounded-xl border ${borderClass} overflow-hidden`}>
      {/* Row header — keyboard-expandable */}
      <button
        onClick={onToggle}
        aria-expanded={isExpanded}
        className="w-full text-left px-3 pt-3 pb-2 flex items-start gap-3 hover:bg-gray-50/60 transition-colors"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm font-medium text-gray-900 truncate">{item.rawDescription}</span>
            {isModeMismatch(item)   && <Pill tone="warning">mode mismatch</Pill>}
            {isCw(item)             && <Pill tone="info">catchweight</Pill>}
            {isLowConfidence(item)  && <Pill tone="warning">low conf</Pill>}
            {isUnknownMode(item)    && <Pill tone="danger">unknown mode</Pill>}
          </div>
          <div className="mt-0.5 text-[11px] text-gray-500 truncate">
            {[
              item.supplierItemCode ? `#${item.supplierItemCode}` : null,
              packDescription(item) || null,
              item.lineCategory || null,
            ].filter(Boolean).join(' · ')}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[15px] font-medium text-gray-900">
            {lineTotal != null ? formatCurrency(lineTotal) : '—'}
          </div>
          {isExpanded ? <ChevronUp size={14} className="text-gray-400 inline-block mt-1" /> : <ChevronDown size={14} className="text-gray-400 inline-block mt-1" />}
        </div>
      </button>

      {/* Math expression card */}
      <div className="mx-3 mb-2 bg-gray-50 rounded-lg px-3 py-2 flex items-center gap-3">
        <div className="shrink-0 text-gray-400">
          {mode === 'per_weight' ? <Scale size={16} /> : <Package size={16} />}
        </div>
        <div className="flex-1 text-[13px] text-gray-900 leading-tight">
          <span className="font-medium">{tokens.lhs.value}</span>
          {tokens.lhs.uom && <span className="text-gray-500"> {tokens.lhs.uom}</span>}
          {tokens.lhs.ordHint && <span className="text-[11px] text-gray-400 ml-1">{tokens.lhs.ordHint}</span>}
          <span className="text-gray-400 mx-1.5">×</span>
          <span className="font-medium">{tokens.rhs.value}</span>
          {tokens.rhs.uom && <span className="text-gray-500">/{tokens.rhs.uom}</span>}
          <span className="text-gray-400 mx-1.5">=</span>
          <span className="font-medium">{tokens.result}</span>
        </div>
        <ModePill mode={mode} />
      </div>

      {/* Link strip */}
      <div className="px-3 pb-3 flex items-center gap-3 text-[12px]">
        <div className="flex-1 min-w-0 flex items-center gap-1.5 flex-wrap">
          {linked ? (
            <>
              <Link2 size={12} className="text-gray-400" />
              <span className="text-gray-700">linked to <span className="font-medium text-gray-900">{linked.itemName}</span></span>
              {v != null && Math.abs(v) >= 0.01 && (
                <VariancePill v={v} />
              )}
            </>
          ) : (
            <>
              <Unlink size={12} className="text-red-500" />
              {item.action === 'CREATE_NEW' ? (
                <span className="text-gray-700">will create new inventory item</span>
              ) : item.action === 'SKIP' ? (
                <span className="text-gray-400">skipped</span>
              ) : (
                <span className="text-red-700 font-medium">not linked yet</span>
              )}
            </>
          )}
        </div>
        <RcAssigner
          item={item}
          revenueCenters={revenueCenters}
          onAssign={(rcId) => patchItem(item.id, { revenueCenterId: rcId })}
        />
      </div>

      {/* Expanded details */}
      {isExpanded && (
        <ExpandedDetails
          item={item}
          mode={mode}
          variance={v}
          productDefaultMode={pdm}
          patchItem={patchItem}
        />
      )}
    </div>
  )
}

function Pill({ tone, children }: { tone: 'warning' | 'info' | 'danger' | 'success'; children: React.ReactNode }) {
  const t = TONE[tone]
  return <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${t.bg} ${t.text} border ${t.border}`}>{children}</span>
}

function ModePill({ mode }: { mode: PricingMode }) {
  if (mode === 'unknown') return <Pill tone="danger">unknown mode</Pill>
  if (mode === 'per_weight') return <Pill tone="info">by weight</Pill>
  return <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-600 border border-gray-200">by case</span>
}

function VariancePill({ v }: { v: number }) {
  const pct = (v * 100)
  const up = v > 0
  const tone = up ? 'danger' : 'success'
  const t = TONE[tone]
  return (
    <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium ${t.bg} ${t.text} border ${t.border}`}>
      {up ? <TrendingUp size={9} /> : <TrendingDown size={9} />}
      {up ? '↑' : '↓'} {Math.abs(pct).toFixed(1)}%
    </span>
  )
}

function RcAssigner({
  item, revenueCenters, onAssign,
}: {
  item: ScanItem
  revenueCenters: Array<{ id: string; name: string; color: string }>
  onAssign: (rcId: string) => void
}) {
  if (revenueCenters.length <= 1) return null
  const current = revenueCenters.find(rc => rc.id === item.revenueCenterId)
  return (
    <select
      value={item.revenueCenterId ?? ''}
      onChange={(e) => onAssign(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      aria-label="Assign revenue center"
      className={`text-[11px] rounded-lg px-2 py-0.5 shrink-0 focus:outline-none focus:ring-1 focus:ring-gold ${
        current
          ? 'border border-gray-200 bg-white text-gray-700'
          : 'border border-dashed border-gray-300 bg-white text-gray-400'
      }`}
    >
      <option value="">RC: assign…</option>
      {revenueCenters.map(rc => (
        <option key={rc.id} value={rc.id}>RC: {rc.name}</option>
      ))}
    </select>
  )
}

// ── Expanded details — mode toggle + adaptive form + variance result ──────────
function ExpandedDetails({
  item, mode, variance, productDefaultMode: pdm, patchItem,
}: {
  item: ScanItem
  mode: PricingMode
  variance: number | null
  productDefaultMode: PricingMode | null
  patchItem: (id: string, updates: Partial<ScanItem>) => Promise<void>
}) {
  const switchMode = async (next: 'per_case' | 'per_weight') => {
    if (mode === next) return
    if (next === 'per_case') {
      // Clear weight-only fields; pre-fill unitPrice from lineTotal/qty if blank
      const qty = item.rawQty != null ? Number(item.rawQty) : null
      const lt  = item.rawLineTotal != null ? Number(item.rawLineTotal) : null
      const fallbackUnitPrice = (qty && lt && qty > 0) ? lt / qty : null
      await patchItem(item.id, {
        pricingMode: 'per_case',
        rate: null, rateUOM: null, totalQty: null, totalQtyUOM: null,
        ...(item.rawUnitPrice == null && fallbackUnitPrice != null ? { rawUnitPrice: String(fallbackUnitPrice) } : {}),
      })
    } else {
      await patchItem(item.id, {
        pricingMode: 'per_weight',
        rawUnitPrice: null,
      })
    }
  }

  return (
    <div className="border-t border-dashed border-gray-200 bg-gray-50/80 px-3 py-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest">Pricing details</span>
        <ModeToggle current={mode} onChange={switchMode} />
      </div>

      {mode === 'per_case' ? (
        <PerCaseForm item={item} patchItem={patchItem} />
      ) : mode === 'per_weight' ? (
        <PerWeightForm item={item} patchItem={patchItem} />
      ) : (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          Mode couldn&apos;t be detected. Pick <button onClick={() => switchMode('per_case')} className="underline font-medium">per case</button> or <button onClick={() => switchMode('per_weight')} className="underline font-medium">per weight</button> to continue.
        </div>
      )}

      {/* Inventory cost result */}
      {item.matchedItem && (
        <CostResult item={item} variance={variance} />
      )}

      {/* Mode-mismatch note — surface only; the "Confirm to switch product default"
          action needs a new endpoint that doesn't exist yet, so we just inform. */}
      {pdm && mode !== 'unknown' && pdm !== mode && item.matchedItem && (
        <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 flex items-start gap-2">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <div>
            Detected pricing is per {mode === 'per_weight' ? 'weight' : 'case'}, but <span className="font-medium">{item.matchedItem.itemName}</span> is set up per {pdm === 'per_weight' ? 'weight' : 'case'}.
            The mode change above applies to this line only.
          </div>
        </div>
      )}
    </div>
  )
}

function ModeToggle({ current, onChange }: { current: PricingMode; onChange: (m: 'per_case' | 'per_weight') => void }) {
  const cls = (active: boolean) =>
    `px-2.5 py-1 text-[11px] font-medium transition-colors ${active ? 'bg-blue-50 text-blue-700' : 'bg-white text-gray-500 hover:text-gray-700'}`
  return (
    <div className="inline-flex border border-gray-200 rounded-lg overflow-hidden">
      <button onClick={() => onChange('per_case')}   className={cls(current === 'per_case')}>case</button>
      <button onClick={() => onChange('per_weight')} className={cls(current === 'per_weight')}>weight</button>
    </div>
  )
}

// ── Inline field editor — debounced PATCH on blur ────────────────────────────
function NumField({
  label, value, onCommit, uom, placeholder, step = 'any',
}: {
  label: string
  value: string | number | null | undefined
  onCommit: (next: string) => void
  uom?: string | null
  placeholder?: string
  step?: string
}) {
  const [local, setLocal] = useState(value == null ? '' : String(Number(value)))
  useEffect(() => { setLocal(value == null ? '' : String(Number(value))) }, [value])
  return (
    <label className="block">
      <span className="block text-[10px] text-gray-500 mb-0.5">{label}</span>
      <div className="flex items-center gap-1">
        <input
          type="number"
          step={step}
          min="0"
          value={local}
          onChange={(e) => setLocal(e.target.value)}
          onBlur={() => { if (local !== (value == null ? '' : String(Number(value)))) onCommit(local) }}
          placeholder={placeholder}
          className="flex-1 min-w-0 border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
        />
        {uom && <span className="text-[11px] text-gray-500 shrink-0">{uom}</span>}
      </div>
    </label>
  )
}

function PerCaseForm({ item, patchItem }: { item: ScanItem; patchItem: (id: string, u: Partial<ScanItem>) => Promise<void> }) {
  return (
    <div className="grid grid-cols-2 gap-2.5">
      <NumField label="Qty ordered"  value={item.qtyOrdered}   uom={item.qtyOrderedUOM ?? 'cs'} onCommit={(v) => patchItem(item.id, { qtyOrdered: v || null })} />
      <NumField label="Qty shipped"  value={item.rawQty}        uom={item.rawUnit ?? 'cs'}      onCommit={(v) => patchItem(item.id, { rawQty: v || null })} />
      <NumField label="Unit price"   value={item.rawUnitPrice}  uom={`$/${item.rawUnit ?? 'cs'}`} onCommit={(v) => patchItem(item.id, { rawUnitPrice: v || null })} />
      <NumField label="Line total"   value={item.rawLineTotal}  uom="$"                          onCommit={(v) => patchItem(item.id, { rawLineTotal: v || null })} />
    </div>
  )
}

function PerWeightForm({ item, patchItem }: { item: ScanItem; patchItem: (id: string, u: Partial<ScanItem>) => Promise<void> }) {
  const rateUOM = item.rateUOM ?? item.totalQtyUOM ?? 'kg'
  return (
    <>
      <div className="grid grid-cols-2 gap-2.5">
        <NumField label="Ordered weight" value={item.qtyOrdered}   uom={item.qtyOrderedUOM ?? rateUOM} onCommit={(v) => patchItem(item.id, { qtyOrdered: v || null })} />
        <NumField label="Shipped weight" value={item.rawQty}        uom={item.rawUnit ?? rateUOM}       onCommit={(v) => patchItem(item.id, { rawQty: v || null })} />
        <NumField label="Rate"           value={item.rate}          uom={`$/${rateUOM}`}                onCommit={(v) => patchItem(item.id, { rate: v || null })} />
        <NumField label="Total qty"      value={item.totalQty}      uom={item.totalQtyUOM ?? rateUOM}   onCommit={(v) => patchItem(item.id, { totalQty: v || null })} />
      </div>
      <div className="text-[11px] text-gray-500 px-1">
        Line total = total qty × rate ={' '}
        <span className="font-medium text-gray-700">
          {item.rawLineTotal != null ? formatCurrency(Number(item.rawLineTotal))
            : (item.rate && item.totalQty) ? formatCurrency(Number(item.rate) * Number(item.totalQty))
            : '—'}
        </span>
      </div>
    </>
  )
}

function CostResult({ item, variance }: { item: ScanItem; variance: number | null }) {
  const inv = item.matchedItem
  if (!inv) return null
  const prev = inv.pricePerBaseUnit != null ? Number(inv.pricePerBaseUnit) : null
  // Local recompute mirroring selectors.newCostPerBaseUnit, but expressed
  // for display so we don't have to thread it through props.
  const baseUnit = inv.baseUnit || 'each'
  return (
    <div className="border-t border-dashed border-gray-200 pt-2.5 flex items-center justify-between gap-3 flex-wrap text-[12px]">
      <div className="text-gray-500">
        inventory cost in <span className="font-mono">{baseUnit}</span>
        {prev != null && (
          <> · last applied <span className="font-medium text-gray-700">${prev.toFixed(4)}/{baseUnit}</span></>
        )}
      </div>
      {variance != null && (
        <VariancePill v={variance} />
      )}
    </div>
  )
}

// ── Drawer footer ─────────────────────────────────────────────────────────────
function DrawerFooter({
  session, approvedBy, onApprovedByChange, onApprove, onReject, isApproving,
}: {
  session: Session
  approvedBy: string
  onApprovedByChange: (v: string) => void
  onApprove: () => void
  onReject: () => void
  isApproving: boolean
}) {
  const blockers = useMemo(() => ({
    unknownMode: session.scanItems.filter(isUnknownMode).length,
    needsLink:   session.scanItems.filter(isNeedsLink).length,
    mismatch:    session.scanItems.filter(isModeMismatch).length,
    lowConf:     session.scanItems.filter(isLowConfidence).length,
  }), [session.scanItems])

  const totalItems = session.scanItems.length
  const canApprove = approvedBy.trim().length > 0 && blockers.unknownMode === 0 && blockers.needsLink === 0 && !isApproving
  const hasBlockerHint = blockers.needsLink > 0 || blockers.mismatch > 0 || blockers.lowConf > 0 || blockers.unknownMode > 0

  return (
    <div className="sticky bottom-0 bg-white border-t border-gray-200 px-4 py-3 flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
      <div className="flex-1 text-[12px] text-gray-600 leading-tight">
        <div className="font-medium text-gray-800">{totalItems} items</div>
        {hasBlockerHint && (
          <div className="text-[11px] text-gray-500 mt-0.5">
            {[
              blockers.unknownMode > 0 ? `${blockers.unknownMode} unknown mode` : null,
              blockers.needsLink   > 0 ? `${blockers.needsLink} needs link`     : null,
              blockers.mismatch    > 0 ? `${blockers.mismatch} mismatch`        : null,
              blockers.lowConf     > 0 ? `${blockers.lowConf} low conf`         : null,
            ].filter(Boolean).join(' · ')}
          </div>
        )}
      </div>
      <input
        type="text"
        value={approvedBy}
        onChange={(e) => onApprovedByChange(e.target.value)}
        placeholder="Your name"
        aria-label="Approver name"
        className={`border rounded-lg px-3 py-1.5 text-sm w-full sm:w-36 focus:outline-none focus:ring-2 focus:ring-gold ${
          !approvedBy ? 'border-amber-300 bg-amber-50' : 'border-gray-200'
        }`}
      />
      <div className="flex items-center gap-2">
        <button
          onClick={onReject}
          disabled={isApproving}
          className="border border-red-500 text-red-600 rounded-lg px-4 py-2 text-sm font-medium hover:bg-red-50 disabled:opacity-50"
        >
          Reject
        </button>
        <button
          onClick={onApprove}
          disabled={!canApprove}
          title={!canApprove
            ? blockers.unknownMode > 0 ? 'Resolve unknown-mode rows first'
              : blockers.needsLink > 0 ? 'Link or create all rows first'
              : !approvedBy.trim() ? 'Enter your name'
              : ''
            : ''}
          className="bg-emerald-600 text-white rounded-lg px-4 py-2 text-sm font-medium flex items-center gap-2 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isApproving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
          {isApproving ? 'Approving…' : 'Approve & apply'}
        </button>
      </div>
    </div>
  )
}

// Unused import suppressions — Plus is reserved for an upcoming manual-add hook
void Plus
