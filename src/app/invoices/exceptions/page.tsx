'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertCircle, Copy, ExternalLink } from 'lucide-react'
import { InboxSubNav } from '@/components/invoices/InboxSubNav'
import { PageHead } from '@/components/layout/PageHead'
import { formatCurrency } from '@/lib/utils'

interface UnmatchedRow {
  id: string
  rawItemName: string | null
  rawSize: string | null
  rawLineTotal: number | null
  createdAt: string
  session: { id: string; supplierName: string | null; invoiceNumber: string | null; invoiceDate: string | null }
}

interface DuplicateGroup {
  supplierName: string | null
  invoiceNumber: string | null
  invoiceDate: string | null
  sessions: Array<{ id: string; status: string; total: number | null; createdAt: string }>
}

interface ExceptionsData {
  unmatched: UnmatchedRow[]
  duplicates: DuplicateGroup[]
  totalCount: number
}

export default function ExceptionsPage() {
  const [data, setData] = useState<ExceptionsData | null>(null)

  useEffect(() => {
    fetch('/api/invoices/exceptions', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(json => json && setData(json))
  }, [])

  const unmatched = data?.unmatched ?? []
  const dupes = data?.duplicates ?? []

  return (
    <>
      <InboxSubNav />
      <div className="p-4 md:p-6 md:px-8 max-w-7xl mx-auto w-full">
        <PageHead
          crumbs={<span>INBOX / EXCEPTIONS</span>}
          title="Exceptions"
          sub={<>Invoice lines the matcher couldn&apos;t resolve, and duplicate invoices waiting for cleanup.</>}
        />

        {unmatched.length + dupes.length === 0 ? (
          <div className="bg-paper border border-line rounded-[12px] p-12 text-center">
            <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-green-text">All clean</p>
            <p className="text-[14px] text-ink-2 mt-2">No unmatched lines or duplicate sessions. Inbox is empty.</p>
          </div>
        ) : (
          <div className="space-y-5">
            {unmatched.length > 0 && (
              <section>
                <h2 className="font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3 mb-2">
                  Unmatched OCR lines · {unmatched.length}
                </h2>
                <div className="bg-paper border border-line rounded-[12px] overflow-hidden">
                  {unmatched.map(u => (
                    <Link
                      key={u.id}
                      href={`/invoices?session=${u.session.id}`}
                      className="grid grid-cols-[36px_1.4fr_1fr_auto_auto] items-center gap-3 px-[18px] py-3 border-b border-line last:border-0 hover:bg-bg-2/40 transition-colors"
                    >
                      <div className="w-9 h-9 rounded-[9px] bg-gold-soft text-gold-2 grid place-items-center shrink-0">
                        <AlertCircle size={15} />
                      </div>
                      <div className="min-w-0">
                        <div className="text-[14px] font-medium text-ink tracking-[-0.01em] truncate">{u.rawItemName ?? '—'}</div>
                        <div className="font-mono text-[10.5px] text-ink-3 mt-0.5">
                          {u.session.supplierName ?? '—'} · {u.session.invoiceNumber ?? '—'} · {fmtDate(u.session.invoiceDate ?? u.createdAt)}
                        </div>
                      </div>
                      <div className="font-mono text-[12px] text-ink-3">{u.rawSize ?? '—'}</div>
                      <div className="font-mono text-[13px] text-ink font-medium tabular-nums">
                        {u.rawLineTotal !== null ? formatCurrency(u.rawLineTotal) : '—'}
                      </div>
                      <div className="font-mono text-[11px] text-gold-2 inline-flex items-center gap-1">
                        Match <ExternalLink size={11} />
                      </div>
                    </Link>
                  ))}
                </div>
              </section>
            )}

            {dupes.length > 0 && (
              <section>
                <h2 className="font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3 mb-2">
                  Duplicate invoices · {dupes.length} {dupes.length === 1 ? 'group' : 'groups'}
                </h2>
                <div className="bg-paper border border-line rounded-[12px] overflow-hidden">
                  {dupes.map((g, idx) => (
                    <div key={idx} className="px-[18px] py-3.5 border-b border-line last:border-0">
                      <div className="flex items-start gap-3">
                        <div className="w-9 h-9 rounded-[9px] bg-red-soft text-red-text grid place-items-center shrink-0">
                          <Copy size={15} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-[14px] font-medium text-ink tracking-[-0.01em]">
                            {g.supplierName ?? '—'} · invoice <span className="font-mono">{g.invoiceNumber ?? '—'}</span>
                          </div>
                          <div className="font-mono text-[10.5px] text-ink-3 mt-0.5">
                            {fmtDate(g.invoiceDate ?? '')} · {g.sessions.length} sessions found
                          </div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {g.sessions.map(s => (
                              <Link key={s.id} href={`/invoices?session=${s.id}`}
                                className="inline-flex items-center gap-1.5 font-mono text-[11px] bg-bg-2 border border-line text-ink-2 px-2 py-1 rounded-[7px] hover:border-ink-3 transition-colors">
                                {s.status} · {s.total !== null ? formatCurrency(s.total) : '—'} <ExternalLink size={10} />
                              </Link>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </>
  )
}

function fmtDate(d: string): string {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
