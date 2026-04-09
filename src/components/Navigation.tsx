'use client'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useState } from 'react'
import { LayoutDashboard, Package, FileText, Trash2, BarChart3, ClipboardList, BookOpen, UtensilsCrossed, MoreHorizontal, X, ShoppingBag } from 'lucide-react'
import { AlertsBell } from '@/components/AlertsBell'

type NavItem = {
  href: string
  label: string
  icon: React.ComponentType<{ size?: number }>
  matchPath?: string
  matchView?: string
  dividerBefore?: boolean
}

const navItems: NavItem[] = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/inventory', label: 'Inventory', icon: Package },
  { href: '/count', label: 'Count', icon: ClipboardList },
  { href: '/invoices', label: 'Invoices', icon: FileText },
  { href: '/recipes?view=book', label: 'Recipe Book', icon: BookOpen, matchPath: '/recipes', matchView: 'book', dividerBefore: true },
  { href: '/recipes?view=menu', label: 'Menu', icon: UtensilsCrossed, matchPath: '/recipes', matchView: 'menu' },
  { href: '/sales', label: 'Sales', icon: ShoppingBag, dividerBefore: true },
  { href: '/wastage', label: 'Wastage', icon: Trash2 },
  { href: '/reports', label: 'Reports', icon: BarChart3 },
]

// Primary 4 tabs always visible on mobile
const mobilePrimary: NavItem[] = [
  { href: '/', label: 'Home', icon: LayoutDashboard },
  { href: '/inventory', label: 'Inventory', icon: Package },
  { href: '/count', label: 'Count', icon: ClipboardList },
  { href: '/recipes?view=book', label: 'Recipes', icon: BookOpen, matchPath: '/recipes', matchView: 'book' },
]

// Extra pages shown in the "More" drawer
const mobileMore: NavItem[] = [
  { href: '/recipes?view=menu', label: 'Menu', icon: UtensilsCrossed, matchPath: '/recipes', matchView: 'menu' },
  { href: '/invoices', label: 'Invoices', icon: FileText },
  { href: '/sales', label: 'Sales', icon: ShoppingBag },
  { href: '/wastage', label: 'Wastage', icon: Trash2 },
  { href: '/reports', label: 'Reports', icon: BarChart3 },
]

export function Navigation() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const currentView = searchParams.get('view')
  const [moreOpen, setMoreOpen] = useState(false)

  const isActive = (item: NavItem) => {
    if (item.matchPath) {
      if (item.matchView) return pathname === item.matchPath && currentView === item.matchView
      return pathname === item.matchPath
    }
    return pathname === item.href
  }

  // "More" tab is highlighted when the current page is one of the extra pages
  const moreIsActive = mobileMore.some(isActive)

  return (
    <>
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex flex-col w-56 bg-gray-900 text-white min-h-screen fixed left-0 top-0 z-40">
        <div className="p-4 border-b border-gray-700 flex items-center justify-between gap-2">
          <div>
            <h1 className="text-xl font-bold text-white">RestaurantOS</h1>
            <p className="text-xs text-gray-400 mt-0.5">Fergie&apos;s Kitchen</p>
          </div>
          <div className="text-white [&_button]:text-gray-400 [&_button:hover]:text-white [&_button:hover]:bg-gray-800">
            <AlertsBell />
          </div>
        </div>
        <nav className="flex-1 p-3">
          {navItems.map(item => {
            const active = isActive(item)
            const { href, label, icon: Icon } = item
            return (
              <div key={href}>
                {item.dividerBefore && (
                  <div className="my-2 border-t border-gray-700/60" />
                )}
                <Link
                  href={href}
                  className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                    active
                      ? 'bg-blue-600 text-white'
                      : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                  }`}
                >
                  <Icon size={18} />
                  {label}
                </Link>
              </div>
            )
          })}
        </nav>
        <div className="p-4 border-t border-gray-700">
          <p className="text-xs text-gray-500">v1.0.0</p>
        </div>
      </aside>

      {/* Mobile Bottom Tabs */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 flex z-50">
        {mobilePrimary.map(item => {
          const active = isActive(item)
          const { href, label, icon: Icon } = item
          return (
            <Link
              key={href}
              href={href}
              className={`flex-1 flex flex-col items-center py-2 gap-0.5 ${
                active ? 'text-blue-600' : 'text-gray-500'
              }`}
            >
              <Icon size={20} />
              <span className="text-[10px]">{label}</span>
            </Link>
          )
        })}
        {/* More tab */}
        <button
          onClick={() => setMoreOpen(true)}
          className={`flex-1 flex flex-col items-center py-2 gap-0.5 ${
            moreIsActive ? 'text-blue-600' : 'text-gray-500'
          }`}
        >
          <MoreHorizontal size={20} />
          <span className="text-[10px]">More</span>
        </button>
      </nav>

      {/* More Drawer — slides up from bottom */}
      {moreOpen && (
        <>
          {/* Backdrop */}
          <div
            className="md:hidden fixed inset-0 bg-black/40 z-50"
            onClick={() => setMoreOpen(false)}
          />
          {/* Sheet */}
          <div className="md:hidden fixed bottom-0 left-0 right-0 bg-white rounded-t-2xl z-50 shadow-xl">
            <div className="flex items-center justify-between px-5 pt-4 pb-2">
              <span className="text-sm font-semibold text-gray-700">All Pages</span>
              <button
                onClick={() => setMoreOpen(false)}
                className="p-1.5 rounded-full text-gray-400 hover:bg-gray-100"
              >
                <X size={18} />
              </button>
            </div>
            <div className="px-4 pb-8 grid grid-cols-4 gap-2">
              {mobileMore.map(item => {
                const active = isActive(item)
                const { href, label, icon: Icon } = item
                return (
                  <Link
                    key={href}
                    href={href}
                    onClick={() => setMoreOpen(false)}
                    className={`flex flex-col items-center gap-1.5 py-3 px-2 rounded-xl text-xs font-medium transition-colors ${
                      active
                        ? 'bg-blue-50 text-blue-600'
                        : 'bg-gray-50 text-gray-600 hover:bg-gray-100'
                    }`}
                  >
                    <Icon size={22} />
                    {label}
                  </Link>
                )
              })}
            </div>
          </div>
        </>
      )}
    </>
  )
}
