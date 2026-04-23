'use client'
import { useState } from 'react'
import { SessionSummary, SessionStatus } from './types'
import { formatCurrency } from '@/lib/utils'

type Tab = 'all' | 'REVIEW' | 'APPROVED' | 'REJECTED'

interface Props {
  sessions: SessionSummary[]
  activeRcId: string | null
  onSelect: (id: string) => void
  onUploadClick: () => void
  onDelete: (id: string, status: SessionStatus) => Promise<void>
}

function StatusBadge({ status }: { status: SessionStatus }) {
  if (status === 'REVIEW')
    return <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700">Review</span>
  if (status === 'APPROVED')
    return <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-green-100 text-green-700">Approved</span>
  if (status === 'REJECTED')
    return <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-100 text-red-600">Rejected</span>
  if (status === 'PROCESSING')
    return <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-100 text-blue-600">Processing</span>
  return <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-gray-100 text-gray-500">Uploading</span>
}

export function InvoiceList({ sessions, activeRcId, onSelect, onUploadClick, onDelete }: Props) {
  const [tab, setTab] = useState<Tab>('all')
  const [search, setSearch] = useState('')
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; status: SessionStatus } | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  const reviewCount = sessions.filter(s => s.status === 'REVIEW').length

  const filtered = sessions.filter(s => {
    if (tab !== 'all' && s.status !== tab) return false
    if (activeRcId && s.revenueCenterId && s.revenueCenterId !== activeRcId) return false
    if (search) {
      const q = search.toLowerCase()
      return (
        (s.supplierName?.toLowerCase().includes(q) ?? false) ||
        (s.invoiceNumber?.toLowerCase().includes(q) ?? false)
      )
    }
    return true
  })

  const handleDelete = async (id: string, status: SessionStatus) => {
    setIsDeleting(true)
    await onDelete(id, status)
    setIsDeleting(false)
    setDeleteConfirm(null)
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Toolbar — mobile: two rows; desktop: single row */}
      <div className="border-b border-gray-200 bg-white shrink-0">
        {/* Row 1: tabs + upload button */}
        <div className="flex items-center gap-2 px-3 pt-2 pb-1.5 sm:px-4 sm:py-2 sm:pb-2">
          <div className="flex gap-0.5 bg-gray-100 rounded-lg p-0.5 flex-1 sm:flex-none overflow-x-auto">
            {(['all', 'REVIEW', 'APPROVED', 'REJECTED'] as Tab[]).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all whitespace-nowrap ${
                  tab === t ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {t === 'all' ? 'All' : t === 'REVIEW' ? (
                  <span className="flex items-center gap-1">
                    Review
                    {reviewCount > 0 && (
                      <span className="bg-amber-100 text-amber-700 rounded-full px-1.5 text-[9px] font-bold">
                        {reviewCount}
                      </span>
                    )}
                  </span>
                ) : (
                  t.charAt(0) + t.slice(1).toLowerCase()
                )}
              </button>
            ))}
          </div>
          <button
            onClick={onUploadClick}
            className="bg-blue-600 text-white rounded-lg px-4 py-2 text-sm font-semibold hover:bg-blue-700 transition-colors shrink-0 sm:px-3 sm:py-1.5 sm:text-xs"
          >
            + Scan Invoice
          </button>
        </div>
        {/* Row 2 on mobile: search (full width). On desktop: search is inline in row 1 */}
        <div className="px-3 pb-2 sm:hidden">
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search supplier or invoice #…"
            className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        {/* Desktop-only search (hidden on mobile) */}
        <div className="hidden sm:block px-4 pb-2">
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search supplier or invoice #…"
            className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-1.5 text-xs text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      {/* Desktop column headers */}
      <div className="hidden sm:grid grid-cols-[1fr_90px_90px_60px_90px_32px] gap-2 px-4 py-1.5 bg-gray-50 border-b border-gray-200 shrink-0">
        {['Supplier / Invoice', 'Date', 'Total', 'Items', 'Status', ''].map((h, i) => (
          <div key={i} className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">{h}</div>
        ))}
      </div>

      {/* Rows */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="py-16 text-center text-sm text-gray-400">No invoices found</div>
        )}

        {filtered.map(s => (
          <div key={s.id}>
            {/* Desktop row */}
            <div
              className={`hidden sm:grid grid-cols-[1fr_90px_90px_60px_90px_32px] gap-2 px-4 py-2.5 border-b border-gray-100 items-center cursor-pointer hover:bg-gray-50 transition-colors ${
                s.status === 'REVIEW' ? 'bg-amber-50 hover:bg-amber-100' : ''
              }`}
              onClick={() => onSelect(s.id)}
            >
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
                    <button
                      onClick={() => { setDeleteConfirm({ id: s.id, status: s.status }); setOpenMenu(null) }}
                      className="w-full px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Mobile card */}
            <div
              className={`sm:hidden flex items-stretch border-b border-gray-100 cursor-pointer ${
                s.status === 'REVIEW' ? 'bg-amber-50' : 'bg-white'
              }`}
              onClick={() => onSelect(s.id)}
            >
              <div className="flex-1 min-w-0 px-4 py-3">
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
                  <p className="text-xs text-gray-500">
                    {s.total ? formatCurrency(Number(s.total)) : '—'}
                  </p>
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
                    <button
                      onClick={() => { setDeleteConfirm({ id: s.id, status: s.status }); setOpenMenu(null) }}
                      className="w-full px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Delete confirmation modal */}
      {deleteConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setDeleteConfirm(null)}
        >
          <div
            className="bg-white rounded-2xl p-6 max-w-sm w-full mx-4 shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-base font-bold text-gray-900 mb-2">Delete invoice?</h3>
            <p className="text-sm text-gray-500 mb-4">
              {deleteConfirm.status === 'APPROVED'
                ? 'This will remove the approved invoice and reverse its price updates.'
                : 'This will permanently delete the invoice session.'}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="flex-1 px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(deleteConfirm.id, deleteConfirm.status)}
                disabled={isDeleting}
                className="flex-1 px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-semibold hover:bg-red-700 disabled:opacity-50"
              >
                {isDeleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
