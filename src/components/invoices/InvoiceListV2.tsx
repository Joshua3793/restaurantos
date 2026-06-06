'use client'
import { useState, useMemo } from 'react'
import { Trash2, X, ChevronsUpDown, ChevronUp, ChevronDown, Search, FileText, Upload, MoreHorizontal, RotateCcw } from 'lucide-react'
import { SessionSummary, SessionStatus } from './types'
import { formatCurrency } from '@/lib/utils'

type Tab    = 'all' | 'REVIEW' | 'APPROVED' | 'REJECTED'
type ColKey = 'supplier' | 'date' | 'total' | 'items' | 'status'
type ColDir = 'asc' | 'desc'

// First-click direction: text cols A→Z, numeric/date cols newest/highest first
const COL_DEFAULT_DIR: Record<ColKey, ColDir> = {
  supplier: 'asc',
  date:     'desc',
  total:    'desc',
  items:    'desc',
  status:   'asc',
}

const STATUS_ORDER: Record<string, number> = {
  REVIEW: 0, PROCESSING: 1, APPROVING: 1, UPLOADING: 2, APPROVED: 3, REJECTED: 4, ERROR: 5,
}

interface Props {
  sessions: SessionSummary[]
  onSelect: (id: string) => void
  onUploadClick: () => void
  onScanClick?: () => void
  onDelete: (id: string, status: SessionStatus) => Promise<void>
  onBulkDelete: (ids: string[]) => Promise<void>
  onRetry: (id: string) => Promise<void>
}

// ── Branded status badge ─────────────────────────────────────────────────────

function StatusBadge({ status }: { status: SessionStatus }) {
  const map: Partial<Record<SessionStatus, { label: string; bg: string; text: string; dot: string; pulse?: boolean }>> = {
    REVIEW:     { label: 'Review',     bg: 'bg-gold-soft',  text: 'text-gold-2',    dot: 'bg-gold' },
    APPROVED:   { label: 'Approved',   bg: 'bg-green-soft', text: 'text-green-text', dot: 'bg-green' },
    REJECTED:   { label: 'Rejected',   bg: 'bg-red-soft',   text: 'text-red-text',  dot: 'bg-red' },
    PROCESSING: { label: 'Processing', bg: 'bg-blue-soft',  text: 'text-blue-text', dot: 'bg-blue', pulse: true },
    APPROVING:  { label: 'Applying',   bg: 'bg-blue-soft',  text: 'text-blue-text', dot: 'bg-blue', pulse: true },
    UPLOADING:  { label: 'Uploading',  bg: 'bg-bg-2',       text: 'text-ink-3',     dot: 'bg-ink-4', pulse: true },
    ERROR:      { label: 'Error',      bg: 'bg-red-soft',   text: 'text-red-text',  dot: 'bg-red' },
  }
  const t = map[status] ?? { label: String(status), bg: 'bg-bg-2', text: 'text-ink-3', dot: 'bg-ink-4' }
  return (
    <span className={`inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.04em] font-medium px-2 py-0.5 rounded-full ${t.bg} ${t.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${t.dot} ${t.pulse ? 'animate-pulse' : ''}`} />
      {t.label}
    </span>
  )
}

function SortIcon({ col, colSort }: { col: ColKey; colSort: { col: ColKey; dir: ColDir } | null }) {
  if (!colSort || colSort.col !== col)
    return <ChevronsUpDown size={10} className="text-ink-4 ml-0.5 inline-block shrink-0" />
  return colSort.dir === 'asc'
    ? <ChevronUp   size={10} className="text-gold ml-0.5 inline-block shrink-0" />
    : <ChevronDown size={10} className="text-gold ml-0.5 inline-block shrink-0" />
}

