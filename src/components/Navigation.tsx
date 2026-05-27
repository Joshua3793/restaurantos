'use client'
import Link from 'next/link'
import Image from 'next/image'
import { usePathname, useRouter } from 'next/navigation'
import { useState, Suspense, useEffect } from 'react'
import {
  Sun, Package, FileText, Trash2, BarChart3,
  BookOpen, UtensilsCrossed, LayoutGrid,
  X, ShoppingBag, TrendingUp, Settings, ChefHat, Truck, LogOut,
  ClipboardList, Activity, Building2, Zap,
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
  exact?: boolean
  adminOnly?: boolean
  badgeKey?: 'invoicesReview' | 'priceAlerts'
}

type NavGroup = {
  label: string
  items: NavItem[]
}

const navGroups: NavGroup[] = [
  {
    label: 'TODAY',
    items: [
      { href: '/',      label: 'Pass',  icon: Sun,          exact: true },
      { href: '/prep',  label: 'Prep',  icon: ChefHat },
      { href: '/count', label: 'Count', icon: ClipboardList },
    ],
  },
  {
    label: 'INBOX',
    items: [
      { href: '/invoices', label: 'Invoices',     icon: FileText,  badgeKey: 'invoicesReview' },
      { href: '/invoices', label: 'Price alerts', icon: TrendingUp, badgeKey: 'priceAlerts' },
    ],
  },
  {
    label: 'LIBRARY',
    items: [
      { href: '/inventory', label: 'Inventory', icon: Package },
      { href: '/recipes',   label: 'Recipes',   icon: BookOpen },
      { href: '/menu',      label: 'Menu',       icon: UtensilsCrossed },
    ],
  },
  {
    label: 'INSIGHTS',
    items: [
      { href: '/reports',                   label: 'Cost',     icon: BarChart3, exact: true },
      { href: '/reports/theoretical-usage', label: 'Variance', icon: Activity },
      { href: '/reports/signals',           label: 'Signals',  icon: Zap },
      { href: '/sales',                     label: 'Sales',    icon: ShoppingBag },
      { href: '/wastage',                   label: 'Wastage',  icon: Trash2 },
    ],
  },
]

const setupItems: NavItem[] = [
  { href: '/suppliers',       label: 'Suppliers',        icon: Truck },
  { href: '/revenue-centers', label: 'Revenue centers',  icon: Building2 },
  { href: '/settings',        label: 'Settings',         icon: Settings, adminOnly: true },
]

