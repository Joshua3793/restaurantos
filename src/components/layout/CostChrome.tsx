'use client'
import { useEffect, useState } from 'react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { SpineAuditDrawer } from './SpineAuditDrawer'

/**
 * Dark live food-cost % strip — Principle 01 of Controla OS.
 * Fetches /api/insights/cost-chrome every 60s; refetches on RC change.
 * Phase 3 will add the click-through audit drawer.
 */

interface ChromeData {
  foodCostPct: number | null
  targetPct: number
  variance7d: number | null
  onHand: number
  lastInvoiceAt: string | null
  lastInvoiceSupplier: string | null
  sourceItemCount: number
}

export function CostChrome() {
  const { activeRcId } = useRc()
  const [data, setData] = useState<ChromeData | null>(null)
  const [loading, setLoading] = useState(true)
  const [auditOpen, setAuditOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    const fetchData = async () => {
      try {
        const qs = activeRcId ? `?rcId=${activeRcId}` : ''
        const res = await fetch(`/api/insights/cost-chrome${qs}`, { cache: 'no-store' })
        if (!res.ok) return
        const json = await res.json()
        if (!cancelled) { setData(json); setLoading(false) }
      } catch { /* swallow — strip stays in last-known state */ }
    }
    fetchData()
    const i = setInterval(fetchData, 60_000)
    return () => { cancelled = true; clearInterval(i) }
  }, [activeRcId])

  const fcPct = data?.foodCostPct ?? null
  const fcClass = fcPct === null
    ? ''
    : fcPct < (data?.targetPct ?? 27)
      ? 'text-green-400'
      : fcPct < (data?.targetPct ?? 27) + 2
        ? 'text-amber-300'
        : 'text-red-300'

  const v7d = data?.variance7d ?? null

  return (
    <div className="hidden md:flex bg-ink text-paper px-8 py-[10px] items-center gap-6 border-b border-ink">
      <CCItem
        label="Food cost · live"
        value={loading ? '…' : fmtPct(fcPct)}
        valueClass={fcClass}
      />
      <CCDivider />
      <CCItem
        label="Target"
        value={loading ? '…' : fmtPct(data?.targetPct ?? null)}
      />
      <CCDivider />
      <CCItem
        label="7d variance"
        value={loading ? '…' : fmtMoneySigned(v7d)}
        valueClass={v7d !== null && v7d > 0 ? 'text-red-300' : v7d !== null && v7d < 0 ? 'text-green-400' : ''}
      />
      <CCDivider />
      <CCItem
        label="On hand"
        value={loading ? '…' : fmtMoney(data?.onHand ?? null)}
      />
      <div className="flex-1" />
      <span className="font-mono text-[10.5px] text-zinc-500">
        computed from{' '}
        <button
          onClick={() => setAuditOpen(true)}
          className="text-gold border-b border-dashed border-gold/60 hover:text-gold/80 transition-colors"
          title={data ? `${data.sourceItemCount} inventory items — click for audit` : 'pricePerBaseUnit spine'}
        >
          pricePerBaseUnit
        </button>
        {data?.lastInvoiceAt && (
          <> · last invoice {humanizeAge(data.lastInvoiceAt)}</>
        )}
      </span>
      <SpineAuditDrawer open={auditOpen} onClose={() => setAuditOpen(false)} />
    </div>
  )
}

function CCItem({ label, value, valueClass = '' }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="font-mono text-[10px] text-zinc-500 uppercase tracking-[0.02em]">{label}</span>
      <span className={`font-mono text-[14px] font-semibold tracking-[-0.01em] ${valueClass || 'text-paper'}`}>
        {value}
      </span>
    </div>
  )
}

function CCDivider() {
  return <div className="w-px h-[14px] bg-zinc-800" />
}

// ── Formatters ──────────────────────────────────────────────────────────────

function fmtPct(n: number | null): string {
  if (n === null || Number.isNaN(n)) return '—'
  return `${n.toFixed(1)}%`
}

function fmtMoney(n: number | null): string {
  if (n === null || Number.isNaN(n)) return '—'
  return '$' + Math.round(n).toLocaleString()
}

function fmtMoneySigned(n: number | null): string {
  if (n === null || Number.isNaN(n)) return '—'
  if (n === 0) return '$0'
  const sign = n > 0 ? '+' : '−'
  return `${sign}$${Math.round(Math.abs(n)).toLocaleString()}`
}

function humanizeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.round(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const h = Math.round(min / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}
