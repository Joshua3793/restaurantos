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
      <div className="border-b border-gray-200 -mx-4 md:-mx-6 px-4 md:px-6">
        <nav className="flex">
          {tabs.map(({ href, label, icon: Icon, accent }) => {
            const active = pathname === href
            return (
              <Link
                key={href}
                href={href}
                className={`flex-1 flex items-center justify-center gap-1.5 py-3 text-sm font-medium border-b-2 transition-colors md:flex-none md:px-4 md:justify-start md:gap-2 ${
                  active
                    ? 'border-gold text-gold'
                    : accent
                    ? 'border-transparent text-gold/80 hover:text-gold hover:border-gold/40'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                {accent
                  ? (
                    <span className={`flex items-center gap-1.5 md:gap-2 rounded-full px-2.5 py-1 ${
                      active ? 'bg-gold/15' : 'bg-gold/10'
                    }`}>
                      <Icon size={15} aria-hidden="true" />
                      <span className="hidden sm:inline">{label}</span>
                      <span className="sm:hidden text-xs">{label.split(' ')[0]}</span>
                    </span>
                  )
                  : (
                    <>
                      <Icon size={15} aria-hidden="true" />
                      {/* Full label on desktop, shortened on mobile */}
                      <span className="hidden sm:inline">{label}</span>
                      <span className="sm:hidden text-xs">{label.split(' ')[0]}</span>
                    </>
                  )}
              </Link>
            )
          })}
        </nav>
      </div>
      {children}
    </div>
  )
}
