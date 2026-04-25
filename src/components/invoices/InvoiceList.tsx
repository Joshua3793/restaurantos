'use client'
import { useState, useMemo } from 'react'
import { Trash2, X, ChevronsUpDown, ChevronUp, ChevronDown } from 'lucide-react'
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

// Status sort order for consistent grouping
const STATUS_ORDER: Record<string, number> = {
  REVIEW: 0, PROCESSING: 1, UPLOADING: 2, APPROVED: 3, REJECTED: 4, ERROR: 5,
}

interface Props {
  sessions: SessionSummary[]
  onSelect: (id: string) => void
  onUploadClick: () => void
  onDelete: (id: string, status: SessionStatus) => Promise<void>
  onBulkDelete: (ids: string[]) => Promise<void>
  onRetry: (id: string) => Promise<void>
}

function StatusBadge({ status }: { status: SessionStatus }) {
  if (status === 'REVIEW')
    return <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700">Review</span>
  if (status === 'APPROVED')
    return <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-green-100 text-green-700">Approved</span>
  if (status === 'REJECTED')
    return <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-100 text-red-600">Rejected</span>
  if (status === 'PROCESSING')
    return (
      <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-100 text-blue-600 flex items-center gap-1 w-fit">
        <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
        Processing
      </span>
    )
  if (status === 'ERROR')
    return <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-100 text-red-700">Error</span>
  return <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-gray-100 text-gray-500">Uploading</span>
}

function SortIcon({ col, colSort }: { col: ColKey; colSort: { col: ColKey; dir: ColDir } | null }) {
  if (!colSort || colSort.col !== col)
    return <ChevronsUpDown size={10} className="text-gray-300 ml-0.5 inline-block shrink-0" />
  return colSort.dir === 'asc'
    ? <ChevronUp   size={10} className="text-blue-600 ml-0.5 inline-block shrink-0" />
    : <ChevronDown size={10} className="text-blue-600 ml-0.5 inline-block shrink-0" />
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
      className={`inline-flex items-center gap-0.5 text-[10px] font-semibold uppercase tracking-wide rounded transition-colors whitespace-nowrap
        ${active ? 'text-blue-600' : 'text-gray-400 hover:text-gray-700'} ${className}`}
    >
      {label}
      <SortIcon col={col} colSort={colSort} />
    </button>
  )
}

