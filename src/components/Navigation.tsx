'use client'
import Link from 'next/link'
import Image from 'next/image'
import { usePathname, useRouter } from 'next/navigation'
import { useState, Suspense, useEffect } from 'react'
import {
  Sun, Package, FileText, Trash2, BarChart3,
  BookOpen, UtensilsCrossed,
  X, ShoppingBag, TrendingUp, Settings, ChefHat, Truck, LogOut,
  ClipboardList, Activity, Building2, Zap, Flame, ChevronRight, Wifi, WifiOff,
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
  const [isOffline, setIsOffline] = useState(false)

  useEffect(() => {
    const on = () => setIsOffline(false)
    const off = () => setIsOffline(true)
    setIsOffline(typeof navigator !== 'undefined' && !navigator.onLine)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])
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

      {/* ── Mobile "More" hub ──────────────────────────────────── */}
      {moreOpen && (
        <div className="md:hidden fixed inset-0 z-[60] flex flex-col bg-bg">
          <div
            className="flex items-center justify-between px-4 pb-3 bg-paper border-b border-line"
            style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 1rem)' }}
          >
            <div>
              <div className="font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">All areas</div>
              <h2 className="text-[22px] font-semibold text-ink tracking-[-0.03em] leading-none mt-1">More</h2>
            </div>
            <button
              onClick={() => setMoreOpen(false)}
              className="w-9 h-9 rounded-full bg-bg-2 flex items-center justify-center text-ink-3 hover:bg-line transition-colors"
            >
              <X size={16} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
            {/* Venue / user card */}
            <div className="flex items-center gap-3 bg-paper border border-line rounded-xl p-3">
              <UserAvatar />
              <div className="flex-1 min-w-0">
                <div className="text-[14px] font-semibold text-ink truncate"><UserName /></div>
                <div className="font-mono text-[11px] text-ink-3 truncate capitalize">
                  {role ? `${role[0]}${role.slice(1).toLowerCase()}` : 'Staff'} · <TenantName />
                </div>
              </div>
              <span className={`font-mono text-[10px] px-2 py-1 rounded-full inline-flex items-center gap-1 shrink-0 ${isOffline ? 'bg-red-soft text-red-text' : 'bg-green-soft text-green-text'}`}>
                {isOffline ? <WifiOff size={11} /> : <Wifi size={11} />} {isOffline ? 'Offline' : 'Synced'}
              </span>
            </div>

            {[...navGroups, { label: 'SETUP', items: visibleSetupItems }].map(group => {
              const visibleItems = group.items.filter(i => !i.adminOnly || role === 'ADMIN')
              if (visibleItems.length === 0) return null
              return (
                <div key={group.label}>
                  <p className="font-mono text-[10px] text-ink-4 uppercase tracking-[0.06em] mb-2 px-1">
                    {group.label}
                  </p>
                  <div className="bg-paper border border-line rounded-xl overflow-hidden">
                    {visibleItems.map((item, i) => {
                      const active = isActive(item)
                      const badge  = getBadge(item.badgeKey)
                      const { href, label, icon: Icon } = item
                      return (
                        <Link
                          key={`drawer-${href}-${label}`}
                          href={href}
                          onClick={() => setMoreOpen(false)}
                          className={`flex items-center gap-3 px-3 py-2.5 transition-colors ${i > 0 ? 'border-t border-line' : ''} ${active ? 'bg-gold-soft/50' : 'hover:bg-bg-2'}`}
                        >
                          <span className={`grid place-items-center w-9 h-9 rounded-[10px] shrink-0 ${active ? 'bg-ink text-gold' : 'bg-bg-2 text-ink-2'}`}>
                            <Icon size={17} color={active ? '#d97706' : '#27272a'} />
                          </span>
                          <span className={`flex-1 text-[14px] ${active ? 'text-ink font-semibold' : 'text-ink-2 font-medium'}`}>{label}</span>
                          {badge > 0 && (
                            <span className="font-mono text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-gold text-ink min-w-[18px] text-center leading-none">
                              {badge > 99 ? '99+' : badge}
                            </span>
                          )}
                          <ChevronRight size={16} className="text-ink-4 shrink-0" />
                        </Link>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>

          <div className="border-t border-line bg-paper px-4 py-3 pb-safe flex items-center justify-between">
            <button
              onClick={() => { setMoreOpen(false); handleLogout() }}
              className="flex items-center gap-2 px-3 py-2 rounded-xl text-[13px] text-ink-3 hover:bg-bg-2 transition-colors"
            >
              <LogOut size={16} className="text-ink-4" />
              Log out
            </button>
            <p className="font-mono text-[10px] text-ink-4">Controla OS · v1.0.0</p>
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
