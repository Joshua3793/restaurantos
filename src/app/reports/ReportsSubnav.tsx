'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { BarChart3, DollarSign, ShoppingCart, Package, ChefHat, Utensils, TrendingUp } from 'lucide-react'

const TABS = [
  { href: '/reports',            label: 'Overview',   icon: BarChart3 },
  { href: '/reports/cogs',       label: 'COGS',       icon: DollarSign },
  { href: '/reports/sales',      label: 'Sales',      icon: TrendingUp },
  { href: '/reports/purchasing', label: 'Purchasing', icon: ShoppingCart },
  { href: '/reports/inventory',  label: 'Inventory',  icon: Package },
  { href: '/reports/prep',       label: 'Prep',       icon: ChefHat },
  { href: '/reports/menu',       label: 'Menu',       icon: Utensils },
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