function SortTh({ col, label, colSort, onSort, className = '' }: {
  col: ColKey; label: string
  colSort: { col: ColKey; dir: ColDir } | null
  onSort: (c: ColKey) => void
  className?: string
}) {
  const active = colSort?.col === col
  return (
    <button
      onClick={() => onSort(col)}
      className={`inline-flex items-center gap-0.5 font-mono text-[10px] uppercase tracking-[0.04em] rounded transition-colors whitespace-nowrap
        ${active ? 'text-gold' : 'text-ink-3 hover:text-ink-2'} ${className}`}
    >
      {label}
      <SortIcon col={col} colSort={colSort} />
    </button>
  )
}

function Checkbox({ checked, indeterminate, onChange }: {
  checked: boolean
  indeterminate?: boolean
  onChange: () => void
}) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onChange() }}
      className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
        checked || indeterminate
          ? 'bg-ink border-ink text-paper'
          : 'border-line bg-paper hover:border-ink-3'
      }`}
    >
      {checked && <span className="text-[10px] leading-none">✓</span>}
      {indeterminate && !checked && <span className="block w-2 h-0.5 bg-paper" />}
    </button>
  )
}

// ── Main ─────────────────────────────────────────────────────────────────────

export function InvoiceListV2({ sessions, onSelect, onUploadClick, onScanClick, onDelete, onBulkDelete, onRetry }: Props) {
  const [tab, setTab]                     = useState<Tab>('all')
  const [search, setSearch]               = useState('')
  const [openMenu, setOpenMenu]           = useState<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; status: SessionStatus } | null>(null)
  const [isDeleting, setIsDeleting]       = useState(false)
  const [colSort, setColSort]             = useState<{ col: ColKey; dir: ColDir } | null>(null)

  const [selectedIds, setSelectedIds]             = useState<Set<string>>(new Set())
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false)
  const [isBulkDeleting, setIsBulkDeleting]       = useState(false)

  const reviewCount = sessions.filter(s => s.status === 'REVIEW').length

  const handleSort = (col: ColKey) => {
    setColSort(prev => {
      if (!prev || prev.col !== col) return { col, dir: COL_DEFAULT_DIR[col] }
      return { col, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
    })
  }

  const filtered = useMemo(() => {
    let rows = sessions.filter(s => {
      if (tab !== 'all' && s.status !== tab) return false
      if (search) {
        const q = search.toLowerCase()
        return (
          (s.supplierName?.toLowerCase().includes(q) ?? false) ||
          (s.invoiceNumber?.toLowerCase().includes(q) ?? false)
        )
      }
      return true
    })

    if (colSort) {
      const { col, dir } = colSort
      const sign = dir === 'asc' ? 1 : -1
      rows = [...rows].sort((a, b) => {
        switch (col) {
          case 'supplier': {
            const aName = (a.supplierName ?? '').toLowerCase()
            const bName = (b.supplierName ?? '').toLowerCase()
            return sign * aName.localeCompare(bName)
          }
          case 'date': {
            const aD = a.invoiceDate ?? a.createdAt
            const bD = b.invoiceDate ?? b.createdAt
            return sign * aD.localeCompare(bD)
          }
          case 'total': return sign * (Number(a.total ?? 0) - Number(b.total ?? 0))
          case 'items': return sign * (a._count.scanItems - b._count.scanItems)
          case 'status': return sign * ((STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9))
          default: return 0
        }
      })
    }

    return rows
  }, [sessions, tab, search, colSort])

  const allSelected  = filtered.length > 0 && filtered.every(s => selectedIds.has(s.id))
  const someSelected = filtered.some(s => selectedIds.has(s.id))
  const selectedInView = filtered.filter(s => selectedIds.has(s.id))
  const hasApproved    = selectedInView.some(s => s.status === 'APPROVED')

  const toggleOne = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const toggleAll = () => {
    if (allSelected) {
      setSelectedIds(prev => { const n = new Set(prev); filtered.forEach(s => n.delete(s.id)); return n })
    } else {
      setSelectedIds(prev => { const n = new Set(prev); filtered.forEach(s => n.add(s.id)); return n })
    }
  }

  const clearSelection = () => setSelectedIds(new Set())

  const handleDelete = async (id: string, status: SessionStatus) => {
    setIsDeleting(true)
    await onDelete(id, status)
    setIsDeleting(false)
    setDeleteConfirm(null)
    setSelectedIds(prev => { const n = new Set(prev); n.delete(id); return n })
  }

  const handleBulkDelete = async () => {
    setIsBulkDeleting(true)
    await onBulkDelete(selectedInView.map(s => s.id))
    setIsBulkDeleting(false)
    setBulkDeleteConfirm(false)
    clearSelection()
  }

  return (
    <div className="space-y-3">
      {/* ── Toolbar ── */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Filter pills */}
        <div className="inline-flex bg-paper border border-line rounded-[9px] p-[3px] gap-0.5">
          {(['all', 'REVIEW', 'APPROVED', 'REJECTED'] as Tab[]).map(t => (
            <button key={t} onClick={() => { setTab(t); clearSelection() }}
              className={`font-mono text-[11px] px-3 py-1.5 rounded-[6px] tracking-[0.02em] uppercase transition-colors inline-flex items-center gap-1.5 ${
                tab === t ? 'bg-ink text-paper' : 'text-ink-3 hover:text-ink-2'
              }`}
            >
              {t === 'all' ? 'All' : t === 'REVIEW' ? 'Review' : t === 'APPROVED' ? 'Approved' : 'Rejected'}
              {t === 'REVIEW' && reviewCount > 0 && (
                <span className={`font-mono text-[10px] px-1.5 rounded-full leading-tight ${tab === t ? 'bg-gold text-ink' : 'bg-gold-soft text-gold-2'}`}>{reviewCount}</span>
              )}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="flex-1 min-w-[200px] relative">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
          <input
            value={search}
            onChange={e => { setSearch(e.target.value); clearSelection() }}
            placeholder="Search supplier or invoice #…"
            className="w-full bg-paper border border-line rounded-[9px] pl-8 pr-3 py-[7px] text-[13px] text-ink placeholder-ink-4 focus:outline-none focus:ring-2 focus:ring-gold"
          />
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          {onScanClick && (
            <button onClick={onScanClick}
              className="inline-flex items-center gap-1.5 border border-line bg-paper text-ink-2 px-3 py-[7px] rounded-[8px] text-[12.5px] font-medium hover:border-ink-3 transition-colors">
              <FileText size={12} className="text-ink-3" /> Scan
            </button>
          )}
          <button onClick={onUploadClick}
            className="inline-flex items-center gap-1.5 bg-ink text-paper px-3 py-[7px] rounded-[8px] text-[12.5px] font-medium hover:bg-[#18181b] transition-colors">
            <Upload size={12} className="text-gold" /> Upload
          </button>
        </div>
      </div>

      {/* ── Bulk action bar ── */}
      {selectedInView.length > 0 && (
        <div className="flex items-center gap-3 px-4 py-2.5 bg-ink text-paper rounded-[10px]">
          <span className="font-mono text-[11px] uppercase tracking-[0.04em]">
            <span className="text-gold font-semibold">{selectedInView.length}</span> selected
          </span>
          <div className="flex-1" />
          <button onClick={clearSelection}
            className="font-mono text-[11px] uppercase tracking-[0.04em] text-ink-4 hover:text-paper inline-flex items-center gap-1 transition-colors">
            <X size={11} /> Clear
          </button>
          <button onClick={() => setBulkDeleteConfirm(true)}
            className="inline-flex items-center gap-1.5 bg-red text-white text-[12px] font-medium px-3 py-1.5 rounded-[8px] hover:bg-red transition-colors">
            <Trash2 size={11} /> Delete {selectedInView.length}
          </button>
        </div>
      )}

      {/* ── Table ── */}
      <div className="bg-paper border border-line rounded-[12px] overflow-hidden">
        {/* Desktop column headers */}
        <div className="hidden sm:grid grid-cols-[36px_1fr_110px_120px_70px_110px_36px] gap-2 px-[18px] py-2.5 bg-bg-2 border-b border-line items-center">
          <Checkbox checked={allSelected} indeterminate={someSelected && !allSelected} onChange={toggleAll} />
          <SortTh col="supplier" label="Supplier / Invoice" colSort={colSort} onSort={handleSort} />
          <SortTh col="date"     label="Date"               colSort={colSort} onSort={handleSort} />
          <SortTh col="total"    label="Total"              colSort={colSort} onSort={handleSort} className="justify-self-end" />
          <SortTh col="items"    label="Items"              colSort={colSort} onSort={handleSort} className="justify-self-end" />
          <SortTh col="status"   label="Status"             colSort={colSort} onSort={handleSort} />
          <div />
        </div>

        <div onClick={() => setOpenMenu(null)}>
          {filtered.length === 0 && (
            <div className="py-12 text-center font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3">No invoices found</div>
          )}

          {filtered.map((s, idx) => {
            const isSelected = selectedIds.has(s.id)
            const isInflight = s.status === 'PROCESSING' || s.status === 'APPROVING' || s.status === 'ERROR'
            const canOpen    = !isInflight
            const isLast     = idx === filtered.length - 1
            return (
              <div key={s.id}>
                {/* Desktop row */}
                <div
                  className={`hidden sm:grid grid-cols-[36px_1fr_110px_120px_70px_110px_36px] gap-2 px-[18px] py-3 items-center transition-colors ${
                    isLast ? '' : 'border-b border-line'
                  } ${
                    isInflight ? 'opacity-70 cursor-default'
                    : isSelected ? 'bg-gold-soft/40 hover:bg-gold-soft/60 cursor-pointer'
                    : s.status === 'REVIEW' ? 'bg-gold-soft/30 hover:bg-gold-soft/50 cursor-pointer'
                    : 'hover:bg-bg-2/40 cursor-pointer'
                  }`}
                  onClick={() => canOpen && onSelect(s.id)}
                >
                  <Checkbox checked={isSelected} onChange={() => toggleOne(s.id)} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[13.5px] font-medium text-ink tracking-[-0.005em] truncate">
                        {s.supplierName ?? 'Unknown supplier'}
                      </span>
                      {s.parentSessionId && (
                        <span className="font-mono text-[9px] uppercase tracking-[0.04em] font-semibold bg-bg-2 text-ink-3 px-1.5 py-0.5 rounded-[4px] shrink-0">Copy</span>
                      )}
                    </div>
                    <div className="font-mono text-[10.5px] text-ink-3 mt-0.5 tracking-[0]">
                      {s._count.priceAlerts > 0 && (
                        <span className="text-gold-2 font-semibold">⚠ {s._count.priceAlerts} alert{s._count.priceAlerts !== 1 ? 's' : ''} · </span>
                      )}
                      {s.invoiceNumber ?? 'No invoice #'}
                    </div>
                    {s.status === 'ERROR' && s.errorMessage && (
                      <div className="font-mono text-[10.5px] text-red-text truncate mt-0.5 tracking-[0]" title={s.errorMessage}>
                        {s.errorMessage}
                      </div>
                    )}
                  </div>
                  <div className="font-mono text-[12px] text-ink-2">{s.invoiceDate ?? '—'}</div>
                  <div className="font-mono text-[13px] font-semibold text-ink tabular-nums text-right tracking-[-0.01em]">
                    {s.total ? formatCurrency(Number(s.total)) : '—'}
                  </div>
                  <div className="font-mono text-[12px] text-ink-2 text-right tabular-nums">{s._count.scanItems}</div>
                  <div><StatusBadge status={s.status} /></div>
                  <div className="relative justify-self-end" onClick={e => e.stopPropagation()}>
                    <button
                      onClick={() => setOpenMenu(openMenu === s.id ? null : s.id)}
                      className="w-7 h-7 grid place-items-center rounded-md text-ink-3 hover:text-ink hover:bg-bg-2 transition-colors"
                    >
                      <MoreHorizontal size={14} />
                    </button>
                    {openMenu === s.id && (
                      <div className="absolute right-0 top-8 z-10 bg-paper rounded-[10px] shadow-lg border border-line py-1 min-w-[140px]">
                        {s.status === 'ERROR' && (
                          <button
                            onClick={() => { onRetry(s.id); setOpenMenu(null) }}
                            className="w-full px-3 py-2 text-left text-[13px] text-ink-2 hover:bg-bg-2 inline-flex items-center gap-2"
                          >
                            <RotateCcw size={12} /> Retry scan
                          </button>
                        )}
                        <button
                          onClick={() => { setDeleteConfirm({ id: s.id, status: s.status }); setOpenMenu(null) }}
                          className="w-full px-3 py-2 text-left text-[13px] text-red-text hover:bg-red-soft/50 inline-flex items-center gap-2"
                        >
                          <Trash2 size={12} /> Delete
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Mobile row */}
                <div
                  className={`sm:hidden flex items-stretch transition-colors ${isLast ? '' : 'border-b border-line'} ${
                    isInflight ? 'opacity-70'
                    : isSelected ? 'bg-gold-soft/40'
                    : s.status === 'REVIEW' ? 'bg-gold-soft/30' : ''
                  }`}
                  onClick={() => canOpen && onSelect(s.id)}
                >
                  <div className="flex items-center pl-3 pr-1 shrink-0" onClick={e => { e.stopPropagation(); toggleOne(s.id) }}>
                    <Checkbox checked={isSelected} onChange={() => toggleOne(s.id)} />
                  </div>
                  <div className="flex-1 min-w-0 px-3 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-[13.5px] font-medium text-ink tracking-[-0.005em] truncate">
                          {s.supplierName ?? 'Unknown supplier'}
                        </span>
                        {s.parentSessionId && (
                          <span className="font-mono text-[9px] uppercase tracking-[0.04em] font-semibold bg-bg-2 text-ink-3 px-1.5 py-0.5 rounded-[4px] shrink-0">Copy</span>
                        )}
                      </div>
                      <StatusBadge status={s.status} />
                    </div>
                    <div className="font-mono text-[10.5px] text-ink-3 mt-1 tracking-[0] flex items-center gap-2 flex-wrap">
                      {s.total && <span className="font-medium text-ink-2">{formatCurrency(Number(s.total))}</span>}
                      <span>{s.invoiceDate ?? '—'}</span>
                      {s._count.priceAlerts > 0 && (
                        <span className="text-gold-2 font-semibold">⚠ {s._count.priceAlerts} alert{s._count.priceAlerts !== 1 ? 's' : ''}</span>
                      )}
                    </div>
                    {s.status === 'ERROR' && s.errorMessage && (
                      <div className="font-mono text-[10.5px] text-red-text truncate mt-1" title={s.errorMessage}>
                        {s.errorMessage}
                      </div>
                    )}
                  </div>
                  <div className="relative flex items-center pr-2 shrink-0" onClick={e => e.stopPropagation()}>
                    <button
                      onClick={() => setOpenMenu(openMenu === s.id ? null : s.id)}
                      className="w-8 h-8 grid place-items-center rounded-md text-ink-3 hover:text-ink hover:bg-bg-2 transition-colors"
                    >
                      <MoreHorizontal size={14} />
                    </button>
                    {openMenu === s.id && (
                      <div className="absolute right-2 top-9 z-10 bg-paper rounded-[10px] shadow-lg border border-line py-1 min-w-[140px]">
                        {s.status === 'ERROR' && (
                          <button
                            onClick={() => { onRetry(s.id); setOpenMenu(null) }}
                            className="w-full px-3 py-2 text-left text-[13px] text-ink-2 hover:bg-bg-2 inline-flex items-center gap-2"
                          >
                            <RotateCcw size={12} /> Retry scan
                          </button>
                        )}
                        <button
                          onClick={() => { setDeleteConfirm({ id: s.id, status: s.status }); setOpenMenu(null) }}
                          className="w-full px-3 py-2 text-left text-[13px] text-red-text hover:bg-red-soft/50 inline-flex items-center gap-2"
                        >
                          <Trash2 size={12} /> Delete
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Footer hint */}
      <div className="flex justify-between font-mono text-[10.5px] text-ink-3 tracking-wide pt-1">
        <span>SHOWING {filtered.length} OF {sessions.length} {sessions.length === 1 ? 'INVOICE' : 'INVOICES'}</span>
        <span>
          <kbd className="font-mono text-[10px] bg-bg-2 border border-line rounded px-1 py-px text-ink-2">⌘U</kbd> UPLOAD ·
          <kbd className="font-mono text-[10px] bg-bg-2 border border-line rounded px-1 py-px text-ink-2 ml-1">⌘F</kbd> SEARCH
        </span>
      </div>

      {/* ── Single delete confirmation modal ── */}
      {deleteConfirm && (
        <ConfirmModal
          onCancel={() => setDeleteConfirm(null)}
          onConfirm={() => handleDelete(deleteConfirm.id, deleteConfirm.status)}
          confirming={isDeleting}
          title="Delete invoice?"
          body={
            deleteConfirm.status === 'APPROVED'
              ? 'This will remove the approved invoice and reverse its price updates.'
              : 'This will permanently delete the invoice session.'
          }
          confirmLabel="Delete"
        />
      )}

      {/* ── Bulk delete confirmation ── */}
      {bulkDeleteConfirm && (
        <ConfirmModal
          onCancel={() => setBulkDeleteConfirm(false)}
          onConfirm={handleBulkDelete}
          confirming={isBulkDeleting}
          title={`Delete ${selectedInView.length} invoice${selectedInView.length !== 1 ? 's' : ''}?`}
          body={
            hasApproved
              ? `${selectedInView.filter(s => s.status === 'APPROVED').length} approved invoice(s) selected — their price updates will be reversed.`
              : 'All selected invoice sessions will be permanently deleted.'
          }
          warning={hasApproved}
          confirmLabel={`Delete ${selectedInView.length}`}
        />
      )}
    </div>
  )
}

function ConfirmModal({ onCancel, onConfirm, confirming, title, body, warning = false, confirmLabel }: {
  onCancel: () => void
  onConfirm: () => void
  confirming: boolean
  title: string
  body: string
  warning?: boolean
  confirmLabel: string
}) {
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onCancel}>
      <div className="bg-paper border border-line rounded-[14px] p-6 max-w-sm w-full mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-start gap-3 mb-3">
          <div className="w-9 h-9 rounded-[9px] grid place-items-center shrink-0 bg-red-soft text-red-text">
            <Trash2 size={15} />
          </div>
          <div className="flex-1">
            <h3 className="text-[16px] font-semibold text-ink tracking-[-0.015em]">{title}</h3>
            <p className="font-mono text-[10.5px] uppercase tracking-[0.04em] text-ink-3 mt-0.5">This cannot be undone</p>
          </div>
        </div>
        {warning ? (
          <div className="bg-gold-soft border border-[#fcd34d]/60 rounded-[8px] px-3 py-2.5 text-[12.5px] text-gold-2 mb-4">
            {body}
          </div>
        ) : (
          <p className="text-[13px] text-ink-2 leading-[1.5] mb-4">{body}</p>
        )}
        <div className="flex gap-2">
          <button onClick={onCancel}
            className="flex-1 px-3 py-2 rounded-[9px] border border-line bg-paper text-[13px] text-ink-2 hover:border-ink-3 transition-colors">
            Cancel
          </button>
          <button onClick={onConfirm} disabled={confirming}
            className="flex-1 px-3 py-2 rounded-[9px] bg-red text-white text-[13px] font-medium hover:bg-red disabled:opacity-50 transition-colors">
            {confirming ? 'Deleting…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
