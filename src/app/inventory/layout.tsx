'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Package, MapPin, Tag } from 'lucide-react'

const tabs = [
  { href: '/inventory',              label: 'Inventory',     icon: Package },
  { href: '/inventory/storage-areas', label: 'Storage Areas', icon: MapPin },
  { href: '/inventory/categories',   label: 'Categories',    icon: Tag },
]

export default function InventoryLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  return (
    <div className="space-y-4">
      {/* Sub-navigation */}
      <div className="border-b border-gray-200 -mx-4 md:-mx-6 px-4 md:px-6">
        <nav className="flex gap-1 overflow-x-auto">
          {tabs.map(({ href, label, icon: Icon }) => {
            const active = pathname === href
            return (
              <Link
                key={href}
                href={href}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
                  active
                    ? 'border-blue-600 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                <Icon size={15} />
                {label}
              </Link>
            )
          })}
        </nav>
      </div>
      {children}
    </div>
  )
}
