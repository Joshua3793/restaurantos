'use client'
import Link from 'next/link'
import Image from 'next/image'
import { usePathname, useRouter } from 'next/navigation'
import { useState, Suspense, useEffect } from 'react'
import {
  Sun, Package, FileText, Trash2, BarChart3,
  BookOpen, UtensilsCrossed,
  X, ShoppingBag, TrendingUp, Settings, ChefHat, Truck, LogOut,
  ClipboardList, Activity, Building2, Zap, Flame,
} from 'lucide-react'
import { AlertsBell } from '@/components/AlertsBell'
import { RcSelector } from '@/components/navigation/RcSelector'
import { MobileTabBar } from '@/components/mobile/MobileTabBar'
import { QuickAddSheet } from '@/components/mobile/QuickAddSheet'
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
      { href: '/pass',     label: 'Pass',      icon: Sun },
      { href: '/preshift', label: 'Pre-shift', icon: Flame },
      { href: '/prep',     label: 'Prep',      icon: ChefHat },
      { href: '/count',    label: 'Count',     icon: ClipboardList },
    ],
  },
  {
    label: 'INBOX',
    items: [
      { href: '/invoices', label: 'Invoices', icon: FileText, badgeKey: 'invoicesReview' },
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
      { href: '/cost',     label: 'Cost',     icon: BarChart3 },
      { href: '/variance', label: 'Variance', icon: Activity },
      { href: '/signals',  label: 'Signals',  icon: Zap },
      { href: '/sales',                     label: 'Sales',    icon: ShoppingBag },
      { href: '/wastage',                   label: 'Wastage',  icon: Trash2 },
    ],
  },
]

const setupItems: NavItem[] = [
  { href: '/setup',                label: 'Setup',           icon: Settings, exact: true, adminOnly: true },
  { href: '/setup/suppliers',      label: 'Suppliers',       icon: Truck },
  { href: '/setup/revenue-centers',label: 'Revenue centers', icon: Building2 },
]

export function Navigation() {
  return (
    <Suspense fallback={null}>
      <NavigationInner />
    </Suspense>
  )
}

// ── User pill helpers (sidebar footer) ──────────────────────────────────────

function userInitials(name?: string | null, email?: string | null) {
  const base = (name || email || '').trim()
  if (!base) return '··'
  const parts = base.split(/\s+/).slice(0, 2)
  return parts.map(p => p[0]?.toUpperCase() ?? '').join('') || base.slice(0, 2).toUpperCase()
}

function UserAvatar() {
  const { user } = useUser()
  const initials = userInitials(user?.name, user?.email)
  return (
    <div className="w-7 h-7 rounded-full flex items-center justify-center font-semibold text-[11.5px] text-ink shrink-0"
      style={{ background: 'linear-gradient(135deg, #d97706, #b45309)' }}>
      {initials}
    </div>
  )
}

function UserName() {
  const { user } = useUser()
  const display = user?.name || user?.email?.split('@')[0] || 'You'
  return <span className="truncate">{display}</span>
}

function TenantName() {
  const { activeRc, revenueCenters } = useRc()
  const name = activeRc?.name ?? (revenueCenters.length > 0 ? 'All revenue centers' : 'Fergie’s')
  return <span className="truncate">{name.toLowerCase()}</span>
}

