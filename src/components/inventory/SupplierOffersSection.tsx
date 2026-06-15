'use client'
// Suppliers section for the inventory item drawer: one row per supplier offer
// with their pack, SKU, normalized $/base-unit, stability, and a primary star.
// Data: GET /api/inventory/[id]/suppliers (see src/lib/supplier-offers.ts).

import { useEffect, useState, useCallback } from 'react'
import { Star } from 'lucide-react'
import { formatCurrency, formatPricePerBase } from '@/lib/utils'
import type { SupplierOfferStats } from '@/lib/supplier-offers'

const STABILITY_BADGE: Record<NonNullable<SupplierOfferStats['stability']>, { label: string; cls: string }> = {
  stable:   { label: 'Stable',   cls: 'bg-green-soft text-green-text' },
  variable: { label: 'Variable', cls: 'bg-gold-soft text-gold-2' },
  volatile: { label: 'Volatile', cls: 'bg-red-soft text-red-text' },
}

function fmtPack(o: SupplierOfferStats): string {
  if (o.packQty != null && o.packSize != null && o.packUOM) return `${o.packQty} × ${o.packSize}${o.packUOM}`
  return '—'
}

// $/base shown per kg/L for weight/volume bases so the numbers are readable.
const fmtPpb = formatPricePerBase

export function SupplierOffersSection({ itemId, baseUnit }: { itemId: string; baseUnit: string | null }) {
  const [offers, setOffers] = useState<SupplierOfferStats[] | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    fetch(`/api/inventory/${itemId}/suppliers`)
      .then(r => (r.ok ? r.json() : []))
      .then(setOffers)
      .catch(() => setOffers([]))
  }, [itemId])

  useEffect(() => { load() }, [load])

  const setPrimary = async (offerId: string) => {
    setSaving(true)
    await fetch(`/api/inventory/${itemId}/suppliers`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offerId }),
    }).catch(() => {})
    setSaving(false)
    load()
  }

  if (!offers || offers.length === 0) return null
  const cheapest = Math.min(...offers.map(o => o.pricePerBaseUnit).filter(p => p > 0))

  return (
    <div className="space-y-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-4 font-semibold">
        Suppliers · {offers.length}
      </div>
      <div className="border border-line rounded-lg divide-y divide-line overflow-hidden">
        {offers.map(o => {
          const isCheapest = offers.length > 1 && o.pricePerBaseUnit > 0 && o.pricePerBaseUnit === cheapest
          const badge = o.stability ? STABILITY_BADGE[o.stability] : null
          return (
            <div key={o.id} className={`flex items-center gap-3 px-3 py-2.5 ${isCheapest ? 'bg-green-soft/40' : 'bg-paper'}`}>
              <button
                type="button"
                disabled={saving}
                onClick={() => setPrimary(o.id)}
                title={o.isPrimary ? 'Primary supplier' : 'Set as primary'}
                className="shrink-0 p-1"
              >
                <Star size={14} className={o.isPrimary ? 'text-gold fill-gold' : 'text-line-2 hover:text-gold'} />
              </button>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium text-ink truncate">{o.supplierName}</div>
                <div className="font-mono text-[10.5px] text-ink-4 mt-0.5">
                  {fmtPack(o)}{o.supplierItemCode ? ` · #${o.supplierItemCode}` : ''} · last {new Date(o.lastUpdated).toLocaleDateString('en-CA')}
                </div>
              </div>
              {badge && (
                <span className={`font-mono text-[9.5px] font-semibold uppercase px-2 py-[3px] rounded-full shrink-0 ${badge.cls}`}>
                  {badge.label}{o.volatility !== null ? ` ±${Math.round(o.volatility * 100)}%` : ''}
                </span>
              )}
              <div className="text-right shrink-0">
                <div className="font-mono text-[13px] font-semibold text-ink tabular-nums">
                  {fmtPpb(o.pricePerBaseUnit, baseUnit)}
                </div>
                <div className="font-mono text-[10.5px] text-ink-4">{formatCurrency(o.lastPrice)}/case{isCheapest ? ' · cheapest' : ''}</div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
