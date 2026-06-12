'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRc } from '@/contexts/RevenueCenterContext'
import { AlertsBell } from '@/components/AlertsBell'
import { RcSelector } from '@/components/navigation/RcSelector'
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

export function CostChrome({ onSpine = true, desktopOnly = false }: { onSpine?: boolean; desktopOnly?: boolean }) {
  const { activeRcId } = useRc()
  const [data, setData] = useState<ChromeData | null>(null)
  const [loading, setLoading] = useState(true)
  const [auditOpen, setAuditOpen] = useState(false)

  useEffect(() => {
    if (!onSpine) return // off-spine routes show only the brand shell — no live KPIs
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
  }, [activeRcId, onSpine])

  const fcPct = data?.foodCostPct ?? null
  const fcClass = fcPct === null
    ? ''
    : fcPct < (data?.targetPct ?? 27)
      ? 'text-[#86efac]'
      : fcPct < (data?.targetPct ?? 27) + 2
        ? 'text-[#fcd34d]'
        : 'text-[#fca5a5]'

  const v7d = data?.variance7d ?? null

  return (
    <div className={`${(onSpine && !desktopOnly) ? 'flex' : 'hidden'} md:flex md:fixed md:top-0 md:inset-x-0 md:z-50 md:h-11 bg-ink text-paper px-4 md:px-8 py-[10px] md:py-0 items-center gap-4 md:gap-6 border-b border-ink overflow-x-auto md:overflow-visible`}>
      {/* Brand — detached from the collapsible nav so it stays pinned in the top bar (desktop) */}
      <Link
        href="/"
        className="hidden md:flex items-center gap-[9px] text-[13px] font-semibold tracking-[-0.02em] text-paper shrink-0 hover:opacity-80 transition-opacity"
      >
        <span className="relative inline-block w-[18px] h-[18px] rounded-[5px] bg-paper">
          <span className="absolute inset-[3px] rounded-[2px] bg-gold" />
        </span>
        Controla OS
      </Link>

      {/* Active revenue center — always visible (desktop) next to the brand */}
      <div className="hidden md:flex items-center">
        <RcSelector compact />
      </div>

      {onSpine && (
        <>
          <div className="hidden md:block w-px h-[14px] bg-ink-2" />
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
            valueClass={v7d !== null && v7d > 0 ? 'text-[#fca5a5]' : v7d !== null && v7d < 0 ? 'text-[#86efac]' : ''}
          />
          <CCDivider />
          <CCItem
            label="Theoretical on hand"
            value={loading ? '…' : fmtMoney(data?.onHand ?? null)}
          />
        </>
      )}

      <div className="hidden md:block flex-1" />

      {onSpine && (
        <span className="hidden md:inline-block font-mono text-[10.5px] text-ink-3 min-w-0 max-w-[320px] overflow-hidden text-ellipsis whitespace-nowrap">
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
      )}
      {/* Alerts bell — detached from the collapsible nav, pinned in the top bar (desktop) */}
      <div className="hidden md:block shrink-0 [&>div>button]:text-ink-4 [&>div>button]:p-1.5 [&>div>button:hover]:text-white [&>div>button:hover]:bg-white/10">
        <AlertsBell dropdownAlign="right" />
      </div>
      <SpineAuditDrawer open={auditOpen} onClose={() => setAuditOpen(false)} />
    </div>
  )
}

function CCItem({ label, value, valueClass = '' }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex items-baseline gap-2 shrink-0">
      <span className="font-mono text-[10px] text-ink-3 uppercase tracking-[0.02em] whitespace-nowrap">{label}</span>
      <span className={`font-mono text-[14px] font-semibold tracking-[-0.01em] ${valueClass || 'text-paper'}`}>
        {value}
      </span>
    </div>
  )
}

function CCDivider() {
  return <div className="w-px h-[14px] bg-ink-2" />
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
