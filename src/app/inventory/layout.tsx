'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Package, MapPin, Tag, ClipboardList } from 'lucide-react'

type Tab = {
  href: string
  label: string
  icon: React.ComponentType<{ size?: number | string }>
  accent?: boolean
}

const tabs: Tab[] = [
  { href: '/inventory',              label: 'Inventory',     icon: Package },
  { href: '/inventory/storage-areas', label: 'Storage Areas', icon: MapPin },
  { href: '/inventory/categories',   label: 'Categories',    icon: Tag },
  { href: '/inventory/count',        label: 'Count Stock',   icon: ClipboardList, accent: true },
]

export default function InventoryLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  return (
    <div className="space-y-4">
      {/* Sub-navigation */}
      <div className="bg-paper border-b border-line -mx-4 md:-mx-6 px-4 md:px-6">
        <nav className="flex h-12">
          {tabs.map(({ href, label, icon: Icon }) => {
            const active = pathname === href
            return (
              <Link
                key={href}
                href={href}
                className={`flex-1 flex items-center justify-center gap-[7px] text-[13.5px] font-medium border-b-2 transition-colors md:flex-none md:px-[18px] md:justify-start ${
                  active
                    ? 'border-gold text-ink'
                    : 'border-transparent text-ink-3 hover:text-ink-2 hover:border-line-2'
                }`}
              >
                <Icon size={14} aria-hidden="true" />
                <span className="hidden sm:inline">{label}</span>
                <span className="sm:hidden text-xs">{label.split(' ')[0]}</span>
              </Link>
            )
          })}
        </nav>
      </div>
      {children}
    </div>
  )
}