function NavigationInner() {
  const pathname  = usePathname()
  const router    = useRouter()
  const [moreOpen, setMoreOpen] = useState(false)
  const [quickAddOpen, setQuickAddOpen] = useState(false)
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

  return (
    <>
      {/* ── Desktop Sidebar (v2) ─────────────────────────────────── */}
      <aside
        className="hidden md:flex flex-col w-[240px] h-screen fixed left-0 top-0 z-40 px-[14px] py-[18px] gap-[18px] text-zinc-300"
        style={{ background: '#09090b' }}
      >
        {/* Brand + bell */}
        <div className="flex items-center justify-between px-1.5 pb-3">
          <Link href="/" className="flex items-center gap-[9px] text-[14px] font-semibold tracking-[-0.02em] text-[#fafaf9]">
            <span className="relative inline-block w-5 h-5 rounded-[6px] bg-paper">
              <span className="absolute inset-1 rounded-[3px] bg-gold" />
            </span>
            Controla OS
          </Link>
          <div className="[&>div>button]:text-zinc-500 [&>div>button:hover]:text-white">
            <AlertsBell />
          </div>
        </div>

        {/* Workspace switcher pill (RC selector) */}
        <div className="-mx-0.5">
          <RcSelector />
        </div>

        {/* Nav groups */}
        <nav className="flex-1 overflow-y-auto -mx-0.5 px-0.5 flex flex-col gap-[6px]">
          {navGroups.map(group => {
            const visibleItems = group.items.filter(i => !i.adminOnly || role === 'ADMIN')
            return (
              <div key={group.label} className="flex flex-col gap-[2px]">
                <p className="font-mono text-[10px] text-zinc-600 tracking-[0.02em] px-2 pt-1.5 pb-[6px]">
                  {group.label}
                </p>
                {visibleItems.map(item => {
                  const active = isActive(item)
                  const badge  = getBadge(item.badgeKey)
                  const { href, label, icon: Icon } = item
                  return (
                    <Link
                      key={`${href}-${label}`}
                      href={href}
                      className={`group flex items-center gap-[10px] px-[10px] py-2 rounded-lg text-[13.5px] font-medium tracking-[-0.005em] whitespace-nowrap transition-colors ${
                        active
                          ? 'bg-paper text-ink'
                          : 'text-zinc-300 hover:bg-[#18181b] hover:text-zinc-50'
                      }`}
                    >
                      <span className={active ? 'text-ink' : 'text-zinc-500 group-hover:text-zinc-300'}>
                        <Icon size={16} />
                      </span>
                      <span className="flex-1">{label}</span>
                      {badge > 0 && (
                        <span className={`font-mono text-[10px] px-[6px] py-[1px] rounded-full font-semibold leading-none tracking-normal ${
                          active ? 'bg-gold text-ink' : 'bg-gold text-ink'
                        }`}>
                          {badge > 99 ? '99+' : badge}
                        </span>
                      )}
                    </Link>
                  )
                })}
              </div>
            )
          })}

          {/* Setup group */}
          <div className="flex flex-col gap-[2px]">
            <p className="font-mono text-[10px] text-zinc-600 tracking-[0.02em] px-2 pt-1.5 pb-[6px]">
              SETUP
            </p>
            {visibleSetupItems.map(item => {
              const active = isActive(item)
              const { href, label, icon: Icon } = item
              return (
                <Link
                  key={href}
                  href={href}
                  className={`group flex items-center gap-[10px] px-[10px] py-2 rounded-lg text-[13.5px] font-medium tracking-[-0.005em] whitespace-nowrap transition-colors ${
                    active
                      ? 'bg-paper text-ink'
                      : 'text-zinc-300 hover:bg-[#18181b] hover:text-zinc-50'
                  }`}
                >
                  <span className={active ? 'text-ink' : 'text-zinc-500 group-hover:text-zinc-300'}>
                    <Icon size={16} />
                  </span>
                  {label}
                </Link>
              )
            })}
          </div>
        </nav>

        {/* User pill footer */}
        <div className="flex items-center gap-[10px] px-[10px] py-2 rounded-[10px] bg-[#18181b] border border-[#27272a]">
          <UserAvatar />
          <div className="min-w-0 flex-1 text-[12.5px] leading-tight text-[#fafaf9] font-medium truncate">
            <UserName />
            <small className="block font-mono text-[10.5px] text-zinc-500 font-normal tracking-normal mt-0.5">
              <TenantName />
            </small>
          </div>
          <button
            onClick={handleLogout}
            title="Log out"
            className="w-7 h-7 rounded-md flex items-center justify-center text-zinc-500 hover:text-white hover:bg-white/5 transition-colors"
          >
            <LogOut size={14} />
          </button>
        </div>
      </aside>

      {/* ── Mobile Bottom Tab Bar ──────────────────────────────── */}
      <MobileTabBar
        onAdd={() => setQuickAddOpen(true)}
        onMore={() => setMoreOpen(true)}
        moreBadge={inboxCounts.invoicesReview + inboxCounts.priceAlerts}
      />
      <QuickAddSheet open={quickAddOpen} onClose={() => setQuickAddOpen(false)} />

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
