'use client'
import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { AlertTriangle, Check, ExternalLink } from 'lucide-react'
import { InboxSubNav } from '@/components/invoices/InboxSubNav'
import { PageHead } from '@/components/layout/PageHead'
import { formatCurrency } from '@/lib/utils'

interface PriceAlert {
  id: string
  inventoryItemId: string
  previousPrice: string | number | null
  newPrice: string | number | null
  changePct: string | number | null
  createdAt: string
  acknowledged: boolean
  inventoryItem: { id: string; itemName: string; purchaseUnit: string | null; baseUnit: string | null; pricePerBaseUnit: string | number | null }
  session: { id: string; supplierName: string | null; invoiceDate: string | null }
}

interface RecipeAlert {
  id: string
  newFoodCostPct: string | number | null
  createdAt: string
  acknowledged: boolean
  recipe: { id: string; name: string; menuPrice: number | null }
  session: { id: string; supplierName: string | null }
}

interface AlertsData {
  priceAlerts: PriceAlert[]
  recipeAlerts: RecipeAlert[]
  totalUnread: number
}

export default function PriceAlertsPage() {
  const [data, setData] = useState<AlertsData | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const json: AlertsData = await fetch('/api/invoices/alerts', { cache: 'no-store' }).then(r => r.json())
      setData(json)
    } catch {}
  }, [])

  useEffect(() => { load() }, [load])

  const ackOne = async (kind: 'price' | 'recipe', id: string) => {
    setBusyId(id)
    try {
      await fetch('/api/invoices/alerts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(kind === 'price' ? { priceAlertIds: [id] } : { recipeAlertIds: [id] }),
      })
      await load()
    } finally { setBusyId(null) }
  }

  const ackAll = async () => {
    setBusyId('all')
    try {
      await fetch('/api/invoices/alerts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acknowledgeAll: true }),
      })
      await load()
    } finally { setBusyId(null) }
  }

  const priceAlerts  = data?.priceAlerts  ?? []
  const recipeAlerts = data?.recipeAlerts ?? []
  const total = priceAlerts.length + recipeAlerts.length

  return (
    <>
      <InboxSubNav />
      <div className="p-4 md:p-6 md:px-8 max-w-7xl mx-auto w-full">
        <PageHead
          crumbs={<span>INBOX / PRICE ALERTS</span>}
          title="Price alerts"
          sub={<>Ingredients whose <b>purchase price</b> moved ≥15% on approval — this re-costs every recipe that uses them.</>}
          actions={
            total > 0 ? (
              <button onClick={ackAll} disabled={busyId === 'all'}
                className="inline-flex items-center gap-1.5 bg-ink text-paper px-4 py-[9px] rounded-[9px] text-[13px] font-medium hover:bg-[#18181b] disabled:opacity-50 transition-colors">
                <Check size={13} className="text-gold" /> Acknowledge all
              </button>
            ) : null
          }
        />

        {total === 0 ? (
          <div className="bg-paper border border-line rounded-[12px] p-12 text-center">
            <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-green-text">All clear</p>
            <p className="text-[14px] text-ink-2 mt-2">No active price alerts. Your spine is calm.</p>
          </div>
        ) : (
          <div className="space-y-5">
            {priceAlerts.length > 0 && (
              <section>
                <h2 className="font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3 mb-2">Ingredient price spikes · {priceAlerts.length}</h2>
                <div className="bg-paper border border-line rounded-[12px] overflow-hidden">
                  {priceAlerts.map(a => {
                    const prevRaw = a.previousPrice != null ? Number(a.previousPrice) : null
                    const curRaw  = a.newPrice != null ? Number(a.newPrice) : null
                    const old = prevRaw !== null && Number.isFinite(prevRaw) && prevRaw > 0 ? prevRaw : null
                    const cur = curRaw  !== null && Number.isFinite(curRaw) ? curRaw : null
                    // Derive % from the two prices shown so the badge always matches
                    // the numbers; fall back to the stored changePct only if we can't.
                    const stored = a.changePct != null && Number.isFinite(Number(a.changePct)) ? Number(a.changePct) : null
                    const pct = old !== null && cur !== null ? ((cur - old) / old) * 100 : stored
                    const unit = a.inventoryItem.purchaseUnit || 'unit'
                    return (
                      <div key={a.id} className="grid grid-cols-[36px_1.4fr_1.2fr_1fr_auto] items-center gap-3 px-[18px] py-3.5 border-b border-line last:border-0">
                        <div className="w-9 h-9 rounded-[9px] bg-red-soft text-red-text grid place-items-center shrink-0">
                          <AlertTriangle size={15} />
                        </div>
                        <div className="min-w-0">
                          <Link href={`/inventory?highlight=${a.inventoryItem.id}`}
                            className="text-[14px] font-medium text-ink tracking-[-0.01em] hover:text-gold-2 inline-flex items-center gap-1">
                            {a.inventoryItem.itemName} <ExternalLink size={11} className="text-ink-4" />
                          </Link>
                          <div className="font-mono text-[10.5px] text-ink-3 mt-0.5">
                            {a.session.supplierName ?? '—'} · {fmtDate(a.session.invoiceDate ?? a.createdAt)}
                          </div>
                        </div>
                        <div className="min-w-0">
                          <div className="font-mono text-[12px] text-ink-3">
                            {old !== null ? formatCurrency(old) : <span className="text-ink-4">new</span>} <span className="text-ink-4">→</span>{' '}
                            <span className="text-ink font-medium">{cur !== null ? formatCurrency(cur) : '—'}</span>
                          </div>
                          <div className="font-mono text-[10px] text-ink-4 uppercase tracking-[0.02em] mt-0.5">
                            purchase price · per {unit}
                          </div>
                        </div>
                        <div className={`font-mono text-[13px] font-semibold tabular-nums ${pct !== null && pct > 0 ? 'text-red-text' : pct !== null && pct < 0 ? 'text-green-text' : 'text-ink-3'}`}>
                          {pct !== null ? (pct > 0 ? '+' : '') + pct.toFixed(1) + '%' : '—'}
                        </div>
                        <button onClick={() => ackOne('price', a.id)} disabled={busyId === a.id}
                          className="font-mono text-[11px] px-3 py-1.5 rounded-full bg-bg-2 text-ink-2 border border-line hover:border-ink-3 disabled:opacity-50 transition-colors">
                          {busyId === a.id ? '…' : 'Ack'}
                        </button>
                      </div>
                    )
                  })}
                </div>
              </section>
            )}

            {recipeAlerts.length > 0 && (
              <section>
                <h2 className="font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3 mb-2">Recipe drift · {recipeAlerts.length}</h2>
                <div className="bg-paper border border-line rounded-[12px] overflow-hidden">
                  {recipeAlerts.map(a => {
                    const fcPct = a.newFoodCostPct !== null ? Number(a.newFoodCostPct) : null
                    const overTarget = fcPct !== null && fcPct > 28
                    return (
                      <div key={a.id} className="grid grid-cols-[36px_1.4fr_1fr_auto] items-center gap-3 px-[18px] py-3.5 border-b border-line last:border-0">
                        <div className="w-9 h-9 rounded-[9px] bg-gold-soft text-gold-2 grid place-items-center shrink-0">
                          <AlertTriangle size={15} />
                        </div>
                        <div className="min-w-0">
                          <Link href={`/menu?highlight=${a.recipe.id}`}
                            className="text-[14px] font-medium text-ink tracking-[-0.01em] hover:text-gold-2 inline-flex items-center gap-1">
                            {a.recipe.name} <ExternalLink size={11} className="text-ink-4" />
                          </Link>
                          <div className="font-mono text-[10.5px] text-ink-3 mt-0.5">
                            triggered by {a.session.supplierName ?? '—'} · {fmtDate(a.createdAt)}
                          </div>
                        </div>
                        <div className={`font-mono text-[13px] font-semibold tabular-nums ${overTarget ? 'text-red-text' : 'text-ink-2'}`}>
                          {fcPct !== null ? fcPct.toFixed(1) + '%' : '—'} food cost
                        </div>
                        <button onClick={() => ackOne('recipe', a.id)} disabled={busyId === a.id}
                          className="font-mono text-[11px] px-3 py-1.5 rounded-full bg-bg-2 text-ink-2 border border-line hover:border-ink-3 disabled:opacity-50 transition-colors">
                          {busyId === a.id ? '…' : 'Ack'}
                        </button>
                      </div>
                    )
                  })}
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
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
