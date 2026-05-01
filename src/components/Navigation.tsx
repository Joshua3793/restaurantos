'use client'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useState, Suspense } from 'react'
import {
  LayoutDashboard, Package, FileText, Trash2, BarChart3,
  ClipboardList, BookOpen, UtensilsCrossed, MoreHorizontal,
  X, ShoppingBag, TrendingUp, Settings, ChefHat, Truck, LogOut,
} from 'lucide-react'
import { AlertsBell } from '@/components/AlertsBell'
import { RcSelector } from '@/components/navigation/RcSelector'
import { useRc } from '@/contexts/RevenueCenterContext'
import { rcHex } from '@/lib/rc-colors'
import { useUser } from '@/contexts/UserContext'
import { createClient } from '@/lib/supabase/client'

type NavItem = {
  href: string
  label: string
  icon: React.ComponentType<{ size?: number | string; color?: string }>
  dividerBefore?: boolean
  adminOnly?: boolean
}

// ── Sidebar nav groups ────────────────────────────────────────────────────────
const navItems: NavItem[] = [
  // Group 1 — Core operations
  { href: '/',          label: 'Dashboard',    icon: LayoutDashboard },
  { href: '/inventory', label: 'Inventory',    icon: Package },
  { href: '/invoices',  label: 'Invoices',     icon: FileText },
  { href: '/suppliers', label: 'Suppliers',    icon: Truck },
  // Group 2 — Kitchen
  { href: '/count',     label: 'Count Stock',  icon: ClipboardList,  dividerBefore: true },
  { href: '/prep',      label: 'Prep List',    icon: ChefHat },
  { href: '/recipes',   label: 'Recipe Book',  icon: BookOpen },
  { href: '/menu',      label: 'Menu',         icon: UtensilsCrossed },
  // Group 3 — Analytics
  { href: '/sales',                      label: 'Sales',        icon: ShoppingBag,  dividerBefore: true },
  { href: '/wastage',                    label: 'Wastage',      icon: Trash2 },
  { href: '/reports/theoretical-usage', label: 'Usage',        icon: TrendingUp },
  { href: '/reports',                    label: 'Reports',      icon: BarChart3 },
  // Group 4 — Admin
  { href: '/settings',  label: 'Settings',     icon: Settings,     dividerBefore: true, adminOnly: true },
]

// ── Mobile bottom primary (5 tabs) ────────────────────────────────────────────
const mobilePrimary: NavItem[] = [
  { href: '/',          label: 'Dashboard', icon: LayoutDashboard },
  { href: '/inventory', label: 'Inventory', icon: Package },
  { href: '/prep',      label: 'Prep',      icon: ChefHat },
  { href: '/count',     label: 'Count',     icon: ClipboardList },
  { href: '/invoices',  label: 'Invoices',  icon: FileText },
]

// ── Mobile More drawer groups ─────────────────────────────────────────────────
const mobileMoreGroups = [
  {
    label: 'Kitchen',
    items: [
      { href: '/recipes',  label: 'Recipe Book', icon: BookOpen },
      { href: '/menu',     label: 'Menu',        icon: UtensilsCrossed },
      { href: '/suppliers',label: 'Suppliers',   icon: Truck },
    ],
  },
  {
    label: 'Analytics',
    items: [
      { href: '/sales',                      label: 'Sales',    icon: ShoppingBag },
      { href: '/wastage',                    label: 'Wastage',  icon: Trash2 },
      { href: '/reports/theoretical-usage', label: 'Usage',    icon: TrendingUp },
      { href: '/reports',                    label: 'Reports',  icon: BarChart3 },
    ],
  },
  {
    label: 'Admin',
    items: [
      { href: '/settings', label: 'Settings', icon: Settings, adminOnly: true },
    ] as NavItem[],
  },
]

export function Navigation() {
  return (
    <Suspense fallback={null}>
      <NavigationInner />
    </Suspense>
  )
}

function NavigationInner() {
  const pathname  = usePathname()
  const router    = useRouter()
  const [moreOpen, setMoreOpen] = useState(false)
  const { activeRc } = useRc()
  const { role }  = useUser()

  const isActive = (item: { href: string }) =>
    pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href + '/'))

  async function handleLogout() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
  }

  const visibleNavItems = navItems.filter(item => !item.adminOnly || role === 'ADMIN')

  const moreIsActive = mobileMoreGroups
    .flatMap(g => g.items)
    .filter(item => !('adminOnly' in item) || !item.adminOnly || role === 'ADMIN')
    .some(isActive)

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
        <RcSelector />
        <nav className="flex-1 p-3">
          {visibleNavItems.map(item => {
            const active = isActive(item)
            const { href, label, icon: Icon } = item
            return (
              <div key={href}>
                {item.dividerBefore && <div className="my-2 border-t border-gray-700/60" />}
                <Link
                  href={href}
                  style={active ? {
                    borderLeftColor: rcHex(activeRc?.color ?? 'blue'),
                    borderLeftWidth: 4,
                    backgroundColor: `${rcHex(activeRc?.color ?? 'blue')}30`,
                  } : undefined}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                    active ? 'text-white pl-[8px]' : 'text-gray-400 hover:bg-gray-800 hover:text-white font-normal'
                  }`}
                >
                  <Icon size={18} />
                  {label}
                </Link>
              </div>
            )
          })}
        </nav>
        <div className="p-3 border-t border-gray-700">
          <button
            onClick={handleLogout}
            className="flex items-center gap-3 px-3 py-2.5 w-full rounded-lg text-sm text-gray-400 hover:bg-gray-800 hover:text-white transition-colors"
          >
            <LogOut size={18} />
            Log Out
          </button>
          <p className="text-xs text-gray-600 px-3 mt-2">v1.0.0</p>
        </div>
      </aside>

      {/* ── Mobile Bottom Tab Bar ──────────────────────────────────────── */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-gray-100 shadow-[0_-1px_8px_rgba(0,0,0,0.06)] flex items-end z-50 pb-safe">
        {mobilePrimary.map((item) => {
          const active = isActive(item)
          const { href, label, icon: Icon } = item
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
            <div className="px-4 pb-6 space-y-4">
              {mobileMoreGroups.map(group => {
                const visibleItems = group.items.filter(
                  item => !('adminOnly' in item) || !item.adminOnly || role === 'ADMIN'
                )
                if (visibleItems.length === 0) return null
                return (
                  <div key={group.label}>
                    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-2 px-1">{group.label}</p>
                    <div className="grid grid-cols-4 gap-2">
                      {visibleItems.map(item => {
                        const active = isActive(item)
                        const { href, label, icon: Icon } = item
                        return (
                          <Link
                            key={href}
                            href={href}
                            onClick={() => setMoreOpen(false)}
                            className={`flex flex-col items-center gap-1.5 py-3 px-1 rounded-2xl text-xs font-medium transition-colors text-center ${
                              active ? 'bg-blue-50 text-blue-600' : 'bg-gray-50 text-gray-600 hover:bg-gray-100'
                            }`}
                          >
                            <Icon size={22} />
                            {label}
                          </Link>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
              {/* Log Out */}
              <button
                onClick={() => { setMoreOpen(false); handleLogout() }}
                className="flex items-center gap-3 w-full px-4 py-3 rounded-xl bg-gray-50 text-sm text-gray-600 hover:bg-gray-100 transition-colors"
              >
                <LogOut size={18} />
                Log Out
              </button>
            </div>
          </div>
        </>
      )}
    </>
  )
}
