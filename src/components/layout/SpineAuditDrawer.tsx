'use client'
import { useEffect, useState } from 'react'
import { X, ExternalLink, AlertCircle, Clock } from 'lucide-react'
import Link from 'next/link'

interface SpineAuditData {
  summary: {
    totalItems: number
    totalValue: number
    zeroPriceCount: number
    staleCount: number
  }
  topItems: Array<{
    id: string
    name: string
    category: string
    baseUnit: string
    pricePerBaseUnit: number
    stockOnHand: number
    inventoryValue: number
    supplier: string | null
    lastUpdated: string | null
  }>
  recentInvoices: Array<{
    id: string
    supplier: string | null
    invoiceNumber: string | null
    approvedAt: string | null
    total: number | null
    lineCount: number
  }>
  recentPrepSyncs: Array<{
    id: string
    itemName: string
    recipeId: string | null
    recipeName: string | null
    pricePerBaseUnit: number
    lastUpdated: string | null
  }>
}

interface SpineAuditDrawerProps {
  open: boolean
  onClose: () => void
}

export function SpineAuditDrawer({ open, onClose }: SpineAuditDrawerProps) {
  const [data, setData] = useState<SpineAuditData | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    fetch('/api/insights/spine-audit', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(json => { if (json) setData(json) })
      .finally(() => setLoading(false))
  }, [open])

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[80] flex">
      <div className="flex-1 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <aside className="w-full max-w-[100vw] md:w-[640px] bg-paper h-full overflow-y-auto overflow-x-hidden flex flex-col shadow-2xl">
        <header className="sticky top-0 bg-paper z-10 border-b border-line px-6 py-4 flex items-center gap-3">
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-[8px] border border-line flex items-center justify-center text-ink-2 hover:border-ink-3 transition-colors"
          >
            <X size={16} />
          </button>
          <div className="flex-1 min-w-0">
            <div className="font-mono text-[10.5px] text-ink-3 uppercase tracking-[0.04em]">Spine audit</div>
            <h2 className="text-[18px] font-semibold tracking-[-0.02em] text-ink leading-tight">
              <span className="font-mono text-gold-2">pricePerBaseUnit</span> — provenance
            </h2>
          </div>
        </header>

        {loading && !data ? (
          <div className="flex-1 flex items-center justify-center text-ink-3 font-mono text-[11px]">Loading…</div>
        ) : !data ? (
          <div className="flex-1 flex items-center justify-center text-ink-3 font-mono text-[11px]">Failed to load</div>
        ) : (
          <div className="flex-1 px-6 py-5 space-y-6">
            {/* Summary */}
            <section className="grid grid-cols-2 gap-3">
              <SummaryCard label="Total inventory value" value={fmtMoney(data.summary.totalValue)} />
              <SummaryCard label="Active items" value={data.summary.totalItems.toString()} />
              <SummaryCard
                label="Zero-price items"
                value={data.summary.zeroPriceCount.toString()}
                tint={data.summary.zeroPriceCount > 0 ? 'warn' : 'neutral'}
                hint={data.summary.zeroPriceCount > 0 ? 'need pricing' : 'all priced'}
              />
              <SummaryCard
                label="Stale prices (>30d)"
                value={data.summary.staleCount.toString()}
                tint={data.summary.staleCount > 0 ? 'warn' : 'neutral'}
                hint={data.summary.staleCount > 0 ? 'consider recount' : 'fresh'}
              />
            </section>

            {/* Top items */}
            <section>
              <SectionHead label="Top items by value">
                Driving <b className="text-ink">{Math.round((sumTop(data.topItems) / Math.max(1, data.summary.totalValue)) * 100)}%</b> of on-hand
              </SectionHead>
              <div className="border border-line rounded-[10px] overflow-hidden bg-paper">
                {data.topItems.map(it => (
                  <Link
                    key={it.id}
                    href={`/inventory?highlight=${it.id}`}
                    onClick={onClose}
                    className="grid grid-cols-[1fr_auto_auto] gap-3 items-center px-4 py-2.5 border-b border-line last:border-0 hover:bg-bg-2/60 transition-colors"
                  >
                    <div className="min-w-0">
                      <div className="text-[13px] text-ink font-medium truncate">{it.name}</div>
                      <div className="font-mono text-[10.5px] text-ink-3">{it.category}{it.supplier ? ` · ${it.supplier}` : ''}</div>
                    </div>
                    <div className="font-mono text-[11px] text-ink-3 text-right whitespace-nowrap">
                      {it.stockOnHand.toFixed(1)} {it.baseUnit} × {fmtMoney(it.pricePerBaseUnit, true)}
                    </div>
                    <div className="font-mono text-[13px] text-ink font-medium tracking-[-0.01em] text-right tabular-nums w-20">
                      {fmtMoney(it.inventoryValue)}
                    </div>
                  </Link>
                ))}
                {data.topItems.length === 0 && <Empty>No items yet — import inventory to populate the spine.</Empty>}
              </div>
            </section>

            {/* Recent invoice approvals */}
            <section>
              <SectionHead label="Recent invoice approvals">
                Each approval writes <span className="font-mono text-gold-2">pricePerBaseUnit</span> for matched lines
              </SectionHead>
              <div className="border border-line rounded-[10px] overflow-hidden bg-paper">
                {data.recentInvoices.map(inv => (
                  <Link
                    key={inv.id}
                    href={`/invoices/${inv.id}`}
                    onClick={onClose}
                    className="grid grid-cols-[1fr_auto_auto] gap-3 items-center px-4 py-2.5 border-b border-line last:border-0 hover:bg-bg-2/60 transition-colors"
                  >
                    <div className="min-w-0">
                      <div className="text-[13px] text-ink font-medium truncate flex items-center gap-1.5">
                        {inv.supplier ?? 'Unknown supplier'} <ExternalLink size={11} className="text-ink-4" />
                      </div>
                      <div className="font-mono text-[10.5px] text-ink-3">
                        {inv.invoiceNumber ?? '—'} · {inv.lineCount} lines · {humanizeAge(inv.approvedAt)}
                      </div>
                    </div>
                    <div className="font-mono text-[13px] text-ink font-medium tabular-nums">
                      {inv.total !== null ? fmtMoney(inv.total) : '—'}
                    </div>
                  </Link>
                ))}
                {data.recentInvoices.length === 0 && <Empty>No approved invoices yet.</Empty>}
              </div>
            </section>

            {/* PREP syncs */}
            <section>
              <SectionHead label="Recent PREP syncs">
                Recipes that re-cost themselves into the spine via <span className="font-mono text-gold-2">syncPrepToInventory</span>
              </SectionHead>
              <div className="border border-line rounded-[10px] overflow-hidden bg-paper">
                {data.recentPrepSyncs.map(p => (
                  <div
                    key={p.id}
                    className="grid grid-cols-[1fr_auto] gap-3 items-center px-4 py-2.5 border-b border-line last:border-0"
                  >
                    <div className="min-w-0">
                      <div className="text-[13px] text-ink font-medium truncate">{p.itemName}</div>
                      <div className="font-mono text-[10.5px] text-ink-3">
                        from {p.recipeName ?? '—'} · {humanizeAge(p.lastUpdated)}
                      </div>
                    </div>
                    <div className="font-mono text-[13px] text-ink font-medium tabular-nums">
                      {fmtMoney(p.pricePerBaseUnit, true)} / unit
                    </div>
                  </div>
                ))}
                {data.recentPrepSyncs.length === 0 && <Empty>No PREP recipes linked to inventory yet.</Empty>}
              </div>
            </section>

            <p className="font-mono text-[10.5px] text-ink-3 pt-2 border-t border-line">
              The spine is a single Decimal column on InventoryItem.
              Read by recipes, menu, prep, count, sales, variance, cost-chrome.
              Written only by: invoice approve, syncPrepToInventory, manual override, inventory-import, repair-prices.
            </p>
          </div>
        )}
      </aside>
    </div>
  )
}

