'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState, Suspense } from 'react'
import {
  LayoutDashboard, Package, FileText, Trash2, BarChart3,
  ClipboardList, BookOpen, UtensilsCrossed, MoreHorizontal,
  X, ShoppingBag, TrendingUp, Settings, ChefHat,
} from 'lucide-react'
import { AlertsBell } from '@/components/AlertsBell'

type NavItem = {
  href: string
  label: string
  icon: React.ComponentType<{ size?: number | string }>
  dividerBefore?: boolean
}

const navItems: NavItem[] = [
  { href: '/',                           label: 'Dashboard',    icon: LayoutDashboard },
  { href: '/inventory',                  label: 'Inventory',    icon: Package },
  { href: '/count',                      label: 'Count',        icon: ClipboardList },
  { href: '/prep',                       label: 'Prep',         icon: ChefHat },
  { href: '/invoices',                   label: 'Invoices',     icon: FileText },
  { href: '/recipes',                    label: 'Recipe Book',  icon: BookOpen,        dividerBefore: true },
  { href: '/menu',                       label: 'Menu',         icon: UtensilsCrossed },
  { href: '/sales',                      label: 'Sales',        icon: ShoppingBag,     dividerBefore: true },
  { href: '/wastage',                    label: 'Wastage',      icon: Trash2 },
  { href: '/reports',                    label: 'Reports',      icon: BarChart3 },
  { href: '/reports/theoretical-usage', label: 'Usage Report', icon: TrendingUp },
  { href: '/settings',                   label: 'Settings',     icon: Settings,        dividerBefore: true },
]

// Roadmap spec: Dashboard / Inventory / Count (center) / Invoices / Reports
const mobilePrimary: NavItem[] = [
  { href: '/',          label: 'Dashboard', icon: LayoutDashboard },
  { href: '/inventory', label: 'Inventory', icon: Package },
  { href: '/count',     label: 'Count',     icon: ClipboardList },   // centre — gets special treatment
  { href: '/invoices',  label: 'Invoices',  icon: FileText },
  { href: '/reports',   label: 'Reports',   icon: BarChart3 },
]

// Everything else lives in the More drawer
const mobileMore: NavItem[] = [
  { href: '/prep',                       label: 'Prep',         icon: ChefHat },
  { href: '/recipes',                    label: 'Recipes',      icon: BookOpen },
  { href: '/menu',                       label: 'Menu',         icon: UtensilsCrossed },
  { href: '/sales',                      label: 'Sales',        icon: ShoppingBag },
  { href: '/wastage',                    label: 'Wastage',      icon: Trash2 },
  { href: '/reports/theoretical-usage', label: 'Usage Report', icon: TrendingUp },
  { href: '/settings',                   label: 'Settings',     icon: Settings },
]

export function Navigation() {
  return (
    <Suspense fallback={null}>
      <NavigationInner />
    </Suspense>
  )
}

function NavigationInner() {
  const pathname = usePathname()
  const [moreOpen, setMoreOpen] = useState(false)

  const isActive = (item: NavItem) => pathname === item.href || pathname.startsWith(item.href + '/')
  const moreIsActive = mobileMore.some(isActive)

  return (
    <>
      {/* ── Desktop Sidebar ────────────────────────────────────────────── */}
      <aside className="hidden md:flex flex-col w-56 bg-gray-900 text-white min-h-screen fixed left-0 top-0 z-40">
        <div className="p-4 border-b border-gray-700 flex items-center justify-between gap-2">
          <div>
            <h1 className="text-xl font-bold text-white">CONTROLA OS</h1>
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
                {item.dividerBefore && <div className="my-2 border-t border-gray-700/60" />}
                <Link
                  href={href}
                  className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                    active ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-800 hover:text-white'
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

      {/* ── Mobile Bottom Tab Bar ──────────────────────────────────────── */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-gray-100 shadow-[0_-1px_8px_rgba(0,0,0,0.06)] flex items-end z-50 pb-safe">
        {mobilePrimary.map((item, idx) => {
          const active = isActive(item)
          const { href, label, icon: Icon } = item
          const isCount = idx === 2  // centre position

          if (isCount) {
            return (
              <Link
                key={href}
                href={href}
                className="flex-1 flex flex-col items-center pb-2 pt-1 gap-0 relative"
              >
                {/* Elevated Count button */}
                <div className={`w-14 h-14 rounded-full flex items-center justify-center shadow-lg -mt-5 transition-colors ${
                  active ? 'bg-blue-700' : 'bg-blue-600'
                }`}>
                  <Icon size={26} color="white" />
                </div>
                <span className={`text-[10px] mt-1 font-semibold ${active ? 'text-blue-600' : 'text-gray-500'}`}>
                  {label}
                </span>
              </Link>
            )
          }

          return (
            <Link
              key={href}
              href={href}
              className={`flex-1 flex flex-col items-center py-2 gap-0.5 transition-colors ${
                active ? 'text-blue-600' : 'text-gray-400'
              }`}
            >
              <Icon size={22} />
              <span className="text-[10px]">{label}</span>
            </Link>
          )
        })}

        {/* More tab */}
        <button
          onClick={() => setMoreOpen(true)}
          className={`flex-1 flex flex-col items-center py-2 gap-0.5 transition-colors ${
            moreIsActive ? 'text-blue-600' : 'text-gray-400'
          }`}
        >
          <MoreHorizontal size={22} />
          <span className="text-[10px]">More</span>
        </button>
      </nav>

      {/* ── More Drawer ────────────────────────────────────────────────── */}
      {moreOpen && (
        <>
          <div className="md:hidden fixed inset-0 bg-black/40 z-[60]" onClick={() => setMoreOpen(false)} />
          <div className="md:hidden fixed bottom-0 left-0 right-0 bg-white rounded-t-2xl z-[60] shadow-xl pb-safe">
            <div className="flex items-center justify-between px-5 pt-4 pb-2">
              <span className="text-sm font-semibold text-gray-700">All Pages</span>
              <button onClick={() => setMoreOpen(false)} className="p-1.5 rounded-full text-gray-400 hover:bg-gray-100">
                <X size={18} />
              </button>
            </div>
            <div className="px-4 pb-8 grid grid-cols-3 gap-3">
              {mobileMore.map(item => {
                const active = isActive(item)
                const { href, label, icon: Icon } = item
                return (
                  <Link
                    key={href}
                    href={href}
                    onClick={() => setMoreOpen(false)}
                    className={`flex flex-col items-center gap-2 py-4 px-2 rounded-2xl text-xs font-medium transition-colors ${
                      active ? 'bg-blue-50 text-blue-600' : 'bg-gray-50 text-gray-600 hover:bg-gray-100'
                    }`}
                  >
                    <Icon size={24} />
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
