'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { BarChart3, DollarSign, ShoppingCart, Package, ChefHat } from 'lucide-react'

const TABS = [
  { href: '/reports',            label: 'Overview',   icon: BarChart3 },
  { href: '/reports/cogs',       label: 'COGS',       icon: DollarSign },
  { href: '/reports/purchasing', label: 'Purchasing', icon: ShoppingCart },
  { href: '/reports/inventory',  label: 'Inventory',  icon: Package },
  { href: '/reports/prep',       label: 'Prep',       icon: ChefHat },
]

/** In-page sub-navigation across the Reports overview + analytics sub-pages. */
export function ReportsSubnav() {
  const pathname = usePathname()
  return (
    <div className="flex items-center gap-1 overflow-x-auto border-b border-line mb-6">
      {TABS.map(({ href, label, icon: Icon }) => {
        const active = href === '/reports' ? pathname === '/reports' : (pathname?.startsWith(href) ?? false)
        return (
          <Link key={href} href={href}
            className={`flex items-center gap-1.5 px-3.5 py-2.5 text-[13px] font-medium border-b-2 whitespace-nowrap transition-colors ${
              active ? 'border-ink text-ink' : 'border-transparent text-ink-3 hover:text-ink hover:border-line-2'
            }`}>
            <Icon size={14} /> {label}
          </Link>
        )
      })}
    </div>
  )
}

export const PERIOD_OPTIONS = [
  { label: '30 days', value: 30 },
  { label: '90 days', value: 90 },
  { label: '6 months', value: 180 },
]

/** 30 / 90 / 180-day pill selector. Active pill uses the black brand accent. */
export function PeriodSelector({ period, setPeriod }: { period: number; setPeriod: (n: number) => void }) {
  return (
    <div className="flex items-center gap-0.5 border border-line rounded-lg p-0.5 bg-paper w-fit mb-5">
      {PERIOD_OPTIONS.map(opt => (
        <button key={opt.value} onClick={() => setPeriod(opt.value)}
          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            period === opt.value ? 'bg-ink text-paper' : 'text-ink-3 hover:text-ink hover:bg-bg-2'
          }`}>
          {opt.label}
        </button>
      ))}
    </div>
  )
}
