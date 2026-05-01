'use client'
import { ChevronUp, ChevronDown, Minus } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'

export const CAT_COLORS: Record<string, string> = {
  MEAT: '#ef4444', FISH: '#06b6d4', DAIRY: '#3b82f6', PROD: '#22c55e',
  DRY: '#eab308', BREAD: '#f97316', PREPD: '#8b5cf6', CHM: '#94a3b8',
}

export const CHART_COLORS = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#f97316','#ec4899']

export function pct(n: number | null | undefined, decimals = 1) {
  if (n == null) return '—'
  return `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`
}

export function DeltaBadge({ change, inverse = false }: { change: number | null; inverse?: boolean }) {
  if (change === null) return <span className="text-xs text-gray-400">vs prev</span>
  const good = inverse ? change < 0 : change > 0
  const Icon = change > 0 ? ChevronUp : change < 0 ? ChevronDown : Minus
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${good ? 'text-green-600' : change === 0 ? 'text-gray-400' : 'text-red-500'}`}>
      <Icon size={11} />
      {Math.abs(change).toFixed(1)}%
    </span>
  )
}

export function KpiCard({ label, value, sub, change, inverse = false, accent = 'blue', icon: Icon }:
  { label: string; value: string; sub?: string; change?: number | null; inverse?: boolean; accent?: string; icon?: React.ElementType }) {
  const accentMap: Record<string, string> = {
    blue: 'text-gold', green: 'text-green-600', amber: 'text-amber-500',
    red: 'text-red-500', purple: 'text-purple-600', gray: 'text-gray-600',
  }
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className="text-[11px] font-semibold text-gray-400 tracking-wide uppercase leading-tight">{label}</span>
        {Icon && <Icon size={16} className={accentMap[accent] ?? 'text-gray-400'} />}
      </div>
      <div className={`text-2xl font-bold ${accentMap[accent] ?? 'text-gray-800'}`}>{value}</div>
      <div className="flex items-center justify-between mt-1.5 gap-2">
        {sub && <span className="text-xs text-gray-400">{sub}</span>}
        {change !== undefined && <DeltaBadge change={change ?? null} inverse={inverse} />}
      </div>
    </div>
  )
}

export function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-base font-bold text-gray-900">{title}</h2>
      {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
    </div>
  )
}

export function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`bg-white rounded-xl border border-gray-100 shadow-sm p-4 ${className}`}>{children}</div>
}

export function EmptyState({ message }: { message: string }) {
  return <div className="flex items-center justify-center py-12 text-gray-400 text-sm">{message}</div>
}

export const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string }) => {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-lg px-3 py-2 text-xs">
      <div className="font-semibold text-gray-700 mb-1">{label}</div>
      {payload.map(p => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ background: p.color }} />
          <span className="text-gray-600">{p.name}:</span>
          <span className="font-semibold text-gray-800">{typeof p.value === 'number' ? formatCurrency(p.value) : p.value}</span>
        </div>
      ))}
    </div>
  )
}

export function LoadingState() {
  return (
    <div className="space-y-4">
      {[1,2,3].map(i => (
        <div key={i} className="bg-white rounded-xl border border-gray-100 p-4 h-32 animate-pulse">
          <div className="h-3 bg-gray-100 rounded w-1/4 mb-3" />
          <div className="h-6 bg-gray-100 rounded w-1/2 mb-2" />
          <div className="h-3 bg-gray-100 rounded w-1/3" />
        </div>
      ))}
    </div>
  )
}
