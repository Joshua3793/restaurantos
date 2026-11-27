'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Sun, ChefHat, ListChecks, Grid2x2, Plus } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

// Bottom tab bar: Today · Checklist · ＋ · Prep · More.
// The station checklist is a daily job for every cook, so it sits on the bar;
// Count lives in ＋ ("Start a count") and in More.
// ＋ opens the quick-add sheet; More opens the existing "All Pages" drawer.
// Any route outside the three core routes activates "More".

const CORE_LEFT = [
  { href: '/today',     label: 'Today',     icon: Sun },
  { href: '/checklist', label: 'Checklist', icon: ListChecks },
]
const CORE_RIGHT = [
  { href: '/prep', label: 'Prep', icon: ChefHat },
]
const CORE_HREFS = [...CORE_LEFT, ...CORE_RIGHT].map(t => t.href)

// Module scope: defined inside the bar it remounted every render.
function Tab({ href, label, Icon, on }: { href: string; label: string; Icon: LucideIcon; on: boolean }) {
  return (
    <Link href={href} className="flex flex-col items-center gap-1" style={{ color: on ? '#09090b' : '#71717a' }}>
      <Icon size={22} strokeWidth={on ? 2.2 : 1.9} color={on ? '#09090b' : '#a1a1aa'} />
      <span className="text-[11px] leading-none" style={{ fontWeight: on ? 600 : 500 }}>{label}</span>
    </Link>
  )
}

export function MobileTabBar({ onAdd, onMore, moreBadge = 0 }: { onAdd: () => void; onMore: () => void; moreBadge?: number }) {
  const pathname = usePathname() ?? ''
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/')
  const moreActive = !CORE_HREFS.some(isActive)

  return (
    <nav
      className="md:hidden fixed bottom-0 left-0 right-0 z-50 grid grid-cols-5 pt-2.5 border-t border-line bg-paper"
      // Solid, no backdrop blur (blur on a fixed full-width bar freezes iOS).
      // At least 8px under the labels on phones with no home-indicator inset.
      style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 8px)' }}
    >
      {CORE_LEFT.map(t => <Tab key={t.href} href={t.href} label={t.label} Icon={t.icon} on={isActive(t.href)} />)}
      <div className="flex justify-center">
        <button onClick={onAdd} aria-label="Quick add" className="grid place-items-center w-[52px] h-[52px] rounded-2xl -mt-[18px] bg-ink border-[3px] border-white shadow-lg">
          <Plus size={24} color="#d97706" strokeWidth={2.6} />
        </button>
      </div>
      {CORE_RIGHT.map(t => <Tab key={t.href} href={t.href} label={t.label} Icon={t.icon} on={isActive(t.href)} />)}
      <button onClick={onMore} className="relative flex flex-col items-center gap-1" style={{ color: moreActive ? '#09090b' : '#71717a' }}>
        <span className="relative">
          <Grid2x2 size={22} strokeWidth={moreActive ? 2.2 : 1.9} color={moreActive ? '#09090b' : '#a1a1aa'} />
          {moreBadge > 0 && !moreActive && <span className="absolute -top-[3px] -right-[4px] w-[7px] h-[7px] bg-gold rounded-full border-[1.5px] border-white" />}
        </span>
        <span className="text-[11px] leading-none" style={{ fontWeight: moreActive ? 600 : 500 }}>More</span>
      </button>
    </nav>
  )
}