// Mobile bottom tabs — 2 left, center Pages button, 2 right
const mobileLeft: NavItem[] = [
  { href: '/',     label: 'Pass', icon: Sun,    exact: true },
  { href: '/prep', label: 'Prep', icon: ChefHat },
]
const mobileRight: NavItem[] = [
  { href: '/count',    label: 'Count',    icon: ClipboardList },
  { href: '/invoices', label: 'Invoices', icon: FileText, badgeKey: 'invoicesReview' },
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
  const [inboxCounts, setInboxCounts] = useState({ invoicesReview: 0, priceAlerts: 0 })
  useRc()
  const { role } = useUser()

  // Poll inbox badge counts
  useEffect(() => {
    const fetchCounts = async () => {
      try {
        const data = await fetch('/api/invoices/kpis').then(r => r.ok ? r.json() : null)
        if (data) {
          setInboxCounts({
            invoicesReview: data.awaitingApprovalCount ?? 0,
            priceAlerts: data.priceAlertCount ?? 0,
          })
        }
      } catch {}
    }
    fetchCounts()
    const interval = setInterval(fetchCounts, 60_000)
    return () => clearInterval(interval)
  }, [])

  const isActive = (item: Pick<NavItem, 'href' | 'exact'>) =>
    pathname === item.href || (!item.exact && item.href !== '/' && pathname.startsWith(item.href + '/'))

  const getBadge = (key?: NavItem['badgeKey']) =>
    key ? inboxCounts[key] : 0

  async function handleLogout() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
  }

  const visibleSetupItems = setupItems.filter(i => !i.adminOnly || role === 'ADMIN')
  const allNavItems = navGroups.flatMap(g => g.items)
  const flankingHrefs = new Set([...mobileLeft, ...mobileRight].map(i => i.href))
  const moreIsActive = !([...flankingHrefs]).some(href =>
    pathname === href || (href !== '/' && pathname.startsWith(href + '/'))
  )

  return (
    <>
      {/* ── Desktop Sidebar ─────────────────────────────────────── */}
      <aside
        className="hidden md:flex flex-col w-[240px] min-h-screen fixed left-0 top-0 z-40"
        style={{ background: '#09090b', borderRight: '1px solid rgba(255,255,255,0.08)' }}
      >
        {/* Wordmark + bell */}
        <div className="px-4 pt-5 pb-4 flex items-center justify-between gap-2">
          <Image
            src="/logo-wordmark.png" alt="Controla OS" width={176} height={52}
            className="shrink-0 object-contain object-left"
            style={{ height: 52, width: 176, maxWidth: 176 }}
          />
          <div className="[&>div>button]:text-white/30 [&>div>button:hover]:text-white [&>div>button:hover]:bg-white/5 rounded-lg shrink-0">
            <AlertsBell />
          </div>
        </div>

        {/* RC selector */}
        <div className="px-3 pb-3">
          <RcSelector />
        </div>

        {/* Nav groups */}
        <nav className="flex-1 px-3 overflow-y-auto pb-2 space-y-4">
          {navGroups.map((group, gi) => {
            const visibleItems = group.items.filter(i => !i.adminOnly || role === 'ADMIN')
            return (
              <div key={group.label}>
                {gi > 0 && (
                  <div className="mb-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }} />
                )}
                <p className="px-3 mb-1 text-[10px] font-semibold tracking-widest"
                  style={{ color: 'rgba(255,255,255,0.22)' }}>
                  {group.label}
                </p>
                <div className="space-y-0.5">
                  {visibleItems.map(item => {
                    const active = isActive(item)
                    const badge  = getBadge(item.badgeKey)
                    const { href, label, icon: Icon } = item
                    return (
                      <Link
                        key={`${href}-${label}`}
                        href={href}
                        className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13px] font-medium transition-all duration-150 ${
                          active
                            ? 'bg-white text-gray-900 shadow-[0_0_24px_rgba(201,168,76,0.18)]'
                            : 'text-white/40 hover:text-white/80 hover:bg-white/5'
                        }`}
                      >
                        <Icon size={15} color={active ? '#111' : undefined} />
                        <span className="flex-1">{label}</span>
                        {badge > 0 && (
                          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full min-w-[18px] text-center leading-none ${
                            active
                              ? 'bg-gold text-[#111]'
                              : 'bg-gold/20 text-gold'
                          }`}>
                            {badge > 99 ? '99+' : badge}
                          </span>
                        )}
                      </Link>
                    )
                  })}
                </div>
              </div>
            )
          })}

          {/* Setup — demoted, rendered smaller */}
          <div>
            <div className="mb-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }} />
            <p className="px-3 mb-1 text-[10px] font-semibold tracking-widest"
              style={{ color: 'rgba(255,255,255,0.15)' }}>
              SETUP
            </p>
            <div className="space-y-0.5">
              {visibleSetupItems.map(item => {
                const active = isActive(item)
                const { href, label, icon: Icon } = item
                return (
                  <Link
                    key={href}
                    href={href}
                    className={`flex items-center gap-3 px-3 py-2 rounded-xl text-[12px] font-medium transition-all duration-150 ${
                      active
                        ? 'bg-white/10 text-white/80'
                        : 'text-white/25 hover:text-white/50 hover:bg-white/5'
                    }`}
                  >
                    <Icon size={13} />
                    {label}
                  </Link>
                )
              })}
            </div>
          </div>
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

      {/* ── Mobile Bottom Tab Bar ──────────────────────────────── */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 pb-safe">
        <div className="relative flex items-end">
          <div
            className="absolute inset-x-0 bg-white border-t border-gray-100 shadow-[0_-1px_8px_rgba(0,0,0,0.06)]"
            style={{
              bottom: 'calc(-1 * env(safe-area-inset-bottom, 0px))',
              height: 'calc(4rem + env(safe-area-inset-bottom, 0px))',
            }}
          />

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

          {/* Center Pages button */}
          <button
            onClick={() => setMoreOpen(true)}
            className="relative flex-1 flex flex-col items-center pb-2"
          >
            <div className={`-mt-5 w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg transition-colors ${
              moreIsActive ? 'bg-gray-700' : 'bg-gray-900'
            }`}>
              <LayoutGrid size={22} className="text-white" />
            </div>
            <span className={`text-[10px] mt-0.5 font-medium ${moreIsActive ? 'text-gray-700' : 'text-gray-500'}`}>
              Pages
            </span>
          </button>

          {mobileRight.map(item => {
            const active = isActive(item)
            const badge  = getBadge(item.badgeKey)
            const { href, label, icon: Icon } = item
            return (
              <Link key={`mob-${href}-${label}`} href={href}
                className={`relative flex-1 flex flex-col items-center pt-2 pb-2 gap-0.5 transition-colors ${
                  active ? 'text-gold' : 'text-gray-400'
                }`}
              >
                <div className="relative">
                  <Icon size={22} />
                  {badge > 0 && (
                    <span className="absolute -top-1 -right-1.5 w-4 h-4 bg-gold text-[#111] text-[8px] font-bold rounded-full flex items-center justify-center leading-none">
                      {badge > 9 ? '9+' : badge}
                    </span>
                  )}
                </div>
                <span className="text-[10px]">{label}</span>
              </Link>
            )
          })}
        </div>
      </nav>

      {/* ── Mobile Pages Drawer ────────────────────────────────── */}
      {moreOpen && (
        <div className="md:hidden fixed inset-0 z-[60] flex flex-col bg-white">
          <div
            className="flex items-center justify-between px-5 pb-4 border-b border-gray-100"
            style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 1.25rem)' }}
          >
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

          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-5">
            {navGroups.map(group => {
              const visibleItems = group.items.filter(i => !i.adminOnly || role === 'ADMIN')
              return (
                <div key={group.label}>
                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1 px-3">
                    {group.label}
                  </p>
                  <div className="space-y-0.5">
                    {visibleItems.map(item => {
                      const active = isActive(item)
                      const badge  = getBadge(item.badgeKey)
                      const { href, label, icon: Icon } = item
                      return (
                        <Link
                          key={`drawer-${href}-${label}`}
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
                          <span className="flex-1">{label}</span>
                          {badge > 0 && (
                            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-gold/20 text-amber-700 min-w-[18px] text-center leading-none">
                              {badge > 99 ? '99+' : badge}
                            </span>
                          )}
                        </Link>
                      )
                    })}
                  </div>
                </div>
              )
            })}

            {/* Setup group in drawer */}
            <div>
              <p className="text-[10px] font-semibold text-gray-300 uppercase tracking-widest mb-1 px-3">
                SETUP
              </p>
              <div className="space-y-0.5">
                {visibleSetupItems.map(item => {
                  const active = isActive(item)
                  const { href, label, icon: Icon } = item
                  return (
                    <Link
                      key={href}
                      href={href}
                      onClick={() => setMoreOpen(false)}
                      className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-colors opacity-60 ${
                        active
                          ? 'text-gray-900 font-medium opacity-100'
                          : 'text-gray-500 hover:bg-gray-50'
                      }`}
                    >
                      <Icon size={16} color="#9ca3af" />
                      {label}
                    </Link>
                  )
                })}
              </div>
            </div>
          </div>

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

// Keep the previous flat navItems export in case anything imports from here
// (AlertsBell, breadcrumbs, etc.) — remove once confirmed nothing uses it.
const _allNavItems = navGroups.flatMap(g => g.items)
export { _allNavItems as navItems }