function SummaryCard({ label, value, tint = 'neutral', hint }: {
  label: string; value: string; tint?: 'neutral' | 'warn'; hint?: string
}) {
  const tintCls = tint === 'warn' ? 'bg-gold-soft border-[#fcd34d] text-gold-2' : 'bg-bg-2 border-line text-ink'
  return (
    <div className={`border rounded-[10px] p-3 ${tintCls}`}>
      <div className="font-mono text-[9.5px] uppercase tracking-[0.04em] opacity-70">{label}</div>
      <div className={`font-mono text-[18px] font-semibold tracking-[-0.02em] mt-1 ${tint === 'warn' ? 'text-gold-2' : 'text-ink'}`}>{value}</div>
      {hint && <div className="font-mono text-[10px] opacity-70 mt-0.5">{hint}</div>}
    </div>
  )
}

function SectionHead({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between mb-2 px-1">
      <h3 className="text-[13px] font-semibold text-ink tracking-[-0.01em]">{label}</h3>
      <p className="font-mono text-[10.5px] text-ink-3 text-right [&_b]:text-ink [&_b]:font-medium">{children}</p>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-6 text-center font-mono text-[11px] text-ink-3">{children}</div>
}

function fmtMoney(n: number, fine = false): string {
  if (n === 0) return '$0'
  if (fine && n < 1) return '$' + n.toFixed(4)
  return '$' + Math.round(n).toLocaleString()
}

function humanizeAge(iso: string | null): string {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.round(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const h = Math.round(min / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}

function sumTop(items: SpineAuditData['topItems']): number {
  return items.reduce((s, it) => s + it.inventoryValue, 0)
}

// Re-export icons to suppress unused warnings (they're available for future enrichment)
export const _audit_icons = { AlertCircle, Clock }