function Checkbox({ checked, indeterminate, onChange }: {
  checked: boolean
  indeterminate?: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      type="button"
      onClick={e => { e.stopPropagation(); onChange(!checked) }}
      className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
        checked || indeterminate
          ? 'bg-blue-600 border-blue-600'
          : 'border-gray-300 hover:border-blue-400 bg-white'
      }`}
    >
      {indeterminate && !checked
        ? <span className="block w-2 h-0.5 bg-white rounded-full" />
        : checked
          ? <svg width="9" height="7" viewBox="0 0 9 7" fill="none"><path d="M1 3.5L3.5 6L8 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          : null
      }
    </button>
  )
}

export function InvoiceList({ sessions, onSelect, onUploadClick, onDelete, onBulkDelete, onRetry }: Props) {
  const [tab, setTab]                     = useState<Tab>('all')
  const [search, setSearch]               = useState('')
  const [openMenu, setOpenMenu]           = useState<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; status: SessionStatus } | null>(null)
  const [isDeleting, setIsDeleting]       = useState(false)
  const [colSort, setColSort]             = useState<{ col: ColKey; dir: ColDir } | null>(null)

  // Bulk selection
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
          case 'total': {
            return sign * (Number(a.total ?? 0) - Number(b.total ?? 0))
          }
          case 'items': {
            return sign * (a._count.scanItems - b._count.scanItems)
          }
          case 'status': {
            return sign * ((STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9))
          }
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
      next.has(id) ? next.delete(id) : next.add(id)
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
    <div className="flex-1 flex flex-col min-h-0">
      {/* ── Toolbar ── */}
      <div className="border-b border-gray-200 bg-white shrink-0">
        <div className="flex items-center gap-2 px-3 pt-2 pb-1.5 sm:px-4 sm:py-2 sm:pb-2">
          <div className="flex gap-0.5 bg-gray-100 rounded-lg p-0.5 flex-1 sm:flex-none overflow-x-auto">
            {(['all', 'REVIEW', 'APPROVED', 'REJECTED'] as Tab[]).map(t => (
              <button key={t} onClick={() => { setTab(t); clearSelection() }}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all whitespace-nowrap ${
                  tab === t ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {t === 'all' ? 'All' : t === 'REVIEW' ? (
                  <span className="flex items-center gap-1">
                    Review
                    {reviewCount > 0 && (
                      <span className="bg-amber-100 text-amber-700 rounded-full px-1.5 text-[9px] font-bold">{reviewCount}</span>
                    )}
                  </span>
                ) : t.charAt(0) + t.slice(1).toLowerCase()}
              </button>
            ))}
          </div>
          <button onClick={onUploadClick}
            className="bg-blue-600 text-white rounded-lg px-4 py-2 text-sm font-semibold hover:bg-blue-700 transition-colors shrink-0 sm:px-3 sm:py-1.5 sm:text-xs">
            + Scan Invoice
          </button>
        </div>
        <div className="px-3 pb-2 sm:hidden">
          <input value={search} onChange={e => { setSearch(e.target.value); clearSelection() }}
            placeholder="Search supplier or invoice #…"
            className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="hidden sm:block px-4 pb-2">
          <input value={search} onChange={e => { setSearch(e.target.value); clearSelection() }}
            placeholder="Search supplier or invoice #…"
            className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-1.5 text-xs text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      {/* ── Bulk action bar ── */}
      {selectedInView.length > 0 && (
        <div className="shrink-0 flex items-center gap-3 px-4 py-2 bg-blue-50 border-b border-blue-100">
          <span className="text-sm font-semibold text-blue-800">{selectedInView.length} selected</span>
          <div className="flex-1" />
          <button onClick={clearSelection}
            className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 font-medium">
            <X size={13} /> Clear
          </button>
          <button onClick={() => setBulkDeleteConfirm(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-600 text-white text-xs font-semibold hover:bg-red-700 transition-colors">
            <Trash2 size={12} /> Delete {selectedInView.length}
          </button>
        </div>
      )}

      {/* ── Desktop column headers with sort ── */}
      <div className="hidden sm:grid grid-cols-[28px_1fr_100px_100px_60px_100px_32px] gap-2 px-4 py-2 bg-gray-50 border-b border-gray-200 shrink-0 items-center">
        <Checkbox checked={allSelected} indeterminate={someSelected && !allSelected} onChange={toggleAll} />
        <SortTh col="supplier" label="Supplier / Invoice" colSort={colSort} onSort={handleSort} />
        <SortTh col="date"     label="Date"               colSort={colSort} onSort={handleSort} />
        <SortTh col="total"    label="Total"              colSort={colSort} onSort={handleSort} />
        <SortTh col="items"    label="Items"              colSort={colSort} onSort={handleSort} />
        <SortTh col="status"   label="Status"             colSort={colSort} onSort={handleSort} />
        <div />
      </div>

      {/* ── Rows ── */}
      <div className="flex-1 overflow-y-auto" onClick={() => setOpenMenu(null)}>
        {filtered.length === 0 && (
          <div className="py-16 text-center text-sm text-gray-400">No invoices found</div>
        )}

        {filtered.map(s => {
          const isSelected = selectedIds.has(s.id)
          return (
            <div key={s.id}>
              {/* Desktop row */}
              <div
                className={`hidden sm:grid grid-cols-[28px_1fr_100px_100px_60px_100px_32px] gap-2 px-4 py-2.5 border-b border-gray-100 items-center transition-colors ${
                  s.status === 'PROCESSING' || s.status === 'ERROR'
                    ? 'opacity-70 cursor-default'
                    : isSelected
                      ? 'bg-blue-50 hover:bg-blue-100 cursor-pointer'
                      : s.status === 'REVIEW'
                        ? 'bg-amber-50 hover:bg-amber-100 cursor-pointer'
                        : 'hover:bg-gray-50 cursor-pointer'
                }`}
                onClick={() => {
                  if (s.status !== 'PROCESSING' && s.status !== 'ERROR') onSelect(s.id)
                }}
              >
                <Checkbox checked={isSelected} onChange={() => toggleOne(s.id)} />
                <div className="min-w-0">
                  <div className="flex items-center gap-1">
                    <p className="text-sm font-semibold text-gray-900 truncate">
                      {s.supplierName ?? 'Unknown supplier'}
                    </p>
                    {s.parentSessionId && (
                      <span className="text-[9px] font-bold bg-purple-100 text-purple-600 px-1 py-0.5 rounded shrink-0">COPY</span>
                    )}
                  </div>
                  <p className="text-[10px] text-gray-400">
                    {s._count.priceAlerts > 0 && (
                      <span className="text-amber-600">
                        ⚠ {s._count.priceAlerts} alert{s._count.priceAlerts !== 1 ? 's' : ''} ·{' '}
                      </span>
                    )}
                    {s.invoiceNumber ?? 'No invoice #'}
                  </p>
                </div>
                <div className="text-xs text-gray-600">{s.invoiceDate ?? '—'}</div>
                <div className="text-sm font-semibold text-gray-900">
                  {s.total ? formatCurrency(Number(s.total)) : '—'}
                </div>
                <div className="text-xs text-gray-600">{s._count.scanItems}</div>
                <div><StatusBadge status={s.status} /></div>
                <div className="relative" onClick={e => e.stopPropagation()}>
                  <button
                    onClick={() => setOpenMenu(openMenu === s.id ? null : s.id)}
                    className="w-7 h-7 flex items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 text-base leading-none"
                  >⋯</button>
                  {openMenu === s.id && (
                    <div className="absolute right-0 top-8 z-10 bg-white border border-gray-200 rounded-lg shadow-lg py-1 min-w-[120px]">
                      {s.status === 'ERROR' && (
                        <button
                          onClick={() => { onRetry(s.id); setOpenMenu(null) }}
                          className="w-full px-3 py-2 text-left text-sm text-blue-600 hover:bg-blue-50"
                        >Retry scan</button>
                      )}
                      <button
                        onClick={() => { setDeleteConfirm({ id: s.id, status: s.status }); setOpenMenu(null) }}
                        className="w-full px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
                      >Delete</button>
                    </div>
                  )}
                </div>
              </div>

              {/* Mobile card */}
              <div
                className={`sm:hidden flex items-stretch border-b border-gray-100 transition-colors ${
                  s.status === 'PROCESSING' || s.status === 'ERROR'
                    ? 'opacity-70 cursor-default bg-white'
                    : isSelected ? 'bg-blue-50 cursor-pointer' : s.status === 'REVIEW' ? 'bg-amber-50 cursor-pointer' : 'bg-white cursor-pointer'
                }`}
                onClick={() => {
                  if (s.status !== 'PROCESSING' && s.status !== 'ERROR') onSelect(s.id)
                }}
              >
                <div className="flex items-center pl-3 pr-1 shrink-0"
                  onClick={e => { e.stopPropagation(); toggleOne(s.id) }}>
                  <Checkbox checked={isSelected} onChange={() => toggleOne(s.id)} />
                </div>
                <div className="flex-1 min-w-0 px-3 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1 min-w-0">
                      <p className="text-sm font-semibold text-gray-900 truncate">
                        {s.supplierName ?? 'Unknown supplier'}
                      </p>
                      {s.parentSessionId && (
                        <span className="text-[9px] font-bold bg-purple-100 text-purple-600 px-1 py-0.5 rounded shrink-0">COPY</span>
                      )}
                    </div>
                    <StatusBadge status={s.status} />
                  </div>
                  <div className="flex items-center gap-3 mt-0.5">
                    <p className="text-xs text-gray-500">{s.total ? formatCurrency(Number(s.total)) : '—'}</p>
                    <p className="text-xs text-gray-400">{s.invoiceDate ?? '—'}</p>
                    {s._count.priceAlerts > 0 && (
                      <p className="text-[10px] text-amber-600">
                        ⚠ {s._count.priceAlerts} alert{s._count.priceAlerts !== 1 ? 's' : ''}
                      </p>
                    )}
                  </div>
                </div>
                <div className="relative flex items-center pr-2 shrink-0" onClick={e => e.stopPropagation()}>
                  <button
                    onClick={() => setOpenMenu(openMenu === s.id ? null : s.id)}
                    className="w-8 h-8 flex items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 text-base leading-none"
                  >⋯</button>
                  {openMenu === s.id && (
                    <div className="absolute right-0 top-9 z-10 bg-white border border-gray-200 rounded-lg shadow-lg py-1 min-w-[120px]">
                      {s.status === 'ERROR' && (
                        <button
                          onClick={() => { onRetry(s.id); setOpenMenu(null) }}
                          className="w-full px-3 py-2 text-left text-sm text-blue-600 hover:bg-blue-50"
                        >Retry scan</button>
                      )}
                      <button
                        onClick={() => { setDeleteConfirm({ id: s.id, status: s.status }); setOpenMenu(null) }}
                        className="w-full px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
                      >Delete</button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* ── Single delete confirmation modal ── */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setDeleteConfirm(null)}>
          <div className="bg-white rounded-2xl p-6 max-w-sm w-full mx-4 shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-bold text-gray-900 mb-2">Delete invoice?</h3>
            <p className="text-sm text-gray-500 mb-4">
              {deleteConfirm.status === 'APPROVED'
                ? 'This will remove the approved invoice and reverse its price updates.'
                : 'This will permanently delete the invoice session.'}
            </p>
            <div className="flex gap-2">
              <button onClick={() => setDeleteConfirm(null)}
                className="flex-1 px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50">
                Cancel
              </button>
              <button onClick={() => handleDelete(deleteConfirm.id, deleteConfirm.status)} disabled={isDeleting}
                className="flex-1 px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-semibold hover:bg-red-700 disabled:opacity-50">
                {isDeleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Bulk delete confirmation modal ── */}
      {bulkDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setBulkDeleteConfirm(false)}>
          <div className="bg-white rounded-2xl p-6 max-w-sm w-full mx-4 shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center shrink-0">
                <Trash2 size={18} className="text-red-600" />
              </div>
              <div>
                <h3 className="text-base font-bold text-gray-900">
                  Delete {selectedInView.length} invoice{selectedInView.length !== 1 ? 's' : ''}?
                </h3>
                <p className="text-xs text-gray-400 mt-0.5">This cannot be undone.</p>
              </div>
            </div>
            {hasApproved && (
              <div className="bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 text-xs text-amber-700 mb-4">
                <strong>{selectedInView.filter(s => s.status === 'APPROVED').length} approved</strong> invoice{selectedInView.filter(s => s.status === 'APPROVED').length !== 1 ? 's are' : ' is'} selected — their price updates will be reversed.
              </div>
            )}
            {!hasApproved && (
              <p className="text-sm text-gray-500 mb-4">All selected invoice sessions will be permanently deleted.</p>
            )}
            <div className="flex gap-2">
              <button onClick={() => setBulkDeleteConfirm(false)}
                className="flex-1 px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50">
                Cancel
              </button>
              <button onClick={handleBulkDelete} disabled={isBulkDeleting}
                className="flex-1 px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-semibold hover:bg-red-700 disabled:opacity-50">
                {isBulkDeleting ? 'Deleting…' : `Delete ${selectedInView.length}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
