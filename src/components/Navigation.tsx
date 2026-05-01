'use client'
import Link from 'next/link'
import Image from 'next/image'
import { usePathname, useRouter } from 'next/navigation'
import { useState, Suspense } from 'react'
import {
  LayoutDashboard, Package, FileText, Trash2, BarChart3,
  ClipboardList, BookOpen, UtensilsCrossed, LayoutGrid,
  X, ShoppingBag, TrendingUp, Settings, ChefHat, Truck, LogOut,
} from 'lucide-react'
import { AlertsBell } from '@/components/AlertsBell'
import { RcSelector } from '@/components/navigation/RcSelector'
import { useRc } from '@/contexts/RevenueCenterContext'
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

// ── Mobile bottom primary (4 flanking tabs — center slot is the Pages button) ─
const mobileLeft: NavItem[] = [
  { href: '/',          label: 'Dashboard', icon: LayoutDashboard },
  { href: '/inventory', label: 'Inventory', icon: Package },
]
const mobileRight: NavItem[] = [
  { href: '/count', label: 'Count', icon: ClipboardList },
  { href: '/prep',  label: 'Prep',  icon: ChefHat },
]

// ── Mobile Pages drawer — mirrors the desktop sidebar groups ──────────────────
const mobilePagesGroups = [
  {
    label: 'Core',
    items: [
      { href: '/',           label: 'Dashboard', icon: LayoutDashboard },
      { href: '/inventory',  label: 'Inventory', icon: Package },
      { href: '/invoices',   label: 'Invoices',  icon: FileText },
      { href: '/suppliers',  label: 'Suppliers', icon: Truck },
    ] as NavItem[],
  },
  {
    label: 'Kitchen',
    items: [
      { href: '/count',    label: 'Count Stock',  icon: ClipboardList },
      { href: '/prep',     label: 'Prep List',    icon: ChefHat },
      { href: '/recipes',  label: 'Recipe Book',  icon: BookOpen },
      { href: '/menu',     label: 'Menu',         icon: UtensilsCrossed },
    ] as NavItem[],
  },
  {
    label: 'Analytics',
    items: [
      { href: '/sales',                     label: 'Sales',    icon: ShoppingBag },
      { href: '/wastage',                   label: 'Wastage',  icon: Trash2 },
      { href: '/reports/theoretical-usage', label: 'Usage',    icon: TrendingUp },
      { href: '/reports',                   label: 'Reports',  icon: BarChart3 },
    ] as NavItem[],
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
  useRc()
  const { role }  = useUser()

  const isActive = (item: { href: string }) =>
    pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href + '/'))

  async function handleLogout() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
  }

  const visibleNavItems = navItems.filter(item => !item.adminOnly || role === 'ADMIN')

  // Pages button is "active" when the current route isn't one of the 4 flanking tabs
  const flankingHrefs = new Set([...mobileLeft, ...mobileRight].map(i => i.href))
  const moreIsActive = ![...flankingHrefs].some(href =>
    pathname === href || (href !== '/' && pathname.startsWith(href + '/'))
  )

  return (
    <>
      {/* ── Desktop Sidebar ────────────────────────────────────────────── */}
      <aside className="hidden md:flex flex-col w-[240px] min-h-screen fixed left-0 top-0 z-40"
        style={{ background: '#09090b', borderRight: '1px solid rgba(255,255,255,0.08)' }}>

        {/* Wordmark */}
        <div className="px-5 pt-5 pb-4 flex items-center justify-between gap-2">
          <Image src="/logo-wordmark.png" alt="Controla OS" width={130} height={34}
            className="shrink-0 object-contain" style={{ height: 34, width: 'auto' }} />
          <div className="[&_button]:text-white/30 [&_button:hover]:text-white [&_button:hover]:bg-white/5 rounded-lg">
            <AlertsBell />
          </div>
        </div>

        {/* RC selector */}
        <div className="px-3 pb-2">
          <RcSelector />
        </div>

        {/* Nav items */}
        <nav className="flex-1 px-3 py-2 overflow-y-auto space-y-0.5">
          {visibleNavItems.map(item => {
            const active = isActive(item)
            const { href, label, icon: Icon } = item
            return (
              <div key={href}>
                {item.dividerBefore && (
                  <div className="my-2.5" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }} />
                )}
                <Link
                  href={href}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13px] font-medium transition-all duration-150 ${
                    active
                      ? 'bg-white text-gray-900 shadow-[0_0_24px_rgba(201,168,76,0.18)]'
                      : 'text-white/40 hover:text-white/80 hover:bg-white/5'
                  }`}
                >
                  <Icon size={16} color={active ? '#111' : undefined} />
                  {label}
                </Link>
              </div>
            )
          })}
        </nav>

        {/* Footer */}
        <div className="px-3 py-3" style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}>
          <button
            onClick={handleLogout}
            className="flex items-center gap-3 px-3 py-2.5 w-full rounded-xl text-[13px] text-white/30 hover:text-white/70 hover:bg-white/5 transition-colors"
          >
            <LogOut size={16} />
            Log Out
          </button>
        </div>
      </aside>

      {/* ── Mobile Bottom Tab Bar ──────────────────────────────────────── */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 pb-safe">
        {/* Raised center button sits above the bar */}
        <div className="relative flex items-end">
          {/* Bar background */}
          <div className="absolute inset-x-0 bottom-0 h-16 bg-white border-t border-gray-100 shadow-[0_-1px_8px_rgba(0,0,0,0.06)]" />

          {/* Left two tabs */}
          {mobileLeft.map(item => {
            const active = isActive(item)
            const { href, label, icon: Icon } = item
            return (
              <Link key={href} href={href}
                className={`relative flex-1 flex flex-col items-center pt-2 pb-2 gap-0.5 transition-colors ${
                  active ? 'text-gold' : 'text-gray-400'
                }`}
              >
                <Icon size={22} />
                <span className="text-[10px]">{label}</span>
              </Link>
            )
          })}

          {/* Center Pages button — raised */}
          <button
            onClick={() => setMoreOpen(true)}
            className="relative flex-1 flex flex-col items-center pb-2"
            style={{ marginBottom: 0 }}
          >
            {/* Raised pill */}
            <div className={`-mt-5 w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg transition-colors ${
              moreIsActive ? 'bg-gray-700' : 'bg-gray-900'
            }`}>
              <LayoutGrid size={22} className="text-white" />
            </div>
            <span className={`text-[10px] mt-0.5 font-medium ${moreIsActive ? 'text-gray-700' : 'text-gray-500'}`}>
              Pages
            </span>
          </button>

          {/* Right two tabs */}
          {mobileRight.map(item => {
            const active = isActive(item)
            const { href, label, icon: Icon } = item
            return (
              <Link key={href} href={href}
                className={`relative flex-1 flex flex-col items-center pt-2 pb-2 gap-0.5 transition-colors ${
                  active ? 'text-gold' : 'text-gray-400'
                }`}
              >
                <Icon size={22} />
                <span className="text-[10px]">{label}</span>
              </Link>
            )
          })}
        </div>
      </nav>

      {/* ── Pages Drawer (full-screen, sidebar style) ──────────────────── */}
      {moreOpen && (
        <div className="md:hidden fixed inset-0 z-[60] flex flex-col bg-white">
          {/* Header */}
          <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-gray-100">
            <div>
              <h2 className="text-base font-bold text-gray-900">All Pages</h2>
              <p className="text-xs text-gray-400 mt-0.5">CONTROLA OS</p>
            </div>
            <button
              onClick={() => setMoreOpen(false)}
              className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-500 hover:bg-gray-200 transition-colors"
            >
              <X size={16} />
            </button>
          </div>

          {/* Nav groups — sidebar style */}
          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-5">
            {mobilePagesGroups.map(group => {
              const visibleItems = group.items.filter(
                item => !item.adminOnly || role === 'ADMIN'
              )
              if (visibleItems.length === 0) return null
              return (
                <div key={group.label}>
                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1 px-3">
                    {group.label}
                  </p>
                  <div className="space-y-0.5">
                    {visibleItems.map(item => {
                      const active = isActive(item)
                      const { href, label, icon: Icon } = item
                      return (
                        <Link
                          key={href}
                          href={href}
                          onClick={() => setMoreOpen(false)}
                          style={active ? {
                            borderLeftColor: '#c9a84c',
                            borderLeftWidth: 3,
                            backgroundColor: 'rgba(201,168,76,0.10)',
                          } : undefined}
                          className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-colors ${
                            active
                              ? 'text-gray-900 font-semibold pl-[10px]'
                              : 'text-gray-600 hover:bg-gray-50 font-normal'
                          }`}
                        >
                          <Icon size={18} color={active ? '#1f2937' : '#9ca3af'} />
                          {label}
                        </Link>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Footer — log out + version */}
          <div className="border-t border-gray-100 px-3 py-3 pb-safe space-y-1">
            <button
              onClick={() => { setMoreOpen(false); handleLogout() }}
              className="flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-sm text-gray-500 hover:bg-gray-50 transition-colors"
            >
              <LogOut size={18} className="text-gray-400" />
              Log Out
            </button>
            <p className="text-xs text-gray-300 px-3">v1.0.0</p>
          </div>
        </div>
      )}
    </>
  )
}
