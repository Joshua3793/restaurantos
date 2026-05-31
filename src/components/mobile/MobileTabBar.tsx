'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Sun, ChefHat, ClipboardList, Grid2x2, Plus } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

// Bottom tab bar: Today · Prep · ＋ · Count · More.
// ＋ opens the quick-add sheet; More opens the existing "All Pages" drawer.
// Any route outside the three core routes activates "More".

const CORE_LEFT = [
  { href: '/today', label: 'Today', icon: Sun },
  { href: '/prep',  label: 'Prep',  icon: ChefHat },
]
const CORE_RIGHT = [
  { href: '/count', label: 'Count', icon: ClipboardList },
]

export function MobileTabBar({ onAdd, onMore, moreBadge = 0 }: { onAdd: () => void; onMore: () => void; moreBadge?: number }) {
  const pathname = usePathname() ?? ''
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/')
  const moreActive = !['/today', '/prep', '/count'].some(isActive)

  const Tab = ({ href, label, Icon }: { href: string; label: string; Icon: LucideIcon }) => {
    const on = isActive(href)
    return (
      <Link href={href} className="flex flex-col items-center gap-1" style={{ color: on ? '#09090b' : '#71717a' }}>
        <Icon size={22} strokeWidth={on ? 2.2 : 1.9} color={on ? '#09090b' : '#a1a1aa'} />
        <span className="text-[9.5px]" style={{ fontWeight: on ? 600 : 500 }}>{label}</span>
      </Link>
    )
  }

  return (
    <nav
      className="md:hidden fixed bottom-0 left-0 right-0 z-50 grid grid-cols-5 pt-2.5 pb-safe border-t border-line"
      style={{ background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(18px) saturate(180%)', WebkitBackdropFilter: 'blur(18px) saturate(180%)' }}
    >
      {CORE_LEFT.map(t => <Tab key={t.href} href={t.href} label={t.label} Icon={t.icon} />)}
      <div className="flex justify-center">
        <button onClick={onAdd} aria-label="Quick add" className="grid place-items-center w-[52px] h-[52px] rounded-2xl -mt-[18px] bg-ink border-[3px] border-white shadow-lg">
          <Plus size={24} color="#d97706" strokeWidth={2.6} />
        </button>
      </div>
      {CORE_RIGHT.map(t => <Tab key={t.href} href={t.href} label={t.label} Icon={t.icon} />)}
      <button onClick={onMore} className="relative flex flex-col items-center gap-1" style={{ color: moreActive ? '#09090b' : '#71717a' }}>
        <span className="relative">
          <Grid2x2 size={22} strokeWidth={moreActive ? 2.2 : 1.9} color={moreActive ? '#09090b' : '#a1a1aa'} />
          {moreBadge > 0 && !moreActive && <span className="absolute -top-[3px] -right-[4px] w-[7px] h-[7px] bg-gold rounded-full border-[1.5px] border-white" />}
        </span>
        <span className="text-[9.5px]" style={{ fontWeight: moreActive ? 600 : 500 }}>More</span>
      </button>
    </nav>
  )
}
